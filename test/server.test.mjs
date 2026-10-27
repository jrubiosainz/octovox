import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// Logs, settings and marks go to a temporary COPILOT_HOME before any module loads.
const home = mkdtempSync(join(tmpdir(), "octovox-test-"));
process.env.COPILOT_HOME = home;

const { ensureDirs } = await import("../lib/config.mjs");
const { Hub } = await import("../lib/hub.mjs");
const { LocalSession } = await import("../lib/local.mjs");
const { listPeers, removePeer, writePeer } = await import("../lib/peers.mjs");
const { startHttpServer } = await import("../lib/server.mjs");
const { SessionTracker } = await import("../lib/tracker.mjs");
const secrets = await import("../lib/secrets.mjs");
const { playback } = await import("../lib/tts.mjs");

// Nothing touches the real Keychain or the speakers.
const keychain = new Map();
Object.assign(secrets.backend, {
    get: async (account) => keychain.get(account) ?? null,
    has: async (account) => keychain.has(account),
    set: async (account, secret) => void keychain.set(account, secret),
    delete: async (account) => void keychain.delete(account),
});
const played = [];
playback.audio = (audio, format) => fakeProc(`${format}:${audio.length}`);
playback.say = async (text, lang) => fakeProc(`say[${lang}] ${text}`);
function fakeProc(label) {
    played.push(label);
    const proc = new EventEmitter();
    proc.kill = () => setImmediate(() => proc.emit("close"));
    setTimeout(() => proc.emit("close"), 5);
    return proc;
}

// A fake Azure Speech resource on loopback (API-key auth).
const speech = { requests: [] };
const VOICES = [
    { ShortName: "es-ES-Marta:MAI-Voice-2.1", Locale: "es-ES", Gender: "Female", VoiceTag: { Source: ["MAI"] } },
    { ShortName: "es-MX-Valeria:MAI-Voice-2.1", Locale: "es-MX", Gender: "Female", VoiceTag: { Source: ["MAI"] } },
    { ShortName: "it-IT-Rosa:MAI-Voice-2.1", Locale: "it-IT", Gender: "Female", VoiceTag: { Source: ["MAI"] } },
    { ShortName: "en-US-Harper:MAI-Voice-2.1", Locale: "en-US", Gender: "Female", VoiceTag: { Source: ["MAI"] } },
    { ShortName: "en-US-Harper:MAI-Voice-2.1-Flash", Locale: "en-US", Gender: "Female", VoiceTag: { Source: ["MAI"] } },
];
const speechServer = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
        speech.requests.push({ method: req.method, url: req.url, key: req.headers["ocp-apim-subscription-key"], body });
        if (req.headers["ocp-apim-subscription-key"] !== "k-123") return res.writeHead(401).end("bad key");
        if (req.url === "/tts/cognitiveservices/voices/list") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(VOICES));
        if (req.url === "/tts/cognitiveservices/v1" && req.method === "POST") return res.writeHead(200, { "Content-Type": "audio/mpeg" }).end(Buffer.from("ID3-fake-mp3"));
        res.writeHead(404).end();
    });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeSession {
    constructor(sessionId, name) {
        this.sessionId = sessionId;
        this.workspacePath = mkdtempSync(join(home, `ws-${sessionId}-`));
        this.handlers = new Set();
        this.sent = [];
        this.answers = [];
        this.questions = [];
        this.processing = true;
        this.rpc = {
            name: { get: async () => ({ name }) },
            metadata: { isProcessing: async () => ({ processing: this.processing }) },
            plan: {
                readSqlTodos: async () => ({
                    rows: [
                        { id: "a", title: "Read the code", status: "done" },
                        { id: "b", title: "Write tests", status: "in_progress" },
                    ],
                }),
            },
            ui: {
                ephemeralQuery: async ({ question }) => {
                    this.questions.push(question);
                    const requestId = `rq-${this.questions.length}`;
                    this.emit({ type: "ui.ephemeral_query", data: { phase: "started", requestId } });
                    for (const chunk of ["All good ", "in ", name, "."]) {
                        await sleep(5);
                        this.emit({ type: "ui.ephemeral_query", data: { phase: "chunk", requestId, chunk } });
                    }
                    return { answer: `All good in ${name}.` };
                },
                handlePendingUserInput: async (params) => {
                    this.answers.push(params);
                    this.emit({ type: "user_input.completed", data: { requestId: params.requestId } });
                    return { success: true };
                },
            },
        };
    }

    on(typeOrHandler, handler) {
        const listener = typeof typeOrHandler === "function" ? typeOrHandler : (event) => event.type === typeOrHandler && handler(event);
        this.handlers.add(listener);
        return () => this.handlers.delete(listener);
    }

    emit(event) {
        for (const listener of [...this.handlers]) listener(event);
    }

    async send(options) {
        this.sent.push(options);
        return `msg-${this.sent.length}`;
    }
}

