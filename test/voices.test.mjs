import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "octovox-voices-"));
process.env.COPILOT_HOME = home;
const { DEFAULT_SETTINGS, ensureDirs } = await import("../lib/config.mjs");
const voices = await import("../lib/voices.mjs");
const { buildSsml, deps, foundrySynthesize, foundryTarget, foundryVoiceList, openaiSynthesize, openaiTarget, resolveFoundryVoice } = voices;

ensureDirs();
after(() => rmSync(home, { recursive: true, force: true }));

const CATALOGUE = [
    { ShortName: "es-ES-Marta:MAI-Voice-2.1", Locale: "es-ES", Gender: "Female", VoiceTag: { Source: ["MAI"] } },
    { ShortName: "es-MX-Valeria:MAI-Voice-2.1", Locale: "es-MX", Gender: "Female", VoiceTag: { Source: ["MAI"] } },
    { ShortName: "en-US-Harper:MAI-Voice-2.1", Locale: "en-US", Gender: "Female", VoiceTag: { Source: ["MAI"] } },
    { ShortName: "en-US-Harper:MAI-Voice-2.1-Flash", Locale: "en-US", Gender: "Female", VoiceTag: { Source: ["MAI"] } },
    { ShortName: "es-ES-XimenaMultilingualNeural", Locale: "es-ES", LocalName: "Ximena Multilingüe", Gender: "Female" },
    { ShortName: "ja-JP-NanamiNeural", Locale: "ja-JP", LocalName: "七海", Gender: "Female" },
];

