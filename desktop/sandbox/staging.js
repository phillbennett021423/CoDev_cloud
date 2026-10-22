// Staging workspaces: a scratch copy of the project per agent workspace, where
// agents' file tools and containers write. Next to it sits a baseline copy of
// the project as it was staged, which is what the diff is taken against and
// what "is the real file still what the agent started from?" is checked
// against. Nothing in this file writes to the real project except applyFiles,
// which the review gate calls after the user approves.
//
// Hidden files and folders (.env, .git and anything else whose name starts with
// a dot) are left out everywhere: they're never copied into a workspace (so a
// container never sees them), listed, searched, read, written or applied.
//
// A project too big to copy (more than MAX_FILES files or MAX_TOTAL_BYTES) is
// staged on demand instead: the workspace and baseline start empty, a file is
// copied into both the first time an agent writes, edits or deletes it, and
// reads, listings and searches of untouched files go to the real project
// (read-only). The review is the same. Containers would see only the touched
// files, so commands don't run on such a project.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SKIPPED_DIRS = new Set(['.git', '.codev', 'node_modules', '__pycache__', '.godot', '.import', 'venv', '.venv', 'dist', 'build']);
const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const SYNC_INTERVAL_MS = 5000;
const MEASURE_CACHE_MS = 60000;

class StagingError extends Error {}

function sha(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readOrNull(file) {
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile()) return null;
        return fs.readFileSync(file);
    } catch { return null; }
}

function isBinary(buffer) {
    if (buffer.subarray(0, 8000).includes(0)) return true;
    try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); return false; } catch { return true; }
}

function toRel(root, full) {
    return path.relative(root, full).split(path.sep).join('/');
}

// Files that can hold API keys and secrets: hidden files and folders (.env, .git,
// anything starting with a dot), env files like production.env, key and
// certificate files, and secrets.* / credentials.*. They're never copied,
// listed, read or written. desktop/mcp-tools.js, the Python helper and the
// page use the same rule.
const SECRET_NAME = /^\.|\.(env|pem|key|pfx|p12|keystore|jks)$|^(secrets|credentials)\./i;

function isSecretName(name) {
    return name !== '.' && name !== '..' && SECRET_NAME.test(name);
}

function isHidden(rel) {
    return String(rel).split('/').some(isSecretName);
}

// Project-relative paths of regular files under dir (symlinks, hidden files and
// folders, and SKIPPED_DIRS left out).
function walk(dir, { limit = MAX_FILES * 4, onSymlink } = {}) {
    const found = [];
    const visit = current => {
        let entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (found.length >= limit) return;
            if (isSecretName(entry.name)) continue;
            const full = path.join(current, entry.name);
            if (entry.isSymbolicLink()) { if (onSymlink) onSymlink(toRel(dir, full)); continue; }
            if (entry.isDirectory()) { if (!SKIPPED_DIRS.has(entry.name)) visit(full); }
            else if (entry.isFile()) found.push(toRel(dir, full));
        }
    };
    visit(dir);
    return found;
}

// Resolves rel under root and refuses anything that leaves it, through ".."
// or through a symlink (an agent can make symlinks inside its container).
function containedPath(root, rel) {
    const clean = String(rel ?? '.').replace(/\\/g, '/');
    if (path.isAbsolute(clean) || /^[a-zA-Z]:/.test(clean)) throw new StagingError(`'${rel}' must be a path relative to the workspace`);
    const full = path.resolve(root, clean);
    const realRoot = fs.realpathSync(root);
    if (full !== root && !full.startsWith(root + path.sep)) throw new StagingError(`'${rel}' is outside the workspace`);
    // Walk up to the deepest part that exists and check where it really points.
    let probe = full;
    while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
    let real;
    try { real = fs.realpathSync(probe); } catch { real = probe; }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new StagingError(`'${rel}' leads outside the workspace (through a link)`);
    return full;
}

function writeAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.codev-${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, data);
    try { fs.renameSync(tmp, file); } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
}

