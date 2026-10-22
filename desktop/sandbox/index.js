// Sandboxed agent workspaces with a review gate, for the Windows app
// (desktop/main.js) and server.js.
//
//  Agents get MCP tools (list_files, read_file, search_files, write_file,
//  edit_file, delete_file, run_command, sandbox_diff, submit_changes) that work
//  in a staging copy of the project. run_command runs inside the agent's own
//  Docker container, which sees only that copy. Nothing an agent does reaches
//  the real project.
//
//  The user reviews the staged changes as a git diff with syntax-check results
//  and approves files one by one. Only that review step (`review` below, never
//  exposed as a tool) writes to the real disk, and only files whose checks
//  didn't fail.
//
// Without Docker the file tools still work in the staging copy, and
// run_command is left out of the tool list; status() says why.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createContainerManager, WORKDIR } = require('./container-manager');
const { createStaging, StagingError } = require('./staging');
const { unifiedDiff, diffStats } = require('./diff');
const { validateFile } = require('./validate');

const MAX_READ_CHARS = 100000;
const MAX_LISTED_FILES = 500;
const MAX_OUTPUT_CHARS = 8000;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCHED_FILE_BYTES = 1024 * 1024;
const MAX_DIFF_CHARS_FOR_AGENT = 30000;
const MAX_DIFF_CHARS_PER_FILE = 400000;
const META_AGENT = 'codev/agent';
const META_WORKSPACE = 'codev/workspace';

class ToolError extends Error {}

