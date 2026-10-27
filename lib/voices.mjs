import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { azureToken } from "./azure.mjs";
import { RUN_DIR } from "./config.mjs";
import { log } from "./log.mjs";
import { getSecret, secretAccount } from "./secrets.mjs";
import { isLanguage, LANGUAGES } from "./text.mjs";

// Replaceable in tests.
export const deps = { fetch: (...args) => fetch(...args), token: azureToken, secret: getSecret };

const VOICES_TTL_MS = 12 * 3600_000;
const SYNTH_TIMEOUT_MS = 20_000;
const voiceLists = new Map();
const inflight = new Map();

class VoiceError extends Error {}

// --- Azure AI Foundry / Azure Speech (MAI-Voice, neural and HD voices) ---

export function foundryTarget(endpoint) {
    const url = new URL(endpoint);
    const resource = url.hostname.match(/^([a-z0-9-]+)\.(?:cognitiveservices\.azure\.com|services\.ai\.azure\.com|openai\.azure\.com)$/i);
    if (resource) {
        // Foundry, project and Azure OpenAI hosts all share the resource's custom domain.
        const base = `https://${resource[1].toLowerCase()}.cognitiveservices.azure.com/tts/cognitiveservices`;
        return { synth: `${base}/v1`, voices: `${base}/voices/list`, entra: true, key: base };
    }
    const regional = url.hostname.match(/^([a-z0-9]+)\.(?:tts\.speech\.microsoft\.com|api\.cognitive\.microsoft\.com)$/i);
    if (regional) {
        const base = `https://${regional[1].toLowerCase()}.tts.speech.microsoft.com/cognitiveservices`;
        return { synth: `${base}/v1`, voices: `${base}/voices/list`, entra: false, key: base };
    }
    const path = url.pathname.replace(/\/+$/, "");
    if (/\/cognitiveservices\/v1$/.test(path)) {
        const base = `${url.origin}${path.replace(/\/v1$/, "")}`;
        return { synth: `${base}/v1`, voices: `${base}/voices/list`, entra: true, key: base };
    }
    const base = `${url.origin}${path}/tts/cognitiveservices`;
    return { synth: `${base}/v1`, voices: `${base}/voices/list`, entra: true, key: base };
}