// limits ({ maxFiles, maxTotalBytes }) override when a project counts as too big to copy (tests use it).
function createStaging({ getProjectDir, root, limits = {} } = {}) {
    const maxFiles = limits.maxFiles || MAX_FILES;
    const maxTotalBytes = limits.maxTotalBytes || MAX_TOTAL_BYTES;
    const baseDir = root || path.join(os.tmpdir(), 'codev-sandboxes');
    const workspaces = new Map();

    function projectDirOrThrow() {
        const dir = getProjectDir();
        if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            throw new StagingError('No project folder is chosen, so there is nothing to stage. Choose one in CoDev Settings.');
        }
        return path.resolve(dir);
    }

    // Whether the project fits a full copy: { large, reason?, files? } where files
    // are the [rel, size] pairs to copy. Cached briefly for the tool list.
    let measured = null;
    function measure(projectDir, { fresh = false } = {}) {
        if (!fresh && measured && measured.projectDir === projectDir && Date.now() - measured.at < MEASURE_CACHE_MS) return measured.result;
        const found = walk(projectDir, { limit: maxFiles + 1 });
        let result;
        if (found.length > maxFiles) {
            result = { large: true, reason: `it has more than ${maxFiles} files, not counting node_modules, .git, .godot, build and dist` };
        } else {
            const files = [];
            let total = 0;
            for (const rel of found) {
                let size;
                try { size = fs.statSync(path.join(projectDir, rel)).size; } catch { continue; }
                files.push([rel, size]);
                if (size <= MAX_FILE_BYTES) total += size;
            }
            result = total > maxTotalBytes
                ? { large: true, reason: `it is larger than ${Math.round(maxTotalBytes / 1024 / 1024)} MB` }
                : { large: false, files };
        }
        measured = { projectDir, at: Date.now(), result };
        return result;
    }

    // { large, reason } for the current project, or null when none is chosen.
    function projectSize() {
        const dir = getProjectDir();
        if (!dir || !fs.existsSync(dir)) return null;
        const { large, reason } = measure(path.resolve(dir));
        return { large, reason: reason || null };
    }

    // Copies the project into a new workspace and baseline, or sets up an
    // on-demand one for a large project.
    function create(id) {
        const projectDir = projectDirOrThrow();
        fs.mkdirSync(baseDir, { recursive: true });
        const dir = fs.mkdtempSync(path.join(baseDir, `${String(id).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 32) || 'ws'}-`));
        const ws = { id, dir, projectDir, work: path.join(dir, 'workspace'), base: path.join(dir, 'baseline'), stats: new Map(), skipped: [], createdAt: Date.now(), lastSync: Date.now(),
            lazy: false, largeReason: null, touched: new Set() };
        fs.mkdirSync(ws.work);
        fs.mkdirSync(ws.base);
        const size = measure(projectDir, { fresh: true });
        if (size.large) {
            ws.lazy = true;
            ws.largeReason = size.reason;
            workspaces.set(id, ws);
            return ws;
        }
        for (const [rel, bytes] of size.files) {
            const src = path.join(projectDir, rel);
            if (bytes > MAX_FILE_BYTES) { ws.skipped.push(rel); continue; }
            let stat;
            try { stat = fs.statSync(src); } catch { continue; }
            for (const target of [ws.work, ws.base]) {
                fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
                fs.copyFileSync(src, path.join(target, rel));
            }
            ws.stats.set(rel, `${stat.size}:${stat.mtimeMs}`);
        }
        workspaces.set(id, ws);
        return ws;
    }

    // Brings in edits the user made to the real project since staging, for every
    // file the agents haven't touched. Files they have touched are left alone;
    // the review flags those as conflicts.
    function sync(ws) {
        const projectDir = projectDirOrThrow();
        if (projectDir !== ws.projectDir) throw new StagingError('The project folder changed. Discard this sandbox and start again.');
        const seen = new Set();
        // An on-demand workspace only holds the files agents touched; the rest are read live.
        for (const rel of ws.lazy ? [...ws.touched] : walk(projectDir, { limit: MAX_FILES })) {
            let stat;
            try { stat = fs.statSync(path.join(projectDir, rel)); } catch { continue; }
            seen.add(rel);
            if (stat.size > MAX_FILE_BYTES) continue;
            const key = `${stat.size}:${stat.mtimeMs}`;
            if (ws.stats.get(rel) === key) continue;
            const real = readOrNull(path.join(projectDir, rel));
            const base = readOrNull(path.join(ws.base, rel));
            const work = readOrNull(path.join(ws.work, rel));
            const untouched = base === null ? work === null : (work !== null && base.equals(work));
            if (real && untouched) {
                writeAtomic(path.join(ws.base, rel), real);
                writeAtomic(path.join(ws.work, rel), real);
            }
            if (untouched) ws.stats.set(rel, key);
        }
        for (const rel of [...ws.stats.keys()]) {
            if (seen.has(rel)) continue;
            const base = readOrNull(path.join(ws.base, rel));
            const work = readOrNull(path.join(ws.work, rel));
            if (base && work && base.equals(work)) {
                fs.rmSync(path.join(ws.base, rel), { force: true });
                fs.rmSync(path.join(ws.work, rel), { force: true });
                ws.stats.delete(rel);
            }
        }
        ws.lastSync = Date.now();
    }

    // ON-DEMAND STAGING (large projects). In a fully copied workspace these just
    // resolve paths in the copy.

    // Hidden files and folders at any depth (.env, .git, CoDev's own .codev data
    // with other sandboxes' copies) are off limits for reading and writing.
    function refuseHidden(key, rel) {
        if (isHidden(key)) throw new StagingError(`'${rel}' is a hidden or secret file (like .env or a key file), which agents can't access`);
    }

    // Where to read rel from: the workspace copy, or the real project for a file
    // no agent has touched yet.
    function readPath(ws, rel) {
        const work = containedPath(ws.work, rel);
        const key = toRel(ws.work, work);
        refuseHidden(key, rel);
        if (!ws.lazy || ws.touched.has(key)) return work;
        return containedPath(ws.projectDir, rel);
    }

    // The workspace path to change rel at, copying the real file into the
    // workspace and baseline first if no agent has touched it yet.
    function prepareWrite(ws, rel) {
        const work = containedPath(ws.work, rel);
        const key = toRel(ws.work, work);
        refuseHidden(key, rel);
        if (!ws.lazy || ws.touched.has(key)) return work;
        if (!key) throw new StagingError(`'${rel}' is the project folder, not a file`);
        const realFile = containedPath(ws.projectDir, rel);
        let stat = null;
        try { stat = fs.lstatSync(realFile); } catch { /* a new file */ }
        if (stat && stat.isDirectory()) throw new StagingError(`'${rel}' is a folder`);
        if (stat && !stat.isFile()) throw new StagingError(`'${rel}' is a link or special file, which the sandbox doesn't stage`);
        if (stat && stat.size > MAX_FILE_BYTES) throw new StagingError(`'${rel}' is over ${MAX_FILE_BYTES / 1024 / 1024} MB, too big to stage`);
        if (stat) {
            const data = fs.readFileSync(realFile);
            writeAtomic(path.join(ws.base, key), data);
            writeAtomic(work, data);
            ws.stats.set(key, `${stat.size}:${stat.mtimeMs}`);
        }
        ws.touched.add(key);
        return work;
    }

    // Workspace-relative paths of the files under rel (a folder), as the agents
    // see them: the real project with the agents' changes on top.
    function listTree(ws, rel, limit) {
        const start = containedPath(ws.work, rel);
        const prefix = toRel(ws.work, start);
        refuseHidden(prefix, rel);
        const join = p => (prefix ? `${prefix}/${p}` : p);
        const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
        if (!ws.lazy) {
            if (!isDir(start)) throw new StagingError(`'${rel}' is not a folder`);
            return walk(start, { limit }).map(join);
        }
        const realStart = containedPath(ws.projectDir, rel);
        const inWork = isDir(start), inReal = isDir(realStart);
        if (!inWork && !inReal) throw new StagingError(`'${rel}' is not a folder`);
        const found = new Set();
        if (inReal) for (const p of walk(realStart, { limit })) if (!ws.touched.has(join(p))) found.add(join(p));
        if (inWork) for (const p of walk(start, { limit })) found.add(join(p));
        return [...found].sort().slice(0, limit);
    }

    function open(id) {
        const ws = workspaces.get(id);
        if (!ws) return create(id);
        if (Date.now() - ws.lastSync > SYNC_INTERVAL_MS) sync(ws);
        return ws;
    }

    function get(id) {
        const ws = workspaces.get(id);
        if (!ws) throw new StagingError(`No sandbox workspace "${id}". It may have been discarded.`);
        return ws;
    }

    // Every difference between the workspace and its baseline.
    function changes(id) {
        const ws = get(id);
        const symlinks = [];
        const work = new Set(walk(ws.work, { onSymlink: rel => symlinks.push(rel) }));
        const base = new Set(walk(ws.base));
        const out = [];
        for (const rel of new Set([...work, ...base])) {
            const before = base.has(rel) ? fs.readFileSync(path.join(ws.base, rel)) : null;
            const after = work.has(rel) ? fs.readFileSync(path.join(ws.work, rel)) : null;
            if (before && after && before.equals(after)) continue;
            const binary = Boolean((before && isBinary(before)) || (after && isBinary(after)));
            out.push({
                path: rel,
                status: before === null ? 'added' : after === null ? 'deleted' : 'modified',
                binary,
                oldText: before === null ? null : binary ? undefined : before.toString('utf8'),
                newText: after === null ? null : binary ? undefined : after.toString('utf8'),
                hash: after === null ? 'deleted' : sha(after),
                size: after ? after.length : 0
            });
        }
        for (const rel of symlinks) out.push({ path: rel, status: 'symlink', binary: false, oldText: null, newText: null, hash: 'symlink', size: 0 });
        return out.sort((a, b) => a.path.localeCompare(b.path));
    }

    // Writes approved files to the real project. Each file is checked again here:
    // it must be exactly what the user reviewed (stagedHash), and the real file
    // must still be what the agent started from, or the user's own newer edit
    // would be overwritten.
    function applyFiles(id, files) {
        const ws = get(id);
        const projectDir = projectDirOrThrow();
        if (projectDir !== ws.projectDir) throw new StagingError('The project folder changed since these files were staged.');
        const results = [];
        for (const { path: rel, hash } of files) {
            try {
                if (isHidden(String(rel).replace(/\\/g, '/'))) throw new StagingError('it is a hidden or secret file, which the sandbox never writes');
                const workFile = containedPath(ws.work, rel);
                const current = readOrNull(workFile);
                const currentHash = current === null ? 'deleted' : sha(current);
                if (currentHash !== hash) throw new StagingError('it changed in the sandbox after you reviewed it; review it again');
                const realFile = containedPath(projectDir, rel);
                let realStat = null;
                try { realStat = fs.lstatSync(realFile); } catch { /* doesn't exist */ }
                if (realStat && !realStat.isFile()) throw new StagingError('on disk it is a folder or link, not a file');
                const real = readOrNull(realFile);
                const base = readOrNull(path.join(ws.base, rel));
                const unchanged = base === null ? real === null : (real !== null && base.equals(real));
                if (!unchanged) throw new StagingError(base === null ? 'a file with this name now exists on disk' : 'the file on disk changed since the agent started; discard and run the task again');
                if (current === null) {
                    fs.rmSync(realFile, { force: true });
                    fs.rmSync(path.join(ws.base, rel), { force: true });
                    ws.stats.delete(rel);
                } else {
                    writeAtomic(realFile, current);
                    writeAtomic(path.join(ws.base, rel), current);
                    const stat = fs.statSync(realFile);
                    ws.stats.set(rel, `${stat.size}:${stat.mtimeMs}`);
                }
                results.push({ path: rel, applied: true });
            } catch (err) {
                results.push({ path: rel, applied: false, error: err.message });
            }
        }
        return results;
    }

    // Puts files in the workspace back to their baseline (the user rejected them).
    function revertFiles(id, paths) {
        const ws = get(id);
        for (const rel of paths) {
            const workFile = containedPath(ws.work, rel);
            const base = readOrNull(path.join(ws.base, rel));
            try { if (fs.lstatSync(workFile).isSymbolicLink()) fs.unlinkSync(workFile); } catch { /* not there */ }
            if (base === null) fs.rmSync(workFile, { force: true });
            else writeAtomic(workFile, base);
        }
    }

    function discard(id) {
        const ws = workspaces.get(id);
        if (!ws) return false;
        workspaces.delete(id);
        fs.rmSync(ws.dir, { recursive: true, force: true });
        return true;
    }

    function discardAll() {
        for (const id of [...workspaces.keys()]) discard(id);
    }

    function list() {
        return [...workspaces.values()].map(ws => ({ id: ws.id, projectDir: ws.projectDir, createdAt: ws.createdAt, skippedLargeFiles: ws.skipped.length, onDemand: ws.lazy }));
    }

    return { open, get, changes, applyFiles, revertFiles, discard, discardAll, list, containedPath, walk, projectSize, readPath, prepareWrite, listTree };
}

module.exports = { createStaging, StagingError, containedPath, walk, isBinary, isHidden, SKIPPED_DIRS };
