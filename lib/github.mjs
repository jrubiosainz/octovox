import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RUN_DIR } from "./config.mjs";
import { log } from "./log.mjs";

const MAX_AGE_MS = 7 * 24 * 3600_000;
const LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

// The session's GitHub login according to the app itself (no credentials); otherwise the `gh` one.
export async function sessionLogin(session) {
    try {
        const status = await Promise.race([
            session.rpc.gitHubAuth.getStatus(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
        ]);
        const host = String(status?.host ?? "github.com");
        if (status?.login && LOGIN_PATTERN.test(status.login) && /(^|\.)github\.com(\/|$)/.test(host.replace(/^https?:\/\//, ""))) {
            return status.login;
        }
    } catch (error) {
        log("warn", "gitHubAuth.getStatus", error);
    }
    return githubLogin();
}

// GitHub user `gh` is signed in as; only the `user` field is read.
export function githubLogin() {
    const base = process.env.GH_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "gh");
    try {
        const text = readFileSync(join(base, "hosts.yml"), "utf8");
        const section = text.split(/^(?=\S)/m).find((block) => block.startsWith("github.com:"));
        const login = section?.match(/^\s+user:\s*(\S+)\s*$/m)?.[1];
        return login && LOGIN_PATTERN.test(login) ? login : null;
    } catch {
        return null;
    }
}

const downloads = new Map();

// The user's public avatar, cached for a week in .run/ so the panel doesn't depend on the network.
export function avatarFile(login) {
    if (!login) return Promise.resolve(null);
    const file = join(RUN_DIR, `avatar-${login}`);
    try {
        if (Date.now() - statSync(file).mtimeMs < MAX_AGE_MS) return Promise.resolve(file);
    } catch {
        // Not cached yet.
    }
    if (!downloads.has(login)) {
        downloads.set(
            login,
            (async () => {
                try {
                    const response = await fetch(`https://github.com/${encodeURIComponent(login)}.png?size=96`, {
                        signal: AbortSignal.timeout(6000),
                    });
                    const type = response.headers.get("content-type") ?? "";
                    if (!response.ok || !type.startsWith("image/")) throw new Error(`HTTP ${response.status} ${type}`);
                    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
                    return file;
                } catch (error) {
                    log("warn", "couldn't download the avatar", error);
                    try {
                        statSync(file);
                        return file;
                    } catch {
                        return null;
                    }
                } finally {
                    downloads.delete(login);
                }
            })(),
        );
    }
    return downloads.get(login);
}
