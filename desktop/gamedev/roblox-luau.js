// Checking Roblox Luau before it reaches Studio: the real Luau compiler (luau-web, Luau
// built for WebAssembly, so it runs anywhere Node does with nothing to install) for syntax
// and compile errors, and CoDev's Roblox rules: the mistakes that make a Roblox game
// exploitable, lose player data, take players' Robux without granting the item, or use
// APIs Roblox has deprecated.
//
//   compileLuau(source, chunkName) -> Promise<{ ok, line, message }>
//   lintRoblox(files)              -> [{ file, line, severity, rule, message }]
//       files: [{ file, source, kind }], kind "server" | "client" | "module"
//   scriptKind(fileName)           -> "server" | "client" | "module"
//   stripLuau(source)              -> { code, noStrings } comments (and strings) blanked,
//                                     line breaks kept so line numbers still match
//
// The rules read code with comments removed, so commented-out code is never flagged.
// They are heuristics: an "error" is something that is almost always a real bug on
// Roblox, a "warning" something to look at. Only compile errors stop roblox_sync.

let statePromise = null;

// One Luau state is enough: loadstring compiles without running anything.
function luauState() {
    if (!statePromise) {
        statePromise = import('luau-web')
            .then(m => m.LuauState.createAsync({}))
            .catch(err => { statePromise = null; throw err; });
    }
    return statePromise;
}

