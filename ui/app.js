const params = new URLSearchParams(location.search);
const token = params.get("t") ?? "";
const SVG_NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

const el = {
    picker: $("picker"),
    pickerState: $("picker-state"),
    pickerLabel: $("picker-label"),
    pickerPanel: $("picker-panel"),
    pickerList: $("picker-list"),
    openSettings: $("open-settings"),
    settings: $("settings"),
    closeSettings: $("close-settings"),
    language: document.querySelector('#settings select[name="language"]'),
    speedValue: $("speed-value"),
    voiceGrid: $("voice-grid"),
    voicesStatus: $("voices-status"),
    refreshVoices: $("refresh-voices"),
    testVoice: $("test-voice"),
    testStatus: $("test-status"),
    stIcon: $("st-icon"),
    stLabel: $("st-label"),
    stTime: $("st-time"),
    stStep: $("st-step"),
    stStepIcon: $("st-step-icon"),
    stStepText: $("st-step-text"),
    stTasks: $("st-tasks"),
    stBar: $("st-bar"),
    stTasksText: $("st-tasks-text"),
    pending: $("pending"),
    pdWho: $("pd-who"),
    pdQuestion: $("pd-question"),
    pdChoices: $("pd-choices"),
    log: $("log"),
    flash: $("flash"),
    flashIcon: $("flash-icon"),
    flashText: $("flash-text"),
    modes: [...document.querySelectorAll(".seg")],
    checkIn: $("check-in"),
    ptt: $("ptt"),
    bars: [...document.querySelectorAll(".bars i")],
    hush: $("hush"),
    hint: $("hint"),
    compose: $("compose"),
    text: $("text"),
    send: $("send"),
};

const HOLD_MS = 350; // a shorter press keeps the mic open until the next tap
const MODE_HINTS = {
    ask: "Hold and ask. It won't interrupt the session.",
    prompt: "Hold and dictate a prompt for the session.",
    answer: "Hold and say your answer.",
};
const SEND_LABELS = { ask: "Ask", prompt: "Send prompt", answer: "Reply" };
const STARTERS = ["How's it going?", "What have you found so far?", "Do you need anything from me?"];
const TOOL_ICONS = [
    [/^(bash|shell|powershell|read_bash|write_bash|stop_bash)$/, "terminal-16"],
    [/^(view|read|glob|ls)$/, "file-16"],
    [/(grep|search|find|query)/, "search-16"],
    [/^(edit|create|apply_patch|write|str_replace)/, "pencil-16"],
    [/(fetch|web|http|browser|navigate)/, "globe-16"],
    [/^(task|read_agent|write_agent|list_agents|create_session|send_session_message)$/, "agent-16"],
    [/^(sql|todo)/, "tasklist-16"],
];
const EVENT_STYLES = {
    sent: ["paper-airplane-16", ""],
    answered: ["reply-16", ""],
    done: ["check-circle-fill-16", "success"],
    input: ["bell-fill-16", "attention"],
    plan: ["bell-fill-16", "attention"],
    permission: ["bell-fill-16", "attention"],
    form: ["bell-fill-16", "attention"],
    error: ["x-circle-fill-16", "danger"],
    info: ["info-16", ""],
};
// Each bar moves at its own pace so the wave reads as a voice, not a level meter.
const BAR_SPEED = [5.1, 6.3, 4.4, 7.0, 5.6, 4.8, 6.6, 5.2];
const BAR_PHASE = [0, 1.7, 0.6, 2.4, 1.1, 2.9, 0.3, 2.0];

const state = {
    selfId: null,
    user: null,
    target: params.get("target") || null,
    peers: [],
    settings: null,
    languages: [],
    voiceStatus: null,
    voiceList: null, // { key, data, error } for the Foundry endpoint and model in use
    voiceLoading: false,
    gridSig: "",
    mode: "ask",
    resumeMode: null,
    pendingRequestId: null,
    rec: "idle", // idle | starting | recording | transcribing
    pressAt: 0,
    latched: false,
    stopWhenReady: false,
    busy: 0,
    checkInBusy: false,
    speaking: false,
    stt: { state: "idle" },
    connected: false,
    composerDictated: false,
    pickerSig: "",
    avatarFailed: false,
};

// --- Theme: light or dark from the background the app really paints ---

const probe = document.createElement("canvas").getContext("2d");

