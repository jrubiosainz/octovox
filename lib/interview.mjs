// Octovox Interview: a live, full-duplex voice conversation (GPT-Live) about a Copilot session.
// The voice model talks with the user; when it needs details it delegates, and Octovox asks the
// session itself with an ephemeral side question, so the session never stops working.
import { EventEmitter } from "node:events";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { azureToken } from "./azure.mjs";
import { buildBriefing, describeItem, LogFollower, readSessionLog, timeline } from "./briefing.mjs";
import { isMuted, loadInterviewConfig, RUN_DIR } from "./config.mjs";
import { ensureDuplexHelper, openDuplex } from "./duplex.mjs";
import { log } from "./log.mjs";
import { clip, describeStatus, detectLanguage, formatDuration, isLanguage, LANGUAGES, sessionLabel } from "./text.mjs";
import { connectWebSocket } from "./ws.mjs";

const LOCK_FILE = join(RUN_DIR, "interview.lock");
export const CONTEXT_CHARS = 1600; // GPT-Live takes up to 500 tokens per context append
const START_TIMEOUT_MS = 20_000;
const UPDATE_EVERY_MS = 6000;
// Helper agents often finish together: one spoken update for all of them.
const AGENT_NEWS_MS = 800;
// The session's log is checked this often during an interview, so news arrives while it's still news.
const FOLLOW_MS = 1000;
const TURN_GAP_MS = 1500;
const MAX_TURNS = 400;
const MIC_CHUNK_BYTES = 1920; // 40 ms at 24 kHz
const SPEAKING_LEVEL = 0.3;
const WATCH_MS = 5000;
// GPT-Live bills by the second: end forgotten interviews.
const IDLE_END_MS = 10 * 60_000;
const NO_PANEL_END_MS = 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class InterviewError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

// Another Octovox process may be running an interview: it owns the microphone and the voice.
// GPT-Live sessions last an hour at most, so an older lock was left by a crash.
export function interviewElsewhere() {
    try {
        const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
        if (lock.pid === process.pid || Date.now() - Date.parse(lock.at) > 65 * 60_000) return null;
        process.kill(lock.pid, 0);
        return lock;
    } catch {
        return null;
    }
}

