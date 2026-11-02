// CoDev's notes and data tables: an Obsidian vault (Markdown notes) in place of
// Google Docs, and CSV, TSV and JSON files in place of Google Sheets, for agents,
// plus the Settings panel that picks where they live.
//
// The vault is a folder of plain files, the same folder Obsidian opens, so the user
// edits the notes in Obsidian (free, obsidian.md) and the tables in any spreadsheet
// app or text editor. It lives in one of two places:
//  - "mega": a folder in the user's MEGA cloud drive (mega-cloud.js), which works on
//    the computer and on the phone. With MEGAsync, the same folder is on the computer
//    for Obsidian to open.
//  - "project": a folder inside the project folder connected in CoDev (computer only).
// Agents search, read, create and edit notes (notes_*) and read, query, create and edit
// tables (table_*). Every change asks the user first, and only when "allow edits" is on.
//
// The same file runs in the page and in Node (tests).
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevNotesTables = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const GUIDE_URL = "https://github.com/phillbennett021423/codev_cloud/blob/main/docs/notes-and-tables.md";
    const STORE = { location: "codev_vault_location", folder: "codev_vault_folder", allowEdit: "codev_vault_allow_edit" };
    const DEFAULT_FOLDER = { mega: "/Obsidian", project: "notes" };
    const NOTES_TOOL_NAMES = ["notes_status", "notes_search", "notes_read", "notes_write", "table_read", "table_write"];
    const READ_CHUNK = 12000;
    const MAX_SCAN = 400;          // notes read for a text search, newest first
    const TABLE_EXT = ["csv", "tsv", "json"];
    const MAX_TABLE_ROWS = 100000;

    const ext = p => { const m = /\.([^.\/]+)$/.exec(String(p || "").toLowerCase()); return m ? m[1] : ""; };
    const baseName = p => String(p || "").split("/").pop().replace(/\.[^.]+$/, "");
    const isNote = p => ext(p) === "md";
    const isTable = p => TABLE_EXT.includes(ext(p));

    function clampInt(value, min, max, fallback) {
        const n = Math.floor(Number(value));
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    }

    // A path inside the vault: forward slashes, no "..", no hidden parts.
    function cleanPath(raw) {
        const parts = String(raw || "").trim().replace(/\\/g, "/").split("/").filter(p => p && p !== ".");
        if (!parts.length || parts.some(p => p === ".." || p.startsWith("."))) return null;
        return parts.join("/");
    }

    // ---- Notes: front matter, tags, links ------------------------------------

    function splitFrontMatter(text) {
        const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text || ""));
        return m ? { yaml: m[1], body: text.slice(m[0].length) } : { yaml: "", body: String(text || "") };
    }

    // Enough YAML for Obsidian properties: "key: value", "key: [a, b]" and "- item" lists.
    function readProperties(yaml) {
        const props = {};
        let listKey = null;
        for (const line of String(yaml || "").split(/\r?\n/)) {
            const item = /^\s+-\s+(.*)$/.exec(line) || (listKey && /^-\s+(.*)$/.exec(line));
            if (item && listKey) { props[listKey].push(unquote(item[1])); continue; }
            const kv = /^([\w][\w -]*):\s*(.*)$/.exec(line);
            if (!kv) continue;
            const key = kv[1].trim(), value = kv[2].trim();
            if (!value) { props[key] = []; listKey = key; continue; }
            listKey = null;
            props[key] = /^\[.*\]$/.test(value) ? value.slice(1, -1).split(",").map(v => unquote(v.trim())).filter(Boolean) : unquote(value);
        }
        return props;
    }
    const unquote = v => String(v).replace(/^(["'])(.*)\1$/, "$2");

    function parseNote(text) {
        const { yaml, body } = splitFrontMatter(text);
        const props = readProperties(yaml);
        const tags = new Set([].concat(props.tags || props.tag || []).map(t => String(t).replace(/^#/, "").toLowerCase()).filter(Boolean));
        for (const m of body.replace(/```[\s\S]*?```/g, "").matchAll(/(^|\s)#([\p{L}\p{N}_\/-]+)/gu)) if (!/^\d+$/.test(m[2])) tags.add(m[2].toLowerCase());
        const links = [];
        for (const m of String(text).matchAll(/!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
            const target = m[1].trim();
            if (target && !links.includes(target)) links.push(target);
        }
        const headings = [...body.matchAll(/^(#{1,6})\s+(.+)$/gm)].map(m => `${m[1]} ${m[2].trim()}`);
        return { props, tags: [...tags], links, headings, body };
    }

    // ---- Tables: CSV, TSV, JSON ----------------------------------------------

    function parseDelimited(text, delimiter) {
        const rows = [];
        let row = [], field = "", quoted = false;
        let i = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
        for (; i < text.length; i++) {
            const ch = text[i];
            if (quoted) {
                if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
            } else if (ch === '"' && field === "") quoted = true;
            else if (ch === delimiter) { row.push(field); field = ""; }
            else if (ch === "\n" || ch === "\r") {
                if (ch === "\r" && text[i + 1] === "\n") i++;
                row.push(field); field = "";
                if (row.length > 1 || row[0] !== "") rows.push(row);
                row = [];
                if (rows.length > MAX_TABLE_ROWS) break;
            } else field += ch;
        }
        if (field !== "" || row.length) { row.push(field); rows.push(row); }
        return rows;
    }

    function delimiterFor(path, text) {
        if (ext(path) === "tsv") return "\t";
        const first = String(text || "").split(/\r?\n/)[0] || "";
        const counts = { ",": 0, ";": 0, "\t": 0 };
        let q = false;
        for (const ch of first) { if (ch === '"') q = !q; else if (!q && ch in counts) counts[ch]++; }
        const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        return best[1] ? best[0] : ",";
    }

    const cellText = v => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

    // A table is { columns: [...], rows: [[...]], format, wrapKey, delimiter }: the first
    // CSV row names the columns; JSON is a list of objects (or of lists), or an object
    // with one such list in it ({ "players": [...] }).
    function parseTable(path, text) {
        if (ext(path) === "json") {
            let data;
            try { data = JSON.parse(text); } catch (err) { return { error: `${path} isn't valid JSON (${err.message}).` }; }
            let wrapKey = null;
            if (!Array.isArray(data) && data && typeof data === "object") {
                wrapKey = Object.keys(data).find(k => Array.isArray(data[k]) && data[k].length && typeof data[k][0] === "object") || Object.keys(data).find(k => Array.isArray(data[k]));
                if (!wrapKey) return { error: `${path} has no list of rows. A JSON table is a list of objects, like [{"name": "A", "points": 10}].` };
                data = data[wrapKey];
            }
            if (!Array.isArray(data)) return { error: `${path} has no list of rows.` };
            if (data.length && Array.isArray(data[0])) {
                const [head, ...body] = data;
                return { format: "json", wrapKey, arrays: true, columns: head.map(cellText), rows: body.map(r => head.map((_, i) => cellText(r[i]))) };
            }
            const columns = [];
            for (const item of data) if (item && typeof item === "object") for (const k of Object.keys(item)) if (!columns.includes(k)) columns.push(k);
            return { format: "json", wrapKey, columns, rows: data.map(item => columns.map(c => cellText(item && item[c]))), types: inferJsonTypes(data, columns) };
        }
        const delimiter = delimiterFor(path, text);
        const all = parseDelimited(String(text || ""), delimiter);
        const width = all.reduce((n, r) => Math.max(n, r.length), 0);
        const columns = (all[0] || []).map((c, i) => String(c).trim() || `Column ${i + 1}`);
        while (columns.length < width) columns.push(`Column ${columns.length + 1}`);
        return { format: "csv", delimiter, columns, rows: all.slice(1).map(r => columns.map((_, i) => r[i] === undefined ? "" : r[i])) };
    }

    // JSON keeps numbers and true/false as they were when a column held only those.
    function inferJsonTypes(data, columns) {
        const types = {};
        for (const c of columns) {
            const kinds = new Set(data.map(d => d && d[c]).filter(v => v !== undefined && v !== null && v !== "").map(v => typeof v));
            types[c] = kinds.size === 1 ? [...kinds][0] : "string";
        }
        return types;
    }

    function typed(value, type) {
        if (value === "") return type === "string" ? "" : null;
        if (type === "number" && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(String(value).trim())) return Number(value);
        if (type === "boolean" && /^(true|false)$/i.test(String(value).trim())) return /^true$/i.test(String(value).trim());
        if (type === "object") { try { return JSON.parse(value); } catch (err) { return value; } }
        if (type === undefined && /^-?\d+(\.\d+)?$/.test(String(value).trim()) && String(value).trim().length < 16) return Number(value);
        return value;
    }

    function serializeTable(table, original) {
        if (table.format === "json") {
            const types = table.types || {};
            const list = table.arrays ? [table.columns, ...table.rows] : table.rows.map(r => {
                const o = {};
                table.columns.forEach((c, i) => { const v = typed(r[i] === undefined ? "" : r[i], types[c]); if (v !== null) o[c] = v; });
                return o;
            });
            let out = list;
            if (table.wrapKey) {
                let wrapper = {};
                try { wrapper = JSON.parse(original); } catch (err) { wrapper = {}; }
                wrapper[table.wrapKey] = list;
                out = wrapper;
            }
            return JSON.stringify(out, null, 2) + "\n";
        }
        const d = table.delimiter || ",";
        const quote = v => { const s = cellText(v); return /["\r\n]/.test(s) || s.includes(d) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
        return [table.columns, ...table.rows].map(r => r.map(quote).join(d)).join("\r\n") + "\r\n";
    }

    // Rows given as lists (in column order) or objects (by column name).
    function toRows(columns, rows) {
        return (Array.isArray(rows) ? rows : []).map(r => Array.isArray(r) ? columns.map((_, i) => cellText(r[i])) : columns.map(c => cellText(r && typeof r === "object" ? findKey(r, c) : "")));
    }
    function findKey(obj, column) {
        if (column in obj) return obj[column];
        const k = Object.keys(obj).find(x => x.toLowerCase() === column.toLowerCase());
        return k ? obj[k] : "";
    }
    function columnIndex(columns, name) {
        const want = String(name || "").trim().toLowerCase();
        let i = columns.findIndex(c => c.toLowerCase() === want);
        if (i < 0) i = columns.findIndex(c => c.toLowerCase().includes(want));
        return want ? i : -1;
    }
    function matches(row, columns, where) {
        return (where || []).every(f => {
            const i = columnIndex(columns, f.column);
            if (i < 0) return false;
            const cell = String(row[i] ?? ""), value = String(f.value ?? "");
            const a = Number(cell), b = Number(value), num = cell.trim() !== "" && value.trim() !== "" && !Number.isNaN(a) && !Number.isNaN(b);
            switch (f.op || "=") {
                case "=": case "==": return num ? a === b : cell.toLowerCase() === value.toLowerCase();
                case "!=": return num ? a !== b : cell.toLowerCase() !== value.toLowerCase();
                case ">": return num && a > b;
                case ">=": return num && a >= b;
                case "<": return num && a < b;
                case "<=": return num && a <= b;
                case "contains": return cell.toLowerCase().includes(value.toLowerCase());
                case "empty": return cell.trim() === "";
                case "not_empty": return cell.trim() !== "";
                default: return false;
            }
        });
    }

    // ---- Where the vault lives -----------------------------------------------

    // A vault in MEGA, through a mega-cloud.js transport.
    function megaStore(transport, folder) {
        const call = async req => {
            const reply = await transport.handle({ ...req, folder });
            if (reply.error) { const err = new Error(reply.error); err.missing = reply.missing; throw err; }
            return reply;
        };
        return {
            kind: "mega", label: `MEGA folder ${folder}`,
            async tree() { try { return (await call({ op: "tree" })).files; } catch (err) { if (err.missing) return []; throw err; } },
            async fetch(path) { try { return (await call({ op: "fetch", path })).text; } catch (err) { if (err.missing) return null; throw err; } },
            async put(path, content) { await call({ op: "put", path, content }); }
        };
    }

    // A vault inside the connected project folder: project = { files() -> { path: text }, read(path) -> text|null, write(path, text) }.
    function projectStore(project, folder) {
        const prefix = cleanPath(folder) ? `${cleanPath(folder)}/` : "";
        return {
            kind: "project", label: `project folder ${prefix || "/"}`,
            async tree() {
                const all = await project.files();
                return Object.keys(all).filter(p => p.startsWith(prefix) && !p.slice(prefix.length).split("/").some(x => x.startsWith(".")))
                    .map(p => ({ path: p.slice(prefix.length), size: String(all[p] || "").length, modified: null }));
            },
            async fetch(path) { return project.read(prefix + path); },
            async put(path, content) {
                const result = await project.write(prefix + path, content);
                if (result && result.error) throw new Error(result.error);
            }
        };
    }

    // ---- The tools -----------------------------------------------------------

    // getStore() -> a store, or { error } saying how to set one up. canEdit() -> bool.
    // confirmWrite(message) -> bool: asked before every change. runTableQuery(entry, args):
    // the page's query_table engine (media-tools.js), for filters, sums and group totals.
    function createNotesTables({ getStore, canEdit = () => false, confirmWrite = () => false, runTableQuery = null }) {
        const cache = new Map(); // path -> { modified, text }

        async function store() {
            const s = await getStore();
            if (!s || s.error) throw new Error((s && s.error) || "No notes vault is set up. The user picks one in Settings > Notes & tables.");
            return s;
        }

        async function textOf(s, file) {
            const hit = cache.get(`${s.label}|${file.path}`);
            if (hit && file.modified && hit.modified === file.modified) return hit.text;
            const text = await s.fetch(file.path);
            if (text !== null && text !== undefined) cache.set(`${s.label}|${file.path}`, { modified: file.modified, text });
            return text;
        }

        // A note or table by path ("Projects/Ideas.md", "Projects/Ideas") or, for notes,
        // by its name alone, the way Obsidian's [[links]] find notes.
        function find(files, ref, kind) {
            const want = cleanPath(ref);
            if (!want) return null;
            const ok = kind === "note" ? isNote : isTable;
            const lower = want.toLowerCase();
            return files.find(f => f.path.toLowerCase() === lower && ok(f.path))
                || (kind === "note" ? files.find(f => f.path.toLowerCase() === `${lower}.md`) : null)
                || files.find(f => ok(f.path) && baseName(f.path).toLowerCase() === baseName(want).toLowerCase() && (!want.includes("/") || f.path.toLowerCase().endsWith(lower.replace(/\.[^.]+$/, "") + "." + ext(f.path))))
                || null;
        }

        const newest = (a, b) => String(b.modified || "").localeCompare(String(a.modified || ""));

        async function notesSearch({ query, tag, folder, kind, max }) {
            const s = await store();
            const all = await s.tree();
            const inFolder = f => !folder || f.path.toLowerCase().startsWith(`${cleanPath(folder) || ""}/`.toLowerCase());
            const limit = clampInt(max, 1, 50, 15);
            if (kind === "tables") {
                const tables = all.filter(f => isTable(f.path) && inFolder(f) && (!query || f.path.toLowerCase().includes(String(query).toLowerCase()))).sort(newest);
                if (!tables.length) return `No CSV, TSV or JSON tables${query ? ` matching "${query}"` : ""} in the ${s.label}.`;
                return tables.slice(0, limit).map(f => `${f.path}${f.modified ? ` · modified ${f.modified.slice(0, 10)}` : ""}`).join("\n") + "\n\n(Read one with table_read and its path.)";
            }
            const notes = all.filter(f => isNote(f.path) && inFolder(f)).sort(newest);
            const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
            const wantTag = String(tag || "").replace(/^#/, "").toLowerCase();
            if (!words.length && !wantTag) {
                if (!notes.length) return `The ${s.label} has no notes yet.`;
                return notes.slice(0, limit).map(f => `${f.path}${f.modified ? ` · modified ${f.modified.slice(0, 10)}` : ""}`).join("\n")
                    + (notes.length > limit ? `\n\n(${notes.length - limit} more; search with a query or tag.)` : "") + "\n\n(Read one with notes_read and its path or name.)";
            }
            const found = [];
            const scanned = notes.slice(0, MAX_SCAN);
            for (const f of scanned) {
                const text = await textOf(s, f);
                if (text === null || text === undefined) continue;
                const note = parseNote(text);
                if (wantTag && !note.tags.some(t => t === wantTag || t.startsWith(`${wantTag}/`))) continue;
                const hay = `${f.path}\n${text}`.toLowerCase();
                if (!words.every(w => hay.includes(w))) continue;
                const line = words.length ? text.split(/\r?\n/).find(l => words.some(w => l.toLowerCase().includes(w)) && l.trim()) : "";
                found.push(`${f.path}${note.tags.length ? ` · #${note.tags.slice(0, 6).join(" #")}` : ""}${line ? `\n  …${line.trim().slice(0, 200)}` : ""}`);
                if (found.length >= limit) break;
            }
            const scope = notes.length > MAX_SCAN ? ` (searched the newest ${MAX_SCAN} of ${notes.length} notes)` : "";
            if (!found.length) return `No notes match${words.length ? ` "${query}"` : ""}${wantTag ? ` with #${wantTag}` : ""}${scope}.`;
            return found.join("\n\n") + `${scope ? `\n\n${scope.trim()}` : ""}\n\n(Read one with notes_read.)`;
        }

        async function notesRead({ note, start }) {
            if (!String(note || "").trim()) return "notes_read needs the note's path or name.";
            const s = await store();
            const all = await s.tree();
            const file = find(all, note, "note");
            if (!file) return `No note "${note}" in the ${s.label}. Find it with notes_search.`;
            const text = await textOf(s, file);
            if (text === null || text === undefined) return `${file.path} couldn't be read.`;
            const parsed = parseNote(text);
            // Backlinks: other notes that [[link]] here.
            const name = baseName(file.path).toLowerCase();
            const backlinks = [];
            for (const f of all.filter(x => isNote(x.path) && x.path !== file.path).sort(newest).slice(0, MAX_SCAN)) {
                const other = await textOf(s, f);
                if (other && parseNote(other).links.some(l => baseName(l).toLowerCase() === name || l.toLowerCase() === file.path.toLowerCase().replace(/\.md$/, ""))) backlinks.push(f.path);
            }
            const head = [`${file.path}${file.modified ? ` · modified ${file.modified.slice(0, 10)}` : ""}`];
            if (parsed.tags.length) head.push(`Tags: #${parsed.tags.join(" #")}`);
            if (parsed.links.length) head.push(`Links to: ${parsed.links.map(l => `[[${l}]]`).join(", ")}`);
            if (backlinks.length) head.push(`Linked from: ${backlinks.slice(0, 20).join(", ")}`);
            start = clampInt(start, 0, Number.MAX_SAFE_INTEGER, 0);
            const part = text.slice(start, start + READ_CHUNK);
            const end = start + part.length;
            return `${head.join("\n")}\n\n${part}${end < text.length ? `\n\n[Characters ${start}-${end} of ${text.length}. Call notes_read again with start ${end} for more.]` : ""}`;
        }

        function editOff() {
            return "Editing notes and tables is off. The user can turn it on in Settings > Notes & tables.";
        }

        async function notesWrite({ note, mode, content, find: findText, replace_with: replaceWith, under_heading: heading }) {
            if (!canEdit()) return editOff();
            mode = ["create", "replace", "append", "edit"].includes(mode) ? mode : "create";
            let path = cleanPath(note);
            if (!path) return "notes_write needs the note's path, like Projects/Ideas.md (no .. or hidden folders).";
            const s = await store();
            const all = await s.tree();
            const existing = find(all, path, "note");
            if (!isNote(path)) path = existing ? existing.path : `${path}.md`;
            else if (existing) path = existing.path;
            const before = existing ? await textOf(s, existing) : null;
            let after, preview;
            if (mode === "create") {
                if (existing) return `${existing.path} already exists. Use mode replace, append or edit to change it.`;
                if (typeof content !== "string") return "notes_write create needs content.";
                after = content;
                preview = `Create the note ${path} in your ${s.label}?\n\n${content.slice(0, 1200)}${content.length > 1200 ? "\n…" : ""}`;
            } else {
                if (!existing || before === null || before === undefined) return `No note ${path} yet. Use mode create.`;
                if (mode === "replace") {
                    if (typeof content !== "string") return "notes_write replace needs content.";
                    after = content;
                    preview = `Replace all of ${path} in your ${s.label}?\n\nNew text:\n${content.slice(0, 1200)}${content.length > 1200 ? "\n…" : ""}`;
                } else if (mode === "append") {
                    if (typeof content !== "string" || !content.trim()) return "notes_write append needs content.";
                    const added = content.replace(/^\n+|\n+$/g, "");
                    if (heading) {
                        const want = String(heading).replace(/^#+\s*/, "").trim().toLowerCase();
                        const lines = before.split("\n");
                        const at = lines.findIndex(l => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim().toLowerCase() === want);
                        if (at < 0) return `${path} has no heading "${heading}". Its headings: ${parseNote(before).headings.join(", ") || "none"}.`;
                        const level = /^(#+)/.exec(lines[at])[1].length;
                        let end = lines.length;
                        for (let i = at + 1; i < lines.length; i++) if (/^(#+)\s/.test(lines[i]) && /^(#+)/.exec(lines[i])[1].length <= level) { end = i; break; }
                        while (end > at + 1 && !lines[end - 1].trim()) end--;
                        lines.splice(end, 0, added);
                        after = lines.join("\n");
                    } else after = `${before.replace(/\s+$/, "")}\n\n${added}\n`;
                    preview = `Add to ${path}${heading ? ` under "${heading}"` : ""} in your ${s.label}?\n\n${added.slice(0, 1200)}`;
                } else {
                    if (typeof findText !== "string" || !findText) return "notes_write edit needs find (the exact text to change) and replace_with.";
                    const count = before.split(findText).length - 1;
                    if (count !== 1) return count ? `"${findText.slice(0, 80)}" appears ${count} times in ${path}. Give more of the text around it so it's unique.` : `"${findText.slice(0, 80)}" isn't in ${path}. Read the note again with notes_read and copy the exact text.`;
                    after = before.replace(findText, () => String(replaceWith ?? ""));
                    preview = `Change ${path} in your ${s.label}?\n\n- ${findText.slice(0, 600)}\n+ ${String(replaceWith ?? "").slice(0, 600)}`;
                }
            }
            if (!(await confirmWrite(preview))) return `The user declined this change to ${path}.`;
            await s.put(path, after);
            cache.delete(`${s.label}|${path}`);
            return `${mode === "create" ? "Created" : "Saved"} ${path} in the ${s.label}.`;
        }

        async function loadTable(s, ref) {
            const all = await s.tree();
            const file = find(all, ref, "table");
            if (!file) return { error: `No table "${ref}" in the ${s.label}. List them with notes_search kind "tables".` };
            const text = await textOf(s, file);
            if (text === null || text === undefined) return { error: `${file.path} couldn't be read.` };
            const table = parseTable(file.path, text);
            if (table.error) return table;
            return { file, text, table };
        }

        async function tableRead(args) {
            const ref = args.table || args.path;
            if (!String(ref || "").trim()) return "table_read needs the table's path, like Data/players.csv.";
            const s = await store();
            const got = await loadTable(s, ref);
            if (got.error) return got.error;
            const { file, table } = got;
            const intro = `${file.path}: ${table.rows.length} rows, columns ${table.columns.join(", ")}.`;
            if (runTableQuery) {
                const entry = { name: file.path, sheets: [{ name: baseName(file.path), columns: table.columns, rows: table.rows }] };
                return `${intro}\n${runTableQuery(entry, { ...args, action: args.action || "rows" })}`;
            }
            const offset = clampInt(args.offset, 0, table.rows.length, 0);
            const limit = clampInt(args.limit, 1, 200, 50);
            const rows = (args.filters ? table.rows.filter(r => matches(r, table.columns, args.filters)) : table.rows).slice(offset, offset + limit);
            return `${intro}\n${[table.columns, ...rows].map(r => r.join(" | ")).join("\n")}`;
        }

        async function tableWrite({ table: ref, path: altPath, mode, columns, rows, where, set, column, value }) {
            if (!canEdit()) return editOff();
            mode = ["create", "replace", "append_rows", "update_rows", "delete_rows", "add_column"].includes(mode) ? mode : "create";
            let path = cleanPath(ref || altPath);
            if (!path) return "table_write needs the table's path, like Data/players.csv (no .. or hidden folders).";
            if (!isTable(path)) path = `${path}.csv`;
            const s = await store();
            let current = null;
            if (mode !== "create") {
                current = await loadTable(s, path);
                if (current.error) return current.error;
                path = current.file.path;
            } else if ((await s.tree()).some(f => f.path.toLowerCase() === path.toLowerCase())) {
                return `${path} already exists. Use mode replace, append_rows, update_rows, delete_rows or add_column.`;
            }
            let table, preview;
            const where_ = Array.isArray(where) ? where : [];
            if (mode === "create" || mode === "replace") {
                let cols = Array.isArray(columns) && columns.length ? columns.map(String) : null;
                if (!cols && Array.isArray(rows) && rows[0] && !Array.isArray(rows[0])) cols = Object.keys(rows[0]);
                if (!cols) return "Give columns (a list of names), or rows as objects.";
                const base = current ? current.table : { format: ext(path) === "json" ? "json" : "csv", delimiter: ext(path) === "tsv" ? "\t" : ",", wrapKey: null };
                table = { ...base, columns: cols, rows: toRows(cols, rows), types: undefined };
                preview = `${mode === "create" ? "Create" : "Replace all of"} the table ${path} in your ${s.label}? ${table.rows.length} rows, columns: ${cols.join(", ")}.\n\n${table.rows.slice(0, 8).map(r => r.join(" | ")).join("\n")}${table.rows.length > 8 ? "\n…" : ""}`;
            } else {
                table = { ...current.table, rows: current.table.rows.map(r => r.slice()) };
                const cols = table.columns;
                if (mode === "append_rows") {
                    const added = toRows(cols, rows);
                    if (!added.length) return "append_rows needs rows.";
                    table.rows.push(...added);
                    preview = `Add ${added.length} row${added.length === 1 ? "" : "s"} to ${path}?\n\n${added.slice(0, 8).map(r => r.join(" | ")).join("\n")}`;
                } else if (mode === "update_rows" || mode === "delete_rows") {
                    if (!where_.length) return `${mode} needs where: which rows, like [{"column": "Player", "op": "=", "value": "Jokic"}].`;
                    const bad = where_.find(f => columnIndex(cols, f.column) < 0);
                    if (bad) return `No column "${bad.column}" in ${path}. Columns: ${cols.join(", ")}.`;
                    const hit = table.rows.filter(r => matches(r, cols, where_));
                    if (!hit.length) return `No rows in ${path} match ${JSON.stringify(where_)}.`;
                    if (mode === "delete_rows") {
                        table.rows = table.rows.filter(r => !matches(r, cols, where_));
                        preview = `Delete ${hit.length} row${hit.length === 1 ? "" : "s"} from ${path}?\n\n${hit.slice(0, 8).map(r => r.join(" | ")).join("\n")}`;
                    } else {
                        if (!set || typeof set !== "object" || !Object.keys(set).length) return "update_rows needs set, like {\"Status\": \"Done\"}.";
                        const sets = Object.entries(set).map(([c, v]) => [columnIndex(cols, c), c, cellText(v)]);
                        const missing = sets.find(([i]) => i < 0);
                        if (missing) return `No column "${missing[1]}" in ${path}. Add it first with mode add_column.`;
                        for (const r of hit) for (const [i, , v] of sets) r[i] = v;
                        preview = `Change ${hit.length} row${hit.length === 1 ? "" : "s"} in ${path}: set ${sets.map(([i, , v]) => `${cols[i]} = ${v}`).join(", ")}?`;
                    }
                } else {
                    if (!String(column || "").trim()) return "add_column needs column (its name).";
                    if (cols.some(c => c.toLowerCase() === String(column).trim().toLowerCase())) return `${path} already has a column "${column}".`;
                    table.columns = [...cols, String(column)];
                    table.rows.forEach(r => r.push(cellText(value ?? "")));
                    preview = `Add the column "${column}" to ${path}${value ? ` (filled with ${value})` : ""}?`;
                }
            }
            if (!(await confirmWrite(`${preview}`))) return `The user declined this change to ${path}.`;
            await s.put(path, serializeTable(table, current ? current.text : ""));
            cache.delete(`${s.label}|${path}`);
            return `Saved ${path} (${table.rows.length} rows) in the ${s.label}.`;
        }

        async function statusReport() {
            let s;
            try { s = await store(); } catch (err) { return `${err.message} Guide: ${GUIDE_URL}`; }
            const files = await s.tree();
            const notes = files.filter(f => isNote(f.path)).length, tables = files.filter(f => isTable(f.path)).length;
            return `The notes vault is the ${s.label}: ${notes} notes and ${tables} tables (CSV, TSV, JSON). Editing is ${canEdit() ? "on (CoDev asks before every change)" : "off; the user can turn it on in Settings > Notes & tables"}. The user opens the same folder in Obsidian to read and edit the notes.`;
        }

        const filterSchema = { type: "array", description: "Optional: rows must match all of these.", items: { type: "object", properties: {
            column: { type: "string", description: "The column to test, by its name." }, op: { type: "string", enum: ["=", "!=", ">", ">=", "<", "<=", "contains", "empty", "not_empty"], description: "How to compare (default =)." }, value: { type: "string", description: "The value to compare with (not needed for empty and not_empty)." } }, required: ["column"] } };

        const TOOLS = {
            notes_status: {
                description: "Check where the user's notes vault is (an Obsidian vault of Markdown notes, plus CSV/JSON data tables; this replaces Google Docs and Sheets), how many notes and tables it has, and whether editing is on. Call it when the user asks about their notes setup or a notes tool they need isn't listed. Not needed when the notes tool you want is already in your tool list: just use it.",
                inputSchema: { type: "object", properties: {} }, run: statusReport
            },
            notes_search: {
                description: "Search the user's Obsidian notes (Markdown) by words in the name or text, or by #tag, or list the newest notes. kind \"tables\" lists the CSV, TSV and JSON data tables instead. Read-only. Use it when the user mentions their notes, a tag or a table without giving its exact path, then notes_read or table_read.",
                inputSchema: { type: "object", properties: {
                    query: { type: "string", description: "Words that must all be in the note (name or text). Leave empty to list notes." },
                    tag: { type: "string", description: "Optional: only notes with this tag (with or without #)." },
                    folder: { type: "string", description: "Optional: a folder inside the vault, like Projects." },
                    kind: { type: "string", enum: ["notes", "tables"], description: "Default notes." },
                    max: { type: "integer", description: "How many results (1-50, default 15)." }
                } }, run: notesSearch
            },
            notes_read: {
                description: "Read one Obsidian note by its path (Projects/Ideas.md) or name (Ideas), with its tags, the notes it [[links]] to and the notes that link to it. Read-only. Use it when the user asks about a note; for a CSV or JSON table use table_read instead.",
                inputSchema: { type: "object", properties: {
                    note: { type: "string", description: "The note's path or name." },
                    start: { type: "integer", description: "Optional: the character to start from, for the next part of a long note." }
                }, required: ["note"] }, run: notesRead
            },
            notes_write: {
                description: "Create or edit an Obsidian note (Markdown, with [[links]], #tags and --- properties --- if useful). mode create makes a new note; append adds text at the end or under_heading; edit swaps one exact piece of text (find -> replace_with); replace rewrites the whole note. CoDev shows the user the change and saves only if they approve. Use it when the user asks to make or change a note; read the note with notes_read before editing it. For a data table use table_write instead.",
                inputSchema: { type: "object", properties: {
                    note: { type: "string", description: "The note's path inside the vault, like Projects/Ideas.md (.md is added if missing)." },
                    mode: { type: "string", enum: ["create", "append", "edit", "replace"], description: "Default create." },
                    content: { type: "string", description: "create/replace: the full Markdown. append: the text to add." },
                    under_heading: { type: "string", description: "append only: add at the end of this heading's section." },
                    find: { type: "string", description: "edit only: the exact text to change (it must appear once)." },
                    replace_with: { type: "string", description: "edit only: the new text." }
                }, required: ["note"] }, run: notesWrite
            },
            table_read: {
                description: "Read or query a CSV, TSV or JSON data table from the notes vault (these replace Google Sheets): action rows lists rows (filters, sort, columns, offset, limit); stats gives count, sum, average, median, min and max; group totals a column per value of another; search finds rows with text; columns describes every column. The math runs over every row. Use it for any number from a table; don't add up rows by eye. For a spreadsheet attached in the chat use query_table instead.",
                inputSchema: { type: "object", properties: {
                    table: { type: "string", description: "The table's path, like Data/players.csv." },
                    action: { type: "string", enum: ["rows", "stats", "group", "search", "columns"], description: "Default rows." },
                    filters: filterSchema,
                    columns: { type: "array", items: { type: "string" }, description: "Optional: columns to show (rows) or measure (stats)." },
                    group_by: { type: "string", description: "group: the column whose values make the groups." }, value_column: { type: "string", description: "group: the column to total per group." },
                    aggregate: { type: "string", enum: ["count", "sum", "avg", "min", "max", "median", "count_distinct"], description: "group: how to total it (default count)." },
                    sort_by: { type: "string", description: "rows: the column to sort by." }, descending: { type: "boolean", description: "rows: sort largest first (default false)." }, query: { type: "string", description: "search: the text to find." },
                    offset: { type: "integer", description: "rows: how many rows to skip, for the next page (default 0)." }, limit: { type: "integer", description: "How many rows (default 50)." }
                }, required: ["table"] }, run: tableRead
            },
            table_write: {
                description: "Create or edit a CSV, TSV or JSON data table in the notes vault. mode create or replace writes columns and rows; append_rows adds rows; update_rows sets values on the rows matching where; delete_rows removes them; add_column adds a column. Rows are lists in column order or objects by column name. The file keeps its format. CoDev shows the user the change and saves only if they approve. Use it when the user asks to make or change a table in their vault; read it with table_read first. To give them an Excel file instead use create_spreadsheet.",
                inputSchema: { type: "object", properties: {
                    table: { type: "string", description: "The table's path, like Data/players.csv (.csv is added if there's no .csv, .tsv or .json)." },
                    mode: { type: "string", enum: ["create", "replace", "append_rows", "update_rows", "delete_rows", "add_column"], description: "Default create." },
                    columns: { type: "array", items: { type: "string" }, description: "create/replace: the column names." },
                    rows: { type: "array", description: "create/replace/append_rows: the rows, as lists or objects.", items: {} },
                    where: filterSchema,
                    set: { type: "object", description: "update_rows: column -> new value." },
                    column: { type: "string", description: "add_column: the new column's name." },
                    value: { type: "string", description: "add_column: the value for every existing row (default empty)." }
                }, required: ["table"] }, run: tableWrite
            }
        };

        async function buildTools() {
            const names = ["notes_status"];
            let ready = false;
            try { const s = await getStore(); ready = Boolean(s && !s.error); } catch (err) { ready = false; }
            if (ready) names.push("notes_search", "notes_read", "table_read");
            if (ready && canEdit()) names.push("notes_write", "table_write");
            names.sort((x, y) => NOTES_TOOL_NAMES.indexOf(x) - NOTES_TOOL_NAMES.indexOf(y));
            return names.map(name => ({ name, description: TOOLS[name].description, inputSchema: TOOLS[name].inputSchema, run: (args, ctx) => TOOLS[name].run(args || {}, ctx) }));
        }

        function describe(name, args) {
            args = args || {};
            switch (name) {
                case "notes_status": return "📝 Checking the notes vault";
                case "notes_search": return `📝 Searching ${args.kind === "tables" ? "tables" : "notes"}${args.query ? `: ${args.query}` : args.tag ? `: #${String(args.tag).replace(/^#/, "")}` : ""}`;
                case "notes_read": return `📝 Reading the note ${args.note || ""}`.trim();
                case "notes_write": return `✏️ ${{ create: "Creating", append: "Adding to", edit: "Editing", replace: "Rewriting" }[args.mode] || "Creating"} the note ${args.note || ""} (asks you first)`;
                case "table_read": return `📊 Reading the table ${args.table || ""}`.trim();
                case "table_write": return `📊 Saving the table ${args.table || ""} (asks you first)`;
                default: return null;
            }
        }

        return { buildTools, describe, TOOLS, forget: () => cache.clear() };
    }

    // ---- Settings panel ------------------------------------------------------

    // Fills Settings > Notes & tables. hasProject: whether a project folder can be used here.
    function mountSettings(el, { storage, tools, hasProject, onChange = () => {} }) {
        el.innerHTML = `
            <summary>📝 Notes &amp; tables (Obsidian, CSV, JSON)</summary>
            <div style="font-size: 0.8rem; color: var(--text-muted);">Agents read and edit an Obsidian vault of Markdown notes and CSV/JSON tables, in place of Google Docs and Sheets. Open the same folder in Obsidian (free at obsidian.md). <a href="${GUIDE_URL}" target="_blank" rel="noopener noreferrer" style="color: var(--accent);">How it works</a></div>
            <div class="form-group">
                <label>Where the vault is</label>
                <select data-n="location">
                    <option value="mega">A folder in my MEGA cloud drive (works on the phone too)</option>
                    ${hasProject ? `<option value="project">A folder inside the connected project folder</option>` : ""}
                </select>
                <label>Folder</label>
                <input type="text" data-n="folder" autocomplete="off" style="font-family: monospace;">
            </div>
            <label class="checkbox-group"><input type="checkbox" data-n="allowEdit"> Let agents create and edit notes and tables (CoDev asks me every time)</label>
            <div data-n="status" style="font-size: 0.85rem; white-space: pre-line;"></div>`;
        const $ = name => el.querySelector(`[data-n="${name}"]`);
        const location = () => (storage.getItem(STORE.location) === "project" && hasProject ? "project" : "mega");
        $("location").value = location();
        $("folder").value = storage.getItem(STORE.folder) || DEFAULT_FOLDER[location()];
        $("folder").placeholder = DEFAULT_FOLDER[location()];
        $("allowEdit").checked = storage.getItem(STORE.allowEdit) === "1";
        const changed = () => { tools.forget(); onChange(); refresh(); };
        $("location").addEventListener("change", () => {
            storage.setItem(STORE.location, $("location").value);
            $("folder").value = DEFAULT_FOLDER[$("location").value];
            $("folder").placeholder = DEFAULT_FOLDER[$("location").value];
            storage.setItem(STORE.folder, $("folder").value);
            changed();
        });
        $("folder").addEventListener("change", () => { storage.setItem(STORE.folder, $("folder").value.trim()); changed(); });
        $("allowEdit").addEventListener("change", () => { storage.setItem(STORE.allowEdit, $("allowEdit").checked ? "1" : "0"); changed(); });
        async function refresh() {
            $("status").textContent = "…";
            try { $("status").textContent = await tools.TOOLS.notes_status.run(); } catch (err) { $("status").textContent = `⚠️ ${err.message}`; }
        }
        el.addEventListener("toggle", () => { if (el.open) refresh(); });
        return { refresh };
    }

    // The vault settings from the page's storage.
    function settingsFrom(storage, hasProject) {
        const location = storage.getItem(STORE.location) === "project" && hasProject ? "project" : "mega";
        return { location, folder: storage.getItem(STORE.folder) || DEFAULT_FOLDER[location], allowEdit: storage.getItem(STORE.allowEdit) === "1" };
    }

    return {
        STORE, GUIDE_URL, DEFAULT_FOLDER, NOTES_TOOL_NAMES,
        parseNote, parseTable, serializeTable, cleanPath,
        megaStore, projectStore, createNotesTables, mountSettings, settingsFrom
    };
});
