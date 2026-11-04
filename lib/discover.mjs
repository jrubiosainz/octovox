// "Find it in my Azure account": the GPT-Live deployments the signed-in Azure CLI user can see.
// Resource Graph lists the AI resources in one call; their deployments come from ARM in parallel.
import { execFile } from "node:child_process";
import { findAz } from "./azure.mjs";

const ARM = "https://management.azure.com";
const API_VERSION = "2024-10-01";
const MAX_ACCOUNTS = 300;
const ACCOUNTS_QUERY =
    "resources | where type =~ 'microsoft.cognitiveservices/accounts' | where kind in~ ('AIServices', 'OpenAI') | project id, name, location, subdomain = tostring(properties.customSubDomainName), endpoint = tostring(properties.endpoint)";

function az(args, timeout = 45_000) {
    const bin = findAz();
    if (!bin) return Promise.reject(new Error("Azure CLI not found. Install it (brew install azure-cli) and run az login."));
    return new Promise((resolve, reject) => {
        execFile(
            bin,
            [...args, "--only-show-errors", "--output", "json"],
            { timeout, maxBuffer: 32 << 20, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ""}` } },
            (error, stdout, stderr) => {
                if (error) {
                    const detail = String(stderr || error.message).trim();
                    reject(new Error(/az login|AADSTS|expired/i.test(detail) ? "Your Azure CLI session has expired. Run az login in a terminal." : detail.split("\n").pop()));
                    return;
                }
                try {
                    resolve(JSON.parse(stdout || "null"));
                } catch {
                    reject(new Error("The Azure CLI returned something unexpected."));
                }
            },
        );
    });
}

export const liveEndpointFor = (account) => (account.subdomain ? `https://${account.subdomain.toLowerCase()}.openai.azure.com` : String(account.endpoint ?? "").replace(/\/+$/, ""));

async function listAccounts() {
    try {
        return (await az(["graph", "query", "-q", ACCOUNTS_QUERY, "--first", "1000"]))?.data ?? [];
    } catch {
        // No Resource Graph extension: the current subscription only.
        const list = await az(["cognitiveservices", "account", "list"]);
        return (list ?? [])
            .filter((item) => /^(AIServices|OpenAI)$/i.test(item.kind))
            .map((item) => ({ id: item.id, name: item.name, location: item.location, subdomain: item.properties?.customSubDomainName ?? "", endpoint: item.properties?.endpoint ?? "" }));
    }
}

export async function findLiveDeployments({ fetchImpl = fetch, concurrency = 10 } = {}) {
    const [accounts, token] = await Promise.all([listAccounts(), az(["account", "get-access-token", "--resource", ARM])]);
    const queue = accounts.slice(0, MAX_ACCOUNTS);
    const deployments = [];
    let failed = 0;
    const worker = async () => {
        for (let account; (account = queue.shift()); ) {
            try {
                const response = await fetchImpl(`${ARM}${account.id}/deployments?api-version=${API_VERSION}`, {
                    headers: { Authorization: `Bearer ${token.accessToken}` },
                    signal: AbortSignal.timeout(15_000),
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const { value = [] } = await response.json();
                for (const item of value) {
                    const model = item.properties?.model ?? {};
                    if (!/^gpt-live/i.test(model.name ?? "")) continue;
                    deployments.push({ resource: account.name, location: account.location, endpoint: liveEndpointFor(account), deployment: item.name, model: model.name, version: model.version ?? "" });
                }
            } catch {
                failed += 1;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
    deployments.sort((a, b) => a.resource.localeCompare(b.resource) || a.deployment.localeCompare(b.deployment));
    return { deployments, scanned: Math.min(accounts.length, MAX_ACCOUNTS), failed };
}
