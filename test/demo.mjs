// Visual demo of Octovox with simulated sessions: `node test/demo.mjs [github-login]` prints the panel URL.
// It never touches real sessions: it uses a temporary COPILOT_HOME, with no voice or sounds.
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "octovox-demo-"));
process.env.COPILOT_HOME = home;

const { ensureDirs, saveInterviewConfig, saveSettings } = await import("../lib/config.mjs");
const { Hub } = await import("../lib/hub.mjs");
const { Interview } = await import("../lib/interview.mjs");
const { LocalSession } = await import("../lib/local.mjs");
const { writePeer } = await import("../lib/peers.mjs");
const { startHttpServer } = await import("../lib/server.mjs");
const { SessionTracker } = await import("../lib/tracker.mjs");
const { fakeLive } = await import("./fake-live.mjs");

ensureDirs();
saveSettings({ speak: false, announce: false, sounds: false });
saveInterviewConfig({ endpoint: "https://demo.openai.azure.com", deployment: "gpt-live-1", voice: "marin" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const login = process.argv[2] || null;

class DemoSession {
    constructor(sessionId, name, { answer, interviewAnswer, todos = [], processing = false }) {
        this.sessionId = sessionId;
        this.workspacePath = join(home, "sessions", sessionId);
        mkdirSync(this.workspacePath, { recursive: true });
        this.handlers = new Set();
        this.processing = processing;
        this.rpc = {
            name: { get: async () => ({ name }) },
            metadata: { isProcessing: async () => ({ processing: this.processing }) },
            plan: { readSqlTodos: async () => ({ rows: todos }) },
            gitHubAuth: { getStatus: async () => ({ isAuthenticated: !!login, login, host: "https://github.com" }) },
            ui: {
                ephemeralQuery: async ({ question }) => {
                    const reply = interviewAnswer && String(question).includes("[Octovox Interview]") ? interviewAnswer : answer;
                    const requestId = `rq-${Math.random().toString(16).slice(2)}`;
                    this.emit({ type: "ui.ephemeral_query", data: { phase: "started", requestId } });
                    for (const chunk of reply.match(/\S+\s*/g)) {
                        await sleep(45);
                        this.emit({ type: "ui.ephemeral_query", data: { phase: "chunk", requestId, chunk } });
                    }
                    return { answer: reply };
                },
                handlePendingUserInput: async ({ requestId }) => {
                    this.emit({ type: "user_input.completed", data: { requestId } });
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

    async send() {
        return "msg-demo";
    }
}

async function boot(sessionId, name, options, withHub = false) {
    const session = new DemoSession(sessionId, name, options);
    const tracker = new SessionTracker(session);
    await tracker.init();
    const local = new LocalSession(session, tracker);
    local.login = login;
    const hub = withHub ? new Hub({ local }) : null;
    if (hub) hub.warmup = () => {};
    const uiToken = `demo-${sessionId}`;
    const peerToken = `peer-${sessionId}`;
    const http = await startHttpServer({ uiToken, peerToken, getHub: () => hub, getLocal: () => local });
    writePeer({ sessionId, pid: process.pid, port: http.port, token: peerToken, name, cwd: home, startedAt: new Date().toISOString() });
    return { session, tracker, local, hub, http, uiToken };
}

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const self = await boot(
    "demo-coordinator",
    "Coordinator",
    { answer: "All good. Payments API is still running the integration tests, Azure infra is waiting for you to pick a region, and Docs has finished the deployment guide." },
    true,
);
const api = await boot("demo-api", "Payments API", {
    processing: true,
    answer: "I'm on the integration tests: 18 of 24 green and no failures so far. When they finish I'll fix whatever comes up and open the pull request.",
    interviewAnswer:
        "Two refund webhook tests failed because they still expected the old event name, payment.refunded. I renamed it to refund.completed in the handler and in the tests. The public API didn't change: only that internal event name did. After the fix, 18 of 24 tests were green with no failures.",
    todos: [
        { id: "read", title: "Read the API code", status: "done" },
        { id: "tests", title: "Run the integration tests", status: "in_progress" },
        { id: "fix", title: "Fix the failures", status: "pending" },
        { id: "pr", title: "Open the pull request", status: "pending" },
    ],
});
const infra = await boot("demo-infra", "Azure infra", {
    processing: true,
    answer: "The Bicep for the test environment is ready, but I need you to pick the region before I deploy.",
});
const docs = await boot("demo-docs", "Docs", { answer: "I finished the deployment guide and saved it in docs/deploy.md." });

api.session.emit({ type: "user.message", data: { content: "Run the tests" } });
api.session.emit({ type: "tool.execution_start", data: { toolCallId: "t1", toolName: "bash", arguments: { description: "Running the integration tests" } } });
infra.session.emit({ type: "user.message", data: { content: "Set up the environment" } });
infra.session.emit({
    type: "user_input.requested",
    data: { requestId: "demo-q1", question: "Which Azure region should I deploy the test environment to?", choices: ["West Europe", "Spain Central", "East US 2"], allowFreeform: true },
});
docs.session.emit({ type: "user.message", data: { content: "Write the guide" } });
docs.session.emit({ type: "assistant.message", data: { content: "I finished the deployment guide and saved it in docs/deploy.md." } });
docs.session.emit({ type: "session.idle", data: {} });

const history = [
    { at: minutesAgo(14), kind: "ask", q: "¿Cómo van mis sesiones?", a: "Payments API acaba de empezar los tests de integración y Docs está escribiendo la guía de despliegue. Nadie te necesita por ahora.", lang: "es", via: "voice", ms: 4200 },
    { at: minutesAgo(9), kind: "prompt", q: "When you finish the review, write up a summary of the changes for the PR.", lang: "en", via: "voice", mode: "enqueue" },
    { at: minutesAgo(6), kind: "answer", q: "Should I use PostgreSQL or SQLite for the tests?", a: "SQLite", via: "voice" },
];
mkdirSync(join(self.session.workspacePath, "octovox"), { recursive: true });
writeFileSync(join(self.session.workspacePath, "octovox", "history.jsonl"), `${history.map((item) => JSON.stringify(item)).join("\n")}\n`);

// Interview: a fake GPT-Live plays a short scripted conversation once the interview is live.
const apiLog = join(home, "session-state", "demo-api", "events.jsonl");
const logLine = (type, data, minutes) => `${JSON.stringify({ type, data, id: `d${Math.random()}`, timestamp: minutesAgo(minutes), parentId: null })}\n`;
mkdirSync(join(home, "session-state", "demo-api"), { recursive: true });
writeFileSync(
    apiLog,
    logLine("user.message", { content: "Run the integration tests and fix whatever fails, then open the pull request." }, 40) +
        logLine("assistant.message", { content: "Two tests failed: the refund webhook expected the old event name. I renamed it and re-ran them." }, 22) +
        logLine("assistant.message", { content: "", toolRequests: [{ toolCallId: "t9", name: "bash", arguments: {}, intentionSummary: "Running the integration tests" }] }, 3),
);
const fake = fakeLive({
    speech: (content) => {
        if (content.startsWith("Hi!")) return "Hi! I'm following Payments API with you. It's running the integration tests, and nothing needs you yet. What would you like to know?";
        if (content.startsWith("Heads-up:")) return "Quick heads-up: Docs just finished. The deployment guide is ready in the docs folder.";
        return content;
    },
});
self.hub.interview = new Interview({ hub: self.hub, ...fake });
let scripted = false;
setInterval(async () => {
    const interview = self.hub.interview;
    if (interview.state !== "live" || scripted) {
        if (interview.state === "idle") scripted = false;
        return;
    }
    scripted = true;
    await sleep(7500);
    await fake.socket?.userSays("Why did the integration tests fail earlier, and did it change anything in the API?");
    fake.socket?.say("Let me check that with the session.");
    fake.socket?.delegate();
    await sleep(9000);
    appendFileSync(apiLog, logLine("assistant.message", { content: "Integration tests finished: 24 of 24 passing. Opening the pull request now." }, 0));
    await sleep(5000);
    interview.alert('"Docs" finished. Its last message: the deployment guide is in docs/deploy.md.');
}, 500);

console.log(`http://127.0.0.1:${self.http.port}/ui/?t=${self.uiToken}`);
