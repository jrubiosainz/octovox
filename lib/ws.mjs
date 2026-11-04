// Minimal WebSocket client (RFC 6455) for GPT-Live: JSON text messages over TLS, and it can send the
// Authorization header (Microsoft Entra ID token), which the WHATWG WebSocket API can't.
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const MAX_MESSAGE = 32 * 1024 * 1024;
const EMPTY = Buffer.alloc(0);

// Client frames must be masked; the server's aren't.
export function encodeFrame(opcode, payload = EMPTY, { mask = true } = {}) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const length = data.length;
    const extra = length < 126 ? 0 : length < 65536 ? 2 : 8;
    const header = Buffer.alloc(2 + extra + (mask ? 4 : 0));
    header[0] = 0x80 | opcode;
    header[1] = (mask ? 0x80 : 0) | (length < 126 ? length : length < 65536 ? 126 : 127);
    if (extra === 2) header.writeUInt16BE(length, 2);
    else if (extra === 8) header.writeBigUInt64BE(BigInt(length), 2);
    if (!mask) return Buffer.concat([header, data]);
    const key = randomBytes(4);
    key.copy(header, 2 + extra);
    const out = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) out[i] = data[i] ^ key[i & 3];
    return Buffer.concat([header, out]);
}

// Feed it bytes as they arrive; it returns the frames that are complete.
export class FrameParser {
    constructor() {
        this.buffer = EMPTY;
    }

    push(chunk) {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        const frames = [];
        for (;;) {
            const b = this.buffer;
            if (b.length < 2) break;
            const fin = (b[0] & 0x80) !== 0;
            const opcode = b[0] & 0x0f;
            const masked = (b[1] & 0x80) !== 0;
            let length = b[1] & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (b.length < 4) break;
                length = b.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (b.length < 10) break;
                const big = b.readBigUInt64BE(2);
                if (big > BigInt(MAX_MESSAGE)) throw new Error("WebSocket frame too large");
                length = Number(big);
                offset = 10;
            }
            const maskAt = offset;
            if (masked) offset += 4;
            if (b.length < offset + length) break;
            let payload = b.subarray(offset, offset + length);
            if (masked) {
                payload = Buffer.from(payload);
                for (let i = 0; i < payload.length; i++) payload[i] ^= b[maskAt + (i & 3)];
            }
            frames.push({ fin, opcode, payload });
            this.buffer = b.length === offset + length ? EMPTY : b.subarray(offset + length);
        }
        return frames;
    }
}

export class WebSocketClient extends EventEmitter {
    constructor(socket, head = EMPTY) {
        super();
        this.socket = socket;
        this.parser = new FrameParser();
        this.fragments = null;
        this.closed = false;
        this.closeSent = false;
        socket.setNoDelay?.(true);
        socket.on("data", (chunk) => this.#onData(chunk));
        socket.on("error", (error) => this.#fail(error));
        socket.on("close", () => this.#finish(1006, "Connection lost"));
        if (head.length) queueMicrotask(() => this.#onData(head));
    }

    get open() {
        return !this.closed && !this.closeSent;
    }

    // Bytes waiting in the socket: lets callers drop stale audio instead of queueing it.
    get bufferedAmount() {
        return this.socket.writableLength ?? 0;
    }

    send(text) {
        if (!this.open) return false;
        return this.socket.write(encodeFrame(OP.TEXT, Buffer.from(String(text), "utf8")));
    }

    close(code = 1000, reason = "") {
        if (this.closed) return;
        if (!this.closeSent) {
            this.closeSent = true;
            const body = Buffer.alloc(2 + Buffer.byteLength(reason));
            body.writeUInt16BE(code, 0);
            body.write(reason, 2);
            this.socket.write(encodeFrame(OP.CLOSE, body));
        }
        // The server answers with its own close frame; don't wait for it forever.
        this.closeTimer ??= setTimeout(() => this.socket.destroy(), 2000);
    }

    terminate() {
        this.socket.destroy();
    }

    #onData(chunk) {
        let frames;
        try {
            frames = this.parser.push(chunk);
        } catch (error) {
            this.#fail(error);
            return;
        }
        for (const frame of frames) this.#onFrame(frame);
    }

    #onFrame({ fin, opcode, payload }) {
        switch (opcode) {
            case OP.PING:
                if (!this.closed) this.socket.write(encodeFrame(OP.PONG, payload));
                return;
            case OP.PONG:
                return;
            case OP.CLOSE: {
                const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
                const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
                if (!this.closeSent) {
                    this.closeSent = true;
                    this.socket.write(encodeFrame(OP.CLOSE, payload.subarray(0, 2)));
                }
                this.socket.end();
                this.#finish(code, reason);
                return;
            }
            case OP.TEXT:
            case OP.BINARY:
                if (fin) this.#message(opcode, payload);
                else this.fragments = { opcode, parts: [Buffer.from(payload)], size: payload.length };
                return;
            case OP.CONT: {
                const pending = this.fragments;
                if (!pending) return;
                pending.parts.push(Buffer.from(payload));
                pending.size += payload.length;
                if (pending.size > MAX_MESSAGE) {
                    this.#fail(new Error("WebSocket message too large"));
                    return;
                }
                if (fin) {
                    this.fragments = null;
                    this.#message(pending.opcode, Buffer.concat(pending.parts));
                }
                return;
            }
            default:
                this.#fail(new Error(`Unknown WebSocket opcode ${opcode}`));
        }
    }

    #message(opcode, data) {
        this.emit("message", opcode === OP.TEXT ? data.toString("utf8") : Buffer.from(data));
    }

    #fail(error) {
        if (this.closed) return;
        this.emit("error", error);
        this.socket.destroy();
    }

    #finish(code, reason) {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.closeTimer);
        this.emit("close", { code, reason });
    }
}

function httpFailure(status, body) {
    let detail = String(body ?? "").trim();
    try {
        const parsed = JSON.parse(detail);
        detail = parsed?.error?.message ?? parsed?.message ?? detail;
    } catch {
        // Not JSON.
    }
    const text = detail ? `: ${detail.slice(0, 300)}` : "";
    return Object.assign(new Error(`GPT-Live refused the connection (HTTP ${status})${text}`), { status });
}

export function connectWebSocket(url, { headers = {}, timeoutMs = 15_000 } = {}) {
    const target = new URL(url);
    const secure = target.protocol === "wss:";
    if (!secure && target.protocol !== "ws:") return Promise.reject(new Error(`Not a WebSocket URL: ${url}`));
    const key = randomBytes(16).toString("base64");
    return new Promise((resolve, reject) => {
        const req = (secure ? httpsRequest : httpRequest)({
            hostname: target.hostname,
            port: target.port || (secure ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            method: "GET",
            headers: { ...headers, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key },
            timeout: timeoutMs,
        });
        req.on("upgrade", (res, socket, head) => {
            const expected = createHash("sha1").update(key + GUID).digest("base64");
            if (res.headers["sec-websocket-accept"] !== expected) {
                socket.destroy();
                reject(new Error("GPT-Live answered with an invalid WebSocket handshake"));
                return;
            }
            socket.setTimeout(0);
            resolve(new WebSocketClient(socket, head));
        });
        req.on("response", (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (data) => {
                if (body.length < 4000) body += data;
            });
            res.on("end", () => reject(httpFailure(res.statusCode, body)));
        });
        req.on("timeout", () => req.destroy(new Error("Timed out connecting to GPT-Live")));
        req.on("error", reject);
        req.end();
    });
}
