import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { UI_DIR } from "./config.mjs";
import { avatarFile, githubLogin } from "./github.mjs";
import { log } from "./log.mjs";
import { isLanguage, LANGUAGE_CODES, LANGUAGES } from "./text.mjs";
import { listVoices } from "./tts.mjs";

const HTML = "text/html; charset=utf-8";
const STATIC = new Map([
    ["/ui/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/ui/app.css", ["app.css", "text/css; charset=utf-8"]],
]);
// Mona Sans (OFL) sits in a hidden folder: it's binary, so it isn't uploaded when the extension is shared as a gist.
const FONT = join(UI_DIR, ".fonts", "MonaSans.woff2");

// The Octicons sprite is inlined so <use href="#..."> works without extra requests.
async function renderIndex() {
    const [page, icons] = await Promise.all([readFile(join(UI_DIR, "index.html"), "utf8"), readFile(join(UI_DIR, "icons.svg"), "utf8")]);
    return page.replace("<!--ICONS-->", icons);
}

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function sameToken(given, expected) {
    const a = Buffer.from(String(given ?? ""));
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
}

async function readJson(req, limit = 256 * 1024) {
    // Requiring JSON forces a CORS preflight we never grant: it blocks requests from other websites.
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "JSON expected");
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new HttpError(413, "Body too large");
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new HttpError(400, "Invalid JSON");
    }
}

function ndjson(res) {
    res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    res.on("error", () => {});
    return (item) => {
        if (!res.writableEnded) res.write(`${JSON.stringify(item)}\n`);
    };
}

async function streamAsk(res, run) {
    const write = ndjson(res);
    try {
        const answer = await run((text) => write({ type: "chunk", text }));
        write({ type: "done", answer });
    } catch (error) {
        write({ type: "error", error: error.message });
    }
    res.end();
}

const str = (value, max = 8000) => (typeof value === "string" ? value.slice(0, max) : "");

async function uiApi(hub, req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
        case "GET /api/state":
            return json(res, 200, {
                self: { sessionId: hub.local.sessionId },
                user: { login: hub.local.login ?? githubLogin() },
                settings: hub.settings(),
                peers: await hub.freshPeers(),
                stt: hub.stt,
                languages: LANGUAGE_CODES.map((code) => ({ code, name: LANGUAGES[code].name, native: LANGUAGES[code].native })),
                systemVoices: await listVoices(),
                voiceStatus: await hub.voiceStatus(),
            });
        case "GET /api/events": {
            res.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-store",
                Connection: "keep-alive",
            });
            res.write("retry: 2000\n\n");
            hub.addClient(res);
            const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
            req.on("close", () => {
                clearInterval(ping);
                hub.removeClient(res);
            });
            return;
        }
        case "POST /api/settings":
            return json(res, 200, { settings: hub.updateSettings(await readJson(req)) });
        case "POST /api/rec/start":
            await readJson(req);
            hub.recStart();
            return json(res, 200, { ok: true });
        case "POST /api/rec/stop":
            await readJson(req);
            return json(res, 200, await hub.recStop());
        case "POST /api/rec/cancel":
            await readJson(req);
            hub.recCancel();
            return json(res, 200, { ok: true });
        case "POST /api/ask": {
            const body = await readJson(req);
            return streamAsk(res, async (onChunk) => {
                const lang = isLanguage(body.lang) ? body.lang : null;
                const { answer } = await hub.ask({ target: str(body.target, 200), question: str(body.question), via: str(body.via, 20), lang, onChunk });
                return answer;
            });
        }
        case "POST /api/send": {
            const body = await readJson(req);
            return json(res, 200, await hub.send({ target: str(body.target, 200), text: str(body.text, 20_000), dictated: body.dictated === true, mode: str(body.mode, 20) }));
        }
        case "POST /api/answer": {
            const body = await readJson(req);
            return json(res, 200, await hub.answer({ target: str(body.target, 200), requestId: str(body.requestId, 200), text: str(body.text), via: str(body.via, 20) }));
        }
        case "POST /api/check-in": {
            await readJson(req);
            const write = ndjson(res);
            try {
                await hub.checkIn({ onItem: write });
                write({ type: "done" });
            } catch (error) {
                write({ type: "error", error: error.message });
            }
            return res.end();
        }
        case "GET /api/history": {
            const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 40));
            return json(res, 200, { items: await hub.history(url.searchParams.get("target") ?? "", limit) });
        }
        case "POST /api/tts/speak": {
            const body = await readJson(req);
            await hub.say(str(body.text), str(body.lang, 5) || undefined);
            return json(res, 200, { ok: true });
        }
        case "POST /api/tts/stop":
            await readJson(req);
            hub.stopSpeaking();
            return json(res, 200, { ok: true });
        case "POST /api/tts/test": {
            const body = await readJson(req);
            try {
                return json(res, 200, await hub.testVoice(isLanguage(body.lang) ? body.lang : null));
            } catch (error) {
                return json(res, 200, { ok: false, error: error.message });
            }
        }
        case "GET /api/tts/voices":
            try {
                return json(res, 200, await hub.voices({ refresh: url.searchParams.get("refresh") === "1" }));
            } catch (error) {
                return json(res, 200, { error: error.message, languages: {} });
            }
        case "GET /api/tts/status":
            return json(res, 200, await hub.voiceStatus());
        case "POST /api/tts/key": {
            const body = await readJson(req);
            if (body.provider !== "foundry" && body.provider !== "openai") throw new HttpError(400, "Unknown provider");
            return json(res, 200, await hub.saveKey(body.provider, str(body.key, 4096).trim()));
        }
        default:
            throw new HttpError(404, "Unknown route");
    }
}

