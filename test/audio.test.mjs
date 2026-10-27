import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzePcm, hasSpeech, pcmToWav, SAMPLE_RATE } from "../lib/audio.mjs";

function tone(seconds, amplitude, freq = 220) {
    const samples = Math.round(seconds * SAMPLE_RATE);
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * amplitude * 32767), i * 2);
    }
    return pcm;
}

test("pcmToWav writes a 16-bit mono PCM RIFF header", () => {
    const pcm = tone(0.5, 0.2);
    const wav = pcmToWav(pcm);
    assert.equal(wav.length, pcm.length + 44);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), SAMPLE_RATE);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), pcm.length);
});

test("pcmToWav drops a stray byte", () => {
    assert.equal(pcmToWav(Buffer.alloc(11)).readUInt32LE(40), 10);
});

test("hasSpeech tells speech from silence and from a click", () => {
    assert.equal(hasSpeech(analyzePcm(tone(1.2, 0.25))), true);
    assert.equal(hasSpeech(analyzePcm(tone(1.2, 0.001))), false);
    assert.equal(hasSpeech(analyzePcm(tone(0.1, 0.5))), false);
    assert.equal(hasSpeech(analyzePcm(Buffer.alloc(0))), false);
});
