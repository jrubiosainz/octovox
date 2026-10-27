import assert from "node:assert/strict";
import { test } from "node:test";
import {
    cleanForSpeech,
    describeStatus,
    detectLanguage,
    firstSentences,
    formatDuration,
    frameQuestion,
    LANGUAGE_CODES,
    LANGUAGES,
    matchChoice,
    SentenceBuffer,
    spoken,
    summarizeTool,
} from "../lib/text.mjs";

test("detectLanguage recognises every supported language", () => {
    const samples = {
        en: "How is it going with the tests? Do you need anything from me?",
        es: "¿Cómo vas con los tests? ¿Necesitas algo de mí?",
        it: "Come va con i test? Hai bisogno di qualcosa da me?",
        de: "Wie läuft es mit den Tests? Brauchst du etwas von mir?",
        fr: "Comment ça avance avec les tests ? Tu as besoin de quelque chose ?",
        pt: "Como vai com os testes? Você precisa de alguma coisa de mim?",
        nl: "Hoe gaat het met de tests? Heb je iets van mij nodig?",
        pl: "Jak ci idą testy? Czy potrzebujesz czegoś ode mnie?",
    };
    assert.deepEqual(Object.keys(samples).sort(), [...LANGUAGE_CODES].sort());
    for (const [lang, text] of Object.entries(samples)) assert.equal(detectLanguage(text), lang, text);
});

test("detectLanguage falls back when the evidence is weak", () => {
    assert.equal(detectLanguage("", { fallback: "en" }), "en");
    assert.equal(detectLanguage("OK", { fallback: "es" }), "es");
    assert.equal(detectLanguage("Kubernetes"), null);
    assert.equal(detectLanguage("oye, qué has encontrado en la api"), "es");
    assert.equal(detectLanguage("please run the unit tests and open a pull request"), "en");
    assert.equal(detectLanguage("Wie läuft es mit den Tests?", { candidates: ["en", "es"], fallback: "en" }), "en");
});

test("every language has names, voices and spoken templates", () => {
    for (const code of LANGUAGE_CODES) {
        const info = LANGUAGES[code];
        assert.ok(info.name && info.native, code);
        assert.match(info.locale, /^[a-z]{2}-[A-Z]{2}$/);
        assert.ok(info.maiVoice.startsWith(info.locale.slice(0, 2)), code);
        const t = spoken(code);
        for (const key of ["plan", "form", "idle", "test"]) assert.ok(typeof t[key] === "function" ? t[key]("API") : t[key], `${code}.${key}`);
        assert.match(t.input("API", "¿Despliego?"), /API/);
        assert.match(t.done("API", "Done."), /API/);
    }
    assert.equal(spoken("es").done("API", "Todo listo."), "API ha terminado. Todo listo.");
    assert.equal(spoken("xx"), spoken("en"));
});

test("matchChoice understands options said in several languages", () => {
    const choices = ["PostgreSQL (Recommended)", "MySQL", "SQLite"];
    assert.equal(matchChoice("mysql", choices), "MySQL");
    assert.equal(matchChoice("Postgres", choices), "PostgreSQL (Recommended)");
    assert.equal(matchChoice("quiero sqlite, por favor", choices), "SQLite");
    assert.equal(matchChoice("la segunda", choices), "MySQL");
    assert.equal(matchChoice("the third one", choices), "SQLite");
    assert.equal(matchChoice("la seconda", choices), "MySQL");
    assert.equal(matchChoice("die dritte", choices), "SQLite");
    assert.equal(matchChoice("le premier", choices), "PostgreSQL (Recommended)");
    assert.equal(matchChoice("opción 1", choices), "PostgreSQL (Recommended)");
    assert.equal(matchChoice("usa la que tú veas mejor", choices), null);
    assert.equal(matchChoice("sí, adelante", ["Yes", "No"]), "Yes");
    assert.equal(matchChoice("oui", ["Yes", "No"]), "Yes");
    assert.equal(matchChoice("nein", ["Ja", "Nein"]), "Nein");
    assert.equal(matchChoice("no", ["Sí", "No"]), "No");
    assert.equal(matchChoice("whatever", []), null);
});

