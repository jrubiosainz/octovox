// Pure text helpers (no I/O): languages, side-question framing, spoken alerts and speech cleanup.

// Languages Octovox can listen to and speak. `whisper` is the speech-to-text code; `locale` is the
// default speech locale; `maiVoice` / `neuralVoice` are the default Azure voices.
export const LANGUAGES = {
    en: { name: "English", native: "English", locale: "en-US", maiVoice: "en-US-Harper", neuralVoice: "en-US-AvaMultilingualNeural", system: ["Samantha", "Daniel", "Karen", "Moira", "Alex"] },
    es: { name: "Spanish", native: "Español", locale: "es-ES", maiVoice: "es-ES-Marta", neuralVoice: "es-ES-XimenaMultilingualNeural", system: ["Mónica", "Paulina", "Jorge", "Marisol"] },
    it: { name: "Italian", native: "Italiano", locale: "it-IT", maiVoice: "it-IT-Rosa", neuralVoice: "it-IT-IsabellaMultilingualNeural", system: ["Alice", "Federica", "Luca"] },
    de: { name: "German", native: "Deutsch", locale: "de-DE", maiVoice: "de-DE-Mia", neuralVoice: "de-DE-SeraphinaMultilingualNeural", system: ["Anna", "Petra", "Markus", "Yannick"] },
    fr: { name: "French", native: "Français", locale: "fr-FR", maiVoice: "fr-FR-Soleil", neuralVoice: "fr-FR-VivienneMultilingualNeural", system: ["Thomas", "Amélie", "Audrey", "Aurélie"] },
    pt: { name: "Portuguese", native: "Português", locale: "pt-BR", maiVoice: "pt-BR-Luana", neuralVoice: "pt-BR-ThalitaMultilingualNeural", system: ["Luciana", "Joana", "Felipe"] },
    nl: { name: "Dutch", native: "Nederlands", locale: "nl-NL", maiVoice: "nl-NL-Harper", neuralVoice: "nl-NL-FennaNeural", system: ["Xander", "Ellen", "Claire"] },
    pl: { name: "Polish", native: "Polski", locale: "pl-PL", maiVoice: "pl-PL-Harper", neuralVoice: "pl-PL-AgnieszkaNeural", system: ["Zosia", "Krzysztof"] },
};
export const LANGUAGE_CODES = Object.keys(LANGUAGES);

export const isLanguage = (code) => Object.hasOwn(LANGUAGES, code ?? "");

