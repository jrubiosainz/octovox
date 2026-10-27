import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "octovox-speaker-"));
process.env.COPILOT_HOME = home;
const { playback, Speaker } = await import("../lib/tts.mjs");

after(() => rmSync(home, { recursive: true, force: true }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let log;
// Fake players: nothing reaches the speakers, but each "plays" for a moment.
function fakeProc(label, ms = 30) {
    const proc = new EventEmitter();
    proc.killed = false;
    proc.kill = () => {
        proc.killed = true;
        log.push(`kill ${label}`);
        setImmediate(() => proc.emit("close"));
    };
    setTimeout(() => {
        if (!proc.killed) {
            log.push(`end ${label}`);
            proc.emit("close");
        }
    }, ms);
    return proc;
}

beforeEach(() => {
    log = [];
    playback.audio = (audio) => {
        log.push(`play ${audio.toString()}`);
        return fakeProc(audio.toString());
    };
    playback.say = async (text, lang) => {
        log.push(`say[${lang}] ${text}`);
        return fakeProc(text);
    };
});

function cloudEngine({ fail = false, delay = 10 } = {}) {
    const synthesized = [];
    return {
        synthesized,
        engine: {
            kind: "cloud",
            label: "Fake voice",
            synthesize: async (text, signal) => {
                synthesized.push(text);
                log.push(`synth ${text}`);
                await sleep(delay);
                if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
                if (fail) throw new Error("HTTP 500.");
                return { audio: Buffer.from(text), format: "mp3", voice: "fake" };
            },
        },
    };
}

const until = async (check, ms = 2000) => {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > ms) throw new Error(`timed out; log: ${log.join(" | ")}`);
        await sleep(5);
    }
};

test("speaks sentence chunks in order and prefetches the next one", async () => {
    const { engine } = cloudEngine();
    const speaker = new Speaker({ engineFor: () => engine });
    const states = [];
    speaker.on("state", (speaking) => states.push(speaking));
    speaker.speak("First sentence is right here. Second sentence follows it. Third one ends it.", { lang: "en" });
    await until(() => states.at(-1) === false);
    const played = log.filter((line) => line.startsWith("play"));
    assert.deepEqual(played, ["play First sentence is right here.", "play Second sentence follows it. Third one ends it."]);
    assert.ok(log.indexOf("synth Second sentence follows it. Third one ends it.") < log.indexOf("end First sentence is right here."), "the second chunk is synthesized while the first plays");
    assert.equal(states[0], true);
});

test("streams: speech starts before the answer is complete", async () => {
    const { engine } = cloudEngine();
    const speaker = new Speaker({ engineFor: () => engine });
    const feed = speaker.stream({ lang: "es" });
    feed.push("Voy bien, estoy con los tests. ");
    await until(() => log.includes("play Voy bien, estoy con los tests."));
    feed.push("Luego abro el pull request.");
    feed.end();
    await until(() => log.includes("end Luego abro el pull request."));
});

test("falls back to the macOS voice and warns once when the cloud voice fails", async () => {
    const { engine } = cloudEngine({ fail: true });
    const speaker = new Speaker({ engineFor: () => engine });
    const warnings = [];
    speaker.on("warning", (message) => warnings.push(message));
    speaker.speak("Ciao, come va il lavoro oggi?", { lang: "it" });
    speaker.speak("Tutto bene, grazie mille davvero.", { lang: "it" });
    await until(() => log.filter((line) => line.startsWith("end")).length === 2);
    assert.deepEqual(log.filter((line) => line.startsWith("say")), ["say[it] Ciao, come va il lavoro oggi?", "say[it] Tutto bene, grazie mille davvero."]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^Fake voice: HTTP 500\. Using the macOS voice instead\.$/);
});

test("system engine and language detection when no language is given", async () => {
    const speaker = new Speaker({ engineFor: () => ({ kind: "system", label: "macOS voice" }), defaultLang: () => "en" });
    speaker.speak("Hola, ¿cómo vas con los tests de la API?");
    await until(() => log.some((line) => line.startsWith("end")));
    assert.equal(log[0], "say[es] Hola, ¿cómo vas con los tests de la API?");
});

test("stop() kills playback and drops the queue", async () => {
    const { engine } = cloudEngine();
    const speaker = new Speaker({ engineFor: () => engine });
    speaker.speak("This first sentence is long enough. And this second one should never be heard at all.", { lang: "en" });
    await until(() => log.includes("play This first sentence is long enough."));
    speaker.stop();
    await sleep(80);
    assert.ok(log.includes("kill This first sentence is long enough."));
    assert.ok(!log.some((line) => line.startsWith("play And this second")));
    assert.equal(speaker.speaking, false);
});

test("playPrepared plays already-synthesized audio", async () => {
    const { engine, synthesized } = cloudEngine();
    const speaker = new Speaker({ engineFor: () => engine });
    speaker.playPrepared({ text: "Sample", lang: "en", engine, result: { audio: Buffer.from("sample-audio"), format: "mp3" } });
    await until(() => log.includes("end sample-audio"));
    assert.equal(synthesized.length, 0);
});

test("stays silent while muted, and muting cuts playback mid-sentence", async () => {
    let muted = true;
    const { engine, synthesized } = cloudEngine();
    const speaker = new Speaker({ engineFor: () => engine, muted: () => muted });
    speaker.speak("This sentence must never reach the speakers.", { lang: "en" });
    speaker.stream({ lang: "en" }).push("Nor this streamed one, even when it is long enough. ");
    await sleep(80);
    assert.deepEqual(synthesized, [], "nothing is even synthesized while muted");
    assert.equal(log.filter((line) => line.startsWith("play")).length, 0);
    assert.equal(speaker.speaking, false);

    muted = false;
    playback.audio = (audio) => {
        log.push(`play ${audio.toString()}`);
        return fakeProc(audio.toString(), 3000);
    };
    speaker.speak("A long first sentence that keeps playing for a while. And a second one that must be dropped.", { lang: "en" });
    await until(() => log.includes("play A long first sentence that keeps playing for a while."));
    const mutedAt = Date.now();
    muted = true; // e.g. another session's panel created the flag file
    await until(() => log.includes("kill A long first sentence that keeps playing for a while."), 1500);
    assert.ok(Date.now() - mutedAt < 700, "stops within a fraction of a second");
    await sleep(60);
    assert.ok(!log.some((line) => line.startsWith("play And a second")));
    assert.equal(speaker.speaking, false);
});
