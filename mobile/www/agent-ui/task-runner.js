// Parallel work for agents: a planner splits a big job into sub-tasks, worker agents
// run them at the same time, each result is checked against what it was meant to
// deliver, and a failed or off-target one is retried with the problem spelled out.
// Wide research uses the same pool to research many items at once into one table.
//
//   CodevTasks.runPool(items, worker, { concurrency, shouldStop })   ordered results
//   CodevTasks.runTaskGraph(tasks, options)       dependencies, verify, retry
//   CodevTasks.wideResearch(deps, args)           items x fields -> rows, with sources
//   CodevTasks.buildTaskTools(deps)               delegate_tasks, wide_research
//   CodevTasks.LIMITS[provider]                   how wide each provider may go
//
// Nothing here talks to a model or the web itself: the page passes in runWorker (a
// whole agent tool loop), ask (one model call), search and read. So the same code is
// tested in Node with stand-ins, and spending limits stay with the page.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevTasks = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    // Groq's free tier has small per-minute token limits, so it goes narrower.
    const LIMITS = {
        groq: { workers: 2, maxTasks: 6, wide: 3, maxItems: 20, pageChars: 1800, pagesPerItem: 1 },
        openrouter: { workers: 4, maxTasks: 10, wide: 6, maxItems: 60, pageChars: 3000, pagesPerItem: 2 },
        anthropic: { workers: 5, maxTasks: 12, wide: 8, maxItems: 100, pageChars: 4000, pagesPerItem: 2 }
    };
    const RESULT_CHARS = 2500;

    // Runs worker(item, index) for every item, at most `concurrency` at a time.
    async function runPool(items, worker, { concurrency = 4, shouldStop = () => false } = {}) {
        const results = new Array(items.length);
        let next = 0;
        const lane = async () => {
            while (next < items.length) {
                const i = next++;
                if (shouldStop()) { results[i] = { ok: false, skipped: true, error: "stopped before it started" }; continue; }
                try { results[i] = { ok: true, value: await worker(items[i], i) }; }
                catch (err) { results[i] = { ok: false, error: err && err.message ? err.message : String(err) }; }
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane));
        return results;
    }

    const FAILED = /^(error|tool failed|i (couldn't|could not|was unable|am unable)|unable to|not run)\b/i;

    // tasks: [{ id, task, depends_on: [ids], expect }]. runTask(task, inputs, attempt, feedback)
    // returns the worker's text; verify(task, text) -> { ok, problem } (optional).
    // A task runs once everything it depends on is done; independent tasks run together.
    async function runTaskGraph(rawTasks, { runTask, verify = null, concurrency = 3, retries = 1, onUpdate = () => {}, shouldStop = () => false } = {}) {
        const seen = new Set();
        const tasks = rawTasks.map((t, i) => {
            let id = String(t.id || `t${i + 1}`).trim().slice(0, 40) || `t${i + 1}`;
            while (seen.has(id)) id += "'";
            seen.add(id);
            return { id, task: String(t.task || t.description || "").trim(), expect: String(t.expect || "").trim(), depends_on: [].concat(t.depends_on || []).map(String), status: "waiting", attempts: 0, result: "", problem: "" };
        });
        const byId = new Map(tasks.map(t => [t.id, t]));
        const notes = [];
        for (const t of tasks) {
            const unknown = t.depends_on.filter(d => !byId.has(d) || d === t.id);
            if (unknown.length) { notes.push(`${t.id}: ignored unknown dependency ${unknown.join(", ")}`); t.depends_on = t.depends_on.filter(d => byId.has(d) && d !== t.id); }
        }
        // A cycle would wait forever: its tasks lose the dependencies that close it.
        const visiting = new Set(), done = new Set();
        const dfs = t => {
            if (done.has(t.id)) return;
            visiting.add(t.id);
            t.depends_on = t.depends_on.filter(d => { if (visiting.has(d)) { notes.push(`${t.id}: dropped dependency ${d} (a cycle)`); return false; } dfs(byId.get(d)); return true; });
            visiting.delete(t.id);
            done.add(t.id);
        };
        tasks.forEach(dfs);
        const update = () => onUpdate(tasks.map(({ id, task, status, attempts, problem }) => ({ id, task, status, attempts, problem })));
        let running = 0;
        await new Promise(resolve => {
            const pump = () => {
                for (const t of tasks) {
                    if (t.status !== "waiting") continue;
                    const deps = t.depends_on.map(d => byId.get(d));
                    if (deps.some(d => d.status === "failed" || d.status === "skipped")) {
                        t.status = "skipped";
                        t.problem = `needs ${deps.filter(d => d.status === "failed" || d.status === "skipped").map(d => d.id).join(", ")}, which did not finish`;
                        continue;
                    }
                    if (!deps.every(d => d.status === "done")) continue;
                    if (shouldStop()) { t.status = "skipped"; t.problem = "stopped (spending limit)"; continue; }
                    if (running >= concurrency) break;
                    running++;
                    t.status = "running";
                    update();
                    execute(t, deps).finally(() => { running--; update(); pump(); });
                }
                update();
                if (!running && !tasks.some(t => t.status === "waiting" || t.status === "running")) resolve();
                else if (!running && tasks.some(t => t.status === "waiting")) {
                    // Nothing can start (shouldn't happen after the cycle check): skip the rest.
                    tasks.filter(t => t.status === "waiting").forEach(t => { t.status = "skipped"; t.problem = "could not start"; });
                    resolve();
                }
            };
            pump();
        });
        async function execute(t, deps) {
            const inputs = deps.map(d => ({ id: d.id, task: d.task, result: d.result }));
            let feedback = "";
            for (let attempt = 1; attempt <= 1 + retries; attempt++) {
                t.attempts = attempt;
                let text = "";
                try { text = String(await runTask(t, inputs, attempt, feedback) || "").trim(); }
                catch (err) { text = `Error: ${err && err.message ? err.message : err}`; }
                let problem = "";
                if (!text) problem = "the worker returned nothing";
                else if (FAILED.test(text)) problem = text.split("\n")[0].slice(0, 300);
                else if (verify && t.expect) {
                    try {
                        const check = await verify(t, text);
                        if (check && check.ok === false) problem = String(check.problem || "it doesn't meet the expected result").slice(0, 400);
                    } catch (err) { /* a broken check doesn't fail good work */ }
                }
                t.result = text;
                if (!problem) { t.status = "done"; t.problem = ""; return; }
                t.problem = problem;
                feedback = `Your previous attempt had a problem: ${problem}\nTry a different approach (another source, query, page or method) and fix it.${text ? `\nWhat you returned last time:\n${text.slice(0, 1200)}` : ""}`;
                if (shouldStop()) break;
            }
            t.status = "failed";
        }
        return { tasks, notes };
    }

    // ---------- Wide research ----------

    function parseJson(text, kind = "object") {
        const s = String(text || "");
        const match = kind === "array" ? s.match(/\[[\s\S]*\]/) : s.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try { return JSON.parse(match[0]); } catch (err) {
            try { return JSON.parse(match[0].replace(/,\s*([}\]])/g, "$1")); } catch (e) { return null; }
        }
    }

    const blank = v => v === null || v === undefined || (typeof v === "string" && (!v.trim() || /^(n\/?a|unknown|not (found|available|stated|given)|none found|-)$/i.test(v.trim())));

    // deps: { search(query) -> { results: [{ title, href, body }], summary }, read(url) -> text,
    //         ask(system, user) -> text, concurrency, pageChars, pagesPerItem, maxItems,
    //         onProgress(state), shouldStop() }
    async function wideResearch(deps, args = {}) {
        const fields = (Array.isArray(args.fields) ? args.fields : String(args.fields || "").split(/\s*,\s*/)).map(f => String(f).trim()).filter(Boolean).slice(0, 15);
        if (!fields.length) throw new Error("wide_research needs fields: the columns to fill for each item");
        const maxItems = Math.max(1, Math.min(deps.maxItems || 50, Number(args.max_items) || deps.maxItems || 50));
        const today = deps.today || new Date().toDateString();
        const stats = { searches: 0, pages: 0, modelCalls: 0 };
        const progress = { phase: "", done: 0, total: 0, current: [] };
        const show = () => deps.onProgress && deps.onProgress({ ...progress, current: progress.current.slice() });
        const search = async q => { stats.searches++; try { return await deps.search(q); } catch (err) { return { results: [], summary: "", error: err.message }; } };
        const ask = async (system, user) => { stats.modelCalls++; return deps.ask(system, user); };
        const read = async url => { stats.pages++; try { return String(await deps.read(url) || ""); } catch (err) { return ""; } };

        // 1. The list of items: given, or found from a description of the list.
        let items = (Array.isArray(args.items) ? args.items : []).map(i => String(typeof i === "object" && i ? i.name || i.item || JSON.stringify(i) : i).trim()).filter(Boolean);
        let listSources = [];
        if (!items.length) {
            const what = String(args.discover || args.list || "").trim();
            if (!what) throw new Error("wide_research needs items (a list of names) or discover (what list to build, like \"the 30 largest US credit unions\")");
            progress.phase = `Finding the list: ${what}`; show();
            const queries = [what, `${what} list ${new Date().getFullYear()}`];
            const found = [];
            for (const q of queries) {
                const r = await search(q);
                found.push(r);
            }
            const top = found.flatMap(r => r.results || []).filter((r, i, all) => all.findIndex(o => o.href === r.href) === i).slice(0, deps.pagesPerItem > 1 ? 3 : 2);
            const texts = await Promise.all(top.map(r => read(r.href)));
            listSources = top.map(r => r.href);
            const notes = found.map(r => r.summary || "").concat(found.flatMap(r => (r.results || []).map(x => `${x.title}: ${x.body}`)), texts.map((t, i) => `[${top[i].href}]\n${t.slice(0, deps.pageChars || 3000)}`)).join("\n\n").slice(0, 16000);
            const list = parseJson(await ask(`Today is ${today}. From the notes, list the items the user asked for. Reply with only a JSON array of up to ${maxItems} distinct item names (strings), most relevant first. Use names exactly as the sources give them. No other text.`, `List wanted: ${what}\n\nNotes:\n${notes}`), "array");
            items = Array.isArray(list) ? list.map(x => String(typeof x === "object" && x ? x.name || Object.values(x)[0] : x).trim()).filter(Boolean) : [];
            if (!items.length) throw new Error(`couldn't build the list "${what}" from the search results; give items instead`);
        }
        items = [...new Set(items)].slice(0, maxItems);
        const context = String(args.question || args.context || "").trim();
        progress.total = items.length;
        progress.phase = `Researching ${items.length} item(s), ${deps.concurrency || 4} at a time`; show();

        const fieldList = fields.map(f => `"${f}"`).join(", ");
        const extract = async (item, wanted, sources) => {
            const notes = sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.href}\n${s.text || s.body || ""}`).join("\n\n");
            const reply = await ask(
                `Today is ${today}. You fill one row of a research table from the numbered sources only. Reply with only a JSON object with these keys: ${wanted.map(f => `"${f}"`).join(", ")}, and "_sources": the numbers of the sources you used. `
                + "Each value is short (a number, name, date or a phrase under 20 words), copied or computed from the sources. Use null when the sources don't say; never guess. Keep units and currency.",
                `Item: ${item}${context ? `\nWhat the user wants to know: ${context}` : ""}\n\nSources:\n${notes}`);
            const obj = parseJson(reply) || {};
            const used = [].concat(obj._sources || []).map(n => sources[Number(n) - 1]).filter(Boolean).map(s => s.href);
            return { values: obj, used };
        };
        const gather = async (query, take) => {
            const r = await search(query);
            const picks = (r.results || []).slice(0, take);
            const sources = await Promise.all(picks.map(async p => ({ title: p.title, href: p.href, body: p.body, text: (await read(p.href)).slice(0, deps.pageChars || 3000) })));
            // Search snippets count too: often they already hold the number.
            for (const p of (r.results || []).slice(take, take + 3)) sources.push({ title: p.title, href: p.href, body: p.body });
            if (r.summary) sources.unshift({ title: "Search summary", href: "", body: r.summary });
            return sources;
        };
        const research = async item => {
            progress.current.push(item); show();
            try {
                const take = deps.pagesPerItem || 2;
                const first = await gather(`${item} ${context || fields.join(" ")}`.slice(0, 200), take);
                const row = {};
                const cites = new Set();
                let got = await extract(item, fields, first);
                fields.forEach(f => { if (!blank(got.values[f])) row[f] = got.values[f]; });
                got.used.forEach(u => u && cites.add(u));
                // Self-correction: one more targeted search for what's still missing.
                const missing = fields.filter(f => blank(row[f]));
                let retried = false;
                if (missing.length && !(deps.shouldStop && deps.shouldStop())) {
                    retried = true;
                    const more = await gather(`${item} ${missing.join(" ")}`.slice(0, 200), 1);
                    got = await extract(item, missing, more);
                    missing.forEach(f => { if (!blank(got.values[f])) row[f] = got.values[f]; });
                    got.used.forEach(u => u && cites.add(u));
                }
                const still = fields.filter(f => blank(row[f]));
                return { item, row, sources: [...cites], missing: still, retried };
            } finally {
                progress.current = progress.current.filter(i => i !== item);
                progress.done++;
                show();
            }
        };
        const results = await runPool(items, research, { concurrency: deps.concurrency || 4, shouldStop: deps.shouldStop || (() => false) });
        const columns = ["item", ...fields, "sources"];
        const rows = results.map((r, i) => (r.ok
            ? [items[i], ...fields.map(f => r.value.row[f] ?? null), r.value.sources.join(" ")]
            : [items[i], ...fields.map(() => null), r.skipped ? "(not researched: stopped)" : `(failed: ${r.error})`]));
        const complete = results.filter(r => r.ok && !r.value.missing.length).length;
        const partial = results.filter(r => r.ok && r.value.missing.length && r.value.missing.length < fields.length).length;
        const empty = results.filter(r => r.ok && r.value.missing.length === fields.length).length;
        const failed = results.filter(r => !r.ok).length;
        const fill = fields.map(f => ({ field: f, filled: results.filter(r => r.ok && !blank(r.value.row[f])).length }));
        return { columns, rows, items, fields, listSources, stats: { ...stats, items: items.length, complete, partial, empty, failed, retried: results.filter(r => r.ok && r.value.retried).length, fill } };
    }

    // ---------- The agents' tools ----------

    // deps: { runWorker(task, inputs, attempt, feedback, ctx) -> text, verify(task, text, ctx) -> {ok, problem},
    //         limits(), wideDeps(ctx) -> deps for wideResearch, datasets, previewTable, shouldStop(ctx) }
    function buildTaskTools(deps) {
        const tools = [];
        tools.push({
            name: "delegate_tasks",
            description: "Split a big job into independent sub-tasks and run them with parallel worker agents (planner/executor). Each worker has your tools (web search, pages, browser, files, code), works on its own sub-task, and reports back; "
                + "its result is checked against expect and retried with the problem if it falls short. Use depends_on to run a step after the ones it needs (it gets their results). "
                + "Use it for multi-part research, comparing many options, building several parts of a project at once, or any job with 3+ separable steps. You then check, combine and finish the results. "
                + "Give each worker everything it needs in its task text (it can't see this chat), and separate files or topics so workers don't collide. Workers' browsers start signed out.",
            inputSchema: { type: "object", properties: {
                tasks: { type: "array", description: "The sub-tasks.", items: { type: "object", properties: {
                    id: { type: "string", description: "Short id, like \"pricing\"." },
                    task: { type: "string", description: "Self-contained instructions for the worker." },
                    expect: { type: "string", description: "What a finished result must contain, so it can be checked (like \"a price and a source URL for each of the 5 plans\")." },
                    depends_on: { type: "array", items: { type: "string" }, description: "Ids of tasks whose results this one needs." }
                }, required: ["task"] } }
            }, required: ["tasks"] },
            run: async (args, ctx) => {
                const limits = deps.limits();
                const list = Array.isArray(args.tasks) ? args.tasks.filter(t => t && String(t.task || "").trim()) : [];
                if (!list.length) return "Error: delegate_tasks needs tasks, each with task text.";
                const taken = list.slice(0, limits.maxTasks);
                const board = new Map();
                const draw = () => {
                    if (!ctx.onStep) return;
                    const icon = { waiting: "○", running: "▶", done: "✓", failed: "⚠️", skipped: "⏭" };
                    ctx.onStep(`🧩 ${taken.length} worker task(s), ${limits.workers} at a time\n${[...board.values()].map(t => `${icon[t.status] || "○"} ${t.id}: ${t.task.slice(0, 70)}${t.attempts > 1 ? ` (try ${t.attempts})` : ""}${t.status === "failed" && t.problem ? ` → ${t.problem.slice(0, 60)}` : ""}`).join("\n")}`);
                };
                const { tasks, notes } = await runTaskGraph(taken, {
                    concurrency: limits.workers,
                    retries: 1,
                    shouldStop: () => deps.shouldStop(ctx),
                    runTask: (task, inputs, attempt, feedback) => deps.runWorker(task, inputs, attempt, feedback, ctx),
                    verify: deps.verify ? (task, text) => deps.verify(task, text, ctx) : null,
                    onUpdate: state => { state.forEach(s => board.set(s.id, s)); draw(); }
                });
                const doneCount = tasks.filter(t => t.status === "done").length;
                const per = Math.max(600, Math.floor(RESULT_CHARS * 4 / tasks.length));
                return [
                    `${doneCount} of ${tasks.length} worker task(s) finished${list.length > taken.length ? ` (${list.length - taken.length} more were dropped: ${limits.maxTasks} is the most at once on this provider)` : ""}.`,
                    ...notes.map(n => `Note: ${n}`),
                    ...tasks.map(t => `\n## ${t.id} — ${t.status}${t.attempts > 1 ? ` after ${t.attempts} tries` : ""}\nTask: ${t.task.slice(0, 200)}${t.problem ? `\nProblem: ${t.problem}` : ""}\nResult:\n${t.result ? t.result.slice(0, per) : "(none)"}`),
                    "\nCheck the results against each other, redo or delegate again only what failed, then finish the job."
                ].join("\n");
            }
        });
        tools.push({
            name: "wide_research",
            description: "Research many items at once (companies, products, people, places, papers, stocks, schools...) and fill the same fields for each, in parallel: dozens of searches and pages in one call instead of one by one. "
                + "Give items, or discover to have CoDev build the list first (\"the 25 largest US banks\"). Every row has its sources; fields the sources don't give stay empty (never guessed), and each item with gaps gets a second, targeted search. "
                + "The table is saved as a dataset for create_spreadsheet / create_csv; you get a preview. "
                + "Use it whenever the user wants the same facts about 5 or more things; for one or two items use web_search and read_webpage instead, and for jobs whose parts differ use delegate_tasks.",
            inputSchema: { type: "object", properties: {
                items: { type: "array", items: { type: "string" }, description: "The items to research, like [\"Stripe\", \"Adyen\", \"Square\"]." },
                discover: { type: "string", description: "Instead of items: what list to build from the web, like \"top 30 AI startups by funding in 2026\"." },
                fields: { type: "array", items: { type: "string" }, description: "The columns to fill for each item, like [\"founded\", \"headquarters\", \"latest funding round\", \"CEO\"]." },
                question: { type: "string", description: "Optional: what the research is for, to steer the searches." },
                max_items: { type: "integer", description: "Optional: at most this many items." },
                name: { type: "string", description: "Optional: a name for the dataset." }
            }, required: ["fields"] },
            run: async (args, ctx) => {
                const wd = deps.wideDeps(ctx);
                let out;
                try { out = await wideResearch(wd, args); } catch (err) { return `Error: ${err.message}.`; }
                const ds = deps.datasets ? deps.datasets.add({ name: args.name || (args.discover ? `Research: ${args.discover}` : `Research: ${args.fields.join(", ")}`), columns: out.columns, rows: out.rows, source: "wide_research" }) : null;
                if (ctx.sources) for (const href of new Set(out.rows.flatMap(r => String(r[r.length - 1] || "").split(" ")).filter(h => /^https?:/.test(h)))) if (!ctx.sources.some(s => s.href === href)) ctx.sources.push({ title: href.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60), href });
                const s = out.stats;
                return [
                    `Researched ${s.items} item(s) in parallel: ${s.complete} complete, ${s.partial} partly filled, ${s.empty} with nothing found${s.failed ? `, ${s.failed} failed` : ""}. ${s.searches} searches, ${s.pages} pages read, ${s.modelCalls} model calls; ${s.retried} item(s) got a second search for missing fields.`,
                    `Filled per field: ${s.fill.map(f => `${f.field} ${f.filled}/${s.items}`).join(", ")}.`,
                    ds ? `Saved as dataset ${ds.id} (${ds.rows.length} rows). Put it in a file with create_spreadsheet (sheet dataset "${ds.id}") or create_csv.` : "",
                    out.listSources.length ? `The list came from: ${out.listSources.join(" ")}` : "",
                    "",
                    deps.previewTable(out.columns.slice(0, -1), out.rows.map(r => r.slice(0, -1)), 15),
                    "",
                    "Empty cells mean the sources didn't say: report them as unknown, don't fill them from memory."
                ].filter((l, i) => l || i > 0).join("\n");
            }
        });
        return tools;
    }

    const TOOL_NAMES = ["delegate_tasks", "wide_research"];

    function describe(name, args = {}) {
        if (name === "delegate_tasks") return `🧩 Running ${Array.isArray(args.tasks) ? args.tasks.length : ""} sub-tasks with parallel workers`.replace(/\s+/g, " ");
        if (name === "wide_research") return `🌐 Wide research: ${Array.isArray(args.items) && args.items.length ? `${args.items.length} items` : args.discover || "items"} × ${Array.isArray(args.fields) ? args.fields.length : 0} fields`;
        return "";
    }

    const TASK_RULES = "[Parallel work] For a job with several separable parts, plan it, then call delegate_tasks so worker agents do the parts at the same time; check their results and finish. To collect the same facts about many items (a list of companies, products, people...), call wide_research instead of searching one by one, then put the dataset in a spreadsheet if the user wants a file.";

    return { LIMITS, TOOL_NAMES, TASK_RULES, runPool, runTaskGraph, wideResearch, buildTaskTools, describe, parseJson };
});