// Spoken alerts, in the language the user talks in. The panel shows its own English text.
const SPOKEN = {
    en: {
        input: (n, q) => `${n} has a question for you: ${q}`,
        plan: (n) => `${n} has a plan ready and is waiting for your approval.`,
        permission: (n, p) => `${n} needs your permission for: ${p}.`,
        form: (n) => `${n} needs you to fill in a form in the app.`,
        done: (n, s) => (s ? `${n} is done. ${s}` : `${n} is done.`),
        idle: "No session is working right now.",
        test: "Hi, I'm Octovox. Ask me how any of your sessions is going.",
    },
    es: {
        input: (n, q) => `${n} tiene una pregunta para ti: ${q}`,
        plan: (n) => `${n} ha preparado un plan y espera tu aprobación.`,
        permission: (n, p) => `${n} necesita tu permiso para: ${p}.`,
        form: (n) => `${n} necesita que completes un formulario en la app.`,
        done: (n, s) => (s ? `${n} ha terminado. ${s}` : `${n} ha terminado.`),
        idle: "Ahora mismo no hay ninguna sesión trabajando.",
        test: "Hola, soy Octovox. Pregúntame cómo va cualquiera de tus sesiones.",
    },
    it: {
        input: (n, q) => `${n} ha una domanda per te: ${q}`,
        plan: (n) => `${n} ha preparato un piano e aspetta la tua approvazione.`,
        permission: (n, p) => `${n} ha bisogno del tuo permesso per: ${p}.`,
        form: (n) => `${n} ha bisogno che tu compili un modulo nell'app.`,
        done: (n, s) => (s ? `${n} ha finito. ${s}` : `${n} ha finito.`),
        idle: "Al momento nessuna sessione sta lavorando.",
        test: "Ciao, sono Octovox. Chiedimi come va una qualsiasi delle tue sessioni.",
    },
    de: {
        input: (n, q) => `${n} hat eine Frage an dich: ${q}`,
        plan: (n) => `${n} hat einen Plan vorbereitet und wartet auf deine Freigabe.`,
        permission: (n, p) => `${n} braucht deine Erlaubnis für: ${p}.`,
        form: (n) => `${n} wartet darauf, dass du in der App ein Formular ausfüllst.`,
        done: (n, s) => (s ? `${n} ist fertig. ${s}` : `${n} ist fertig.`),
        idle: "Gerade arbeitet keine Sitzung.",
        test: "Hallo, ich bin Octovox. Frag mich, wie es bei deinen Sitzungen läuft.",
    },
    fr: {
        input: (n, q) => `${n} a une question pour toi : ${q}`,
        plan: (n) => `${n} a préparé un plan et attend ton approbation.`,
        permission: (n, p) => `${n} a besoin de ton autorisation pour : ${p}.`,
        form: (n) => `${n} a besoin que tu remplisses un formulaire dans l'application.`,
        done: (n, s) => (s ? `${n} a terminé. ${s}` : `${n} a terminé.`),
        idle: "Aucune session ne travaille en ce moment.",
        test: "Salut, je suis Octovox. Demande-moi où en est n'importe laquelle de tes sessions.",
    },
    pt: {
        input: (n, q) => `${n} tem uma pergunta para você: ${q}`,
        plan: (n) => `${n} preparou um plano e está aguardando sua aprovação.`,
        permission: (n, p) => `${n} precisa da sua permissão para: ${p}.`,
        form: (n) => `${n} precisa que você preencha um formulário no app.`,
        done: (n, s) => (s ? `${n} terminou. ${s}` : `${n} terminou.`),
        idle: "No momento nenhuma sessão está trabalhando.",
        test: "Olá, eu sou o Octovox. Pergunte como está qualquer uma das suas sessões.",
    },
    nl: {
        input: (n, q) => `${n} heeft een vraag voor je: ${q}`,
        plan: (n) => `${n} heeft een plan klaar en wacht op je goedkeuring.`,
        permission: (n, p) => `${n} heeft je toestemming nodig voor: ${p}.`,
        form: (n) => `${n} wacht tot je een formulier in de app invult.`,
        done: (n, s) => (s ? `${n} is klaar. ${s}` : `${n} is klaar.`),
        idle: "Er is op dit moment geen sessie bezig.",
        test: "Hoi, ik ben Octovox. Vraag me hoe het met een van je sessies gaat.",
    },
    pl: {
        input: (n, q) => `${n} ma do ciebie pytanie: ${q}`,
        plan: (n) => `Plan od ${n} jest gotowy i czeka na twoją akceptację.`,
        permission: (n, p) => `${n} potrzebuje twojej zgody na: ${p}.`,
        form: (n) => `${n} czeka, aż wypełnisz formularz w aplikacji.`,
        done: (n, s) => (s ? `${n}: zadanie zakończone. ${s}` : `${n}: zadanie zakończone.`),
        idle: "W tej chwili żadna sesja nie pracuje.",
        test: "Cześć, jestem Octovox. Zapytaj mnie, jak idzie dowolna z twoich sesji.",
    },
};

export function spoken(lang) {
    return SPOKEN[isLanguage(lang) ? lang : "en"];
}

