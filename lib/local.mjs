import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { EXT_NAME } from "./config.mjs";
import { log } from "./log.mjs";
import { describeStatus, DICTATED_NOTE, frameQuestion, isLanguage, matchChoice } from "./text.mjs";

const userError = (status, message) => Object.assign(new Error(message), { status });

function withTimeout(promise, ms, message) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

// Operations on the session this extension process belongs to.
export class LocalSession {
    constructor(session, tracker) {
        this.session = session;
        this.tracker = tracker;
        this.sessionId = session.sessionId;
        this.cwd = process.cwd();
        this.kind = this.cwd.includes(`${sep}.copilot${sep}chats${sep}`) ? "chat" : "project";
        this.historyFile = session.workspacePath ? join(session.workspacePath, EXT_NAME, "history.jsonl") : null;
        this.memory = [];
        this.askChain = Promise.resolve();
        this.login = null; // GitHub login, for the panel avatar
    }

    async status() {
        return { sessionId: this.sessionId, cwd: this.cwd, kind: this.kind, ...(await this.tracker.snapshot()) };
    }

    // Ephemeral side question: no tools, doesn't interrupt and isn't added to the session history.
    ask(question, options = {}) {
        const run = this.askChain.then(() => this.#ask(question, options));
        this.askChain = run.catch(() => {});
        return run;
    }

    async #ask(question, { lang = null, onChunk, via = "text", others = [] }) {
        const text = String(question ?? "").trim();
        if (!text) throw userError(400, "Empty question");
        if (!isLanguage(lang)) lang = null;
        const status = describeStatus(await this.status());
        const history = (await this.history(20)).filter((item) => item.kind === "ask");
        const prompt = frameQuestion({ question: text, lang, status, history, others });
        let requestId = null;
        let streamed = "";
        const off = this.session.on("ui.ephemeral_query", (event) => {
            const data = event.data ?? {};
            if (!requestId) {
                if (data.phase !== "started" && data.phase !== "chunk") return;
                requestId = data.requestId;
            }
            if (data.requestId !== requestId || data.phase !== "chunk" || !data.chunk) return;
            streamed += data.chunk;
            try {
                onChunk?.(data.chunk);
            } catch (error) {
                log("warn", "onChunk", error);
            }
        });
        const started = Date.now();
        try {
            const result = await withTimeout(
                this.session.rpc.ui.ephemeralQuery({ question: prompt }),
                150_000,
                "The session took too long to answer",
            );
            const answer = String(result?.answer ?? streamed).trim();
            await this.record({ kind: "ask", q: text, a: answer, lang, via, ms: Date.now() - started });
            return answer;
        } finally {
            off();
        }
    }

    async send(text, { dictated = false, mode = "enqueue", lang = null } = {}) {
        const clean = String(text ?? "").trim();
        if (!clean) throw userError(400, "Empty message");
        const prompt = dictated ? `${clean}\n\n${DICTATED_NOTE}` : clean;
        const messageId = await this.session.send({
            prompt,
            displayPrompt: clean,
            mode: mode === "immediate" ? "immediate" : "enqueue",
        });
        await this.record({ kind: "prompt", q: clean, lang, via: dictated ? "voice" : "text", mode });
        return { messageId };
    }

    async answer(requestId, text, { via = "text" } = {}) {
        const pending = this.tracker.state.pending.input;
        if (!pending || pending.requestId !== requestId) throw userError(409, "That question is no longer pending");
        const clean = String(text ?? "").trim();
        if (!clean) throw userError(400, "Empty answer");
        const choice = matchChoice(clean, pending.choices);
        if (!choice && !pending.allowFreeform) throw userError(400, `Pick one of the options: ${pending.choices.join(" · ")}`);
        const response = choice ? { answer: choice, wasFreeform: false } : { answer: clean, wasFreeform: true };
        const result = await this.session.rpc.ui.handlePendingUserInput({ requestId, response });
        if (result?.success === false) throw userError(409, "The app had already resolved that question");
        await this.record({ kind: "answer", q: pending.question, a: response.answer, via });
        return response;
    }

    async record(entry) {
        const item = { at: new Date().toISOString(), ...entry };
        this.memory.push(item);
        if (this.memory.length > 200) this.memory.shift();
        if (!this.historyFile) return;
        try {
            await mkdir(dirname(this.historyFile), { recursive: true });
            await appendFile(this.historyFile, `${JSON.stringify(item)}\n`);
        } catch (error) {
            log("warn", "couldn't save the history", error);
        }
    }

    async history(limit = 50) {
        if (!this.historyFile) return this.memory.slice(-limit);
        let raw;
        try {
            raw = await readFile(this.historyFile, "utf8");
        } catch {
            return this.memory.slice(-limit);
        }
        const items = [];
        for (const line of raw.trim().split("\n").slice(-limit)) {
            try {
                items.push(JSON.parse(line));
            } catch {
                // Damaged line: skipped.
            }
        }
        return items;
    }
}