// GPT-Live lives on the resource's Azure OpenAI host, whichever endpoint form the user pasted.
export function liveSocketUrl(endpoint) {
    const url = new URL(endpoint);
    const resource = url.hostname.match(/^([a-z0-9-]+)\.(?:openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/i);
    const host = resource ? `${resource[1].toLowerCase()}.openai.azure.com` : url.host;
    return `wss://${host}/openai/v1/live/sessions`;
}

function friendly(error, endpoint) {
    const status = error?.status;
    if (status === 401 || status === 403) return "Azure denied access to GPT-Live. Your account needs the Cognitive Services OpenAI User role on that resource.";
    if (status === 404) return "GPT-Live isn't available at that endpoint. Check the endpoint and the deployment name in Settings.";
    if (status === 429) return "GPT-Live is busy (too many sessions or requests). Try again in a minute.";
    if (error?.code === "ENOTFOUND") return `Can't reach ${new URL(endpoint).hostname}. Check the endpoint and your connection.`;
    return error?.message ?? String(error);
}

const CLOSE_REASONS = {
    expired: "The interview reached GPT-Live's time limit.",
    content: "GPT-Live ended the interview (content filter).",
    remote_hangup: "GPT-Live ended the interview.",
    connection_lost: "The connection to GPT-Live was lost.",
};

// `fixed`: the user chose the language in Settings. Otherwise it's a guess from how they usually talk.
function languageRule(lang, fixed) {
    if (!isLanguage(lang)) return "Speak the language the user speaks, and follow them if they switch.";
    const name = LANGUAGES[lang].name;
    return fixed
        ? `Speak ${name}. If the user speaks another language, switch to theirs.`
        : `The user usually talks to Octovox in ${name}: start in ${name}, then always reply in the language the user speaks.`;
}

export function liveInstructions({ name, lang, fixed = false, briefing }) {
    return [
        `You are Octovox Interview, a live voice companion inside the GitHub Copilot app. The user is talking with you hands-free about a GitHub Copilot coding session called "${name}": what it did, what it's doing right now, why it made its decisions and what it needs from the user. Talk like a teammate who has been watching the session and can explain it clearly.`,
        "",
        "How to talk:",
        `- ${languageRule(lang, fixed)}`,
        "- Natural, warm and concise: one to three sentences per turn. When the user asks for detail, go deeper, step by step.",
        "- The user can interrupt you at any moment. When they do, stop and answer what they just said; don't restart your previous answer.",
        "- Never read out code, file paths, IDs, URLs or long numbers verbatim; describe them (\"the webhook handler\", \"pull request 517\").",
        "- Don't make things up. If something isn't in what you know, say so or check with the session.",
        "",
        "What you know:",
        "- The briefing below is a snapshot of the session from its own log. While you talk you'll quietly receive live updates as the session keeps working; the newest update is the truth. Don't narrate updates as they arrive: use them when they're relevant, and bring one up on your own only if it matters to the user (the session finished, hit a problem or needs them).",
        "- For anything that isn't in the briefing or the updates (the exact reason for a decision, specific results, what a file or a test contains, what it tried before), delegate. Octovox then asks the session itself, which has its whole context, without interrupting it. While you wait, say briefly that you're checking with the session; when the answer arrives, explain it in your own words.",
        "- You can't change anything: you don't send prompts, approve plans or run commands. If the user wants the session to do something, tell them to use Prompt in the Octovox panel.",
        "- Octovox also tells you news out loud as it happens: a helper agent of this session finished, or one of the user's sessions finished or needs them. Don't wait until your answer is over: as soon as you finish the sentence you're saying, give the news in one short sentence that names where it comes from (for example: \"I just got an update from the test agent: it finished, and the session is moving on to the next step\"), then say you're going back to your explanation and continue exactly where you left off.",
        "",
        "BRIEFING",
        briefing,
    ].join("\n");
}

const trimTo = (text, max = CONTEXT_CHARS) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// What GPT-Live says when the session's helper agents finish: who, what, and where the session goes next.
export function agentNewsText(sessionName, news, peer) {
    const describe = (item) => `"${item.name}"${item.description ? ` (${item.description})` : ""}`;
    const done = news.filter((item) => item.kind === "agent-done");
    const failed = news.filter((item) => item.kind === "agent-failed");
    const parts = [];
    if (done.length === 1) parts.push(`its helper agent ${describe(done[0])} just finished${done[0].durationMs ? `, after ${formatDuration(done[0].durationMs)}` : ""}`);
    else if (done.length > 1) parts.push(`${done.length} of its helper agents just finished: ${done.map(describe).join(", ")}`);
    if (failed.length === 1) parts.push(`its helper agent ${describe(failed[0])} failed${failed[0].error ? ` (${failed[0].error})` : ""}`);
    else if (failed.length > 1) parts.push(`${failed.length} of its helper agents failed: ${failed.map(describe).join(", ")}`);
    const todos = peer?.todos;
    const next = todos?.current
        ? ` The session moves on to the next step: "${clip(todos.current, 120)}" (${todos.done} of ${todos.total} tasks done).`
        : peer?.processing
          ? " The session keeps going with its next step."
          : "";
    return `Update from "${sessionName}": ${parts.join(", and ")}.${next}`;
}
// A turn can join fragments of separate utterances: keep a space between sentences.
export const joinDelta = (text, delta) => (/[.!?…]$/.test(text) && /^\p{Lu}/u.test(delta) ? `${text} ${delta}` : text + delta);

// Streams a session's answer to GPT-Live in sentence-sized appends, so it can start talking early.
export class CommentaryStream {
    constructor(send, { first = 80, rest = 280, max = CONTEXT_CHARS } = {}) {
        this.send = send;
        this.first = first;
        this.rest = rest;
        this.max = max;
        this.buffer = "";
        this.count = 0;
    }

    push(text) {
        this.buffer += text;
        this.#drain(false);
    }

    end() {
        this.#drain(true);
    }

    #drain(final) {
        for (;;) {
            const min = this.count === 0 ? this.first : this.rest;
            if (!this.buffer.trim()) {
                this.buffer = "";
                return;
            }
            if (!final && this.buffer.length < min) return;
            let cut = -1;
            const boundary = /[.!?…]["»”')\]]*\s/g;
            for (let match; (match = boundary.exec(this.buffer)); ) {
                const end = match.index + match[0].length;
                if (end > this.max) break;
                if (end >= min) cut = end;
            }
            if (cut < 0) {
                if (final) cut = Math.min(this.buffer.length, this.max);
                else if (this.buffer.length > this.max) cut = this.buffer.lastIndexOf(" ", this.max) > this.max / 2 ? this.buffer.lastIndexOf(" ", this.max) : this.max;
                else return;
            }
            const piece = this.buffer.slice(0, cut).trim();
            this.buffer = this.buffer.slice(cut);
            if (piece) {
                this.send(piece);
                this.count += 1;
            }
        }
    }
}

export class Interview extends EventEmitter {
    // The dependencies are injectable so tests can run without a microphone or speakers.
    constructor({ hub, openAudio = openDuplex, prepareAudio = ensureDuplexHelper, getToken = azureToken, connect = connectWebSocket }) {
        super();
        this.hub = hub;
        this.deps = { openAudio, prepareAudio, getToken, connect };
        this.seq = 0;
        this.generation = 0; // bumped by stop(): a start() still in progress then gives up
        this.#reset();
    }

    #reset() {
        this.state = "idle"; // idle | preparing | connecting | live | ending
        this.target = null;
        this.targetName = "";
        this.lang = null;
        this.fixedLang = false;
        this.ws = null;
        this.audio = null;
        this.follower = null;
        this.liveId = null;
        this.startedAt = null;
        this.expiresAt = null;
        this.lastHeardAt = 0;
        this.noPanelSince = 0;
        this.watchTimer = null;
        this.micMuted = false;
        this.micCarry = Buffer.alloc(0);
        this.turns = [];
        this.turnSeq = 0;
        this.splitNext = false;
        this.lastInputEnd = 0;
        this.lookups = new Map();
        this.updates = [];
        this.updateTimer = null;
        this.agentNews = [];
        this.agentTimer = null;
        this.usageSeconds = 0;
        this.serverClosed = false;
        this.closeReason = null;
        this.notice = null;
        this.error = null;
        this.speaking = false;
    }

    get active() {
        return this.state !== "idle";
    }

    #head() {
        return {
            state: this.state,
            target: this.target,
            targetName: this.targetName,
            startedAt: this.startedAt,
            expiresAt: this.expiresAt,
            micMuted: this.micMuted,
            echoCancellation: this.audio ? this.audio.echoCancellation : null,
            lang: this.lang,
            notice: this.notice,
            error: this.error,
        };
    }

    snapshot() {
        return {
            ...this.#head(),
            turns: this.turns.slice(-60).map(({ id, role, text }) => ({ id, role, text: text.trim() })),
            lookups: [...this.lookups.values()].slice(-12),
        };
    }

    #ui(kind, data = {}) {
        this.hub.broadcast({ type: "interview", kind, ...data });
    }

    #setState(state) {
        this.state = state;
        this.#ui("state", this.#head());
    }

    #notify(text) {
        this.notice = text;
        this.#ui("state", this.#head());
    }

    #eventId() {
        this.seq += 1;
        return `octovox_${this.seq}`;
    }

    #send(event) {
        if (this.ws?.open) this.ws.send(JSON.stringify(event));
    }

    #append(type, content, delegationId = null) {
        const text = String(content ?? "").trim();
        if (text) this.#send({ type, event_id: this.#eventId(), delegation_id: delegationId, content: trimTo(text) });
    }

    // Resolves with the next server event of `type`; rejects on a GPT-Live error, a closed socket or a timeout.
    #waitFor(type, timeoutMs) {
        return new Promise((resolve, reject) => {
            const finish = (fn, value) => {
                clearTimeout(timer);
                this.off("server", onEvent);
                this.off("closed", onClose);
                fn(value);
            };
            const onEvent = (event) => {
                if (event.type === type) finish(resolve, event);
                else if (event.type === "error" && type === "session.started") finish(reject, new Error(`GPT-Live: ${event.error?.message ?? "error"}`));
            };
            const onClose = (info) => finish(reject, new Error(`GPT-Live closed the connection${info?.reason ? `: ${info.reason}` : ""}.`));
            const timer = setTimeout(() => finish(reject, new Error("GPT-Live didn't answer in time.")), timeoutMs);
            this.on("server", onEvent);
            this.on("closed", onClose);
        });
    }

    async start({ target, lang = null, fixed = false }) {
        if (this.active) return this.snapshot();
        if (isMuted()) throw new InterviewError("Mute all messages is on. Turn it off to start an interview.", 409);
        const config = loadInterviewConfig();
        if (!config.endpoint || !config.deployment) throw new InterviewError("Set up Interview first: add your GPT-Live endpoint and deployment in Settings.", 400);
        const other = interviewElsewhere();
        if (other) throw new InterviewError(`An interview is already running about “${other.name ?? "another session"}”. End it first.`, 409);
        const peers = await this.hub.freshPeers().catch(() => []);
        const peer = peers.find((item) => item.sessionId === target) ?? (target ? null : peers.find((item) => item.self));
        if (!peer) throw new InterviewError("That session isn't available anymore.", 410);
        this.target = peer.sessionId;
        this.targetName = sessionLabel(peer);
        this.lang = isLanguage(lang) ? lang : null;
        this.fixedLang = fixed && !!this.lang;
        this.error = null;
        const generation = this.generation;
        const stopped = () => this.generation !== generation;
        this.#lock();
        this.#setState("preparing");
        this.hub.quietForInterview();
        try {
            const [token, briefing] = await Promise.all([
                this.deps.getToken(),
                this.#briefing(peer, peers),
                this.deps.prepareAudio({ onBuild: () => this.#notify("Preparing the audio for the first time (about 30 seconds)…") }).catch(() => null),
            ]);
            if (stopped()) return this.snapshot();
            this.notice = null;
            this.#setState("connecting");
            const ws = await this.deps.connect(liveSocketUrl(config.endpoint), { headers: { Authorization: `Bearer ${token}`, "User-Agent": "Octovox" } });
            if (stopped()) {
                ws.terminate();
                return this.snapshot();
            }
            this.ws = ws;
            // Listeners act only while this socket is the interview's: a late event from an old one is dropped.
            const current = () => this.ws === ws;
            ws.on("message", (text) => current() && this.#onMessage(text));
            ws.on("close", (info) => current() && this.#onClose(info));
            ws.on("error", (error) => log("warn", "interview socket", error.message));
            const started = this.#waitFor("session.started", START_TIMEOUT_MS);
            this.#send({
                type: "session.start",
                event_id: this.#eventId(),
                session: {
                    model: config.deployment,
                    instructions: liveInstructions({ name: this.targetName, lang: this.lang, fixed: this.fixedLang, briefing: briefing.text }),
                    audio: { output: { voice: config.voice } },
                    delegation: { type: "client" },
                },
            });
            const { session } = await started;
            this.liveId = session?.id ?? null;
            this.expiresAt = session?.expires_at ? session.expires_at * 1000 : null;
            const audio = await this.deps.openAudio();
            if (stopped()) {
                audio.close();
                return this.snapshot();
            }
            // GPT-Live may have hung up while the audio was starting.
            if (!ws.open || this.serverClosed) {
                audio.close();
                throw new Error(CLOSE_REASONS[this.closeReason] ?? "GPT-Live closed the connection while the audio was starting.");
            }
            this.audio = audio;
            const mine = () => this.audio === audio;
            audio.on("mic", (pcm) => mine() && this.#onMic(pcm));
            audio.on("status", (status) => mine() && this.#onAudioStatus(status));
            audio.on("notice", (text) => mine() && this.#notify(text));
            audio.on("exit", (info) => {
                if (mine() && !info.expected && this.state === "live") this.stop({ reason: "error", error: `The audio stopped${info.detail ? `: ${info.detail}` : "."}` });
            });
            this.startedAt = Date.now();
            this.lastHeardAt = this.startedAt;
            this.watchTimer = setInterval(() => this.#watch(), WATCH_MS);
            this.notice = audio.echoCancellation ? null : "No echo cancellation here: use headphones, or tap the orb to talk over Octovox.";
            this.follower = new LogFollower(this.target, { from: briefing.offset, intervalMs: FOLLOW_MS, toolNames: briefing.toolNames, onItems: (items) => !stopped() && this.#onLogItems(items) }).start();
            this.#setState("live");
            this.#greet(peer);
            log("info", "interview started", { target: this.target, live: this.liveId, echoCancellation: audio.echoCancellation });
            return this.snapshot();
        } catch (error) {
            // Ended by the user while it was still connecting: nothing to report.
            if (stopped()) return this.snapshot();
            const message = friendly(error, config.endpoint);
            log("warn", "interview start", error);
            await this.stop({ reason: "error", error: message });
            throw new InterviewError(message, error?.status === 401 || error?.status === 403 ? 403 : 502);
        }
    }

    async #briefing(peer, peers) {
        const others = peers
            .filter((item) => item.sessionId !== peer.sessionId && item.online)
            .map((item) => `${sessionLabel(item)}: ${describeStatus(item)}`);
        const logData = await readSessionLog(peer.sessionId).catch((error) => {
            log("warn", "interview briefing", error);
            return null;
        });
        const text = buildBriefing({ name: this.targetName, statusLine: describeStatus(peer), kind: peer.kind, cwd: peer.cwd, log: logData, others });
        // What the log already says about tools and helper agents, for the follower.
        const toolNames = new Map();
        if (logData) timeline(logData.events, toolNames);
        return { text, offset: logData?.size ?? 0, toolNames };
    }

    // Commentary is information GPT-Live says aloud (in the conversation's language, in its own words).
    #greet(peer) {
        this.#append("session.commentary.append", `Hi! I'm following the session "${this.targetName}" with you. Its status: ${describeStatus(peer)}. Ask me anything about it.`);
    }

    #watch() {
        if (this.state !== "live") return;
        const now = Date.now();
        if (now - this.lastHeardAt > IDLE_END_MS) {
            this.stop({ reason: "idle" });
            return;
        }
        // The panel was closed: keep talking for a while (the user may be switching sessions), then hang up.
        if (this.hub.clients.size) this.noPanelSince = 0;
        else if (!this.noPanelSince) this.noPanelSince = now;
        else if (now - Math.max(this.noPanelSince, this.lastHeardAt) > NO_PANEL_END_MS) this.stop({ reason: "closed" });
    }

    #onMessage(text) {
        let event;
        try {
            event = JSON.parse(text);
        } catch {
            return;
        }
        this.emit("server", event);
        switch (event.type) {
            case "session.output_audio.delta":
                if (this.audio && event.delta) this.audio.play(Buffer.from(event.delta, "base64"));
                break;
            case "session.input_transcript.delta":
                this.#onTranscript("user", event);
                break;
            case "session.output_transcript.delta":
                this.#onTranscript("assistant", event);
                break;
            case "session.delegation.created":
                this.#onDelegation(event).catch((error) => log("warn", "interview delegation", error));
                break;
            case "session.usage.updated":
                this.usageSeconds = event.usage?.seconds ?? this.usageSeconds;
                break;
            case "session.closed":
                this.usageSeconds = event.usage?.seconds ?? this.usageSeconds;
                this.serverClosed = true;
                this.closeReason = event.reason ?? null;
                if (this.state === "live") this.stop({ reason: event.reason ?? "remote", error: CLOSE_REASONS[event.reason] ?? null });
                break;
            case "error":
                log("warn", "GPT-Live error", event.error);
                if (this.state === "live" && event.error?.message) this.#notify(`GPT-Live: ${clip(event.error.message, 160)}`);
                break;
            default:
        }
    }

    #onClose(info) {
        this.emit("closed", info);
        if (this.state === "live") this.stop({ reason: "lost", error: "The connection to GPT-Live was lost." });
    }

    // The mic arrives in arbitrary pipe chunks: send whole samples, about 40 ms at a time.
    #onMic(pcm) {
        if (this.state !== "live" || !this.ws?.open) return;
        let data = this.micCarry.length ? Buffer.concat([this.micCarry, pcm]) : pcm;
        if (data.length < MIC_CHUNK_BYTES) {
            this.micCarry = data;
            return;
        }
        const even = data.length - (data.length % 2);
        this.micCarry = data.subarray(even);
        data = data.subarray(0, even);
        // If the network stalls, drop audio instead of falling further and further behind.
        if (this.ws.bufferedAmount > 512 * 1024) return;
        this.#send({ type: "session.input_audio.append", audio: data.toString("base64") });
    }

    #onAudioStatus({ in: input = 0, out = 0 }) {
        this.speaking = out > SPEAKING_LEVEL;
        this.#ui("level", { in: this.micMuted ? 0 : input, out, speaking: this.speaking });
    }

    #onTranscript(role, event) {
        const delta = String(event.delta ?? "");
        if (!delta) return;
        const start = Number(event.start_ms) || 0;
        const end = Number(event.end_ms) || start;
        if (role === "user") {
            this.lastInputEnd = Math.max(this.lastInputEnd, end);
            this.lastHeardAt = Date.now();
        }
        let turn = this.turns.at(-1);
        // After a lookup appears, Octovox's next words start a new turn, so the answer reads after it.
        if (!turn || turn.role !== role || start - turn.end > TURN_GAP_MS || (role === "assistant" && this.splitNext)) {
            if (role === "assistant") this.splitNext = false;
            turn = { id: ++this.turnSeq, role, text: "", start, end };
            this.turns.push(turn);
            if (this.turns.length > MAX_TURNS) this.turns.shift();
        }
        turn.text = joinDelta(turn.text, delta);
        turn.end = Math.max(turn.end, end);
        this.#ui("turn", { id: turn.id, role, text: turn.text.trim() });
    }

    // The user's latest request: their words since the last real answer (short fillers like "Hmm." split turns).
    #latestRequest() {
        const parts = [];
        for (let i = this.turns.length - 1; i >= 0; i--) {
            const text = this.turns[i].text.trim();
            if (this.turns[i].role === "user") parts.unshift(text);
            else if (text.length >= 40 && parts.length) break;
        }
        return clip(parts.join(" "), 300);
    }

    // What the session gets (framed by frameQuestion): the recent voice conversation, oldest first.
    conversationForSession() {
        const recent = [];
        let chars = 0;
        for (const turn of [...this.turns].reverse()) {
            const text = turn.text.trim();
            if (!text) continue;
            const line = `${turn.role === "user" ? "User" : "Voice assistant"}: ${clip(text, 420)}`;
            chars += line.length;
            if (chars > 2400 && recent.length) break;
            recent.unshift(line);
        }
        return recent.join("\n");
    }

    async #onDelegation(event) {
        const delegation = event.delegation ?? {};
        if (delegation.target !== "client" || !delegation.id) return;
        const id = delegation.id;
        // A side question can take minutes: if this interview ends meanwhile, its answer goes nowhere
        // (and never into a newer interview).
        const generation = this.generation;
        const live = () => this.generation === generation && this.state === "live";
        // The model often delegates before the user has finished, and transcription runs a little behind
        // the audio: wait until the user's words stop arriving.
        const offset = Number(event.offset_ms) || 0;
        const until = Date.now() + 3000;
        while (live() && Date.now() < until) {
            if (this.lastInputEnd >= offset - 600 && Date.now() - this.lastHeardAt > 800) break;
            await sleep(100);
        }
        if (!live()) return;
        const lookup = { id, question: this.#latestRequest(), answer: "", state: "asking", at: Date.now() };
        this.lookups.set(id, lookup);
        if (this.lookups.size > 30) this.lookups.delete(this.lookups.keys().next().value);
        this.#ui("lookup", lookup);
        // Octovox's words after the session's answer arrives start a new turn, so they read after the lookup.
        let answered = false;
        const commentary = (content) => {
            if (!live()) return;
            if (!answered) this.splitNext = answered = true;
            this.#append("session.commentary.append", content, id);
        };
        const stream = new CommentaryStream(commentary);
        let shownAt = 0;
        const conversation = this.conversationForSession();
        try {
            const { answer } = await this.hub.ask({
                target: this.target,
                question: conversation || lookup.question || "What are you doing right now?",
                display: lookup.question || "(asked during the interview)",
                via: "interview",
                lang: this.fixedLang ? this.lang : detectLanguage(lookup.question, { fallback: this.lang }),
                speak: false,
                detail: true,
                onChunk: (chunk) => {
                    lookup.answer += chunk;
                    if (!live()) return;
                    stream.push(chunk);
                    if (Date.now() - shownAt > 250) {
                        shownAt = Date.now();
                        this.#ui("lookup", lookup);
                    }
                },
            });
            stream.end();
            lookup.answer = String(answer || lookup.answer).trim();
            lookup.state = "done";
        } catch (error) {
            lookup.state = "error";
            lookup.error = error.message;
            commentary(`I couldn't check that with the session: ${clip(error.message, 160)}`);
        }
        if (live()) this.#ui("lookup", lookup);
    }

    // New events in the session's log become quiet context, a few at a time. Finished helper agents are
    // news: GPT-Live says them right away.
    #onLogItems(items) {
        if (this.state !== "live") return;
        const news = items.filter((item) => item.kind === "agent-done" || item.kind === "agent-failed");
        if (news.length) {
            this.agentNews.push(...news);
            this.agentTimer ??= setTimeout(() => this.#flushAgentNews(), AGENT_NEWS_MS);
        }
        const quiet = news.length ? items.filter((item) => !news.includes(item)) : items;
        if (!quiet.length) return;
        this.updates.push(...quiet);
        const urgent = quiet.some((item) => item.kind === "user" || item.kind === "said" || item.kind === "abort");
        if (urgent) clearTimeout(this.updateTimer);
        if (urgent || !this.updateTimer) this.updateTimer = setTimeout(() => this.#flushUpdates(), urgent ? 400 : UPDATE_EVERY_MS);
    }

    async #flushAgentNews() {
        this.agentTimer = null;
        const news = this.agentNews.splice(0);
        if (this.state !== "live" || !news.length) return;
        const generation = this.generation;
        // Fresh status, so the update can say where the session goes next.
        const peers = await this.hub.freshPeers(0).catch(() => []);
        if (this.generation !== generation || this.state !== "live") return;
        const peer = peers.find((item) => item.sessionId === this.target);
        this.#append("session.commentary.append", agentNewsText(this.targetName, news, peer));
        const failed = news.some((item) => item.kind === "agent-failed");
        this.#ui("note", {
            source: "agent",
            tone: failed ? "danger" : "success",
            text: news.map((item) => `Helper agent “${item.name}” ${item.kind === "agent-failed" ? "failed" : "finished"}`).join(" · "),
        });
    }

    #flushUpdates() {
        this.updateTimer = null;
        const items = this.updates.splice(0);
        if (this.state !== "live" || !items.length) return;
        const now = new Date();
        const head = `Live update from "${this.targetName}" (newest last):`;
        let lines = items.map((item) => describeItem(item, now));
        while (lines.length > 1 && [head, ...lines].join("\n").length > CONTEXT_CHARS) lines = lines.slice(1);
        this.#append("session.thinking.append", [head, ...lines].join("\n"));
        this.#ui("update", { lines: items.slice(-3).map((item) => clip(item.text, 140)) });
    }

    // Alerts from the hub (a session finished or needs the user) go through the live voice.
    alert(text, { speak = true } = {}) {
        if (this.state !== "live") return false;
        if (speak) this.#append("session.commentary.append", `Heads-up: ${text}`);
        else this.#append("session.thinking.append", `Octovox alert, for context only: ${text}`);
        this.#ui("note", { text });
        return true;
    }

    // Without echo cancellation the mic is held while Octovox speaks: this lets the user talk over it.
    interrupt() {
        this.audio?.holdOpen?.(5000);
    }

    setMicMuted(on) {
        this.micMuted = !!on;
        this.audio?.mute(this.micMuted);
        if (this.state === "live") this.#send({ type: this.micMuted ? "session.input_audio.mute" : "session.input_audio.unmute", event_id: this.#eventId() });
        this.#ui("state", this.#head());
        return this.snapshot();
    }

    async stop({ reason = "user", error = null } = {}) {
        if (this.state === "idle" || this.state === "ending") return this.snapshot();
        this.generation += 1;
        const wasLive = this.state === "live";
        this.error = error;
        this.#setState("ending");
        clearInterval(this.watchTimer);
        this.follower?.stop();
        clearTimeout(this.updateTimer);
        clearTimeout(this.agentTimer);
        this.audio?.close();
        const ws = this.ws;
        if (ws?.open && !this.serverClosed) {
            const closed = this.#waitFor("session.closed", 2500).catch(() => null);
            this.#send({ type: "session.close", event_id: this.#eventId() });
            await closed;
            ws.close();
        } else {
            ws?.terminate();
        }
        this.#unlock();
        const seconds = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
        const summary = {
            target: this.target,
            targetName: this.targetName,
            seconds,
            billedSeconds: this.usageSeconds || null,
            reason,
            error,
            turns: this.turns.filter((turn) => turn.text.trim()).map(({ role, text }) => ({ role, text: clip(text, 2000) })),
            lookups: [...this.lookups.values()].map(({ question, answer, state }) => ({ question, answer: clip(answer, 2000), state })),
        };
        if (wasLive) {
            this.hub.recordInterview(summary).catch((failure) => log("warn", "interview record", failure));
            log("info", "interview ended", { reason, seconds, turns: summary.turns.length, lookups: summary.lookups.length });
        }
        this.#ui("ended", { ...summary, wasLive });
        this.#reset();
        this.#ui("state", this.#head());
        return this.snapshot();
    }

    // Process exit: no time for a graceful close.
    destroy() {
        clearInterval(this.watchTimer);
        clearTimeout(this.updateTimer);
        clearTimeout(this.agentTimer);
        this.follower?.stop();
        this.audio?.close();
        this.ws?.terminate();
        if (this.active) this.#unlock();
    }

    #lock() {
        writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, sessionId: this.hub.local.sessionId, target: this.target, name: this.targetName, at: new Date().toISOString() }));
    }

    #unlock() {
        try {
            if (JSON.parse(readFileSync(LOCK_FILE, "utf8")).pid === process.pid) rmSync(LOCK_FILE, { force: true });
        } catch {
            // No lock.
        }
    }
}