const STOPWORDS = {
    en: "the be to of and in that have it for not on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go when make can like time just him know take into your some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us is are was were been has had does did please run tests status need doing going done found hey what's how's i'm don't",
    es: "de la que el en y los se del las un por con una su para es al lo como más pero sus le ya o fue este ha si porque esta son entre cuando muy sin sobre ser también hasta hay donde han quien están desde todo nos durante todos uno les ni contra otros ese eso había ante ellos esto antes algunos qué unos yo otro otras otra él tanto esa estos mucho nada muchos cual poco ella estar estas estaba estamos algo nosotros mi mis tú te ti tu tus vas voy va estás está estoy cómo hola oye dime haz hazme necesitas puedes quiero quieres hemos hecho encontrado vale bien gracias ahora sesión pruebas cuánto falta",
    it: "di che il la e un una per non in sono mi ho lo ma ti ci le del della come con se io questo qui cosa hai ha anche bene sei mio tutto gli nel alla da più quando molto fatto essere perché dove chi ciao grazie fare devi puoi stai sto vai ancora adesso adesso sessione prova trovato serve qualcosa cosa",
    de: "der die und in den von zu das mit sich des auf für ist im dem nicht ein eine als auch es an werden aus er hat dass sie nach wird bei einer um am sind noch wie einem über einen so zum war haben nur oder aber vor zur bis mehr durch man sehr was wenn ich du wir ihr mir dich dir bist kannst brauchst gerade jetzt hallo danke bitte machst läuft sitzung gefunden",
    fr: "le de un être et à il avoir ne je son que se qui ce dans en du elle au pour pas que vous par sur faire plus dire me on mon lui nous comme mais pouvoir avec tout y aller voir en bien où sans tu ou leur homme si deux mari moi vouloir te femme venir quand grand celui notre devoir là jour prendre même votre tout rien petit encore aussi quelque est les des une ça c'est où bonjour merci besoin trouvé session",
    pt: "de a o que e do da em um para é com não uma os no se na por mais as dos como mas foi ao ele das tem à seu sua ou ser quando muito há nos já está eu também só pelo pela até isso ela entre era depois sem mesmo aos ter seus quem nas me esse eles estão você tinha foram essa num nem suas meu às minha têm numa pelos elas havia seja qual será nós tenho lhe deles essas esses pelas este fosse dele tu te vocês vos lhes meus minhas teu tua olá obrigado preciso sessão",
    nl: "de en van ik te dat die in een hij het niet zijn is was op aan met als voor had er maar om hem dan zou of wat mijn men dit zo door over ze zich bij ook tot je mij uit der daar haar naar heb hoe heeft hebben deze u want nog zal me zij nu ge geen omdat iets worden toch al waren veel meer doen toen moet ben zonder kan hun dus alles onder ja eens hier wie werd altijd doch wordt wezen kunnen ons zelf tegen na reeds wil kon niets uw iemand geweest andere hallo dank sessie gevonden",
    pl: "i w nie na się z do to że jest jak o a co ale po tak za od już jego go są czy tylko może ma przez by jej mnie ze dla ich gdy też bo tu jeszcze jak pan być był była było były będzie które który która mi ci cię ty ja my wy oni jestem jesteś masz mam potrzebujesz teraz cześć dzięki proszę sesja znalazłeś",
};
const STOPWORD_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([lang, words]) => [lang, new Set(words.split(/\s+/))]));
const MARKS = {
    es: /[ñ¿¡]/g,
    de: /[äöüß]/g,
    fr: /[çœêëîïûù]|\b(?:c|d|l|j|n|qu)'/g,
    pt: /[ãõ]|\bnão\b|ção\b/g,
    pl: /[ąęłńśźż]/g,
    it: /\b\w+(?:zione|zioni)\b|\b[dl]'/g,
    nl: /\bij|ij\w*/g,
};

