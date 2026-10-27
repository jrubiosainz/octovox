import { closeSync, openSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { analyzePcm, hasSpeech, pcmToWav, Recorder, SAMPLE_RATE } from "./audio.mjs";
import { findAz } from "./azure.mjs";
import { isMuted, loadSettings, MARKS_DIR, saveSettings } from "./config.mjs";
import { OPEN_EARCON_TRIM_MS, playEarcon } from "./earcons.mjs";
import { log } from "./log.mjs";
import { listPeers, peerFetch, peerJson, readNdjson } from "./peers.mjs";
import { deleteSecret, hasSecret, secretAccount, setSecret } from "./secrets.mjs";
import { sttHealth, transcribe, warmupStt } from "./stt.mjs";
import { CHECK_IN_QUESTION, clip, describeStatus, detectLanguage, firstSentences, isLanguage, LANGUAGE_CODES, sessionLabel, spoken } from "./text.mjs";
import { pickSystemVoice, Speaker } from "./tts.mjs";
import { foundrySynthesize, foundryVoiceList, openaiSynthesize, resolveFoundryVoice } from "./voices.mjs";

const POLL_MS = 2500;

// Deduplicated across processes: only the first panel that notices an event says it aloud.
function claimMark(key) {
    try {
        closeSync(openSync(join(MARKS_DIR, key.replace(/[^A-Za-z0-9._-]/g, "_")), "wx"));
        return true;
    } catch {
        return false;
    }
}

export function pruneMarks(maxAgeMs = 6 * 3600_000) {
    try {
        for (const name of readdirSync(MARKS_DIR)) {
            const file = join(MARKS_DIR, name);
            if (Date.now() - statSync(file).mtimeMs > maxAgeMs) unlinkSync(file);
        }
    } catch {
        // Empty or missing directory.
    }
}

const needsAttention = (peer) => Object.values(peer.pending ?? {}).some(Boolean);

// Runs this session's panel: microphone, voice, alerts and the other sessions that have Octovox.
export class Hub {
    constructor({ local }) {
        this.local = local;
        this.recorder = new Recorder();
        this.speaker = new Speaker({
            engineFor: (lang) => this.#engineFor(lang),
            speed: () => this.settings().speed,
            defaultLang: () => this.lang(),
            muted: isMuted,
        });
        this.clients = new Set();
        this.peers = [];
        this.previous = new Map();
        this.awaitingReply = new Set();
        this.deferred = [];
        this.pollTimer = null;
        this.startedAt = Date.now();
        this.lastLang = null;
        this.voiceUsedAt = 0;
        this.lastMuted = isMuted();
        this.stt = { state: "idle" };
        this.recorder.on("level", (value) => this.broadcast({ type: "level", value }));
        this.recorder.on("limit", () => this.broadcast({ type: "rec", state: "limit" }));
        this.recorder.on("failed", (error) => {
            log("warn", "recording failed", error);
            this.broadcast({ type: "rec", state: "idle", error: `Can't use the microphone: ${error.message}` });
            this.#flushDeferred();
        });
        this.speaker.on("state", (speaking) => this.broadcast({ type: "tts", speaking }));
        this.speaker.on("warning", (message) => this.broadcast({ type: "notice", tone: "warn", text: message }));
    }

    settings() {
        return loadSettings();
    }

    updateSettings(patch) {
        const settings = saveSettings(patch);
        if (settings.muted) this.#silence();
        this.lastMuted = settings.muted;
        this.broadcast({ type: "settings", settings });
        return settings;
    }

    // "Mute all messages": cut whatever is playing and drop speech waiting for the mic to close.
    #silence() {
        this.deferred = [];
        this.speaker.stop();
    }

    // Language to talk in: the chosen one, else the last one heard, else English.
    lang(hint) {
        if (isLanguage(hint)) return hint;
        const { language } = this.settings();
        return isLanguage(language) ? language : this.lastLang ?? "en";
    }

    // --- Server-sent events to the panel ---

    addClient(res) {
        this.clients.add(res);
        res.on("error", () => this.clients.delete(res));
        this.#send(res, { type: "settings", settings: this.settings() });
        this.#send(res, { type: "stt", ...this.stt });
        this.#send(res, { type: "tts", speaking: this.speaker.speaking });
        this.#send(res, { type: "rec", state: this.recorder.active ? "recording" : "idle" });
        if (this.peers.length) this.#send(res, { type: "peers", peers: this.peers });
        this.#startPolling();
        this.warmup();
        this.#warmVoice();
    }

    removeClient(res) {
        this.clients.delete(res);
        if (!this.clients.size && this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    broadcast(event) {
        for (const res of this.clients) this.#send(res, event);
    }

    #send(res, event) {
        try {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
            this.clients.delete(res);
        }
    }

    // --- Sessions ---

    async collectPeers() {
        const selfId = this.local.sessionId;
        const entries = listPeers().filter((entry) => entry.sessionId !== selfId);
        const others = await Promise.all(
            entries.map(async (entry) => {
                try {
                    return { ...(await peerJson(entry, "/peer/status", { timeoutMs: 2000 })), self: false, online: true };
                } catch (error) {
                    return { sessionId: entry.sessionId, name: entry.name, cwd: entry.cwd, self: false, online: false, error: error.message };
                }
            }),
        );
        const self = { ...(await this.local.status()), self: true, online: true };
        const rank = (peer) => (needsAttention(peer) ? 0 : peer.processing ? 1 : peer.online ? 2 : 3);
        others.sort((a, b) => rank(a) - rank(b) || sessionLabel(a).localeCompare(sessionLabel(b)));
        return [self, ...others];
    }

    #startPolling() {
        if (this.pollTimer) return;
        const tick = async () => {
            try {
                this.peers = await this.collectPeers();
                this.peersAt = Date.now();
                this.broadcast({ type: "peers", peers: this.peers });
                this.#syncMute();
                this.#detectTransitions(this.peers);
            } catch (error) {
                log("warn", "session poll", error);
            }
            this.pollTimer = this.clients.size ? setTimeout(tick, POLL_MS) : null;
        };
        this.pollTimer = setTimeout(tick, 0);
    }

    // Another session's panel may have muted or unmuted: keep this panel's button in step.
    #syncMute() {
        const muted = isMuted();
        if (muted === this.lastMuted) return;
        this.lastMuted = muted;
        if (muted) this.#silence();
        this.broadcast({ type: "settings", settings: this.settings() });
    }

    async freshPeers(maxAgeMs = 5000) {
        if (!this.peers.length || Date.now() - (this.peersAt ?? 0) > maxAgeMs) {
            this.peers = await this.collectPeers();
            this.peersAt = Date.now();
        }
        return this.peers;
    }

    // Live status of the other sessions, so this session can talk about them.
    async #othersSummary() {
        const peers = await this.freshPeers().catch(() => []);
        return peers
            .filter((peer) => !peer.self && peer.online)
            .map((peer) => {
                const last = !peer.processing && peer.lastMessage ? `; last message: ${firstSentences(peer.lastMessage, 1, 160)}` : "";
                return `${sessionLabel(peer)}: ${describeStatus(peer)}${last}`;
            });
    }

    #detectTransitions(peers) {
        const settings = this.settings();
        for (const peer of peers) {
            if (!peer.online) continue;
            const before = this.previous.get(peer.sessionId);
            const name = sessionLabel(peer);
            const { input, plan, permission, elicitation } = peer.pending ?? {};
            if (input && before?.pending?.input?.requestId !== input.requestId) {
                this.#announce(`input-${input.requestId}`, { kind: "input", name, question: clip(input.question, 240) }, settings, peer);
            }
            if (plan && before?.pending?.plan?.requestId !== plan.requestId) {
                this.#announce(`plan-${plan.requestId}`, { kind: "plan", name, summary: clip(plan.summary, 200) }, settings, peer);
            }
            if (permission && before?.pending?.permission?.requestId !== permission.requestId) {
                this.#announce(`perm-${permission.requestId}`, { kind: "permission", name, permission: permission.text }, settings, peer);
            }
            if (elicitation && before?.pending?.elicitation?.requestId !== elicitation.requestId) {
                this.#announce(`form-${elicitation.requestId}`, { kind: "form", name, message: clip(elicitation.message, 160) }, settings, peer);
            }
            const finished = peer.lastIdleAt && peer.lastIdleAt > (before?.lastIdleAt ?? this.startedAt);
            if (finished) {
                const awaited = this.awaitingReply.delete(peer.sessionId);
                if (awaited || peer.lastTurnMs >= settings.doneAfterSeconds * 1000) {
                    const summary = firstSentences(peer.lastMessage, awaited ? 3 : 1, awaited ? 450 : 220);
                    this.#announce(`idle-${peer.sessionId}-${peer.lastIdleAt}`, { kind: "done", name, summary }, settings, peer);
                }
            }
            this.previous.set(peer.sessionId, peer);
        }
    }

    // The panel renders its own English text; the spoken alert uses the language the user talks in.
    #announce(key, event, settings, peer) {
        this.broadcast({ type: "announce", ...event, sessionId: peer.sessionId, at: Date.now() });
        if (settings.muted || !settings.announce || !claimMark(key)) return;
        const lang = this.lang();
        const t = spoken(lang);
        const text =
            event.kind === "input"
                ? t.input(event.name, event.question)
                : event.kind === "plan"
                  ? t.plan(event.name)
                  : event.kind === "permission"
                    ? t.permission(event.name, event.permission)
                    : event.kind === "form"
                      ? t.form(event.name)
                      : t.done(event.name, event.summary);
        this.say(text, lang);
    }

    #entry(target) {
        const entry = listPeers().find((peer) => peer.sessionId === target);
        if (!entry) throw Object.assign(new Error("That session isn't available anymore (was it closed?)"), { status: 410 });
        return entry;
    }

    #isSelf(target) {
        return !target || target === this.local.sessionId;
    }

    // --- Voice ---

    // The voice to use for a language, given the current settings.
    #engineFor(lang) {
        const { tts, speed } = this.settings();
        if (tts.provider === "foundry" && tts.foundry.endpoint) {
            const cfg = tts.foundry;
            return this.#cloud(cfg.model === "neural" ? "Azure voice" : cfg.model, (text, signal) => foundrySynthesize({ text, lang, cfg, speed, signal }));
        }
        if (tts.provider === "openai" && tts.openai.endpoint) {
            const cfg = tts.openai;
            return this.#cloud(cfg.model, (text, signal) => openaiSynthesize({ text, cfg, speed, signal }));
        }
        return { kind: "system", label: "macOS voice" };
    }

    #cloud(label, synthesize) {
        return {
            kind: "cloud",
            label,
            synthesize: (text, signal) => {
                this.voiceUsedAt = Date.now();
                return synthesize(text, signal);
            },
        };
    }

    // After a pause, the first cloud request also pays for the sign-in token and a new connection
    // (~1.5 s). A tiny synthesis while the user is still talking hides that from the answer.
    #warmVoice() {
        if (isMuted() || Date.now() - this.voiceUsedAt < 20_000) return;
        const engine = this.#engineFor(this.lang());
        if (engine.kind !== "cloud") return;
        engine.synthesize("OK.", AbortSignal.timeout(20_000)).catch((error) => log("warn", "voice warm-up", error.message));
    }

    // Returns false when nothing will be said because all messages are muted.
    async say(text, langHint) {
        if (!text || isMuted()) return false;
        const lang = isLanguage(langHint) ? langHint : detectLanguage(text, { fallback: this.lang() });
        if (this.recorder.active) {
            this.deferred.push([text, lang]);
            return true;
        }
        this.speaker.speak(text, { lang });
        return true;
    }

    #flushDeferred() {
        const pending = this.deferred.splice(0);
        for (const [text, lang] of pending) this.say(text, lang);
    }

    stopSpeaking() {
        this.speaker.stop();
    }

    // Says a sample sentence with the current voice and reports how long the first audio took.
    async testVoice(langHint) {
        if (isMuted()) throw Object.assign(new Error("Messages are muted. Turn off “Mute all messages” to test the voice."), { status: 409 });
        const lang = this.lang(langHint);
        const text = spoken(lang).test;
        const engine = this.#engineFor(lang);
        this.speaker.stop();
        if (engine.kind !== "cloud") {
            const voice = await pickSystemVoice(lang);
            this.speaker.speak(text, { lang });
            return { ok: true, provider: "system", voice: voice ?? "default", lang };
        }
        const started = Date.now();
        const result = await engine.synthesize(text, AbortSignal.timeout(25_000));
        const ms = Date.now() - started;
        this.speaker.playPrepared({ text, lang, result, engine });
        return { ok: true, provider: this.settings().tts.provider, voice: result.voice, ms, lang };
    }

    // Voices the configured Foundry endpoint offers for the chosen model, grouped by language.
    async voices({ refresh = false } = {}) {
        const { tts } = this.settings();
        if (tts.provider !== "foundry" || !tts.foundry.endpoint) return { model: tts.foundry.model, languages: {} };
        const cfg = tts.foundry;
        const list = await foundryVoiceList(cfg, { refresh });
        const languages = {};
        for (const code of LANGUAGE_CODES) {
            const voices = list
                .filter((voice) => voice.lang === code && voice.model === cfg.model)
                .sort((a, b) => a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name))
                .map(({ id, name, locale, gender }) => ({ id, name, locale, gender }));
            languages[code] = { voices, selected: resolveFoundryVoice(cfg, code, voices).id };
        }
        return { model: cfg.model, languages };
    }

    async voiceStatus() {
        const { tts } = this.settings();
        const [foundryKey, openaiKey] = await Promise.all([
            tts.foundry.endpoint ? hasSecret(secretAccount("foundry", tts.foundry.endpoint)) : false,
            tts.openai.endpoint ? hasSecret(secretAccount("openai", tts.openai.endpoint)) : false,
        ]);
        return { azureCli: !!findAz(), keys: { foundry: foundryKey, openai: openaiKey } };
    }

    async saveKey(provider, key) {
        const { tts } = this.settings();
        const endpoint = tts[provider]?.endpoint;
        if (!endpoint) throw Object.assign(new Error("Set the endpoint first"), { status: 400 });
        if (key) await setSecret(secretAccount(provider, endpoint), key);
        else await deleteSecret(secretAccount(provider, endpoint));
        return this.voiceStatus();
    }

    warmup() {
        if (this.warming) return;
        this.stt = { state: "loading" };
        this.broadcast({ type: "stt", ...this.stt });
        this.warming = warmupStt()
            .then(() => {
                this.stt = { state: "ready" };
            })
            .catch((error) => {
                log("warn", "speech recognition unavailable", error);
                this.stt = { state: "error", error: error.message };
            })
            .finally(() => {
                this.warming = null;
                this.broadcast({ type: "stt", ...this.stt });
            });
    }

    // --- Push to talk ---

    recStart() {
        this.speaker.stop();
        this.recorder.start();
        this.#warmVoice();
        const settings = this.settings();
        // The opening chime lands at the start of the recording: it's trimmed when the recording stops.
        this.trimMs = settings.sounds && !settings.muted && playEarcon("open") ? OPEN_EARCON_TRIM_MS : 0;
        this.broadcast({ type: "rec", state: "recording" });
        sttHealth().then((health) => {
            if (!health) this.warmup();
        });
    }

    recCancel() {
        this.recorder.cancel();
        this.broadcast({ type: "rec", state: "idle" });
        this.#flushDeferred();
    }

    async recStop() {
        const raw = await this.recorder.stop();
        if (!raw) {
            this.broadcast({ type: "rec", state: "idle" });
            this.#flushDeferred();
            return { empty: true, reason: "not-recording" };
        }
        const settings = this.settings();
        const sounds = settings.sounds && !settings.muted;
        const pcm = raw.subarray(Math.min(raw.length, Math.round(((this.trimMs ?? 0) * SAMPLE_RATE) / 1000) * 2));
        const stats = analyzePcm(pcm);
        if (!hasSpeech(stats)) {
            if (sounds) playEarcon("failed");
            this.broadcast({ type: "rec", state: "idle" });
            this.#flushDeferred();
            return { empty: true, reason: "silence", seconds: stats.duration };
        }
        this.broadcast({ type: "rec", state: "transcribing" });
        try {
            const result = await transcribe(pcmToWav(pcm), settings.language);
            if (isLanguage(result.language)) this.lastLang = result.language;
            const text = String(result.text ?? "").trim();
            if (sounds) playEarcon(text ? "done" : "failed");
            if (!text) return { empty: true, reason: "no-text", seconds: stats.duration };
            return { text, language: result.language, seconds: stats.duration, sttMs: result.elapsed_ms };
        } catch (error) {
            if (sounds) playEarcon("failed");
            throw error;
        } finally {
            this.broadcast({ type: "rec", state: "idle" });
            this.#flushDeferred();
        }
    }

    // --- Talking to sessions ---

    // Language for the answer: the chosen one, or the one the question was asked in.
    #replyLang(question, hint) {
        const { language } = this.settings();
        if (isLanguage(language)) return language;
        if (isLanguage(hint)) return hint;
        return detectLanguage(question);
    }

    async ask({ target, question, via = "text", lang: hint = null, onChunk, speak = true }) {
        const lang = this.#replyLang(question, hint);
        if (lang) this.lastLang = lang;
        const settings = this.settings();
        const voice = speak && settings.speak && !settings.muted ? this.speaker.stream({ lang }) : null;
        const relay = (chunk) => {
            onChunk?.(chunk);
            voice?.push(chunk);
        };
        try {
            const answer = this.#isSelf(target)
                ? await this.local.ask(question, { lang, via, onChunk: relay, others: await this.#othersSummary() })
                : await this.#remoteAsk(target, question, { lang, via, onChunk: relay });
            voice?.end();
            return { answer, lang };
        } catch (error) {
            voice?.cancel();
            throw error;
        }
    }

    async #remoteAsk(target, question, { lang, via, onChunk }) {
        const response = await peerFetch(this.#entry(target), "/peer/ask", {
            method: "POST",
            body: { question, lang, via },
            timeoutMs: 180_000,
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || `HTTP ${response.status}`);
        }
        let answer = "";
        let failure = null;
        await readNdjson(response, (item) => {
            if (item.type === "chunk") onChunk?.(item.text);
            else if (item.type === "done") answer = item.answer;
            else if (item.type === "error") failure = item.error;
        });
        if (failure) throw new Error(failure);
        return answer;
    }

    async send({ target, text, dictated = false, mode }) {
        const settings = this.settings();
        const sendMode = mode === "immediate" || mode === "enqueue" ? mode : settings.sendMode;
        const result = this.#isSelf(target)
            ? await this.local.send(text, { dictated, mode: sendMode })
            : await peerJson(this.#entry(target), "/peer/send", {
                  method: "POST",
                  body: { text, dictated, mode: sendMode },
                  timeoutMs: 15_000,
              });
        this.awaitingReply.add(this.#isSelf(target) ? this.local.sessionId : target);
        return { ...result, mode: sendMode };
    }

    async answer({ target, requestId, text, via = "text" }) {
        return this.#isSelf(target)
            ? this.local.answer(requestId, text, { via })
            : peerJson(this.#entry(target), "/peer/answer", {
                  method: "POST",
                  body: { requestId, text, via },
                  timeoutMs: 15_000,
              });
    }

    async history(target, limit = 40) {
        if (this.#isSelf(target)) return this.local.history(limit);
        return (await peerJson(this.#entry(target), `/peer/history?limit=${limit}`, { timeoutMs: 4000 })).items ?? [];
    }

    // Asks every busy session at once and reads the answers out as they arrive.
    async checkIn({ onItem }) {
        const lang = this.lang();
        const settings = this.settings();
        const speak = settings.speak && !settings.muted;
        this.peers = await this.collectPeers();
        this.peersAt = Date.now();
        const active = this.peers.filter((peer) => peer.online && (peer.processing || needsAttention(peer)));
        if (!active.length) {
            onItem({ type: "empty" });
            if (speak) this.say(spoken(lang).idle, lang);
            return;
        }
        onItem({
            type: "start",
            count: active.length,
            sessions: active.map((peer) => ({ sessionId: peer.sessionId, name: sessionLabel(peer), self: !!peer.self })),
        });
        await Promise.all(
            active.map(async (peer) => {
                const name = sessionLabel(peer);
                try {
                    const answer = peer.self
                        ? await this.local.ask(CHECK_IN_QUESTION, { lang, via: "check-in" })
                        : await this.#remoteAsk(peer.sessionId, CHECK_IN_QUESTION, { lang, via: "check-in" });
                    onItem({ type: "peer", sessionId: peer.sessionId, name, answer });
                    if (speak) this.say(`${name}: ${answer}`, lang);
                } catch (error) {
                    onItem({ type: "peer", sessionId: peer.sessionId, name, error: error.message });
                }
            }),
        );
    }

    shutdown() {
        this.recorder.cancel();
        this.speaker.stop();
        if (this.pollTimer) clearTimeout(this.pollTimer);
        for (const res of this.clients) {
            try {
                res.end();
            } catch {
                // Client already closed.
            }
        }
        this.clients.clear();
    }
}