function luminance(color) {
    probe.fillStyle = "#010203";
    probe.fillStyle = color;
    const value = probe.fillStyle;
    let rgb;
    if (value.startsWith("#")) rgb = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
    else rgb = (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    if (rgb.length !== 3 || (value === "#010203" && color.trim().toLowerCase() !== "#010203")) return null;
    const [r, g, b] = rgb.map((c) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function detectTone() {
    const root = document.documentElement;
    let dark = null;
    const hostBg = getComputedStyle(root).getPropertyValue("--background-color-default").trim();
    if (hostBg) {
        const lum = luminance(hostBg);
        if (lum !== null) dark = lum < 0.4;
    }
    if (dark === null) {
        const attr = ["data-theme-tone", "data-color-mode"]
            .map((name) => root.getAttribute(name) || document.body.getAttribute(name))
            .find((value) => value === "dark" || value === "light");
        if (attr) dark = attr === "dark";
    }
    if (dark === null) dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const tone = dark ? "dark" : "light";
    if (root.dataset.tone !== tone) root.dataset.tone = tone;
}

function watchTheme() {
    detectTone();
    const observer = new MutationObserver(detectTone);
    const attributeFilter = ["data-color-mode", "data-theme-tone", "data-dark-theme", "data-light-theme", "style", "class"];
    observer.observe(document.documentElement, { attributes: true, attributeFilter });
    observer.observe(document.body, { attributes: true, attributeFilter });
    observer.observe(document.head, { childList: true });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", detectTone);
}

// --- Network ---

async function api(path, body) {
    const post = body !== undefined;
    const response = await fetch(path, {
        method: post ? "POST" : "GET",
        headers: { "X-Octovox-Token": token, ...(post ? { "Content-Type": "application/json" } : {}) },
        body: post ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
}

async function stream(path, body, onItem) {
    const response = await fetch(path, {
        method: "POST",
        headers: { "X-Octovox-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) onItem(JSON.parse(line));
        }
    }
    if (buffer.trim()) onItem(JSON.parse(buffer));
}

// --- Formatting ---

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const label = (peer) =>
    peer?.name || String(peer?.cwd ?? "").split("/").filter(Boolean).pop() || String(peer?.sessionId ?? "").slice(0, 8) || "Session";
const currentPeer = () => state.peers.find((peer) => peer.sessionId === state.target) ?? null;
const targetName = () => {
    const peer = currentPeer();
    return !peer || peer.self ? "this session" : label(peer);
};
const languageName = (code) => state.languages.find((item) => item.code === code)?.native ?? null;

function fmtRun(ms) {
    const seconds = Math.max(0, Math.round((ms ?? 0) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function fmtAgo(timestamp) {
    const diff = (timestamp - Date.now()) / 1000;
    const abs = Math.abs(diff);
    if (abs < 45) return "just now";
    if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
    if (abs < 86_400) return rtf.format(Math.round(diff / 3600), "hour");
    return rtf.format(Math.round(diff / 86_400), "day");
}

function oneLine(text, max = 160) {
    const flat = String(text ?? "")
        .replace(/[#*_`>|]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function toolIcon(tool) {
    if (!tool) return "sparkle-fill-16";
    return TOOL_ICONS.find(([pattern]) => pattern.test(tool))?.[1] ?? "tools-16";
}

// --- Building blocks ---

function icon(name, className = "oi") {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", `#${name.startsWith("ov-") ? name : `oi-${name}`}`);
    svg.append(use);
    return svg;
}

function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function option(value, text) {
    const node = make("option", "", text);
    node.value = value;
    return node;
}

// A one-line status with an icon (or a spinner) under a settings field.
function setNote(node, text, { tone = "", icon: iconName = null, spin = false, extra = null } = {}) {
    node.className = `note${tone ? ` ${tone}` : ""}`;
    if (!text) {
        node.replaceChildren();
        node.hidden = true;
        return;
    }
    node.hidden = false;
    const parts = [spin ? make("span", "spin") : iconName ? icon(iconName) : null, make("span", "", text), extra].filter(Boolean);
    node.replaceChildren(...parts);
}

function sessionState(peer) {
    if (!peer) return { key: "unknown", tone: "", icon: "circle-16", label: state.connected ? "Looking for the session…" : "Connecting…" };
    if (peer.online === false) return { key: "off", tone: "", icon: "circle-slash-16", label: "Offline" };
    const pending = peer.pending ?? {};
    if (pending.input) return { key: "attention", tone: "attention", icon: "bell-fill-16", label: "Needs you" };
    if (pending.plan) return { key: "attention", tone: "attention", icon: "bell-fill-16", label: "Waiting for plan approval" };
    if (pending.permission) return { key: "attention", tone: "attention", icon: "bell-fill-16", label: "Asking for permission" };
    if (pending.elicitation) return { key: "attention", tone: "attention", icon: "bell-fill-16", label: "Waiting for a form" };
    if (peer.processing) return { key: "working", tone: "", icon: null, label: "Working" };
    if (peer.lastIdleAt) return { key: "done", tone: "done", icon: "check-circle-fill-16", label: "Finished" };
    return { key: "idle", tone: "", icon: "circle-16", label: "Idle" };
}

function paintState(container, st) {
    container.className = `state${st.tone ? ` ${st.tone}` : ""}`;
    container.replaceChildren(st.key === "working" ? make("span", "spin") : icon(st.icon));
}

function sessionDesc(peer) {
    const st = sessionState(peer);
    const pending = peer.pending ?? {};
    if (st.key === "off") return "Offline";
    if (pending.input) return `Asks: ${oneLine(pending.input.question, 90)}`;
    if (pending.plan) return "Waiting for you to approve its plan in the app";
    if (pending.permission) return `Needs your permission for: ${pending.permission.text}`;
    if (pending.elicitation) return "Waiting for you to fill in a form in the app";
    if (st.key === "working") return `${fmtRun(peer.busyForMs)} · ${oneLine(peer.activity || peer.intent || "working", 80)}`;
    if (st.key === "done") return `Finished ${fmtAgo(peer.lastIdleAt)}`;
    return "Idle";
}

function timeEl(timestamp) {
    const node = make("time");
    node.dataset.ts = String(timestamp);
    node.dateTime = new Date(timestamp).toISOString();
    node.title = new Date(timestamp).toLocaleString();
    node.textContent = fmtAgo(timestamp);
    return node;
}

function refreshTimes() {
    for (const node of document.querySelectorAll("time[data-ts]")) node.textContent = fmtAgo(Number(node.dataset.ts));
}

function avatar(who) {
    if (who === "me") {
        const node = make("span", "avatar");
        if (state.user?.login && !state.avatarFailed) {
            const img = new Image();
            img.alt = "";
            img.decoding = "async";
            img.src = "avatar.png";
            img.addEventListener("error", () => {
                state.avatarFailed = true;
                img.replaceWith(icon("person-16"));
            });
            node.append(img);
        } else {
            node.append(icon("person-16"));
        }
        return node;
    }
    const node = make("span", who === "brand" ? "avatar brand" : "avatar bot");
    node.title = who === "brand" ? "Octovox" : "GitHub Copilot";
    node.append(icon(who === "brand" ? "ov-mark" : "copilot-16"));
    return node;
}

// --- Conversation ---

function nearBottom() {
    return el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 80;
}

function append(node) {
    const stick = nearBottom();
    el.log.querySelector(".blankslate")?.remove();
    el.log.append(node);
    if (stick) el.log.scrollTop = el.log.scrollHeight;
    return node;
}

function replayButton(node) {
    const button = make("button", "btn-icon");
    button.type = "button";
    button.title = "Play again";
    button.setAttribute("aria-label", "Play again");
    button.append(icon("unmute-16"));
    button.addEventListener("click", () => {
        if (node.dataset.text) api("/api/tts/speak", { text: node.dataset.text }).catch((error) => flash(error.message, "error"));
    });
    return button;
}

function message({ who, text = "", tag, meta, ts = Date.now(), replay = false, thinking = false }) {
    const node = make("article", `msg${who === "me" ? " mine" : ""}`);
    const head = make("div", "msg-head");
    head.append(make("span", "author", who === "me" ? state.user?.login || "You" : who === "brand" ? "Octovox" : "Copilot"));
    if (tag) head.append(make("span", "label", tag));
    if (meta) head.append(make("span", "", meta));
    head.append(make("span", "", "·"), timeEl(ts));
    if (replay) head.append(replayButton(node));
    const body = make("div", "msg-body");
    if (thinking) {
        const wait = make("span", "thinking");
        wait.append(make("span", "spin"), make("span", "", `Asking ${targetName()}…`));
        body.append(wait);
    } else {
        body.textContent = text;
    }
    node.append(avatar(who), head, body);
    node.dataset.text = thinking ? "" : text;
    return append(node);
}

function updateMessage(node, text, { error = false } = {}) {
    const stick = nearBottom();
    node.querySelector(".msg-body").textContent = text;
    node.dataset.text = error ? "" : text;
    node.classList.toggle("error", error);
    if (stick) el.log.scrollTop = el.log.scrollHeight;
}

function addEvent(kind, content, ts = Date.now()) {
    const [iconName, tone] = EVENT_STYLES[kind] ?? EVENT_STYLES.info;
    const node = make("div", "event");
    const badge = make("span", `badge${tone ? ` ${tone}` : ""}`);
    badge.append(icon(iconName));
    const text = make("div", "event-text");
    if (typeof content === "string") text.append(content);
    else text.append(...content);
    text.append(" · ", timeEl(ts));
    node.append(badge, text);
    return append(node);
}

// Alerts arrive as data; the panel words them in English (the spoken version follows your language).
function announcement(event) {
    const who = make("strong", "", event.name || "A session");
    switch (event.kind) {
        case "input":
            return [who, " is asking you: ", `“${oneLine(event.question, 220)}”`];
        case "plan":
            return [who, " is waiting for you to approve its plan", event.summary ? `: ${oneLine(event.summary, 180)}` : "", "."];
        case "permission":
            return [who, " needs your permission for ", make("em", "", event.permission || "an action"), ". Approve it in the app."];
        case "form":
            return [who, " needs you to fill in a form", event.message ? `: ${oneLine(event.message, 160)}` : "", "."];
        case "done":
            return [who, " finished", event.summary ? `: ${oneLine(event.summary, 240)}` : "."];
        default:
            return event.text ?? "";
    }
}

function showBlankslate() {
    const box = make("div", "blankslate");
    const mark = make("span", "blankslate-icon");
    mark.append(icon("ov-mark"));
    const peer = currentPeer();
    const title = make("h2", "", peer && !peer.self ? `Talk to ${label(peer)}` : "Talk to Copilot");
    const intro = make(
        "p",
        "",
        "Hold the button (or the space bar) and ask in your own language. The session answers without stopping what it's doing.",
    );
    const starters = make("div", "starters");
    for (const question of STARTERS) {
        const button = make("button", "btn btn-sm", question);
        button.type = "button";
        button.addEventListener("click", () => ask(question, "text"));
        starters.append(button);
    }
    box.append(mark, title, intro, starters);
    el.log.replaceChildren(box);
}

async function loadHistory() {
    const target = state.target;
    let items;
    try {
        items = (await api(`/api/history?target=${encodeURIComponent(target)}&limit=40`)).items ?? [];
    } catch (error) {
        if (target !== state.target) return;
        el.log.replaceChildren();
        addEvent("error", `Couldn't load the conversation: ${error.message}`);
        return;
    }
    if (target !== state.target) return;
    el.log.replaceChildren();
    if (!items.length) return showBlankslate();
    for (const item of items) {
        const ts = Date.parse(item.at) || Date.now();
        const voice = item.via === "voice" ? "by voice" : undefined;
        if (item.kind === "ask") {
            const tag = item.via === "check-in" || item.via === "ronda" ? "Check-in" : item.via === "agent" ? "Agent" : undefined;
            message({ who: "me", text: item.q, tag, meta: voice, ts });
            if (item.a) message({ who: "copilot", text: item.a, ts: ts + (item.ms ?? 0), replay: true });
        } else if (item.kind === "prompt") {
            message({ who: "me", text: item.q, tag: "Prompt", meta: voice, ts });
        } else if (item.kind === "answer") {
            addEvent("answered", ["You answered ", make("strong", "", `“${item.a}”`), ` to “${oneLine(item.q, 90)}”`], ts);
        }
    }
    el.log.scrollTop = el.log.scrollHeight;
}

let flashTimer;
function flash(text, tone = "info") {
    el.flash.className = `flash${tone === "info" ? "" : ` ${tone}`}`;
    el.flashIcon.setAttribute("href", tone === "error" ? "#oi-x-circle-fill-16" : tone === "warn" ? "#oi-alert-fill-16" : "#oi-info-16");
    el.flashText.textContent = text;
    el.flash.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(
        () => {
            el.flash.hidden = true;
        },
        tone === "error" ? 8000 : 4500,
    );
}

// --- Session picker ---

function renderPicker() {
    const peer = currentPeer();
    paintState(el.pickerState, sessionState(peer));
    el.pickerLabel.textContent = peer ? label(peer) : "This session";
    if (!el.pickerPanel.hidden) renderPickerOptions();
}

function renderPickerOptions() {
    const peers = state.peers.length ? state.peers : state.selfId ? [{ sessionId: state.selfId, self: true, online: true }] : [];
    const signature = JSON.stringify(peers.map((peer) => [peer.sessionId, label(peer), sessionDesc(peer), peer.sessionId === state.target]));
    if (signature === state.pickerSig) return;
    state.pickerSig = signature;
    const focused = document.activeElement?.dataset?.session;
    el.pickerList.replaceChildren(
        ...peers.map((peer) => {
            const item = make("button", "option");
            item.type = "button";
            item.role = "option";
            item.tabIndex = -1;
            item.dataset.session = peer.sessionId;
            item.setAttribute("aria-selected", String(peer.sessionId === state.target));
            const stateIcon = make("span");
            paintState(stateIcon, sessionState(peer));
            const main = make("span", "option-main");
            const name = make("span", "option-name");
            name.append(make("span", "truncate", label(peer)));
            if (peer.self) name.append(make("span", "label", "This session"));
            main.append(name, make("span", "option-desc", sessionDesc(peer)));
            item.append(stateIcon, main, icon("check-16", "oi tick"));
            item.addEventListener("click", () => choose(peer.sessionId));
            return item;
        }),
    );
    if (focused) el.pickerList.querySelector(`[data-session="${CSS.escape(focused)}"]`)?.focus();
}

function openPicker() {
    state.pickerSig = "";
    renderPickerOptions();
    el.pickerPanel.hidden = false;
    el.picker.setAttribute("aria-expanded", "true");
    (el.pickerList.querySelector('[aria-selected="true"]') ?? el.pickerList.firstElementChild)?.focus();
}

function closePicker({ focus = true } = {}) {
    if (el.pickerPanel.hidden) return;
    el.pickerPanel.hidden = true;
    el.picker.setAttribute("aria-expanded", "false");
    if (focus) el.picker.focus();
}

function choose(sessionId) {
    closePicker();
    if (sessionId === state.target) return;
    state.target = sessionId;
    state.pendingRequestId = null;
    renderAll();
    loadHistory();
}

// --- Session status ---

function renderRun() {
    const peer = currentPeer();
    const st = sessionState(peer);
    paintState(el.stIcon, st);
    el.stLabel.textContent = st.label;
    el.stTime.textContent = peer?.processing ? fmtRun(peer.busyForMs) : st.key === "done" ? fmtAgo(peer.lastIdleAt) : "";
    el.stTime.title = peer?.processing ? "Time spent on this turn" : "";

    const pending = peer?.pending ?? {};
    let step = null;
    if (st.key === "working") step = [toolIcon(peer.activityTool), peer.activity || peer.intent || "Thinking…"];
    else if (pending.plan) step = ["info-16", `${oneLine(pending.plan.summary, 140) || "Plan ready"}. Approve it in the app.`];
    else if (pending.permission) step = ["info-16", `For: ${pending.permission.text}. Approve it in the app.`];
    else if (pending.elicitation) step = ["info-16", `${oneLine(pending.elicitation.message, 140)}. Complete it in the app.`];
    else if (st.key === "off") step = ["info-16", peer?.error || "The session isn't responding."];
    else if (peer?.lastMessage && !pending.input) step = ["copilot-16", oneLine(peer.lastMessage, 220)];
    el.stStep.hidden = !step;
    if (step) {
        el.stStepIcon.setAttribute("href", `#oi-${step[0]}`);
        el.stStepText.textContent = step[1];
    }

    const todos = peer?.online === false ? null : peer?.todos;
    el.stTasks.hidden = !todos?.total;
    if (todos?.total) {
        el.stBar.style.transform = `scaleX(${todos.done / todos.total})`;
        el.stTasksText.textContent = `${todos.done} of ${todos.total} tasks${todos.current ? ` · ${todos.current}` : ""}`;
    }
    renderPending(peer);
}

function renderPending(peer) {
    const input = peer && peer.online !== false ? peer.pending?.input : null;
    el.pending.hidden = !input;
    el.modes.find((button) => button.dataset.mode === "answer").hidden = !input;
    if (!input) {
        state.pendingRequestId = null;
        if (state.mode === "answer") setMode(state.resumeMode ?? state.settings?.mode ?? "ask", { persist: false });
        return;
    }
    if (state.pendingRequestId === input.requestId) return;
    state.pendingRequestId = input.requestId;
    el.pdWho.textContent = peer.self ? "Copilot" : label(peer);
    el.pdQuestion.textContent = input.question;
    el.pdChoices.replaceChildren(
        ...(input.choices ?? []).map((choice) => {
            const button = make("button", "btn btn-sm", choice);
            button.type = "button";
            button.addEventListener("click", () => answerPending(choice, "text"));
            return button;
        }),
    );
    if (state.mode !== "answer") {
        state.resumeMode = state.mode;
        setMode("answer", { persist: false });
    }
}

function renderAll() {
    renderPicker();
    renderRun();
    renderControls();
}

function setMode(mode, { persist = true } = {}) {
    state.mode = mode;
    for (const button of el.modes) button.setAttribute("aria-checked", String(button.dataset.mode === mode));
    el.send.setAttribute("aria-label", SEND_LABELS[mode]);
    el.send.title = `${SEND_LABELS[mode]} (Enter)`;
    if (persist && mode !== "answer" && state.settings && state.settings.mode !== mode) {
        state.settings.mode = mode;
        api("/api/settings", { mode }).catch(() => {});
    }
    renderControls();
}

function renderControls() {
    const listening = state.rec === "starting" || state.rec === "recording";
    el.ptt.classList.toggle("recording", listening);
    el.ptt.classList.toggle("working", !listening && (state.rec === "transcribing" || state.busy > 0));
    el.ptt.setAttribute("aria-pressed", String(listening));
    el.ptt.disabled = state.rec === "transcribing";
    el.checkIn.disabled = state.checkInBusy;
    el.hush.disabled = !state.speaking;
    if (!listening) resetBars();
    let hint = MODE_HINTS[state.mode];
    if (listening) hint = state.latched ? "Listening… tap again to send · Esc cancels" : "Listening… release to send · Esc cancels";
    else if (state.rec === "transcribing") hint = "Transcribing…";
    else if (state.stt.state === "error") hint = `Speech recognition is unavailable: ${state.stt.error}`;
    else if (state.stt.state === "loading") hint = "Getting speech recognition ready…";
    else if (state.busy > 0) hint = state.mode === "ask" ? `Waiting for ${targetName()}…` : "One moment…";
    el.hint.textContent = hint;
    el.hint.classList.toggle("live", listening);
}

// --- Talk button bars ---

function showLevel(value) {
    const level = Math.min(1, Math.max(0, Number(value) * 1.15));
    const t = performance.now() / 1000;
    el.ptt.style.setProperty("--level", level.toFixed(3));
    el.bars.forEach((bar, i) => {
        const rest = Number(bar.style.getPropertyValue("--rest")) || 0.5;
        const wobble = 0.55 + 0.45 * Math.sin(t * BAR_SPEED[i] + BAR_PHASE[i]);
        const scale = Math.min(1, 0.12 + rest * 0.2 + level * wobble * (0.55 + rest * 0.5));
        bar.style.setProperty("--s", scale.toFixed(3));
    });
}

function resetBars() {
    el.ptt.style.setProperty("--level", "0");
    for (const bar of el.bars) bar.style.removeProperty("--s");
}

// --- Actions ---

function route(text, via, { reviewed = false, lang = null } = {}) {
    if (state.mode === "answer") return answerPending(text, via);
    if (state.mode === "prompt") {
        if (via === "voice" && !reviewed && !state.settings?.autoSend) {
            appendToComposer(text);
            flash("Check the text, then press Enter to send it.");
            return;
        }
        return sendPrompt(text, via === "voice");
    }
    return ask(text, via, lang);
}

async function ask(question, via, lang = null) {
    const target = state.target;
    message({ who: "me", text: question, meta: via === "voice" ? "by voice" : undefined });
    const bubble = message({ who: "copilot", replay: true, thinking: true });
    state.busy += 1;
    renderControls();
    let text = "";
    try {
        await stream("/api/ask", { target, question, via, lang }, (item) => {
            if (item.type === "chunk") {
                text += item.text;
                updateMessage(bubble, text);
            } else if (item.type === "done") {
                text = item.answer || text;
                updateMessage(bubble, text || "(No answer)");
            } else if (item.type === "error") {
                throw new Error(item.error);
            }
        });
    } catch (error) {
        updateMessage(bubble, `Couldn't ask: ${error.message}`, { error: true });
    } finally {
        state.busy -= 1;
        renderControls();
    }
}

async function sendPrompt(text, dictated) {
    const name = targetName();
    message({ who: "me", text, tag: "Prompt", meta: dictated ? "by voice" : undefined });
    state.busy += 1;
    renderControls();
    try {
        const result = await api("/api/send", { target: state.target, text, dictated });
        const when = result.mode === "immediate" ? "it will see it at its next step" : "if it's busy, it will pick it up when it finishes";
        const notice = state.settings?.announce ? ". I'll tell you when it's done." : ".";
        addEvent("sent", ["Prompt sent to ", make("strong", "", name), `: ${when}${notice}`]);
    } catch (error) {
        addEvent("error", `Couldn't send the prompt: ${error.message}`);
        appendToComposer(text);
    } finally {
        state.busy -= 1;
        renderControls();
    }
}

async function answerPending(text, via) {
    const input = currentPeer()?.pending?.input;
    if (!input) {
        flash("There's no pending question anymore.", "warn");
        return;
    }
    message({ who: "me", text, tag: "Reply", meta: via === "voice" ? "by voice" : undefined });
    state.busy += 1;
    renderControls();
    try {
        const result = await api("/api/answer", { target: state.target, requestId: input.requestId, text, via });
        addEvent("answered", [
            "Answer sent: ",
            make("strong", "", `“${result.answer}”`),
            ". The session carries on; if the app still shows the question, you can ignore it.",
        ]);
        el.pending.hidden = true;
    } catch (error) {
        addEvent("error", `Couldn't answer: ${error.message}`);
    } finally {
        state.busy -= 1;
        renderControls();
    }
}

function checksBox(sessions) {
    const box = make("div", "checks");
    const head = make("div", "checks-head");
    head.append(icon("broadcast-16"), make("strong", "", "Check-in"), make("span", "", `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`));
    box.append(head);
    const rows = new Map();
    for (const session of sessions) {
        const row = make("div", "check-row pending");
        const st = make("span");
        paintState(st, { key: "working", tone: "" });
        const main = make("div");
        const answer = make("div", "check-answer", "Asking…");
        main.append(make("div", "check-name", session.self ? `${session.name} (this session)` : session.name), answer);
        row.append(st, main);
        box.append(row);
        rows.set(session.sessionId, { row, st, answer });
    }
    return { box, rows };
}

async function checkIn() {
    if (state.checkInBusy) return;
    state.checkInBusy = true;
    state.busy += 1;
    renderControls();
    const node = message({ who: "brand", replay: true, thinking: true });
    const body = node.querySelector(".msg-body");
    body.querySelector(".thinking span:last-child").textContent = "Asking the active sessions…";
    let rows = null;
    const said = [];
    try {
        await stream("/api/check-in", {}, (item) => {
            if (item.type === "empty") {
                body.textContent = "No session is working right now.";
                said.push(body.textContent);
            } else if (item.type === "start") {
                const built = checksBox(item.sessions ?? []);
                rows = built.rows;
                body.replaceWith(built.box);
            } else if (item.type === "peer") {
                const row = rows?.get(item.sessionId);
                if (row) {
                    row.row.classList.remove("pending");
                    paintState(row.st, item.error ? { key: "error", tone: "error", icon: "x-circle-fill-16" } : { key: "done", tone: "done", icon: "check-circle-fill-16" });
                    row.answer.textContent = item.error ? `No answer: ${item.error}` : item.answer;
                }
                if (!item.error) said.push(`${item.name}: ${item.answer}`);
            } else if (item.type === "error") {
                throw new Error(item.error);
            }
        });
    } catch (error) {
        addEvent("error", `The check-in failed: ${error.message}`);
    } finally {
        node.dataset.text = said.join(" ");
        state.checkInBusy = false;
        state.busy -= 1;
        renderControls();
    }
}

function hush() {
    api("/api/tts/stop", {}).catch(() => {});
}

function appendToComposer(text) {
    el.text.value = el.text.value.trim() ? `${el.text.value.trimEnd()} ${text}` : text;
    state.composerDictated = true;
    autosize();
    el.text.focus();
    el.text.setSelectionRange(el.text.value.length, el.text.value.length);
}

function autosize() {
    el.text.style.height = "auto";
    el.text.style.height = `${Math.min(el.text.scrollHeight, 140)}px`;
}

// --- Talk button ---

function pressStart() {
    if (state.rec === "recording" && state.latched) {
        stopRec();
        return;
    }
    if (state.rec !== "idle") return;
    state.pressAt = Date.now();
    startRec();
}

function pressEnd({ cancelled = false } = {}) {
    const short = Date.now() - state.pressAt < HOLD_MS;
    if (state.rec === "starting") {
        if (cancelled) cancelRec();
        else if (short) state.latched = true;
        else state.stopWhenReady = true;
        renderControls();
        return;
    }
    if (state.rec !== "recording" || state.latched) return;
    if (cancelled) return cancelRec();
    if (short) {
        state.latched = true;
        renderControls();
        return;
    }
    stopRec();
}

async function startRec() {
    state.rec = "starting";
    state.latched = false;
    state.stopWhenReady = false;
    renderControls();
    try {
        await api("/api/rec/start", {});
    } catch (error) {
        state.rec = "idle";
        renderControls();
        flash(error.message, "error");
        return;
    }
    if (state.rec !== "starting") {
        api("/api/rec/cancel", {}).catch(() => {});
        return;
    }
    state.rec = "recording";
    renderControls();
    if (state.stopWhenReady) stopRec();
}

async function stopRec() {
    if (state.rec !== "recording") return;
    state.rec = "transcribing";
    state.latched = false;
    renderControls();
    let result;
    try {
        result = await api("/api/rec/stop", {});
    } catch (error) {
        state.rec = "idle";
        renderControls();
        flash(error.message, "error");
        return;
    }
    state.rec = "idle";
    renderControls();
    if (result.empty) {
        flash(result.reason === "silence" ? "I didn't hear anything. Hold the button while you talk." : "I couldn't make that out. Try again.", "warn");
        return;
    }
    route(result.text, "voice", { lang: result.language ?? null });
}

function cancelRec() {
    const previous = state.rec;
    state.rec = "idle";
    state.latched = false;
    renderControls();
    if (previous === "recording" || previous === "starting") api("/api/rec/cancel", {}).catch(() => {});
}

// --- Settings ---

const getPath = (object, path) => path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), object);

// "tts.foundry.voices.es" → { tts: { foundry: { voices: { es: value } } } }
function patchFor(path, value) {
    return path
        .split(".")
        .reduceRight((inner, key) => ({ [key]: inner }), value);
}

const sameUrl = (typed, saved) => typed.trim().replace(/\/+$/, "").toLowerCase() === String(saved ?? "").toLowerCase();
const voiceKey = () => {
    const cfg = state.settings?.tts?.foundry;
    return cfg ? `${cfg.endpoint}|${cfg.model}` : "";
};
const currentLanguage = () => (state.settings?.language && state.settings.language !== "auto" ? state.settings.language : null);

function fillLanguages() {
    el.language.replaceChildren(
        option("auto", "Auto-detect"),
        ...state.languages.map(({ code, name, native }) => option(code, native === name ? name : `${native} (${name})`)),
    );
}

function fillSettings() {
    const settings = state.settings;
    if (!settings) return;
    for (const field of el.settings.elements) {
        if (!field.name || field.closest(".voice-grid")) continue;
        const value = getPath(settings, field.name);
        if (value === undefined) continue;
        if (field.type === "radio") field.checked = field.value === value;
        else if (field.type === "checkbox") field.checked = value === true;
        else if (field === document.activeElement && field.matches("input.input, textarea")) continue;
        else field.value = String(value);
    }
    el.speedValue.textContent = `${Number(settings.speed).toFixed(2)}×`;
    renderVoiceSections();
}

function renderVoiceSections() {
    const tts = state.settings?.tts;
    if (!tts) return;
    for (const section of el.settings.querySelectorAll(".provider")) section.hidden = section.dataset.provider !== tts.provider;
    for (const provider of ["foundry", "openai"]) {
        el.settings.querySelector(`[data-key-field="${provider}"]`).hidden = tts[provider].auth !== "key";
        renderAuthNote(provider);
        renderKeyStatus(provider);
    }
    if (tts.provider !== "foundry") return;
    if (tts.foundry.endpoint && state.voiceList?.key !== voiceKey() && !state.voiceLoading) loadVoiceList();
    else renderVoiceGrid();
}

function renderAuthNote(provider) {
    const node = el.settings.querySelector(`[data-auth-note="${provider}"]`);
    if (state.settings.tts[provider].auth !== "entra") return setNote(node, "");
    if (state.voiceStatus && !state.voiceStatus.azureCli) {
        return setNote(node, "Azure CLI isn't installed. Install it with “brew install azure-cli”, then run “az login”.", { tone: "attention", icon: "alert-fill-16" });
    }
    const role = provider === "openai" ? "Cognitive Services OpenAI User" : "Cognitive Services User";
    setNote(node, `Signs in with your Azure CLI account (az login), which needs the ${role} role on the resource.`, { icon: "shield-lock-16" });
}

function renderKeyStatus(provider) {
    const node = el.settings.querySelector(`[data-key-status="${provider}"]`);
    if (!state.settings.tts[provider].endpoint) return setNote(node, "Add the endpoint first: keys are stored per endpoint.", { icon: "info-16" });
    if (state.voiceStatus?.keys?.[provider]) {
        const remove = make("button", "btn-link danger", "Remove");
        remove.type = "button";
        remove.addEventListener("click", () => removeKey(provider));
        return setNote(node, "Stored in your macOS Keychain.", { tone: "success", icon: "check-circle-fill-16", extra: remove });
    }
    setNote(node, "Kept in your macOS Keychain, never in a settings file.", { icon: "shield-lock-16" });
}

async function refreshVoiceStatus() {
    try {
        state.voiceStatus = await api("/api/tts/status");
    } catch {
        // Keep the last known status.
    }
    if (state.settings) renderVoiceSections();
}

async function loadVoiceList({ refresh = false } = {}) {
    const key = voiceKey();
    state.voiceLoading = true;
    renderVoiceGrid();
    try {
        const data = await api(`/api/tts/voices${refresh ? "?refresh=1" : ""}`);
        state.voiceList = { key, data: data.error ? null : data, error: data.error ?? null };
    } catch (error) {
        state.voiceList = { key, data: null, error: error.message };
    } finally {
        state.voiceLoading = false;
    }
    if (key !== voiceKey()) return renderVoiceSections();
    renderVoiceGrid();
}

function voiceRow(code, native, field, cfg, data) {
    const row = make("div", "voice-row");
    const id = `voice-${code}`;
    const name = make("label", "voice-lang", native);
    name.htmlFor = id;
    const wrap = make("span", "select");
    const select = make("select");
    select.id = id;
    select.name = `tts.foundry.${field}.${code}`;
    const info = data?.languages?.[code];
    const voices = info?.voices ?? [];
    const configured = cfg[field]?.[code] ?? "";
    if (voices.length) {
        select.append(...voices.map((voice) => option(voice.id, `${voice.name} · ${voice.locale}`)));
        select.value = info.selected ?? configured;
    } else {
        select.append(option(configured, data ? "No voices with this model" : configured));
        select.disabled = !!data;
    }
    wrap.append(select, icon("triangle-down-16"));
    const preview = make("button", "btn-icon");
    preview.type = "button";
    preview.dataset.preview = code;
    preview.title = `Preview the ${native} voice`;
    preview.setAttribute("aria-label", preview.title);
    preview.disabled = !cfg.endpoint || (!!data && !voices.length);
    preview.append(icon("unmute-16"));
    row.append(name, wrap, preview);
    return row;
}

function renderVoiceGrid() {
    const cfg = state.settings?.tts?.foundry;
    if (!cfg) return;
    const field = cfg.model === "neural" ? "neuralVoices" : "voices";
    const current = state.voiceList?.key === voiceKey() ? state.voiceList : null;
    const data = current?.data ?? null;
    const signature = JSON.stringify([field, cfg[field], current?.key ?? null, !!data, data && state.languages.map(({ code }) => data.languages?.[code]?.selected)]);
    if (signature !== state.gridSig) {
        state.gridSig = signature;
        const focused = el.voiceGrid.contains(document.activeElement) ? document.activeElement.id || document.activeElement.dataset.preview : null;
        el.voiceGrid.replaceChildren(...state.languages.map(({ code, native }) => voiceRow(code, native, field, cfg, data)));
        if (focused) ($(focused) ?? el.voiceGrid.querySelector(`[data-preview="${focused}"]`))?.focus();
    }
    el.refreshVoices.disabled = !cfg.endpoint || state.voiceLoading;
    if (!cfg.endpoint) setNote(el.voicesStatus, "Add the endpoint to choose from the voices it offers.", { icon: "info-16" });
    else if (state.voiceLoading) setNote(el.voicesStatus, "Loading the voices this resource offers…", { spin: true });
    else if (current?.error) setNote(el.voicesStatus, `Couldn't load the voice list: ${current.error}`, { tone: "danger", icon: "x-circle-fill-16" });
    else setNote(el.voicesStatus, "");
}

function voiceDisplay(voice) {
    const [id, model] = String(voice ?? "").split(":");
    const parts = id.split("-");
    if (model && parts.length >= 3) return `${parts.slice(2).join("-")} (${parts.slice(0, 2).join("-")}) · ${model}`;
    return id || "default voice";
}

async function testVoice() {
    el.testVoice.disabled = true;
    setNote(el.testStatus, "Preparing a sample…", { spin: true });
    try {
        const result = await api("/api/tts/test", { lang: currentLanguage() });
        if (!result.ok) throw new Error(result.error || "The voice test failed.");
        const where = languageName(result.lang);
        const timing = Number.isFinite(result.ms) ? ` · first audio in ${(result.ms / 1000).toFixed(1)} s` : "";
        const who = result.provider === "system" ? `macOS · ${result.voice}` : voiceDisplay(result.voice);
        setNote(el.testStatus, `${where ? `${where}: ` : ""}${who}${timing}`, { tone: "success", icon: "check-circle-fill-16" });
    } catch (error) {
        setNote(el.testStatus, error.message, { tone: "danger", icon: "x-circle-fill-16" });
    } finally {
        el.testVoice.disabled = false;
    }
}

async function previewVoice(button) {
    button.disabled = true;
    button.replaceChildren(make("span", "spin"));
    try {
        const result = await api("/api/tts/test", { lang: button.dataset.preview });
        if (!result.ok) throw new Error(result.error || "The voice test failed.");
    } catch (error) {
        flash(error.message, "error");
    } finally {
        button.disabled = false;
        button.replaceChildren(icon("unmute-16"));
    }
}

async function saveKey(provider) {
    const input = $(`${provider}-key`);
    const key = input.value.trim();
    if (!key) {
        flash("Paste a key first.", "warn");
        input.focus();
        return;
    }
    try {
        state.voiceStatus = await api("/api/tts/key", { provider, key });
        input.value = "";
        flash("Key saved to your macOS Keychain.");
        renderVoiceSections();
        if (provider === "foundry" && state.settings.tts.provider === "foundry") loadVoiceList({ refresh: true });
    } catch (error) {
        flash(error.message, "error");
    }
}

async function removeKey(provider) {
    try {
        state.voiceStatus = await api("/api/tts/key", { provider, key: "" });
        flash("Key removed from your Keychain.");
        renderVoiceSections();
    } catch (error) {
        flash(error.message, "error");
    }
}

async function saveField(field) {
    if (!field.name || (field.type === "radio" && !field.checked)) return;
    const value = field.type === "checkbox" ? field.checked : field.type === "range" ? Number(field.value) : field.value.trim();
    const previous = state.settings;
    try {
        state.settings = (await api("/api/settings", patchFor(field.name, value))).settings;
    } catch (error) {
        flash(error.message, "error");
        return;
    }
    if (field.name.endsWith(".endpoint") && value) {
        const saved = getPath(state.settings, field.name);
        if (!saved || (saved === getPath(previous, field.name) && !sameUrl(value, saved))) {
            flash("That isn't a valid endpoint. Use the full https:// address.", "error");
        }
    }
    if (field.name.startsWith("tts.") || field.name === "speed") setNote(el.testStatus, "");
    if (/^tts\.(provider|(foundry|openai)\.(endpoint|auth))$/.test(field.name)) refreshVoiceStatus();
    fillSettings();
}

function toggleSettings(open = el.settings.hidden) {
    el.settings.hidden = !open;
    el.log.hidden = open;
    el.openSettings.setAttribute("aria-expanded", String(open));
    if (open) {
        fillSettings();
        refreshVoiceStatus();
    }
}

// --- Server events ---

const handlers = {
    level: ({ value }) => {
        if (state.rec === "recording" || state.rec === "starting") showLevel(value);
    },
    rec: ({ state: recState, error }) => {
        if (error) {
            flash(error, "error");
            if (state.rec !== "idle") {
                state.rec = "idle";
                state.latched = false;
                renderControls();
            }
        }
        if (recState === "limit") {
            flash("You've been recording for two minutes, so I stopped there.", "warn");
            stopRec();
        }
    },
    tts: ({ speaking }) => {
        state.speaking = speaking;
        renderControls();
    },
    stt: (event) => {
        state.stt = event;
        renderControls();
    },
    settings: ({ settings }) => {
        state.settings = settings;
        if (!el.settings.hidden) fillSettings();
    },
    peers: ({ peers }) => {
        state.peers = peers;
        if (state.peers.length && !state.peers.some((peer) => peer.sessionId === state.target)) {
            flash("That session isn't available anymore, so I switched back to this one.", "warn");
            state.target = state.selfId;
            state.pendingRequestId = null;
            loadHistory();
        }
        renderPicker();
        renderRun();
    },
    announce: (event) => addEvent(event.kind ?? "info", announcement(event), event.at),
    notice: ({ text, tone }) => flash(text, tone === "error" ? "error" : tone === "warn" ? "warn" : "info"),
};

function connect() {
    const source = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
    source.addEventListener("open", () => {
        state.connected = true;
        renderRun();
    });
    source.addEventListener("error", () => {
        state.connected = false;
    });
    source.addEventListener("message", (message) => {
        let event;
        try {
            event = JSON.parse(message.data);
        } catch {
            return;
        }
        handlers[event.type]?.(event);
    });
}

// --- Wiring ---

el.ptt.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    el.ptt.setPointerCapture?.(event.pointerId);
    pressStart();
});
el.ptt.addEventListener("pointerup", () => pressEnd());
el.ptt.addEventListener("pointercancel", () => pressEnd({ cancelled: true }));
el.ptt.addEventListener("contextmenu", (event) => event.preventDefault());
el.ptt.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!event.repeat) pressStart();
});
el.ptt.addEventListener("keyup", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    pressEnd();
});

const typing = (target) => target instanceof HTMLElement && (target.matches("textarea, input, select") || target.isContentEditable);
const inMenu = (target) => target instanceof HTMLElement && !!target.closest(".overlay");
document.addEventListener("keydown", (event) => {
    if (event.code === "Space" && !typing(event.target) && !inMenu(event.target) && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        if (!event.repeat) pressStart();
    } else if (event.key === "Escape") {
        if (state.rec === "recording" || state.rec === "starting") cancelRec();
        else if (!el.pickerPanel.hidden) closePicker();
        else if (!el.settings.hidden) toggleSettings(false);
        else hush();
    }
});
document.addEventListener("keyup", (event) => {
    if (event.code !== "Space" || typing(event.target) || inMenu(event.target)) return;
    event.preventDefault();
    pressEnd();
});

el.picker.addEventListener("click", () => (el.pickerPanel.hidden ? openPicker() : closePicker()));
el.picker.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openPicker();
    }
});
el.pickerList.addEventListener("keydown", (event) => {
    const options = [...el.pickerList.querySelectorAll(".option")];
    const index = options.indexOf(document.activeElement);
    const go = (i) => options[(i + options.length) % options.length]?.focus();
    if (event.key === "ArrowDown") go(index + 1);
    else if (event.key === "ArrowUp") go(index - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(options.length - 1);
    else if (event.key === "Tab") closePicker({ focus: false });
    else return;
    if (event.key !== "Tab") event.preventDefault();
});
document.addEventListener("pointerdown", (event) => {
    if (!el.pickerPanel.hidden && !event.target.closest(".picker")) closePicker({ focus: false });
});

for (const button of el.modes) button.addEventListener("click", () => setMode(button.dataset.mode));
el.checkIn.addEventListener("click", checkIn);
el.hush.addEventListener("click", hush);
el.compose.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = el.text.value.trim();
    if (!text) return;
    const dictated = state.composerDictated;
    el.text.value = "";
    state.composerDictated = false;
    autosize();
    route(text, dictated ? "voice" : "text", { reviewed: true });
});
el.text.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        el.compose.requestSubmit();
    }
});
el.text.addEventListener("input", () => {
    autosize();
    if (!el.text.value.trim()) state.composerDictated = false;
});

