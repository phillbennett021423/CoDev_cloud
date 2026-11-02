// Checkpoints: a snapshot of the whole project folder taken before agents change it, and
// a one-step rollback to any snapshot. They live in a shadow git repository in CoDev's
// data folder (CODEV_DATA_DIR, or ~/.codev), never in the project's own .git, so they
// work on any folder (git repo or not) and never touch the user's branches, index or stash.
// Git itself is the only requirement (free, git-scm.com).
//
//   checkpoint_create   snapshot now (CoDev's page does this before every coding task)
//   checkpoint_list     the snapshots, newest first
//   checkpoint_restore  put the folder back as it was at a snapshot; the state before the
//                       rollback is saved as a snapshot first, so a rollback can be undone
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const EXCLUDE = ['node_modules/', '.godot/', '.import/', 'build/', 'dist/', '.venv/', 'venv/', '__pycache__/', '*.tmp', '.codev_bridge.json', '*.env', '.env*', '*.pem', '*.key', '*.keystore', '*.jks'];
const MAX_FILE_BYTES = 50 * 1024 * 1024;

function git(args, { cwd, env } = {}) {
    return new Promise(resolve => {
        execFile('git', args, { cwd, env, maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, missing: Boolean(err && err.code === 'ENOENT'), out: String(stdout || '').trim(), err: String(stderr || '').trim() });
        });
    });
}

const text = (value, isError = false) => ({ content: [{ type: 'text', text: String(value) }], ...(isError ? { isError: true } : {}) });

