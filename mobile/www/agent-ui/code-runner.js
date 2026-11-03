// Runs Python and JavaScript inside the user's browser, so the agents can calculate,
// analyze data, draw charts and check code anywhere CoDev runs: the web page, the
// Android app, the Windows app and start-codev.bat. Nothing goes to a server.
//
//   CodevCodeRunner.createCodeRunner(deps)  { run({ language, code, timeout_seconds, files }), reset(), WORKER_SOURCE }
//   CodevCodeRunner.buildCodeTools(deps)    the run_code tool for the agents
//   CodevCodeRunner.formatResult(result)    the text the model reads back
//
// Python is Pyodide (CPython compiled to WebAssembly), loaded from jsDelivr the first
// time it's used (about 10 MB, then cached by the browser). Packages it ships (numpy,
// pandas, matplotlib, scipy, scikit-learn, sympy and more) load on import. Charts made
// with matplotlib come back as pictures, and files saved in /out come back as
// downloads. JavaScript runs in its own worker with no page, cookies or keys.
//
// Each language keeps one worker, so variables last between calls in the same page
// (like a notebook). A run that goes over its time is stopped and the worker is
// started fresh, which also clears those variables.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevCodeRunner = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const PYODIDE_VERSION = "0.26.4";
    const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
    const DEFAULT_TIMEOUT_S = 30;
    const MAX_TIMEOUT_S = 120;
    const LOAD_TIMEOUT_MS = 120000;
    const MAX_OUTPUT = 12000;
    const MAX_IMAGES = 4;
    const MAX_OUT_FILES = 5;
    const MAX_OUT_FILE_BYTES = 20 * 1024 * 1024;

    // Runs inside the worker. It must not use anything from this file's scope.
    function workerMain(pyodideUrl) {
        let pyodideReady = null;
        let out = [];
        const write = (stream, text) => out.push({ stream, text: String(text) });
        const show = v => {
            if (typeof v === "string") return v;
            try { return JSON.stringify(v, (k, x) => (typeof x === "bigint" ? `${x}n` : x), 2) ?? String(v); } catch (err) { return String(v); }
        };

        function loadPython() {
            if (!pyodideReady) {
                pyodideReady = (async () => {
                    importScripts(`${pyodideUrl}pyodide.js`);
                    const py = await self.loadPyodide({ indexURL: pyodideUrl });
                    py.setStdout({ batched: line => write("stdout", line + "\n") });
                    py.setStderr({ batched: line => write("stderr", line + "\n") });
                    py.runPython("import os\nos.environ['MPLBACKEND'] = 'AGG'\nos.makedirs('/data', exist_ok=True)\nos.makedirs('/out', exist_ok=True)");
                    return py;
                })();
                pyodideReady.catch(() => { pyodideReady = null; });
            }
            return pyodideReady;
        }

        async function runPython(job) {
            self.postMessage({ id: job.id, type: "phase", phase: "loading" });
            const py = await loadPython();
            for (const f of job.files || []) {
                const dir = f.path.slice(0, f.path.lastIndexOf("/"));
                if (dir) py.FS.mkdirTree(dir);
                py.FS.writeFile(f.path, f.text);
            }
            py.runPython("import os, shutil\nfor _n in os.listdir('/out'):\n    _p = os.path.join('/out', _n)\n    shutil.rmtree(_p) if os.path.isdir(_p) else os.remove(_p)");
            await py.loadPackagesFromImports(job.code, { messageCallback: () => {}, errorCallback: m => write("stderr", m + "\n") });
            self.postMessage({ id: job.id, type: "phase", phase: "running" });
            let result;
            let error = null;
            try {
                const value = await py.runPythonAsync(job.code);
                if (value !== undefined && value !== null) {
                    result = typeof value === "boolean" ? (value ? "True" : "False") : typeof value === "object" && value.toString ? value.toString() : String(value);
                    if (value && typeof value.destroy === "function") value.destroy();
                }
            } catch (err) {
                // The last lines of a Python traceback say what went wrong.
                error = String(err && err.message || err).split("\n").filter(l => !/^\s*File "\/lib\/python|_pyodide|pyodide\/|^\s*\^+\s*$/.test(l)).slice(-12).join("\n");
            }
            const images = [];
            try {
                const figs = py.runPython(`
import sys
_figs = []
if 'matplotlib.pyplot' in sys.modules:
    import io, base64
    import matplotlib.pyplot as _plt
    for _num in _plt.get_fignums()[:${4}]:
        _buf = io.BytesIO()
        _plt.figure(_num).savefig(_buf, format='png', dpi=110, bbox_inches='tight')
        _figs.append(base64.b64encode(_buf.getvalue()).decode())
    _plt.close('all')
_figs`);
                images.push(...figs.toJs());
                figs.destroy();
            } catch (err) { /* no charts */ }
            const files = [];
            for (const name of py.FS.readdir("/out")) {
                if (name === "." || name === "..") continue;
                const stat = py.FS.stat(`/out/${name}`);
                if (py.FS.isDir(stat.mode)) continue;
                files.push({ name, bytes: py.FS.readFile(`/out/${name}`) });
            }
            return { result, error, images, files };
        }

        async function runJavaScript(job) {
            self.postMessage({ id: job.id, type: "phase", phase: "running" });
            const log = stream => (...args) => write(stream, args.map(show).join(" ") + "\n");
            const sandboxConsole = { log: log("stdout"), info: log("stdout"), debug: log("stdout"), table: log("stdout"), warn: log("stderr"), error: log("stderr") };
            const files = Object.fromEntries((job.files || []).map(f => [f.path.replace(/^\/data\//, ""), f.text]));
            try {
                // The last expression is the result, as in a console, when it can be.
                const body = String(job.code);
                let fn = null;
                const lines = body.trimEnd().replace(/;\s*$/, "").split("\n");
                const lastLine = lines.pop() || "";
                const cut = lastLine.lastIndexOf(";");
                // The whole last line, or what follows its last semicolon ("a(); b").
                const tries = [[lines.join("\n"), lastLine]];
                if (cut > 0) tries.push([`${lines.join("\n")}\n${lastLine.slice(0, cut + 1)}`, lastLine.slice(cut + 1)]);
                for (const [head, last] of tries) {
                    if (fn || !last.trim() || /^\s*(\}|\)|\]|\/\/|let |const |var |function |class |if |for |while |do |switch |return |throw |try |import |export )/.test(last) || /\{\s*$/.test(last)) continue;
                    try { fn = new Function("console", "files", `return (async () => {\n${head}\nreturn (${last});\n})();`); } catch (err) { fn = null; }
                }
                if (!fn) fn = new Function("console", "files", `return (async () => {\n${body}\n})();`);
                const value = await fn(sandboxConsole, files);
                return { result: value === undefined ? undefined : show(value), images: [], files: [] };
            } catch (err) {
                return { error: `${err && err.name || "Error"}: ${err && err.message || err}`, images: [], files: [] };
            }
        }

        self.onmessage = async event => {
            const job = event.data;
            out = [];
            let reply;
            try {
                reply = job.language === "python" ? await runPython(job) : await runJavaScript(job);
            } catch (err) {
                reply = { error: `${job.language === "python" ? "Python couldn't start" : "Error"}: ${err && err.message || err}`, setup: true, images: [], files: [] };
            }
            const stdout = out.filter(o => o.stream === "stdout").map(o => o.text).join("");
            const stderr = out.filter(o => o.stream === "stderr").map(o => o.text).join("");
            const transfer = (reply.files || []).map(f => f.bytes.buffer);
            self.postMessage({ id: job.id, type: "done", stdout, stderr, ...reply }, transfer);
        };
    }

    const workerSource = pyodideUrl => `(${workerMain.toString()})(${JSON.stringify(pyodideUrl)});`;
    const WORKER_SOURCE = workerSource(PYODIDE_URL);

    const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters cut)` : text);

    function formatResult(r) {
        const parts = [];
        if (r.timedOut) parts.push(`Error: the code was stopped after ${r.timeoutSeconds} seconds, and its variables were cleared. Make it faster or work on less data, or pass a longer timeout_seconds (up to ${MAX_TIMEOUT_S}).`);
        else if (r.error) parts.push(`Error:\n${clip(r.error, 3000)}`);
        if (r.stdout) parts.push(`Output:\n${clip(r.stdout, MAX_OUTPUT)}`);
        if (r.stderr) parts.push(`Warnings and errors printed:\n${clip(r.stderr, 3000)}`);
        if (r.result !== undefined && r.result !== null && r.result !== "") parts.push(`Value of the last line:\n${clip(String(r.result), 4000)}`);
        if (r.imageCount) parts.push(`${r.imageCount} chart(s) made; they are shown to the user with your reply. Don't paste links or data for them.`);
        if (r.savedFiles && r.savedFiles.length) parts.push(`Files saved for the user to download: ${r.savedFiles.join(", ")}. They appear under your reply.`);
        if (r.skippedFiles && r.skippedFiles.length) parts.push(`Not kept: ${r.skippedFiles.join(", ")}.`);
        if (!parts.length) parts.push("The code ran and printed nothing. Print what you need to see, or end with the value you want.");
        else if (!r.error && !r.timedOut) parts.unshift(`Ran ${r.language === "python" ? "Python" : "JavaScript"} in ${(r.ms / 1000).toFixed(1)} s.`);
        return parts.join("\n\n");
    }

    // deps: { createWorker(source) -> Worker-like { postMessage, terminate, onmessage, onerror },
    //         pyodideUrl? (a folder with pyodide.js, for tests or a copy served offline), now?() }
    function createCodeRunner(deps) {
        const source = workerSource(deps.pyodideUrl || PYODIDE_URL);
        const now = deps.now || (() => Date.now());
        const workers = {};
        let nextId = 1;

        function workerFor(language) {
            if (!workers[language]) workers[language] = deps.createWorker(source);
            return workers[language];
        }
        function reset(language) {
            for (const lang of language ? [language] : Object.keys(workers)) {
                try { workers[lang] && workers[lang].terminate(); } catch (err) { /* already gone */ }
                delete workers[lang];
            }
        }

        function run({ language, code, timeout_seconds, files }, onPhase) {
            const lang = language === "javascript" ? "javascript" : "python";
            const timeoutSeconds = Math.max(1, Math.min(MAX_TIMEOUT_S, Math.round(Number(timeout_seconds) || DEFAULT_TIMEOUT_S)));
            const worker = workerFor(lang);
            const id = nextId++;
            const started = now();
            return new Promise(resolve => {
                let timer = null;
                const finish = result => {
                    clearTimeout(timer);
                    worker.onmessage = null;
                    worker.onerror = null;
                    resolve({ language: lang, timeoutSeconds, ms: now() - started, ...result });
                };
                const stop = () => { reset(lang); finish({ timedOut: true, stdout: "", stderr: "" }); };
                // Loading Python the first time doesn't count toward the code's own time.
                timer = setTimeout(stop, lang === "python" ? LOAD_TIMEOUT_MS : timeoutSeconds * 1000);
                worker.onmessage = event => {
                    const m = event.data || {};
                    if (m.id !== id) return;
                    if (m.type === "phase") {
                        if (onPhase) onPhase(m.phase);
                        if (m.phase === "running") {
                            clearTimeout(timer);
                            timer = setTimeout(stop, timeoutSeconds * 1000);
                        }
                        return;
                    }
                    if (m.setup) reset(lang);
                    finish(m);
                };
                worker.onerror = event => {
                    reset(lang);
                    finish({ error: `the ${lang} worker stopped: ${(event && event.message) || "unknown error"}`, stdout: "", stderr: "" });
                };
                worker.postMessage({ id, language: lang, code: String(code || ""), files: files || [] });
            });
        }

        return { run, reset, WORKER_SOURCE: source };
    }

    const fileName = name => String(name || "file").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 120);

    function csvOf(sheet) {
        const cell = v => {
            const s = v === null || v === undefined ? "" : String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        return [sheet.columns || [], ...(sheet.rows || [])].map(r => r.map(cell).join(",")).join("\n");
    }

    // The files the user attached in this chat, as files the code can open under /data.
    function attachmentFiles(list) {
        const files = [];
        for (const a of list || []) {
            if (a.sheets && a.sheets.length) {
                const base = fileName(a.name).replace(/\.[^.]+$/, "");
                a.sheets.forEach(s => files.push({ path: `/data/${a.sheets.length > 1 ? `${base} - ${fileName(s.name)}` : base}.csv`, text: csvOf(s) }));
            } else if (a.text) {
                files.push({ path: `/data/${fileName(a.name).replace(/\.pdf$/i, ".txt")}`, text: a.text });
            }
        }
        return files;
    }

    const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", csv: "text/csv", json: "application/json", txt: "text/plain", md: "text/markdown", html: "text/html", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", pdf: "application/pdf", zip: "application/zip" };

    // deps: { runner, attachments(ctx) -> Promise<list>, keepImages(content, toolName, ctx) -> Promise<count>,
    //         saveFile({ name, mime, bytes, kind }) -> Promise<{ id }> }
    function buildCodeTools(deps) {
        return [{
            name: "run_code",
            description: "Run Python or JavaScript in the user's browser and get back what it printed, the value of its last line, any error, charts and files. "
                + "Use it whenever an answer needs exact math, statistics, data analysis, unit or date conversions, simulations, a chart, or checking that a snippet of code really works, instead of working it out in your head. "
                + "Python (the default) has numpy, pandas, matplotlib, scipy, scikit-learn, sympy and the standard library; they load on import. Files the user attached in this chat are in /data (spreadsheets as CSV, PDFs and documents as .txt): list them with os.listdir('/data'). "
                + "Charts drawn with matplotlib are shown to the user; files you save in /out (CSV, PNG, XLSX with openpyxl) become downloads. Variables last between calls until a run times out. "
                + "Don't fetch websites from the code (most block it, and requests isn't there): use web_search and read_webpage for live facts. JavaScript runs in a worker with no page or DOM; attached files are in the files object. "
                + "Don't use it for the user's project folder (use the file and command tools) or to make Excel, PowerPoint or Word deliverables when create_spreadsheet, create_slides or create_document fit.",
            inputSchema: { type: "object", properties: {
                code: { type: "string", description: "The whole program. In Python, print() what you need; the last line's value is returned too, like in a notebook." },
                language: { type: "string", enum: ["python", "javascript"], description: "python (default) or javascript." },
                timeout_seconds: { type: "integer", description: `How long the code may run, in seconds. Default ${DEFAULT_TIMEOUT_S}, at most ${MAX_TIMEOUT_S}. The first Python run also loads Python, which doesn't count.` }
            }, required: ["code"] },
            run: async (args, ctx) => {
                if (!String(args.code || "").trim()) return "Not run: run_code needs code.";
                const language = args.language === "javascript" ? "javascript" : "python";
                let files = [];
                try { files = attachmentFiles(deps.attachments ? await deps.attachments(ctx) : []); } catch (err) { files = []; }
                if (ctx && ctx.onStep) ctx.onStep(language === "python" ? "🐍 Running Python…" : "⚙️ Running JavaScript…");
                const result = await deps.runner.run({ ...args, language, files }, phase => {
                    if (phase === "loading" && ctx && ctx.onStep) ctx.onStep("🐍 Getting Python ready (the first run downloads it, about 10 MB)…");
                });
                if (result.setup) return `Error: ${result.error}. Python downloads from cdn.jsdelivr.net the first time; check the internet connection, or run the code as JavaScript instead.`;
                const images = (result.images || []).slice(0, MAX_IMAGES);
                result.imageCount = images.length && deps.keepImages
                    ? await deps.keepImages(images.map(data => ({ type: "image", data, mimeType: "image/png" })), "chart", ctx)
                    : 0;
                result.savedFiles = [];
                result.skippedFiles = [];
                for (const f of (result.files || []).slice(0, MAX_OUT_FILES)) {
                    const bytes = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes || []);
                    if (bytes.length > MAX_OUT_FILE_BYTES || !deps.saveFile) { result.skippedFiles.push(`${f.name} (over 20 MB)`); continue; }
                    const ext = (f.name.match(/\.([a-z0-9]+)$/i) || [])[1] || "";
                    const record = { name: fileName(f.name), mime: MIME[ext.toLowerCase()] || "application/octet-stream", bytes, kind: ext.toLowerCase() };
                    const saved = await deps.saveFile(record);
                    if (ctx) {
                        ctx.generatedFiles = ctx.generatedFiles || [];
                        ctx.generatedFiles.push({ name: record.name, kind: "file", fileId: saved.id, size: bytes.length, mime: record.mime, format: record.kind });
                    }
                    result.savedFiles.push(record.name);
                }
                if ((result.files || []).length > MAX_OUT_FILES) result.skippedFiles.push(`${result.files.length - MAX_OUT_FILES} more file(s): save at most ${MAX_OUT_FILES} per run`);
                return formatResult(result);
            }
        }];
    }

    return { PYODIDE_URL, DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S, WORKER_SOURCE, createCodeRunner, buildCodeTools, formatResult, attachmentFiles };
});
