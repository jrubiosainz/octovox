// A stand-in for GPT-Live and the audio device, for the demo and the tests: no network, no microphone
// and no sound. It "speaks" commentary as timed transcript deltas and simulates the voice levels.
import { EventEmitter } from "node:events";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeAudio extends EventEmitter {
    echoCancellation = true;
    inLevel = 0;
    outUntil = 0;
    muted = false;
    played = 0;

    start() {
        this.timer = setInterval(() => {
            const speaking = Date.now() < this.outUntil;
            this.emit("status", {
                queuedMs: 0,
                in: this.muted ? 0 : this.inLevel * (0.65 + Math.random() * 0.35),
                out: speaking ? 0.5 + Math.random() * 0.35 : 0,
            });
        }, 100);
        return this;
    }

    play(pcm) {
        this.played += pcm.length;
    }

    flush() {}

    mute(on) {
        this.muted = !!on;
    }

    close() {
        clearInterval(this.timer);
        this.emit("exit", { expected: true });
    }
}

class FakeSocket extends EventEmitter {
    open = true;
    bufferedAmount = 0;
    sent = [];

    constructor(audio, { speech, wordMs }) {
        super();
        this.audio = audio;
        this.speech = speech;
        this.wordMs = wordMs;
        this.t0 = Date.now();
        this.queue = Promise.resolve();
        this.closed = false;
    }

    now() {
        return Date.now() - this.t0;
    }

    push(event) {
        if (!this.closed) setImmediate(() => this.emit("message", JSON.stringify(event)));
    }

    send(text) {
        const event = JSON.parse(text);
        this.sent.push(event);
        const ack = (type) => {
            const at = this.now();
            this.push({ type, client_event_id: event.event_id, start_ms: at, end_ms: at + 200 });
        };
        switch (event.type) {
            case "session.start":
                setTimeout(() => this.push({ type: "session.started", session: { id: "live_demo", model: event.session.model, expires_at: Math.floor(Date.now() / 1000) + 3600 } }), 400);
                break;
            case "session.commentary.append":
                ack("session.commentary.appended");
                this.say(this.speech(event.content, event.delegation_id));
                break;
            case "session.thinking.append":
                ack("session.thinking.appended");
                break;
            case "session.instructions.append":
                ack("session.instructions.appended");
                break;
            case "session.input_audio.mute":
                this.push({ type: "session.input_audio.muted" });
                break;
            case "session.input_audio.unmute":
                this.push({ type: "session.input_audio.unmuted" });
                break;
            case "session.close":
                setTimeout(() => {
                    this.push({ type: "session.closed", reason: "close_requested", usage: { seconds: Math.round(this.now() / 100) / 10 } });
                    setTimeout(() => this.close(), 50);
                }, 200);
                break;
            default:
        }
    }

    async #words(role, text) {
        const type = role === "user" ? "session.input_transcript.delta" : "session.output_transcript.delta";
        const words = String(text).split(/\s+/).filter(Boolean);
        for (const [i, word] of words.entries()) {
            if (this.closed) return;
            if (role === "user") this.audio.inLevel = 0.75;
            else this.audio.outUntil = Date.now() + this.wordMs + 150;
            const start = this.now();
            this.push({ type, delta: `${i ? " " : ""}${word}`, start_ms: start, end_ms: start + this.wordMs });
            await sleep(this.wordMs);
        }
        if (role === "user") this.audio.inLevel = 0;
        await sleep(400);
    }

    // Speech is queued like a real voice: one sentence after another.
    say(text) {
        if (text) this.queue = this.queue.then(() => this.#words("assistant", text));
        return this.queue;
    }

    userSays(text) {
        this.queue = this.queue.then(() => this.#words("user", text));
        return this.queue;
    }

    delegate() {
        const id = `item_demo_${Math.random().toString(36).slice(2, 8)}`;
        this.push({ type: "session.delegation.created", offset_ms: this.now(), delegation: { id, type: "delegation", target: "client" } });
        return id;
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        this.open = false;
        this.audio.outUntil = 0;
        this.emit("close", { code: 1000, reason: "" });
    }

    terminate() {
        this.close();
    }
}

// Pass the returned dependencies to `new Interview({ hub, ...fake })`.
export function fakeLive({ speech = (content) => content, wordMs = 110 } = {}) {
    const audio = new FakeAudio();
    const fake = {
        audio,
        socket: null,
        connect: async () => {
            fake.socket = new FakeSocket(audio, { speech, wordMs });
            return fake.socket;
        },
        openAudio: async () => audio.start(),
        prepareAudio: async () => null,
        getToken: async () => "demo-token",
    };
    return fake;
}
