// Native files for agents: real Excel workbooks with working formulas, PowerPoint
// decks, Word documents, CSV files and web apps, built on the device. No server, no
// library and no upload: each format is a zip of XML files written here, so the
// file opens in Excel, PowerPoint, Word, Google Sheets/Slides/Docs, LibreOffice and
// Numbers, and on the phone's share sheet.
//
//   CodevFiles.buildXlsx(spec)         -> { bytes, checks }  sheets, formulas, styles
//   CodevFiles.buildPptx(spec)         -> { bytes }          16:9 slides
//   CodevFiles.buildDocx(spec)         -> { bytes }          from Markdown
//   CodevFiles.buildCsv(columns, rows) -> string
//   CodevFiles.buildWebApp(spec)       -> { bytes, preview, problems }
//   CodevFiles.createDatasetStore()    tables agents collected (scrapes, wide research)
//   CodevFiles.buildFileTools(deps)    create_spreadsheet, create_slides, create_document,
//                                      create_csv, create_web_app, list_datasets
//
// Formulas are written as formulas, and the workbook asks Excel to recalculate on
// open. CoDev also works out the common ones itself (arithmetic, SUM, AVERAGE, MIN,
// MAX, COUNT, ROUND, IF...) and stores the results, so previews that don't
// calculate (phones, mail apps) still show numbers, and the agent sees each formula's
// result and catches a wrong range or a #DIV/0! before the user opens the file.
//
// The same file runs in the page and in Node (tests), like code-intel.js.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevFiles = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const enc = new TextEncoder();
    const MIME = {
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        csv: "text/csv",
        zip: "application/zip",
        html: "text/html"
    };
    const MAX_ROWS = 100000;
    const MAX_SLIDES = 80;

    // ---------- Zip (stored, no compression: every Office app and unzip reads it) ----------

    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c >>> 0;
        }
        return t;
    })();
    function crc32(bytes) {
        let c = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    }

    // files: [[name, string | Uint8Array]] in order. Returns the zip's bytes.
    function zip(files, date = new Date()) {
        const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
        const day = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
        const locals = [];
        const centrals = [];
        let offset = 0;
        for (const [name, content] of files) {
            const nameBytes = enc.encode(name);
            const data = typeof content === "string" ? enc.encode(content) : content;
            const crc = crc32(data);
            const local = new Uint8Array(30 + nameBytes.length);
            const lv = new DataView(local.buffer);
            lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
            lv.setUint16(10, time, true); lv.setUint16(12, day, true); lv.setUint32(14, crc, true);
            lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, 0, true);
            local.set(nameBytes, 30);
            const central = new Uint8Array(46 + nameBytes.length);
            const cv = new DataView(central.buffer);
            cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
            cv.setUint16(12, time, true); cv.setUint16(14, day, true); cv.setUint32(16, crc, true);
            cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, nameBytes.length, true);
            cv.setUint32(42, offset, true);
            central.set(nameBytes, 46);
            locals.push(local, data);
            centrals.push(central);
            offset += local.length + data.length;
        }
        const centralSize = centrals.reduce((n, c) => n + c.length, 0);
        const end = new Uint8Array(22);
        const ev = new DataView(end.buffer);
        ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
        ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
        const out = new Uint8Array(offset + centralSize + 22);
        let at = 0;
        for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length; }
        return out;
    }

    // Reads a stored zip back (tests, and the web app preview). Stored entries only.
    function unzipStored(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const files = {};
        let at = 0;
        while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
            const size = view.getUint32(at + 18, true);
            const nameLen = view.getUint16(at + 26, true);
            const extra = view.getUint16(at + 28, true);
            const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLen));
            const start = at + 30 + nameLen + extra;
            files[name] = bytes.subarray(start, start + size);
            at = start + size;
        }
        return files;
    }

    const xml = value => String(value == null ? "" : value)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

    function safeFileName(name, ext) {
        let base = String(name || "").trim().replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").slice(0, 80).trim();
        if (!base) base = ext === "zip" ? "web-app" : ext === "pptx" ? "slides" : ext === "docx" ? "document" : "data";
        return `${base}.${ext}`;
    }

    // ---------- Cells and references ----------

    function colName(index) {   // 0 -> A
        let s = "";
        for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
        return s;
    }
    function colIndex(letters) {
        let n = 0;
        for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
        return n - 1;
    }
    function parseRef(ref) {
        const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref);
        return m ? { col: colIndex(m[1]), row: Number(m[2]) - 1 } : null;
    }

    // Excel's serial day number for a date (1900 system).
    function dateSerial(value) {
        const d = value instanceof Date ? value : new Date(String(value).length <= 10 ? `${value}T00:00:00Z` : value);
        if (isNaN(d)) return null;
        const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
        return utc / 86400000 + 25569;
    }

    // Styles: index into cellXfs in styles.xml below.
    const STYLE = { default: 0, header: 1, currency: 2, percent: 3, date: 4, int: 5, decimal: 6, bold: 7, wrap: 8, total: 9, totalCurrency: 10, link: 11 };
    const FORMATS = { currency: "currency", money: "currency", usd: "currency", "$": "currency", percent: "percent", pct: "percent", "%": "percent",
        date: "date", int: "int", integer: "int", number: "decimal", decimal: "decimal", text: "default", bold: "bold", wrap: "wrap", link: "link" };
    const formatOf = name => FORMATS[String(name || "").toLowerCase()] || null;

    // A typed cell from whatever the agent sent.
    function normalizeCell(raw, columnFormat) {
        let cell = raw;
        if (cell && typeof cell === "object" && !(cell instanceof Date) && !Array.isArray(cell)) {
            cell = { ...cell };
            if (cell.formula != null && cell.f == null) cell.f = cell.formula;
            if (cell.value !== undefined && cell.v === undefined) cell.v = cell.value;
            if (cell.format && !cell.style) cell.style = cell.format;
        } else {
            cell = { v: cell };
        }
        if (typeof cell.f === "string") cell.f = cell.f.replace(/^=/, "").trim();
        if (cell.f == null && typeof cell.v === "string" && /^=[^=]/.test(cell.v.trim())) cell.f = cell.v.trim().slice(1);
        const style = formatOf(cell.style) || columnFormat || null;
        if (cell.f == null && typeof cell.v === "string") {
            const s = cell.v.trim();
            // Numbers that came in as text ("$1,250.50", "12%", "3,400") become numbers.
            if (/^-?\$\s?[\d,]+(\.\d+)?$/.test(s)) { cell.v = Number(s.replace(/[$,\s]/g, "")); return { ...cell, style: style || "currency" }; }
            if (/^-?[\d,]*\.?\d+%$/.test(s) && !/,,/.test(s)) { cell.v = Number(s.replace(/[%,]/g, "")) / 100; return { ...cell, style: style || "percent" }; }
            if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) || /^-?\d+(\.\d+)?$/.test(s) && !/^0\d/.test(s) && s.length < 16) { cell.v = Number(s.replace(/,/g, "")); return { ...cell, style }; }
            if (style === "date" && dateSerial(s) != null) { cell.v = dateSerial(s); return { ...cell, style }; }
            if (/^https?:\/\/\S+$/.test(s) && !style) return { ...cell, style: "link" };
        }
        if (cell.v instanceof Date) { cell.v = dateSerial(cell.v); return { ...cell, style: style || "date" }; }
        return { ...cell, style };
    }

    // ---------- A small formula engine, for cached values and the agent's check ----------

    class FormulaError extends Error {}
    const ERR = { div0: "#DIV/0!", ref: "#REF!", value: "#VALUE!", name: "#NAME?", na: "#N/A" };

    function tokenize(src) {
        const tokens = [];
        let i = 0;
        while (i < src.length) {
            const ch = src[i];
            if (/\s/.test(ch)) { i++; continue; }
            const rest = src.slice(i);
            let m;
            if ((m = /^'((?:[^']|'')+)'!(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)/.exec(rest)) ||
                (m = /^([A-Za-z_][\w.]*)!(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)/.exec(rest))) {
                tokens.push({ t: "ref", sheet: m[1].replace(/''/g, "'"), ref: m[2] }); i += m[0].length; continue;
            }
            if ((m = /^\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?(?![\w(])/.exec(rest))) { tokens.push({ t: "ref", ref: m[0] }); i += m[0].length; continue; }
            if ((m = /^\d+(\.\d+)?([eE][+-]?\d+)?%?/.exec(rest))) { tokens.push({ t: "num", v: m[0].endsWith("%") ? Number(m[0].slice(0, -1)) / 100 : Number(m[0]) }); i += m[0].length; continue; }
            if ((m = /^"((?:[^"]|"")*)"/.exec(rest))) { tokens.push({ t: "str", v: m[1].replace(/""/g, '"') }); i += m[0].length; continue; }
            if ((m = /^(TRUE|FALSE)(?![\w(])/i.exec(rest))) { tokens.push({ t: "bool", v: m[1].toUpperCase() === "TRUE" }); i += m[0].length; continue; }
            if ((m = /^[A-Za-z_][\w.]*(?=\s*\()/.exec(rest))) { tokens.push({ t: "fn", v: m[0].toUpperCase() }); i += m[0].length; continue; }
            if ((m = /^(<=|>=|<>|[-+*/^&=<>(),;:])/.exec(rest))) { tokens.push({ t: "op", v: m[0] === ";" ? "," : m[0] }); i += m[0].length; continue; }
            throw new FormulaError(ERR.name);
        }
        return tokens;
    }

    function evaluateFormula(formula, sheetName, lookup) {
        const tokens = tokenize(formula);
        let p = 0;
        const peek = () => tokens[p];
        const take = v => { const t = tokens[p]; if (!t || (v && t.v !== v)) throw new FormulaError(ERR.value); p++; return t; };
        const num = v => {
            if (Array.isArray(v)) v = v.length === 1 ? v[0] : (() => { throw new FormulaError(ERR.value); })();
            if (typeof v === "string" && v.startsWith("#")) throw new FormulaError(v);
            if (v === null || v === undefined || v === "") return 0;
            if (typeof v === "boolean") return v ? 1 : 0;
            const n = Number(v);
            if (isNaN(n)) throw new FormulaError(ERR.value);
            return n;
        };
        const refValues = tok => {
            const [a, b] = tok.ref.split(":");
            const s = parseRef(a), e = b ? parseRef(b) : s;
            if (!s || !e) throw new FormulaError(ERR.ref);
            const out = [];
            for (let r = Math.min(s.row, e.row); r <= Math.max(s.row, e.row); r++)
                for (let c = Math.min(s.col, e.col); c <= Math.max(s.col, e.col); c++) out.push(lookup(tok.sheet || sheetName, r, c));
            return b ? out : out[0];
        };
        const flat = args => args.flat(Infinity);
        const numbers = args => flat(args).filter(v => typeof v === "number" || (typeof v === "string" && v.startsWith("#") && (() => { throw new FormulaError(v); })()));
        const FN = {
            SUM: a => numbers(a).reduce((s, v) => s + v, 0),
            AVERAGE: a => { const n = numbers(a); if (!n.length) throw new FormulaError(ERR.div0); return n.reduce((s, v) => s + v, 0) / n.length; },
            MIN: a => { const n = numbers(a); return n.length ? Math.min(...n) : 0; },
            MAX: a => { const n = numbers(a); return n.length ? Math.max(...n) : 0; },
            COUNT: a => numbers(a).length,
            COUNTA: a => flat(a).filter(v => v !== null && v !== undefined && v !== "").length,
            ROUND: a => { const f = 10 ** num(a[1] ?? 0); return Math.round(num(a[0]) * f) / f; },
            ABS: a => Math.abs(num(a[0])),
            IF: a => (num(a[0]) ? (a[1] ?? true) : (a[2] ?? false)),
            IFERROR: a => a[0],
            AND: a => flat(a).every(v => num(v)),
            OR: a => flat(a).some(v => num(v)),
            PRODUCT: a => numbers(a).reduce((s, v) => s * v, 1),
            MEDIAN: a => { const n = numbers(a).sort((x, y) => x - y); if (!n.length) throw new FormulaError(ERR.num); const m = n.length >> 1; return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2; },
            SUMPRODUCT: a => { const [x, y] = a.map(v => [].concat(v)); return x.reduce((s, v, i) => s + num(v) * num(y ? y[i] : 1), 0); },
            CONCAT: a => flat(a).map(v => v ?? "").join(""),
            CONCATENATE: a => flat(a).map(v => v ?? "").join(""),
            LEN: a => String(a[0] ?? "").length,
            UPPER: a => String(a[0] ?? "").toUpperCase(),
            LOWER: a => String(a[0] ?? "").toLowerCase()
        };
        function primary() {
            const t = peek();
            if (!t) throw new FormulaError(ERR.value);
            if (t.t === "op" && t.v === "-") { p++; return -num(power()); }
            if (t.t === "op" && t.v === "+") { p++; return num(power()); }
            if (t.t === "op" && t.v === "(") { p++; const v = comparison(); take(")"); return v; }
            if (t.t === "num" || t.t === "str" || t.t === "bool") { p++; return t.v; }
            if (t.t === "ref") { p++; return refValues(t); }
            if (t.t === "fn") {
                p++; take("(");
                const args = [];
                if (!(peek() && peek().v === ")")) {
                    for (;;) {
                        // IFERROR and IF evaluate lazily enough for the common cases.
                        if (t.v === "IFERROR" && !args.length) {
                            const save = p;
                            try { args.push(comparison()); } catch (err) {
                                if (!(err instanceof FormulaError)) throw err;
                                p = save; skipArg(); args.push(undefined); take(","); args.push(comparison()); break;
                            }
                        } else args.push(comparison());
                        if (peek() && peek().v === ",") { p++; continue; }
                        break;
                    }
                }
                take(")");
                if (t.v === "IFERROR") return args.length > 1 && args[0] === undefined ? args[1] : args[0];
                const fn = FN[t.v];
                if (!fn) throw new FormulaError(ERR.name);
                return fn(args);
            }
            throw new FormulaError(ERR.value);
        }
        function skipArg() {
            let depth = 0;
            while (p < tokens.length) {
                const t = tokens[p];
                if (t.v === "(") depth++;
                if (t.v === ")") { if (!depth) return; depth--; }
                if (t.v === "," && !depth) return;
                p++;
            }
        }
        function power() { let v = primary(); while (peek() && peek().v === "^") { p++; v = num(v) ** num(primary()); } return v; }
        function product() {
            let v = power();
            while (peek() && (peek().v === "*" || peek().v === "/")) {
                const op = tokens[p++].v; const r = num(power());
                if (op === "/" && r === 0) throw new FormulaError(ERR.div0);
                v = op === "*" ? num(v) * r : num(v) / r;
            }
            return v;
        }
        function sum() { let v = product(); while (peek() && (peek().v === "+" || peek().v === "-")) { const op = tokens[p++].v; const r = num(product()); v = op === "+" ? num(v) + r : num(v) - r; } return v; }
        function concat() { let v = sum(); while (peek() && peek().v === "&") { p++; v = `${v ?? ""}${sum() ?? ""}`; } return v; }
        function comparison() {
            let v = concat();
            while (peek() && /^(=|<>|<|>|<=|>=)$/.test(peek().v)) {
                const op = tokens[p++].v; const r = concat();
                const [a, b] = typeof v === "string" || typeof r === "string" ? [String(v ?? "").toLowerCase(), String(r ?? "").toLowerCase()] : [num(v), num(r)];
                v = op === "=" ? a === b : op === "<>" ? a !== b : op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b;
            }
            return v;
        }
        const value = comparison();
        if (p < tokens.length) throw new FormulaError(ERR.value);
        if (Array.isArray(value)) throw new FormulaError(ERR.value);
        return value;
    }

    // ---------- XLSX ----------

    function sheetNameOf(name, used) {
        let base = String(name || "").replace(/[\[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 31) || `Sheet${used.size + 1}`;
        let candidate = base;
        for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base.slice(0, 28)} (${n})`;
        used.add(candidate.toLowerCase());
        return candidate;
    }

    // A sheet spec -> a grid of normalized cells, with what the header and widths need.
    function layoutSheet(sheet, getDataset) {
        let columns = Array.isArray(sheet.columns) ? sheet.columns.map(c => (typeof c === "string" ? { header: c } : { ...c, header: c.header ?? c.name ?? "" })) : null;
        let rows = Array.isArray(sheet.rows) ? sheet.rows : [];
        if (sheet.dataset) {
            const ds = getDataset ? getDataset(sheet.dataset) : null;
            if (!ds) throw new Error(`there is no dataset "${sheet.dataset}"; list_datasets shows what was collected`);
            if (!columns) columns = ds.columns.map(c => ({ header: c }));
            rows = ds.rows.concat(rows);
        }
        // Rows given as objects use the column headers (or their own keys) for order.
        if (rows.some(r => r && typeof r === "object" && !Array.isArray(r))) {
            if (!columns) {
                const keys = [];
                for (const r of rows) if (r && typeof r === "object" && !Array.isArray(r)) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
                columns = keys.map(k => ({ header: k }));
            }
            rows = rows.map(r => (Array.isArray(r) ? r : columns.map(c => (r ? r[c.key ?? c.header] : null))));
        }
        if (rows.length > MAX_ROWS) throw new Error(`a sheet can have at most ${MAX_ROWS} rows here`);
        const formats = (columns || []).map(c => formatOf(c.format));
        const grid = [];
        if (columns && sheet.header !== false) grid.push(columns.map(c => ({ v: String(c.header ?? ""), style: "header" })));
        const firstBody = grid.length;
        for (const row of rows) grid.push((Array.isArray(row) ? row : [row]).map((cell, c) => normalizeCell(cell, formats[c])));
        const width = Math.max(columns ? columns.length : 0, ...grid.map(r => r.length), 1);
        // A totals row: SUM (or what's asked) under every numeric column.
        if (sheet.total_row && grid.length > firstBody) {
            const kind = typeof sheet.total_row === "string" ? sheet.total_row.toUpperCase() : "SUM";
            const fn = /^(SUM|AVERAGE|MIN|MAX|COUNT)$/.test(kind) ? kind : "SUM";
            const total = [];
            for (let c = 0; c < width; c++) {
                const numeric = grid.slice(firstBody).some(r => r[c] && (typeof r[c].v === "number" || r[c].f));
                const label = c === 0 && !numeric;
                const isMoney = formats[c] === "currency" || grid.slice(firstBody).some(r => r[c] && r[c].style === "currency");
                total.push(label ? { v: fn === "SUM" ? "Total" : fn.charAt(0) + fn.slice(1).toLowerCase(), style: "total" }
                    : numeric ? { f: `${fn}(${colName(c)}${firstBody + 1}:${colName(c)}${grid.length})`, style: isMoney ? "totalCurrency" : "total" } : { v: null, style: "total" });
            }
            grid.push(total);
        }
        // Column widths: given, else from the longest text (capped).
        const widths = [];
        for (let c = 0; c < width; c++) {
            const given = columns && columns[c] && Number(columns[c].width);
            if (given) { widths.push(Math.min(120, Math.max(4, given))); continue; }
            let longest = 6;
            for (const r of grid.slice(0, 500)) {
                const cell = r[c];
                if (!cell || cell.v == null) continue;
                const shown = cell.style === "currency" ? 14 : cell.style === "date" ? 12 : typeof cell.v === "number" ? String(Math.round(cell.v * 100) / 100).length + 3 : String(cell.v).length;
                longest = Math.max(longest, shown + (cell.style === "header" ? 3 : 1));
            }
            widths.push(Math.min(60, longest));
        }
        return { grid, width, widths, hasHeader: Boolean(columns && sheet.header !== false) };
    }

    function buildXlsx(spec = {}, options = {}) {
        const specs = Array.isArray(spec.sheets) && spec.sheets.length ? spec.sheets : [{ name: "Sheet1", columns: spec.columns, rows: spec.rows, dataset: spec.dataset }];
        const used = new Set();
        const sheets = specs.map(s => ({ spec: s, name: sheetNameOf(s.name, used), ...layoutSheet(s, options.getDataset) }));
        // Work out formulas (in order, across sheets, a few passes for forward references).
        const byName = new Map(sheets.map(s => [s.name.toLowerCase(), s]));
        const cache = new Map();
        const lookup = (sheetName, r, c) => {
            const sheet = byName.get(String(sheetName).toLowerCase());
            if (!sheet) throw new FormulaError(ERR.ref);
            const cell = sheet.grid[r] && sheet.grid[r][c];
            if (!cell) return null;
            if (cell.f == null) return cell.v ?? null;
            const key = `${sheet.name}!${r}:${c}`;
            if (cache.has(key)) { const v = cache.get(key); if (v === cache) throw new FormulaError("#CIRCULAR"); return v; }
            cache.set(key, cache);
            let v;
            try { v = evaluateFormula(cell.f, sheet.name, lookup); } catch (err) { v = err instanceof FormulaError ? err.message : ERR.value; }
            cache.set(key, v);
            return v;
        };
        const checks = [];
        for (const sheet of sheets) {
            sheet.grid.forEach((row, r) => row.forEach((cell, c) => {
                if (!cell || cell.f == null) return;
                const v = lookup(sheet.name, r, c);
                cell.cached = v;
                checks.push({ sheet: sheet.name, cell: `${colName(c)}${r + 1}`, formula: `=${cell.f}`, value: v });
            }));
        }
        const files = [];
        files.push(["[Content_Types].xml", XML_HEAD + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`]);
        files.push(["_rels/.rels", XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`]);
        files.push(...docProps(spec.title || "CoDev workbook", "Microsoft Excel"));
        files.push(["xl/workbook.xml", XML_HEAD + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="16000"/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${definedNames(sheets)}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`]);
        files.push(["xl/_rels/workbook.xml.rels", XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`]);
        files.push(["xl/styles.xml", XLSX_STYLES]);
        sheets.forEach((s, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s, i === 0)]));
        return { bytes: zip(files), checks, sheets: sheets.map(s => ({ name: s.name, rows: s.grid.length, columns: s.width })) };
    }

    // The header row's autofilter, named the way Excel does.
    function definedNames(sheets) {
        const names = sheets.map((s, i) => (s.hasHeader && s.grid.length > 1 && s.spec.filter !== false
            ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xml(s.name.replace(/'/g, "''"))}'!$A$1:$${colName(s.width - 1)}$${s.grid.length - (s.spec.total_row ? 1 : 0)}</definedName>` : "")).join("");
        return names ? `<definedNames>${names}</definedNames>` : "";
    }

    function sheetXml(sheet, selected) {
        const { grid, width, widths, hasHeader, spec } = sheet;
        const freeze = spec.freeze !== false && hasHeader && grid.length > 1;
        const last = `${colName(width - 1)}${Math.max(1, grid.length)}`;
        const rowsXml = grid.map((row, r) => {
            const cells = row.map((cell, c) => {
                if (!cell) return "";
                const ref = `${colName(c)}${r + 1}`;
                const s = STYLE[cell.style] || 0;
                const sAttr = s ? ` s="${s}"` : "";
                if (cell.f != null) {
                    const v = cell.cached;
                    const f = `<f>${xml(cell.f)}</f>`;
                    if (typeof v === "number" && isFinite(v)) return `<c r="${ref}"${sAttr}>${f}<v>${v}</v></c>`;
                    if (typeof v === "boolean") return `<c r="${ref}"${sAttr} t="b">${f}<v>${v ? 1 : 0}</v></c>`;
                    if (typeof v === "string" && v.startsWith("#")) return `<c r="${ref}"${sAttr} t="e">${f}<v>${xml(v === "#CIRCULAR" ? "#REF!" : v)}</v></c>`;
                    if (typeof v === "string") return `<c r="${ref}"${sAttr} t="str">${f}<v>${xml(v)}</v></c>`;
                    return `<c r="${ref}"${sAttr}>${f}</c>`;
                }
                const v = cell.v;
                if (v === null || v === undefined || v === "") return s ? `<c r="${ref}"${sAttr}/>` : "";
                if (typeof v === "number" && isFinite(v)) return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
                if (typeof v === "boolean") return `<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`;
                const text = String(v).slice(0, 32767);
                return `<c r="${ref}"${sAttr} t="inlineStr"><is><t${/^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : ""}>${xml(text)}</t></is></c>`;
            }).join("");
            return `<row r="${r + 1}"${r === 0 && hasHeader ? ' ht="20" customHeight="1"' : ""}>${cells}</row>`;
        }).join("");
        const view = freeze
            ? `<sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ""}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView>`
            : `<sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ""}/>`;
        const cols = `<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`;
        const filter = hasHeader && grid.length > 1 && spec.filter !== false ? `<autoFilter ref="A1:${colName(width - 1)}${grid.length - (spec.total_row ? 1 : 0)}"/>` : "";
        return XML_HEAD + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${last}"/><sheetViews>${view}</sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${rowsXml}</sheetData>${filter}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
    }

    const XLSX_STYLES = XML_HEAD + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/></numFmts><fonts count="4"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color auto="1"/></top><bottom style="double"><color auto="1"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="12"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="4" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;

    function docProps(title, app) {
        const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        return [
            ["docProps/core.xml", XML_HEAD + `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>CoDev Studio</dc:creator><cp:lastModifiedBy>CoDev Studio</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`],
            ["docProps/app.xml", XML_HEAD + `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>${xml(app)}</Application></Properties>`]
        ];
    }

    // ---------- PPTX ----------

    const EMU = 914400;          // per inch
    const SLIDE_W = 12192000;    // 13.333 in (16:9)
    const SLIDE_H = 6858000;     // 7.5 in
    const THEMES = {
        blue: { dark: "1F2937", accent: "2563EB", light: "F8FAFC", muted: "64748B", bg: "FFFFFF" },
        green: { dark: "14261C", accent: "16A34A", light: "F0FDF4", muted: "52675A", bg: "FFFFFF" },
        purple: { dark: "2E1065", accent: "7C3AED", light: "F5F3FF", muted: "6B5B8A", bg: "FFFFFF" },
        orange: { dark: "3B1F0B", accent: "EA580C", light: "FFF7ED", muted: "7C5E48", bg: "FFFFFF" },
        dark: { dark: "F8FAFC", accent: "38BDF8", light: "1E293B", muted: "94A3B8", bg: "0F172A" }
    };

    function textRuns(text, { size, bold, color }) {
        // **bold** inside a line.
        const parts = String(text).split(/(\*\*[^*]+\*\*)/).filter(s => s !== "");
        return parts.map(part => {
            const b = bold || /^\*\*[^*]+\*\*$/.test(part);
            const t = part.replace(/^\*\*([^*]+)\*\*$/, "$1");
            return `<a:r><a:rPr lang="en-US" sz="${size}"${b ? ' b="1"' : ""} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${xml(t)}</a:t></a:r>`;
        }).join("") || `<a:endParaRPr lang="en-US" sz="${size}"/>`;
    }

    function textBox(id, name, x, y, w, h, paragraphs, { anchor = "t" } = {}) {
        return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xml(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="91440" tIns="45720" rIns="91440" bIns="45720" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
    }

    function rect(id, x, y, w, h, color) {
        return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Bar ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
    }

    function bulletParas(bullets, theme, size) {
        return bullets.map(b => {
            const item = typeof b === "string" ? { text: b.replace(/^\s*[-*•]\s+/, ""), level: (/^(\s*)/.exec(b)[1].length >> 1) } : { text: String(b.text || ""), level: Number(b.level) || 0 };
            const level = Math.max(0, Math.min(3, item.level));
            const s = Math.max(1200, size - level * 300);
            return `<a:p><a:pPr marL="${342900 + level * 342900}" lvl="${level}" indent="-342900"><a:spcBef><a:spcPts val="${Math.round(s / 20)}0"/></a:spcBef><a:buClr><a:srgbClr val="${theme.accent}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="${level ? "–" : "•"}"/></a:pPr>${textRuns(item.text, { size: s, color: level ? theme.muted : theme.dark })}</a:p>`;
        }).join("");
    }

    function tableFrame(id, x, y, w, table, theme) {
        const header = (table.columns || table.header || []).map(String);
        const rows = (table.rows || []).slice(0, 14).map(r => (Array.isArray(r) ? r : header.map(h => r[h])).map(v => (v == null ? "" : String(v))));
        const cols = Math.max(header.length, ...rows.map(r => r.length), 1);
        const colW = Math.floor(w / cols);
        const rowH = 370840;
        const size = rows.length > 9 || cols > 6 ? 1100 : 1400;
        const cell = (text, head, shade) => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${textRuns(text, { size, bold: head, color: head ? "FFFFFF" : theme.dark === "F8FAFC" ? "F8FAFC" : "1F2937" })}</a:p></a:txBody><a:tcPr marL="91440" marR="91440" marT="45720" marB="45720" anchor="ctr"><a:solidFill><a:srgbClr val="${head ? theme.accent : shade ? theme.light : theme.bg}"/></a:solidFill></a:tcPr></a:tc>`;
        const allRows = (header.length ? [header] : []).concat(rows);
        const trs = allRows.map((r, i) => `<a:tr h="${rowH}">${Array.from({ length: cols }, (_, c) => cell(r[c] ?? "", header.length && i === 0, i % 2 === 0)).join("")}</a:tr>`).join("");
        return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${colW * cols}" cy="${rowH * allRows.length}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${Array.from({ length: cols }, () => `<a:gridCol w="${colW}"/>`).join("")}</a:tblGrid>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    }

    function slideXml(slide, index, theme) {
        const shapes = [];
        let id = 2;
        const margin = 0.6 * EMU;
        const layout = slide.layout || (index === 0 && !slide.bullets && !slide.table ? "title" : slide.table ? "table" : slide.stats ? "stats" : "bullets");
        const titleSize = layout === "title" ? 4400 : 3000;
        if (layout === "title" || layout === "section") {
            shapes.push(rect(id++, 0, SLIDE_H * 0.62, SLIDE_W, 0.08 * EMU, theme.accent));
            shapes.push(textBox(id++, "Title", margin, SLIDE_H * 0.28, SLIDE_W - 2 * margin, 1.5 * EMU, `<a:p>${textRuns(slide.title || "", { size: layout === "title" ? 4400 : 3600, bold: true, color: theme.dark })}</a:p>`, { anchor: "b" }));
            if (slide.subtitle) shapes.push(textBox(id++, "Subtitle", margin, SLIDE_H * 0.66, SLIDE_W - 2 * margin, 0.9 * EMU, `<a:p>${textRuns(slide.subtitle, { size: 2000, color: theme.muted })}</a:p>`));
        } else {
            shapes.push(rect(id++, 0, 0, 0.12 * EMU, SLIDE_H, theme.accent));
            shapes.push(textBox(id++, "Title", margin, 0.35 * EMU, SLIDE_W - 2 * margin, 0.95 * EMU, `<a:p>${textRuns(slide.title || "", { size: titleSize, bold: true, color: theme.dark })}</a:p>`, { anchor: "b" }));
            const top = 1.45 * EMU;
            const bodyH = SLIDE_H - top - 0.5 * EMU;
            const bullets = Array.isArray(slide.bullets) ? slide.bullets.slice(0, 12) : [];
            const words = bullets.reduce((n, b) => n + String(typeof b === "string" ? b : b.text || "").length, 0);
            const size = bullets.length > 8 || words > 650 ? 1600 : bullets.length > 5 || words > 400 ? 1800 : 2200;
            if (layout === "stats" && Array.isArray(slide.stats)) {
                const stats = slide.stats.slice(0, 4);
                const w = (SLIDE_W - 2 * margin) / stats.length;
                stats.forEach((s, i) => {
                    shapes.push(textBox(id++, `Stat ${i + 1}`, margin + i * w, top + 0.4 * EMU, w - 0.2 * EMU, 1.4 * EMU, `<a:p><a:pPr algn="ctr"/>${textRuns(String(s.value ?? ""), { size: 4800, bold: true, color: theme.accent })}</a:p>`, { anchor: "b" }));
                    shapes.push(textBox(id++, `Stat label ${i + 1}`, margin + i * w, top + 1.9 * EMU, w - 0.2 * EMU, 1.2 * EMU, `<a:p><a:pPr algn="ctr"/>${textRuns(String(s.label ?? ""), { size: 1800, color: theme.muted })}</a:p>`));
                });
                if (bullets.length) shapes.push(textBox(id++, "Notes", margin, top + 3.3 * EMU, SLIDE_W - 2 * margin, bodyH - 3.3 * EMU, bulletParas(bullets, theme, 1600)));
            } else if (slide.table) {
                const hasText = bullets.length > 0;
                const tableW = hasText ? (SLIDE_W - 2 * margin) * 0.62 : SLIDE_W - 2 * margin;
                shapes.push(tableFrame(id++, margin, top, tableW, slide.table, theme));
                if (hasText) shapes.push(textBox(id++, "Text", margin + tableW + 0.3 * EMU, top, SLIDE_W - 2 * margin - tableW - 0.3 * EMU, bodyH, bulletParas(bullets, theme, 1600)));
            } else if (Array.isArray(slide.columns) && slide.columns.length) {
                const cols = slide.columns.slice(0, 3);
                const w = (SLIDE_W - 2 * margin) / cols.length;
                cols.forEach((col, i) => {
                    shapes.push(textBox(id++, `Heading ${i + 1}`, margin + i * w, top, w - 0.25 * EMU, 0.6 * EMU, `<a:p>${textRuns(col.heading || "", { size: 2000, bold: true, color: theme.accent })}</a:p>`));
                    shapes.push(textBox(id++, `Column ${i + 1}`, margin + i * w, top + 0.65 * EMU, w - 0.25 * EMU, bodyH - 0.65 * EMU, bulletParas(col.bullets || [], theme, 1600)));
                });
            } else {
                shapes.push(textBox(id++, "Body", margin, top, SLIDE_W - 2 * margin, bodyH, bullets.length ? bulletParas(bullets, theme, size) : `<a:p>${textRuns(slide.text || "", { size: 2000, color: theme.dark })}</a:p>`));
            }
        }
        const bg = `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${theme.bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`;
        return XML_HEAD + `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    }

    function notesXml(text) {
        return XML_HEAD + `<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${String(text).split("\n").map(line => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${xml(line)}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
    }

    const THEME_XML = XML_HEAD + `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="CoDev"><a:themeElements><a:clrScheme name="CoDev"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F1F5F9"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="16A34A"/></a:accent2><a:accent3><a:srgbClr val="EA580C"/></a:accent3><a:accent4><a:srgbClr val="7C3AED"/></a:accent4><a:accent5><a:srgbClr val="0891B2"/></a:accent5><a:accent6><a:srgbClr val="DB2777"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="CoDev"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="CoDev"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

    const EMPTY_TREE = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>`;
    const NS_P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
    const CLR_MAP = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';

    function buildPptx(spec = {}) {
        const theme = THEMES[String(spec.theme || "blue").toLowerCase()] || THEMES.blue;
        let slides = Array.isArray(spec.slides) ? spec.slides.filter(s => s && typeof s === "object").slice(0, MAX_SLIDES) : [];
        if (spec.title && !(slides[0] && slides[0].layout === "title")) slides = [{ layout: "title", title: spec.title, subtitle: spec.subtitle || "" }].concat(slides);
        if (!slides.length) throw new Error("slides needs at least one slide");
        const withNotes = slides.map((s, i) => (s.notes ? i : -1)).filter(i => i >= 0);
        const files = [];
        files.push(["[Content_Types].xml", XML_HEAD + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>${slides.map((s, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}${withNotes.length ? `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/><Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${withNotes.map(i => `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`).join("")}` : ""}<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`]);
        files.push(["_rels/.rels", XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`]);
        files.push(...docProps(spec.title || slides[0].title || "CoDev slides", "Microsoft Office PowerPoint"));
        const slideRid = i => `rId${i + 10}`;
        files.push(["ppt/presentation.xml", XML_HEAD + `<p:presentation ${NS_P} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${withNotes.length ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId6"/></p:notesMasterIdLst>' : ""}<p:sldIdLst>${slides.map((s, i) => `<p:sldId id="${256 + i}" r:id="${slideRid(i)}"/>`).join("")}</p:sldIdLst><p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>`]);
        files.push(["ppt/_rels/presentation.xml.rels", XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>${withNotes.length ? '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="notesMasters/notesMaster1.xml"/>' : ""}${slides.map((s, i) => `<Relationship Id="${slideRid(i)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("")}</Relationships>`]);
        files.push(["ppt/presProps.xml", XML_HEAD + `<p:presentationPr ${NS_P}/>`]);
        files.push(["ppt/viewProps.xml", XML_HEAD + `<p:viewPr ${NS_P}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`]);
        files.push(["ppt/tableStyles.xml", XML_HEAD + `<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`]);
        files.push(["ppt/theme/theme1.xml", THEME_XML]);
        files.push(["ppt/slideMasters/slideMaster1.xml", XML_HEAD + `<p:sldMaster ${NS_P}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${EMPTY_TREE}</p:cSld>${CLR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`]);
        files.push(["ppt/slideMasters/_rels/slideMaster1.xml.rels", XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`]);
        files.push(["ppt/slideLayouts/slideLayout1.xml", XML_HEAD + `<p:sldLayout ${NS_P} type="blank" preserve="1"><p:cSld name="Blank">${EMPTY_TREE}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`]);
        files.push(["ppt/slideLayouts/_rels/slideLayout1.xml.rels", XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`]);
        if (withNotes.length) {
            files.push(["ppt/theme/theme2.xml", THEME_XML]);
            files.push(["ppt/notesMasters/notesMaster1.xml", XML_HEAD + `<p:notesMaster ${NS_P}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${EMPTY_TREE}</p:cSld>${CLR_MAP}</p:notesMaster>`]);
            files.push(["ppt/notesMasters/_rels/notesMaster1.xml.rels", XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme2.xml"/></Relationships>`]);
        }
        slides.forEach((slide, i) => {
            files.push([`ppt/slides/slide${i + 1}.xml`, slideXml(slide, i, theme)]);
            files.push([`ppt/slides/_rels/slide${i + 1}.xml.rels`, XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${slide.notes ? `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/>` : ""}</Relationships>`]);
            if (slide.notes) {
                files.push([`ppt/notesSlides/notesSlide${i + 1}.xml`, notesXml(slide.notes)]);
                files.push([`ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`, XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster" Target="../notesMasters/notesMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="../slides/slide${i + 1}.xml"/></Relationships>`]);
            }
        });
        return { bytes: zip(files), slides: slides.length };
    }

    // ---------- DOCX (from Markdown) ----------

    function inlineRuns(text) {
        const out = [];
        const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
        let last = 0, m;
        const run = (t, props = "") => out.push(`<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${xml(t)}</w:t></w:r>`);
        while ((m = re.exec(text))) {
            if (m.index > last) run(text.slice(last, m.index));
            const tok = m[0];
            if (tok.startsWith("**")) run(tok.slice(2, -2), "<w:b/>");
            else if (tok.startsWith("`")) run(tok.slice(1, -1), '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
            else if (tok.startsWith("[")) { const l = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok); run(`${l[1]} (${l[2]})`, '<w:color w:val="0563C1"/><w:u w:val="single"/>'); }
            else run(tok.slice(1, -1), "<w:i/>");
            last = m.index + tok.length;
        }
        if (last < text.length) run(text.slice(last));
        return out.join("");
    }

    function markdownToDocxBody(markdown) {
        const lines = String(markdown || "").replace(/\r/g, "").split("\n");
        const body = [];
        const para = (style, content, extra = "") => body.push(`<w:p>${style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extra}</w:pPr>` : ""}${content}</w:p>`);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            let m;
            if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { para(m[1].length === 1 && !body.length ? "Title" : `Heading${Math.min(3, m[1].length)}`, inlineRuns(m[2])); continue; }
            if (/^```/.test(line)) {
                const code = [];
                for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
                for (const c of code) para("Code", `<w:r><w:t xml:space="preserve">${xml(c)}</w:t></w:r>`);
                continue;
            }
            if (/^\s*\|.*\|\s*$/.test(line)) {
                const rows = [];
                for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) {
                    if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) continue;
                    rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
                }
                i--;
                const cols = Math.max(...rows.map(r => r.length));
                const w = Math.floor(9000 / cols);
                body.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${rows.map((r, ri) => `<w:tr>${Array.from({ length: cols }, (_, c) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="1F4E79"/>' : ""}</w:tcPr><w:p>${ri === 0 ? `<w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr><w:t xml:space="preserve">${xml(r[c] || "")}</w:t></w:r>` : inlineRuns(r[c] || "")}</w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`);
                body.push("<w:p/>");
                continue;
            }
            if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) { para("ListBullet", inlineRuns(m[2]), `<w:numPr><w:ilvl w:val="${Math.min(2, m[1].length >> 1)}"/><w:numId w:val="1"/></w:numPr>`); continue; }
            if ((m = /^(\s*)\d+[.)]\s+(.*)$/.exec(line))) { para("ListNumber", inlineRuns(m[2]), `<w:numPr><w:ilvl w:val="${Math.min(2, m[1].length >> 1)}"/><w:numId w:val="2"/></w:numPr>`); continue; }
            if ((m = /^>\s?(.*)$/.exec(line))) { para("Quote", inlineRuns(m[1])); continue; }
            if (/^(-{3,}|\*{3,})$/.test(line.trim())) { body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>'); continue; }
            // A paragraph: following plain lines join it.
            let text = line.trim();
            while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#{1,4}\s|```|\s*\||\s*[-*+]\s|\s*\d+[.)]\s|>)/.test(lines[i + 1])) text += " " + lines[++i].trim();
            para("", inlineRuns(text));
        }
        return body.join("");
    }

    function buildDocx(spec = {}) {
        const markdown = spec.markdown || spec.content || "";
        if (!String(markdown).trim()) throw new Error("create_document needs markdown content");
        const lvl = (i, fmt, text, ind) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${ind}" w:hanging="360"/></w:pPr>${fmt === "bullet" ? '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr>' : ""}</w:lvl>`;
        const files = [
            ["[Content_Types].xml", XML_HEAD + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`],
            ["_rels/.rels", XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`],
            ...docProps(spec.title || "CoDev document", "Microsoft Office Word"),
            ["word/_rels/document.xml.rels", XML_HEAD + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`],
            ["word/document.xml", XML_HEAD + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${markdownToDocxBody(markdown)}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`],
            ["word/numbering.xml", XML_HEAD + `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0">${lvl(0, "bullet", "", 720)}${lvl(1, "bullet", "o", 1440)}${lvl(2, "bullet", "", 2160)}</w:abstractNum><w:abstractNum w:abstractNumId="1">${lvl(0, "decimal", "%1.", 720)}${lvl(1, "lowerLetter", "%2.", 1440)}${lvl(2, "lowerRoman", "%3.", 2160)}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`],
            ["word/styles.xml", XML_HEAD + `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:color w:val="1F4E79"/><w:sz w:val="52"/></w:rPr></w:style>${[1, 2, 3].map(n => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${n === 1 ? 360 : 240}" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="${n === 1 ? "1F4E79" : "2E74B5"}"/><w:sz w:val="${[0, 32, 26, 24][n]}"/></w:rPr></w:style>`).join("")}<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/></w:tblBorders><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`]
        ];
        return { bytes: zip(files) };
    }

    // ---------- CSV ----------

    function buildCsv(columns, rows) {
        const cell = v => {
            if (v === null || v === undefined) return "";
            if (typeof v === "object") v = v.v ?? v.value ?? (v.f != null ? `=${String(v.f).replace(/^=/, "")}` : JSON.stringify(v));
            const s = String(v);
            return /[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const lines = [];
        if (columns && columns.length) lines.push(columns.map(cell).join(","));
        for (const r of rows || []) lines.push((Array.isArray(r) ? r : (columns || Object.keys(r || {})).map(c => (r ? r[c] : ""))).map(cell).join(","));
        // The BOM makes Excel read UTF-8 (names with accents) correctly.
        return "﻿" + lines.join("\r\n") + "\r\n";
    }

    // ---------- Web apps ----------

    const TEXT_EXT = /\.(html?|css|js|mjs|json|svg|txt|md|xml|webmanifest|map)$/i;

    function cleanAppPath(p) {
        const parts = String(p || "").replace(/\\/g, "/").split("/").filter(s => s && s !== ".");
        if (!parts.length || parts.some(s => s === "..")) return null;
        return parts.join("/");
    }

    // The app's own CSS and scripts put inline, so one self-contained page previews it.
    function inlineAssets(files, entry) {
        let html = files[entry];
        const dir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : "";
        const local = href => { const p = cleanAppPath(dir + String(href).replace(/^\.\//, "").split(/[?#]/)[0]); return p && files[p] != null ? p : null; };
        html = html.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, tag => {
            const href = (/href=["']([^"']+)["']/i.exec(tag) || [])[1];
            const p = href && !/^[a-z]+:|^\/\//i.test(href) ? local(href) : null;
            return p ? `<style>/* ${p} */\n${files[p]}\n</style>` : tag;
        });
        html = html.replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, a, src, b) => {
            const p = !/^[a-z]+:|^\/\//i.test(src) ? local(src) : null;
            const attrs = `${a}${b}`.replace(/\s+/g, " ").trim();
            return p ? `<script${attrs ? ` ${attrs}` : ""}>/* ${p} */\n${String(files[p]).replace(/<\/script/gi, "<\\/script")}\n</script>` : tag;
        });
        return html;
    }

    // Syntax problems that would leave a blank page. Nothing is run: a script is only
    // compiled (new Function), and JSON parsed. Modules can't be compiled that way.
    function checkWebApp(files, compile) {
        const problems = [];
        const tryCompile = (code, where) => {
            if (!compile) return;
            try { compile(code); } catch (err) { problems.push(`${where}: ${err.message}`); }
        };
        for (const [p, content] of Object.entries(files)) {
            if (/\.json$/i.test(p)) { try { JSON.parse(content); } catch (err) { problems.push(`${p}: ${err.message}`); } }
            else if (/\.js$/i.test(p) && !/^\s*(import|export)\s/m.test(content)) tryCompile(content, p);
            else if (/\.html?$/i.test(p)) {
                const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
                let m, n = 0;
                while ((m = re.exec(content))) {
                    n++;
                    if (/\bsrc=/.test(m[1]) || /type=["']?(module|application\/(ld\+)?json|text\/(template|x-))/i.test(m[1])) continue;
                    tryCompile(m[2], `${p} inline script ${n}`);
                }
                const missing = [];
                const refs = /(?:src|href)=["']([^"'#?]+)["']/gi;
                const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "";
                while ((m = refs.exec(content))) {
                    const ref = m[1];
                    if (/^([a-z]+:|\/\/|#|mailto:|data:)/i.test(ref) || ref.startsWith("/")) continue;
                    if (!/\.(css|js|mjs|png|jpe?g|gif|svg|webp|ico|json|html?)$/i.test(ref)) continue;
                    const target = cleanAppPath(dir + ref.replace(/^\.\//, ""));
                    if (target && files[target] == null) missing.push(ref);
                }
                if (missing.length) problems.push(`${p} links to files that aren't in the app: ${[...new Set(missing)].join(", ")}`);
            }
        }
        return problems;
    }

    function buildWebApp(spec = {}, { compile } = {}) {
        const raw = spec.files && typeof spec.files === "object" ? spec.files : {};
        const files = {};
        for (const [p, content] of Object.entries(raw)) {
            const clean = cleanAppPath(p);
            if (!clean) throw new Error(`"${p}" isn't a valid file path inside the app`);
            if (!TEXT_EXT.test(clean)) throw new Error(`${clean}: only text files (html, css, js, json, svg, md...) can be written; draw pictures with SVG or CSS, or link to them`);
            files[clean] = String(content ?? "");
        }
        const entry = cleanAppPath(spec.entry) || (files["index.html"] != null ? "index.html" : Object.keys(files).find(p => /\.html?$/i.test(p)));
        if (!entry || files[entry] == null) throw new Error("the app needs an index.html (or name its entry page)");
        const problems = checkWebApp(files, compile);
        const preview = inlineAssets(files, entry);
        const bytes = zip(Object.entries(files));
        return { bytes, preview, entry, files: Object.keys(files), problems };
    }

    // ---------- Datasets: tables agents collected, to put in files without retyping ----------

    function createDatasetStore({ max = 30 } = {}) {
        const sets = new Map();
        let seq = 0;
        return {
            add({ name, columns, rows, source }) {
                const cols = Array.isArray(columns) && columns.length ? columns.map(String)
                    : [...new Set((rows || []).flatMap(r => (r && typeof r === "object" && !Array.isArray(r) ? Object.keys(r) : [])))];
                const body = (rows || []).map(r => (Array.isArray(r) ? r : cols.map(c => (r ? r[c] ?? null : null))));
                const id = `ds${++seq}`;
                sets.set(id, { id, name: String(name || id).slice(0, 80), columns: cols, rows: body, source: source || "", at: Date.now() });
                while (sets.size > max) sets.delete(sets.keys().next().value);
                return sets.get(id);
            },
            get(id) {
                const key = String(id || "").trim();
                return sets.get(key) || [...sets.values()].find(d => d.name.toLowerCase() === key.toLowerCase()) || null;
            },
            list() { return [...sets.values()]; }
        };
    }

    function previewRows(columns, rows, max = 8) {
        const head = `| ${columns.join(" | ")} |\n|${columns.map(() => "---").join("|")}|`;
        const body = rows.slice(0, max).map(r => `| ${r.map(v => String(v ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 60)).join(" | ")} |`).join("\n");
        return `${head}\n${body}${rows.length > max ? `\n… ${rows.length - max} more row(s)` : ""}`;
    }

    // ---------- The agents' tools ----------

    const cellDoc = "A cell is a number, text, true/false, null, or text starting with = for a formula (\"=SUM(B2:B9)\", \"=B2*C2\", \"='Q1 Sales'!D10\"). An object {\"v\": 1250, \"format\": \"currency\"} sets a format: currency, percent (0.25 shows 25%), date (\"2026-03-01\"), int, decimal, bold, wrap.";

    // deps: { saveFile({ name, mime, bytes, kind, preview }) -> Promise<{ id }>, datasets, compile(code), writeProjectFile?(path, text) }
    function buildFileTools(deps) {
        const { saveFile, datasets, compile } = deps;
        const deliver = async (ctx, record) => {
            const saved = await saveFile(record);
            ctx.generatedFiles = ctx.generatedFiles || [];
            ctx.generatedFiles.push({ name: record.name, kind: "file", fileId: saved.id, size: record.bytes.length, mime: record.mime, format: record.kind });
            return saved;
        };
        const kb = n => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
        const showValue = v => (typeof v === "number" ? (Math.abs(v) >= 1000 || Number.isInteger(v) ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(Math.round(v * 10000) / 10000)) : v === null || v === undefined ? "(blank)" : String(v));
        return [
            {
                name: "create_spreadsheet",
                description: "Make a real Excel workbook (.xlsx) the user can download: several sheets, working formulas (also across sheets), number formats, a styled header with filters and frozen panes, and an optional totals row. "
                    + "Use it whenever the user wants a spreadsheet, tracker, budget, model, comparison table or data export, instead of pasting a table. Put collected data in with dataset (from browser_extract or wide_research) instead of retyping rows. "
                    + "The result lists every formula's value: check them before you answer. " + cellDoc,
                inputSchema: { type: "object", properties: {
                    filename: { type: "string", description: "File name, like \"Q3 budget\"." },
                    sheets: { type: "array", description: "The sheets, in order.", items: { type: "object", properties: {
                        name: { type: "string", description: "Tab name (31 characters at most)." },
                        columns: { type: "array", description: "Header cells: text, or {\"header\": \"Price\", \"format\": \"currency\", \"width\": 14}.", items: {} },
                        rows: { type: "array", description: "Rows: arrays of cells in column order, or objects keyed by header.", items: {} },
                        dataset: { type: "string", description: "A dataset id (ds1...) whose columns and rows fill this sheet; rows you give are added after it." },
                        total_row: { type: ["boolean", "string"], description: "true adds a SUM row under the numeric columns; or AVERAGE, MIN, MAX, COUNT." },
                        freeze: { type: "boolean", description: "Freeze the header row (default true)." }
                    } } }
                }, required: ["sheets"] },
                run: async (args, ctx) => {
                    let built;
                    try { built = buildXlsx({ sheets: args.sheets, title: args.filename }, { getDataset: id => datasets && datasets.get(id) }); }
                    catch (err) { return `Error: the workbook wasn't made: ${err.message}.`; }
                    const name = safeFileName(args.filename || "workbook", "xlsx");
                    const first = built.sheets[0];
                    await deliver(ctx, { name, mime: MIME.xlsx, bytes: built.bytes, kind: "xlsx", preview: { sheets: built.sheets } });
                    const errors = built.checks.filter(c => typeof c.value === "string" && c.value.startsWith("#"));
                    const shown = built.checks.slice(0, 25).map(c => `${c.sheet}!${c.cell} ${c.formula} → ${showValue(c.value)}`).join("\n");
                    return `Made ${name} (${kb(built.bytes.length)}): ${built.sheets.map(s => `"${s.name}" ${s.rows} rows × ${s.columns} columns`).join(", ")}. It is attached to your reply for the user to download; don't paste its contents.`
                        + (built.checks.length ? `\n\nFormula results (Excel recalculates them on open):\n${shown}${built.checks.length > 25 ? `\n… ${built.checks.length - 25} more` : ""}` : "")
                        + (errors.length ? `\n\n⚠️ ${errors.length} formula(s) give an error (${errors.slice(0, 5).map(e => `${e.sheet}!${e.cell} ${e.value}`).join(", ")}). Fix the ranges or references and call create_spreadsheet again.` : "")
                        + (first && first.rows <= 1 ? "\n\n⚠️ The first sheet has no data rows." : "");
                }
            },
            {
                name: "create_slides",
                description: "Make a PowerPoint deck (.pptx, opens in PowerPoint, Google Slides and Keynote) the user can download and present. Each slide has a layout: title, section, bullets, table, stats (big numbers) or columns (two or three side-by-side lists). "
                    + "Keep slides short: a headline title that states the point, 3 to 6 bullets of under 15 words. Use it whenever the user asks for slides, a deck or a presentation.",
                inputSchema: { type: "object", properties: {
                    filename: { type: "string" },
                    title: { type: "string", description: "Optional: adds a title slide first." },
                    subtitle: { type: "string" },
                    theme: { type: "string", enum: Object.keys(THEMES), description: "Colors (default blue)." },
                    slides: { type: "array", items: { type: "object", properties: {
                        layout: { type: "string", enum: ["title", "section", "bullets", "table", "stats", "columns"] },
                        title: { type: "string" },
                        subtitle: { type: "string", description: "For title and section slides." },
                        bullets: { type: "array", description: "Text lines; start a line with two spaces per sub-level, or give {\"text\", \"level\"}. **bold** works.", items: {} },
                        table: { type: "object", description: "{\"columns\": [...], \"rows\": [[...]...]} up to 14 rows.", properties: { columns: { type: "array", items: {} }, rows: { type: "array", items: {} } } },
                        stats: { type: "array", description: "Up to 4 {\"value\": \"$4.2M\", \"label\": \"ARR\"}.", items: { type: "object" } },
                        columns: { type: "array", description: "Up to 3 {\"heading\", \"bullets\": [...]}.", items: { type: "object" } },
                        notes: { type: "string", description: "Speaker notes." }
                    } } }
                }, required: ["slides"] },
                run: async (args, ctx) => {
                    let built;
                    try { built = buildPptx(args); } catch (err) { return `Error: the deck wasn't made: ${err.message}.`; }
                    const name = safeFileName(args.filename || args.title || "slides", "pptx");
                    await deliver(ctx, { name, mime: MIME.pptx, bytes: built.bytes, kind: "pptx", preview: { slides: (args.title ? [{ title: args.title }] : []).concat(args.slides || []).map(s => s.title || "").slice(0, 40) } });
                    const long = (args.slides || []).filter(s => Array.isArray(s.bullets) && (s.bullets.length > 8 || s.bullets.some(b => String(typeof b === "string" ? b : b.text || "").length > 140))).map(s => s.title);
                    return `Made ${name} (${built.slides} slides, ${kb(built.bytes.length)}). It is attached to your reply for the user to download; don't paste the slides' text.`
                        + (long.length ? `\n⚠️ These slides are text-heavy and may look crowded: ${long.join("; ")}. Consider splitting them.` : "");
                }
            },
            {
                name: "create_document",
                description: "Make a Word document (.docx) from Markdown: headings (#, ##, ###), paragraphs, **bold**, *italic*, bullet and numbered lists, tables (| a | b |), quotes and code blocks. "
                    + "Use it for reports, letters, plans, proposals and research write-ups the user wants as a file.",
                inputSchema: { type: "object", properties: {
                    filename: { type: "string" },
                    markdown: { type: "string", description: "The whole document in Markdown. A first # heading becomes the title." }
                }, required: ["markdown"] },
                run: async (args, ctx) => {
                    let built;
                    try { built = buildDocx(args); } catch (err) { return `Error: the document wasn't made: ${err.message}.`; }
                    const title = (/^#\s+(.+)$/m.exec(String(args.markdown || "")) || [])[1];
                    const name = safeFileName(args.filename || title || "document", "docx");
                    await deliver(ctx, { name, mime: MIME.docx, bytes: built.bytes, kind: "docx", preview: { text: String(args.markdown).slice(0, 4000) } });
                    return `Made ${name} (${kb(built.bytes.length)}). It is attached to your reply for the user to download; give a short summary instead of pasting it.`;
                }
            },
            {
                name: "create_csv",
                description: "Make a CSV file (opens in Excel, Google Sheets, databases) from rows or a collected dataset. Prefer create_spreadsheet when the user wants formulas or formatting.",
                inputSchema: { type: "object", properties: {
                    filename: { type: "string" },
                    columns: { type: "array", items: { type: "string" } },
                    rows: { type: "array", items: {}, description: "Arrays in column order, or objects keyed by column." },
                    dataset: { type: "string", description: "A dataset id (ds1...) to write instead of rows." }
                } },
                run: async (args, ctx) => {
                    let columns = Array.isArray(args.columns) ? args.columns.map(String) : null;
                    let rows = Array.isArray(args.rows) ? args.rows : [];
                    if (args.dataset) {
                        const ds = datasets && datasets.get(args.dataset);
                        if (!ds) return `Error: there is no dataset "${args.dataset}". list_datasets shows what was collected.`;
                        columns = columns || ds.columns;
                        rows = ds.rows.concat(rows);
                    }
                    if (!rows.length) return "Error: create_csv needs rows or a dataset.";
                    if (!columns && rows.some(r => r && !Array.isArray(r))) columns = [...new Set(rows.flatMap(r => Object.keys(r || {})))];
                    const csv = buildCsv(columns, rows);
                    const bytes = enc.encode(csv);
                    const name = safeFileName(args.filename || "data", "csv");
                    await deliver(ctx, { name, mime: MIME.csv, bytes, kind: "csv", preview: { columns: columns || [], rows: rows.slice(0, 20) } });
                    return `Made ${name} (${rows.length} rows, ${kb(bytes.length)}). It is attached to your reply for the user to download.`;
                }
            },
            {
                name: "create_web_app",
                description: "Build a working web app, site, dashboard, game or tool as files (index.html plus any CSS, JS and JSON), checked for syntax errors and missing files, and handed to the user as a live preview they can open and a .zip ready to host (drag it onto Netlify Drop, or upload to GitHub Pages or any static host). "
                    + "Use it when the user wants an app or page they can run, instead of pasting code. Keep it self-contained: no build step, libraries only from a CDN. If the result lists problems, fix them and call it again.",
                inputSchema: { type: "object", properties: {
                    name: { type: "string", description: "The app's name, used for the zip." },
                    files: { type: "object", description: "Path -> file content, like {\"index.html\": \"<!doctype html>...\", \"app.js\": \"...\", \"style.css\": \"...\"}.", additionalProperties: { type: "string" } },
                    entry: { type: "string", description: "The page to open (default index.html)." },
                    save_to_project: { type: "string", description: "Optional: also write the files into this folder of the user's project (like apps/budget)." }
                }, required: ["files"] },
                run: async (args, ctx) => {
                    let built;
                    try { built = buildWebApp(args, { compile }); } catch (err) { return `Error: the app wasn't made: ${err.message}.`; }
                    const name = safeFileName(args.name || "web-app", "zip");
                    await deliver(ctx, { name, mime: MIME.zip, bytes: built.bytes, kind: "webapp", preview: { html: built.preview, entry: built.entry, files: built.files } });
                    let saved = "";
                    if (args.save_to_project && deps.writeProjectFile) {
                        const folder = cleanAppPath(args.save_to_project);
                        if (folder) {
                            const results = [];
                            for (const p of built.files) results.push(await deps.writeProjectFile(`${folder}/${p}`, String(args.files[p] ?? args.files[`./${p}`] ?? "")).catch(err => `Error: ${err.message}`));
                            const failed = results.filter(r => /^(Error|The user declined)/.test(String(r)));
                            saved = failed.length ? `\nSaving into ${folder}/ in the project: ${failed[0]}` : `\nAlso saved into ${folder}/ in the project.`;
                        }
                    }
                    return `Made ${name} with ${built.files.length} file(s) (${built.files.join(", ")}). The user gets a ▶ live preview and the .zip with your reply.${saved}`
                        + (built.problems.length ? `\n\n⚠️ Problems found (the page may be blank or broken):\n${built.problems.slice(0, 10).join("\n")}\nFix them and call create_web_app again.` : "\nSyntax check: passed.");
                }
            },
            {
                name: "list_datasets",
                description: "List the tables collected in this session (from browser_extract, wide_research...) with their ids, sizes and first rows, to put them in a spreadsheet or CSV.",
                inputSchema: { type: "object", properties: { id: { type: "string", description: "Optional: show more rows of one dataset." } } },
                run: async ({ id }) => {
                    if (!datasets) return "No datasets here.";
                    if (id) {
                        const ds = datasets.get(id);
                        return ds ? `${ds.id} "${ds.name}" (${ds.rows.length} rows${ds.source ? `, from ${ds.source}` : ""})\n${previewRows(ds.columns, ds.rows, 40)}` : `There is no dataset "${id}".`;
                    }
                    const all = datasets.list();
                    return all.length ? all.map(ds => `${ds.id} "${ds.name}": ${ds.rows.length} rows × ${ds.columns.length} columns (${ds.columns.slice(0, 8).join(", ")})${ds.source ? `, from ${ds.source}` : ""}`).join("\n") : "No datasets collected yet.";
                }
            }
        ];
    }

    const TOOL_NAMES = ["create_spreadsheet", "create_slides", "create_document", "create_csv", "create_web_app", "list_datasets"];

    function describe(name, args = {}) {
        if (name === "create_spreadsheet") return `📊 Building the spreadsheet ${args.filename || ""}`.trim();
        if (name === "create_slides") return `📽️ Building the slides ${args.filename || args.title || ""}`.trim();
        if (name === "create_document") return `📄 Writing the document ${args.filename || ""}`.trim();
        if (name === "create_csv") return `🧾 Writing the CSV ${args.filename || ""}`.trim();
        if (name === "create_web_app") return `🌐 Building the web app ${args.name || ""}`.trim();
        if (name === "list_datasets") return "🗂️ Listing collected datasets";
        return "";
    }

    // Requests that should end in a file, so the agent is told to make one.
    const FILE_TASK = /\b(spreadsheet|excel|xlsx|workbook|csv|slides?|slide deck|deck|powerpoint|pptx|presentation|word doc(ument)?|docx|web ?app|website|landing page|dashboard|download(able)?|export)\b/i;
    const FILE_RULES = "[Files] When the user wants a spreadsheet, deck, document, CSV or app, make the real file with create_spreadsheet, create_slides, create_document, create_csv or create_web_app: it is attached to your reply. Don't paste the file's contents or raw code instead. In spreadsheets use formulas for anything computed (totals, growth, ratios) so the user can change inputs, then check the formula results the tool reports. Put tables you collected (datasets) in with dataset instead of retyping them.";

    return {
        MIME, TOOL_NAMES, FILE_TASK, FILE_RULES, THEMES,
        zip, unzipStored, crc32, colName, colIndex, dateSerial, evaluateFormula, normalizeCell,
        buildXlsx, buildPptx, buildDocx, buildCsv, buildWebApp, inlineAssets, checkWebApp, markdownToDocxBody,
        createDatasetStore, previewRows, buildFileTools, describe, safeFileName
    };
});