// Best guess of a text's language among `candidates`, or `fallback` when the evidence is weak.
export function detectLanguage(text, { candidates = LANGUAGE_CODES, fallback = null } = {}) {
    if (!text) return fallback;
    const lower = String(text).toLowerCase();
    const words = lower.match(/[\p{L}']+/gu) ?? [];
    const scores = new Map(candidates.map((lang) => [lang, 0]));
    for (const lang of candidates) {
        const set = STOPWORD_SETS[lang];
        if (!set) continue;
        let score = 0;
        for (const word of words) if (set.has(word)) score += 1;
        score += (lower.match(MARKS[lang] ?? /$^/g) ?? []).length * 1.5;
        scores.set(lang, score);
    }
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const [best, second] = ranked;
    if (!best || best[1] < 1 || (second && best[1] - second[1] < 0.5)) return fallback;
    return best[0];
}

export function clip(text, max) {
    const value = String(text ?? "").replace(/\s+/g, " ").trim();
    return value.length > max ? `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…` : value;
}

export function formatDuration(ms) {
    const seconds = Math.max(0, Math.round((ms ?? 0) / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// Session status as one English line for the model (it answers in the user's language anyway).
export function describeStatus(status) {
    if (!status) return "";
    const parts = [];
    const pending = status.pending ?? {};
    if (pending.input) parts.push(`waiting for the user to answer: "${clip(pending.input.question, 200)}"`);
    if (pending.plan) parts.push("waiting for the user to approve the plan");
    if (pending.permission) parts.push(`waiting for the user's permission for: ${pending.permission.text}`);
    if (pending.elicitation) parts.push(`waiting for the user to fill in: ${clip(pending.elicitation.message, 120)}`);
    parts.push(status.processing ? `working for ${formatDuration(status.busyForMs)}` : "idle");
    if (status.processing && status.activity) parts.push(`right now: ${status.activity}`);
    if (status.todos?.total) parts.push(`tasks: ${status.todos.done} of ${status.todos.total} done`);
    return parts.join("; ");
}

export const CHECK_IN_QUESTION = "In one sentence: what are you doing right now, and do you need anything from the user?";
export const DICTATED_NOTE = "[Dictated by voice with Octovox; it may contain transcription errors.]";

export function frameQuestion({ question, lang = null, status, history = [], others = [] }) {
    const reply = isLanguage(lang) ? `Reply in ${LANGUAGES[lang].name}` : "Reply in the same language as the user's question";
    const lines = [
        "[Octovox] The user is talking to you by voice from the Octovox panel while you work. This is a side question: it doesn't interrupt your task, it isn't kept in your history and you can't use tools here. Answer only from what you already know in this conversation.",
        `- ${reply}, in 1 to 4 short, natural sentences meant to be read aloud.`,
        "- No markdown, lists, tables, code blocks or long paths.",
        "- If you're waiting for something from the user (an answer, an approval or a decision), say that first.",
        "- If you don't know something or haven't done it yet, say so plainly; don't make anything up.",
    ];
    if (status) lines.push("", `Status observed by Octovox: ${status}.`);
    if (others.length) lines.push("", "The user's other open sessions (live status from Octovox; use it if they ask about their sessions):", ...others.map((line) => `- ${line}`));
    const recent = history.filter((item) => item?.q && item?.a).slice(-3);
    if (recent.length) {
        lines.push("", "Earlier Octovox conversation (oldest first):");
        for (const item of recent) lines.push(`User: ${clip(item.q, 300)}`, `You: ${clip(item.a, 500)}`);
    }
    lines.push("", `User's question: "${String(question).trim()}"`);
    return lines.join("\n");
}

function norm(text) {
    return String(text ?? "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/ł/g, "l")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

// Ordinal words (after accent stripping) in every supported language: first … fifth.
const ORDINALS = [
    "first one 1 primera primero prima primo erste ersten erstes eins premiere premier primeira eerste pierwsza pierwszy pierwsze jeden uno un une um uma una een",
    "second two 2 segunda segundo seconda secondo due zweite zweiten zwei deuxieme seconde dois duas tweede twee druga drugi drugie dwa dos",
    "third three 3 tercera tercero terza terzo tre dritte dritten drei troisieme trois terceira terceiro tres derde drie trzecia trzeci trzy",
    "fourth four 4 cuarta cuarto quarta quarto quattro vierte vierten vier quatrieme quatre quatro vierde czwarta czwarty cztery",
    "fifth five 5 quinta quinto cinque funfte funften funf cinquieme cinq cinco vijfde vijf piata piaty piec",
].map((line) => new Set(line.split(" ")));
// "one/uno/un…" also work as articles ("la segunda (uno)"); they only count without another ordinal.
const WEAK_ORDINALS = new Set(["one", "uno", "un", "une", "um", "uma", "una", "een", "eins", "jeden"]);
const YES = new Set(["yes", "yeah", "yep", "sure", "ok", "okay", "si", "vale", "claro", "adelante", "certo", "ja", "oui", "sim", "tak"]);
const NO = new Set(["no", "nope", "non", "nein", "nao", "nee", "nie"]);

function ordinalIndex(words) {
    const matched = ORDINALS.map((set, i) => (words.some((word) => set.has(word)) ? i : -1)).filter((i) => i >= 0);
    if (matched.length === 1) return matched[0];
    const strong = matched.filter((i) => words.some((word) => ORDINALS[i].has(word) && !WEAK_ORDINALS.has(word)));
    return strong.length === 1 ? strong[0] : -1;
}

// The option the user said, or null when the answer is free text.
export function matchChoice(text, choices = []) {
    if (!choices?.length) return null;
    const said = norm(text);
    if (!said) return null;
    const normalized = choices.map(norm);
    const exact = normalized.indexOf(said);
    if (exact >= 0) return choices[exact];
    const words = said.split(" ");
    if (words.length <= 4) {
        const index = ordinalIndex(words);
        if (index >= 0 && index < choices.length) return choices[index];
        const polarity = words.some((w) => YES.has(w)) ? YES : words.some((w) => NO.has(w)) ? NO : null;
        if (polarity) {
            const options = choices.filter((_, i) => polarity.has(normalized[i].split(" ")[0]));
            if (options.length === 1) return options[0];
        }
    }
    const hits = choices.filter((_, i) => {
        const option = normalized[i];
        if (option.length < 3) return false;
        if (` ${said} `.includes(` ${option} `)) return true;
        return said.length >= 4 && (option.startsWith(said) || ` ${option} `.includes(` ${said} `));
    });
    return hits.length === 1 ? hits[0] : null;
}

export function cleanForSpeech(text, maxChars = 700) {
    if (!text) return "";
    const flattened = String(text)
        .replace(/```[\s\S]*?```/g, "\n")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/(\*\*|__|~~)/g, "")
        .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
        .replace(/(?:~|\.{1,2})?(?:\/[\w.@-]+){2,}\/?/g, (path) => path.split("/").filter(Boolean).pop() ?? "");
    const lines = flattened
        .split("\n")
        .map((line) =>
            line
                .replace(/^\s*\|.*\|\s*$/, "")
                .replace(/^\s{0,3}#{1,6}\s+/, "")
                .replace(/^\s*>\s?/, "")
                .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, "")
                .replace(/\s{2,}/g, " ")
                .trim(),
        )
        .filter((line) => line && !/^[-|:\s]+$/.test(line))
        .map((line) => (/[.!?:;…]$/.test(line) ? line : `${line}.`));
    let spokenText = lines.join(" ").replace(/\s{2,}/g, " ").trim();
    if (spokenText.length > maxChars) {
        const cut = spokenText.slice(0, maxChars);
        const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
        spokenText = end > maxChars * 0.5 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
    }
    return spokenText;
}

export function firstSentences(text, count = 2, maxChars = 320) {
    const spokenText = cleanForSpeech(text, 4000);
    if (!spokenText) return "";
    const sentences = spokenText.match(/[^.!?…]+[.!?…]+(?:\s|$)|[^.!?…]+$/g) ?? [spokenText];
    return clip(sentences.slice(0, count).join(" ").trim(), maxChars);
}

const BOUNDARY = /[.!?…]+["»”')\]]*\s+|\n{2,}/g;

// Turns streamed text into speakable chunks: a short first chunk so the voice starts quickly,
// then bigger ones (fewer joins in the intonation).
export class SentenceBuffer {
    constructor(onChunk, { first = 20, rest = 160, hardLimit = 420, maxChars = 1200 } = {}) {
        this.onChunk = onChunk;
        this.first = first;
        this.rest = rest;
        this.hardLimit = hardLimit;
        this.budget = maxChars;
        this.buffer = "";
        this.count = 0;
        this.closed = false;
    }

    push(text) {
        if (this.closed || !text) return;
        this.buffer += text;
        this.#drain(false);
    }

    end() {
        if (this.closed) return;
        this.#drain(true);
        this.closed = true;
    }

    #drain(final) {
        for (;;) {
            const min = this.count === 0 ? this.first : this.rest;
            let cut = -1;
            BOUNDARY.lastIndex = 0;
            for (let match; (match = BOUNDARY.exec(this.buffer)); ) {
                if (match.index + match[0].length >= min) {
                    cut = match.index + match[0].length;
                    break;
                }
            }
            if (cut < 0 && this.buffer.length > this.hardLimit) {
                const soft = Math.max(this.buffer.lastIndexOf(", ", this.hardLimit), this.buffer.lastIndexOf(" ", this.hardLimit));
                cut = soft > this.first ? soft + 1 : this.hardLimit;
            }
            if (cut < 0) break;
            this.#emit(this.buffer.slice(0, cut));
            this.buffer = this.buffer.slice(cut);
        }
        if (final && this.buffer.trim()) {
            this.#emit(this.buffer);
            this.buffer = "";
        }
    }

    #emit(piece) {
        if (this.budget <= 0) return;
        const clean = cleanForSpeech(piece, this.budget);
        if (!clean) return;
        this.budget -= clean.length;
        this.count += 1;
        this.onChunk(clean);
    }
}

export function summarizeTool(name, args) {
    if (!name) return null;
    const a = args && typeof args === "object" ? args : {};
    const path = typeof a.path === "string" ? a.path.split("/").filter(Boolean).pop() : null;
    const detail = a.description || a.intent || a.title || path || a.pattern || a.query;
    return detail ? `${name} · ${clip(detail, 80)}` : name;
}

export function describePermission(request) {
    if (!request || typeof request !== "object") return "an action";
    const detail = request.intention || request.fullCommandText || request.fileName || request.path || request.url || request.toolName || request.serverName || request.kind;
    return clip(detail ?? "an action", 120);
}

export function sessionLabel(peer) {
    if (peer?.name) return peer.name;
    const base = String(peer?.cwd ?? "").split("/").filter(Boolean).pop();
    return base || String(peer?.sessionId ?? "session").slice(0, 8);
}
