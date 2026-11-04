import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Settings, session logs and the interview lock go to a temporary COPILOT_HOME before any module loads.
const home = mkdtempSync(join(tmpdir(), "octovox-interview-"));
process.env.COPILOT_HOME = home;

const { ensureDirs, RUN_DIR, saveInterviewConfig, saveSettings } = await import("../lib/config.mjs");
const { buildBriefing, LogFollower, readSessionLog, timeline } = await import("../lib/briefing.mjs");
const { CommentaryStream, Interview, joinDelta, liveSocketUrl } = await import("../lib/interview.mjs");
const { frameQuestion } = await import("../lib/text.mjs");
const { connectWebSocket, encodeFrame, FrameParser, OP } = await import("../lib/ws.mjs");
const { fakeLive } = await import("./fake-live.mjs");

ensureDirs();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 4000) {
    const until = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > until) throw new Error("timed out");
        await sleep(20);
    }
}

let n = 0;
const line = (type, data, at = Date.now()) => `${JSON.stringify({ type, data, id: `e${++n}`, timestamp: new Date(at).toISOString(), parentId: null })}\n`;
function sessionLog(sessionId, text) {
    mkdirSync(join(home, "session-state", sessionId), { recursive: true });
    const file = join(home, "session-state", sessionId, "events.jsonl");
    writeFileSync(file, text);
    return file;
}

test("liveSocketUrl points any form of the resource endpoint at GPT-Live", () => {
    const live = "wss://contoso.openai.azure.com/openai/v1/live/sessions";
    assert.equal(liveSocketUrl("https://contoso.openai.azure.com"), live);
    assert.equal(liveSocketUrl("https://Contoso.cognitiveservices.azure.com/"), live);
    assert.equal(liveSocketUrl("https://contoso.services.ai.azure.com/api/projects/demo"), live);
    assert.equal(liveSocketUrl("https://gateway.example.com/whatever"), "wss://gateway.example.com/openai/v1/live/sessions");
});

test("CommentaryStream sends whole sentences: a short first piece, then bigger ones", () => {
    const sent = [];
    const stream = new CommentaryStream((text) => sent.push(text), { first: 20, rest: 60, max: 120 });
    stream.push("Short one. ");
    assert.deepEqual(sent, [], "waits for enough text");
    stream.push("Now the first piece is long. And this sentence");
    assert.deepEqual(sent, ["Short one. Now the first piece is long."]);
    stream.push(" keeps going until it ends. Plus a second one, which is long enough to send now. Tail");
    assert.equal(sent.length, 2);
    assert.ok(sent[1].endsWith("send now."));
    stream.push(` ${"word ".repeat(40)}`);
    assert.ok(sent.every((piece) => piece.length <= 120), "never above the maximum");
    stream.end();
    assert.equal(sent.join(" ").replace(/\s+/g, " "), `Short one. Now the first piece is long. And this sentence keeps going until it ends. Plus a second one, which is long enough to send now. Tail ${"word ".repeat(40)}`.replace(/\s+/g, " ").trim());
});

test("joinDelta keeps a space between sentences without splitting words", () => {
    assert.equal(joinDelta("Let me check.", "Two tests failed"), "Let me check. Two tests failed");
    assert.equal(joinDelta("It's in docs/deploy.", "md"), "It's in docs/deploy.md");
    assert.equal(joinDelta("Sí", " claro"), "Sí claro");
    assert.equal(joinDelta("", "Hola"), "Hola");
});