function createCheckpoints({ getRoot, env = process.env } = {}) {
    const dataDir = env.CODEV_DATA_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.codev');

    async function repo() {
        const root = getRoot();
        if (!root || !fs.existsSync(root)) throw new Error('No project folder is set, so there is nothing to checkpoint.');
        const id = crypto.createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 12);
        const gitDir = path.join(dataDir, 'checkpoints', `${path.basename(root).replace(/[^\w.-]+/g, '_')}-${id}.git`);
        const cleanEnv = { ...env, GIT_DIR: gitDir, GIT_WORK_TREE: root, GIT_TERMINAL_PROMPT: '0' };
        for (const key of Object.keys(cleanEnv)) if (/^GIT_(INDEX_FILE|OBJECT_DIRECTORY|NAMESPACE)$/.test(key)) delete cleanEnv[key];
        const run = args => git(args, { cwd: root, env: cleanEnv });
        if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
            fs.mkdirSync(gitDir, { recursive: true });
            const init = await run(['init', '-q']);
            if (init.missing) throw new Error('Checkpoints need git, which isn\'t installed or on the PATH. It is free from git-scm.com.');
            if (init.code) throw new Error(`git init failed: ${init.err}`);
            await run(['config', 'user.name', 'CoDev']);
            await run(['config', 'user.email', 'checkpoints@codev.local']);
            await run(['config', 'core.autocrlf', 'false']);
            await run(['config', 'core.quotepath', 'false']);
            fs.mkdirSync(path.join(gitDir, 'info'), { recursive: true });
            fs.writeFileSync(path.join(gitDir, 'info', 'exclude'), EXCLUDE.join('\n') + '\n');
        }
        return { root, run };
    }

    async function create({ label = '' } = {}) {
        const { root, run } = await repo();
        const add = await run(['add', '-A', '--', '.']);
        if (add.missing) throw new Error('Checkpoints need git, which isn\'t installed or on the PATH. It is free from git-scm.com.');
        if (add.code) throw new Error(`Couldn't snapshot the folder: ${add.err}`);
        // Huge files (videos, builds) would bloat every snapshot.
        const big = (await run(['diff', '--cached', '--name-only', '-z'])).out.split('\0').filter(Boolean)
            .filter(f => { try { return fs.statSync(path.join(root, f)).size > MAX_FILE_BYTES; } catch { return false; } });
        if (big.length) await run(['rm', '--cached', '-q', '--', ...big]);
        const message = String(label || 'Checkpoint').replace(/\s+/g, ' ').slice(0, 200);
        const commit = await run(['commit', '-q', '--allow-empty', '--no-verify', '-m', message]);
        if (commit.code) throw new Error(`Couldn't save the checkpoint: ${commit.err || commit.out}`);
        const id = (await run(['rev-parse', '--short=10', 'HEAD'])).out;
        const files = (await run(['ls-files'])).out.split('\n').filter(Boolean).length;
        return { id, label: message, files, skipped: big };
    }

    async function list({ limit = 20 } = {}) {
        const { run } = await repo();
        const log = await run(['log', `-n${Math.min(Math.max(Number(limit) || 20, 1), 100)}`, '--format=%h%x09%ci%x09%s', '--abbrev=10']);
        if (log.code) return [];
        return log.out.split('\n').filter(Boolean).map(line => { const [id, at, label] = line.split('\t'); return { id, at, label }; });
    }

    async function restore({ id }) {
        const { run } = await repo();
        if (!/^[0-9a-f]{4,40}$/i.test(String(id || ''))) throw new Error('Give a checkpoint id from checkpoint_list.');
        if ((await run(['cat-file', '-e', `${id}^{commit}`])).code) throw new Error(`No checkpoint ${id}. Call checkpoint_list for the ids.`);
        const before = await create({ label: `Before rolling back to ${id}` });
        // Files made since the checkpoint go; changed and deleted files come back.
        const added = (await run(['diff', '--no-renames', '--name-only', '-z', '--diff-filter=A', id, 'HEAD'])).out.split('\0').filter(Boolean);
        const root = getRoot();
        for (const file of added) {
            const full = path.resolve(root, file);
            if (full.startsWith(path.resolve(root) + path.sep)) fs.rmSync(full, { force: true });
        }
        const checkout = await run(['checkout', id, '--', '.']);
        if (checkout.code) throw new Error(`Rollback failed: ${checkout.err}. The folder as it was is saved as checkpoint ${before.id}.`);
        await run(['reset', '-q', 'HEAD', '--', '.']);
        return { id, removed: added, undo: before.id };
    }

    const tools = [
        {
            name: 'checkpoint_create',
            description: 'Save a checkpoint of the whole project folder (a snapshot in CoDev\'s own data folder, not in the project\'s git), so the user can roll back to it with one click. CoDev already takes one before every coding task; call it yourself only before a risky step in the middle of a task (a big refactor, a mass rename, deleting files). Don\'t call it after every small edit.',
            inputSchema: { type: 'object', properties: { label: { type: 'string', description: 'A short label for the snapshot, like "Before splitting player.gd".' } } },
            // It writes only to CoDev's data folder, never to the project.
            annotations: { readOnlyHint: true }
        },
        {
            name: 'checkpoint_list',
            description: 'List the project\'s checkpoints, newest first, with their ids, times and labels. Use it when the user asks what can be rolled back, or to find the id for checkpoint_restore. Not for git history of the project itself (run git log with a command tool instead).',
            inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'How many to list (default 20, up to 100).' } } },
            annotations: { readOnlyHint: true }
        },
        {
            name: 'checkpoint_restore',
            description: 'Roll the project folder back to a checkpoint: changed and deleted files come back, files made since are removed. The current state is saved as a checkpoint first, so the rollback can itself be undone. The user is asked first. Use it only when the user asks to undo or roll back; never to hide a failed change from them.',
            inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The checkpoint id from checkpoint_list, like 3f2a9c1b7d.' } }, required: ['id'] },
            _meta: { 'codev/alwaysAsk': true }
        }
    ];
    const names = tools.map(t => t.name);

    async function callTool(name, args = {}) {
        try {
            if (name === 'checkpoint_create') {
                const c = await create(args);
                return text(`Checkpoint ${c.id} saved ("${c.label}", ${c.files} files)${c.skipped.length ? `; left out ${c.skipped.length} file(s) over 50 MB: ${c.skipped.slice(0, 5).join(', ')}` : ''}. checkpoint_restore with this id rolls back to it.`);
            }
            if (name === 'checkpoint_list') {
                const all = await list(args);
                return text(all.length ? all.map(c => `${c.id}  ${c.at}  ${c.label}`).join('\n') : 'No checkpoints yet for this project.');
            }
            if (name === 'checkpoint_restore') {
                const r = await restore(args);
                return text(`Rolled back to checkpoint ${r.id}${r.removed.length ? `; removed ${r.removed.length} file(s) made since (${r.removed.slice(0, 8).join(', ')})` : ''}. To undo the rollback, restore checkpoint ${r.undo}.`);
            }
            return text(`Unknown tool: ${name}`, true);
        } catch (err) {
            return text(err.message || String(err), true);
        }
    }

    return { tools, names, callTool, create, list, restore };
}

module.exports = { createCheckpoints };
