// What Octovox Interview knows about a session: its own log (events.jsonl), summarized into a
// briefing for GPT-Live, plus a follower that turns new events into live updates.
import { open, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { COPILOT_HOME } from "./config.mjs";
import { cleanForSpeech, clip, formatDuration, summarizeTool } from "./text.mjs";

export const sessionLogPath = (sessionId) => join(COPILOT_HOME, "session-state", sessionId, "events.jsonl");

// Only these events matter for a conversation summary; the rest (hooks, usage, binary assets…) are skipped
// without being parsed, which keeps a 100 MB log cheap to read.
const KEEP = [
    '{"type":"user.message"',
    '{"type":"assistant.message"',
    '{"type":"tool.execution_start"',
    '{"type":"tool.execution_complete"',
    '{"type":"abort"',
    '{"type":"subagent.started"',
    '{"type":"subagent.completed"',
    '{"type":"subagent.failed"',
];
const USER_PREFIX = Buffer.from('\n{"type":"user.message"');
const TAIL_BYTES = 3 * 1024 * 1024;
const SCAN_CHUNK = 8 * 1024 * 1024;
const BRIEFING_CHARS = 14_000;

function parseLine(line) {
    if (!KEEP.some((prefix) => line.startsWith(prefix))) return null;
    try {
        const event = JSON.parse(line);
        // Sub-agents log their own steps with an agentId; the summary follows the main conversation.
        if (event.agentId && !event.type.startsWith("subagent.")) return null;
        return event;
    } catch {
        return null;
    }
}

export function parseLines(text) {
    const events = [];
    for (const line of text.split("\n")) {
        const event = parseLine(line);
        if (event) events.push(event);
    }
    return events;
}

async function readRange(handle, start, end) {
    const buffer = Buffer.alloc(Math.max(0, end - start));
    let read = 0;
    while (read < buffer.length) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, start + read);
        if (!bytesRead) break;
        read += bytesRead;
    }
    return buffer.subarray(0, read);
}

// Every user message in the log, found with a byte search (no need to decode the whole file).
async function scanUserMessages(handle, size) {
    const found = [];
    let carry = Buffer.from("\n"); // the first line has no newline before it
    for (let pos = 0; pos < size; pos += SCAN_CHUNK) {
        const chunk = await readRange(handle, pos, Math.min(size, pos + SCAN_CHUNK));
        const data = Buffer.concat([carry, chunk]);
        let from = 0;
        let keepFrom = Math.max(0, data.length - USER_PREFIX.length + 1);
        for (;;) {
            const hit = data.indexOf(USER_PREFIX, from);
            if (hit < 0) break;
            const end = data.indexOf(0x0a, hit + 1);
            if (end < 0) {
                keepFrom = hit; // the line continues in the next chunk
                break;
            }
            const event = parseLine(data.subarray(hit + 1, end).toString("utf8"));
            if (event) found.push(event);
            from = end;
        }
        carry = data.subarray(keepFrom);
    }
    return found;
}

// Reads the user's requests (whole log) and the recent events (tail) of a session.
export async function readSessionLog(sessionId, { tailBytes = TAIL_BYTES } = {}) {
    const file = sessionLogPath(sessionId);
    let info;
    try {
        info = await stat(file);
    } catch {
        return null;
    }
    const handle = await open(file, "r");
    try {
        const size = info.size;
        const users = await scanUserMessages(handle, size);
        const from = Math.max(0, size - tailBytes);
        const lines = (await readRange(handle, from, size)).toString("utf8").split("\n");
        if (from > 0) lines.shift(); // partial first line
        const events = [];
        for (const line of lines) {
            const event = parseLine(line);
            if (event) events.push(event);
        }
        return { file, size, users, events };
    } finally {
        await handle.close();
    }
}

const toolError = (data) => clip(data?.error?.message ?? data?.result?.error ?? data?.result?.content ?? "", 140);
// "/Users/me/repo/lib/x.mjs" → "x.mjs": paths are noise for a spoken summary.
const shortPaths = (text) => text.replace(/(?:~|\.{1,2})?(?:\/[\w.@-]+){2,}\/?/g, (path) => path.split("/").filter(Boolean).pop() ?? path);

