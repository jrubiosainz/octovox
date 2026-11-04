// Audio for Octovox Interview. The native helper (native/duplex.swift, built once with the Swift
// compiler from Xcode's command line tools) uses macOS voice processing, so the live model doesn't
// hear itself through the speakers. Without it, SoX `rec` and `play` stand in: no echo cancellation,
// so the microphone is held back while the model speaks (headphones avoid that).
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findRec } from "./audio.mjs";
import { EXT_DIR, RUN_DIR } from "./config.mjs";
import { log } from "./log.mjs";

export const LIVE_RATE = 24_000;
const SOURCE = join(EXT_DIR, "native", "duplex.swift");
const BIN_DIR = join(RUN_DIR, "bin");
const XCRUN = "/usr/bin/xcrun";
const PLAY_CANDIDATES = ["/opt/homebrew/bin/play", "/usr/local/bin/play"];
const READY_TIMEOUT_MS = 10_000;

let building = null;
let buildFailure = null; // a failed build isn't retried until Octovox restarts

export const helperPath = () => {
    const hash = createHash("sha256").update(readFileSync(SOURCE)).digest("hex").slice(0, 12);
    return join(BIN_DIR, `octovox-duplex-${hash}`);
};

// Builds the helper once per version of its source; later calls reuse the binary.
export function ensureDuplexHelper({ onBuild } = {}) {
    const bin = helperPath();
    if (existsSync(bin)) return Promise.resolve(bin);
    if (buildFailure) return Promise.reject(buildFailure);
    if (!existsSync(XCRUN)) return Promise.reject(new Error("The Swift compiler isn't installed (xcode-select --install)."));
    building ??= new Promise((resolve, reject) => {
        onBuild?.();
        mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 });
        const tmp = `${bin}.${process.pid}.tmp`;
        execFile(
            XCRUN,
            ["swiftc", "-O", "-swift-version", "5", "-module-cache-path", join(RUN_DIR, "swift-cache"), "-o", tmp, SOURCE],
            { timeout: 240_000, maxBuffer: 4 << 20 },
            (error, _stdout, stderr) => {
                if (error) {
                    rmSync(tmp, { force: true });
                    const detail = String(stderr || error.message).trim().split("\n").slice(-3).join(" ");
                    buildFailure = new Error(`Couldn't build the audio helper: ${detail}`);
                    reject(buildFailure);
                    return;
                }
                renameSync(tmp, bin);
                for (const name of readdirSync(BIN_DIR)) {
                    if (name.startsWith("octovox-duplex-") && join(BIN_DIR, name) !== bin) rmSync(join(BIN_DIR, name), { force: true });
                }
                resolve(bin);
            },
        );
    }).finally(() => {
        building = null;
    });
    return building;
}

const findPlay = () => PLAY_CANDIDATES.find((path) => existsSync(path)) ?? null;

// Level of PCM16 audio in 0..1 on a dB scale, like the push-to-talk meter.
export function pcmLevel(pcm) {
    const samples = Math.floor(pcm.length / 2);
    if (!samples) return 0;
    let sum = 0;
    for (let i = 0; i < samples; i++) {
        const value = pcm.readInt16LE(i * 2) / 32768;
        sum += value * value;
    }
    const db = 20 * Math.log10(Math.sqrt(sum / samples) + 1e-9);
    return Math.max(0, Math.min(1, (db + 60) / 60));
}

export function packet(kind, payload) {
    const header = Buffer.alloc(5);
    header[0] = kind;
    header.writeUInt32LE(payload.length, 1);
    return Buffer.concat([header, payload]);
}

// Events: "mic" (PCM16 24 kHz), "status" ({ queuedMs, in, out }), "notice" (text), "exit" ({ expected, detail }).
class HelperDuplex extends EventEmitter {
    constructor(bin) {
        super();
        this.bin = bin;
        this.echoCancellation = true;
        this.closing = false;
        this.info = null;
        this.lastError = "";
    }

    start() {
        const proc = spawn(this.bin, [], { stdio: ["pipe", "pipe", "pipe"] });
        this.proc = proc;
        proc.stdin.on("error", () => {});
        proc.stdout.on("data", (chunk) => this.emit("mic", chunk));
        let errText = "";
        let lines = "";
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error("The audio helper didn't start"));
                proc.kill("SIGKILL");
            }, READY_TIMEOUT_MS);
            proc.stderr.setEncoding("utf8");
            proc.stderr.on("data", (data) => {
                lines += data;
                let newline;
                while ((newline = lines.indexOf("\n")) >= 0) {
                    const line = lines.slice(0, newline);
                    lines = lines.slice(newline + 1);
                    if (!line.startsWith("@@ ")) {
                        errText = `${errText}${line}\n`.slice(-1000);
                        continue;
                    }
                    let event;
                    try {
                        event = JSON.parse(line.slice(3));
                    } catch {
                        continue;
                    }
                    if (event.event === "status") this.emit("status", event);
                    else if (event.event === "ready") {
                        clearTimeout(timer);
                        this.info = event;
                        this.echoCancellation = event.voiceProcessing === true;
                        resolve(event);
                    } else if (event.event === "error") {
                        // The helper exits right after reporting an error: the message becomes the exit's detail.
                        clearTimeout(timer);
                        this.lastError = String(event.message ?? "");
                        reject(new Error(this.lastError));
                    } else if (event.event === "warning") {
                        log("warn", "duplex", event.message);
                        this.emit("notice", event.message);
                    } else if (event.event === "route") {
                        this.emit("notice", "Audio device changed.");
                    }
                }
            });
            proc.on("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            proc.on("exit", (code, signal) => {
                clearTimeout(timer);
                const detail = this.lastError || errText.trim().split("\n").pop();
                reject(new Error(`The audio helper stopped${detail ? `: ${detail}` : ` (${signal ?? code})`}`));
                this.emit("exit", { code, signal, expected: this.closing, detail });
            });
        });
    }

    play(pcm) {
        if (!this.closing && pcm.length) this.proc?.stdin.write(packet(1, pcm));
    }

    #command(command) {
        if (!this.closing) this.proc?.stdin.write(packet(2, Buffer.from(JSON.stringify(command))));
    }

    flush() {
        this.#command({ cmd: "flush" });
    }

    mute(on) {
        this.#command({ cmd: "mute", on: !!on });
    }

    close() {
        if (this.closing || !this.proc) return;
        this.#command({ cmd: "quit" });
        this.closing = true;
        this.proc.stdin.end();
        const proc = this.proc;
        setTimeout(() => proc.kill("SIGKILL"), 1500).unref();
    }
}

