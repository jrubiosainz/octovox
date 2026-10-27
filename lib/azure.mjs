import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

// Microsoft Entra ID tokens from the signed-in Azure CLI: no keys needed (and MCAPS-style
// subscriptions often disable keys on AI resources anyway).
const AZ_CANDIDATES = ["/opt/homebrew/bin/az", "/usr/local/bin/az", "/usr/bin/az"];
const RESOURCE = "https://cognitiveservices.azure.com";
const REFRESH_MARGIN_MS = 5 * 60_000;

let cached = null;
let pending = null;

export function findAz() {
    return AZ_CANDIDATES.find((path) => existsSync(path)) ?? null;
}

function requestToken() {
    const az = findAz();
    if (!az) return Promise.reject(new Error("Azure CLI not found. Install it (brew install azure-cli) and run az login."));
    return new Promise((resolve, reject) => {
        execFile(
            az,
            ["account", "get-access-token", "--resource", RESOURCE, "--output", "json"],
            { timeout: 45_000, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ""}` } },
            (error, stdout, stderr) => {
                if (error) {
                    const detail = String(stderr || error.message);
                    const login = /az login|AADSTS|expired|refresh token/i.test(detail);
                    reject(new Error(login ? "Your Azure CLI session has expired. Run az login in a terminal." : `Azure CLI couldn't get a token: ${detail.trim().split("\n").pop()}`));
                    return;
                }
                try {
                    const data = JSON.parse(stdout);
                    const expiresAt = data.expires_on ? Number(data.expires_on) * 1000 : Date.parse(data.expiresOn);
                    resolve({ token: data.accessToken, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 30 * 60_000 });
                } catch {
                    reject(new Error("Azure CLI returned an unexpected token response."));
                }
            },
        );
    });
}

export async function azureToken() {
    if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) return cached.token;
    pending ??= requestToken()
        .then((result) => {
            cached = result;
            return result.token;
        })
        .finally(() => {
            pending = null;
        });
    return pending;
}

export function forgetAzureToken() {
    cached = null;
}
