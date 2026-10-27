import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";

export const SAMPLE_RATE = 16000;
const FRAME_SECONDS = 0.03;
const VOICE_FRAME_RMS = 0.006; // ~ -44 dBFS: louder frames count as voice
const REC_CANDIDATES = ["/opt/homebrew/bin/rec", "/usr/local/bin/rec"];

export function findRec() {
    return REC_CANDIDATES.find((path) => existsSync(path)) ?? null;
}

export function pcmToWav(pcm, sampleRate = SAMPLE_RATE) {
    const data = pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm;
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(36 + data.length, 4);
    header.write("WAVE", 8, "ascii");
    header.write("fmt ", 12, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

export function analyzePcm(pcm, sampleRate = SAMPLE_RATE) {
    const samples = Math.floor(pcm.length / 2);
    if (!samples) return { duration: 0, rms: 0, peak: 0, voicedSeconds: 0 };
    const frameSize = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
    let total = 0;
    let peak = 0;
    let frameSum = 0;
    let frameCount = 0;
    let voicedFrames = 0;
    for (let i = 0; i < samples; i++) {
        const value = pcm.readInt16LE(i * 2) / 32768;
        const energy = value * value;
        total += energy;
        frameSum += energy;
        if (Math.abs(value) > peak) peak = Math.abs(value);
        if (++frameCount === frameSize) {
            if (Math.sqrt(frameSum / frameCount) > VOICE_FRAME_RMS) voicedFrames += 1;
            frameSum = 0;
            frameCount = 0;
        }
    }
    return {
        duration: samples / sampleRate,
        rms: Math.sqrt(total / samples),
        peak,
        voicedSeconds: voicedFrames * (frameSize / sampleRate),
    };
}

export function hasSpeech(stats) {
    return stats.duration >= 0.3 && stats.voicedSeconds >= 0.2 && stats.peak >= 0.015;
}

function chunkLevel(chunk) {
    const samples = Math.floor(chunk.length / 2);
    if (!samples) return 0;
    let sum = 0;
    for (let i = 0; i < samples; i++) {
        const value = chunk.readInt16LE(i * 2) / 32768;
        sum += value * value;
    }
    // Log scale from -60 dBFS to 0 dBFS in [0, 1] for the level meter.
    const db = 20 * Math.log10(Math.sqrt(sum / samples) + 1e-9);
    return Math.max(0, Math.min(1, (db + 60) / 60));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Records the default microphone with SoX (`rec`) as 16 kHz mono PCM.
export class Recorder extends EventEmitter {
    constructor({ maxSeconds = 120 } = {}) {
        super();
        this.maxBytes = maxSeconds * SAMPLE_RATE * 2;
        this.take = null;
        this.lastLevelAt = 0;
    }

    get active() {
        return this.take !== null;
    }

    start() {
        if (this.take) throw new Error("Already recording");
        const rec = findRec();
        if (!rec) throw new Error("Can't find `rec` (SoX). Install it with: brew install sox");
        const proc = spawn(rec, ["-q", "--buffer", "2048", "-t", "raw", "-b", "16", "-e", "signed-integer", "-c", "1", "-r", String(SAMPLE_RATE), "-"], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        // Each take keeps its data until `rec` exits, even after a stop was requested.
        const take = { proc, chunks: [], bytes: 0, stderr: "", startedAt: Date.now() };
        proc.stderr.on("data", (data) => {
            take.stderr = (take.stderr + data).slice(-2000);
        });
        proc.stdout.on("data", (chunk) => {
            take.chunks.push(chunk);
            take.bytes += chunk.length;
            if (this.take !== take) return;
            const now = Date.now();
            if (now - this.lastLevelAt > 60) {
                this.lastLevelAt = now;
                this.emit("level", chunkLevel(chunk));
            }
            if (take.bytes >= this.maxBytes) this.emit("limit");
        });
        take.closed = new Promise((resolve) => {
            proc.on("close", (code, signal) => {
                if (this.take === take && signal === null) {
                    // `rec` exited on its own (microphone busy, no permission…).
                    this.take = null;
                    this.emit("failed", new Error(take.stderr.trim() || `rec exited with code ${code}`));
                }
                resolve();
            });
        });
        proc.on("error", (error) => {
            if (this.take === take) this.take = null;
            this.emit("failed", error);
        });
        this.take = take;
    }

    // Wait a little before cutting so the last word isn't lost.
    async stop({ tailMs = 300 } = {}) {
        const take = this.take;
        if (!take) return null;
        await sleep(tailMs);
        if (this.take !== take) return null;
        this.take = null;
        take.proc.kill("SIGTERM");
        const timer = setTimeout(() => take.proc.kill("SIGKILL"), 1500);
        await take.closed;
        clearTimeout(timer);
        return Buffer.concat(take.chunks);
    }

    cancel() {
        const take = this.take;
        this.take = null;
        if (take) take.proc.kill("SIGKILL");
    }
}
