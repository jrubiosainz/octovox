import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { RUN_DIR, STT_DIR } from "./config.mjs";
import { log } from "./log.mjs";
import { LANGUAGE_CODES } from "./text.mjs";

const PORT = Number(process.env.OCTOVOX_STT_PORT) || 18766;
const BASE = `http://127.0.0.1:${PORT}`;
const PYTHON = join(STT_DIR, ".venv", "bin", "python");
const SERVER = join(STT_DIR, "server.py");
const LOCK = join(RUN_DIR, "stt.starting");
const SERVER_VERSION = 2;
export const STT_LOG = join(RUN_DIR, "stt.log");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(path, { method = "GET", body, headers = {}, timeoutMs = 1000 } = {}) {
    const response = await fetch(BASE + path, {
        method,
        body,
        headers: { "X-Octovox": "1", ...headers },
        signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `STT HTTP ${response.status}`);
    return payload;
}

export async function sttHealth() {
    try {
        return await call("/health", { timeoutMs: 800 });
    } catch {
        return null;
    }
}

function acquireStartLock() {
    try {
        closeSync(openSync(LOCK, "wx"));
        return true;
    } catch {
        try {
            if (Date.now() - statSync(LOCK).mtimeMs > 60_000) {
                unlinkSync(LOCK);
                closeSync(openSync(LOCK, "wx"));
                return true;
            }
        } catch {
            // Another process won the race.
        }
        return false;
    }
}

function releaseStartLock() {
    try {
        unlinkSync(LOCK);
    } catch {
        // Already released.
    }
}

function spawnServer() {
    const out = openSync(STT_LOG, "a");
    try {
        // Independent of the session: every session shares it and it exits on its own after an hour unused.
        const child = spawn(PYTHON, [SERVER, "--port", String(PORT), "--preload"], {
            detached: true,
            stdio: ["ignore", out, out],
            env: { ...process.env, PYTHONUNBUFFERED: "1" },
        });
        child.unref();
        log("info", "speech server started", { pid: child.pid });
    } finally {
        closeSync(out);
    }
}

// A server from an older Octovox version keeps the port: replace it with the current one.
async function retireOldServer(health) {
    if (!health?.pid) return;
    try {
        process.kill(health.pid, "SIGTERM");
    } catch {
        return;
    }
    for (let i = 0; i < 20 && (await sttHealth()); i++) await sleep(150);
    log("info", "replaced an older speech server", { pid: health.pid, version: health.version ?? 1 });
}

async function ensureRunning() {
    let current = await sttHealth();
    if (current?.service === "octovox-stt" && (current.version ?? 1) >= SERVER_VERSION) return current;
    if (current?.service === "octovox-stt") {
        await retireOldServer(current);
        current = await sttHealth();
    }
    if (current) throw new Error(`Port ${PORT} is taken by another service (${current.service ?? "unknown"})`);
    if (!existsSync(PYTHON)) throw new Error(`The speech environment is missing. Run: ${join(STT_DIR, "setup.sh")}`);
    const owner = acquireStartLock();
    if (owner) spawnServer();
    try {
        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline) {
            await sleep(300);
            const health = await sttHealth();
            if (health?.service === "octovox-stt" && (health.version ?? 1) >= SERVER_VERSION) return health;
        }
    } finally {
        if (owner) releaseStartLock();
    }
    throw new Error(`The speech server didn't start. Check ${STT_LOG}`);
}

let ensuring = null;
export function ensureStt() {
    ensuring ??= ensureRunning().finally(() => {
        ensuring = null;
    });
    return ensuring;
}

export async function warmupStt() {
    await ensureStt();
    return call("/warmup", { method: "POST", timeoutMs: 120_000 });
}

export async function transcribe(wav, language = "auto", allowed = LANGUAGE_CODES) {
    await ensureStt();
    const query = new URLSearchParams({ language, allowed: allowed.join(",") });
    return call(`/transcribe?${query}`, {
        method: "POST",
        body: wav,
        headers: { "Content-Type": "audio/wav" },
        timeoutMs: 120_000,
    });
}
