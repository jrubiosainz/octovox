import { readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PEERS_DIR } from "./config.mjs";
import { log } from "./log.mjs";

// Registry of live sessions with Octovox: one 0600 file per session with its port and token.
const fileFor = (sessionId) => join(PEERS_DIR, `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

export function writePeer(entry) {
    const file = fileFor(entry.sessionId);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...entry, updatedAt: new Date().toISOString() }), { mode: 0o600 });
    renameSync(tmp, file);
}

export function removePeer(sessionId, pid = process.pid) {
    const file = fileFor(sessionId);
    try {
        if (JSON.parse(readFileSync(file, "utf8")).pid === pid) unlinkSync(file);
    } catch {
        // Gone already, or owned by another process.
    }
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
}

export function listPeers() {
    const peers = [];
    let names = [];
    try {
        names = readdirSync(PEERS_DIR).filter((name) => name.endsWith(".json"));
    } catch {
        return peers;
    }
    for (const name of names) {
        const file = join(PEERS_DIR, name);
        try {
            const entry = JSON.parse(readFileSync(file, "utf8"));
            if (!entry?.sessionId || !entry.port || !entry.token) continue;
            if (!alive(entry.pid)) {
                unlinkSync(file);
                continue;
            }
            peers.push(entry);
        } catch {
            // Half-written file: skipped this time.
        }
    }
    return peers;
}

export async function peerFetch(peer, path, { method = "GET", body, timeoutMs = 2000 } = {}) {
    return fetch(`http://127.0.0.1:${peer.port}${path}`, {
        method,
        headers: { "X-Octovox-Peer": peer.token, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
}

export async function peerJson(peer, path, options) {
    const response = await peerFetch(peer, path, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { status: response.status });
    return payload;
}

// Reads a streaming NDJSON response and calls onItem for each line.
export async function readNdjson(response, onItem) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            try {
                onItem(JSON.parse(line));
            } catch (error) {
                log("warn", "invalid NDJSON line", error);
            }
        }
    }
    if (buffer.trim()) onItem(JSON.parse(buffer));
}
