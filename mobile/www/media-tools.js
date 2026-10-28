// BIG FILES AND IMAGE MAKING
// Loaded before the main script in index.html, which calls these when files are
// attached and when it builds the agents' tools. Everything runs in the page, so
// it works the same in a browser, the Windows app and the Android app.
//
// Big files: long PDFs, spreadsheets (CSV, TSV, XLSX), text files and audio are
// read in full when picked. A short file goes into the message whole; a long one
// goes in as a summary plus its start, and the agent reads the rest with
// read_attachment (pages, searches) and query_table (filters, sums, averages,
// group totals over every row), so a 500-page PDF or a 100,000-row sheet costs
// only what the agent actually reads. Files are kept per chat in IndexedDB, so a
// follow-up question can still read them after a restart.
//
// Video: frames are sampled across the clip as before (more for longer clips).
// With a Gemini key, Gemini watches the whole video with its sound; otherwise a
// Groq key transcribes its sound with Whisper (both have free tiers).
//
// Images: generate_image makes pictures with Pollinations (Flux), which is free
// and needs no key, unless Settings picks Gemini (Nano Banana) or OpenRouter.
// Those cost money: Gemini's free tier has no image models, so a free Gemini key
// is for video, audio and scanned PDFs, never pictures. Each task makes at
// most MAX_IMAGES_PER_TASK and each day at most the daily limit in Settings.
// Pictures are kept in IndexedDB; the chat keeps a small preview.

const GEMINI_KEY_PATTERN = /^AIza[\w-]{20,}$/;
const GEMINI_API = "https://generativelanguage.googleapis.com";
// Flash-Lite: Gemini's cheapest model that watches video and listens to audio, with a free tier.
const GEMINI_MEDIA_MODEL = "gemini-3.5-flash-lite";
const GEMINI_IMAGE_MODELS = {
    lite: "gemini-3.1-flash-lite-image",   // Nano Banana 2 Lite: cheapest
    standard: "gemini-3.1-flash-image",    // Nano Banana 2
    pro: "gemini-3-pro-image"              // Nano Banana Pro: best and dearest
};
const DEFAULT_OPENROUTER_IMAGE_MODEL = "google/gemini-2.5-flash-image";
const POLLINATIONS_URL = "https://image.pollinations.ai/prompt/";

// Pollinations without a key: about one picture every 15 to 45 seconds per address.
const POLLINATIONS_RETRY_MAX_SECONDS = 50;

// Long text past this goes in as its start and a summary; the rest through read_attachment.
const INLINE_DOC_CHARS = 40000;
const DOC_PREVIEW_CHARS = 12000;
const MAX_DOC_CHARS = 4000000;
const MAX_PDF_PAGES = 3000;
const READ_CHUNK_CHARS = 12000;
const MAX_SHEET_ROWS = 300000;
const INLINE_SHEET_CHARS = 20000;
const MAX_TABLE_RESULT_CHARS = 9000;
// Gemini takes up to about 20 MB inline; bigger videos go through its Files API.
const GEMINI_INLINE_BYTES = 14 * 1024 * 1024;
const MAX_GEMINI_VIDEO_SECONDS = 45 * 60;
const WHISPER_MAX_BYTES = 25 * 1024 * 1024;
const MAX_IMAGES_PER_TASK = 4;
const DEFAULT_DAILY_IMAGE_LIMIT = 20;
const MAX_KEPT_ATTACHMENTS = 40;

let geminiKey = String(localStorage.getItem("codev_gemini_key") || "").replace(/[\s​-‍﻿"'`]+/g, "");
let imageProvider = localStorage.getItem("codev_image_provider") || "auto";   // auto | gemini | openrouter | free | off
let geminiImageQuality = localStorage.getItem("codev_image_quality") || "lite";
let openRouterImageModel = localStorage.getItem("codev_openrouter_image_model") || DEFAULT_OPENROUTER_IMAGE_MODEL;
let dailyImageLimit = Number(localStorage.getItem("codev_daily_image_limit")) || DEFAULT_DAILY_IMAGE_LIMIT;

// ---------- File kinds ----------

const SHEET_EXTENSIONS = [".csv", ".tsv", ".xlsx", ".xlsm"];
const TEXT_EXTENSIONS = [".txt", ".md", ".markdown", ".json", ".jsonl", ".log", ".xml", ".html", ".htm", ".yaml", ".yml", ".ini", ".cfg", ".toml",
    ".js", ".ts", ".jsx", ".tsx", ".py", ".gd", ".cs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".go", ".rs", ".rb", ".php", ".sql", ".sh", ".bat", ".ps1", ".css", ".srt", ".vtt"];
const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".wav", ".ogg", ".oga", ".flac", ".aac", ".opus", ".weba"];

function fileExtension(name) {
    const match = /\.[^./\\]+$/.exec(String(name || "").toLowerCase());
    return match ? match[0] : "";
}

// "sheet", "text" or "audio" for the kinds this file adds; null for the rest.
function extraAttachmentKind(file) {
    const ext = fileExtension(file.name);
    if (SHEET_EXTENSIONS.includes(ext) || /^text\/(csv|tab-separated-values)$/.test(file.type)
        || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "sheet";
    if (ext === ".xls") return "sheet";   // refused with a clear message in prepareSheet
    if (file.type.startsWith("audio/") || AUDIO_EXTENSIONS.includes(ext)) return "audio";
    if (file.type.startsWith("text/") || TEXT_EXTENSIONS.includes(ext) || file.type === "application/json") return "text";
    return null;
}

// ---------- Long documents ----------

// What goes in the message for a long text: all of it when short, else the start,
// its size, and how to read on.
function describeLongText(att, label, fullText, extra = "") {
    att.fullText = fullText;
    if (fullText.length <= INLINE_DOC_CHARS) {
        att.text = `${label}${extra}:\n${fullText}`;
        return;
    }
    att.text = `${label}${extra}, ${fullText.length.toLocaleString("en-US")} characters. Only the first ${DOC_PREVIEW_CHARS.toLocaleString("en-US")} are below. `
        + `Read the rest with read_attachment (name "${att.name}"): pass pages like "40-45", a query to find every passage that mentions something, or start for the next part. `
        + `Don't answer about parts you haven't read.\n${fullText.slice(0, DOC_PREVIEW_CHARS)}\n[…continues]`;
}

// The whole text layer of a PDF, page by page. Scanned pages have none.
async function extractPdfText(pdf) {
    const pages = [];
    let total = 0;
    const last = Math.min(pdf.numPages, MAX_PDF_PAGES);
    for (let pageNo = 1; pageNo <= last && total < MAX_DOC_CHARS; pageNo++) {
        const page = await pdf.getPage(pageNo);
        const content = await page.getTextContent();
        const text = content.items.map(item => item.str + (item.hasEOL ? "\n" : " ")).join("");
        pages.push(`\n--- Page ${pageNo} ---\n${text}`);
        total += text.length + 20;
        page.cleanup();
    }
    let fullText = pages.join("");
    if (fullText.length > MAX_DOC_CHARS) fullText = fullText.slice(0, MAX_DOC_CHARS);
    return { fullText, pagesRead: pages.length, cut: pages.length < pdf.numPages };
}

async function prepareTextFile(file, att) {
    let text = await file.text();
    const cut = text.length > MAX_DOC_CHARS;
    if (cut) text = text.slice(0, MAX_DOC_CHARS);
    describeLongText(att, `Text file "${file.name}"`, text, cut ? ` (only the first ${MAX_DOC_CHARS.toLocaleString("en-US")} characters were kept)` : "");
}

// ---------- Spreadsheets ----------

function detectDelimiter(text, name) {
    if (fileExtension(name) === ".tsv") return "\t";
    const firstLine = text.slice(0, 5000).split(/\r?\n/)[0] || "";
    const counts = { ",": 0, "\t": 0, ";": 0, "|": 0 };
    let quoted = false;
    for (const ch of firstLine) {
        if (ch === '"') quoted = !quoted;
        else if (!quoted && ch in counts) counts[ch]++;
    }
    const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return count > 0 ? best : ",";
}

// RFC 4180 CSV: quoted fields may hold the delimiter, quotes ("") and line breaks.
function parseDelimited(text, delimiter, maxRows = MAX_SHEET_ROWS + 1) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    let i = text.charCodeAt(0) === 0xFEFF ? 1 : 0;
    for (; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
            } else field += ch;
        } else if (ch === '"' && field === "") {
            quoted = true;
        } else if (ch === delimiter) {
            row.push(field); field = "";
        } else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && text[i + 1] === "\n") i++;
            row.push(field); field = "";
            if (row.length > 1 || row[0] !== "") rows.push(row);
            row = [];
            if (rows.length >= maxRows) return { rows, cut: true };
        } else field += ch;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return { rows, cut: false };
}