async function peerApi(local, req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
        case "GET /peer/status":
            return json(res, 200, await local.status());
        case "POST /peer/ask": {
            const body = await readJson(req);
            return streamAsk(res, (onChunk) => local.ask(str(body.question), { lang: isLanguage(body.lang) ? body.lang : null, via: str(body.via, 20) || "text", onChunk }));
        }
        case "POST /peer/send": {
            const body = await readJson(req);
            return json(res, 200, await local.send(str(body.text, 20_000), { dictated: body.dictated === true, mode: str(body.mode, 20) }));
        }
        case "POST /peer/answer": {
            const body = await readJson(req);
            return json(res, 200, await local.answer(str(body.requestId, 200), str(body.text), { via: str(body.via, 20) || "text" }));
        }
        case "GET /peer/history": {
            const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 40));
            return json(res, 200, { items: await local.history(limit) });
        }
        default:
            throw new HttpError(404, "Unknown route");
    }
}

// One server per session process: serves the panel (/ui, /api) and the session-to-session API (/peer).
export async function startHttpServer({ uiToken, peerToken, getHub, getLocal }) {
    const server = createServer((req, res) => {
        handle(req, res).catch((error) => {
            const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
            if (status >= 500) log("error", `${req.method} ${req.url?.split("?")[0]}`, error);
            if (!res.headersSent) json(res, status, { error: error.message });
            else res.end();
        });
    });

    async function handle(req, res) {
        const url = new URL(req.url, "http://127.0.0.1");
        const host = String(req.headers.host ?? "").split(":")[0];
        // DNS-rebinding defence: loopback names only.
        if (host !== "127.0.0.1" && host !== "localhost") throw new HttpError(421, "Host not allowed");
        if (req.method === "GET" && (url.pathname === "/ui/" || url.pathname === "/ui/index.html")) {
            const body = await renderIndex();
            res.writeHead(200, { "Content-Type": HTML, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
            return res.end(body);
        }
        if (req.method === "GET" && STATIC.has(url.pathname)) {
            const [file, type] = STATIC.get(url.pathname);
            const body = await readFile(join(UI_DIR, file));
            res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
            return res.end(body);
        }
        if (req.method === "GET" && url.pathname === "/ui/fonts/mona-sans.woff2") {
            const body = await readFile(FONT).catch(() => null);
            if (!body) throw new HttpError(404, "Font not installed");
            res.writeHead(200, { "Content-Type": "font/woff2", "Cache-Control": "max-age=86400" });
            return res.end(body);
        }
        if (req.method === "GET" && url.pathname === "/ui/avatar.png") {
            const file = await avatarFile(getLocal()?.login ?? githubLogin());
            const body = file ? await readFile(file).catch(() => null) : null;
            if (!body) throw new HttpError(404, "No avatar");
            // GitHub serves avatars as JPEG or PNG depending on the original image.
            const type = body[0] === 0xff && body[1] === 0xd8 ? "image/jpeg" : body.subarray(0, 4).toString("latin1") === "\x89PNG" ? "image/png" : "application/octet-stream";
            res.writeHead(200, { "Content-Type": type, "Cache-Control": "max-age=3600", "X-Content-Type-Options": "nosniff" });
            return res.end(body);
        }
        if (url.pathname.startsWith("/api/")) {
            if (!sameToken(req.headers["x-octovox-token"] ?? url.searchParams.get("t"), uiToken)) throw new HttpError(401, "Invalid token");
            const hub = getHub();
            if (!hub) throw new HttpError(503, "Octovox is still starting");
            return uiApi(hub, req, res, url);
        }
        if (url.pathname.startsWith("/peer/")) {
            if (!sameToken(req.headers["x-octovox-peer"], peerToken)) throw new HttpError(401, "Invalid token");
            const local = getLocal();
            if (!local) throw new HttpError(503, "Octovox is still starting");
            return peerApi(local, req, res, url);
        }
        throw new HttpError(404, "Not found");
    }

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    server.on("error", (error) => log("error", "servidor HTTP", error));
    return { server, port: server.address().port };
}