el.openSettings.addEventListener("click", () => toggleSettings());
el.closeSettings.addEventListener("click", () => toggleSettings(false));
el.settings.addEventListener("submit", (event) => event.preventDefault());
el.settings.addEventListener("change", (event) => saveField(event.target));
el.settings.addEventListener("input", (event) => {
    if (event.target.name === "speed") el.speedValue.textContent = `${Number(event.target.value).toFixed(2)}×`;
});
el.settings.addEventListener("click", (event) => {
    const save = event.target.closest("[data-key-save]");
    const preview = event.target.closest("[data-preview]");
    if (save) saveKey(save.dataset.keySave);
    else if (preview && !preview.disabled) previewVoice(preview);
});
el.settings.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.matches('input[type="password"]')) {
        event.preventDefault();
        saveKey(event.target.id.replace(/-key$/, ""));
    }
});
el.refreshVoices.addEventListener("click", () => loadVoiceList({ refresh: true }));
el.testVoice.addEventListener("click", testVoice);

async function init() {
    watchTheme();
    if (!token) {
        el.stLabel.textContent = "Missing token: reopen Octovox from Copilot.";
        return;
    }
    try {
        const snapshot = await api("/api/state");
        state.selfId = snapshot.self.sessionId;
        state.user = snapshot.user ?? null;
        state.settings = snapshot.settings;
        state.languages = snapshot.languages ?? [];
        state.voiceStatus = snapshot.voiceStatus ?? null;
        state.peers = snapshot.peers ?? [];
        state.stt = snapshot.stt ?? state.stt;
        state.target ||= state.selfId;
        fillLanguages();
        const wanted = params.get("mode");
        setMode(wanted === "ask" || wanted === "prompt" ? wanted : snapshot.settings.mode, { persist: false });
        renderAll();
        if (params.get("view") === "settings") toggleSettings(true);
        await loadHistory();
    } catch (error) {
        flash(`Couldn't connect to Octovox: ${error.message}`, "error");
    }
    connect();
    setInterval(refreshTimes, 30_000);
}

init();
