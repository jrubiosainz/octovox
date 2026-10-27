import { execFile, spawn } from "node:child_process";

// API keys live in the macOS Keychain, never in settings.json.
const SECURITY = "/usr/bin/security";
const SERVICE = "Octovox";
const cache = new Map();

export function secretAccount(provider, endpoint) {
    let host = "";
    try {
        host = new URL(endpoint).host;
    } catch {
        // No endpoint yet.
    }
    return `${provider}@${host}`;
}

function run(args) {
    return new Promise((resolve) => {
        execFile(SECURITY, args, { timeout: 10_000 }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout ?? "") }));
    });
}

const quote = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// The real store is the login Keychain; tests swap in an in-memory one.
export const backend = {
    async get(account) {
        const { ok, stdout } = await run(["find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
        return ok ? stdout.replace(/\n$/, "") || null : null;
    },
    async has(account) {
        return (await run(["find-generic-password", "-s", SERVICE, "-a", account])).ok;
    },
    // `security -i` reads the command from stdin, so the key never shows up in the process list.
    set(account, secret) {
        return new Promise((resolve, reject) => {
            const proc = spawn(SECURITY, ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
            let stderr = "";
            proc.stderr.on("data", (chunk) => {
                stderr += chunk;
            });
            proc.on("error", reject);
            proc.on("close", (code) => {
                if (code === 0 && !/error/i.test(stderr)) resolve();
                else reject(new Error(`Couldn't save the key in the Keychain: ${stderr.trim() || `exit ${code}`}`));
            });
            proc.stdin.end(`add-generic-password -U -s ${quote(SERVICE)} -a ${quote(account)} -l ${quote(`${SERVICE} (${account})`)} -w ${quote(secret)}\n`);
        });
    },
    async delete(account) {
        await run(["delete-generic-password", "-s", SERVICE, "-a", account]);
    },
};

export async function getSecret(account) {
    if (cache.has(account)) return cache.get(account);
    const value = await backend.get(account);
    if (value) cache.set(account, value);
    return value || null;
}

export async function hasSecret(account) {
    if (cache.has(account)) return true;
    return backend.has(account);
}

export async function setSecret(account, secret) {
    if (!secret || /[\r\n]/.test(secret) || secret.length > 4096) {
        throw Object.assign(new Error("That doesn't look like a valid API key"), { status: 400 });
    }
    await backend.set(account, secret);
    cache.set(account, secret);
}

export async function deleteSecret(account) {
    cache.delete(account);
    await backend.delete(account);
}