async function boot(sessionId, name, withHub) {
    const session = new FakeSession(sessionId, name);
    const tracker = new SessionTracker(session);
    await tracker.init();
    const local = new LocalSession(session, tracker);
    const hub = withHub ? new Hub({ local }) : null;
    if (hub) hub.warmup = () => {};
    const uiToken = `ui-${sessionId}`;
    const peerToken = `peer-${sessionId}`;
    const http = await startHttpServer({ uiToken, peerToken, getHub: () => hub, getLocal: () => local });
    writePeer({ sessionId, pid: process.pid, port: http.port, token: peerToken, name, cwd: "/tmp", startedAt: new Date().toISOString() });
    return { session, tracker, local, hub, http, uiToken, peerToken };
}

function call(node, path, { method = "GET", body, headers = {}, raw = false } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
        const req = request(
            {
                host: "127.0.0.1",
                port: node.http.port,
                path,
                method,
                headers: {
                    "X-Octovox-Token": node.uiToken,
                    ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
                    ...headers,
                },
            },
            (res) => {
                let data = "";
                res.setEncoding("utf8");
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    if (raw) return resolve({ status: res.statusCode, text: data });
                    let parsed = data;
                    try {
                        parsed = JSON.parse(data);
                    } catch {
                        parsed = data
                            .trim()
                            .split("\n")
                            .filter(Boolean)
                            .map((line) => JSON.parse(line));
                    }
                    resolve({ status: res.statusCode, body: parsed });
                });
            },
        );
        req.on("error", reject);
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

let a;
let b;

before(async () => {
    ensureDirs();
    await new Promise((resolve) => speechServer.listen(0, "127.0.0.1", resolve));
    a = await boot("sess-a", "Coordinator", true);
    b = await boot("sess-b", "Payments API", false);
    await call(a, "/api/settings", { method: "POST", body: { speak: false, announce: false } });
});

after(() => {
    a?.http.server.close();
    b?.http.server.close();
    a?.hub.shutdown();
    speechServer.close();
    rmSync(home, { recursive: true, force: true });
});