// getProjectDir() -> the real project folder (or ''). stagingRoot: where scratch
// copies go (default: the OS temp folder).
function createSandbox({ getProjectDir, stagingRoot, log = () => {}, containerOptions } = {}) {
    const containers = createContainerManager(containerOptions);
    const staging = createStaging({ getProjectDir, root: stagingRoot });
    const sandboxes = new Map(); // id -> { id, agents, task, createdAt }; one staging copy each
    const changesets = new Map(); // id -> change set (pending, approved or rejected)
    const submissions = new Map(); // sandbox id -> agent's summary from submit_changes
    let enabled = true;

    // A sandbox is one staging copy of the project; the agents that share it each
    // get their own container on it.
    function openSandbox(id, agentId, task) {
        try { staging.open(id); } catch (err) { throw new ToolError(err.message); }
        let box = sandboxes.get(id);
        if (!box) {
            box = { id, agents: new Set(), task: task ? String(task).slice(0, 500) : '', createdAt: Date.now() };
            sandboxes.set(id, box);
        }
        box.agents.add(agentId);
        return box;
    }

    function workspaceFor(ctx) {
        openSandbox(ctx.workspace, ctx.agentId);
        return staging.get(ctx.workspace);
    }

    function filePath(ws, rel) {
        try { return staging.containedPath(ws.work, rel); } catch (err) { throw new ToolError(err.message); }
    }

    // TOOLS (what agents can do; all of it inside the staging copy)

    function listFiles({ path: rel } = {}, ctx) {
        const ws = workspaceFor(ctx);
        const start = filePath(ws, rel);
        if (!fs.existsSync(start) || !fs.statSync(start).isDirectory()) throw new ToolError(`'${rel}' is not a folder`);
        const found = staging.walk(start, { limit: MAX_LISTED_FILES }).map(p => path.posix.join(path.relative(ws.work, start).split(path.sep).join('/'), p));
        if (!found.length) return 'The folder is empty.';
        return found.join('\n') + (found.length >= MAX_LISTED_FILES ? `\n[stopped at ${MAX_LISTED_FILES} files]` : '');
    }

    function readFile({ path: rel } = {}, ctx) {
        const ws = workspaceFor(ctx);
        const full = filePath(ws, rel);
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new ToolError(`No file at '${rel}'. Call list_files to see what exists.`);
        const text = fs.readFileSync(full, 'utf8');
        return text.length > MAX_READ_CHARS ? text.slice(0, MAX_READ_CHARS) + `\n[truncated at ${MAX_READ_CHARS} characters]` : text;
    }

    function searchFiles({ query, path: rel } = {}, ctx) {
        if (typeof query !== 'string' || !query.trim()) throw new ToolError("search_files needs a 'query' string");
        const ws = workspaceFor(ctx);
        const start = filePath(ws, rel);
        const needle = query.toLowerCase();
        const hits = [];
        for (const file of staging.walk(start, { limit: 5000 })) {
            const full = path.join(start, file);
            if (fs.statSync(full).size > MAX_SEARCHED_FILE_BYTES) continue;
            const text = fs.readFileSync(full, 'utf8');
            if (text.includes('\u0000')) continue;
            const shown = path.relative(ws.work, full).split(path.sep).join('/');
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (!lines[i].toLowerCase().includes(needle)) continue;
                hits.push(`${shown}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                if (hits.length >= MAX_SEARCH_MATCHES) return hits.join('\n') + `\n[stopped at ${MAX_SEARCH_MATCHES} matches]`;
            }
        }
        return hits.length ? hits.join('\n') : `No matches for "${query}".`;
    }

    function writeFile({ path: rel, content } = {}, ctx) {
        if (typeof content !== 'string') throw new ToolError("write_file needs 'content' as a string");
        const ws = workspaceFor(ctx);
        const full = filePath(ws, rel);
        if (fs.existsSync(full) && fs.lstatSync(full).isSymbolicLink()) fs.unlinkSync(full);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
        return `Staged ${rel} (${content.length} characters) in the sandbox. It reaches the user's disk only after they approve it in the review.`;
    }

    function editFile({ path: rel, old_text: oldText, new_text: newText } = {}, ctx) {
        if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string') {
            throw new ToolError("edit_file needs non-empty 'old_text' and a 'new_text' string");
        }
        const ws = workspaceFor(ctx);
        const full = filePath(ws, rel);
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new ToolError(`No file at '${rel}'`);
        const text = fs.readFileSync(full, 'utf8');
        const count = text.split(oldText).length - 1;
        if (count !== 1) throw new ToolError(`old_text must appear exactly once in the file; it appears ${count} times`);
        fs.writeFileSync(full, text.replace(oldText, () => newText), 'utf8');
        return `Edited ${rel} in the sandbox (staged for the user's review).`;
    }

    function deleteFile({ path: rel } = {}, ctx) {
        const ws = workspaceFor(ctx);
        const full = filePath(ws, rel);
        if (!fs.existsSync(full) || !fs.lstatSync(full).isFile()) throw new ToolError(`No file at '${rel}'`);
        fs.unlinkSync(full);
        return `Deleted ${rel} in the sandbox (staged for the user's review).`;
    }

    async function runCommand({ command, cwd, timeout_seconds: timeoutSeconds } = {}, ctx) {
        if (typeof command !== 'string' || !command.trim()) throw new ToolError("run_command needs a 'command' string");
        const ws = workspaceFor(ctx);
        const docker = await containers.detect();
        if (!docker.available) throw new ToolError(`Nothing was run: ${docker.reason}`);
        let result;
        try {
            result = await containers.exec(ctx.agentId, ctx.workspace, ws.work, command, { cwd, timeoutSeconds });
        } catch (err) {
            throw new ToolError(err.message);
        }
        log(`[Sandbox] ${ctx.agentId}: ${command.slice(0, 120)} -> exit ${result.exitCode}`);
        return `Exit code: ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}\n--- stdout ---\n${result.stdout.slice(-MAX_OUTPUT_CHARS)}\n--- stderr ---\n${result.stderr.slice(-MAX_OUTPUT_CHARS)}`;
    }

    // The agent's view of the review: the diff and the syntax checks, so it can fix
    // failures before the user sees them.
    async function sandboxDiff(_args, ctx) {
        workspaceFor(ctx);
        const set = await buildChangeset(ctx.workspace);
        if (!set.files.length) return 'No changes staged yet.';
        const lines = set.files.map(f => {
            const check = f.checks[0];
            const verdict = !check.ok ? 'FAILED' : check.skipped ? 'not checked' : 'passed';
            return `${f.status.padEnd(8)} ${f.path}  +${f.additions} -${f.deletions}  syntax: ${verdict}${check.ok ? '' : `\n    ${check.message.replace(/\n/g, '\n    ')}`}`;
        });
        let patch = set.diff;
        if (patch.length > MAX_DIFF_CHARS_FOR_AGENT) patch = patch.slice(0, MAX_DIFF_CHARS_FOR_AGENT) + '\n[diff truncated]';
        return `${set.files.length} staged change(s):\n${lines.join('\n')}\n\nFiles whose syntax check failed can't be applied; fix them.\n\n${patch}`;
    }

    async function submitChanges({ summary } = {}, ctx) {
        workspaceFor(ctx);
        const set = await buildChangeset(ctx.workspace);
        if (!set.files.length) return 'There are no staged changes to submit.';
        submissions.set(ctx.workspace, { agent: ctx.agentId, summary: String(summary || '').slice(0, 4000), at: Date.now() });
        const failed = set.files.filter(f => !passed(f));
        return `Submitted ${set.files.length} file(s) for the user's review. They are written to the user's disk only after the user approves them.`
            + (failed.length ? ` ${failed.length} file(s) failed the syntax check and can't be approved until fixed: ${failed.map(f => f.path).join(', ')}.` : '');
    }

    const pathProp = { type: 'string', description: 'Path relative to the project, with / separators.' };
    const TOOLS = [
        { name: 'list_files', run: listFiles, annotations: { readOnlyHint: true },
          description: 'List files in your sandbox copy of the user\'s project (recursively, skipping .git and node_modules).',
          inputSchema: { type: 'object', properties: { path: { ...pathProp, description: 'Sub-folder to list; omit for the whole project.' } } } },
        { name: 'read_file', run: readFile, annotations: { readOnlyHint: true },
          description: 'Read a text file from your sandbox copy of the project, including changes you staged.',
          inputSchema: { type: 'object', properties: { path: pathProp }, required: ['path'] } },
        { name: 'search_files', run: searchFiles, annotations: { readOnlyHint: true },
          description: 'Search the text of every file in your sandbox copy of the project (case-insensitive); results are path:line: text.',
          inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Text to look for.' },
              path: { ...pathProp, description: 'Sub-folder to search; omit for the whole project.' } }, required: ['query'] } },
        { name: 'write_file', run: writeFile, annotations: { readOnlyHint: false, destructiveHint: false },
          description: 'Create or overwrite a file in your sandbox copy of the project. Changes are staged: the user reviews a diff and approves them before anything is written to their disk.',
          inputSchema: { type: 'object', properties: { path: pathProp, content: { type: 'string', description: 'The complete new file content.' } }, required: ['path', 'content'] } },
        { name: 'edit_file', run: editFile, annotations: { readOnlyHint: false, destructiveHint: false },
          description: 'Replace one exact snippet of a file in your sandbox copy (staged for review). old_text must appear exactly once; read the file first.',
          inputSchema: { type: 'object', properties: { path: pathProp, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
        { name: 'delete_file', run: deleteFile, annotations: { readOnlyHint: false, destructiveHint: false },
          description: 'Delete a file in your sandbox copy (staged for review).',
          inputSchema: { type: 'object', properties: { path: pathProp }, required: ['path'] } },
        { name: 'run_command', run: runCommand, annotations: { readOnlyHint: false, destructiveHint: false }, needsDocker: true,
          description: 'Run a shell command (sh, Linux) in your own isolated Docker container, in /workspace, which is your sandbox copy of the project. Use it to run code, tests, builds and scripts. The container has no network unless the user allowed it, and nothing outside /workspace persists.',
          inputSchema: { type: 'object', properties: {
              command: { type: 'string', description: 'The command line to run with sh -c.' },
              cwd: { ...pathProp, description: 'Sub-folder of the project to run in; omit for the project root.' },
              timeout_seconds: { type: 'integer', description: 'Stop after this many seconds (default 120, max 600).' } },
              required: ['command'] } },
        { name: 'sandbox_diff', run: sandboxDiff, annotations: { readOnlyHint: true },
          description: 'Show the git diff of everything staged in your sandbox so far, with syntax-check results per file. Check it before you finish; files that fail the check can\'t be approved.',
          inputSchema: { type: 'object', properties: {} } },
        { name: 'submit_changes', run: submitChanges, annotations: { readOnlyHint: true },
          description: 'Hand your staged changes to the user for review when you are done, with a short summary of what changed and why. The user approves them before they are written to disk.',
          inputSchema: { type: 'object', properties: { summary: { type: 'string', description: 'What you changed and why, in a few lines.' } }, required: ['summary'] } }
    ];

    async function listTools() {
        if (!enabled || !getProjectDir()) return [];
        const docker = await containers.detect();
        return TOOLS.filter(t => !t.needsDocker || docker.available).map(({ run, needsDocker, ...t }) => t);
    }

    // MCP CallToolResult for one tool call. ctx = { agentId, workspace }.
    async function callTool(name, args, ctx = {}) {
        const tool = TOOLS.find(t => t.name === name);
        if (!tool || !enabled) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
        const context = { agentId: cleanId(ctx.agentId), workspace: cleanId(ctx.workspace || ctx.agentId) };
        try {
            const text = await tool.run(args || {}, context);
            return { content: [{ type: 'text', text }], isError: false };
        } catch (err) {
            const known = err instanceof ToolError || err instanceof StagingError;
            return { content: [{ type: 'text', text: known ? err.message : `${err.name}: ${err.message}` }], isError: true };
        }
    }

    // Answers one JSON-RPC message the way an MCP server would (the Windows app's
    // IPC path). The agent and workspace come in params._meta.
    async function handleMcp(msg) {
        const id = msg && msg.id;
        const ok = result => ({ jsonrpc: '2.0', id, result });
        if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
            return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
        }
        if (msg.method === 'initialize') {
            return ok({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'codev-sandbox', version: '1.0.0' },
                instructions: 'Every file change is staged in a sandbox copy of the project and reaches the user\'s disk only after they approve the diff. Run code with run_command inside your container. Check sandbox_diff before finishing, then call submit_changes.' });
        }
        if (msg.method === 'ping') return ok({});
        if (msg.method === 'tools/list') return ok({ tools: await listTools() });
        if (msg.method === 'tools/call') {
            const meta = msg.params?._meta || {};
            if (!TOOLS.some(t => t.name === msg.params?.name)) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${msg.params?.name}` } };
            return ok(await callTool(msg.params.name, msg.params.arguments, { agentId: meta[META_AGENT] || meta['codev/agentId'], workspace: meta[META_WORKSPACE] }));
        }
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }

    // REVIEW GATE (the user's side; never offered to agents)

    async function buildChangeset(sandboxId) {
        const changes = staging.changes(sandboxId);
        const files = [];
        for (const change of changes) {
            let diff;
            if (change.status === 'symlink') diff = `diff --git a/${change.path} b/${change.path}\n# symbolic link created in the sandbox; links are never written to disk\n`;
            else if (change.binary) diff = `diff --git a/${change.path} b/${change.path}\nBinary files ${change.status === 'added' ? '/dev/null' : `a/${change.path}`} and ${change.status === 'deleted' ? '/dev/null' : `b/${change.path}`} differ\n`;
            else diff = unifiedDiff(change.path, change.oldText, change.newText);
            if (diff.length > MAX_DIFF_CHARS_PER_FILE) diff = diff.slice(0, MAX_DIFF_CHARS_PER_FILE) + '\n[diff truncated for display]\n';
            const result = change.status === 'symlink'
                ? { status: 'failed', message: 'Symbolic links are never written to your disk.' }
                : await validateFile(change.path, change.binary ? undefined : change.newText);
            const { added, removed } = diffStats(diff);
            files.push({
                path: change.path, status: change.status, binary: change.binary, size: change.size, hash: change.hash,
                additions: added, deletions: removed, diff,
                checks: [{ name: 'syntax', ok: result.status !== 'failed', skipped: result.status === 'skipped', message: result.message || (result.status === 'passed' ? 'Passed.' : '') }]
            });
        }
        const box = sandboxes.get(sandboxId);
        const submission = submissions.get(sandboxId) || null;
        return {
            id: crypto.randomBytes(8).toString('hex'),
            sandboxId,
            agentId: submission ? submission.agent : box ? [...box.agents][0] || null : null,
            status: 'pending',
            createdAt: Date.now(),
            submission,
            diff: files.map(f => f.diff).join(''),
            files
        };
    }

    function passed(file) {
        return file.checks.every(c => c.ok);
    }

    // Stages a sandbox's changes for review. An older pending review of the same
    // sandbox is replaced, so approving always acts on the latest one.
    async function stage(sandboxId) {
        staging.get(sandboxId);
        const set = await buildChangeset(sandboxId);
        for (const [id, old] of changesets) if (old.sandboxId === sandboxId && old.status === 'pending') changesets.delete(id);
        if (set.files.length) changesets.set(set.id, set);
        return set;
    }

    function pendingCount(sandboxId) {
        try { return staging.changes(sandboxId).length; } catch { return 0; }
    }

    // Writes the approved files of a reviewed change set to the real project.
    // paths omitted: every file whose checks passed.
    async function approve(set, paths) {
        const skipped = [];
        const approved = [];
        const wanted = Array.isArray(paths) ? paths.map(String) : set.files.filter(passed).map(f => f.path);
        for (const rel of wanted) {
            const file = set.files.find(f => f.path === rel);
            if (!file) skipped.push({ path: rel, reason: 'not part of this change set' });
            else if (!passed(file)) skipped.push({ path: rel, reason: `checks failed: ${file.checks.filter(c => !c.ok).map(c => c.message).join('; ')}` });
            else approved.push({ path: file.path, hash: file.hash });
        }
        const written = [];
        for (const r of staging.applyFiles(set.sandboxId, approved)) {
            if (r.applied) written.push(r.path);
            else skipped.push({ path: r.path, reason: r.error });
        }
        for (const p of written) log(`[Sandbox] Wrote ${p} to the project after review.`);
        for (const s of skipped) log(`[Sandbox] Did not write ${s.path}: ${s.reason}`);
        set.status = written.length ? 'approved' : set.status;
        set.decidedAt = Date.now();
        set.result = { written, skipped };
        if (!pendingCount(set.sandboxId)) await finishSandbox(set.sandboxId);
        return { written, skipped };
    }

    async function reject(set, reason) {
        staging.revertFiles(set.sandboxId, set.files.map(f => f.path));
        set.status = 'rejected';
        set.decidedAt = Date.now();
        set.reason = String(reason || '').slice(0, 2000);
        log(`[Sandbox] Rejected ${set.files.length} change(s) from ${set.sandboxId}${set.reason ? `: ${set.reason}` : ''}`);
        if (!pendingCount(set.sandboxId)) await finishSandbox(set.sandboxId);
        return { ok: true };
    }

    // A sandbox with nothing left to review is thrown away with its containers,
    // so the next task starts from the current project. Decided reviews stay
    // listed (GET /agent/changes/:id) for a while.
    async function finishSandbox(id) {
        for (const [key, set] of changesets) if (set.sandboxId === id && set.status === 'pending') changesets.delete(key);
        submissions.delete(id);
        sandboxes.delete(id);
        await containers.release(id);
        staging.discard(id);
    }

    async function status() {
        const docker = await containers.detect();
        return {
            enabled,
            workspace: getProjectDir() || null,
            docker: docker.available ? { available: true, version: docker.version } : { available: false, error: docker.reason },
            container: containers.getConfig(),
            sandboxes: [...sandboxes.values()].map(describeSandbox),
            containers: containers.list()
        };
    }

    function describeSandbox(box) {
        return { id: box.id, agents: [...box.agents], task: box.task, createdAt: box.createdAt, image: containers.getConfig().image, scratchpad: WORKDIR,
            pendingChanges: pendingCount(box.id), submitted: submissions.has(box.id) };
    }

    // The user-side HTTP contract (server.js mounts it under /agent/; the Windows
    // app passes the same requests over IPC). Returns { status, body }, or null
    // for a path that isn't the sandbox's.
    async function handleRequest(method, pathname, query = {}, body = {}) {
        const parts = String(pathname || '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
        if (parts[0] !== 'agent') return null;
        const m = String(method || 'GET').toUpperCase();
        const reply = (status, payload) => ({ status, body: payload });
        const fail = (status, message) => reply(status, { error: message });
        body = body && typeof body === 'object' ? body : {};
        try {
            const [, area, id, action, ...rest] = parts;
            if (rest.length) return null;
            if (area === 'status' && !id && m === 'GET') return reply(200, await status());
            if (area === 'config' && !id && m === 'POST') {
                if (typeof body.enabled === 'boolean') enabled = body.enabled;
                return reply(200, { enabled, container: containers.configure({ image: body.image, network: body.network }) });
            }
            if (area === 'sandboxes') {
                if (!id && m === 'GET') return reply(200, [...sandboxes.values()].map(describeSandbox));
                if (!id && m === 'POST') {
                    const agentId = cleanId(body.agentId);
                    const box = openSandbox(body.workspace ? cleanId(body.workspace) : `${agentId}-${crypto.randomBytes(3).toString('hex')}`, agentId, body.task);
                    const docker = await containers.detect();
                    // Start the container now so the first command isn't slow; without Docker the
                    // sandbox still stages file edits.
                    let containerError = docker.available ? null : docker.reason;
                    if (docker.available) {
                        try { await containers.acquire(agentId, box.id, staging.get(box.id).work); } catch (err) { containerError = err.message; }
                    }
                    return reply(201, { ...describeSandbox(box), agentId, container: containerError ? { running: false, error: containerError } : { running: true } });
                }
                const box = sandboxes.get(cleanId(id));
                if (!box) return fail(404, `No sandbox "${id}". It may have been discarded after its review.`);
                const agentId = cleanId(body.agentId || query.agentId || [...box.agents][0]);
                const ctx = { agentId, workspace: box.id };
                if (!action && m === 'GET') return reply(200, describeSandbox(box));
                if (!action && m === 'DELETE') { await finishSandbox(box.id); return reply(200, { ok: true }); }
                if (action === 'exec' && m === 'POST') {
                    if (typeof body.command !== 'string' || !body.command.trim()) return fail(400, 'exec needs a command');
                    const docker = await containers.detect();
                    if (!docker.available) return fail(503, docker.reason);
                    const timeoutSeconds = body.timeoutMs ? Math.ceil(Number(body.timeoutMs) / 1000) : undefined;
                    const result = await containers.exec(agentId, box.id, staging.get(box.id).work, body.command, { cwd: body.cwd, timeoutSeconds });
                    return reply(200, result);
                }
                if (action === 'files' && m === 'GET') {
                    const rel = query.path;
                    return reply(200, { path: rel, content: readFile({ path: rel }, ctx) });
                }
                if (action === 'files' && m === 'POST') {
                    writeFile({ path: body.path, content: body.content }, ctx);
                    return reply(200, { ok: true });
                }
                if (action === 'stage' && m === 'POST') return reply(200, await stage(box.id));
                return null;
            }
            if (area === 'changes') {
                if (!id && m === 'GET') {
                    // Bring every sandbox's latest edits into its pending review first.
                    for (const box of sandboxes.values()) if (pendingCount(box.id)) await stage(box.id);
                    return reply(200, [...changesets.values()].filter(set => set.status === 'pending'));
                }
                const set = changesets.get(String(id));
                if (!set) return fail(404, 'No such change set. It may be out of date; list the changes again.');
                if (!action && m === 'GET') return reply(200, set);
                if (set.status !== 'pending') return fail(409, `This change set was already ${set.status}.`);
                if (action === 'approve' && m === 'POST') return reply(200, await approve(set, body.paths));
                if (action === 'reject' && m === 'POST') return reply(200, await reject(set, body.reason));
                return null;
            }
            return null;
        } catch (err) {
            const known = err instanceof ToolError || err instanceof StagingError;
            return fail(known ? 400 : 500, err.message);
        }
    }

    async function close() {
        await containers.closeAll();
        staging.discardAll();
    }

    function closeSync() {
        containers.closeAllSync();
        staging.discardAll();
    }

    return { handleMcp, handleRequest, listTools, callTool, status, stage, close, closeSync, containers, staging };
}

function cleanId(value) {
    return String(value || 'default').replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 64) || 'default';
}

