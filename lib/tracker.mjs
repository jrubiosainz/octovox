import { EventEmitter } from "node:events";
import { log } from "./log.mjs";
import { describePermission, summarizeTool } from "./text.mjs";

// Live session state built from its events; RPC queries fill in the rest.
export class SessionTracker extends EventEmitter {
    constructor(session) {
        super();
        this.session = session;
        this.tools = new Map();
        this.state = {
            name: null,
            intent: null,
            lastMessage: null,
            lastMessageAt: null,
            turnStartedAt: null,
            lastIdleAt: null,
            lastTurnMs: 0,
            pending: { input: null, plan: null, permission: null, elicitation: null },
            todos: null,
        };
        this.todosTimer = null;
        session.on((event) => {
            try {
                this.#onEvent(event);
            } catch (error) {
                log("warn", "unhandled event", error);
            }
        });
    }

    async init() {
        try {
            this.state.name = (await this.session.rpc.name.get())?.name ?? null;
        } catch (error) {
            log("warn", "name.get", error);
        }
        try {
            if ((await this.session.rpc.metadata.isProcessing())?.processing) this.state.turnStartedAt = Date.now();
        } catch {
            // Session without a local loop.
        }
        await this.#refreshTodos();
    }

    #onEvent(event) {
        const data = event.data ?? {};
        const root = !event.agentId;
        const pending = this.state.pending;
        switch (event.type) {
            case "user.message":
            case "assistant.turn_start":
                if (root && !this.state.turnStartedAt) this.state.turnStartedAt = Date.now();
                break;
            case "assistant.intent":
                this.state.intent = data.intent || null;
                break;
            case "tool.execution_start":
                this.tools.set(data.toolCallId, { tool: data.toolName ?? null, summary: summarizeTool(data.toolName, data.arguments), root, at: Date.now() });
                break;
            case "tool.execution_complete":
                this.tools.delete(data.toolCallId);
                break;
            case "assistant.message":
                if (root && typeof data.content === "string" && data.content.trim()) {
                    this.state.lastMessage = data.content;
                    this.state.lastMessageAt = Date.now();
                }
                break;
            case "session.idle": {
                const startedAt = this.state.turnStartedAt;
                this.state.turnStartedAt = null;
                this.state.lastIdleAt = Date.now();
                this.state.lastTurnMs = startedAt ? Date.now() - startedAt : 0;
                this.tools.clear();
                this.emit("idle", { busyMs: this.state.lastTurnMs, aborted: !!data.aborted });
                break;
            }
            case "user_input.requested":
                pending.input = {
                    requestId: data.requestId,
                    question: data.question,
                    choices: Array.isArray(data.choices) ? data.choices : [],
                    allowFreeform: data.allowFreeform !== false,
                    at: Date.now(),
                };
                break;
            case "user_input.completed":
                if (pending.input?.requestId === data.requestId) pending.input = null;
                break;
            case "exit_plan_mode.requested":
                pending.plan = { requestId: data.requestId, summary: data.summary ?? "", at: Date.now() };
                break;
            case "exit_plan_mode.completed":
                if (pending.plan?.requestId === data.requestId) pending.plan = null;
                break;
            case "permission.requested":
                if (!data.resolvedByHook) pending.permission = { requestId: data.requestId, text: describePermission(data.permissionRequest), at: Date.now() };
                break;
            case "permission.completed":
                if (pending.permission?.requestId === data.requestId) pending.permission = null;
                break;
            case "elicitation.requested":
                pending.elicitation = { requestId: data.requestId, message: data.message ?? "", at: Date.now() };
                break;
            case "elicitation.completed":
                if (pending.elicitation?.requestId === data.requestId) pending.elicitation = null;
                break;
            case "session.title_changed":
                this.state.name = data.title || this.state.name;
                this.emit("name", this.state.name);
                break;
            case "session.todos_changed":
                clearTimeout(this.todosTimer);
                this.todosTimer = setTimeout(() => this.#refreshTodos(), 300);
                return;
            default:
                return;
        }
        this.emit("change");
    }

    async #refreshTodos() {
        try {
            const rows = (await this.session.rpc.plan.readSqlTodos())?.rows ?? [];
            const current = rows.find((row) => row.status === "in_progress");
            this.state.todos = rows.length
                ? {
                      total: rows.length,
                      done: rows.filter((row) => row.status === "done").length,
                      blocked: rows.filter((row) => row.status === "blocked").length,
                      current: current?.title ?? null,
                  }
                : null;
            this.emit("change");
        } catch {
            this.state.todos = null;
        }
    }

    // Most recent root tool still running, or null.
    currentTool() {
        let latest = null;
        for (const tool of this.tools.values()) {
            if (tool.root && (!latest || tool.at > latest.at)) latest = tool;
        }
        return latest;
    }

    // Current activity: the latest root tool or, failing that, the declared intent.
    activity() {
        return this.currentTool()?.summary ?? this.state.intent ?? null;
    }

    async snapshot() {
        let processing = !!this.state.turnStartedAt;
        try {
            processing = !!(await this.session.rpc.metadata.isProcessing())?.processing;
        } catch {
            // Use the state derived from events.
        }
        if (processing && !this.state.turnStartedAt) this.state.turnStartedAt = Date.now();
        const now = Date.now();
        return {
            name: this.state.name,
            processing,
            busyForMs: processing && this.state.turnStartedAt ? now - this.state.turnStartedAt : 0,
            intent: this.state.intent,
            activity: processing ? this.activity() : null,
            activityTool: processing ? this.currentTool()?.tool ?? null : null,
            todos: this.state.todos,
            pending: structuredClone(this.state.pending),
            lastMessage: this.state.lastMessage ? this.state.lastMessage.slice(0, 1200) : null,
            lastMessageAt: this.state.lastMessageAt,
            lastIdleAt: this.state.lastIdleAt,
            lastTurnMs: this.state.lastTurnMs,
        };
    }
}