test("the panel only answers loopback requests with a token and JSON", async () => {
    assert.equal((await call(a, "/api/state", { headers: { Host: "evil.example" } })).status, 421);
    assert.equal((await call(a, "/api/state", { headers: { "X-Octovox-Token": "nope" } })).status, 401);
    assert.equal((await call(a, "/peer/status", { headers: { "X-Octovox-Peer": "nope" } })).status, 401);
    const form = await call(a, "/api/rec/cancel", { method: "POST", body: "x=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    assert.equal(form.status, 415);
    const page = await call(a, "/ui/?t=x", { raw: true });
    assert.equal(page.status, 200);
    assert.match(page.text, /id="ptt"/);
    assert.match(page.text, /<html lang="en">/);
    assert.match(page.text, /<symbol id="oi-copilot-16"/, "inlines the Octicons sprite");
    assert.match(page.text, /<symbol id="oi-key-16"/);
    assert.match(page.text, /<symbol id="ov-mark"/, "inlines the Octovox mark");
    assert.doesNotMatch(page.text, /<!--ICONS-->/);
    const font = await call(a, "/ui/fonts/mona-sans.woff2", { raw: true });
    assert.equal(font.status, 200, "serves Mona Sans");
});

test("state: this session, settings, languages, voices and live sessions from the start", async () => {
    const { status, body } = await call(a, "/api/state");
    assert.equal(status, 200);
    assert.equal(body.self.sessionId, "sess-a");
    assert.ok("login" in body.user);
    assert.equal(body.settings.speak, false);
    assert.equal(body.settings.sounds, true);
    assert.ok(Array.isArray(body.systemVoices));
    assert.deepEqual(body.languages.map((item) => item.code), ["en", "es", "it", "de", "fr", "pt", "nl", "pl"]);
    assert.deepEqual(body.languages[1], { code: "es", name: "Spanish", native: "Español" });
    assert.equal(typeof body.voiceStatus.azureCli, "boolean");
    assert.deepEqual(body.voiceStatus.keys, { foundry: false, openai: false });
    assert.deepEqual(body.peers.map((peer) => peer.sessionId), ["sess-a", "sess-b"]);
});

test("registry of live sessions", () => {
    const ids = listPeers().map((peer) => peer.sessionId).sort();
    assert.deepEqual(ids, ["sess-a", "sess-b"]);
});

test("side question to this session, streamed and with context", async () => {
    const { status, body } = await call(a, "/api/ask", { method: "POST", body: { target: "sess-a", question: "¿Cómo vas?", via: "voice" } });
    assert.equal(status, 200);
    const chunks = body.filter((item) => item.type === "chunk").map((item) => item.text).join("");
    assert.equal(chunks, "All good in Coordinator.");
    assert.deepEqual(body.at(-1), { type: "done", answer: "All good in Coordinator." });
    const framed = a.session.questions.at(-1);
    assert.match(framed, /side question/);
    assert.match(framed, /Reply in Spanish/);
    assert.match(framed, /working for/);
    assert.match(framed, /tasks: 1 of 2 done/);
    assert.match(framed, /other open sessions/);
    assert.match(framed, /- Payments API: working for/);
    assert.match(framed, /User's question: "¿Cómo vas\?"/);
});

test("side question to another session through its peer API", async () => {
    const { body } = await call(a, "/api/ask", { method: "POST", body: { target: "sess-b", question: "How is it going?" } });
    assert.deepEqual(body.at(-1), { type: "done", answer: "All good in Payments API." });
    assert.match(b.session.questions.at(-1), /Reply in English/);
    const second = await call(a, "/api/ask", { method: "POST", body: { target: "sess-b", question: "¿Y ahora?" } });
    assert.equal(second.body.at(-1).type, "done");
    assert.match(b.session.questions.at(-1), /How is it going\?/, "includes the earlier Octovox conversation");
    assert.match(b.session.questions.at(-1), /Reply in Spanish/);
    await call(a, "/api/ask", { method: "POST", body: { target: "sess-b", question: "ok", lang: "it" } });
    assert.match(b.session.questions.at(-1), /Reply in Italian/, "the speech-to-text language wins for short questions");
});

test("dictated prompt: sent with a dictation note, shown clean", async () => {
    const { status, body } = await call(a, "/api/send", { method: "POST", body: { target: "sess-b", text: "Lanza los tests de la API", dictated: true } });
    assert.equal(status, 200);
    assert.equal(body.mode, "enqueue");
    const sent = b.session.sent.at(-1);
    assert.equal(sent.displayPrompt, "Lanza los tests de la API");
    assert.match(sent.prompt, /Dictated by voice with Octovox/);
    assert.equal(sent.mode, "enqueue");
    await call(a, "/api/send", { method: "POST", body: { target: "sess-b", text: "Para", mode: "immediate" } });
    assert.equal(b.session.sent.at(-1).mode, "immediate");
    assert.equal(b.session.sent.at(-1).prompt, "Para");
});

test("answering another session's pending question by voice", async () => {
    b.session.emit({
        type: "user_input.requested",
        data: { requestId: "in-1", question: "¿Qué base de datos uso?", choices: ["PostgreSQL (Recommended)", "MySQL"], allowFreeform: true },
    });
    const status = await call(b, "/peer/status", { headers: { "X-Octovox-Peer": b.peerToken } });
    assert.equal(status.body.pending.input.requestId, "in-1");
    const { body } = await call(a, "/api/answer", { method: "POST", body: { target: "sess-b", requestId: "in-1", text: "la segunda", via: "voice" } });
    assert.deepEqual(body, { answer: "MySQL", wasFreeform: false });
    assert.deepEqual(b.session.answers.at(-1), { requestId: "in-1", response: { answer: "MySQL", wasFreeform: false } });
    const after = await call(b, "/peer/status", { headers: { "X-Octovox-Peer": b.peerToken } });
    assert.equal(after.body.pending.input, null);
    const stale = await call(a, "/api/answer", { method: "POST", body: { target: "sess-b", requestId: "in-1", text: "MySQL" } });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /no longer pending/);
});

test("per-session history with questions, prompts and answers", async () => {
    const { body } = await call(a, "/api/history?target=sess-b&limit=20");
    const kinds = body.items.map((item) => item.kind);
    assert.deepEqual(kinds, ["ask", "ask", "ask", "prompt", "prompt", "answer"]);
    assert.equal(body.items[0].a, "All good in Payments API.");
});

test("check-in: asks every busy session", async () => {
    const { body } = await call(a, "/api/check-in", { method: "POST", body: {} });
    const peers = body.filter((item) => item.type === "peer");
    assert.equal(body[0].type, "start");
    assert.deepEqual(body[0].sessions.map((session) => session.name).sort(), ["Coordinator", "Payments API"]);
    assert.deepEqual(peers.map((item) => item.name).sort(), ["Coordinator", "Payments API"]);
    assert.ok(peers.every((item) => item.answer));
    assert.equal(body.at(-1).type, "done");
    a.session.processing = false;
    b.session.processing = false;
    const idle = await call(a, "/api/check-in", { method: "POST", body: {} });
    assert.deepEqual(idle.body[0], { type: "empty" });
    assert.equal((await call(a, "/api/ronda", { method: "POST", body: {} })).status, 404);
});

test("the SSE channel sends the initial state and the session list", async () => {
    const events = await new Promise((resolve, reject) => {
        const seen = [];
        const req = request(
            { host: "127.0.0.1", port: a.http.port, path: `/api/events?t=${a.uiToken}` },
            (res) => {
                res.setEncoding("utf8");
                let buffer = "";
                res.on("data", (chunk) => {
                    buffer += chunk;
                    for (const match of buffer.matchAll(/^data: (.+)$/gm)) seen.push(JSON.parse(match[1]));
                    buffer = "";
                    if (seen.some((event) => event.type === "peers")) {
                        req.destroy();
                        resolve(seen);
                    }
                });
            },
        );
        req.on("error", (error) => (error.code === "ECONNRESET" ? resolve(seen) : reject(error)));
        req.end();
    });
    const types = events.map((event) => event.type);
    assert.ok(types.includes("settings"));
    assert.ok(types.includes("rec"));
    const peers = events.find((event) => event.type === "peers").peers;
    assert.equal(peers[0].sessionId, "sess-a");
    assert.equal(peers[0].self, true);
    assert.equal(peers[1].name, "Payments API");
});

test("live state: running tool, and a structured alert when another session asks", async () => {
    b.session.processing = true;
    b.session.emit({ type: "tool.execution_start", data: { toolCallId: "t1", toolName: "bash", arguments: { description: "Run tests" } } });
    const status = await call(b, "/peer/status", { headers: { "X-Octovox-Peer": b.peerToken } });
    assert.equal(status.body.activityTool, "bash");
    assert.equal(status.body.activity, "bash · Run tests");
    const announce = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no alert")), 8000);
        let asked = false;
        const req = request({ host: "127.0.0.1", port: a.http.port, path: `/api/events?t=${a.uiToken}` }, (res) => {
            res.setEncoding("utf8");
            let buffer = "";
            res.on("data", (chunk) => {
                buffer += chunk;
                const lines = buffer.split("\n\n");
                buffer = lines.pop();
                for (const line of lines) {
                    const match = line.match(/^data: (.+)$/m);
                    if (!match) continue;
                    const event = JSON.parse(match[1]);
                    if (event.type === "peers" && !asked) {
                        asked = true;
                        b.session.emit({ type: "user_input.requested", data: { requestId: "in-2", question: "¿Despliego ya?", choices: ["Sí", "No"] } });
                    }
                    if (event.type === "announce") {
                        clearTimeout(timer);
                        req.destroy();
                        resolve(event);
                    }
                }
            });
        });
        req.on("error", (error) => (error.code === "ECONNRESET" ? null : reject(error)));
        req.end();
    });
    assert.equal(announce.kind, "input");
    assert.equal(announce.name, "Payments API");
    assert.equal(announce.question, "¿Despliego ya?");
    assert.equal(announce.sessionId, "sess-b");
    assert.equal(announce.text, undefined, "the panel words alerts itself");
    b.session.emit({ type: "user_input.completed", data: { requestId: "in-2" } });
    b.session.emit({ type: "tool.execution_complete", data: { toolCallId: "t1", success: true } });
});