// The service shape server.js mounts: the agents' tools at its /agent-tools
// JSON-RPC endpoint, and handleRequest for the user's review routes under
// /agent/ (behind the same own-origin checks as /mcp-hub).
function createService(config = {}, { log } = {}) {
    const workspace = config.workspace || {};
    const sandbox = createSandbox({
        getProjectDir: () => workspace.root || '',
        stagingRoot: workspace.dataDir ? path.join(workspace.dataDir, 'sandboxes') : undefined,
        log: log || (line => console.log(line))
    });
    const route = async (req, res, body) => {
        const url = new URL(req.url, 'http://localhost');
        let parsed = body;
        if (typeof body === 'string' || Buffer.isBuffer(body)) {
            try { parsed = String(body).trim() ? JSON.parse(String(body)) : {}; } catch { parsed = null; }
        }
        const reply = parsed === null ? { status: 400, body: { error: 'Bad JSON' } }
            : (await sandbox.handleRequest(req.method, url.pathname, Object.fromEntries(url.searchParams), parsed)) || { status: 404, body: { error: 'Not found' } };
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply.body));
    };
    return {
        name: 'sandbox',
        get tools() { return sandbox.listTools(); },
        listTools: sandbox.listTools,
        callTool: sandbox.callTool,
        handleMcp: sandbox.handleMcp,
        handleRequest: sandbox.handleRequest,
        routes: { 'ANY /agent/*': route },
        status: async () => {
            const s = await sandbox.status();
            const detail = !s.workspace ? 'No project folder is set, so agents have no sandbox.'
                : s.docker.available ? `Docker ${s.docker.version}: agents' commands run in their own containers.`
                    : `File edits are staged for review, but commands can't run: ${s.docker.error}`;
            return { available: Boolean(s.workspace), detail, ...s };
        },
        close: sandbox.close,
        closeSync: sandbox.closeSync,
        sandbox
    };
}

module.exports = { createSandbox, createService };