async function compileLuau(source, chunkName = 'script') {
    const state = await luauState();
    const result = state.loadstring(String(source), String(chunkName), false);
    if (typeof result !== 'string') return { ok: true, line: 0, message: '' };
    const m = result.match(/^\[string "[^"]*"\]:(\d+): ([\s\S]*)$/);
    return { ok: false, line: m ? Number(m[1]) : 0, message: (m ? m[2] : result).trim() };
}

async function luauAvailable() {
    try { await luauState(); return true; } catch { return false; }
}

function scriptKind(fileName) {
    const name = String(fileName).split(/[\\/]/).pop().toLowerCase();
    if (/\.server\.(luau|lua)$/.test(name)) return 'server';
    if (/\.client\.(luau|lua)$/.test(name)) return 'client';
    return 'module';
}

// Comments become spaces; in noStrings, string contents do too. Newlines stay put.
function stripLuau(source) {
    const src = String(source);
    let code = '';
    let noStrings = '';
    const blank = s => s.replace(/[^\n]/g, ' ');
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '-' && src[i + 1] === '-') {
            const long = src.slice(i + 2).match(/^\[(=*)\[/);
            let end;
            if (long) {
                const close = `]${long[1]}]`;
                const at = src.indexOf(close, i + 2 + long[0].length);
                end = at < 0 ? src.length : at + close.length;
            } else {
                const nl = src.indexOf('\n', i);
                end = nl < 0 ? src.length : nl;
            }
            const gap = blank(src.slice(i, end));
            code += gap; noStrings += gap; i = end;
            continue;
        }
        if (c === '"' || c === '\'' || c === '`') {
            let j = i + 1;
            while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
            const end = Math.min(j + 1, src.length);
            const piece = src.slice(i, end);
            code += piece;
            noStrings += c + blank(piece.slice(1, -1)) + (piece.length > 1 ? piece[piece.length - 1] : '');
            i = end;
            continue;
        }
        if (c === '[') {
            const long = src.slice(i).match(/^\[(=*)\[/);
            if (long) {
                const close = `]${long[1]}]`;
                const at = src.indexOf(close, i + long[0].length);
                const end = at < 0 ? src.length : at + close.length;
                const piece = src.slice(i, end);
                code += piece;
                noStrings += long[0] + blank(piece.slice(long[0].length, piece.length - close.length)) + (at < 0 ? '' : close);
                i = end;
                continue;
            }
        }
        code += c; noStrings += c; i++;
    }
    return { code, noStrings };
}

const SERVER_ONLY = ['DataStoreService', 'ServerStorage', 'ServerScriptService', 'HttpService', 'MessagingService', 'MemoryStoreService'];
const NOT_GLOBAL = '(^|[^.:\\w])';

// Line rules: re is tested on the comment-free line (strings blanked when strings is false).
const LINE_RULES = [
    { rule: 'deprecated-wait', severity: 'warning', re: new RegExp(`${NOT_GLOBAL}wait\\s*\\(`), message: 'wait() is deprecated and throttled; use task.wait().' },
    { rule: 'deprecated-spawn', severity: 'warning', re: new RegExp(`${NOT_GLOBAL}(spawn|delay)\\s*\\(`), message: 'spawn() and delay() are deprecated; use task.spawn() and task.delay().' },
    { rule: 'loadstring', severity: 'error', re: new RegExp(`${NOT_GLOBAL}loadstring\\s*\\(`), message: 'loadstring is off on Roblox by default (and a security risk when on); use ModuleScripts instead.' },
    { rule: 'instance-new-parent', severity: 'warning', strings: true, re: /Instance\.new\s*\(\s*("[^"]*"|'[^']*')\s*,/, message: 'Instance.new(class, parent) is slow: set the properties first and Parent last.' },
    { rule: 'find-first-child-chain', severity: 'warning', strings: true, re: /:(FindFirstChild|FindFirstChildOfClass|FindFirstChildWhichIsA|FindFirstAncestor)\s*\([^()]*\)\s*[.:]\s*[A-Za-z_]/, message: 'FindFirstChild can return nil; check the result before indexing it (or use WaitForChild for things that load in).' },
    { rule: 'server-local-player', severity: 'error', kinds: ['server'], re: /\.LocalPlayer\b/, message: 'Players.LocalPlayer is nil in a server Script; use the player passed to the event (PlayerAdded, OnServerEvent).' },
    { rule: 'server-user-input', severity: 'error', kinds: ['server'], strings: true, re: /GetService\s*\(\s*["'](UserInputService|ContextActionService)["']/, message: 'Input services only work on the client; read input in a LocalScript and send it to the server with a RemoteEvent.' },
    { rule: 'client-server-only', severity: 'error', kinds: ['client'], strings: true, re: new RegExp(`GetService\\s*\\(\\s*["'](${SERVER_ONLY.join('|')})["']`), message: 'This service is server-only; a LocalScript can\'t use it. Do the work in a server Script and talk to it through a RemoteEvent or RemoteFunction.' },
    { rule: 'client-game-pass-check', severity: 'warning', kinds: ['client'], re: /:UserOwnsGamePassAsync\s*\(/, message: 'A client check of game pass ownership can be faked; grant the perk from a server Script that checks ownership itself.' },
    { rule: 'client-process-receipt', severity: 'error', kinds: ['client'], re: /\.ProcessReceipt\s*=/, message: 'ProcessReceipt only works in a server Script; set it there.' }
];

// Lines that call a DataStore and aren't inside a pcall within the last few lines.
const DATASTORE_CALL = /:(GetAsync|SetAsync|UpdateAsync|IncrementAsync|RemoveAsync)\s*\(/;
const REMOTE_HANDLER = /\.(OnServerEvent:Connect|OnServerInvoke\s*=)\s*\(?\s*function\s*\(\s*\w+\s*,\s*\w/;
const VALIDATES = /\b(typeof|type|tonumber|tostring|assert|math\.clamp|table\.find)\s*\(|\bif\s+not\b|~=\s*nil|==\s*nil|\.IsA\s*\(|:IsA\s*\(/;
const YIELDS = /\b(task\.wait|wait|coroutine\.yield)\s*\(|:Wait\s*\(|\b(Heartbeat|RenderStepped|Stepped|PreSimulation|PostSimulation)\b|\bbreak\b|\breturn\b/;

// How many blocks a line opens minus how many it closes. "while x do" and "for ... do"
// open one block (the do), "if ... then ... elseif ... then" one (the elseif's then is
// part of it), and repeat ... until is a block too.
function blockDelta(line) {
    const opens = (line.match(/\b(do|then|function|repeat)\b/g) || []).length - (line.match(/\belseif\b/g) || []).length;
    const closes = (line.match(/\b(end|until)\b/g) || []).length;
    return opens - closes;
}

function lintFile({ file, source, kind }) {
    const out = [];
    const { code, noStrings } = stripLuau(source);
    const lines = code.split('\n');
    const bare = noStrings.split('\n');
    const add = (line, severity, rule, message) => out.push({ file, line, severity, rule, message });
    // Block depth before each line, and the depths at which pcall(function() ... end) bodies opened.
    let depth = 0;
    let pcalls = [];
    for (let i = 0; i < lines.length; i++) {
        // pcall, or a retry helper (retry, withRetries...) that wraps the call in one.
        const insidePcall = pcalls.length > 0 || /\b(x?pcall|\w*[Rr]etr(y|ies)\w*)\s*\(/.test(bare[i]);
        if (/\b(x?pcall|\w*[Rr]etr(y|ies)\w*)\s*\([^)]*\bfunction\b/.test(bare[i])) pcalls.push(depth);
        depth += blockDelta(bare[i]);
        pcalls = pcalls.filter(d => depth > d);
        for (const r of LINE_RULES) {
            if (r.kinds && !r.kinds.includes(kind)) continue;
            if (r.re.test(r.strings ? lines[i] : bare[i])) add(i + 1, r.severity, r.rule, r.message);
        }
        if (DATASTORE_CALL.test(bare[i]) && !insidePcall) {
            add(i + 1, 'warning', 'datastore-pcall', 'DataStore calls fail and throttle at times; wrap each in pcall and retry, or player data is lost.');
        }
        if (REMOTE_HANDLER.test(bare[i]) && !VALIDATES.test(bare.slice(i, i + 12).join('\n'))) {
            add(i + 1, 'warning', 'remote-validation', 'Exploiters can send anything through a remote: check every argument\'s type and range (and rate-limit) before using it, and never trust prices or damage from the client.');
        }
        if (/^\s*while\s+(true|1)\s+do\b/.test(bare[i])) {
            const body = [];
            let depth = 0;
            let open = 0;
            for (let j = i; j < Math.min(lines.length, i + 200); j++) {
                open += blockDelta(bare[j]);
                body.push(bare[j]);
                if (j > i && open <= 0) break;
            }
            if (!YIELDS.test(body.join('\n'))) add(i + 1, 'error', 'loop-without-wait', 'This while-true loop never yields, so it freezes the game; add task.wait() (or wait on an event) inside it.');
        }
    }
    return out;
}

// Rules across the whole project: developer products need exactly one ProcessReceipt.
function lintProject(files, stripped) {
    const out = [];
    const prompts = [];
    const receipts = [];
    files.forEach((f, n) => {
        stripped[n].split('\n').forEach((line, i) => {
            if (/:PromptProductPurchase\s*\(/.test(line)) prompts.push({ file: f.file, line: i + 1 });
            if (/\.ProcessReceipt\s*=/.test(line) && f.kind !== 'client') receipts.push({ file: f.file, line: i + 1 });
        });
    });
    if (prompts.length && !receipts.length) {
        for (const p of prompts) out.push({ ...p, severity: 'error', rule: 'missing-process-receipt', message: 'This prompts a developer product purchase, but no server Script sets MarketplaceService.ProcessReceipt, so players would pay and get nothing. Add one that grants the item, saves it, and returns Enum.ProductPurchaseDecision.PurchaseGranted only after the save works.' });
    }
    if (receipts.length > 1) {
        for (const r of receipts.slice(1)) out.push({ ...r, severity: 'warning', rule: 'duplicate-process-receipt', message: 'ProcessReceipt is set in more than one place; only the last one runs. Handle every product in one callback.' });
    }
    return out;
}

function lintRoblox(files) {
    const list = files.map(f => ({ ...f, kind: f.kind || scriptKind(f.file) }));
    const stripped = list.map(f => stripLuau(f.source).noStrings);
    return [...list.flatMap(lintFile), ...lintProject(list, stripped)]
        .sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

module.exports = { compileLuau, luauAvailable, lintRoblox, scriptKind, stripLuau, SERVER_ONLY };