test("voice: keys go to the Keychain per endpoint, never to settings", async () => {
    assert.equal((await call(a, "/api/tts/key", { method: "POST", body: { provider: "evil", key: "x" } })).status, 400);
    const early = await call(a, "/api/tts/key", { method: "POST", body: { provider: "foundry", key: "k-123" } });
    assert.equal(early.status, 400);
    assert.match(early.body.error, /Set the endpoint first/);
    const endpoint = `http://127.0.0.1:${speechServer.address().port}`;
    const saved = await call(a, "/api/settings", { method: "POST", body: { tts: { provider: "foundry", foundry: { endpoint, auth: "key", model: "MAI-Voice-2.1" } } } });
    assert.equal(saved.body.settings.tts.foundry.endpoint, endpoint);
    assert.deepEqual((await call(a, "/api/tts/status")).body.keys, { foundry: false, openai: false });
    const stored = await call(a, "/api/tts/key", { method: "POST", body: { provider: "foundry", key: " k-123 " } });
    assert.deepEqual(stored.body.keys, { foundry: true, openai: false });
    assert.equal(keychain.get(`foundry@127.0.0.1:${speechServer.address().port}`), "k-123");
    assert.doesNotMatch(JSON.stringify((await call(a, "/api/state")).body.settings), /k-123/);
    assert.equal((await call(a, "/api/tts/key", { method: "POST", body: { provider: "foundry", key: "bad\nkey" } })).status, 400);
});

