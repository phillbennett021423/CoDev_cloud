// Code intelligence for agents: a map of the user's project built on the device from
// its own files, so agents work file by file on big codebases and game projects
// instead of guessing from a few files picked by keyword. Nothing leaves the device.
//
//   CodevCodeIntel.createIndexer(options)       keeps the project's index between requests
//   CodevCodeIntel.buildIndex(files, options)   files = { path: text } -> the index
//   CodevCodeIntel.buildTools(deps)             code_map, find_symbol, file_outline, read_lines,
//                                               architecture_review, godot_check
//   CodevCodeIntel.contextNote(index, request)  a short map for the agent's prompt
//   CodevCodeIntel.engineGuide(text)            the game engine guide, or "" when the task isn't about one
//
// The index holds, per file, its language, symbols (functions, classes, methods,
// GDScript signals and class_names, shader uniforms, scene nodes) with their line
// ranges, and its imports resolved to project paths (import/require, <script src>,
// preload/load("res://..."), extends, .tscn ext_resources, #include, Python modules).
// Symbols are found with per-language patterns, not a compiler, so the tools say
// "likely" where that matters (unused code).
//
// architecture_review finds copy-pasted blocks, functions defined in several files,
// code nothing references, import cycles, and oversized files and functions.
// godot_check is a static checker for Godot 4 GDScript, C# and shaders (Godot 3 code,
// shader GLSL-isms, frame-rate dependent physics, missing res:// files); with a command
// tool, agents also run Godot headless, as engineGuide tells them.
//
// The same file runs in the page and in Node (tests), like story-studio.js.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevCodeIntel = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const MAX_INDEX_FILES = 2000;
    const MAX_FILE_CHARS = 400000;      // bigger files are usually generated or minified
    const READ_CONCURRENCY = 8;
    const LIST_REFRESH_MS = 60000;      // the file list is fetched again after this
    const REFRESH_MS = 5 * 60000;       // files read through a tool are read again after this (files agents change, at once)
    const MAX_RESULT_CHARS = 12000;
    const MAX_READ_LINES = 400;
    const DUP_WINDOW = 6;               // lines in a copy-paste window

    const LANGS = [
        ["js", /\.(m?js|cjs|jsx|ts|tsx)$/i],
        ["py", /\.py$/i],
        ["gd", /\.gd$/i],
        ["cs", /\.cs$/i],
        ["shader", /\.(gdshader|gdshaderinc|shader|glsl|vert|frag)$/i],
        ["scene", /\.(tscn|tres)$/i],
        ["godot", /(^|\/)project\.godot$/i],
        ["html", /\.html?$/i],
        ["cpp", /\.(c|h|cc|cpp|hpp|hh|cxx)$/i],
        ["java", /\.java$/i],
        ["kt", /\.kts?$/i],
        ["go", /\.go$/i],
        ["rs", /\.rs$/i],
        ["lua", /\.lua$/i],
        ["rb", /\.rb$/i],
        ["php", /\.php$/i],
        ["css", /\.css$/i]
    ];
    const SOURCE_LANGS = new Set(["js", "py", "gd", "cs", "shader", "cpp", "java", "kt", "go", "rs", "lua", "rb", "php"]);

    function langOf(path) {
        for (const [lang, re] of LANGS) if (re.test(path)) return lang;
        return "";
    }

    function clip(text, max) {
        text = String(text);
        return text.length > max ? text.slice(0, max) + `\n[cut at ${max} characters; narrow the request for the rest]` : text;
    }

    const KEYWORDS = new Set(("if else for while do switch case catch return function new typeof delete await yield throw try finally "
        + "foreach using lock fixed sizeof nameof default match when elif with not and or in is as var let const static public private "
        + "protected internal override virtual abstract async void int float double bool string char long short unsigned signed struct class "
        + "enum interface namespace import from export pass break continue func signal extends super self this true false null nil none").split(" "));

    // ---------------------------------------------------------------- symbols

    // [regex, kind, name group]. A pattern runs on each line; the first match wins.
    const SYMBOL_PATTERNS = {
        js: [
            [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "function"],
            [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
            [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>)/, "function"],
            [/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, "type"],
            [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, "const"],
            [/^\s+(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*\*?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/, "method"]
        ],
        py: [
            [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, "function"],
            [/^\s*class\s+([A-Za-z_]\w*)/, "class"],
            [/^([A-Z][A-Z0-9_]+)\s*(?::[^=]+)?=/, "const"]
        ],
        gd: [
            [/^class_name\s+([A-Za-z_]\w*)/, "class_name"],
            [/^\s*class\s+([A-Za-z_]\w*)/, "class"],
            [/^\s*(?:static\s+)?func\s+([A-Za-z_]\w*)/, "function"],
            [/^\s*signal\s+([A-Za-z_]\w*)/, "signal"],
            [/^\s*enum\s+([A-Za-z_]\w*)/, "enum"],
            [/^const\s+([A-Za-z_]\w*)/, "const"],
            [/^(?:@export\S*(?:\([^)]*\))?\s+|@onready\s+|export(?:\([^)]*\))?\s+|onready\s+)*var\s+([A-Za-z_]\w*)/, "var"]
        ],
        cs: [
            [/^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|unsafe|file)\s+)*(?:class|struct|interface|enum|record(?:\s+struct)?)\s+([A-Za-z_]\w*)/, "class"],
            [/^\s*(?:\[[^\]]*\]\s*)*(?:public|private|protected|internal)?\s*(?:delegate)\s+[\w<>\[\],.? ]+\s+([A-Za-z_]\w*)\s*\(/, "signal"],
            [/^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|unsafe|new|partial)\s+)+[\w<>\[\],.?() ]+?\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\([^;]*$/, "method"]
        ],
        shader: [
            [/^\s*shader_type\s+(\w+)/, "shader_type"],
            [/^\s*(?:global\s+|instance\s+)?uniform\s+\w+\s+([A-Za-z_]\w*)/, "uniform"],
            [/^\s*varying\s+(?:flat\s+|smooth\s+)?\w+\s+([A-Za-z_]\w*)/, "varying"],
            [/^\s*(?:void|float|int|uint|bool|[biu]?vec[234]|mat[234]|sampler2D)\s+([A-Za-z_]\w*)\s*\(/, "function"],
            [/^\s*const\s+\w+\s+([A-Za-z_]\w*)/, "const"]
        ],
        scene: [
            [/^\[node\s+name="([^"]+)"/, "node"],
            [/^\[sub_resource\s+type="(\w+)"/, "resource"]
        ],
        cpp: [
            [/^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct|union|enum(?:\s+class)?)\s+(?:\w+\s+)?([A-Za-z_]\w*)\s*(?:final\s*)?(?::[^;{]*)?\{?\s*$/, "class"],
            [/^(?:[\w:<>,*&~]+\s+)+\**&?([A-Za-z_~][\w:~]*)\s*\([^;]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?\{?\s*$/, "function"],
            [/^\s*#define\s+([A-Za-z_]\w*)/, "macro"]
        ],
        java: [
            [/^\s*(?:(?:public|private|protected|static|final|abstract|sealed)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, "class"],
            [/^\s*(?:@\w+\s+)*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)+[\w<>\[\],.? ]+\s+([A-Za-z_]\w*)\s*\(/, "method"]
        ],
        kt: [
            [/^\s*(?:(?:data|sealed|abstract|open|enum|inner|private|internal|public)\s+)*(?:class|interface|object)\s+([A-Za-z_]\w*)/, "class"],
            [/^\s*(?:(?:private|public|internal|protected|override|suspend|inline|open)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/, "function"]
        ],
        go: [
            [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, "function"],
            [/^type\s+([A-Za-z_]\w*)/, "type"]
        ],
        rs: [
            [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, "function"],
            [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type|union)\s+([A-Za-z_]\w*)/, "type"],
            [/^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_]\w*)/, "impl"]
        ],
        lua: [
            [/^\s*local\s+function\s+([A-Za-z_][\w]*)/, "function"],
            [/^\s*function\s+([A-Za-z_][\w.:]*)/, "function"],
            [/^\s*(?:local\s+)?([A-Za-z_][\w.]*)\s*=\s*function\b/, "function"]
        ],
        rb: [
            [/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, "function"],
            [/^\s*(?:class|module)\s+([A-Z]\w*)/, "class"]
        ],
        php: [
            [/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+([A-Za-z_]\w*)/, "function"],
            [/^\s*(?:(?:final|abstract)\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/, "class"]
        ]
    };

    function indentOf(line) {
        const m = line.match(/^[ \t]*/)[0];
        return m.replace(/\t/g, "    ").length;
    }

    // Where a symbol ends: by indentation for Python and GDScript, by braces elsewhere.
    function symbolEnd(lines, start, lang, kind) {
        if (["const", "var", "signal", "uniform", "varying", "macro", "class_name", "shader_type", "resource"].includes(kind)) return start;
        if (kind === "node") {
            let i = start + 1;
            while (i < lines.length && !/^\[/.test(lines[i])) i++;
            return i - 1;
        }
        if (lang === "py" || lang === "gd") {
            const base = indentOf(lines[start]);
            let last = start;
            for (let i = start + 1; i < lines.length; i++) {
                const line = lines[i];
                if (!line.trim() || /^\s*#/.test(line)) continue;
                if (indentOf(line) <= base) break;
                last = i;
            }
            return last;
        }
        if (lang === "lua" || lang === "rb") {
            const base = indentOf(lines[start]);
            for (let i = start + 1; i < lines.length && i < start + 3000; i++) {
                if (/^\s*end\b/.test(lines[i]) && indentOf(lines[i]) <= base) return i;
            }
            return start;
        }
        let depth = 0;
        let opened = false;
        for (let i = start; i < lines.length && i < start + 5000; i++) {
            // Strings and comments are dropped so their braces don't count.
            const code = lines[i].replace(/\/\/.*$/, "").replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "\"\"");
            for (const ch of code) {
                if (ch === "{") { depth++; opened = true; } else if (ch === "}") depth--;
            }
            if (opened && depth <= 0) return i;
            // An arrow function or declaration with no block ends on its own line.
            if (!opened && i > start + 1) return start;
            if (!opened && /;\s*$/.test(code)) return i;
        }
        return start;
    }

    function extractSymbols(path, text, lang = langOf(path)) {
        const patterns = SYMBOL_PATTERNS[lang];
        if (!patterns) return [];
        const lines = String(text).split("\n");
        const symbols = [];
        let inBlockComment = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (lang !== "py" && lang !== "gd" && lang !== "scene") {
                if (inBlockComment) { if (line.includes("*/")) inBlockComment = false; continue; }
                if (/^\s*\/\*/.test(line) && !line.includes("*/")) { inBlockComment = true; continue; }
                if (/^\s*(\/\/|\*)/.test(line)) continue;
            } else if (/^\s*#/.test(line)) continue;
            for (const [re, kind] of patterns) {
                const m = line.match(re);
                if (!m) continue;
                const name = m[1];
                if (!name || KEYWORDS.has(name)) break;
                symbols.push({ name, kind, line: i + 1, end: symbolEnd(lines, i, lang, kind) + 1, indent: indentOf(line), exported: /^\s*export\b|\bpublic\b|^\s*pub\b/.test(line) });
                break;
            }
        }
        return symbols;
    }

    // ---------------------------------------------------------------- imports

    function extractImports(path, text, lang = langOf(path)) {
        const out = [];
        const lines = String(text).split("\n");
        const add = (spec, line, how) => { if (spec && !out.some(o => o.spec === spec && o.line === line)) out.push({ spec, line, how }); };
        lines.forEach((line, n) => {
            const at = n + 1;
            let m;
            // res:// paths in any Godot file: preload, load, extends, ext_resource, #include, GD.Load.
            const resRe = /["'](res:\/\/[^"']+)["']/g;
            while ((m = resRe.exec(line))) add(m[1], at, "res");
            if (lang === "js") {
                const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
                while ((m = re.exec(line))) add(m[1], at, "module");
            } else if (lang === "html") {
                const re = /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"'#?]+)["']/gi;
                while ((m = re.exec(line))) if (!/^(https?:)?\/\//.test(m[1])) add(m[1], at, "module");
            } else if (lang === "py") {
                if ((m = line.match(/^\s*from\s+(\.*[\w.]*)\s+import\b/))) add(m[1], at, "python");
                else if ((m = line.match(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/))) m[1].split(",").forEach(s => add(s.trim(), at, "python"));
            } else if (lang === "gd") {
                if ((m = line.match(/^extends\s+([A-Za-z_]\w*)\s*$/))) add(m[1], at, "class");
            } else if (lang === "cpp" || lang === "shader") {
                if ((m = line.match(/^\s*#include\s+"([^"]+)"/))) add(m[1], at, "module");
            } else if (lang === "cs") {
                if ((m = line.match(/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/))) add(m[1], at, "namespace");
            } else if (lang === "java" || lang === "kt") {
                if ((m = line.match(/^\s*import\s+(?:static\s+)?([\w.]+)/))) add(m[1], at, "namespace");
            } else if (lang === "go") {
                if ((m = line.match(/^\s*(?:import\s+)?(?:\w+\s+)?"([^"]+)"\s*$/))) add(m[1], at, "namespace");
            } else if (lang === "lua") {
                if ((m = line.match(/\brequire\s*\(?\s*["']([^"']+)["']/))) add(m[1], at, "lua");
            } else if (lang === "rb") {
                if ((m = line.match(/^\s*require(?:_relative)?\s+["']([^"']+)["']/))) add(m[1], at, /require_relative/.test(line) ? "module" : "namespace");
            }
        });
        return out;
    }

    function joinPath(dir, rel) {
        const parts = dir ? dir.split("/") : [];
        for (const part of rel.split("/")) {
            if (!part || part === ".") continue;
            if (part === "..") parts.pop(); else parts.push(part);
        }
        return parts.join("/");
    }

    const JS_EXTS = ["", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", "/index.js", "/index.ts", "/index.tsx", ".json"];

    // A project path for an import, or "" when it's outside the project (a package, the engine).
    function resolveImport(fromPath, imp, ctx) {
        const { pathSet, suffix, classNames, godotRoots } = ctx;
        const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
        const first = candidates => candidates.find(c => pathSet.has(c)) || "";
        if (imp.how === "res") {
            const rel = imp.spec.replace(/^res:\/\//, "").split("::")[0];
            const hit = first(godotRoots.map(root => (root ? `${root}/${rel}` : rel)));
            return hit || suffix(rel);
        }
        if (imp.how === "class") return classNames.get(imp.spec) || "";
        if (imp.how === "module") {
            if (/^[./]/.test(imp.spec)) {
                const base = imp.spec.startsWith("/") ? imp.spec.slice(1) : joinPath(dir, imp.spec);
                return first(JS_EXTS.map(ext => base + ext));
            }
            // Bare names: a package, or (for C includes and HTML) a path from the project root.
            return first([joinPath(dir, imp.spec), imp.spec]) || (/\.\w+$/.test(imp.spec) ? suffix(imp.spec) : "");
        }
        if (imp.how === "python") {
            const dots = imp.spec.match(/^\.*/)[0].length;
            const mod = imp.spec.slice(dots).replace(/\./g, "/");
            if (dots) {
                let base = dir;
                for (let i = 1; i < dots; i++) base = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "";
                const at = mod ? joinPath(base, mod) : base;
                return first([`${at}.py`, `${at}/__init__.py`]);
            }
            return first([`${mod}.py`, `${mod}/__init__.py`, joinPath(dir, `${mod}.py`)]) || suffix(`${mod}.py`);
        }
        if (imp.how === "lua") return suffix(`${imp.spec.replace(/\./g, "/")}.lua`);
        return "";
    }

    // ---------------------------------------------------------------- the index

    function parseFile(path, text) {
        const lang = langOf(path);
        return { path, lang, text, lines: text.split("\n").length, symbols: extractSymbols(path, text, lang), imports: extractImports(path, text, lang) };
    }

    // files: { path: text }. options.previous reuses the parsed files whose text didn't change.
    function buildIndex(files, options = {}) {
        const previous = options.previous && options.previous.files;
        const parsed = new Map();
        for (const [path, text] of Object.entries(files)) {
            if (typeof text !== "string") continue;
            const old = previous && previous.get(path);
            parsed.set(path, old && old.text === text ? { ...old, imports: old.imports.map(i => ({ ...i, resolved: "" })) } : parseFile(path, text));
        }
        const pathSet = new Set(parsed.keys());
        const byBase = new Map();
        for (const path of pathSet) {
            const base = path.split("/").pop();
            if (!byBase.has(base)) byBase.set(base, []);
            byBase.get(base).push(path);
        }
        const suffix = rel => {
            const list = byBase.get(rel.split("/").pop()) || [];
            return list.find(p => p === rel || p.endsWith("/" + rel)) || "";
        };
        const classNames = new Map();
        const godotRoots = [];
        for (const f of parsed.values()) {
            if (f.lang === "godot") godotRoots.push(f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "");
            if (f.lang === "gd") for (const s of f.symbols) if (s.kind === "class_name") classNames.set(s.name, f.path);
        }
        if (!godotRoots.length) godotRoots.push("");
        const ctx = { pathSet, suffix, classNames, godotRoots };
        const defs = new Map();
        const importedBy = new Map();
        for (const f of parsed.values()) {
            for (const s of f.symbols) {
                if (!defs.has(s.name)) defs.set(s.name, []);
                defs.get(s.name).push({ path: f.path, line: s.line, end: s.end, kind: s.kind });
            }
            for (const imp of f.imports) {
                imp.resolved = resolveImport(f.path, imp, ctx);
                if (imp.resolved && imp.resolved !== f.path) {
                    if (!importedBy.has(imp.resolved)) importedBy.set(imp.resolved, new Set());
                    importedBy.get(imp.resolved).add(f.path);
                }
            }
        }
        const godot = godotInfo(parsed);
        return { files: parsed, defs, importedBy, classNames, godotRoots, godot, builtAt: Date.now() };
    }

    // project.godot: the engine version, main scene and autoloads.
    function godotInfo(parsed) {
        const project = [...parsed.values()].find(f => f.lang === "godot");
        if (!project) return null;
        const text = project.text;
        const config = Number((text.match(/^config_version\s*=\s*(\d+)/m) || [])[1] || 0);
        const features = (text.match(/^config\/features\s*=\s*PackedStringArray\(([^)]*)\)/m) || [])[1] || "";
        const version = (features.match(/"(\d+\.\d+)"/) || [])[1] || (config >= 5 ? "4" : config ? "3" : "4");
        const autoloads = [];
        const section = text.split(/^\[autoload\]\s*$/m)[1];
        if (section) for (const line of section.split(/^\[/m)[0].split("\n")) {
            const m = line.match(/^(\w+)\s*=\s*"\*?(res:\/\/[^"]+)"/);
            if (m) autoloads.push({ name: m[1], path: m[2] });
        }
        return {
            path: project.path,
            version,
            major: Number(version.split(".")[0]) || 4,
            mainScene: (text.match(/^run\/main_scene\s*=\s*"([^"]+)"/m) || [])[1] || "",
            autoloads,
            dotnet: /\[dotnet\]/.test(text) || [...parsed.values()].some(f => f.lang === "cs")
        };
    }

    function dependents(index, path) { return [...(index.importedBy.get(path) || [])].sort(); }

    // ---------------------------------------------------------------- what the tools return

    const ENTRY_NAME = /(^|\/)(index|main|app|server|program|game|__main__|manage|setup|cli)\.\w+$/i;

    function codeMap(index, { focus = "" } = {}) {
        const all = [...index.files.values()];
        const needle = String(focus || "").toLowerCase().trim();
        const files = needle ? all.filter(f => f.path.toLowerCase().includes(needle) || f.symbols.some(s => s.name.toLowerCase() === needle)) : all;
        if (!files.length) return `Nothing in the project matches "${focus}". Call code_map without focus for the whole project.`;
        const out = [];
        const langs = {};
        let lines = 0;
        for (const f of files) { langs[f.lang || "other"] = (langs[f.lang || "other"] || 0) + 1; lines += f.lines; }
        out.push(`${needle ? `Files matching "${focus}"` : "Project"}: ${files.length} files, ${lines.toLocaleString("en-US")} lines (${Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(", ")}).`);
        if (index.godot && !needle) {
            const g = index.godot;
            out.push(`Godot ${g.version} project (${g.path})${g.mainScene ? `, main scene ${g.mainScene}` : ""}${g.dotnet ? ", uses C#" : ""}.`
                + (g.autoloads.length ? ` Autoloads (global singletons): ${g.autoloads.map(a => `${a.name} = ${a.path}`).join(", ")}.` : ""));
        }
        if (!needle) {
            const hubs = [...index.importedBy.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 8);
            if (hubs.length) out.push("Most depended-on files: " + hubs.map(([p, s]) => `${p} (${s.size})`).join(", ") + ".");
            const entries = all.filter(f => SOURCE_LANGS.has(f.lang) && ENTRY_NAME.test(f.path) && f.path.split("/").length <= 3).map(f => f.path).slice(0, 8);
            if (entries.length) out.push("Likely entry points: " + entries.join(", ") + ".");
        }
        out.push("", "Files (symbols with line numbers; uses = files this one imports, used by = files importing it):");
        // Folders first, so the map reads top-down; the most connected files go first inside each.
        const sorted = files.slice().sort((a, b) => a.path.localeCompare(b.path));
        let size = out.join("\n").length;
        let shown = 0;
        for (const f of sorted) {
            const top = f.symbols.filter(s => s.indent === 0 || ["class", "class_name", "method", "signal", "node"].includes(s.kind));
            const names = top.slice(0, 14).map(s => `${s.kind === "class" || s.kind === "class_name" ? "class " : s.kind === "signal" ? "signal " : ""}${s.name}:${s.line}`);
            const uses = f.imports.filter(i => i.resolved).map(i => i.resolved.split("/").pop());
            const usedBy = dependents(index, f.path).length;
            const line = `${f.path} [${f.lines} lines]` + (names.length ? ` ${names.join(", ")}${top.length > 14 ? ` +${top.length - 14} more` : ""}` : "")
                + (uses.length ? ` | uses ${[...new Set(uses)].slice(0, 6).join(", ")}` : "") + (usedBy ? ` | used by ${usedBy}` : "");
            if (size + line.length > MAX_RESULT_CHARS - 200) {
                out.push(`[${sorted.length - shown} more files; call code_map with focus set to a folder, file or name to see them]`);
                break;
            }
            out.push(line);
            size += line.length + 1;
            shown++;
        }
        return out.join("\n");
    }

    function findFile(index, name) {
        const raw = String(name || "").replace(/\\/g, "/").replace(/^res:\/\//, "").replace(/^\.?\//, "").trim();
        if (!raw) return null;
        if (index.files.has(raw)) return index.files.get(raw);
        const lower = raw.toLowerCase();
        const matches = [...index.files.values()].filter(f => f.path.toLowerCase() === lower || f.path.toLowerCase().endsWith("/" + lower));
        return matches.length === 1 ? matches[0] : matches.length ? { ambiguous: matches.map(f => f.path) } : null;
    }

    function notFound(index, name) {
        const base = String(name || "").split(/[\\/]/).pop().toLowerCase();
        const near = [...index.files.keys()].filter(p => p.toLowerCase().includes(base.replace(/\.\w+$/, ""))).slice(0, 8);
        return `No file "${name}" in the project index.` + (near.length ? ` Similar: ${near.join(", ")}.` : " Call code_map to see the files.");
    }

    function fileOutline(index, name) {
        const f = findFile(index, name);
        if (!f) return notFound(index, name);
        if (f.ambiguous) return `Several files match "${name}": ${f.ambiguous.join(", ")}. Pass the full path.`;
        const out = [`${f.path}: ${f.lang || "text"}, ${f.lines} lines.`];
        const imports = f.imports.map(i => `${i.spec}${i.resolved && i.resolved !== i.spec ? ` -> ${i.resolved}` : i.resolved ? "" : " (outside the project)"} (line ${i.line})`);
        if (imports.length) out.push("Imports / loads: " + imports.slice(0, 40).join("; "));
        const by = dependents(index, f.path);
        out.push(by.length ? `Used by: ${by.slice(0, 40).join(", ")}${by.length > 40 ? ` +${by.length - 40} more` : ""}` : "Used by: nothing in the project imports, loads or extends it.");
        if (f.symbols.length) {
            out.push("Symbols:");
            for (const s of f.symbols) {
                out.push(`${" ".repeat(Math.min(s.indent, 12))}${s.kind} ${s.name}  lines ${s.line}${s.end > s.line ? `-${s.end}` : ""}`);
            }
        } else out.push("No functions, classes or other symbols were found in it.");
        return clip(out.join("\n"), MAX_RESULT_CHARS);
    }

    function readLines(index, name, start, end) {
        const f = findFile(index, name);
        if (!f) return notFound(index, name);
        if (f.ambiguous) return `Several files match "${name}": ${f.ambiguous.join(", ")}. Pass the full path.`;
        const lines = f.text.split("\n");
        let from = Math.max(1, Math.floor(Number(start) || 1));
        let to = Math.min(lines.length, Math.floor(Number(end) || from + 199));
        if (to < from) to = from;
        if (to - from + 1 > MAX_READ_LINES) to = from + MAX_READ_LINES - 1;
        const width = String(to).length;
        let body = "";
        let n = from;
        for (; n <= to; n++) {
            const row = `${String(n).padStart(width)}| ${lines[n - 1]}\n`;
            if (body.length + row.length > MAX_RESULT_CHARS) break;
            body += row;
        }
        const last = n - 1;
        return `${f.path} lines ${from}-${last} of ${lines.length}:\n${body}` + (last < lines.length ? `[more: call read_lines with start ${last + 1}]` : "[end of file]");
    }

    function escapeRegExp(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

    function findSymbol(index, name, { limit = 80 } = {}) {
        const wanted = String(name || "").trim().replace(/\(\)$/, "");
        if (!wanted) return "find_symbol needs a name.";
        let defs = index.defs.get(wanted) || [];
        if (!defs.length) {
            const lower = wanted.toLowerCase();
            for (const [n, list] of index.defs) if (n.toLowerCase() === lower) defs = defs.concat(list);
        }
        const out = [];
        if (defs.length) out.push(`Defined (${defs.length}):`, ...defs.map(d => `  ${d.path}:${d.line}${d.end > d.line ? `-${d.end}` : ""} ${d.kind}`));
        else out.push(`No definition of "${wanted}" found in the project (it may come from the engine, a library, or be built dynamically).`);
        const re = new RegExp(`(^|[^\\w$])${escapeRegExp(wanted)}(?![\\w$])`);
        const defLines = new Set(defs.map(d => `${d.path}:${d.line}`));
        const refs = [];
        let total = 0;
        const files = new Set();
        for (const f of index.files.values()) {
            const lines = f.text.split("\n");
            for (let i = 0; i < lines.length; i++) {
                if (!re.test(lines[i]) || defLines.has(`${f.path}:${i + 1}`)) continue;
                total++;
                files.add(f.path);
                if (refs.length < limit) refs.push(`  ${f.path}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
            }
        }
        out.push(total ? `Used ${total} time(s) in ${files.size} file(s)${total > refs.length ? ` (first ${refs.length} shown)` : ""}:` : "Not used anywhere else in the project (text search, so strings and scene files count).", ...refs);
        return clip(out.join("\n"), MAX_RESULT_CHARS);
    }

    // ---------------------------------------------------------------- architecture review

    // Called by the engine, a framework or by name from outside, so never "unused".
    const ENTRY_SYMBOLS = new Set(("_ready _process _physics_process _input _unhandled_input _unhandled_key_input _gui_input _init _enter_tree _exit_tree "
        + "_draw _notification _integrate_forces _get _set _get_property_list _to_string _run _get_configuration_warnings _validate_property _shortcut_input "
        + "_Ready _Process _PhysicsProcess _Input _UnhandledInput _EnterTree _ExitTree _Draw _Notification _IntegrateForces _GuiInput "
        + "Start Update FixedUpdate LateUpdate Awake OnEnable OnDisable OnDestroy OnCollisionEnter OnTriggerEnter "
        + "vertex fragment light start process sky fog "
        + "main Main constructor render toString valueOf toJSON setup teardown setUp tearDown __init__ __main__ __repr__ __str__ "
        + "connectedCallback disconnectedCallback attributeChangedCallback componentDidMount componentWillUnmount").split(" "));
    // Common names that mean different things in different files; not "duplicates".
    const COMMON_NAMES = new Set(("init initialize start stop run update render draw reset clear load save get set add remove create build "
        + "main setup handle process apply open close show hide toggle refresh destroy dispose test helper util utils index default "
        + "constructor toString equals hashCode describe mount unmount format parse normalize validate").split(" "));

    function identifierCounts(index) {
        const counts = new Map();
        for (const f of index.files.values()) {
            const words = f.text.match(/[A-Za-z_$][\w$]*/g) || [];
            for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
        }
        return counts;
    }

    function unusedSymbols(index, counts) {
        const out = [];
        for (const f of index.files.values()) {
            if (!SOURCE_LANGS.has(f.lang) || /(^|\/)(tests?|spec|__tests__)\/|\.(test|spec)\.\w+$|(^|\/)test_\w+\.py$/i.test(f.path)) continue;
            for (const s of f.symbols) {
                if (!["function", "method", "class", "type", "signal", "const", "enum"].includes(s.kind)) continue;
                // Godot scripts' classes are attached by scenes and the editor, which the text doesn't show.
                if ((f.lang === "gd" || f.lang === "cs") && (s.kind === "class" || s.kind === "class_name")) continue;
                if (ENTRY_SYMBOLS.has(s.name) || s.name.length < 3 || /^(test|Test)/.test(s.name) || /^__\w+__$/.test(s.name)) continue;
                const defsCount = (index.defs.get(s.name) || []).length;
                if ((counts.get(s.name) || 0) > defsCount) continue;
                // C# overrides and [Export]ed/attribute-marked members are used by the engine.
                const line = f.text.split("\n")[s.line - 1] || "";
                if (/\boverride\b|\[\w+/.test(line)) continue;
                out.push({ path: f.path, line: s.line, name: s.name, kind: s.kind, size: s.end - s.line + 1 });
            }
        }
        return out.sort((a, b) => b.size - a.size);
    }

    function normalizedLines(f) {
        const out = [];
        const comment = f.lang === "py" || f.lang === "gd" ? /^#/ : /^(\/\/|\/\*|\*|#(?!include))/;
        f.text.split("\n").forEach((raw, i) => {
            const line = raw.trim().replace(/\s+/g, " ");
            if (!line || comment.test(line)) return;
            out.push({ text: line, line: i + 1 });
        });
        return out;
    }

    // Blocks of at least DUP_WINDOW meaningful lines that appear in two places.
    function duplicateBlocks(index) {
        const seen = new Map();
        const norm = new Map();
        for (const f of index.files.values()) {
            if (!SOURCE_LANGS.has(f.lang)) continue;
            const lines = normalizedLines(f);
            norm.set(f.path, lines);
            for (let i = 0; i + DUP_WINDOW <= lines.length; i++) {
                const window = lines.slice(i, i + DUP_WINDOW);
                // Windows of braces, "pass", "else:" and the like are everywhere and mean nothing.
                if (window.filter(l => l.text.length >= 12).length < 4) continue;
                const key = window.map(l => l.text).join("\n");
                if (!seen.has(key)) seen.set(key, []);
                const list = seen.get(key);
                if (list.length <= 20) list.push({ path: f.path, i });
            }
        }
        const runs = new Map();
        for (const list of seen.values()) {
            if (list.length < 2 || list.length > 20) continue;
            for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
                const x = list[a], y = list[b];
                if (x.path === y.path && Math.abs(x.i - y.i) < DUP_WINDOW) continue;
                const key = `${x.path}\0${y.path}\0${x.i - y.i}`;
                if (!runs.has(key)) runs.set(key, []);
                runs.get(key).push({ a: x.i, b: y.i });
            }
        }
        const blocks = [];
        for (const [key, starts] of runs) {
            const [pathA, pathB] = key.split("\0");
            starts.sort((p, q) => p.a - q.a);
            let first = starts[0];
            let prev = first;
            const flush = () => {
                const la = norm.get(pathA), lb = norm.get(pathB);
                const count = prev.a - first.a + DUP_WINDOW;
                blocks.push({ a: { path: pathA, from: la[first.a].line, to: la[prev.a + DUP_WINDOW - 1].line },
                    b: { path: pathB, from: lb[first.b].line, to: lb[prev.b + DUP_WINDOW - 1].line }, lines: count });
            };
            for (let k = 1; k < starts.length; k++) {
                if (starts[k].a === prev.a + 1) { prev = starts[k]; continue; }
                flush();
                first = prev = starts[k];
            }
            flush();
        }
        return blocks.sort((p, q) => q.lines - p.lines);
    }

    // Groups of files that import each other in a loop (Tarjan's strongly connected components).
    function importCycles(index) {
        const graph = new Map();
        for (const f of index.files.values()) {
            // Scene and resource files referencing scripts aren't code dependencies in the same sense.
            if (!SOURCE_LANGS.has(f.lang)) continue;
            graph.set(f.path, [...new Set(f.imports.map(i => i.resolved).filter(p => p && p !== f.path && SOURCE_LANGS.has(langOf(p))))]);
        }
        let counter = 0;
        const idx = new Map(), low = new Map(), onStack = new Set(), stack = [], groups = [];
        const visit = start => {
            // Iterative, so a deep import chain can't overflow the call stack.
            const work = [[start, 0]];
            idx.set(start, counter); low.set(start, counter); counter++;
            stack.push(start); onStack.add(start);
            while (work.length) {
                const frame = work[work.length - 1];
                const [v] = frame;
                const next = (graph.get(v) || [])[frame[1]++];
                if (next !== undefined) {
                    if (!graph.has(next)) continue;
                    if (!idx.has(next)) {
                        idx.set(next, counter); low.set(next, counter); counter++;
                        stack.push(next); onStack.add(next);
                        work.push([next, 0]);
                    } else if (onStack.has(next)) low.set(v, Math.min(low.get(v), idx.get(next)));
                    continue;
                }
                work.pop();
                if (work.length) { const parent = work[work.length - 1][0]; low.set(parent, Math.min(low.get(parent), low.get(v))); }
                if (low.get(v) === idx.get(v)) {
                    const group = [];
                    let w;
                    do { w = stack.pop(); onStack.delete(w); group.push(w); } while (w !== v);
                    if (group.length > 1) groups.push(group.sort());
                }
            }
        };
        for (const v of graph.keys()) if (!idx.has(v)) visit(v);
        return groups.sort((a, b) => b.length - a.length);
    }

    function architectureReview(index, { focus = "" } = {}) {
        const needle = String(focus || "").toLowerCase();
        const inFocus = path => !needle || path.toLowerCase().includes(needle);
        const files = [...index.files.values()];
        const source = files.filter(f => SOURCE_LANGS.has(f.lang));
        const out = [`Architecture review of ${needle ? `files matching "${focus}" in ` : ""}${source.length} source files (${source.reduce((n, f) => n + f.lines, 0).toLocaleString("en-US")} lines). `
            + "Findings come from pattern matching, not a compiler: confirm each one with find_symbol or read_lines before changing code, keep behavior the same, and fix the biggest items first."];
        const section = (title, items, render, max) => {
            items = items.slice(0, max);
            out.push("", `## ${title}${items.length ? "" : ": none found"}`);
            items.forEach(item => out.push(render(item)));
        };
        const dups = duplicateBlocks(index).filter(d => inFocus(d.a.path) || inFocus(d.b.path));
        section("Copy-pasted code (merge into one shared function)", dups, d => `- ${d.lines} lines: ${d.a.path}:${d.a.from}-${d.a.to} = ${d.b.path}:${d.b.from}-${d.b.to}`, 15);
        const repeated = [];
        for (const [name, list] of index.defs) {
            if (COMMON_NAMES.has(name) || ENTRY_SYMBOLS.has(name) || name.length < 4) continue;
            const top = list.filter(d => ["function", "class", "type", "class_name"].includes(d.kind) && SOURCE_LANGS.has(langOf(d.path)));
            const paths = [...new Set(top.map(d => d.path))];
            if (paths.length >= 2 && paths.some(inFocus)) repeated.push({ name, list: top, count: paths.length });
        }
        repeated.sort((a, b) => b.count - a.count);
        section("Same function or class defined in several files (redundant abstractions; keep one)", repeated, r => `- ${r.name}: ${r.list.slice(0, 5).map(d => `${d.path}:${d.line}`).join(", ")}${r.list.length > 5 ? ` +${r.list.length - 5} more` : ""}`, 15);
        const unused = unusedSymbols(index, identifierCounts(index)).filter(u => inFocus(u.path));
        section("Likely unused (nothing else in the project mentions the name; check reflection, signals connected in the editor and outside callers before deleting)", unused, u => `- ${u.kind} ${u.name} at ${u.path}:${u.line}${u.size > 1 ? ` (${u.size} lines)` : ""}`, 25);
        const cycles = importCycles(index).filter(g => g.some(inFocus));
        section("Import cycles (files that depend on each other in a loop; move the shared part into its own module)", cycles, g => `- ${g.slice(0, 8).join(" <-> ")}${g.length > 8 ? ` +${g.length - 8} more` : ""}`, 10);
        const bigFiles = source.filter(f => f.lines > 800 && inFocus(f.path)).sort((a, b) => b.lines - a.lines);
        section("Very large files (split by responsibility)", bigFiles, f => `- ${f.path}: ${f.lines} lines, ${f.symbols.length} symbols`, 10);
        const bigFns = [];
        for (const f of source) {
            if (!inFocus(f.path)) continue;
            for (const s of f.symbols) if (["function", "method"].includes(s.kind) && s.end - s.line + 1 > 100) bigFns.push({ path: f.path, s, size: s.end - s.line + 1 });
        }
        bigFns.sort((a, b) => b.size - a.size);
        section("Very long functions (over 100 lines; extract steps into named helpers)", bigFns, x => `- ${x.s.name} at ${x.path}:${x.s.line}-${x.s.end} (${x.size} lines)`, 12);
        const hubs = [...index.importedBy.entries()].filter(([p, s]) => s.size >= 15 && inFocus(p) && SOURCE_LANGS.has(langOf(p))).sort((a, b) => b[1].size - a[1].size);
        section("Files most of the project depends on (change carefully; consider narrowing what they export)", hubs, ([p, s]) => `- ${p}: used by ${s.size} files`, 8);
        return clip(out.join("\n"), MAX_RESULT_CHARS);
    }

    // ---------------------------------------------------------------- Godot checks

    const GD3_TO_4 = [
        [/^\s*onready\s+var\b/, "error", "`onready var` is Godot 3. Use `@onready var`."],
        [/^\s*export(\s*\(.*\))?\s+var\b/, "error", "`export var` is Godot 3. Use `@export var` (with a type, e.g. `@export var speed: float = 5.0`; ranges are `@export_range(0, 10)`)."],
        [/^tool\s*$/, "error", "`tool` is Godot 3. Use `@tool` at the top of the script."],
        [/\byield\s*\(/, "error", "`yield` was removed in Godot 4. Use `await`, e.g. `await get_tree().create_timer(0.5).timeout` or `await some_signal`."],
        [/\bKinematicBody(2D)?\b/, "error", "KinematicBody/KinematicBody2D are Godot 3. Use CharacterBody3D/CharacterBody2D."],
        [/\bextends\s+Spatial\b|\bSpatial\b(?=\s*[\.\)\],:]|\s*$)/, "error", "Spatial is Godot 3. Use Node3D."],
        // Only where the name is a type (extends, a type hint, is/as, .new()), not a node path like $Camera.
        [/(?:\bextends\s+|:\s*|\bis\s+|\bas\s+)(?:RigidBody|Area|CollisionShape|CollisionPolygon|MeshInstance|Camera|RayCast|StaticBody|Particles|Listener|VisibilityNotifier|SoftBody|OmniLight|SpotLight|DirectionalLight)\b(?![23]D)|\b(?:RigidBody|Area|CollisionShape|MeshInstance|Camera|RayCast|StaticBody|OmniLight|SpotLight|DirectionalLight)\.new\(/, "error", "Godot 3 3D node name. In Godot 4 the 3D nodes end in 3D (RigidBody3D, Area3D, CollisionShape3D, MeshInstance3D, Camera3D, RayCast3D...)."],
        [/\bPosition(2D|3D)\b/, "error", "Position2D/Position3D are Godot 3. Use Marker2D/Marker3D."],
        [/\.instance\(\s*\)/, "error", "`.instance()` is Godot 3. Use `.instantiate()`."],
        [/\bmove_and_slide\s*\(\s*[^)\s]/, "error", "In Godot 4 `move_and_slide()` takes no arguments: set the body's `velocity` (and `up_direction`) and call `move_and_slide()`; it applies delta itself."],
        [/\bmove_and_slide_with_snap\b/, "error", "`move_and_slide_with_snap` is Godot 3. Set `floor_snap_length` and call `move_and_slide()`."],
        [/\brand_range\s*\(/, "error", "`rand_range` is Godot 3. Use `randf_range` (or `randi_range`)."],
        [/\b(deg2rad|rad2deg|stepify|str2var|var2str|lerp_angle_deg|range_lerp|linear2db|db2linear)\s*\(/, "error", "Godot 3 global function. Godot 4 names: deg_to_rad, rad_to_deg, snapped, str_to_var, var_to_str, remap, linear_to_db, db_to_linear."],
        [/\.connect\(\s*["'][^"']+["']\s*,\s*self\s*,/, "error", "Godot 3 connect. In Godot 4: `signal_name.connect(_on_method)` or `connect(\"signal_name\", _on_method)` with a Callable."],
        [/\bsetget\b/, "error", "`setget` is Godot 3. Use property syntax: `var hp: int = 10:\\n\\tset(value):\\n\\t\\thp = value`."],
        [/\bPool(String|Vector2|Vector3|Int|Real|Byte|Color)Array\b/, "error", "Pool*Array is Godot 3. Use Packed*Array (PackedStringArray, PackedVector3Array, PackedFloat32Array...)."],
        [/\.empty\(\s*\)/, "error", "`.empty()` is Godot 3. Use `.is_empty()`."],
        [/\bchange_scene\s*\(/, "error", "`change_scene` is Godot 3. Use `get_tree().change_scene_to_file(\"res://...\")` or `change_scene_to_packed`."],
        [/\bfuncref\s*\(/, "error", "`funcref` is Godot 3. Use a Callable: `Callable(obj, \"method\")` or just `obj.method`."],
        [/\bBUTTON_(LEFT|RIGHT|MIDDLE|WHEEL_UP|WHEEL_DOWN)\b/, "error", "Godot 3 mouse constant. Use MOUSE_BUTTON_LEFT, MOUSE_BUTTON_RIGHT..."],
        [/\b(to_json|parse_json)\s*\(/, "error", "Godot 3 JSON. Use `JSON.stringify(value)` and `JSON.parse_string(text)`."],
        [/\bOS\.get_ticks_(msec|usec)\b/, "error", "Use `Time.get_ticks_msec()` / `Time.get_ticks_usec()` in Godot 4."],
        [/\bEngine\.iterations_per_second\b/, "error", "Use `Engine.physics_ticks_per_second` in Godot 4."],
        [/\b(Quat|Transform)\s*\(/, "error", "Godot 3 type. Use Quaternion / Transform3D."],
        [/\.xform(_inv)?\s*\(/, "error", "`xform` is Godot 3. Multiply instead: `transform * v`, and `v * transform` (or `transform.affine_inverse() * v`) for the inverse."],
        [/\.translation\b/, "check", "`.translation` is Godot 3 for Node3D. In Godot 4 use `.position` (local) or `.global_position`."],
        [/\bemit_signal\s*\(\s*["']/, "info", "Works, but Godot 4 style is `signal_name.emit(args)`, which the editor checks."]
    ];

    const PHYSICS_CALLS = /\b(move_and_slide|move_and_collide|apply_(central_)?(force|impulse|torque)|apply_torque_impulse|add_(central_)?force)\s*\(/;

    function lintGdscript(path, text, opts) {
        const issues = [];
        const lines = text.split("\n");
        const add = (line, severity, message) => issues.push({ path, line, severity, message });
        const tabs = lines.findIndex(l => /^\t/.test(l));
        const spaces = lines.findIndex(l => /^ +\S/.test(l) && !/^ +#/.test(l));
        if (tabs >= 0 && spaces >= 0) add(Math.max(tabs, spaces) + 1, "error", "Indentation mixes tabs and spaces in one script; GDScript refuses to parse that. Use tabs (Godot's default) throughout.");
        let fn = "";
        let fnIndent = 0;
        lines.forEach((raw, i) => {
            const n = i + 1;
            const line = raw.replace(/#.*$/, "");
            if (!line.trim()) return;
            const def = line.match(/^(\s*)(?:static\s+)?func\s+(\w+)/);
            if (def) { fn = def[2]; fnIndent = indentOf(raw); } else if (fn && indentOf(raw) <= fnIndent) fn = "";
            if (opts.major >= 4) for (const [re, severity, message] of GD3_TO_4) if (re.test(line)) add(n, severity, message);
            if (fn === "_process" && PHYSICS_CALLS.test(line)) add(n, "warning", "Physics movement in `_process` runs at the frame rate and fights the physics engine. Move it into `_physics_process(delta)`.");
            if (/^\s*(velocity|linear_velocity)(\.[xyz])?\s*[-+]=/.test(line) && !/\bdelta\b/.test(line) && /(gravity|accel|accelerat|friction|drag|force)/i.test(line)) {
                add(n, "warning", "Acceleration added to velocity without `* delta` is frame-rate dependent. Write e.g. `velocity.y -= gravity * delta`.");
            }
            if (/^\s*(global_)?position\s*\+=\s*velocity\b/.test(line) && !/\bdelta\b/.test(line)) add(n, "warning", "`position += velocity` without `* delta` moves by a per-frame amount. Use `* delta`, or `move_and_slide()` on a CharacterBody.");
            if (/\bmove_and_slide\s*\(\s*\)/.test(line) && /\bdelta\b/.test(lines.slice(Math.max(0, i - 3), i).join("\n")) && /velocity\s*\*\s*delta/.test(lines.slice(Math.max(0, i - 3), i).join("\n"))) {
                add(n, "warning", "Velocity looks pre-multiplied by delta before `move_and_slide()`, which already applies delta. Keep velocity in units per second.");
            }
            if (/\blerp\s*\([^)]*,\s*0?\.\d+\s*\)/.test(line) && (fn === "_process" || fn === "_physics_process")) add(n, "check", "lerp with a constant weight each frame depends on the frame rate. For smoothing use `lerp(a, b, 1.0 - exp(-speed * delta))`.");
            if (/\.rotation(_degrees)?(\.[xyz])?\s*[-+]?=/.test(line) && /\bslerp|lerp\b/.test(line) && /rotation/.test(line)) add(n, "check", "Interpolating Euler angles can spin the long way and gimbal-lock. Interpolate orientation with `Quaternion.slerp` (or `lerp_angle` for one axis).");
        });
        return issues;
    }

    function lintShader(path, text, opts) {
        const issues = [];
        const add = (line, severity, message) => issues.push({ path, line, severity, message });
        const lines = text.split("\n");
        const isInclude = /\.gdshaderinc$/i.test(path);
        const firstCode = lines.findIndex(l => l.trim() && !/^\s*(\/\/|\/\*|\*)/.test(l));
        if (!isInclude && /\.(gdshader|shader)$/i.test(path) && !lines.some(l => /^\s*shader_type\s+(spatial|canvas_item|particles|sky|fog)\s*;/.test(l))) {
            add(firstCode + 1 || 1, "error", "A Godot shader must start with `shader_type spatial;` (or canvas_item, particles, sky, fog).");
        }
        let inComment = false;
        lines.forEach((raw, i) => {
            const n = i + 1;
            let line = raw;
            if (inComment) { if (!line.includes("*/")) return; line = line.slice(line.indexOf("*/") + 2); inComment = false; }
            line = line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");
            if (line.includes("/*")) { line = line.slice(0, line.indexOf("/*")); inComment = true; }
            if (!line.trim()) return;
            if (/^\s*#version\b/.test(line)) add(n, "error", "`#version` isn't allowed: Godot's shading language isn't raw GLSL.");
            if (/\b(gl_FragColor|gl_Position|gl_FragCoord)\b/.test(line)) add(n, "error", "GLSL built-in. In Godot write ALBEDO / COLOR (output), VERTEX / POSITION (vertex), FRAGCOORD (pixel position).");
            if (/\btexture2D(Lod)?\s*\(/.test(line)) add(n, "error", "`texture2D` is old GLSL. Use `texture(sampler, uv)` (or `textureLod`).");
            if (/\b(attribute|varying\s+in|out\s+vec4\s+\w+\s*;)/.test(line) && !/^\s*varying\s+\w/.test(line)) add(n, "error", "GLSL in/out declarations aren't used in Godot shaders: use built-ins, and `varying` to pass values from vertex() to fragment().");
            if (opts.major >= 4) {
                if (/\bhint_color\b/.test(line)) add(n, "error", "`hint_color` is Godot 3. Use `source_color` (e.g. `uniform vec4 tint : source_color = vec4(1.0);`).");
                if (/\bhint_albedo\b/.test(line)) add(n, "error", "`hint_albedo` is Godot 3. Use `source_color`.");
                if (/\b(SCREEN_TEXTURE|DEPTH_TEXTURE|NORMAL_ROUGHNESS_TEXTURE)\b/.test(line)) add(n, "error", "Godot 4 removed SCREEN_TEXTURE/DEPTH_TEXTURE built-ins. Declare `uniform sampler2D screen_tex : hint_screen_texture, filter_linear_mipmap;` (or hint_depth_texture) and sample that.");
                if (/\bWORLD_MATRIX\b/.test(line)) add(n, "error", "`WORLD_MATRIX` is Godot 3. Use `MODEL_MATRIX`.");
                if (/\bCAMERA_MATRIX\b/.test(line)) add(n, "error", "`CAMERA_MATRIX` is Godot 3. Use `INV_VIEW_MATRIX`.");
                if (/\bINV_CAMERA_MATRIX\b/.test(line)) add(n, "error", "`INV_CAMERA_MATRIX` is Godot 3. Use `VIEW_MATRIX`.");
                if (/\bWORLD_NORMAL_MATRIX\b/.test(line)) add(n, "error", "Use `MODEL_NORMAL_MATRIX` in Godot 4.");
            }
            // Godot shaders have no implicit int -> float conversion.
            const decl = line.match(/\b(float|vec[234])\s+\w+\s*=\s*(-?\d+)\s*;/);
            if (decl) add(n, "error", `Integer literal ${decl[2]} assigned to ${decl[1]}: Godot shaders don't convert int to float. Write ${decl[2]}.0.`);
            const ctor = line.match(/\b(vec[234]|mat[234])\s*\(([^()]*)\)/g) || [];
            for (const c of ctor) {
                const args = c.replace(/^\w+\s*\(|\)$/g, "").split(",").map(a => a.trim());
                if (args.some(a => /^-?\d+$/.test(a))) { add(n, "error", `\`${c}\` has an integer argument; float vectors need float literals (1.0, not 1).`); break; }
            }
            if (/\b(float|vec[234])\s+\w+\s*=[^;]*[^.\w]\d+\s*[*\/+-]\s*\w/.test(line) && /[^.\d]\d+\s*[*\/]\s*[A-Za-z_]/.test(line)) {
                add(n, "check", "Integer literal in a float expression; Godot shaders need `2.0 * x`, not `2 * x`.");
            }
        });
        return issues;
    }

    const GODOT_NODE_BASES = /\b(Node|Node2D|Node3D|CharacterBody[23]D|RigidBody[23]D|StaticBody[23]D|Area[23]D|Control|Sprite[23]D|AnimatedSprite[23]D|Camera[23]D|Resource|RefCounted|GodotObject|CanvasLayer|AnimationPlayer|Label|Button|Panel|MeshInstance3D|Marker[23]D|RayCast[23]D|Timer|AudioStreamPlayer[23]?D?|Path[23]D|PathFollow[23]D|TileMap|TileMapLayer|SubViewport|VehicleBody3D|PhysicsBody[23]D|CollisionObject[23]D)\b/;

    function lintCsharp(path, text, opts) {
        const issues = [];
        if (!/\busing\s+Godot\s*;|\bGodot\.\w/.test(text)) return issues;
        const add = (line, severity, message) => issues.push({ path, line, severity, message });
        text.split("\n").forEach((raw, i) => {
            const n = i + 1;
            const line = raw.replace(/\/\/.*$/, "");
            const cls = line.match(/\bclass\s+(\w+)\s*:\s*([\w.]+)/);
            if (opts.major >= 4 && cls && GODOT_NODE_BASES.test(cls[2]) && !/\bpartial\b/.test(line)) add(n, "error", `Godot 4 C# scripts must be \`partial\`: \`public partial class ${cls[1]} : ${cls[2]}\`, or the source generators can't add signals and exports.`);
            if (/\b(Vector[234]i?|Transform[23]D|Basis|Quaternion|Color|Rect2i?|Aabb|Plane)\b[^;\n]*\bwith\s*\{/.test(line) || /\b(Velocity|Position|GlobalPosition|Rotation|Scale)\s+with\s*\{/.test(line)) {
                add(n, "error", "Godot's C# math types are structs, not records: `with { }` doesn't compile. Copy, change, assign: `var v = Velocity; v.Y = 0; Velocity = v;`.");
            }
            if (/\b(Velocity|Position|GlobalPosition|Rotation|RotationDegrees|Scale|GlobalRotation|LinearVelocity|Size|Modulate)\.(X|Y|Z|W|R|G|B|A)\s*([-+*\/]?=)(?!=)/.test(line) && !/\bvar\b|\.\w+\.\w+\.(X|Y|Z)/.test(line.split("=")[0].replace(/\bthis\./, ""))) {
                add(n, "error", "Can't change a field of a struct returned by a property (CS1612). Copy it to a local, change the field, then assign it back.");
            }
            if (/\bMoveAndSlide\s*\(\s*[^)\s]/.test(line)) add(n, "error", "In Godot 4 `MoveAndSlide()` takes no arguments: set `Velocity`, then call `MoveAndSlide()`.");
            if (opts.major >= 4 && /\boverride\s+void\s+_(Physics)?Process\s*\(\s*float\b/.test(line)) add(n, "error", "Godot 4 passes delta as double: `public override void _PhysicsProcess(double delta)`; cast with `(float)delta` where you need a float.");
            if (/\bpublic\s+void\s+_(Ready|Process|PhysicsProcess|Input|UnhandledInput|EnterTree|ExitTree|Draw|IntegrateForces)\s*\(/.test(line)) add(n, "error", "Engine callbacks need `override`: `public override void _Ready()`. Without it Godot never calls the method.");
            if (/\bGetNode\s*\(\s*"/.test(line) && !/GetNode\s*</.test(line)) add(n, "info", "Prefer the typed `GetNode<Type>(\"path\")`, which fails loudly when the node type is wrong.");
        });
        return issues;
    }

    // res:// files a script or scene loads that aren't in the project.
    function missingResources(index, f) {
        const issues = [];
        const lines = f.text.split("\n");
        for (const imp of f.imports) {
            if (imp.how !== "res" || imp.resolved) continue;
            // Only paths the file loads; a res:// string it writes to or checks for isn't an error.
            if (!/\b(pre)?load\s*\(|ext_resource|^\s*extends\s|ResourceLoader\.load|GD\.Load|change_scene_to_file|#include/.test(lines[imp.line - 1] || "")) continue;
            const rel = imp.spec.replace(/^res:\/\//, "").split("::")[0];
            // Imported assets (textures, sounds, models) aren't text, so the index can't see them.
            if (!/\.(gd|cs|tscn|scn|tres|res|gdshader|gdshaderinc|shader|json|cfg)$/i.test(rel)) continue;
            issues.push({ path: f.path, line: imp.line, severity: "error", message: `${imp.spec} doesn't exist in the project. Loading it fails at runtime; fix the path or create the file.` });
        }
        return issues;
    }

    function godotCheck(index, target = "") {
        const opts = { major: index.godot ? index.godot.major : 4 };
        let files = [...index.files.values()].filter(f => ["gd", "shader", "cs", "scene"].includes(f.lang));
        if (target) {
            const wanted = String(target).replace(/\\/g, "/").replace(/^res:\/\//, "").replace(/\/$/, "").toLowerCase();
            files = files.filter(f => { const p = f.path.toLowerCase(); return p === wanted || p.endsWith("/" + wanted) || p.startsWith(wanted + "/") || p.includes("/" + wanted + "/"); });
            if (!files.length) return `No Godot scripts, scenes or shaders match "${target}". Call code_map to see the files.`;
        }
        if (!files.length) return "The project has no GDScript, C#, shader or scene files to check.";
        const issues = [];
        for (const f of files) {
            if (f.lang === "gd") issues.push(...lintGdscript(f.path, f.text, opts));
            else if (f.lang === "shader") issues.push(...lintShader(f.path, f.text, opts));
            else if (f.lang === "cs") issues.push(...lintCsharp(f.path, f.text, opts));
            if (f.lang !== "cs") issues.push(...missingResources(index, f));
        }
        const order = { error: 0, warning: 1, check: 2, info: 3 };
        issues.sort((a, b) => order[a.severity] - order[b.severity] || a.path.localeCompare(b.path) || a.line - b.line);
        const counts = issues.reduce((c, i) => (c[i.severity] = (c[i.severity] || 0) + 1, c), {});
        const head = `Checked ${files.length} Godot file(s) for Godot ${index.godot ? index.godot.version : "4 (no project.godot found, so Godot 4 assumed)"}: `
            + (issues.length ? ["error", "warning", "check", "info"].filter(s => counts[s]).map(s => `${counts[s]} ${s}${counts[s] > 1 ? "s" : ""}`).join(", ") : "no problems found")
            + ". This is a static check; when a command tool exists, also run Godot headless as the engine guide says.";
        return clip([head, ...issues.slice(0, 120).map(i => `${i.path}:${i.line} [${i.severity}] ${i.message}`), issues.length > 120 ? `[${issues.length - 120} more]` : ""].filter(Boolean).join("\n"), MAX_RESULT_CHARS);
    }

    // ---------------------------------------------------------------- the indexer

    // Keeps one index per workspace. ws = { label, list(), read(path), contents? } as the
    // page's getWorkspace returns it; isIndexable(path) picks the files worth parsing.
    function createIndexer({ isIndexable = path => Boolean(langOf(path)), now = () => Date.now() } = {}) {
        const states = new Map();
        async function index(ws, { changed = [] } = {}) {
            if (!ws) throw new Error("No project is connected.");
            changed = changed.filter(p => isIndexable(p));
            const key = ws.label || "project";
            const state = states.get(key) || { texts: new Map(), readAt: new Map(), index: null, listedAt: 0, paths: [] };
            states.set(key, state);
            if (!state.paths.length || now() - state.listedAt > LIST_REFRESH_MS || changed.some(p => !state.paths.includes(p))) {
                state.paths = (await ws.list()).filter(p => isIndexable(p)).slice(0, MAX_INDEX_FILES);
                state.listedAt = now();
            }
            const changedSet = new Set(changed);
            const todo = [];
            let dirty = !state.index;
            for (const path of state.paths) {
                if (ws.contents && typeof ws.contents[path] === "string") {
                    if (state.texts.get(path) !== ws.contents[path]) { state.texts.set(path, ws.contents[path]); dirty = true; }
                } else if (!state.texts.has(path) || changedSet.has(path) || now() - (state.readAt.get(path) || 0) > REFRESH_MS) todo.push(path);
            }
            for (let i = 0; i < todo.length; i += READ_CONCURRENCY) {
                await Promise.all(todo.slice(i, i + READ_CONCURRENCY).map(async path => {
                    let text;
                    try { text = await ws.read(path); } catch (err) { text = null; }
                    state.readAt.set(path, now());
                    if (typeof text !== "string" || /^Error: /.test(text) || text.length > MAX_FILE_CHARS) { if (state.texts.delete(path)) dirty = true; return; }
                    if (state.texts.get(path) !== text) { state.texts.set(path, text); dirty = true; }
                }));
            }
            const listed = new Set(state.paths);
            for (const path of [...state.texts.keys()]) if (!listed.has(path)) { state.texts.delete(path); dirty = true; }
            if (dirty) state.index = buildIndex(Object.fromEntries(state.texts), { previous: state.index });
            return state.index;
        }
        // An index already built for this workspace, without reading anything.
        function cached(ws) { return ws && states.get(ws.label || "project")?.index || null; }
        return { index, cached, forget: () => states.clear() };
    }

    // ---------------------------------------------------------------- prompt blocks

    // Definitions of names the request mentions, so the agent starts at the right lines.
    function contextNote(index, request, maxChars = 2500) {
        if (!index || !index.files.size) return "";
        const words = [...new Set(String(request || "").match(/[A-Za-z_][\w]{2,}/g) || [])];
        const hits = [];
        for (const w of words) {
            const defs = index.defs.get(w);
            if (defs && defs.length <= 6) for (const d of defs) hits.push(`${w}: ${d.kind} at ${d.path}:${d.line}${d.end > d.line ? `-${d.end}` : ""}`);
        }
        const out = [];
        if (index.godot) out.push(`Godot ${index.godot.version} project${index.godot.mainScene ? `, main scene ${index.godot.mainScene}` : ""}${index.godot.autoloads.length ? `, autoloads ${index.godot.autoloads.map(a => a.name).join(", ")}` : ""}.`);
        if (hits.length) out.push("Names from the request defined in the project:", ...hits.slice(0, 20));
        if (!out.length) return "";
        return clip(`\n\n[Code map] ${out.join("\n")}`, maxChars);
    }

    const GAME_TASK = /\b(godot|gdscript|gdshader|tscn|tres|shaders?|glsl|hlsl|CharacterBody[23]D|RigidBody[23]D|Area[23]D|move_and_slide|MoveAndSlide|_physics_process|PhysicsProcess|quaternions?|euler angles?|transform3d|basis|raycasts?|hit ?box(es)?|hurt ?box(es)?|frame[- ]data|state machines?|game ?engines?|game ?loop|fixed ?time ?step|collisions?|rigid ?body|kinematic|physics (loop|engine|step|tick)|inverse kinematics|netcode|rollback|unity|unreal|monogame|bevy|raylib|sdl2?|blender|bpy|gltf|glb)\b|\.(gd|gdshader|tscn|tres|glb|gltf|blend)\b/i;
    const BLENDER_TASK = /\b(blender|bpy|gltf|glb|\.blend)\b/i;

    function isGameTask(text) { return GAME_TASK.test(String(text || "")); }

    const ENGINE_GUIDE = `GAME ENGINE GUIDE (Godot 4 unless the project says otherwise; the [Code map] and code_map show the version).

WORKFLOW FOR ENGINE CODE
1. Map before you touch: code_map (focus on the folder or scene), file_outline of each script involved, and find_symbol for every signal, method, node path or class_name you change. Signals connected in the editor live in .tscn files ([connection ... method="_on_x"]), and find_symbol searches those too.
2. Write a 2-4 line plan first: the coordinate space (local or global), the units (per second or per physics tick), which callback runs it (_physics_process for anything physics), and every file you will edit.
3. Edit with the file tools, then run godot_check on each changed script, scene and shader, and fix every error it reports.
4. On the user's computer, godot_validate runs the real Godot headless on the project (as saved on disk) and reports parse and runtime errors; use it after editing scripts (gamedev_status says whether Godot is installed). Otherwise, with a command tool (run_command), check that Godot is installed (\`godot --version\`, or godot4) and validate for real: \`godot --headless --path <folder with project.godot> --check-only --script res://path/to/script.gd\` for each changed script, then \`godot --headless --path <folder> --quit-after 120\` to load the main scene; read every "SCRIPT ERROR", "Parse Error" and "ERROR:" line and fix it. For C#, \`dotnet build\` in the project folder. If Godot isn't installed, say the code was checked statically only.

GDSCRIPT 2.0 (Godot 4)
- Typed code: \`var speed: float = 5.0\`, \`func hit(damage: int) -> void:\`, \`:=\` to infer. Annotations: @export, @export_range(0, 10, 0.5), @onready, @tool. Indent with tabs only.
- Signals: \`signal hit(damage: int)\`, \`hit.emit(3)\`, \`button.pressed.connect(_on_pressed)\`, \`await get_tree().create_timer(0.5).timeout\`, \`await get_tree().physics_frame\`.
- CharacterBody3D/2D: change \`velocity\` (units per second), then \`move_and_slide()\` with NO arguments (it applies delta). is_on_floor()/get_slide_collision() are valid after move_and_slide().
- Scenes: \`load(...).instantiate()\`, \`preload\` for constant paths, \`add_child\`, \`queue_free()\`. Change physics state from callbacks with \`set_deferred\` / \`call_deferred\`.
- Input: \`Input.get_vector("left", "right", "forward", "back")\` for movement, actions from the Input Map, \`_unhandled_input(event)\` for one-off presses.

C# IN GODOT 4
- \`public partial class Player : CharacterBody3D\` (partial is required), \`public override void _PhysicsProcess(double delta)\` (delta is double; cast \`(float)delta\`), \`[Export] public float Speed = 5f;\`, \`GetNode<Camera3D>("Camera3D")\`.
- Signals: \`[Signal] public delegate void HitEventHandler(int damage);\` then \`EmitSignal(SignalName.Hit, 3)\`; connect with \`Hit += OnHit;\`.
- Vector2/3, Basis, Transform3D, Quaternion are structs: never \`with { }\`, and never \`Velocity.Y = 0\` (CS1612). Copy, change, assign: \`var v = Velocity; v.Y = 0; Velocity = v;\`. Components are capitalized (X, Y, Z).

SHADERS (Godot shading language, not raw GLSL)
- First line: \`shader_type spatial;\` (or canvas_item, particles, sky, fog), then optional \`render_mode unshaded, cull_disabled;\`.
- No implicit int to float: write 1.0, vec3(1.0, 0.0, 0.0), 2.0 * x.
- Uniforms: \`uniform vec4 tint : source_color = vec4(1.0);\`, \`uniform float amount : hint_range(0.0, 1.0) = 0.5;\`, \`uniform sampler2D albedo_tex : source_color, filter_linear_mipmap;\`, screen reads with \`uniform sampler2D screen_tex : hint_screen_texture;\`.
- spatial: vertex() works on VERTEX/NORMAL in model space (MODEL_MATRIX to world); fragment() writes ALBEDO, ALPHA (turns on transparency), ROUGHNESS, METALLIC, EMISSION, NORMAL_MAP; light() for custom lighting. canvas_item: COLOR = texture(TEXTURE, UV) * modulate. Pass data with \`varying vec3 world_pos;\`. Time is TIME.
- Godot 3 names to avoid: hint_color, SCREEN_TEXTURE, WORLD_MATRIX, CAMERA_MATRIX, texture2D, gl_FragColor.

3D MATH
- Godot is right-handed and Y-up; a node's forward is \`-global_transform.basis.z\`, right is \`basis.x\`, up is \`basis.y\`. Basis columns are the local axes; \`transform * point\` converts local to parent space, \`transform.affine_inverse() * point\` goes back.
- Rotate orientations with quaternions (Quaternion(axis, angle) with a NORMALIZED axis; \`q.slerp(target, t)\`), not accumulated Euler angles (gimbal lock, long-way spins). Re-orthonormalize a basis you multiply every frame (\`basis = basis.orthonormalized()\`).
- \`looking_at\`/\`look_at\` fail when the direction is parallel to up: pick another up vector. Use \`atan2(x, z)\` for yaw, \`lerp_angle\` / \`angle_difference\` for wrapped angles.
- dot(a, b) > 0 means same side; cross gives the perpendicular (order matters). Normalize before using a direction, and guard zero-length vectors (\`if v.length_squared() > 0.0001\`).
- Frame-rate independent smoothing: \`value = lerp(value, target, 1.0 - exp(-sharpness * delta))\`, never a constant weight per frame.

PHYSICS LOOPS
- Gameplay physics in \`_physics_process(delta)\` (fixed rate, Engine.physics_ticks_per_second, default 60); visuals in \`_process\`. Rates times delta (\`velocity.y -= gravity * delta\`); move_and_slide already uses delta, so don't multiply velocity by it yourself.
- Custom loop: fixed timestep with an accumulator: \`acc += min(frame_time, 0.25); while acc >= DT: step(DT); acc -= DT\`, render with \`alpha = acc / DT\` interpolation. Semi-implicit Euler: update velocity first, then position. Clamp frame time to avoid the spiral of death.
- Raycasts and shape queries in the physics step: \`PhysicsRayQueryParameters3D.create(from, to, mask)\` with \`get_world_3d().direct_space_state.intersect_ray(query)\`, or a RayCast3D node with \`force_raycast_update()\`.
- Collision layers say what a body IS, masks what it SCANS. Fast bodies tunnel: enable continuous_cd or use a ray/shape cast along the motion.
- Determinism (replays, rollback): seeded RandomNumberGenerator, no gameplay in _process, no dependence on node order or wall-clock time.

FRAME-DATA STATE MACHINES (fighters, action games)
- Count frames in physics ticks, never seconds. Store each move as data (a Resource with @export fields): startup, active, recovery frames, damage, hitstun, blockstun, pushback, cancel windows, hitbox shapes per frame.
- One state active at a time with enter(), exit(), physics_update(delta) and handle_input(); transitions are decided in one place (the state machine), not scattered across nodes.
- Fixed order each tick: read input (into a buffer kept 4-8 frames for leniency) -> update state and frame counter -> move -> enable hitboxes for active frames -> resolve hits -> apply hitstop (freeze the counter N frames).
- Hitboxes as Area3D/Area2D toggled per frame (\`monitoring\` via set_deferred) or shape queries in the step; hurtboxes on a separate layer. Frame advantage = attacker recovery remaining minus defender stun.
- Show the frame table (startup/active/recovery, advantage) in your reply when you add or change a move.

LIVE EDITOR AND BLENDER (Windows app or CoDev on the computer)
- godot_editor controls the open Godot editor through the CoDev Bridge plugin: inspect the scene_tree, add_node, instantiate scenes and .glb models, set_property, play and stop, save_scene. If it says the plugin is missing, call godot_install_bridge (the user approves) and ask the user to reopen the project. Keep the game loop in GDScript/C#; use the bridge for one-off edits, never frame-by-frame control.
- blender_run runs a bpy script in Blender in the background and saves to the project (output: "assets/models/x.glb" exports glTF for Godot). Then godot_editor "rescan" imports it and "instantiate" places it. Model in meters, +Z up in Blender (the glTF exporter converts to Godot's +Y up), apply transforms before export, name objects clearly (suffix -col makes Godot generate collision, -rigid a rigid body, -noimp skips the node).

OTHER ENGINES: Unity physics in FixedUpdate with Rigidbody (not transform) moves; Unreal uses Tick(DeltaSeconds) and UPROPERTY for editor values. Same math and fixed-step rules.`;

    const BLENDER_GUIDE = `BLENDER (bpy, Blender 4.x) for blender_run
- Start clean: \`bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()\` (the factory scene has a cube, camera and light). Prefer bpy.data and bmesh over bpy.ops where possible: ops depend on context and selection.
- Primitives: \`bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0))\`, then \`obj = bpy.context.active_object\`. Custom meshes: \`mesh = bpy.data.meshes.new("Rock"); mesh.from_pydata(verts, [], faces); mesh.update(); obj = bpy.data.objects.new("Rock", mesh); bpy.context.collection.objects.link(obj)\`.
- Modifiers: \`m = obj.modifiers.new("Bevel", "BEVEL"); m.width = 0.05\`; apply with \`bpy.context.view_layer.objects.active = obj; bpy.ops.object.modifier_apply(modifier=m.name)\` (the glTF exporter can also apply them with export_apply=True).
- Materials (Principled BSDF, what glTF exports): \`mat = bpy.data.materials.new("Stone"); mat.use_nodes = True; bsdf = mat.node_tree.nodes["Principled BSDF"]; bsdf.inputs["Base Color"].default_value = (0.5, 0.5, 0.5, 1); bsdf.inputs["Roughness"].default_value = 0.8; obj.data.materials.append(mat)\`.
- Transforms: apply before export with \`bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)\` on the selected objects. Units are meters; Blender is +Z up and the exporter converts to Godot's +Y up.
- Animation: \`obj.location = (0, 0, 0); obj.keyframe_insert("location", frame=1)\`; actions export as glTF animations that Godot imports into an AnimationPlayer.
- Export: blender_run exports to its output path when the script doesn't; to control it: \`bpy.ops.export_scene.gltf(filepath=CODEV_OUTPUT, export_format="GLB", export_apply=True, use_selection=False)\`.
- Godot import hints in object names: "-col" (collision from the mesh), "-convcol" (convex collision), "-rigid" (RigidBody3D), "-noimp" (skip).
- Print what you made (object names, vertex counts) so the result shows in the tool output.`;

    function engineGuide(text) {
        if (!isGameTask(text)) return "";
        return BLENDER_TASK.test(String(text)) ? `${ENGINE_GUIDE}\n\n${BLENDER_GUIDE}` : ENGINE_GUIDE;
    }

    const BIG_PROJECT_RULES = `[Large project tools] code_map (the project's files, symbols and who uses what), find_symbol (where a name is defined and every place it's used, scene files included), file_outline (a file's functions and classes with line ranges, its imports and dependents), read_lines (exact line ranges of a long file), architecture_review (copy-pasted code, redundant definitions, unused code, import cycles, oversized files) and godot_check (static checks for Godot scripts, scenes and shaders).
- Work file by file: before editing a function, class or signal, find_symbol it to see every caller; read the lines you change with read_lines rather than whole long files.
- A change touching more than one file: first write a short plan naming each file and what changes there, then edit, then find_symbol the old names and signatures again to confirm nothing still uses them.
- Don't add redundant abstractions: before writing a helper, wrapper, manager or new module, search for an existing one and reuse or extend it; follow the patterns the project already uses; keep each change as small as the task allows.
- For a cleanup, refactor or "review the architecture" request: run architecture_review, fix the largest items one at a time while keeping behavior the same, and verify each step (tests or checks when a command tool exists, otherwise find_symbol and reading back).`;

    // ---------------------------------------------------------------- tools

    // deps.getIndex(ctx) -> the index for the agent's workspace (may throw "No project...").
    function buildTools(deps) {
        const withIndex = run => async (args, ctx) => {
            let index;
            try { index = await deps.getIndex(ctx); } catch (err) { return `The project index isn't available: ${err.message}`; }
            if (!index || !index.files.size) return "The project has no source files to index. Connect a project folder first.";
            return run(index, args || {}, ctx);
        };
        return [
            {
                name: "code_map",
                description: "Get a map of the user's project: languages and size, the Godot version, main scene and autoloads when it's a Godot game, the most depended-on files, and every file with its functions/classes (with line numbers) and which files it uses and is used by. Call it first on an unfamiliar or large project; pass focus to zoom into a folder, file name or symbol.",
                inputSchema: { type: "object", properties: { focus: { type: "string", description: "Optional: a folder (\"scripts/player\"), part of a file name, or a symbol name to limit the map to." } } },
                run: withIndex((index, { focus }) => codeMap(index, { focus }))
            },
            {
                name: "find_symbol",
                description: "Find where a function, class, method, signal, variable or node is defined and every line that uses it, across all project files (scripts, scenes and shaders). Use it before renaming or changing a signature, to find every caller, and to check that nothing still uses old code.",
                inputSchema: { type: "object", properties: { name: { type: "string", description: "The exact name, like take_damage, PlayerController or health_changed." } }, required: ["name"] },
                run: withIndex((index, { name }) => findSymbol(index, name))
            },
            {
                name: "file_outline",
                description: "Outline one project file: its functions, classes, signals and other symbols with their line ranges, what it imports or loads, and which files depend on it. Use it to find the lines to read in a long file.",
                inputSchema: { type: "object", properties: { path: { type: "string", description: "The file path (a res:// path or just the file name works when it's unique)." } }, required: ["path"] },
                run: withIndex((index, { path }) => fileOutline(index, path))
            },
            {
                name: "read_lines",
                description: `Read a range of lines from a project file, with line numbers (up to ${MAX_READ_LINES} lines at a time). Use it for long files instead of reading the whole file, together with file_outline.`,
                inputSchema: { type: "object", properties: {
                    path: { type: "string", description: "The file path." },
                    start: { type: "integer", description: "First line (1-based)." },
                    end: { type: "integer", description: "Last line (inclusive)." }
                }, required: ["path", "start"] },
                run: withIndex((index, { path, start, end }) => readLines(index, path, start, end))
            },
            {
                name: "architecture_review",
                description: "Review the project's structure for technical debt: copy-pasted code blocks, the same function or class defined in several files, functions and classes nothing uses, import cycles, very large files and very long functions, and the files most of the project depends on. Use it for cleanup, refactoring or architecture questions, and after a big change to check nothing redundant was added.",
                inputSchema: { type: "object", properties: { focus: { type: "string", description: "Optional: limit the findings to paths containing this text, like a folder name." } } },
                run: withIndex((index, { focus }) => architectureReview(index, { focus }))
            },
            {
                name: "godot_check",
                description: "Check Godot files without running Godot: GDScript (Godot 3 code in a Godot 4 project, mixed indentation, physics in _process, frame-rate dependent movement), C# (missing partial or override, struct field assignment, float delta), shaders (missing shader_type, GLSL-isms, int literals in float math, Godot 3 hints) and res:// paths that don't exist. Run it on every Godot file you change.",
                inputSchema: { type: "object", properties: { path: { type: "string", description: "Optional: a file or folder to check; leave it out to check the whole project." } } },
                run: withIndex((index, { path }) => godotCheck(index, path))
            }
        ];
    }

    const TOOL_NAMES = ["code_map", "find_symbol", "file_outline", "read_lines", "architecture_review", "godot_check"];

    function describe(name, args = {}) {
        if (name === "code_map") return `🗺️ Mapping the project${args.focus ? ` (${args.focus})` : ""}`;
        if (name === "find_symbol") return `🔎 Finding every use of ${args.name}`;
        if (name === "file_outline") return `📑 Outlining ${args.path}`;
        if (name === "read_lines") return `📄 Reading ${args.path} lines ${args.start}${args.end ? `-${args.end}` : "+"}`;
        if (name === "architecture_review") return `🏗️ Reviewing the architecture${args.focus ? ` of ${args.focus}` : ""}`;
        if (name === "godot_check") return `🎮 Checking Godot files${args.path ? ` in ${args.path}` : ""}`;
        if (name === "gamedev_status") return "🎮 Checking Godot and Blender on this computer";
        if (name === "godot_validate") return `🎮 Running Godot headless to check ${Array.isArray(args.files) && args.files.length ? args.files.join(", ") : "the scripts"}`;
        if (name === "godot_editor") return `🎮 Godot editor: ${args.action}${args.args && (args.args.path || args.args.node || args.args.name) ? ` ${args.args.path || args.args.node || args.args.name}` : ""}`;
        if (name === "godot_install_bridge") return "🎮 Installing the CoDev Bridge plugin (asks you first)";
        if (name === "blender_run") return `🧊 Running Blender${args.output ? ` to make ${args.output}` : ""} (asks you first)`;
        return "";
    }

    return {
        TOOL_NAMES, ENGINE_GUIDE, BIG_PROJECT_RULES, GAME_TASK,
        langOf, extractSymbols, extractImports, buildIndex, createIndexer, buildTools, describe,
        codeMap, findSymbol, fileOutline, readLines, architectureReview, duplicateBlocks, importCycles, godotCheck,
        lintGdscript, lintShader, lintCsharp, contextNote, engineGuide, isGameTask
    };
});