test("frameQuestion frames Interview lookups around the voice conversation", () => {
    const prompt = frameQuestion({ question: "User: ¿Qué reintentos pusiste?\nVoice assistant: Déjame revisar.", lang: "es", status: "working for 3 min", detail: true });
    assert.match(prompt, /^\[Octovox Interview\]/);
    assert.match(prompt, /Reply in Spanish/);
    assert.match(prompt, /up to 8 short sentences/);
    assert.match(prompt, /User: ¿Qué reintentos pusiste\?/);
    assert.match(prompt, /Status observed by Octovox: working for 3 min/);
    assert.doesNotMatch(prompt, /User's question:/);
});

test("WebSocket frames round-trip at every length size, masked or not, in any chunking", () => {
    for (const size of [0, 5, 125, 126, 300, 65_535, 65_536, 70_000]) {
        for (const mask of [true, false]) {
            const payload = Buffer.from(Array.from({ length: size }, (_, i) => i % 251));
            const frame = encodeFrame(OP.TEXT, payload, { mask });
            const parser = new FrameParser();
            const frames = [];
            for (let i = 0; i < frame.length; i += 4093) frames.push(...parser.push(frame.subarray(i, i + 4093)));
            assert.equal(frames.length, 1, `size ${size}`);
            assert.equal(frames[0].opcode, OP.TEXT);
            assert.ok(frames[0].payload.equals(payload), `size ${size} mask ${mask}`);
        }
    }
});

test("connectWebSocket talks to a server and reports refusals with their HTTP status", async (t) => {
    const server = createServer((req, res) => {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Principal does not have access" } }));
    });
    server.on("upgrade", (req, socket) => {
        const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        const parser = new FrameParser();
        socket.on("data", (chunk) => {
            for (const frame of parser.push(chunk)) {
                if (frame.opcode === OP.TEXT) socket.write(encodeFrame(OP.TEXT, Buffer.from(`echo:${frame.payload}`), { mask: false }));
                if (frame.opcode === OP.CLOSE) socket.end(encodeFrame(OP.CLOSE, frame.payload, { mask: false }));
            }
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const { port } = server.address();
    const ws = await connectWebSocket(`ws://127.0.0.1:${port}/openai/v1/live/sessions`, { headers: { Authorization: "Bearer x" } });
    const reply = new Promise((resolve) => ws.once("message", resolve));
    ws.send(JSON.stringify({ type: "session.start" }));
    assert.equal(await reply, 'echo:{"type":"session.start"}');
    const closed = new Promise((resolve) => ws.once("close", resolve));
    ws.close();
    assert.equal((await closed).code, 1000);

    // A plain HTTP answer (no upgrade) is a refusal: its status and message come through.
    const refused = createServer((req, res) => {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Principal does not have access" } }));
    });
    await new Promise((resolve) => refused.listen(0, "127.0.0.1", resolve));
    t.after(() => refused.close());
    await assert.rejects(connectWebSocket(`ws://127.0.0.1:${refused.address().port}/x`), (error) => error.status === 403 && /does not have access/.test(error.message));
});

test("the briefing covers what the user asked and the latest work, and the follower sees new events", async (t) => {
    const t0 = Date.now() - 3600_000;
    const file = sessionLog(
        "brief-1",
        line("user.message", { content: "Migrate the payment webhooks to the queue." }, t0) +
            line("hook.start", { big: "x".repeat(5000) }, t0 + 1000) +
            line("assistant.message", { content: "", toolRequests: [{ toolCallId: "a", name: "view", arguments: { path: "/Users/dev/acme/src/queue/consumer.ts" } }] }, t0 + 2000) +
            line("tool.execution_complete", { toolCallId: "a", success: false, error: { message: "File not found" } }, t0 + 3000) +
            line("assistant.message", { content: "I'm using **idempotency keys** in Redis, because the database write happens after the provider call." }, t0 + 4000),
    );
    const log = await readSessionLog("brief-1");
    const briefing = buildBriefing({ name: "Checkout", statusLine: "working for 1 h", kind: "project", cwd: "/Users/dev/acme", log, others: ["Docs: idle"] });
    assert.match(briefing, /Migrate the payment webhooks/);
    assert.match(briefing, /idempotency keys in Redis/);
    assert.doesNotMatch(briefing, /\*\*/, "markdown is cleaned for speech");
    assert.match(briefing, /failed: File not found/);
    assert.match(briefing, /consumer\.ts/);
    assert.doesNotMatch(briefing, /\/Users\/dev\/acme\/src/, "long paths are shortened");
    assert.match(briefing, /Docs: idle/);

    const seen = [];
    const follower = new LogFollower("brief-1", { from: log.size, intervalMs: 50, onItems: (items) => seen.push(...items) }).start();
    t.after(() => follower.stop());
    appendFileSync(file, line("assistant.message", { content: "All 214 tests pass." }));
    await waitFor(() => seen.length > 0);
    follower.stop();
    assert.equal(seen[0].kind, "said");
    assert.match(seen[0].text, /214 tests/);

    // A helper agent's description is only in its start event: its end still says what it was.
    const agents = timeline([
        JSON.parse(line("subagent.started", { toolCallId: "c1", agentDisplayName: "load-tester", agentDescription: "Replay 5,000 webhook events" })),
        JSON.parse(line("subagent.completed", { toolCallId: "c1", agentDisplayName: "load-tester", durationMs: 125_000 })),
        JSON.parse(line("subagent.failed", { toolCallId: "c2", agentName: "docs-agent", error: "Timed out" })),
    ]);
    assert.deepEqual(
        agents.map(({ kind, text }) => [kind, text]),
        [
            ["agent", "Started a helper agent: load-tester (Replay 5,000 webhook events)"],
            ["agent-done", "Helper agent load-tester (Replay 5,000 webhook events) finished after 2 min"],
            ["agent-failed", "Helper agent docs-agent failed: Timed out"],
        ],
    );
});

function fakeHub(overrides = {}) {
    const hub = {
        local: { sessionId: "panel" },
        clients: new Set(["panel"]),
        events: [],
        asks: [],
        recorded: [],
        freshPeers: async () => [{ sessionId: "s-1", name: "Checkout", processing: true, busyForMs: 60_000, activity: "Running tests", pending: {}, online: true, self: false }],
        broadcast: (event) => hub.events.push(event),
        quietForInterview: () => {},
        recordInterview: async (summary) => hub.recorded.push(summary),
        ask: async ({ question, display, detail, lang, onChunk }) => {
            hub.asks.push({ question, display, detail, lang });
            const answer = "Five retries, starting at two seconds, with jitter. Then the message goes to a dead-letter queue.";
            onChunk(answer);
            return { answer };
        },
        ...overrides,
    };
    return hub;
}

test("an interview doesn't start without an endpoint, or while everything is muted", async () => {
    saveInterviewConfig({ endpoint: "" });
    await assert.rejects(new Interview({ hub: fakeHub(), ...fakeLive() }).start({ target: "s-1" }), (error) => error.status === 400);
    saveInterviewConfig({ endpoint: "https://demo.openai.azure.com" });
    saveSettings({ muted: true });
    try {
        await assert.rejects(new Interview({ hub: fakeHub(), ...fakeLive() }).start({ target: "s-1" }), (error) => error.status === 409);
    } finally {
        saveSettings({ muted: false });
    }
    await assert.rejects(new Interview({ hub: fakeHub(), ...fakeLive() }).start({ target: "gone" }), (error) => error.status === 410);
});

test("ending an interview while it's still connecting leaves nothing behind", async (t) => {
    saveInterviewConfig({ endpoint: "https://demo.openai.azure.com", deployment: "gpt-live-1" });
    const hub = fakeHub();
    const fake = fakeLive({ wordMs: 5 });
    let release;
    const slowToken = new Promise((resolve) => {
        release = resolve;
    });
    const interview = new Interview({ hub, ...fake, getToken: () => slowToken });
    t.after(() => interview.destroy());
    const starting = interview.start({ target: "s-1" });
    await waitFor(() => interview.state === "preparing");
    await interview.stop();
    release("token");
    const result = await starting;
    assert.equal(result.state, "idle");
    assert.equal(interview.state, "idle");
    assert.equal(fake.socket, null, "never connected");
    assert.ok(!existsSync(join(RUN_DIR, "interview.lock")));
    assert.equal(hub.recorded.length, 0);
});

test("a lookup still running when an interview ends never reaches the next interview", async (t) => {
    saveInterviewConfig({ endpoint: "https://demo.openai.azure.com", deployment: "gpt-live-1" });
    sessionLog("s-1", line("user.message", { content: "Make the webhooks idempotent." }));
    let answerNow;
    const slowAnswer = new Promise((resolve) => {
        answerNow = resolve;
    });
    const hub = fakeHub({
        ask: async ({ onChunk }) => {
            const answer = await slowAnswer;
            onChunk(answer);
            return { answer };
        },
    });
    const fake = fakeLive({ wordMs: 5 });
    const interview = new Interview({ hub, ...fake });
    t.after(() => {
        answerNow("");
        interview.destroy();
    });
    await interview.start({ target: "s-1" });
    await fake.socket.userSays("Why Redis?");
    fake.socket.delegate();
    await waitFor(() => hub.events.some((event) => event.kind === "lookup" && event.state === "asking"));
    await interview.stop();

    await interview.start({ target: "s-1" });
    const second = fake.socket;
    const lookupsBefore = hub.events.filter((event) => event.kind === "lookup").length;
    answerNow("Because the database write happens after the provider call, so a unique constraint would come too late.");
    await sleep(200);
    assert.ok(!second.sent.some((event) => event.type === "session.commentary.append" && event.delegation_id !== null), "the old answer isn't sent to the new session");
    assert.equal(hub.events.filter((event) => event.kind === "lookup").length, lookupsBefore, "nor shown in the new interview");
    assert.equal(interview.lookups.size, 0);
    await interview.stop();
});

test("if GPT-Live hangs up while the audio is starting, the start fails with the reason", async (t) => {
    saveInterviewConfig({ endpoint: "https://demo.openai.azure.com", deployment: "gpt-live-1" });
    const hub = fakeHub();
    const fake = fakeLive({ wordMs: 5 });
    const openAudio = fake.openAudio;
    const interview = new Interview({
        hub,
        ...fake,
        openAudio: async () => {
            fake.socket.push({ type: "session.closed", reason: "content", usage: { seconds: 1 } });
            await sleep(50);
            fake.socket.close();
            return openAudio();
        },
    });
    t.after(() => interview.destroy());
    await assert.rejects(interview.start({ target: "s-1" }), (error) => error.status === 502 && /content filter/.test(error.message));
    assert.equal(interview.state, "idle");
    assert.ok(!hub.events.some((event) => event.kind === "state" && event.state === "live"), "never went live");
    assert.ok(!existsSync(join(RUN_DIR, "interview.lock")));
});

test("a finished helper agent is news: GPT-Live hears it right away, with what comes next", async (t) => {
    saveInterviewConfig({ endpoint: "https://demo.openai.azure.com", deployment: "gpt-live-1", voice: "marin" });
    const at = Date.now() - 12 * 60_000;
    const file = sessionLog(
        "s-1",
        line("user.message", { content: "Make the webhooks idempotent." }, at) +
            line("subagent.started", { toolCallId: "call-7", agentName: "general-purpose", agentDisplayName: "load-tester", agentDescription: "Replay 5,000 webhook events" }, at + 1000),
    );
    let todos = { done: 5, total: 7, current: "Load test the queue consumer" };
    const hub = fakeHub({
        freshPeers: async () => [{ sessionId: "s-1", name: "Checkout", processing: true, busyForMs: 60_000, pending: {}, online: true, self: false, todos }],
    });
    const fake = fakeLive({ wordMs: 5 });
    const interview = new Interview({ hub, ...fake });
    t.after(() => interview.destroy());
    await interview.start({ target: "s-1", lang: "en" });

    todos = { done: 6, total: 7, current: "Write the rollout plan" };
    appendFileSync(file, line("subagent.completed", { toolCallId: "call-7", agentName: "general-purpose", agentDisplayName: "load-tester", durationMs: 12 * 60_000 }));
    const spoken = () => fake.socket.sent.find((event) => event.type === "session.commentary.append" && /^Update from/.test(event.content));
    await waitFor(spoken, 8000);
    const { content, delegation_id } = spoken();
    assert.equal(delegation_id, null);
    assert.match(content, /^Update from "Checkout": its helper agent "load-tester" \(Replay 5,000 webhook events\) just finished, after 12 min\./);
    assert.match(content, /moves on to the next step: "Write the rollout plan" \(6 of 7 tasks done\)/);
    assert.ok(!fake.socket.sent.some((event) => event.type === "session.thinking.append" && /load-tester/.test(event.content)), "not passed again as quiet context");
    const note = hub.events.find((event) => event.kind === "note");
    assert.deepEqual({ source: note.source, tone: note.tone, text: note.text }, { source: "agent", tone: "success", text: "Helper agent “load-tester” finished" });
    await interview.stop();
});

test("an interview greets, follows the session, checks details with it and ends with a summary", async (t) => {
    saveInterviewConfig({ endpoint: "https://demo.openai.azure.com", deployment: "gpt-live-1", voice: "marin" });
    const file = sessionLog("s-1", line("user.message", { content: "Make the webhooks idempotent." }) + line("assistant.message", { content: "Working on the queue consumer." }));
    const hub = fakeHub();
    const fake = fakeLive({ wordMs: 5 });
    const interview = new Interview({ hub, ...fake });
    t.after(() => interview.destroy());
    await interview.start({ target: "s-1", lang: "en" });
    assert.equal(interview.state, "live");
    const lock = join(RUN_DIR, "interview.lock");
    assert.ok(existsSync(lock), "other Octovox panels stay quiet");

    const start = fake.socket.sent.find((event) => event.type === "session.start");
    assert.equal(start.session.model, "gpt-live-1");
    assert.deepEqual(start.session.audio, { output: { voice: "marin" } });
    assert.deepEqual(start.session.delegation, { type: "client" });
    assert.match(start.session.instructions, /"Checkout"/);
    assert.match(start.session.instructions, /BRIEFING[\s\S]*Make the webhooks idempotent/);
    assert.ok(fake.socket.sent.some((event) => event.type === "session.commentary.append" && event.delegation_id === null && /Checkout/.test(event.content)), "greets");

    // The user asks for details: GPT-Live delegates, Octovox asks the session and streams the answer back.
    await fake.socket.userSays("What retry values did you configure?");
    const id = fake.socket.delegate();
    await waitFor(() => fake.socket.sent.some((event) => event.type === "session.commentary.append" && event.delegation_id === id));
    assert.equal(hub.asks.length, 1);
    assert.equal(hub.asks[0].detail, true);
    assert.equal(hub.asks[0].display, "What retry values did you configure?");
    assert.match(hub.asks[0].question, /User: What retry values did you configure\?/);
    const lookup = hub.events.filter((event) => event.kind === "lookup").at(-1);
    await waitFor(() => hub.events.some((event) => event.kind === "lookup" && event.state === "done"));
    assert.equal(lookup.id, id);

    // New events in the session's log reach GPT-Live as quiet context.
    appendFileSync(file, line("assistant.message", { content: "All 214 tests pass." }));
    await waitFor(() => fake.socket.sent.some((event) => event.type === "session.thinking.append" && /214 tests/.test(event.content)), 6000);

    // Microphone audio goes out in whole samples.
    fake.audio.emit("mic", Buffer.alloc(1001));
    fake.audio.emit("mic", Buffer.alloc(1000));
    const audio = fake.socket.sent.filter((event) => event.type === "session.input_audio.append");
    assert.equal(audio.length, 1);
    assert.equal(Buffer.from(audio[0].audio, "base64").length, 2000);

    // Alerts are said through the live voice.
    assert.equal(interview.alert('"Docs" finished.'), true);
    assert.ok(fake.socket.sent.some((event) => event.type === "session.commentary.append" && /Heads-up: "Docs" finished/.test(event.content)));

    interview.setMicMuted(true);
    assert.ok(fake.audio.muted);
    assert.ok(fake.socket.sent.some((event) => event.type === "session.input_audio.mute"));

    await interview.stop();
    assert.equal(interview.state, "idle");
    assert.ok(!existsSync(lock));
    assert.ok(fake.socket.sent.some((event) => event.type === "session.close"));
    assert.equal(hub.recorded.length, 1);
    const [summary] = hub.recorded;
    assert.equal(summary.target, "s-1");
    assert.equal(summary.lookups.length, 1);
    assert.equal(summary.lookups[0].state, "done");
    assert.ok(summary.turns.some((turn) => turn.role === "user" && /retry values/.test(turn.text)));
    assert.ok(hub.events.some((event) => event.kind === "ended" && event.wasLive));
});
