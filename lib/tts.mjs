import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_DIR } from "./config.mjs";
import { log } from "./log.mjs";
import { detectLanguage, isLanguage, LANGUAGES, SentenceBuffer } from "./text.mjs";

const SAY = "/usr/bin/say";
const AFPLAY = "/usr/bin/afplay";
const AUDIO_DIR = join(RUN_DIR, "tts");
const BASE_WPM = 185;
// Novelty voices that make no sense for an assistant.
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Wobble|Fred|Good News|Jester|Junior|Kathy|Organ|Superstar|Ralph|Trinoids|Whisper|Zarvox|Grandma|Grandpa|Rocko|Shelley|Sandy|Eddy|Flo|Reed)\b/;

let voicesCache = null;

// macOS voices installed for the supported languages.
export function listVoices() {
    voicesCache ??= new Promise((resolve) => {
        execFile(SAY, ["-v", "?"], { timeout: 5000 }, (error, stdout) => {
            if (error) return resolve([]);
            const voices = [];
            for (const line of stdout.split("\n")) {
                const match = line.match(/^(.+?)\s{2,}([a-z]{2,3}_[A-Za-z0-9]{2,4})\s+#/);
                if (!match) continue;
                const [, name, locale] = match;
                const lang = locale.slice(0, 2);
                if (!isLanguage(lang) || NOVELTY.test(name)) continue;
                voices.push({ name: name.trim(), locale, lang });
            }
            resolve(voices);
        });
    });
    return voicesCache;
}

export async function pickSystemVoice(lang) {
    const code = isLanguage(lang) ? lang : "en";
    const installed = (await listVoices()).filter((voice) => voice.lang === code);
    return LANGUAGES[code].system.find((name) => installed.some((voice) => voice.name === name)) ?? installed[0]?.name ?? null;
}

function sayProcess(text, voice, speed) {
    const args = ["-r", String(Math.round(BASE_WPM * speed))];
    if (voice) args.unshift("-v", voice);
    // The text goes through stdin so it can never be read as an option.
    const proc = spawn(SAY, args, { stdio: ["pipe", "ignore", "ignore"] });
    proc.stdin.on("error", () => {});
    proc.stdin.end(text);
    return proc;
}

function audioProcess(audio, format) {
    mkdirSync(AUDIO_DIR, { recursive: true, mode: 0o700 });
    const file = join(AUDIO_DIR, `${randomBytes(6).toString("hex")}.${format || "mp3"}`);
    writeFileSync(file, audio);
    const proc = spawn(AFPLAY, [file], { stdio: "ignore" });
    proc.on("close", () => {
        try {
            unlinkSync(file);
        } catch {
            // Already gone.
        }
    });
    return proc;
}

// How audio reaches the speakers; tests swap these so nothing is actually played.
export const playback = {
    audio: (audio, format) => audioProcess(audio, format),
    say: async (text, lang, speed) => sayProcess(text, await pickSystemVoice(lang), speed),
};

// Speech queue. Each utterance becomes sentence-sized chunks; while one chunk plays, the next
// one is already being synthesized, so cloud voices start fast and flow without gaps.
export class Speaker extends EventEmitter {
    // engineFor(lang) → { kind: "cloud", label, synthesize(text, signal) } | { kind: "system" }
    constructor({ engineFor, speed = () => 1, defaultLang = () => "en" }) {
        super();
        this.engineFor = engineFor;
        this.speed = speed;
        this.defaultLang = defaultLang;
        this.queue = [];
        this.current = null;
        this.generation = 0;
        this.lastWarning = 0;
    }

    get speaking() {
        return this.current !== null || this.queue.length > 0;
    }

    speak(text, { lang = null, maxChars = 900 } = {}) {
        const feed = this.stream({ lang, maxChars });
        feed.push(text);
        feed.end();
    }

    // Incremental speech: push text as it streams in; complete sentences start playing right away.
    stream({ lang = null, maxChars = 1200 } = {}) {
        const generation = this.generation;
        let chosen = isLanguage(lang) ? lang : null;
        let engine = null;
        const buffer = new SentenceBuffer(
            (chunk) => {
                if (generation !== this.generation) return;
                chosen ??= detectLanguage(chunk, { fallback: this.defaultLang() });
                engine ??= this.engineFor(chosen);
                this.queue.push({ text: chunk, lang: chosen, engine, generation });
                this.#prefetch();
                this.#pump();
            },
            { maxChars },
        );
        return {
            push: (text) => buffer.push(text),
            end: () => buffer.end(),
            cancel: () => {
                buffer.closed = true;
            },
        };
    }

    // Plays audio that was already synthesized (voice test), queued like any other chunk.
    playPrepared({ text, lang, result, engine }) {
        this.queue.push({ text, lang, engine, generation: this.generation, audio: Promise.resolve(result) });
        this.#pump();
    }

    stop() {
        this.generation += 1;
        for (const item of this.queue) item.controller?.abort();
        this.queue = [];
        const current = this.current;
        this.current = null;
        if (current) {
            current.controller?.abort();
            current.proc?.kill("SIGTERM");
        }
        this.emit("state", false);
    }

    #startSynthesis(item) {
        if (item.audio || item.engine.kind !== "cloud") return;
        item.controller = new AbortController();
        item.audio = item.engine.synthesize(item.text, item.controller.signal).catch((error) => ({ error }));
    }

    #prefetch() {
        // Keep at most the chunk that's playing plus the next one in flight.
        if (this.current) this.#startSynthesis(this.current);
        if (this.queue[0]) this.#startSynthesis(this.queue[0]);
    }

    #warn(error, engine) {
        log("warn", `cloud voice failed (${engine.label})`, error.message);
        if (Date.now() - this.lastWarning > 60_000) {
            this.lastWarning = Date.now();
            this.emit("warning", `${engine.label}: ${error.message} Using the macOS voice instead.`);
        }
    }

    async #pump() {
        if (this.current || !this.queue.length) return;
        const item = this.queue.shift();
        this.current = item;
        this.emit("state", true);
        this.#startSynthesis(item);
        this.#prefetch();
        try {
            let proc = null;
            if (item.engine.kind === "cloud") {
                const result = await item.audio;
                if (item.generation !== this.generation || this.current !== item) return;
                if (result?.error) {
                    if (result.error.name === "AbortError") return;
                    this.#warn(result.error, item.engine);
                    proc = await playback.say(item.text, item.lang, this.speed());
                } else {
                    proc = playback.audio(result.audio, result.format);
                }
            } else {
                proc = await playback.say(item.text, item.lang, this.speed());
            }
            if (item.generation !== this.generation || this.current !== item) {
                proc.kill("SIGTERM");
                return;
            }
            item.proc = proc;
            await new Promise((resolve) => {
                proc.on("close", resolve);
                proc.on("error", resolve);
            });
        } catch (error) {
            log("warn", "speech failed", error);
        } finally {
            if (this.current === item) this.current = null;
            if (this.queue.length) this.#pump();
            else if (!this.current) this.emit("state", false);
        }
    }
}
