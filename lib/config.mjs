import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LANGUAGE_CODES, LANGUAGES } from "./text.mjs";

export const EXT_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const EXT_NAME = basename(EXT_DIR);
export const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
// User data always lives under $COPILOT_HOME, even if the extension is installed in a repo.
export const HOME_DIR = join(COPILOT_HOME, "extensions", EXT_NAME);
export const DATA_DIR = join(HOME_DIR, "artifacts");
export const RUN_DIR = join(HOME_DIR, ".run");
export const PEERS_DIR = join(RUN_DIR, "peers");
export const MARKS_DIR = join(RUN_DIR, "announced");
export const UI_DIR = join(EXT_DIR, "ui");
export const STT_DIR = join(EXT_DIR, "stt");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");
// Language, speed and voice provider live in their own file: panels from the first version rewrite
// settings.json with only the keys they know, which would silently drop the voice configuration.
const SPEECH_FILE = join(DATA_DIR, "speech.json");
const SPEECH_KEYS = ["language", "speed", "tts"];
// "Mute all messages" is a flag file that every Octovox process checks before making a sound. A
// separate file can't be reset by panels that save settings without knowing about it.
const MUTE_FILE = join(DATA_DIR, "muted");

export const TTS_PROVIDERS = ["system", "foundry", "openai"];
// "neural" = Azure neural and HD voices (any voice name); the rest are MAI-Voice models.
export const FOUNDRY_MODELS = ["MAI-Voice-2.1", "MAI-Voice-2.1-Flash", "MAI-Voice-2", "MAI-Voice-2-Flash", "neural"];

export const DEFAULT_SETTINGS = Object.freeze({
    language: "auto", // language the user speaks and wants answers in: auto | en | es | it | …
    mode: "ask", // push-to-talk mode: ask (side question) | prompt (message to the session)
    speak: true, // read answers aloud
    announce: true, // spoken alerts for pending questions and finished tasks
    sounds: true, // GitHub Copilot dictation sounds when the mic opens and closes
    autoSend: false, // send dictated prompts without review
    sendMode: "enqueue", // enqueue | immediate (steers the session at its next step)
    speed: 1, // speaking speed multiplier
    doneAfterSeconds: 45, // announce a finished turn only if it took at least this long
    muted: false, // "Mute all messages": no voice or sounds at all; answers and alerts still show in the panel
    tts: {
        provider: "system",
        foundry: {
            endpoint: "",
            auth: "entra",
            model: "MAI-Voice-2.1", // most natural; the Flash variants answer ~3× faster
            voices: Object.fromEntries(LANGUAGE_CODES.map((code) => [code, LANGUAGES[code].maiVoice])),
            neuralVoices: Object.fromEntries(LANGUAGE_CODES.map((code) => [code, LANGUAGES[code].neuralVoice])),
        },
        openai: {
            endpoint: "",
            auth: "key",
            model: "gpt-4o-mini-tts",
            voice: "coral",
            instructions: "Speak naturally and warmly, like a helpful teammate giving a quick update.",
        },
    },
});

const ENUMS = {
    language: ["auto", ...LANGUAGE_CODES],
    mode: ["ask", "prompt"],
    sendMode: ["enqueue", "immediate"],
};
const AUTH = ["entra", "key"];
const VOICE_ID = /^[a-z]{2,3}-[A-Z]{2,3}-[\p{L}\p{N}]+(?::[\w.-]+)?$/u;

function cleanUrl(value, fallback) {
    if (value === "") return "";
    if (typeof value !== "string" || value.length > 300) return fallback;
    try {
        const url = new URL(value.trim());
        if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) return fallback;
        return url.toString().replace(/\/+$/, "");
    } catch {
        return fallback;
    }
}

function cleanVoices(raw, fallback) {
    const out = { ...fallback };
    if (raw && typeof raw === "object") {
        for (const code of LANGUAGE_CODES) {
            const value = raw[code];
            if (typeof value === "string" && value.length <= 80 && VOICE_ID.test(value)) out[code] = value;
        }
    }
    return out;
}

