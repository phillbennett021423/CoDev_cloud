// The check-and-fix loop after agents change code: an engine gate CoDev runs itself, a QA
// agent that starts from a clean context, and a run log that later tasks learn from.
//
//   CodevQaLoop.runEngineGate({ changes, staticCheck, validate })
//       Godot files among the changes get the static godot_check and, when Godot is
//       installed, the real engine headless (godot --headless --check-only, through
//       godot_validate). Returns { applies, ok, ran, report }. CoDev runs it, not the
//       model, so a Godot change is never "done" while the engine rejects it.
//   CodevQaLoop.qaBrief({ task, changes, commands, gate, claims, round })
//       The QA agent's whole input: the task, the changed files, what was run, the gate's
//       findings and a short summary of what the coder says it did. Not the chat, not the
//       web results, not the coder's reasoning: the reviewer judges the code, not the story.
//   CodevQaLoop.runLogEntry(...) / parseRunLog(md) / runLessons(entries, task)
//       codev/runlog.md in the project: per task, what failed and what fixed it. Later
//       tasks on the same files get those lessons in their prompt.
//
// The same file runs in the page and in Node (tests).
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevQaLoop = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const GODOT_FILE = /\.(gd|tscn|tres|gdshader|gdshaderinc|cs)$/i;
    const GATE_ROUNDS = 3;
    const RUN_LOG_FILE = "codev/runlog.md";
    const MAX_REPORT_CHARS = 6000;

    const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}\n[cut at ${n} characters]` : text);

    // Prose and notes: a story bible, a README, a script. No code runs from them, so the QA
    // pass (which re-reads every changed file) is skipped when nothing else changed.
    const DOCUMENT_FILE = /\.(md|markdown|mdx|txt|text|rst|adoc|asciidoc|org|fountain|rtf|tex)$/i;
    function documentsOnly(paths) {
        const files = (paths || []).map(p => String(p).replace(/\\/g, "/"));
        return files.length > 0 && files.every(p => DOCUMENT_FILE.test(p));
    }

    function godotChanges(paths) {
        return [...new Set((paths || []).map(p => String(p).replace(/\\/g, "/")))].filter(p => GODOT_FILE.test(p));
    }

    // godot_check's report: "path:line [error] message" lines.
    function staticErrors(report) {
        return String(report || "").split("\n").filter(line => /\[error\]/.test(line));
    }

    // godot_validate's report: "N problem(s) found." or "No errors.", ✗ lines with what Godot printed.
    function validateResult(result) {
        const text = String(result && result.text != null ? result.text : result || "");
        if (!text) return { ran: false, failed: 0, lines: [], note: "" };
        if (result && result.isError) return { ran: false, failed: 0, lines: [], note: text.split("\n")[0] };
        const m = text.match(/^(\d+) problem\(s\) found\./m);
        const failed = m ? Number(m[1]) : 0;
        const lines = [];
        const all = text.split("\n");
        all.forEach((line, i) => {
            if (/^✗ /.test(line) || /^Main scene run for/.test(line)) {
                lines.push(line);
                for (let j = i + 1; j < all.length && /^\s{2}\S/.test(all[j]); j++) lines.push(all[j]);
            }
        });
        return { ran: true, failed, lines, note: "" };
    }

    // deps.staticCheck(path) -> godot_check's text; deps.validate(files) -> { text, isError } or null when unavailable.
    async function runEngineGate({ changes, staticCheck, validate }) {
        const files = godotChanges(changes);
        if (!files.length) return { applies: false, ok: true, ran: [], report: "" };
        const ran = [];
        const parts = [];
        let ok = true;
        if (staticCheck) {
            const errors = [];
            for (const file of files) {
                try { errors.push(...staticErrors(await staticCheck(file))); } catch (err) { /* the index isn't there: the engine still checks */ }
            }
            ran.push("godot_check");
            if (errors.length) { ok = false; parts.push(`Static check (godot_check): ${errors.length} error(s)\n${errors.slice(0, 60).join("\n")}`); }
            else parts.push("Static check (godot_check): no errors.");
        }
        const scripts = files.filter(f => /\.gd$/i.test(f));
        if (validate && scripts.length) {
            let result = null;
            try { result = await validate(scripts); } catch (err) { result = { text: err.message, isError: true }; }
            const v = validateResult(result);
            if (v.ran) {
                ran.push("godot --headless --check-only");
                if (v.failed) { ok = false; parts.push(`Godot engine (headless --check-only): ${v.failed} problem(s)\n${v.lines.slice(0, 60).join("\n")}`); }
                else parts.push(`Godot engine (headless --check-only): ${scripts.length} script(s) load with no errors.`);
            } else if (v.note) parts.push(`Godot engine: not run (${v.note})`);
        }
        return { applies: true, ok, ran, files, report: clip(parts.join("\n\n"), MAX_REPORT_CHARS) };
    }

    const QA_RULES = `[QA rules] You are the independent reviewer. You did not write this code and you have not seen the conversation that produced it; judge only the code as it is on disk.