export function escapeXml(text) {
    return String(text).replace(/[<>&'"]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[char]);
}

export function buildSsml({ text, voiceName, locale, speed = 1 }) {
    const escaped = escapeXml(text);
    const percent = Math.round((speed - 1) * 100);
    const body = percent ? `<prosody rate="${percent > 0 ? "+" : ""}${percent}%">${escaped}</prosody>` : escaped;
    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="${locale}"><voice name="${escapeXml(voiceName)}">${body}</voice></speak>`;
}

// Picks the configured voice for a language, or the first one this model really offers.
export function resolveFoundryVoice(cfg, lang, available = null) {
    const code = isLanguage(lang) ? lang : "en";
    const neural = cfg.model === "neural";
    const preferred = (neural ? cfg.neuralVoices : cfg.voices)?.[code] ?? (neural ? LANGUAGES[code].neuralVoice : LANGUAGES[code].maiVoice);
    let id = preferred;
    if (available?.length && !available.some((voice) => voice.id === preferred)) id = available[0].id;
    return { id, name: neural ? id : `${id}:${cfg.model}`, locale: id.split("-").slice(0, 2).join("-") };
}

async function authHeaders(kind, cfg, { entraAllowed = true, azure = true } = {}) {
    if (cfg.auth === "entra") {
        if (!entraAllowed) throw new VoiceError("Microsoft Entra ID needs your resource endpoint (https://<resource>.cognitiveservices.azure.com), not a regional one.");
        return { Authorization: `Bearer ${await deps.token()}` };
    }
    const key = await deps.secret(secretAccount(kind, cfg.endpoint));
    if (!key) throw new VoiceError("No API key saved for this endpoint yet. Add it in Settings → Voice.");
    if (kind === "foundry") return { "Ocp-Apim-Subscription-Key": key };
    return azure ? { "api-key": key } : { Authorization: `Bearer ${key}` };
}

function httpError(status, body, cfg) {
    const detail = String(body ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
    if (status === 401 || status === 403) {
        return new VoiceError(
            cfg.auth === "entra"
                ? `Access denied (HTTP ${status}). Your account needs the "Cognitive Services User" or "Cognitive Services Speech User" role on this resource.`
                : `Access denied (HTTP ${status}). Check the API key.`,
        );
    }
    if (status === 404) return new VoiceError(`Not found (HTTP 404). Check the endpoint${cfg.model ? " and the model or deployment name" : ""}.`);
    if (status === 429) return new VoiceError("Too many requests (HTTP 429). Try again in a moment.");
    if (status === 400) return new VoiceError(`The service rejected the request (HTTP 400)${detail ? `: ${detail}` : ". Check the voice and model."}`);
    return new VoiceError(`The voice service failed (HTTP ${status})${detail ? `: ${detail}` : ""}.`);
}

async function request(url, init, cfg) {
    const signals = [AbortSignal.timeout(SYNTH_TIMEOUT_MS), init.signal].filter(Boolean);
    let response;
    try {
        response = await deps.fetch(url, { ...init, signal: AbortSignal.any(signals) });
    } catch (error) {
        if (init.signal?.aborted) throw error;
        if (error.name === "TimeoutError") throw new VoiceError("The voice service took too long to answer.");
        const host = new URL(url).host;
        throw new VoiceError(`Couldn't reach ${host}: ${error.cause?.code ?? error.message}`);
    }
    if (!response.ok) throw httpError(response.status, await response.text().catch(() => ""), cfg);
    return response;
}

function parseVoiceList(list) {
    const voices = [];
    for (const item of Array.isArray(list) ? list : []) {
        const short = String(item.ShortName ?? "");
        const locale = String(item.Locale ?? "");
        const lang = locale.slice(0, 2);
        if (!short || !isLanguage(lang)) continue;
        const [id, model] = short.split(":");
        const mai = (item.VoiceTag?.Source ?? []).includes("MAI") || /^MAI-Voice/.test(model ?? "");
        voices.push({
            id: mai ? id : short,
            model: mai ? model : "neural",
            lang,
            locale,
            name: mai ? id.split("-").slice(2).join("-") : String(item.LocalName || item.DisplayName || short),
            gender: String(item.Gender ?? "").toLowerCase(),
        });
    }
    return voices;
}

function diskCache(target) {
    return join(RUN_DIR, `voices-${target.key.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 120)}.json`);
}

// Full voice catalogue of the endpoint, cached 12 h in memory and on disk (it's ~1 MB).
export async function foundryVoiceList(cfg, { refresh = false } = {}) {
    const target = foundryTarget(cfg.endpoint);
    const memo = voiceLists.get(target.key);
    if (!refresh && memo && Date.now() - memo.at < VOICES_TTL_MS) return memo.voices;
    if (!refresh) {
        try {
            const saved = JSON.parse(readFileSync(diskCache(target), "utf8"));
            if (Date.now() - saved.at < VOICES_TTL_MS && Array.isArray(saved.voices)) {
                voiceLists.set(target.key, saved);
                return saved.voices;
            }
        } catch {
            // Not cached yet.
        }
    }
    // Concurrent callers (background warm-up, the settings panel, a retry) share one download.
    if (inflight.has(target.key)) return inflight.get(target.key);
    const job = (async () => {
        const headers = await authHeaders("foundry", cfg, { entraAllowed: target.entra });
        const response = await request(target.voices, { headers: { ...headers, "User-Agent": "Octovox" } }, cfg);
        const voices = parseVoiceList(await response.json());
        const entry = { at: Date.now(), voices };
        voiceLists.set(target.key, entry);
        try {
            writeFileSync(diskCache(target), JSON.stringify(entry));
        } catch (error) {
            log("warn", "couldn't cache the voice list", error);
        }
        return voices;
    })().finally(() => inflight.delete(target.key));
    inflight.set(target.key, job);
    return job;
}

export function cachedVoices(cfg, lang) {
    try {
        const memo = voiceLists.get(foundryTarget(cfg.endpoint).key);
        return memo ? memo.voices.filter((voice) => voice.lang === lang && voice.model === cfg.model) : null;
    } catch {
        return null;
    }
}

export async function foundrySynthesize({ text, lang, cfg, speed = 1, signal }) {
    const target = foundryTarget(cfg.endpoint);
    const headers = {
        ...(await authHeaders("foundry", cfg, { entraAllowed: target.entra })),
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
        "User-Agent": "Octovox",
    };
    let available = cachedVoices(cfg, lang);
    // Warm the catalogue in the background so later voices can be checked without waiting.
    if (!available) foundryVoiceList(cfg).catch((error) => log("warn", "voice list", error.message));
    let voice = resolveFoundryVoice(cfg, lang, available);
    const send = (chosen) => request(target.synth, { method: "POST", headers, body: buildSsml({ text, voiceName: chosen.name, locale: chosen.locale, speed }), signal }, cfg);
    let response;
    try {
        response = await send(voice);
    } catch (error) {
        // A voice that this model doesn't offer gives HTTP 400: retry once with one it does.
        if (!(error instanceof VoiceError) || !/HTTP 400/.test(error.message)) throw error;
        available = (await foundryVoiceList(cfg).catch(() => [])).filter((item) => item.lang === lang && item.model === cfg.model);
        const fallback = resolveFoundryVoice(cfg, lang, available);
        if (!available.length || fallback.name === voice.name) throw error;
        voice = fallback;
        response = await send(voice);
    }
    return { audio: Buffer.from(await response.arrayBuffer()), format: "mp3", voice: voice.name };
}

// --- OpenAI-compatible /audio/speech (OpenAI, Azure OpenAI gpt-4o-mini-tts, local servers…) ---

export function openaiTarget(endpoint) {
    const url = new URL(endpoint);
    const azure = /\.(?:openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/i.test(url.hostname);
    const path = url.pathname.replace(/\/+$/, "");
    let speech;
    if (/\/audio\/speech$/.test(path)) speech = `${url.origin}${path}${url.search}`;
    else if (azure && !path) speech = `${url.origin}/openai/v1/audio/speech`;
    else speech = `${url.origin}${path}/audio/speech`;
    return { speech, azure };
}

export async function openaiSynthesize({ text, cfg, speed = 1, signal }) {
    const target = openaiTarget(cfg.endpoint);
    const body = { model: cfg.model, input: text, voice: cfg.voice, response_format: "mp3" };
    if (cfg.instructions && /gpt-4o|tts-2|mini-tts/i.test(cfg.model)) body.instructions = cfg.instructions;
    // gpt-4o-mini-tts ignores `speed`; the classic tts-1 models honour it.
    if (Math.abs(speed - 1) > 0.01 && !/gpt-4o/i.test(cfg.model)) body.speed = speed;
    const headers = { ...(await authHeaders("openai", cfg, { azure: target.azure })), "Content-Type": "application/json", "User-Agent": "Octovox" };
    const response = await request(target.speech, { method: "POST", headers, body: JSON.stringify(body), signal }, cfg);
    return { audio: Buffer.from(await response.arrayBuffer()), format: "mp3", voice: `${cfg.model} · ${cfg.voice}` };
}