// SoX fallback: no echo cancellation, so the mic is held back while the model is speaking.
class SoxDuplex extends EventEmitter {
    constructor(rec, play) {
        super();
        this.recBin = rec;
        this.playBin = play;
        this.echoCancellation = false;
        this.closing = false;
        this.muted = false;
        this.playEnd = 0;
        this.outLevel = 0;
        this.outUntil = 0;
        this.openUntil = 0;
        this.inLevel = 0;
    }

    async start() {
        const args = ["-q", "--buffer", "1024", "-t", "raw", "-b", "16", "-e", "signed-integer", "-c", "1", "-r", String(LIVE_RATE), "-"];
        this.rec = spawn(this.recBin, args, { stdio: ["ignore", "pipe", "pipe"] });
        // SoX still prints warnings with -q: an unread pipe would fill up and block the recording.
        this.recErr = "";
        this.rec.stderr.on("data", (data) => {
            this.recErr = (this.recErr + data).slice(-1000);
        });
        this.rec.on("error", (error) => {
            this.recErr = error.message;
        });
        this.rec.stdout.on("data", (chunk) => {
            this.inLevel = pcmLevel(chunk);
            // While the model speaks, its own voice would come back through the mic: send silence.
            const held = Date.now() < this.outUntil && Date.now() > this.openUntil;
            this.emit("mic", this.muted || held ? Buffer.alloc(chunk.length) : chunk);
        });
        this.rec.on("close", (code, signal) => this.emit("exit", { code, signal, expected: this.closing, detail: this.recErr.trim().split("\n").pop() }));
        this.#spawnPlay();
        this.timer = setInterval(() => {
            const queuedMs = Math.max(0, this.playEnd - Date.now());
            this.emit("status", { queuedMs, in: this.muted ? 0 : this.inLevel, out: queuedMs > 0 ? this.outLevel : 0 });
        }, 100);
        return { voiceProcessing: false };
    }

    #spawnPlay() {
        this.player = spawn(this.playBin, ["-q", "--buffer", "1024", "-t", "raw", "-b", "16", "-e", "signed-integer", "-c", "1", "-r", String(LIVE_RATE), "-"], {
            stdio: ["pipe", "ignore", "ignore"],
        });
        this.player.stdin.on("error", () => {});
        this.player.on("error", (error) => log("warn", "interview playback", error.message));
    }

    play(pcm) {
        if (this.closing || !pcm.length) return;
        const ms = (pcm.length / 2 / LIVE_RATE) * 1000;
        const level = pcmLevel(pcm);
        this.playEnd = Math.max(this.playEnd, Date.now()) + ms;
        if (level > 0.25) {
            this.outLevel = level;
            this.outUntil = this.playEnd + 250;
        }
        this.player.stdin.write(pcm);
    }

    // Lets the user's voice through for a few seconds even while the model speaks (to interrupt it).
    holdOpen(ms = 4000) {
        this.openUntil = Date.now() + ms;
    }

    flush() {
        this.player.kill("SIGKILL");
        this.playEnd = 0;
        this.#spawnPlay();
    }

    mute(on) {
        this.muted = !!on;
    }

    close() {
        if (this.closing) return;
        this.closing = true;
        clearInterval(this.timer);
        this.rec?.kill("SIGTERM");
        this.player?.kill("SIGTERM");
    }
}

// The best audio this Mac allows: native with echo cancellation, else SoX.
export async function openDuplex({ onBuild } = {}) {
    let helperError = null;
    try {
        const bin = await ensureDuplexHelper({ onBuild });
        const duplex = new HelperDuplex(bin);
        await duplex.start();
        return duplex;
    } catch (error) {
        helperError = error;
        log("warn", "native interview audio unavailable", error.message);
    }
    const rec = findRec();
    const play = findPlay();
    if (!rec || !play) throw new Error(`${helperError.message} SoX isn't installed either (brew install sox).`);
    const duplex = new SoxDuplex(rec, play);
    await duplex.start();
    duplex.fallbackReason = helperError.message;
    return duplex;
}