// The first row names the columns when it is mostly text over a column of numbers,
// or simply text; otherwise the columns are named A, B, C.
function tableFromRows(name, rows, cut) {
    const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
    const first = rows[0] || [];
    const looksLikeHeader = first.length && first.filter(v => String(v).trim() && !isNumberLike(v)).length >= Math.ceil(first.filter(v => String(v).trim()).length * 0.6);
    const columns = [];
    for (let c = 0; c < width; c++) {
        let label = looksLikeHeader ? String(first[c] ?? "").trim() : "";
        if (!label) label = columnLetter(c);
        while (columns.includes(label)) label += "_";
        columns.push(label);
    }
    const body = (looksLikeHeader ? rows.slice(1) : rows).map(r => {
        const out = new Array(width);
        for (let c = 0; c < width; c++) out[c] = r[c] === undefined || r[c] === null ? "" : String(r[c]);
        return out;
    });
    return { name, columns, rows: body, cut };
}

function columnLetter(index) {
    let s = "";
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
    return s;
}

function toNumber(value) {
    const s = String(value ?? "").trim().replace(/^\((.*)\)$/, "-$1").replace(/[$€£,\s]/g, "").replace(/%$/, "");
    if (!s || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
    return Number(s);
}

function isNumberLike(value) { return !Number.isNaN(toNumber(value)); }

// Each column's type and a few numbers about it, so the summary says what's there.
function describeColumns(table) {
    return table.columns.map((column, c) => {
        let filled = 0, numeric = 0, min = Infinity, max = -Infinity, sum = 0;
        const distinct = new Set();
        for (const row of table.rows) {
            const v = row[c];
            if (v === "" || v === undefined) continue;
            filled++;
            if (distinct.size <= 1000) distinct.add(v);
            const n = toNumber(v);
            if (!Number.isNaN(n)) { numeric++; sum += n; if (n < min) min = n; if (n > max) max = n; }
        }
        if (!filled) return `${column} (empty)`;
        if (numeric >= filled * 0.9) return `${column} (number: min ${roundNice(min)}, max ${roundNice(max)}, average ${roundNice(sum / numeric)}${filled < table.rows.length ? `, ${table.rows.length - filled} blank` : ""})`;
        if (filled && [...distinct].slice(0, 50).every(v => /^\d{4}-\d{2}-\d{2}/.test(v))) return `${column} (date)`;
        return `${column} (text, ${distinct.size > 1000 ? "1000+" : distinct.size} different values${distinct.size <= 6 ? `: ${[...distinct].map(v => String(v).slice(0, 30)).join(", ")}` : ""})`;
    });
}

function roundNice(n) {
    if (!Number.isFinite(n)) return String(n);
    return Math.abs(n) >= 100 ? String(Math.round(n * 100) / 100) : String(Math.round(n * 10000) / 10000);
}

function csvCell(value) {
    const s = String(value ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tableToCsv(columns, rows) {
    return [columns, ...rows].map(r => r.map(csvCell).join(",")).join("\n");
}

async function prepareSheet(file, att) {
    const ext = fileExtension(file.name);
    if (ext === ".xls") throw new Error("old .xls files can't be read here. In Excel or Google Sheets, save it as .xlsx or .csv and attach that");
    let sheets;
    if (ext === ".xlsx" || ext === ".xlsm" || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
        sheets = await readXlsx(file);
    } else {
        const text = await file.text();
        const { rows, cut } = parseDelimited(text, detectDelimiter(text, file.name));
        sheets = [tableFromRows(file.name, rows, cut)];
    }
    sheets = sheets.filter(s => s.rows.length || s.columns.length);
    if (!sheets.length) throw new Error("it has no rows");
    att.sheets = sheets;
    const parts = [];
    let wholeLeft = INLINE_SHEET_CHARS;
    for (const sheet of sheets) {
        const csv = tableToCsv(sheet.columns, sheet.rows);
        const head = `Sheet "${sheet.name}": ${sheet.rows.length.toLocaleString("en-US")} rows × ${sheet.columns.length} columns${sheet.cut ? ` (only the first ${MAX_SHEET_ROWS.toLocaleString("en-US")} rows were kept)` : ""}.`;
        if (csv.length <= wholeLeft) {
            wholeLeft -= csv.length;
            parts.push(`${head} Every row:\n${csv}`);
        } else {
            parts.push(`${head}\nColumns: ${describeColumns(sheet).join("; ")}\nFirst 10 rows:\n${tableToCsv(sheet.columns, sheet.rows.slice(0, 10))}`);
        }
    }
    const partial = parts.some(p => !/Every row:/.test(p));
    att.text = `Spreadsheet "${file.name}" (${sheets.length} sheet${sheets.length === 1 ? "" : "s"}).\n${parts.join("\n\n")}`
        + (partial ? `\n\nOnly a preview of the rows is above. For counts, totals, averages, filters, rankings or any number from this data, call query_table (name "${file.name}") so the math runs over every row; never estimate from the preview.` : "");
}

// ---------- XLSX (a zip of XML files) ----------

async function inflateRaw(bytes) {
    if (typeof DecompressionStream === "undefined") throw new Error("this browser can't unzip .xlsx files; save it as .csv and attach that");
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// The files in a zip, by name, read from its central directory.
async function readZipEntries(buffer, wanted) {
    const view = new DataView(buffer);
    let end = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
        if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error("it isn't a valid .xlsx file");
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const decoder = new TextDecoder();
    const files = {};
    for (let n = 0; n < count; n++) {
        if (view.getUint32(at, true) !== 0x02014b50) break;
        const method = view.getUint16(at + 10, true);
        const compressedSize = view.getUint32(at + 20, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        const localOffset = view.getUint32(at + 42, true);
        const name = decoder.decode(new Uint8Array(buffer, at + 46, nameLength));
        at += 46 + nameLength + extraLength + commentLength;
        if (!wanted(name)) continue;
        const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
        const data = new Uint8Array(buffer, dataStart, compressedSize);
        files[name] = decoder.decode(method === 0 ? data : await inflateRaw(data));
    }
    return files;
}

// Built-in Excel number formats that are dates, and custom ones that look like dates.
const XLSX_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function xlsxDateStyles(stylesXml) {
    const dates = new Set();
    if (!stylesXml) return dates;
    const doc = new DOMParser().parseFromString(stylesXml, "application/xml");
    const custom = new Map([...doc.getElementsByTagName("numFmt")].map(f => [Number(f.getAttribute("numFmtId")), f.getAttribute("formatCode") || ""]));
    const xfs = doc.getElementsByTagName("cellXfs")[0];
    if (!xfs) return dates;
    [...xfs.getElementsByTagName("xf")].forEach((xf, index) => {
        const id = Number(xf.getAttribute("numFmtId"));
        const code = (custom.get(id) || "").replace(/"[^"]*"|\[[^\]]*\]/g, "");
        if (XLSX_DATE_FORMATS.has(id) || (custom.has(id) && /[dy]/i.test(code))) dates.add(index);
    });
    return dates;
}

function excelSerialToDate(serial, withTime) {
    const ms = Math.round((serial - 25569) * 86400000);
    const iso = new Date(ms).toISOString();
    return withTime && serial % 1 ? iso.slice(0, 16).replace("T", " ") : iso.slice(0, 10);
}

function columnIndexFromRef(ref) {
    let n = 0;
    for (const ch of String(ref).replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

async function readXlsx(file) {
    const buffer = await file.arrayBuffer();
    const files = await readZipEntries(buffer, name => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|worksheets\/[^/]+\.xml)$/.test(name));
    if (!files["xl/workbook.xml"]) throw new Error("it isn't a valid .xlsx file");
    const parse = xml => new DOMParser().parseFromString(xml, "application/xml");
    const shared = files["xl/sharedStrings.xml"]
        ? [...parse(files["xl/sharedStrings.xml"]).getElementsByTagName("si")].map(si => [...si.getElementsByTagName("t")].map(t => t.textContent).join(""))
        : [];
    const dateStyles = xlsxDateStyles(files["xl/styles.xml"]);
    const rels = new Map(files["xl/_rels/workbook.xml.rels"]
        ? [...parse(files["xl/_rels/workbook.xml.rels"]).getElementsByTagName("Relationship")].map(r => [r.getAttribute("Id"), r.getAttribute("Target")])
        : []);
    const sheets = [];
    const sheetElements = [...parse(files["xl/workbook.xml"]).getElementsByTagName("sheet")];
    sheetElements.forEach((sheetEl, index) => {
        const relId = sheetEl.getAttribute("r:id") || sheetEl.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
        let target = rels.get(relId) || `worksheets/sheet${index + 1}.xml`;
        target = target.replace(/^\/?xl\//, "").replace(/^\//, "");
        const xml = files[`xl/${target}`];
        if (!xml) return;
        const rows = [];
        let cut = false;
        for (const rowEl of parse(xml).getElementsByTagName("row")) {
            if (rows.length > MAX_SHEET_ROWS) { cut = true; break; }
            const row = [];
            for (const c of rowEl.getElementsByTagName("c")) {
                const col = c.getAttribute("r") ? columnIndexFromRef(c.getAttribute("r")) : row.length;
                const type = c.getAttribute("t");
                const v = c.getElementsByTagName("v")[0]?.textContent ?? "";
                let value;
                if (type === "s") value = shared[Number(v)] ?? "";
                else if (type === "inlineStr") value = [...c.getElementsByTagName("t")].map(t => t.textContent).join("");
                else if (type === "b") value = v === "1" ? "TRUE" : "FALSE";
                else if (type === "str" || type === "e") value = v;
                else if (v !== "" && dateStyles.has(Number(c.getAttribute("s") || 0))) value = excelSerialToDate(Number(v), true);
                else value = v;
                row[col] = value;
            }
            rows.push(row);
        }
        sheets.push(tableFromRows(sheetEl.getAttribute("name") || `Sheet${index + 1}`, rows, cut));
    });
    return sheets;
}

// ---------- query_table ----------

function findSheet(entry, sheetName) {
    const sheets = entry.sheets || [];
    if (!sheetName) return sheets[0];
    const wanted = String(sheetName).toLowerCase();
    return sheets.find(s => s.name.toLowerCase() === wanted) || sheets.find(s => s.name.toLowerCase().includes(wanted));
}

function findColumn(table, name) {
    if (name === undefined || name === null || name === "") return -1;
    const wanted = String(name).trim().toLowerCase();
    let index = table.columns.findIndex(c => c.toLowerCase() === wanted);
    if (index < 0) index = table.columns.findIndex(c => c.toLowerCase().includes(wanted));
    if (index < 0 && /^[A-Z]{1,3}$/.test(String(name).trim())) index = columnIndexFromRef(String(name).trim());
    return index < table.columns.length ? index : -1;
}

function rowMatches(row, filters) {
    return filters.every(({ index, op, value }) => {
        const cell = row[index] ?? "";
        const a = toNumber(cell), b = toNumber(value);
        const numeric = !Number.isNaN(a) && !Number.isNaN(b);
        const text = String(cell).toLowerCase(), target = String(value ?? "").toLowerCase();
        switch (op) {
            case "=": case "==": return numeric ? a === b : text === target;
            case "!=": return numeric ? a !== b : text !== target;
            case ">": return numeric ? a > b : text > target;
            case ">=": return numeric ? a >= b : text >= target;
            case "<": return numeric ? a < b : text < target;
            case "<=": return numeric ? a <= b : text <= target;
            case "contains": return text.includes(target);
            case "not_contains": return !text.includes(target);
            case "empty": return text.trim() === "";
            case "not_empty": return text.trim() !== "";
            default: return true;
        }
    });
}

function aggregate(values, how) {
    const nums = values.map(toNumber).filter(n => !Number.isNaN(n));
    switch (how) {
        case "count": return values.length;
        case "count_distinct": return new Set(values).size;
        case "sum": return nums.reduce((a, b) => a + b, 0);
        case "avg": case "mean": return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : NaN;
        case "min": return nums.length ? Math.min(...nums) : NaN;
        case "max": return nums.length ? Math.max(...nums) : NaN;
        case "median": {
            if (!nums.length) return NaN;
            const s = nums.slice().sort((a, b) => a - b);
            return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
        }
        default: return NaN;
    }
}

function clipResult(text) {
    return text.length > MAX_TABLE_RESULT_CHARS ? text.slice(0, MAX_TABLE_RESULT_CHARS) + "\n[cut: ask for fewer rows or columns]" : text;
}

// Runs one query over every row of an attached sheet. Exposed for tests.
function runTableQuery(entry, args) {
    const table = findSheet(entry, args.sheet);
    if (!table) return `No sheet "${args.sheet}" in ${entry.name}. Sheets: ${(entry.sheets || []).map(s => s.name).join(", ")}.`;
    const filters = [];
    for (const f of Array.isArray(args.filters) ? args.filters : []) {
        const index = findColumn(table, f?.column);
        if (index < 0) return `No column "${f?.column}" in sheet "${table.name}". Columns: ${table.columns.join(", ")}.`;
        filters.push({ index, op: String(f.op || "="), value: f.value });
    }
    const rows = filters.length ? table.rows.filter(r => rowMatches(r, filters)) : table.rows;
    const header = `Sheet "${table.name}": ${rows.length.toLocaleString("en-US")} of ${table.rows.length.toLocaleString("en-US")} rows match.`;
    const action = String(args.action || "rows");
    const pick = (args.columns || []).map(c => [c, findColumn(table, c)]);
    const missing = pick.find(([, i]) => i < 0);
    if (missing) return `No column "${missing[0]}" in sheet "${table.name}". Columns: ${table.columns.join(", ")}.`;

    if (action === "columns") return `${header}\nColumns: ${describeColumns({ ...table, rows }).join("; ")}`;

    if (action === "stats") {
        const indexes = pick.length ? pick.map(([, i]) => i) : table.columns.map((_, i) => i);
        const lines = indexes.map(i => {
            const values = rows.map(r => r[i]).filter(v => v !== "" && v !== undefined);
            const numeric = values.filter(isNumberLike).length >= values.length * 0.9 && values.length;
            if (!numeric) return `${table.columns[i]}: ${values.length} filled, ${new Set(values).size} different values`;
            return `${table.columns[i]}: count ${values.length}, sum ${roundNice(aggregate(values, "sum"))}, average ${roundNice(aggregate(values, "avg"))}, median ${roundNice(aggregate(values, "median"))}, min ${roundNice(aggregate(values, "min"))}, max ${roundNice(aggregate(values, "max"))}`;
        });
        return clipResult(`${header}\n${lines.join("\n")}`);
    }

    if (action === "group") {
        const groupIndex = findColumn(table, args.group_by);
        if (groupIndex < 0) return `group needs group_by, one of: ${table.columns.join(", ")}.`;
        const how = String(args.aggregate || "count");
        const valueIndex = how === "count" ? groupIndex : findColumn(table, args.value_column);
        if (valueIndex < 0) return `${how} needs value_column, one of: ${table.columns.join(", ")}.`;
        const groups = new Map();
        for (const r of rows) {
            const key = r[groupIndex] ?? "";
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(r[valueIndex]);
        }
        let out = [...groups].map(([key, values]) => [key, aggregate(values, how), values.length]);
        out.sort((a, b) => args.descending === false ? a[1] - b[1] : b[1] - a[1]);
        const limit = Math.min(Math.max(1, Number(args.limit) || 50), 500);
        const label = how === "count" ? "rows" : `${how} of ${table.columns[valueIndex]}`;
        return clipResult(`${header} ${groups.size} groups by ${table.columns[groupIndex]}${groups.size > limit ? `, top ${limit} shown` : ""}.\n`
            + tableToCsv([table.columns[groupIndex], label, "rows"], out.slice(0, limit).map(([k, v, n]) => [k, roundNice(v), n])));
    }

    if (action === "search") {
        const query = String(args.query || "").toLowerCase();
        if (!query) return "search needs query.";
        const hits = rows.map((r, i) => [i, r]).filter(([, r]) => r.some(v => String(v).toLowerCase().includes(query)));
        const limit = Math.min(Math.max(1, Number(args.limit) || 30), 200);
        return clipResult(`${header} ${hits.length} contain "${args.query}"${hits.length > limit ? `, first ${limit} shown` : ""}.\n`
            + tableToCsv(table.columns, hits.slice(0, limit).map(([, r]) => r)));
    }

    // rows: sorted, sliced, chosen columns
    let list = rows;
    if (args.sort_by !== undefined) {
        const sortIndex = findColumn(table, args.sort_by);
        if (sortIndex < 0) return `No column "${args.sort_by}" to sort by. Columns: ${table.columns.join(", ")}.`;
        const desc = Boolean(args.descending);
        list = rows.slice().sort((x, y) => {
            const a = toNumber(x[sortIndex]), b = toNumber(y[sortIndex]);
            const cmp = !Number.isNaN(a) && !Number.isNaN(b) ? a - b : String(x[sortIndex]).localeCompare(String(y[sortIndex]));
            return desc ? -cmp : cmp;
        });
    }
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.min(Math.max(1, Number(args.limit) || 50), 500);
    const indexes = pick.length ? pick.map(([, i]) => i) : table.columns.map((_, i) => i);
    const slice = list.slice(offset, offset + limit).map(r => indexes.map(i => r[i]));
    const more = offset + limit < list.length ? `\n[Rows ${offset + 1}-${offset + slice.length} of ${list.length}. Pass offset ${offset + limit} for more, only if you need them.]` : "";
    return clipResult(`${header}\n${tableToCsv(indexes.map(i => table.columns[i]), slice)}${more}`);
}

// ---------- read_attachment ----------

function parsePageRange(pages) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(String(pages || ""));
    if (!match) return null;
    const from = Number(match[1]);
    return [from, Math.max(from, Number(match[2] || match[1]))];
}

// Exposed for tests.
function readAttachmentText(entry, args) {
    const text = entry.text || "";
    if (!text) {
        if (entry.sheets) return `${entry.name} is a spreadsheet: use query_table with name "${entry.name}".`;
        return `${entry.name} has no text to read.`;
    }
    if (args.query) {
        const words = String(args.query).toLowerCase().split(/\s+/).filter(w => w.length > 1);
        const lower = text.toLowerCase();
        const hits = [];
        const phrase = String(args.query).toLowerCase().trim();
        let at = lower.indexOf(phrase);
        while (at >= 0 && hits.length < 40) { hits.push(at); at = lower.indexOf(phrase, at + phrase.length); }
        if (!hits.length && words.length > 1) {
            // No exact phrase: paragraphs with the most of the words.
            const paragraphs = [];
            const re = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g;
            let m;
            while ((m = re.exec(text))) {
                const p = m[0].toLowerCase();
                const score = words.filter(w => p.includes(w)).length;
                if (score >= Math.ceil(words.length / 2)) paragraphs.push([score, m.index]);
            }
            paragraphs.sort((a, b) => b[0] - a[0]).slice(0, 20).forEach(([, index]) => hits.push(index));
            hits.sort((a, b) => a - b);
        }
        if (!hits.length) return `"${args.query}" isn't in ${entry.name}. Try other words, or read it by pages.`;
        const pageOf = index => { const before = text.lastIndexOf("--- Page ", index); return before >= 0 ? (/--- Page (\d+)/.exec(text.slice(before, before + 20)) || [])[1] : null; };
        const out = [];
        let shownTo = -1, used = 0;
        for (const index of hits) {
            const start = Math.max(index - 400, shownTo), end = Math.min(text.length, index + 600);
            if (end <= start) continue;
            const page = pageOf(index);
            const piece = `${page ? `[page ${page}] ` : ""}…${text.slice(start, end).replace(/\s+/g, " ")}…`;
            if (used + piece.length > READ_CHUNK_CHARS) break;
            out.push(piece); used += piece.length; shownTo = end;
        }
        return `${hits.length} place(s) in ${entry.name} match "${args.query}"${out.length < hits.length ? `, ${out.length} shown` : ""}:\n\n${out.join("\n\n")}`;
    }
    let start = Math.max(0, Number(args.start) || 0);
    let end;
    const range = parsePageRange(args.pages);
    if (range) {
        const from = text.indexOf(`--- Page ${range[0]} ---`);
        if (from < 0) return `${entry.name} has no page ${range[0]}${entry.pageCount ? ` (it has ${entry.pageCount})` : ""}.`;
        const after = text.indexOf(`--- Page ${range[1] + 1} ---`);
        start = from;
        end = Math.min(after < 0 ? text.length : after, from + READ_CHUNK_CHARS * 2);
    } else {
        end = Math.min(text.length, start + READ_CHUNK_CHARS);
    }
    const more = end < text.length ? `\n\n[Characters ${start}-${end} of ${text.length}. Pass start ${end} (or later pages) for more, only if you need them.]` : "\n\n[End of the file.]";
    return text.slice(start, end) + more;
}

// ---------- Kept attachments (per chat, IndexedDB) ----------

const keptAttachments = new Map();   // key -> entry, this page's copy

function mediaStore(store, mode, work) {
    return new Promise(resolve => {
        try {
            const open = indexedDB.open("codev-media", 1);
            open.onupgradeneeded = () => {
                open.result.createObjectStore("attachments", { keyPath: "key" }).createIndex("sessionId", "sessionId");
                open.result.createObjectStore("images", { keyPath: "id" });
            };
            open.onerror = () => resolve(null);
            open.onsuccess = () => {
                const tx = open.result.transaction(store, mode);
                const request = work(tx.objectStore(store));
                tx.oncomplete = () => resolve(request ? request.result ?? null : true);
                tx.onerror = tx.onabort = () => resolve(null);
            };
        } catch (err) { resolve(null); }
    });
}

// Files sent in a chat: their full text or rows, for read_attachment and query_table.
async function keepAttachmentsForChat(sessionId, attachments) {
    for (const att of attachments) {
        if (!att.fullText && !att.sheets) continue;
        const entry = { key: `${sessionId}:${att.name}`, sessionId, name: att.name, kind: att.kind, text: att.fullText || "", sheets: att.sheets || null, pageCount: att.pageCount || 0, at: Date.now() };
        keptAttachments.set(entry.key, entry);
        await mediaStore("attachments", "readwrite", store => store.put(entry));
    }
    // Only the newest MAX_KEPT_ATTACHMENTS stay. Their keys and times are listed in
    // localStorage, so this never has to load the files themselves.
    let index = [];
    try { index = JSON.parse(localStorage.getItem("codev_kept_attachments") || "[]"); } catch (err) { /* start over */ }
    const sent = new Set(attachments.filter(a => a.fullText || a.sheets).map(a => `${sessionId}:${a.name}`));
    index = index.filter(e => !sent.has(e.key)).concat([...sent].map(key => ({ key, at: Date.now() })));
    const old = index.slice(0, Math.max(0, index.length - MAX_KEPT_ATTACHMENTS));
    if (old.length) {
        await mediaStore("attachments", "readwrite", store => { old.forEach(e => store.delete(e.key)); return null; });
        old.forEach(e => keptAttachments.delete(e.key));
    }
    try { localStorage.setItem("codev_kept_attachments", JSON.stringify(index.slice(old.length))); } catch (err) { /* pruned next time */ }
}

async function chatAttachments(sessionId) {
    const found = await mediaStore("attachments", "readonly", store => store.index("sessionId").getAll(sessionId));
    const list = Array.isArray(found) ? found : [];
    for (const entry of keptAttachments.values()) if (entry.sessionId === sessionId && !list.some(e => e.key === entry.key)) list.push(entry);
    return list.sort((a, b) => a.at - b.at);
}

function pickAttachment(list, name, want) {
    const usable = list.filter(want);
    if (!usable.length) return null;
    if (!name) return usable[usable.length - 1];
    const wanted = String(name).toLowerCase();
    return usable.find(e => e.name.toLowerCase() === wanted) || usable.find(e => e.name.toLowerCase().includes(wanted)) || null;
}

// ---------- Gemini (video, audio, scanned PDFs, images) ----------

function hasGeminiKey() { return GEMINI_KEY_PATTERN.test(geminiKey); }

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
        reader.onerror = () => reject(reader.error || new Error("couldn't read the file"));
        reader.readAsDataURL(blob);
    });
}

async function geminiRequest(path, body) {
    let response;
    try {
        response = await fetch(`${GEMINI_API}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
            body: JSON.stringify(body)
        });
    } catch (err) {
        throw new Error(`couldn't reach Gemini at generativelanguage.googleapis.com (${err.message})`);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = data.error?.message || `HTTP ${response.status}`;
        if (response.status === 400 && /api key/i.test(message) || response.status === 401 || response.status === 403) {
            throw new Error(`Gemini rejected the API key (${message}). Check it in Settings > Images, video & big files`);
        }
        if (response.status === 429) throw new Error(`Gemini's free limit is used up for now (${message}). Try again later`);
        const error = new Error(`Gemini answered ${response.status}: ${message}`);
        error.status = response.status;
        throw error;
    }
    return data;
}

// Every output block of one kind from an Interactions API reply.
function geminiOutputs(data, type) {
    const blocks = [];
    for (const step of data.steps || data.outputs || []) {
        if (step.type && step.type !== "model_output" && step.type !== type) continue;
        if (step.type === type) blocks.push(step);
        for (const part of step.content || []) if (part.type === type) blocks.push(part);
    }
    if (type === "image" && data.output_image?.data) blocks.push(data.output_image);
    return blocks;
}

async function geminiAsk(input, model = GEMINI_MEDIA_MODEL) {
    const data = await geminiRequest("/v1beta/interactions", { model, input, store: false });
    const text = geminiOutputs(data, "text").map(p => p.text || "").join("").trim();
    if (!text) throw new Error(`Gemini returned no text${data.status && data.status !== "completed" ? ` (status ${data.status})` : ""}`);
    return text;
}

// Gemini's Files API, for media too big to send inline. Returns the file's uri.
async function geminiUpload(file, mimeType, onProgress) {
    let start;
    try {
        start = await fetch(`${GEMINI_API}/upload/v1beta/files`, {
            method: "POST",
            headers: {
                "x-goog-api-key": geminiKey, "Content-Type": "application/json",
                "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
                "X-Goog-Upload-Header-Content-Length": String(file.size), "X-Goog-Upload-Header-Content-Type": mimeType
            },
            body: JSON.stringify({ file: { display_name: file.name } })
        });
    } catch (err) { throw new Error(`couldn't reach Gemini to upload (${err.message})`); }
    const uploadUrl = start.headers.get("x-goog-upload-url");
    if (!start.ok || !uploadUrl) throw new Error(`Gemini didn't accept the upload (HTTP ${start.status})`);
    if (onProgress) onProgress("uploading to Gemini…");
    const done = await fetch(uploadUrl, { method: "POST", headers: { "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0" }, body: file });
    const data = await done.json().catch(() => ({}));
    if (!done.ok || !data.file) throw new Error(`the upload to Gemini failed (${data.error?.message || `HTTP ${done.status}`})`);
    let info = data.file;
    // Videos are processed before they can be used.
    for (let wait = 0; info.state === "PROCESSING" && wait < 90; wait++) {
        if (onProgress) onProgress("Gemini is processing the video…");
        await new Promise(r => setTimeout(r, 2000));
        const check = await fetch(`${GEMINI_API}/v1beta/${info.name}`, { headers: { "x-goog-api-key": geminiKey } });
        info = await check.json().catch(() => info);
    }
    if (info.state && info.state !== "ACTIVE") throw new Error(`Gemini couldn't process the file (state ${info.state})`);
    return info.uri;
}

async function geminiMediaPart(file, type, mimeType, onProgress) {
    if (file.size <= GEMINI_INLINE_BYTES) return { type, mime_type: mimeType, data: await blobToBase64(file) };
    return { type, mime_type: mimeType, uri: await geminiUpload(file, mimeType, onProgress) };
}

function mediaMimeType(file, kind) {
    if (file.type) return file.type;
    const ext = fileExtension(file.name).slice(1);
    if (kind === "video") return { mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm", avi: "video/x-msvideo" }[ext] || "video/mp4";
    return { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac", aac: "audio/aac", opus: "audio/ogg", weba: "audio/webm" }[ext] || "audio/mpeg";
}

// Groq Whisper (free tier) for a file's sound, when there's no Gemini key.
async function transcribeMediaWithWhisper(file) {
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("model", typeof WHISPER_MODEL === "string" ? WHISPER_MODEL : "whisper-large-v3-turbo");
    form.append("response_format", "json");
    let response;
    try {
        response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { "Authorization": `Bearer ${groqKey}` }, body: form });
    } catch (err) { throw new Error(`couldn't reach Groq (${err.message})`); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error?.message || `Groq returned HTTP ${response.status}`);
    return String(data.text || "").trim();
}

const VIDEO_PROMPT = "Watch this whole video, including its sound. Describe what happens in order with rough timestamps (m:ss), read any on-screen text, scores, names and numbers exactly, and transcribe what is said. Be factual and complete; don't guess at what you can't see or hear.";
const AUDIO_PROMPT = "Transcribe this audio in full, with rough timestamps (m:ss) every so often and speaker changes marked. Then add a short summary.";

// After the frames: the whole video with sound (Gemini), or its sound (Whisper).
// Never fails the attachment; a problem becomes a note the agent can pass on.
async function addVideoUnderstanding(file, att, duration) {
    const label = `the video's sound`;
    if (hasGeminiKey() && (!duration || duration <= MAX_GEMINI_VIDEO_SECONDS)) {
        try {
            att.status = "Gemini is watching it…";
            renderAttachmentTrayIfThere();
            const part = await geminiMediaPart(file, "video", mediaMimeType(file, "video"), note => { att.status = note; renderAttachmentTrayIfThere(); });
            const notes = await geminiAsk([part, { type: "text", text: VIDEO_PROMPT }]);
            att.text += `\n\n[Gemini watched the whole video with sound]\n${notes}`;
            att.fullText = att.text;
            att.watched = "Gemini";
            return;
        } catch (err) {
            att.text += `\n\n[Gemini couldn't watch the whole video: ${err.message}. Only the frames are available.]`;
            logMediaActivity(`[Video] Gemini couldn't watch ${file.name}: ${err.message}`);
        }
    }
    if (groqKey && file.size <= WHISPER_MAX_BYTES) {
        try {
            att.status = "transcribing its sound…";
            renderAttachmentTrayIfThere();
            const transcript = await transcribeMediaWithWhisper(file);
            att.text += transcript ? `\n\n[Transcript of ${label}, by Whisper]\n${transcript}` : "\n\n[The video has no speech Whisper could hear.]";
            att.watched = att.watched || "Whisper";
        } catch (err) {
            att.text += `\n\n[Couldn't transcribe ${label}: ${err.message}]`;
        }
    } else if (!hasGeminiKey()) {
        att.text += `\n\n[Sound not included. Adding a free Gemini key in Settings > Images, video & big files lets CoDev watch whole videos with sound.]`;
    }
}

async function prepareAudio(file, att) {
    let transcript = "";
    let by = "";
    if (hasGeminiKey()) {
        try {
            att.status = "Gemini is listening…";
            renderAttachmentTrayIfThere();
            transcript = await geminiAsk([await geminiMediaPart(file, "audio", mediaMimeType(file, "audio")), { type: "text", text: AUDIO_PROMPT }]);
            by = "Gemini";
        } catch (err) {
            logMediaActivity(`[Audio] Gemini couldn't listen to ${file.name}: ${err.message}`);
            if (!groqKey) throw err;
        }
    }
    if (!transcript && groqKey) {
        if (file.size > WHISPER_MAX_BYTES) throw new Error(`it's over 25 MB, Groq Whisper's limit. Add a free Gemini key in Settings to read longer audio`);
        att.status = "transcribing…";
        renderAttachmentTrayIfThere();
        transcript = await transcribeMediaWithWhisper(file);
        by = "Whisper";
    }
    if (!by) throw new Error("audio needs a Groq or Gemini key (both free) in Settings");
    describeLongText(att, `Audio "${file.name}", transcribed by ${by}`, transcript || "(no speech heard)");
}

// A scanned PDF (no text layer): Gemini reads every page when there's a key.
async function readScannedPdfWithGemini(file, att, pageCount) {
    if (!hasGeminiKey()) return false;
    try {
        att.status = "Gemini is reading the scanned pages…";
        renderAttachmentTrayIfThere();
        const part = await geminiMediaPart(file, "document", "application/pdf");
        const text = await geminiAsk([part, { type: "text", text: "Transcribe all the text in this scanned PDF, page by page. Start each page with a line \"--- Page N ---\". Keep tables as rows with | between cells. Don't summarize or skip anything." }]);
        att.pageCount = pageCount;
        describeLongText(att, `Scanned PDF "${file.name}" (${pageCount} pages, read by Gemini)`, text.startsWith("\n") ? text : `\n${text}`);
        return true;
    } catch (err) {
        logMediaActivity(`[PDF] Gemini couldn't read ${file.name}: ${err.message}`);
        return false;
    }
}

function renderAttachmentTrayIfThere() {
    if (typeof renderAttachmentTray === "function" && document.getElementById("attachmentTray")) renderAttachmentTray();
}

function logMediaActivity(text) {
    if (typeof logConsoleActivity === "function") logConsoleActivity(text); else console.log(text);
}

// ---------- Image making ----------

// Which service makes pictures right now, or null when it's off.
function imageService() {
    if (imageProvider === "off") return null;
    if (imageProvider === "gemini") return hasGeminiKey() ? "gemini" : null;
    if (imageProvider === "openrouter") return openRouterKey ? "openrouter" : null;
    // Automatic is the free service: a Gemini or OpenRouter key alone never starts paid pictures.
    return "free";
}

const IMAGE_SERVICE_NAMES = { gemini: "Gemini (Nano Banana)", openrouter: "OpenRouter", free: "Pollinations (free)" };

function imageUsageToday() {
    try {
        const saved = JSON.parse(localStorage.getItem("codev_image_usage") || "{}");
        return saved.day === new Date().toDateString() ? saved : { day: new Date().toDateString(), count: 0, cost: 0 };
    } catch (err) { return { day: new Date().toDateString(), count: 0, cost: 0 }; }
}

function countImageMade(cost) {
    const usage = imageUsageToday();
    usage.count++;
    usage.cost = Math.round(((usage.cost || 0) + (cost || 0)) * 10000) / 10000;
    try { localStorage.setItem("codev_image_usage", JSON.stringify(usage)); } catch (err) { /* not counted */ }
    return usage;
}

const ASPECT_SIZES = { "1:1": [1024, 1024], "16:9": [1344, 768], "9:16": [768, 1344], "4:3": [1152, 864], "3:4": [864, 1152], "3:2": [1216, 832], "2:3": [832, 1216] };

function dataUrlParts(url) {
    const match = /^data:([^;,]+);base64,(.*)$/.exec(url);
    return match ? { mimeType: match[1], data: match[2] } : null;
}

async function makeImageWithGemini(prompt, aspect, references) {
    const model = GEMINI_IMAGE_MODELS[geminiImageQuality] || GEMINI_IMAGE_MODELS.lite;
    const input = [...references.map(url => dataUrlParts(url)).filter(Boolean).map(p => ({ type: "image", mime_type: p.mimeType, data: p.data })),
        { type: "text", text: prompt }];
    const body = { model, input, store: false };
    if (aspect) body.response_format = { type: "image", aspect_ratio: aspect };
    let data;
    try {
        data = await geminiRequest("/v1beta/interactions", body);
    } catch (err) {
        if (err.status !== 400 || !aspect) throw err;
        // An older model without aspect_ratio: ask for it in words instead.
        data = await geminiRequest("/v1beta/interactions", { model, input: [...input.slice(0, -1), { type: "text", text: `${prompt}\n\nAspect ratio ${aspect}.` }], store: false });
    }
    const image = geminiOutputs(data, "image").find(p => p.data);
    if (!image) {
        const said = geminiOutputs(data, "text").map(p => p.text).join(" ").trim();
        throw new Error(`Gemini made no image${said ? `: ${said.slice(0, 300)}` : " (it may have declined the prompt)"}`);
    }
    return { url: `data:${image.mime_type || image.mimeType || "image/png"};base64,${image.data}`, model, cost: null };
}

async function makeImageWithOpenRouter(prompt, aspect, references) {
    const body = { model: openRouterImageModel, prompt, n: 1 };
    if (aspect) body.aspect_ratio = aspect;
    if (references.length) body.input_references = references;
    let response;
    try {
        response = await fetch("https://openrouter.ai/api/v1/images", {
            method: "POST",
            headers: { "Authorization": `Bearer ${openRouterKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://github.com/phillbennett021423/CoDev_cloud", "X-Title": "CoDev Studio" },
            body: JSON.stringify(body)
        });
    } catch (err) { throw new Error(`couldn't reach OpenRouter (${err.message})`); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`OpenRouter answered ${response.status}: ${data.error?.message || "no image"}`);
    const first = (data.data || [])[0];
    if (!first) throw new Error("OpenRouter returned no image");
    const url = first.b64_json ? `data:${first.media_type || "image/png"};base64,${first.b64_json}` : first.url;
    return { url, model: openRouterImageModel, cost: Number(data.usage?.cost) || null };
}

async function makeImageWithPollinations(prompt, aspect) {
    const [width, height] = ASPECT_SIZES[aspect] || ASPECT_SIZES["1:1"];
    const url = `${POLLINATIONS_URL}${encodeURIComponent(prompt.slice(0, 1500))}?model=flux&width=${width}&height=${height}&nologo=true&private=true&referrer=codev-studio&seed=${Math.floor(Math.random() * 1e9)}`;
    let response;
    for (let attempt = 0; ; attempt++) {
        try { response = await fetch(url); } catch (err) { throw new Error(`couldn't reach the free image service at image.pollinations.ai (${err.message})`); }
        // Its free limit (402 or 429): wait as long as it asks, once, rather than fail a second picture.
        if (attempt > 0 || (response.status !== 402 && response.status !== 429)) break;
        const wait = Math.min(POLLINATIONS_RETRY_MAX_SECONDS, Math.max(1, Number(response.headers.get("retry-after")) || 20));
        logMediaActivity(`[Images] The free image service asked to wait ${wait}s; trying again then.`);
        await new Promise(resolve => setTimeout(resolve, wait * 1000));
    }
    if (!response.ok) throw new Error(`the free image service answered ${response.status}${response.status === 402 || response.status === 429 ? " (its free limit is about one picture every 45 seconds: try again in a minute)" : ""}`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error("the free image service didn't return a picture");
    return { url: `data:${blob.type};base64,${await blobToBase64(blob)}`, model: "pollinations", cost: 0 };
}

function shrinkDataUrl(url, maxEdge, quality = 0.8) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.onerror = () => resolve("");
        img.src = url;
    });
}

// Makes one picture and keeps it. Returns what the reply shows and the model hears.
async function generateImageForTask(args, ctx) {
    const prompt = String(args.prompt || "").trim();
    if (!prompt) return "generate_image needs a prompt describing the picture.";
    const service = imageService();
    if (!service) {
        return imageProvider === "off"
            ? "Image making is turned off in Settings > Images, video & big files. Tell the user they can turn it on there."
            : `Image making is set to ${imageProvider === "gemini" ? "Gemini" : "OpenRouter"}, but there's no ${imageProvider === "gemini" ? "Gemini" : "OpenRouter"} key. Tell the user to add one in Settings > Images, video & big files, or pick the free service.`;
    }
    ctx.generatedImages = ctx.generatedImages || [];
    if (ctx.generatedImages.length >= MAX_IMAGES_PER_TASK) return `Not made: ${MAX_IMAGES_PER_TASK} pictures is the limit for one task, to keep usage down. Show the user what you made and ask before making more.`;
    const usage = imageUsageToday();
    if (usage.count >= dailyImageLimit) return `Not made: today's limit of ${dailyImageLimit} pictures is reached (Settings > Images, video & big files changes it). Tell the user.`;
    const aspect = ASPECT_SIZES[args.aspect_ratio] ? args.aspect_ratio : "";
    const references = args.edit_attached_images && Array.isArray(ctx.attachedImages) ? ctx.attachedImages.slice(0, 3) : [];
    if (args.edit_attached_images && !references.length) return "There are no attached pictures in this message to edit. Make a new one without edit_attached_images, or ask the user to attach the picture.";
    if (references.length && service === "free") return "The free image service can't edit pictures. Tell the user that editing an attached picture needs Gemini or OpenRouter picked under Make pictures with in Settings > Images, video & big files, and that both cost money (Gemini's free tier has no image models).";
    if (ctx.onStep) ctx.onStep(`🎨 Making a picture with ${IMAGE_SERVICE_NAMES[service]}…`);
    let made;
    try {
        made = service === "gemini" ? await makeImageWithGemini(prompt, aspect, references)
            : service === "openrouter" ? await makeImageWithOpenRouter(prompt, aspect, references)
            : await makeImageWithPollinations(prompt, aspect);
    } catch (err) {
        return `Error: the picture couldn't be made: ${err.message}.`;
    }
    const today = countImageMade(made.cost);
    const id = `img_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const thumb = await shrinkDataUrl(made.url, 360, 0.78);
    await mediaStore("images", "readwrite", store => store.put({ id, url: made.url, prompt, model: made.model, at: Date.now() }));
    const name = `${prompt.replace(/[^\w ]+/g, "").trim().split(/\s+/).slice(0, 5).join("-").toLowerCase() || "picture"}.${/png/.test(made.url.slice(5, 20)) ? "png" : "jpg"}`;
    ctx.generatedImages.push({ name, kind: "image", thumb, generatedId: id, fullUrl: made.url });
    logMediaActivity(`[Images] Made "${name}" with ${made.model}${made.cost ? ` ($${made.cost.toFixed(3)})` : ""}. Today: ${today.count} of ${dailyImageLimit}${today.cost ? `, about $${today.cost.toFixed(2)}` : ""}.`);
    return `Made the picture "${name}" with ${IMAGE_SERVICE_NAMES[service]}; it is shown to the user with your reply. Don't paste links or data for it. In your reply, say briefly what you made${service === "free" ? " (with the free image service)" : ""}.`;
}

async function loadGeneratedImage(id) {
    const saved = await mediaStore("images", "readonly", store => store.get(id));
    return saved && saved.url ? saved : null;
}

// Full-size view of a made picture, with a download button.
async function openGeneratedImage(id) {
    const saved = await loadGeneratedImage(id);
    const existing = document.getElementById("generatedImageViewer");
    if (existing) existing.remove();
    const viewer = document.createElement("div");
    viewer.id = "generatedImageViewer";
    viewer.className = "generated-viewer";
    viewer.onclick = event => { if (event.target === viewer) viewer.remove(); };
    const box = document.createElement("div");
    box.className = "generated-viewer-box";
    if (!saved) {
        box.textContent = "This picture is no longer saved on this device.";
    } else {
        const img = document.createElement("img");
        img.src = saved.url;
        img.alt = saved.prompt;
        const caption = document.createElement("div");
        caption.className = "generated-viewer-caption";
        caption.textContent = saved.prompt;
        const download = document.createElement("a");
        download.href = saved.url;
        download.download = `codev-${id}.${/png/.test(saved.url.slice(5, 20)) ? "png" : "jpg"}`;
        download.textContent = "⬇ Download";
        download.className = "btn-secondary";
        box.append(img, caption, download);
    }
    const close = document.createElement("button");
    close.textContent = "✕";
    close.className = "generated-viewer-close";
    close.title = "Close";
    close.onclick = () => viewer.remove();
    box.prepend(close);
    viewer.appendChild(box);
    document.body.appendChild(viewer);
}

// ---------- The agents' tools ----------

async function buildMediaTools(ctx) {
    const tools = [];
    const sessionId = ctx?.sessionId;
    const files = sessionId ? await chatAttachments(sessionId) : [];
    const textFiles = files.filter(f => f.text);
    const sheetFiles = files.filter(f => f.sheets);
    if (textFiles.length) tools.push({
        name: "read_attachment",
        description: `Read more of a long file the user attached in this chat (PDFs, text files, transcripts). Attached here: ${textFiles.map(f => `"${f.name}"`).join(", ")}. `
            + "Pass pages (like \"12-15\") to read pages of a PDF, query to find every passage that mentions something (with page numbers), or start for the next part. Returns about 12,000 characters at a time.",
        inputSchema: { type: "object", properties: {
            name: { type: "string", description: "The file's name. Leave it out for the latest one." },
            pages: { type: "string", description: "Optional: a page or range of a PDF, like \"7\" or \"40-45\"." },
            query: { type: "string", description: "Optional: words or a phrase to find." },
            start: { type: "integer", description: "Optional: the character to read from." }
        } },
        run: async args => {
            const entry = pickAttachment(await chatAttachments(sessionId), args.name, f => f.text);
            return entry ? readAttachmentText(entry, args) : `No attached file named "${args.name}". Files: ${textFiles.map(f => f.name).join(", ")}.`;
        }
    });
    if (sheetFiles.length) tools.push({
        name: "query_table",
        description: `Run exact math over every row of a spreadsheet the user attached in this chat: ${sheetFiles.map(f => `"${f.name}" (sheets: ${f.sheets.map(s => `${s.name}: ${s.columns.slice(0, 25).join(", ")}`).join(" | ")})`).join("; ")}. `
            + "action rows lists rows (filter, sort, columns, offset, limit); stats gives count, sum, average, median, min and max of columns; group totals a column per value of another (like points per team); search finds rows containing text; columns describes every column. Filters apply to every action. Use this for any number from the data instead of estimating.",
        inputSchema: { type: "object", properties: {
            name: { type: "string", description: "The file's name. Leave it out for the latest one." },
            sheet: { type: "string", description: "Optional: the sheet's name, for a workbook with several." },
            action: { type: "string", enum: ["rows", "stats", "group", "search", "columns"] },
            filters: { type: "array", description: "Optional: rows must match all of these.", items: { type: "object", properties: {
                column: { type: "string" }, op: { type: "string", enum: ["=", "!=", ">", ">=", "<", "<=", "contains", "not_contains", "empty", "not_empty"] }, value: { type: "string" } }, required: ["column", "op"] } },
            columns: { type: "array", items: { type: "string" }, description: "Optional: columns to show (rows) or measure (stats)." },
            group_by: { type: "string", description: "group: the column to group by." },
            value_column: { type: "string", description: "group: the column to total (not needed for count)." },
            aggregate: { type: "string", enum: ["count", "sum", "avg", "min", "max", "median", "count_distinct"], description: "group: how to total each group. Default count." },
            sort_by: { type: "string", description: "rows: the column to sort by." },
            descending: { type: "boolean", description: "Sort largest first (group sorts largest first unless this is false)." },
            query: { type: "string", description: "search: the text to find." },
            offset: { type: "integer" },
            limit: { type: "integer", description: "How many rows or groups to return (default 50)." }
        }, required: ["action"] },
        run: async args => {
            const entry = pickAttachment(await chatAttachments(sessionId), args.name, f => f.sheets);
            return entry ? runTableQuery(entry, args) : `No attached spreadsheet named "${args.name}". Spreadsheets: ${sheetFiles.map(f => f.name).join(", ")}.`;
        }
    });
    const service = imageService();
    if (service) tools.push({
        name: "generate_image",
        description: `Make a picture (illustration, photo-style image, logo, icon, diagram-like art, concept art) from a description, using ${IMAGE_SERVICE_NAMES[service]}. `
            + "Only call it when the user asks for a picture or image to be made or edited; it costs the user usage. Write a detailed prompt: subject, style, composition, colors, any text to show. "
            + `At most ${MAX_IMAGES_PER_TASK} per task.` + (service === "free" ? " The free service can't edit attached pictures." : " Set edit_attached_images to change the pictures the user attached to this message."),
        inputSchema: { type: "object", properties: {
            prompt: { type: "string", description: "A detailed description of the picture, or of the change to make to the attached picture." },
            aspect_ratio: { type: "string", enum: Object.keys(ASPECT_SIZES), description: "Optional: the shape. Default 1:1." },
            edit_attached_images: { type: "boolean", description: "Optional: true to edit or build on the pictures attached to this message." }
        }, required: ["prompt"] },
        run: async (args, toolCtx) => generateImageForTask(args, toolCtx || ctx)
    });
    return tools;
}

// ---------- Settings ----------

function fillMediaSettings() {
    const set = (id, value) => { const el = document.getElementById(id); if (el) el[typeof value === "boolean" ? "checked" : "value"] = value; };
    set("modalGeminiKey", geminiKey);
    set("modalImageProvider", imageProvider === "free" ? "auto" : imageProvider);
    set("modalImageQuality", geminiImageQuality);
    set("modalOpenRouterImageModel", openRouterImageModel);
    set("modalDailyImageLimit", String(dailyImageLimit));
    updateMediaStatus();
}

function updateMediaStatus() {
    const status = document.getElementById("mediaStatus");
    if (!status) return;
    const service = imageService();
    const usage = imageUsageToday();
    status.textContent = [
        `Pictures: ${service ? IMAGE_SERVICE_NAMES[service] : "off"}. Made today: ${usage.count} of ${dailyImageLimit}${usage.cost ? ` (about $${usage.cost.toFixed(2)})` : ""}.`,
        `Videos: ${hasGeminiKey() ? "Gemini watches the whole video with sound" : groqKey ? "frames, plus the sound transcribed by Groq Whisper (up to 25 MB)" : "frames only (add a Gemini or Groq key for sound)"}.`,
        `Audio files: ${hasGeminiKey() ? "Gemini" : groqKey ? "Groq Whisper (up to 25 MB)" : "need a Gemini or Groq key"}. Long PDFs and spreadsheets: always on, no key needed.`
    ].join("\n");
}

// Returns an error message, or "" when saved.
function saveMediaSettings() {
    const value = id => String(document.getElementById(id)?.value || "").trim();
    const newKey = value("modalGeminiKey").replace(/[\s​-‍﻿"'`]+/g, "");
    if (newKey && !GEMINI_KEY_PATTERN.test(newKey)) return "That doesn't look like a Gemini API key (they start with AIza). Copy it again from aistudio.google.com/apikey.";
    geminiKey = newKey;
    imageProvider = ["auto", "gemini", "openrouter", "free", "off"].includes(value("modalImageProvider")) ? value("modalImageProvider") : "auto";
    geminiImageQuality = GEMINI_IMAGE_MODELS[value("modalImageQuality")] ? value("modalImageQuality") : "lite";
    openRouterImageModel = value("modalOpenRouterImageModel") || DEFAULT_OPENROUTER_IMAGE_MODEL;
    dailyImageLimit = Math.max(0, Math.min(500, Math.round(Number(value("modalDailyImageLimit")) || DEFAULT_DAILY_IMAGE_LIMIT)));
    localStorage.setItem("codev_gemini_key", geminiKey);
    localStorage.setItem("codev_image_provider", imageProvider);
    localStorage.setItem("codev_image_quality", geminiImageQuality);
    localStorage.setItem("codev_openrouter_image_model", openRouterImageModel);
    localStorage.setItem("codev_daily_image_limit", String(dailyImageLimit));
    updateMediaStatus();
    return "";
}
