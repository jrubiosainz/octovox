import { appendFileSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { EXT_NAME, RUN_DIR } from "./config.mjs";

// stdout is reserved for JSON-RPC: diagnostics go to a file.
const LOG_FILE = join(RUN_DIR, `${EXT_NAME}.log`);

export function log(level, message, extra) {
    try {
        const detail = extra === undefined ? "" : ` ${extra instanceof Error ? extra.stack || extra.message : JSON.stringify(extra)}`;
        appendFileSync(LOG_FILE, `${new Date().toISOString()} ${process.pid} ${level} ${message}${detail}\n`);
    } catch {
        // Logging must never break the extension.
    }
}

export function rotateLog(maxBytes = 2_000_000) {
    try {
        if (statSync(LOG_FILE).size > maxBytes) truncateSync(LOG_FILE, 0);
    } catch {
        // No file yet.
    }
}