// A fake Azure Speech endpoint: records requests, serves the catalogue and audio.
function fakeService({ rejectVoice = null } = {}) {
    const calls = [];
    deps.token = async () => "entra-token";
    deps.secret = async (account) => (account.startsWith("openai@") || account.startsWith("foundry@") ? "secret-key" : null);
    deps.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/voices/list")) return Response.json(CATALOGUE);
        if (rejectVoice && String(init.body).includes(rejectVoice)) return new Response("Unsupported voice", { status: 400 });
        return new Response(new Uint8Array([0xff, 0xf3, 1, 2]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
    };
    return calls;
}

const foundry = (patch = {}) => ({ ...structuredClone(DEFAULT_SETTINGS.tts.foundry), endpoint: "https://res-a.cognitiveservices.azure.com", ...patch });

beforeEach(() => {
    deps.fetch = () => Promise.reject(new Error("no network in tests"));
});

test("foundryTarget maps resource, project, regional and custom endpoints", () => {
    assert.deepEqual(foundryTarget("https://my-foundry.cognitiveservices.azure.com"), {
        synth: "https://my-foundry.cognitiveservices.azure.com/tts/cognitiveservices/v1",
        voices: "https://my-foundry.cognitiveservices.azure.com/tts/cognitiveservices/voices/list",
        entra: true,
        key: "https://my-foundry.cognitiveservices.azure.com/tts/cognitiveservices",
    });
    assert.equal(
        foundryTarget("https://MY-FOUNDRY.services.ai.azure.com/api/projects/my-project").synth,
        "https://my-foundry.cognitiveservices.azure.com/tts/cognitiveservices/v1",
    );
    const regional = foundryTarget("https://swedencentral.api.cognitive.microsoft.com/");
    assert.equal(regional.synth, "https://swedencentral.tts.speech.microsoft.com/cognitiveservices/v1");
    assert.equal(regional.entra, false);
    assert.equal(foundryTarget("https://swedencentral.tts.speech.microsoft.com/cognitiveservices/v1").synth, regional.synth);
    assert.equal(foundryTarget("http://127.0.0.1:5000").synth, "http://127.0.0.1:5000/tts/cognitiveservices/v1");
    assert.equal(foundryTarget("http://127.0.0.1:5000/speech/cognitiveservices/v1").voices, "http://127.0.0.1:5000/speech/cognitiveservices/voices/list");
});

test("buildSsml escapes text and turns speed into a prosody rate", () => {
    const ssml = buildSsml({ text: `R&D <ok> "quoted"`, voiceName: "es-ES-Marta:MAI-Voice-2.1", locale: "es-ES", speed: 1.2 });
    assert.match(ssml, /xml:lang="es-ES"/);
    assert.match(ssml, /<voice name="es-ES-Marta:MAI-Voice-2.1"><prosody rate="\+20%">R&amp;D &lt;ok&gt; &quot;quoted&quot;<\/prosody><\/voice>/);
    assert.doesNotMatch(buildSsml({ text: "hi", voiceName: "v", locale: "en-US", speed: 1 }), /prosody/);
    assert.match(buildSsml({ text: "hi", voiceName: "v", locale: "en-US", speed: 0.85 }), /rate="-15%"/);
});

test("resolveFoundryVoice uses the configured voice when the model offers it", () => {
    assert.deepEqual(resolveFoundryVoice(foundry({ model: "MAI-Voice-2.1" }), "es"), { id: "es-ES-Marta", name: "es-ES-Marta:MAI-Voice-2.1", locale: "es-ES" });
    const fallback = resolveFoundryVoice(foundry(), "es", [{ id: "es-MX-Valeria" }]);
    assert.equal(fallback.name, "es-MX-Valeria:MAI-Voice-2.1");
    assert.equal(fallback.locale, "es-MX");
    const neural = resolveFoundryVoice(foundry({ model: "neural" }), "es");
    assert.deepEqual(neural, { id: "es-ES-XimenaMultilingualNeural", name: "es-ES-XimenaMultilingualNeural", locale: "es-ES" });
    assert.equal(resolveFoundryVoice(foundry(), "xx").locale, "en-US");
});

test("openaiTarget finds the /audio/speech route", () => {
    assert.deepEqual(openaiTarget("https://res.openai.azure.com"), { speech: "https://res.openai.azure.com/openai/v1/audio/speech", azure: true });
    assert.deepEqual(openaiTarget("https://api.openai.com/v1"), { speech: "https://api.openai.com/v1/audio/speech", azure: false });
    assert.equal(openaiTarget("http://127.0.0.1:8880/v1/audio/speech").speech, "http://127.0.0.1:8880/v1/audio/speech");
});

test("foundrySynthesize sends SSML with Entra ID and returns mp3", async () => {
    const calls = fakeService();
    const result = await foundrySynthesize({ text: "Hola, ¿qué tal?", lang: "es", cfg: foundry({ model: "MAI-Voice-2.1" }), speed: 1.1 });
    assert.equal(result.format, "mp3");
    assert.equal(result.voice, "es-ES-Marta:MAI-Voice-2.1");
    assert.deepEqual([...result.audio], [0xff, 0xf3, 1, 2]);
    const synth = calls.find((call) => call.url.endsWith("/v1"));
    assert.equal(synth.url, "https://res-a.cognitiveservices.azure.com/tts/cognitiveservices/v1");
    assert.equal(synth.init.method, "POST");
    assert.equal(synth.init.headers.Authorization, "Bearer entra-token");
    assert.equal(synth.init.headers["Content-Type"], "application/ssml+xml");
    assert.equal(synth.init.headers["X-Microsoft-OutputFormat"], "audio-24khz-96kbitrate-mono-mp3");
    assert.match(synth.init.body, /<voice name="es-ES-Marta:MAI-Voice-2.1"><prosody rate="\+10%">Hola, ¿qué tal\?<\/prosody>/);
});

test("foundrySynthesize uses the stored key and retries once with a voice the model offers", async () => {
    const calls = fakeService({ rejectVoice: "es-ES-Elena" });
    const cfg = foundry({ endpoint: "https://res-b.cognitiveservices.azure.com", auth: "key", model: "MAI-Voice-2.1" });
    cfg.voices.es = "es-ES-Elena";
    const result = await foundrySynthesize({ text: "Hola", lang: "es", cfg });
    const synths = calls.filter((call) => call.url.endsWith("/v1"));
    assert.equal(synths.length, 2);
    assert.equal(synths[0].init.headers["Ocp-Apim-Subscription-Key"], "secret-key");
    assert.match(synths[0].init.body, /es-ES-Elena:MAI-Voice-2.1/);
    assert.equal(result.voice, "es-ES-Marta:MAI-Voice-2.1");
    fakeService({ rejectVoice: "es-ES-Marta" });
    await assert.rejects(foundrySynthesize({ text: "Hola", lang: "es", cfg: foundry({ endpoint: "https://res-b.cognitiveservices.azure.com", model: "MAI-Voice-2.1" }) }), /HTTP 400/, "no second try when the voice is already a valid one");
});

test("foundrySynthesize explains auth and network failures", async () => {
    fakeService();
    deps.fetch = async () => new Response("denied", { status: 403 });
    await assert.rejects(foundrySynthesize({ text: "Hi", lang: "en", cfg: foundry({ endpoint: "https://res-c.cognitiveservices.azure.com" }) }), /Cognitive Services User/);
    deps.fetch = async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    };
    await assert.rejects(foundrySynthesize({ text: "Hi", lang: "en", cfg: foundry({ endpoint: "https://res-d.cognitiveservices.azure.com" }) }), /Couldn't reach res-d\.cognitiveservices\.azure\.com: ENOTFOUND/);
    deps.secret = async () => null;
    await assert.rejects(foundrySynthesize({ text: "Hi", lang: "en", cfg: foundry({ endpoint: "https://res-e.cognitiveservices.azure.com", auth: "key" }) }), /No API key saved/);
    await assert.rejects(
        foundrySynthesize({ text: "Hi", lang: "en", cfg: foundry({ endpoint: "https://westeurope.tts.speech.microsoft.com" }) }),
        /Microsoft Entra ID needs your resource endpoint/,
    );
});

test("the voice catalogue is parsed, filtered to our languages and fetched once", async () => {
    const calls = fakeService();
    const cfg = foundry({ endpoint: "https://res-f.cognitiveservices.azure.com" });
    const [first, second] = await Promise.all([foundryVoiceList(cfg), foundryVoiceList(cfg)]);
    assert.equal(calls.filter((call) => call.url.endsWith("/voices/list")).length, 1, "concurrent callers share one download");
    assert.equal(first, second);
    assert.deepEqual(first.find((voice) => voice.id === "es-MX-Valeria"), { id: "es-MX-Valeria", model: "MAI-Voice-2.1", lang: "es", locale: "es-MX", name: "Valeria", gender: "female" });
    assert.equal(first.find((voice) => voice.id === "es-ES-XimenaMultilingualNeural").model, "neural");
    assert.ok(!first.some((voice) => voice.locale === "ja-JP"));
    await foundryVoiceList(cfg);
    assert.equal(calls.length, 1, "served from the cache afterwards");
});

test("openaiSynthesize posts JSON with the key and style instructions", async () => {
    const calls = fakeService();
    const cfg = { ...DEFAULT_SETTINGS.tts.openai, endpoint: "https://res.openai.azure.com" };
    const result = await openaiSynthesize({ text: "Hello there", cfg, speed: 1.2 });
    assert.equal(result.voice, "gpt-4o-mini-tts · coral");
    const [call] = calls;
    assert.equal(call.url, "https://res.openai.azure.com/openai/v1/audio/speech");
    assert.equal(call.init.headers["api-key"], "secret-key");
    const body = JSON.parse(call.init.body);
    assert.deepEqual(Object.keys(body).sort(), ["input", "instructions", "model", "response_format", "voice"]);
    assert.equal(body.speed, undefined, "gpt-4o-mini-tts ignores speed");
    await openaiSynthesize({ text: "Hi", cfg: { ...cfg, endpoint: "https://api.openai.com/v1", model: "tts-1" }, speed: 1.2 });
    const classic = calls.at(-1);
    assert.equal(classic.init.headers.Authorization, "Bearer secret-key");
    assert.equal(JSON.parse(classic.init.body).speed, 1.2);
    assert.equal(JSON.parse(classic.init.body).instructions, undefined);
});