test("voice: opening the panel warms the cloud voice up, without playing it", async () => {
    speech.requests.length = 0;
    played.length = 0;
    const open = () =>
        new Promise((resolve, reject) => {
            const req = request({ host: "127.0.0.1", port: a.http.port, path: `/api/events?t=${a.uiToken}` }, (res) => {
                res.once("data", () => setTimeout(() => req.destroy(), 20));
            });
            req.on("close", resolve);
            req.on("error", (error) => (error.code === "ECONNRESET" ? resolve() : reject(error)));
            req.end();
        });
    await open();
    const deadline = Date.now() + 5000;
    while (!speech.requests.some((item) => item.method === "POST") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const posts = speech.requests.filter((item) => item.method === "POST");
    assert.equal(posts.length, 1);
    assert.match(posts[0].body, />OK\.<\/voice>/);
    await open();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(speech.requests.filter((item) => item.method === "POST").length, 1, "no second warm-up right after the first");
    assert.deepEqual(played, []);
});

test("voice: lists the endpoint's voices for the chosen model, per language", async () => {
    const { body } = await call(a, "/api/tts/voices?refresh=1");
    assert.equal(body.model, "MAI-Voice-2.1");
    assert.deepEqual(body.languages.es.voices.map((voice) => voice.id), ["es-ES-Marta", "es-MX-Valeria"]);
    assert.equal(body.languages.es.selected, "es-ES-Marta");
    assert.deepEqual(body.languages.en.voices, [{ id: "en-US-Harper", name: "Harper", locale: "en-US", gender: "female" }]);
    assert.deepEqual(body.languages.pl.voices, []);
    await call(a, "/api/settings", { method: "POST", body: { tts: { foundry: { voices: { es: "es-MX-Valeria" } } } } });
    assert.equal((await call(a, "/api/tts/voices")).body.languages.es.selected, "es-MX-Valeria");
});

test("voice: the test plays a sample and reports the voice and timing", async () => {
    speech.requests.length = 0;
    played.length = 0;
    const { body } = await call(a, "/api/tts/test", { method: "POST", body: { lang: "es" } });
    assert.equal(body.ok, true, body.error);
    assert.equal(body.provider, "foundry");
    assert.equal(body.voice, "es-MX-Valeria:MAI-Voice-2.1");
    assert.equal(body.lang, "es");
    assert.ok(Number.isFinite(body.ms));
    const synth = speech.requests.find((item) => item.method === "POST");
    assert.equal(synth.key, "k-123");
    assert.match(synth.body, /xml:lang="es-MX"/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(played, ["mp3:12"]);
});

test("voice: answers are spoken while they stream, in the reply language", async () => {
    await call(a, "/api/settings", { method: "POST", body: { speak: true } });
    speech.requests.length = 0;
    played.length = 0;
    await call(a, "/api/ask", { method: "POST", body: { target: "sess-a", question: "Come va il lavoro?", lang: "it" } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const ssml = speech.requests.filter((item) => item.method === "POST").map((item) => item.body);
    assert.ok(ssml.length >= 1);
    assert.ok(ssml.every((item) => item.includes('<voice name="it-IT-Rosa:MAI-Voice-2.1">')), ssml.join("\n"));
    assert.match(ssml.join(" "), /All good in Coordinator\./);
    assert.ok(played.length >= 1);
    await call(a, "/api/settings", { method: "POST", body: { speak: false } });
});

test("voice: a failing cloud voice falls back to macOS and tells the panel", async () => {
    await call(a, "/api/tts/key", { method: "POST", body: { provider: "foundry", key: "wrong" } });
    played.length = 0;
    const notice = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no notice")), 8000);
        const req = request({ host: "127.0.0.1", port: a.http.port, path: `/api/events?t=${a.uiToken}` }, (res) => {
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
                for (const match of chunk.matchAll(/^data: (.+)$/gm)) {
                    const event = JSON.parse(match[1]);
                    if (event.type === "notice") {
                        clearTimeout(timer);
                        req.destroy();
                        resolve(event);
                    }
                }
            });
        });
        req.on("error", (error) => (error.code === "ECONNRESET" ? null : reject(error)));
        req.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await call(a, "/api/tts/speak", { method: "POST", body: { text: "Hello there, this is a fallback check.", lang: "en" } });
    const event = await notice;
    assert.equal(event.tone, "warn");
    assert.match(event.text, /Access denied \(HTTP 401\)\. Check the API key\. Using the macOS voice instead\./);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(played, ["say[en] Hello there, this is a fallback check."]);
    const removed = await call(a, "/api/tts/key", { method: "POST", body: { provider: "foundry", key: "" } });
    assert.deepEqual(removed.body.keys, { foundry: false, openai: false });
    await call(a, "/api/settings", { method: "POST", body: { tts: { provider: "system" } } });
});

test("a closed session leaves the registry", () => {
    removePeer("sess-b");
    assert.deepEqual(
        listPeers().map((peer) => peer.sessionId),
        ["sess-a"],
    );
});