- Read every changed file. Look for what is broken: errors the checks report, code that can't run, wrong APIs for the engine version, broken references between scripts and scenes, the task not actually done.
- Fix each problem with the smallest patch that makes it right. Don't refactor, rename, restyle or add features; don't rewrite a file to fix a line.
- Run the project's tests, build or checks when a command tool exists; for Godot files, godot_check (and godot_validate when it's available) on what you touched.
- The task is the user's own decision, above all on their creative work (story, lore, names, canon): check that it was done correctly, never undo it or report it as a problem.
- If everything is right, change nothing and say so. Finish with: what you checked, each problem found with file:line, the patch for each, and anything still failing.`;

    function qaBrief({ task, changes = [], commands = [], gate = null, claims = [], round = 1 }) {
        const parts = [`Review and repair the changes just made for this task: ${task}`];
        if (changes.length) parts.push(`[Changed files]\n${[...new Set(changes)].join("\n")}`);
        if (commands.length) parts.push(`[Commands the coder ran]\n${commands.slice(-12).join("\n")}`);
        if (gate && gate.applies) parts.push(`[Engine checks CoDev ran${round > 1 ? ` after QA round ${round - 1}` : ""}] ${gate.ok ? "passed" : "FAILED: fix these first"}\n${gate.report}`);
        // The coder's own summary, short: what it says it did, to check against the code.
        const said = claims.filter(Boolean).map(c => String(c).replace(/\s+/g, " ").trim().slice(0, 500));
        if (said.length) parts.push(`[What the coder says it did (claims to verify, not facts)]\n${said.join("\n")}`);
        parts.push(QA_RULES);
        return parts.join("\n\n");
    }

    // ---------------------------------------------------------------- run log

    function runLogEntry({ date, task, files = [], failures = [], fixes = "", outcome = "" }) {
        const line = s => String(s || "").replace(/\s+/g, " ").trim();
        return [`## ${date}: ${line(task).slice(0, 120)}`,
            files.length ? `**Files:** ${[...new Set(files)].slice(0, 20).join(", ")}` : "",
            failures.length ? `**Failed:** ${failures.map(f => line(f).slice(0, 200)).slice(0, 8).join(" | ")}` : "",
            fixes ? `**Fixed by:** ${line(fixes).slice(0, 600)}` : "",
            `**Outcome:** ${line(outcome) || "unknown"}`].filter(Boolean).join("\n") + "\n";
    }

    function parseRunLog(md) {
        return String(md || "").split(/^## /m).slice(1).map(part => {
            const [head, ...rest] = part.split("\n");
            const body = rest.join("\n");
            const field = label => { const m = body.match(new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.*)$`, "mi")); return m ? m[1].trim() : ""; };
            const m = head.match(/^(\d{4}-\d{2}-\d{2})\s*:?\s*(.*)$/);
            return { date: m ? m[1] : "", task: m ? m[2] : head, files: field("Files").split(/,\s*/).filter(Boolean), failed: field("Failed"), fixedBy: field("Fixed by"), outcome: field("Outcome") };
        });
    }

    // Past runs on the same files, or about the same thing, that hit a failure: what broke
    // and what fixed it. Clean runs teach nothing and stay out of the prompt.
    function runLessons(entries, task, files = [], maxChars = 2500) {
        const want = new Set((String(task).toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) || []));
        const touched = new Set(files);
        const scored = entries.map((e, i) => {
            if (!e.failed) return null;
            let score = e.files.filter(f => touched.has(f) || [...want].some(w => f.toLowerCase().includes(w))).length * 3;
            for (const w of String(`${e.task} ${e.failed}`).toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) || []) if (want.has(w)) score++;
            return score ? { e, score, i } : null;
        }).filter(Boolean).sort((a, b) => b.score - a.score || b.i - a.i);
        const out = [];
        let used = 0;
        for (const { e } of scored) {
            const line = `- ${e.date} "${e.task}": failed with ${e.failed}${e.fixedBy ? `; fixed by ${e.fixedBy}` : ""}${e.outcome ? ` (${e.outcome})` : ""}`;
            if (used + line.length > maxChars) break;
            out.push(line);
            used += line.length;
        }
        return out.length ? `[Lessons from earlier runs] Past tasks on this project hit these failures (${RUN_LOG_FILE}). Avoid repeating them:\n${out.join("\n")}` : "";
    }

    // Tools a planning step may use: the ones that only read.
    const WRITE_NAME = /(^|_)(write|edit|delete|remove|run|submit|save|send|install|apply|create|generate|restore|train|move|import|dress|play)(_|$)/;
    function readOnlyTools(tools) {
        return (tools || []).filter(t => (t.annotations && t.annotations.readOnlyHint) || !WRITE_NAME.test(String(t.name).replace(/^.*__/, "")));
    }

    return { GODOT_FILE, DOCUMENT_FILE, GATE_ROUNDS, RUN_LOG_FILE, QA_RULES, documentsOnly, godotChanges, staticErrors, validateResult, runEngineGate, qaBrief, runLogEntry, parseRunLog, runLessons, readOnlyTools };
});
