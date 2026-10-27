import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "octovox-config-"));
process.env.COPILOT_HOME = home;
const { DATA_DIR, DEFAULT_SETTINGS, ensureDirs, FOUNDRY_MODELS, loadSettings, sanitizeSettings, saveSettings } = await import("../lib/config.mjs");
ensureDirs();

after(() => rmSync(home, { recursive: true, force: true }));

test("defaults: auto language, macOS voice, a voice for every language", () => {
    const settings = sanitizeSettings(null);
    assert.deepEqual(settings, DEFAULT_SETTINGS);
    assert.equal(settings.language, "auto");
    assert.equal(settings.tts.provider, "system");
    assert.ok(FOUNDRY_MODELS.includes(settings.tts.foundry.model));
    assert.equal(Object.keys(settings.tts.foundry.voices).length, 8);
});

test("sanitizeSettings keeps valid values and drops the rest", () => {
    const settings = sanitizeSettings({
        language: "it",
        speak: "yes",
        speed: 1.07,
        mode: "prompt",
        voiceEs: "Mónica",
        tts: {
            provider: "foundry",
            foundry: {
                endpoint: "https://AIF-Test.cognitiveservices.azure.com/",
                auth: "key",
                model: "MAI-Voice-2.1",
                voices: { es: "es-MX-Valeria", en: "bad voice!", de: "de-DE-Mia:MAI-Voice-2.1" },
            },
            openai: { endpoint: "http://example.com", model: "gpt-4o-mini-tts", voice: "../etc", instructions: "x".repeat(900) },
        },
    });
    assert.equal(settings.language, "it");
    assert.equal(settings.speak, false);
    assert.equal(settings.speed, 1.05);
    assert.equal(settings.mode, "prompt");
    assert.equal("voiceEs" in settings, false);
    assert.equal(settings.tts.provider, "foundry");
    assert.equal(settings.tts.foundry.endpoint, "https://aif-test.cognitiveservices.azure.com");
    assert.equal(settings.tts.foundry.auth, "key");
    assert.equal(settings.tts.foundry.model, "MAI-Voice-2.1");
    assert.equal(settings.tts.foundry.voices.es, "es-MX-Valeria");
    assert.equal(settings.tts.foundry.voices.en, DEFAULT_SETTINGS.tts.foundry.voices.en);
    assert.equal(settings.tts.foundry.voices.de, "de-DE-Mia:MAI-Voice-2.1");
    assert.equal(settings.tts.openai.endpoint, "", "plain http is only allowed on loopback");
    assert.equal(settings.tts.openai.voice, "coral");
    assert.equal(settings.tts.openai.instructions.length, 400);
    assert.equal(sanitizeSettings({ language: "xx", tts: { provider: "nope" } }).language, "auto");
    assert.equal(sanitizeSettings({ tts: { provider: "nope" } }).tts.provider, "system");
    assert.equal(sanitizeSettings({ tts: { openai: { endpoint: "http://127.0.0.1:8000/v1/" } } }).tts.openai.endpoint, "http://127.0.0.1:8000/v1");
});

test("speed is clamped, and the old words-per-minute rate migrates", () => {
    assert.equal(sanitizeSettings({ speed: 3 }).speed, 1.6);
    assert.equal(sanitizeSettings({ speed: 0.1 }).speed, 0.7);
    assert.equal(sanitizeSettings({ rate: 222 }).speed, 1.2);
    assert.equal(sanitizeSettings({ rate: 222, speed: 1 }).speed, 1);
});

test("saveSettings merges nested patches", () => {
    saveSettings({ tts: { provider: "foundry", foundry: { endpoint: "https://res.cognitiveservices.azure.com" } } });
    saveSettings({ tts: { foundry: { voices: { it: "it-IT-Giulia" } } } });
    const settings = loadSettings();
    assert.equal(settings.tts.provider, "foundry");
    assert.equal(settings.tts.foundry.endpoint, "https://res.cognitiveservices.azure.com");
    assert.equal(settings.tts.foundry.voices.it, "it-IT-Giulia");
    assert.equal(settings.tts.foundry.voices.es, DEFAULT_SETTINGS.tts.foundry.voices.es);
    saveSettings({ tts: { foundry: { endpoint: "not a url" } } });
    assert.equal(loadSettings().tts.foundry.endpoint, "https://res.cognitiveservices.azure.com", "an invalid endpoint keeps the previous one");
});

test("speech settings live apart, so a first-version panel can't drop them", () => {
    saveSettings({ language: "de", speed: 1.2, speak: false, tts: { provider: "foundry", foundry: { model: "MAI-Voice-2.1-Flash" } } });
    const general = JSON.parse(readFileSync(join(DATA_DIR, "settings.json"), "utf8"));
    const speech = JSON.parse(readFileSync(join(DATA_DIR, "speech.json"), "utf8"));
    assert.deepEqual(Object.keys(speech).sort(), ["language", "speed", "tts"]);
    assert.equal("tts" in general, false);
    assert.equal(general.speak, false);
    // What a first-version panel writes when you toggle anything in it.
    writeFileSync(join(DATA_DIR, "settings.json"), JSON.stringify({ language: "auto", mode: "prompt", speak: true, voiceEs: "Mónica", voiceEn: "Samantha", rate: 185 }));
    const settings = loadSettings();
    assert.equal(settings.tts.provider, "foundry");
    assert.equal(settings.tts.foundry.model, "MAI-Voice-2.1-Flash");
    assert.equal(settings.language, "de");
    assert.equal(settings.speed, 1.2);
    assert.equal(settings.mode, "prompt");
    assert.equal(settings.speak, true);
});

test("older installs keep their speech settings from settings.json until the next save", () => {
    rmSync(join(DATA_DIR, "speech.json"));
    writeFileSync(join(DATA_DIR, "settings.json"), JSON.stringify({ language: "it", rate: 222, tts: { provider: "foundry", foundry: { endpoint: "https://res.cognitiveservices.azure.com" } } }));
    const settings = loadSettings();
    assert.equal(settings.language, "it");
    assert.equal(settings.speed, 1.2);
    assert.equal(settings.tts.foundry.endpoint, "https://res.cognitiveservices.azure.com");
    saveSettings({ sounds: false });
    assert.equal(JSON.parse(readFileSync(join(DATA_DIR, "speech.json"), "utf8")).tts.foundry.endpoint, "https://res.cognitiveservices.azure.com");
    assert.equal("rate" in JSON.parse(readFileSync(join(DATA_DIR, "settings.json"), "utf8")), false);
});

test("Mute all messages is a flag file that other saves can't reset by accident", () => {
    const flag = join(DATA_DIR, "muted");
    assert.equal(loadSettings().muted, false);
    assert.equal(saveSettings({ muted: true }).muted, true);
    assert.equal(existsSync(flag), true);
    assert.equal("muted" in JSON.parse(readFileSync(join(DATA_DIR, "settings.json"), "utf8")), false);
    // Saving anything else, or a panel rewriting settings.json on its own, keeps it muted.
    saveSettings({ sounds: true });
    writeFileSync(join(DATA_DIR, "settings.json"), JSON.stringify({ mode: "ask", speak: true, muted: false }));
    assert.equal(loadSettings().muted, true);
    assert.equal(saveSettings({ muted: false }).muted, false);
    assert.equal(existsSync(flag), false);
    assert.equal(saveSettings({ muted: "yes" }).muted, false);
});