function sanitizeTts(raw, base = DEFAULT_SETTINGS.tts) {
    const tts = raw && typeof raw === "object" ? raw : {};
    const foundry = tts.foundry && typeof tts.foundry === "object" ? tts.foundry : {};
    const openai = tts.openai && typeof tts.openai === "object" ? tts.openai : {};
    return {
        provider: TTS_PROVIDERS.includes(tts.provider) ? tts.provider : base.provider,
        foundry: {
            endpoint: cleanUrl(foundry.endpoint, base.foundry.endpoint),
            auth: AUTH.includes(foundry.auth) ? foundry.auth : base.foundry.auth,
            model: FOUNDRY_MODELS.includes(foundry.model) ? foundry.model : base.foundry.model,
            voices: cleanVoices(foundry.voices, base.foundry.voices),
            neuralVoices: cleanVoices(foundry.neuralVoices, base.foundry.neuralVoices),
        },
        openai: {
            endpoint: cleanUrl(openai.endpoint, base.openai.endpoint),
            auth: AUTH.includes(openai.auth) ? openai.auth : base.openai.auth,
            model: typeof openai.model === "string" && /^[\w.:/-]{1,100}$/.test(openai.model) ? openai.model : base.openai.model,
            voice: typeof openai.voice === "string" && /^[\w-]{1,60}$/.test(openai.voice) ? openai.voice : base.openai.voice,
            instructions: typeof openai.instructions === "string" ? openai.instructions.slice(0, 400) : base.openai.instructions,
        },
    };
}

export function ensureDirs() {
    mkdirSync(DATA_DIR, { recursive: true });
    for (const dir of [RUN_DIR, PEERS_DIR, MARKS_DIR]) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
}

// Invalid values fall back to `base`: the defaults, or the current settings when saving a change.
export function sanitizeSettings(raw, base = DEFAULT_SETTINGS) {
    const out = structuredClone(base);
    if (!raw || typeof raw !== "object") return out;
    for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
        const value = raw[key];
        if (value === undefined || key === "tts") continue;
        if (ENUMS[key]) {
            if (ENUMS[key].includes(value)) out[key] = value;
        } else if (typeof fallback === "boolean") {
            out[key] = value === true;
        } else if (typeof fallback === "number") {
            const n = Number(value);
            if (Number.isFinite(n)) out[key] = key === "speed" ? Math.round(Math.min(1.6, Math.max(0.7, n)) * 20) / 20 : Math.max(0, n);
        }
    }
    // Settings from the first version: words per minute for `say`.
    if (raw.speed === undefined && Number.isFinite(Number(raw.rate))) {
        out.speed = Math.round(Math.min(1.6, Math.max(0.7, Number(raw.rate) / 185)) * 20) / 20;
    }
    out.tts = sanitizeTts(raw.tts, base.tts);
    return out;
}

function deepMerge(base, patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
    const out = { ...(base && typeof base === "object" ? base : {}) };
    for (const [key, value] of Object.entries(patch)) {
        out[key] = value && typeof value === "object" && !Array.isArray(value) ? deepMerge(out[key], value) : value;
    }
    return out;
}

function readJson(file) {
    try {
        const value = JSON.parse(readFileSync(file, "utf8"));
        return value && typeof value === "object" ? value : null;
    } catch {
        return null;
    }
}

function writeJson(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(tmp, file);
}

export function isMuted() {
    return existsSync(MUTE_FILE);
}

function setMuted(on) {
    if (on) {
        if (!existsSync(MUTE_FILE)) writeFileSync(MUTE_FILE, `${new Date().toISOString()}\n`);
    } else {
        rmSync(MUTE_FILE, { force: true });
    }
}

export function loadSettings() {
    const general = readJson(SETTINGS_FILE) ?? {};
    const speech = readJson(SPEECH_FILE);
    // Without speech.json yet, the speech keys come from settings.json (older installs).
    const raw = speech ? { ...general, ...Object.fromEntries(SPEECH_KEYS.filter((key) => key in speech).map((key) => [key, speech[key]])) } : general;
    return { ...sanitizeSettings(raw), muted: isMuted() };
}

export function saveSettings(patch) {
    const current = loadSettings();
    const next = sanitizeSettings(deepMerge(current, patch), current);
    mkdirSync(DATA_DIR, { recursive: true });
    // Only an explicit change touches the flag, so a stale read elsewhere can never unmute.
    if (patch && typeof patch === "object" && "muted" in patch) setMuted(next.muted);
    const speech = Object.fromEntries(SPEECH_KEYS.map((key) => [key, next[key]]));
    const general = Object.fromEntries(Object.entries(next).filter(([key]) => !SPEECH_KEYS.includes(key) && key !== "muted"));
    writeJson(SPEECH_FILE, speech);
    writeJson(SETTINGS_FILE, general);
    return { ...next, muted: isMuted() };
}