test("cleanForSpeech strips markdown, code, links and paths", () => {
    const said = cleanForSpeech(
        "## Result\n**All good**: I checked `src/app.ts` and [the docs](https://x.y/z).\n\n- Step one\n- Step two\n\n```js\nconsole.log(1)\n```\nPath: /Users/me/project/src/index.ts",
    );
    assert.doesNotMatch(said, /[#*`]|https?:|console\.log|\/Users/);
    assert.match(said, /Result\./);
    assert.match(said, /Step one\. Step two\./);
    assert.match(said, /index\.ts/);
});

test("cleanForSpeech cuts at a sentence boundary", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i}.`).join(" ");
    const said = cleanForSpeech(long, 120);
    assert.ok(said.length <= 121, said);
    assert.match(said, /\.$/);
});

test("firstSentences returns the first clean sentences", () => {
    assert.equal(firstSentences("I'm done. The tests pass. Deploy is pending.", 2), "I'm done. The tests pass.");
    assert.equal(firstSentences("", 2), "");
});

test("SentenceBuffer starts with a short chunk, then waits for longer ones", () => {
    const out = [];
    const buffer = new SentenceBuffer((chunk) => out.push(chunk));
    buffer.push("Sure. I'm running");
    assert.deepEqual(out, [], "a 6-character first sentence is too short to start with");
    buffer.push(" the unit tests now. Then I'll open");
    assert.deepEqual(out, ["Sure. I'm running the unit tests now."]);
    buffer.push(" a **pull request** with `the fix`.");
    assert.equal(out.length, 1, "later chunks wait for ~160 characters or the end");
    buffer.end();
    assert.deepEqual(out, ["Sure. I'm running the unit tests now.", "Then I'll open a pull request with the fix."]);
    buffer.push("Ignored after end.");
    assert.equal(out.length, 2);
});

test("SentenceBuffer splits run-on text and respects its budget", () => {
    const out = [];
    const buffer = new SentenceBuffer((chunk) => out.push(chunk));
    buffer.push(`${"word ".repeat(120)}`);
    assert.equal(out.length, 1, "no punctuation: cut at a space before the hard limit");
    assert.ok(out[0].length <= 421, out[0].length);
    const small = [];
    const capped = new SentenceBuffer((chunk) => small.push(chunk), { maxChars: 60 });
    for (let i = 0; i < 20; i++) capped.push(`This is sentence number ${i} of many. `);
    capped.end();
    assert.ok(small.join(" ").length <= 70, small.join(" "));
});

test("frameQuestion asks for the reply language, status, recent history and the question", () => {
    const prompt = frameQuestion({
        question: "¿Cómo vas?",
        lang: "es",
        status: "working for 3 min",
        history: [
            { q: "one", a: "answer one" },
            { q: "two", a: "answer two" },
            { q: "three", a: "answer three" },
            { q: "four", a: "answer four" },
        ],
    });
    assert.match(prompt, /^\[Octovox\]/);
    assert.match(prompt, /side question/);
    assert.match(prompt, /Reply in Spanish/);
    assert.match(prompt, /Status observed by Octovox: working for 3 min\./);
    assert.doesNotMatch(prompt, /answer one/);
    assert.match(prompt, /answer four/);
    assert.match(prompt, /User's question: "¿Cómo vas\?"$/);
    assert.match(frameQuestion({ question: "Wie läuft's?", lang: "de" }), /Reply in German/);
    assert.match(frameQuestion({ question: "Come va?", lang: null }), /Reply in the same language as the user's question/);
    const withOthers = frameQuestion({ question: "How are my sessions?", others: ["API: working for 2 min"] });
    assert.match(withOthers, /other open sessions[^\n]*\n- API: working for 2 min/);
    assert.doesNotMatch(prompt, /other open sessions/);
});

test("describeStatus summarises pending items, activity and tasks", () => {
    const text = describeStatus({
        processing: true,
        busyForMs: 125_000,
        activity: "bash · Run tests",
        todos: { total: 5, done: 2 },
        pending: { input: { question: "Which database should I use?" } },
    });
    assert.match(text, /waiting for the user to answer: "Which database should I use\?"/);
    assert.match(text, /working for 2 min/);
    assert.match(text, /right now: bash · Run tests/);
    assert.match(text, /tasks: 2 of 5 done/);
    assert.equal(describeStatus({ processing: false, pending: {} }), "idle");
});

test("formatDuration and summarizeTool", () => {
    assert.equal(formatDuration(42_000), "42 s");
    assert.equal(formatDuration(5 * 60_000), "5 min");
    assert.equal(formatDuration(65 * 60_000), "1 h 5 min");
    assert.equal(summarizeTool("bash", { command: "secret --token x", description: "Run tests" }), "bash · Run tests");
    assert.equal(summarizeTool("view", { path: "/a/b/c.txt" }), "view · c.txt");
    assert.equal(summarizeTool("bash", { command: "curl -H 'Authorization: x'" }), "bash");
});
