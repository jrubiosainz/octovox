import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { ensureDirs } from "./lib/config.mjs";
import { sessionLogin } from "./lib/github.mjs";
import { Hub, pruneMarks } from "./lib/hub.mjs";
import { LocalSession } from "./lib/local.mjs";
import { log, rotateLog } from "./lib/log.mjs";
import { removePeer, writePeer } from "./lib/peers.mjs";
import { startHttpServer } from "./lib/server.mjs";
import { firstSentences, sessionLabel } from "./lib/text.mjs";
import { SessionTracker } from "./lib/tracker.mjs";

ensureDirs();
rotateLog();
pruneMarks();
process.on("uncaughtException", (error) => log("error", "uncaughtException", error));
process.on("unhandledRejection", (error) => log("error", "unhandledRejection", error));

const uiToken = randomBytes(24).toString("hex");
const peerToken = randomBytes(24).toString("hex");
let local = null;
let hub = null;
let markReady;
const ready = new Promise((resolve) => {
    markReady = resolve;
});

const http = await startHttpServer({ uiToken, peerToken, getHub: () => hub, getLocal: () => local });

// Agents often send `null` when there's no input: accept it like `{}`.
const emptySchema = { type: ["object", "null"], properties: {}, additionalProperties: false };

function guard(code, handler) {
    return async (ctx) => {
        await ready;
        try {
            return await handler(ctx.input ?? {});
        } catch (error) {
            throw new CanvasError(code, error.message);
        }
    };
}

const canvas = createCanvas({
    id: "octovox",
    displayName: "Octovox · Talk to Copilot",
    description:
        "Octovox (formerly Walkie): walkie-talkie style push-to-talk voice panel (auto-detect, English, Spanish, Italian, German, French, Portuguese, Dutch, Polish). Ask any running Copilot session how it is going without interrupting it, dictate prompts, answer its pending questions and hear the replies with natural voices (MAI-Voice on Azure AI Foundry or any OpenAI-compatible endpoint).",
    inputSchema: {
        type: ["object", "null"],
        properties: {
            target: { type: "string", description: "Session ID to talk to. Defaults to this session." },
            mode: { type: "string", enum: ["ask", "prompt"], description: "ask = side question that never interrupts; prompt = dictate a message to the session." },
        },
        additionalProperties: false,
    },
    actions: [
        {
            name: "status",
            description: "Live status of every session that has Octovox loaded: busy or idle, current activity, task progress and pending questions for the user.",
            inputSchema: emptySchema,
            handler: guard("status_failed", async () => {
                const peers = await hub.collectPeers();
                return peers.map((peer) => ({
                    sessionId: peer.sessionId,
                    name: sessionLabel(peer),
                    self: peer.self,
                    online: peer.online,
                    kind: peer.kind,
                    processing: peer.processing,
                    busyForSeconds: Math.round((peer.busyForMs ?? 0) / 1000),
                    activity: peer.activity,
                    todos: peer.todos,
                    pendingQuestion: peer.pending?.input?.question ?? null,
                    pendingPlan: !!peer.pending?.plan,
                    pendingPermission: peer.pending?.permission?.text ?? null,
                    lastMessage: firstSentences(peer.lastMessage, 2, 300) || null,
                }));
            }),
        },
        {
            name: "ask_session",
            description: "Ask another running session a side question without interrupting it (ephemeral, no tools, not added to its history). Returns its answer.",
            inputSchema: {
                type: "object",
                properties: { sessionId: { type: "string" }, question: { type: "string", minLength: 1 } },
                required: ["sessionId", "question"],
                additionalProperties: false,
            },
            handler: guard("ask_failed", async ({ sessionId, question }) => {
                const { answer } = await hub.ask({ target: sessionId, question, via: "agent", speak: false });
                return { answer };
            }),
        },
        {
            name: "speak",
            description: "Read a short message aloud to the user with the configured voice (language auto-detected).",
            inputSchema: {
                type: "object",
                properties: { text: { type: "string", minLength: 1, maxLength: 2000 } },
                required: ["text"],
                additionalProperties: false,
            },
            handler: guard("speak_failed", async ({ text }) => {
                await hub.say(text);
                return { spoken: true };
            }),
        },
    ],
    open: async (ctx) => {
        await ready;
        const query = new URLSearchParams({ t: uiToken });
        if (typeof ctx.input?.target === "string" && ctx.input.target) query.set("target", ctx.input.target);
        if (ctx.input?.mode) query.set("mode", ctx.input.mode);
        hub.warmup();
        return { title: "Octovox", url: `http://127.0.0.1:${http.port}/ui/?${query}` };
    },
});

const session = await joinSession({ canvases: [canvas] });
const tracker = new SessionTracker(session);
local = new LocalSession(session, tracker);
hub = new Hub({ local });
sessionLogin(session).then((login) => {
    local.login = login;
});
// Don't block startup if an RPC is slow: events fill in the state anyway.
await Promise.race([
    tracker.init().catch((error) => log("warn", "tracker.init", error)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
]);

const startedAt = new Date().toISOString();
// The app creates hidden sessions to catalogue canvases: they aren't user sessions.
const internalSession = basename(process.cwd()) === "canvas-catalog-probe";
const register = () => {
    if (internalSession) return;
    try {
        writePeer({
            sessionId: session.sessionId,
            pid: process.pid,
            port: http.port,
            token: peerToken,
            name: tracker.state.name,
            cwd: process.cwd(),
            startedAt,
        });
    } catch (error) {
        log("warn", "couldn't register the session", error);
    }
};
register();
tracker.on("name", register);
markReady();

process.on("exit", () => {
    removePeer(session.sessionId);
    hub?.shutdown();
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => process.exit(0));

log("info", "octovox ready", { sessionId: session.sessionId, port: http.port });
