// Staging workspaces: a scratch copy of the project per agent workspace, where
// agents' file tools and containers write. Next to it sits a baseline copy of
// the project as it was staged, which is what the diff is taken against and
// what "is the real file still what the agent started from?" is checked
// against. Nothing in this file writes to the real project except applyFiles,
// which the review gate calls after the user approves.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SKIPPED_DIRS = new Set(['.git', '.codev', 'node_modules', '__pycache__', '.godot', '.import', 'venv', '.venv', 'dist', 'build']);
const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const SYNC_INTERVAL_MS = 5000;

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

// Project-relative paths of regular files under dir (symlinks and SKIPPED_DIRS left out).
function walk(dir, { limit = MAX_FILES * 4, onSymlink } = {}) {
    const found = [];
    const visit = current => {
        let entries;
        try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (found.length >= limit) return;
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

function createStaging({ getProjectDir, root } = {}) {
    const baseDir = root || path.join(os.tmpdir(), 'codev-sandboxes');
    const workspaces = new Map();

    function projectDirOrThrow() {
        const dir = getProjectDir();
        if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            throw new StagingError('No project folder is chosen, so there is nothing to stage. Choose one in CoDev Settings.');
        }
        return path.resolve(dir);
    }

    // Copies the project into a new workspace and baseline.
    function create(id) {
        const projectDir = projectDirOrThrow();
        fs.mkdirSync(baseDir, { recursive: true });
        const dir = fs.mkdtempSync(path.join(baseDir, `${String(id).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 32) || 'ws'}-`));
        const ws = { id, dir, projectDir, work: path.join(dir, 'workspace'), base: path.join(dir, 'baseline'), stats: new Map(), skipped: [], createdAt: Date.now(), lastSync: Date.now() };
        fs.mkdirSync(ws.work);
        fs.mkdirSync(ws.base);
        const files = walk(projectDir, { limit: MAX_FILES + 1 });
        if (files.length > MAX_FILES) {
            fs.rmSync(dir, { recursive: true, force: true });
            throw new StagingError(`The project has more than ${MAX_FILES} files (outside node_modules, .git, build and dist), which is too many to copy into a sandbox.`);
        }
        let total = 0;
        for (const rel of files) {
            const src = path.join(projectDir, rel);
            const stat = fs.statSync(src);
            if (stat.size > MAX_FILE_BYTES) { ws.skipped.push(rel); continue; }
            total += stat.size;
            if (total > MAX_TOTAL_BYTES) {
                fs.rmSync(dir, { recursive: true, force: true });
                throw new StagingError(`The project is larger than ${MAX_TOTAL_BYTES / 1024 / 1024} MB, which is too big to copy into a sandbox.`);
            }
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
        for (const rel of walk(projectDir, { limit: MAX_FILES })) {
            seen.add(rel);
            let stat;
            try { stat = fs.statSync(path.join(projectDir, rel)); } catch { continue; }
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
        return [...workspaces.values()].map(ws => ({ id: ws.id, projectDir: ws.projectDir, createdAt: ws.createdAt, skippedLargeFiles: ws.skipped.length }));
    }

    return { open, get, changes, applyFiles, revertFiles, discard, discardAll, list, containedPath, walk };
}

module.exports = { createStaging, StagingError, containedPath, walk, isBinary, SKIPPED_DIRS };