// Session events as short timeline items: what the user asked, what Copilot said and did.
export function timeline(events, toolNames = new Map()) {
    const items = [];
    for (const event of events) {
        const data = event.data ?? {};
        const at = Date.parse(event.timestamp) || Date.now();
        switch (event.type) {
            case "user.message":
                if (typeof data.content === "string" && data.content.trim()) items.push({ at, kind: "user", text: clip(data.content, 320) });
                break;
            case "assistant.message": {
                if (typeof data.content === "string" && data.content.trim()) items.push({ at, kind: "said", text: clip(cleanForSpeech(data.content, 700), 340) });
                const requests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
                for (const request of requests) if (request.toolCallId) toolNames.set(request.toolCallId, request.name);
                const steps = requests.map((request) => request.intentionSummary || summarizeTool(request.name, request.arguments)).filter(Boolean);
                if (steps.length) items.push({ at, kind: "steps", text: clip(shortPaths(steps.join("; ")), 240) });
                break;
            }
            case "tool.execution_start":
                if (data.toolCallId) toolNames.set(data.toolCallId, data.toolName);
                break;
            case "tool.execution_complete":
                if (data.success === false) items.push({ at, kind: "failed", text: `${toolNames.get(data.toolCallId) ?? "A tool"} failed: ${toolError(data)}` });
                break;
            case "abort":
                items.push({ at, kind: "abort", text: "The user stopped the session." });
                break;
            case "subagent.started": {
                const name = data.agentDisplayName || data.agentName || "agent";
                const description = clip(data.agentDescription ?? "", 90);
                // Its description is only in this event: remembered for when it finishes.
                if (data.toolCallId) toolNames.set(`agent:${data.toolCallId}`, { name, description });
                items.push({ at, kind: "agent", text: `Started a helper agent: ${name}${description ? ` (${description})` : ""}` });
                break;
            }
            case "subagent.completed":
            case "subagent.failed": {
                const started = toolNames.get(`agent:${data.toolCallId}`);
                const name = data.agentDisplayName || data.agentName || started?.name || "agent";
                const description = started?.description ?? "";
                const failed = event.type === "subagent.failed";
                const durationMs = Number(data.durationMs) > 0 ? Number(data.durationMs) : null;
                const error = failed ? clip(typeof data.error === "string" ? data.error : (data.error?.message ?? ""), 140) : "";
                const text = `Helper agent ${name}${description ? ` (${description})` : ""} ${failed ? "failed" : "finished"}${durationMs ? ` after ${formatDuration(durationMs)}` : ""}${error ? `: ${error}` : ""}`;
                items.push({ at, kind: failed ? "agent-failed" : "agent-done", name, description, durationMs, error, text });
                break;
            }
            default:
        }
    }
    return items;
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const clockFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const stamp = (ms, now = new Date()) => {
    const date = new Date(ms);
    return sameDay(date, now) ? clockFmt.format(date) : dayFmt.format(date);
};

export function describeItem(item, now = new Date()) {
    const when = `[${stamp(item.at, now)}]`;
    switch (item.kind) {
        case "user":
            return `${when} The user wrote to the session: "${item.text}"`;
        case "said":
            return `${when} Copilot said: "${item.text}"`;
        case "steps":
            return `${when} Copilot started: ${item.text}`;
        case "failed":
            return `${when} ${item.text}`;
        default:
            return `${when} ${item.text}`;
    }
}

// The session as seen by Octovox, for GPT-Live's instructions. Keeps the newest details when it's long.
export function buildBriefing({ name, statusLine, kind, cwd, log, others = [], now = new Date(), maxChars = BRIEFING_CHARS }) {
    const head = [`Session: "${name}"${kind === "project" && cwd ? `, working in the project folder "${basename(cwd)}"` : ""}.`, `Status now: ${statusLine || "unknown"}.`, `Local time now: ${stamp(now, now)}.`];
    const requests = [];
    const users = (log?.users ?? []).map((event) => ({ at: Date.parse(event.timestamp), text: clip(event.data?.content, 360) })).filter((item) => item.text);
    if (users.length) {
        const shown = users.length > 14 ? [...users.slice(0, 2), null, ...users.slice(-12)] : users;
        for (const item of shown) requests.push(item ? `- [${stamp(item.at, now)}] "${item.text}"` : `- (${users.length - 14} more requests in between)`);
    }
    const items = timeline(log?.events ?? []);
    const latest = [...(log?.events ?? [])].reverse().find((event) => event.type === "assistant.message" && typeof event.data?.content === "string" && event.data.content.trim());
    const latestText = latest ? cleanForSpeech(latest.data.content, 1800) : "";
    const otherLines = others.map((line) => `- ${line}`);
    const section = (title, lines) => (lines.length ? ["", title, ...lines] : []);
    const compose = (work) =>
        [
            ...head,
            ...section("What the user asked the session (oldest first):", requests),
            ...section("Recent work, from the session's own log (oldest first):", work),
            ...(latestText ? ["", `Latest message from the session to the user (${stamp(Date.parse(latest.timestamp), now)}):`, `"${latestText}"`] : []),
            ...section("The user's other open sessions:", otherLines),
        ].join("\n");
    let work = items.slice(-60).map((item) => describeItem(item, now));
    let text = compose(work);
    while (text.length > maxChars && work.length > 6) {
        work = work.slice(Math.ceil(work.length / 5));
        text = compose(work);
    }
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

// Watches a session's log and reports new timeline items as they're written. `toolNames` carries what
// earlier events said about tools and helper agents (from the briefing), so their ends can be named.
export class LogFollower {
    constructor(sessionId, { from = 0, intervalMs = 2000, onItems, toolNames = new Map() }) {
        this.file = sessionLogPath(sessionId);
        this.offset = from;
        this.intervalMs = intervalMs;
        this.onItems = onItems;
        this.carry = "";
        this.toolNames = toolNames;
        this.timer = null;
        this.busy = false;
    }

    start() {
        this.timer ??= setInterval(() => this.poll(), this.intervalMs);
        return this;
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
    }

    async poll() {
        if (this.busy) return;
        this.busy = true;
        try {
            const { size } = await stat(this.file);
            if (size < this.offset) this.offset = 0; // rewritten
            if (size === this.offset) return;
            const handle = await open(this.file, "r");
            let text;
            try {
                text = (await readRange(handle, this.offset, size)).toString("utf8");
            } finally {
                await handle.close();
            }
            this.offset = size;
            const data = this.carry + text;
            const cut = data.lastIndexOf("\n");
            this.carry = cut < 0 ? data : data.slice(cut + 1);
            if (cut < 0) return;
            const items = timeline(parseLines(data.slice(0, cut)), this.toolNames);
            if (items.length) this.onItems(items);
        } catch {
            // The log may not exist (yet) for this session.
        } finally {
            this.busy = false;
        }
    }
}
