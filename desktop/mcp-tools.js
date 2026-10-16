// Built-in MCP tools for the Windows desktop app, so agents can read, write and
// edit files and run commands in a project folder without the Python helper.
// The page talks to this over IPC with the same JSON-RPC messages it sends to
// an MCP server (initialize, tools/list, tools/call).
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const MAX_READ_CHARS = 100000;
const MAX_LISTED_FILES = 500;
const MAX_OUTPUT_CHARS = 8000;
const MAX_TIMEOUT_SECONDS = 600;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.godot', '.import', 'venv', '.venv', 'dist', 'build']);

class ToolError extends Error {}

function createMcpTools(getProjectDir) {
    function projectPath(rel) {
        const root = getProjectDir();
        if (!root) throw new ToolError('No project folder is chosen. Choose one in CoDev Settings.');
        const full = path.resolve(root, String(rel || '.'));
        const realRoot = fs.realpathSync(root);
        let realFull = full;
        try { realFull = fs.realpathSync(full); } catch { realFull = path.resolve(realRoot, path.relative(root, full)); }
        if (realFull !== realRoot && !realFull.startsWith(realRoot + path.sep)) {
            throw new ToolError(`'${rel}' is outside the project folder ${root}`);
        }
        return full;
    }

    function listFiles({ path: rel } = {}) {
        const start = projectPath(rel);
        if (!fs.existsSync(start) || !fs.statSync(start).isDirectory()) throw new ToolError(`'${rel}' is not a folder`);
        const root = getProjectDir();
        const found = [];
        const walk = dir => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
                if (found.length >= MAX_LISTED_FILES) return;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { if (!SKIPPED_DIRS.has(entry.name)) walk(full); }
                else found.push(path.relative(root, full).split(path.sep).join('/'));
            }
        };
        walk(start);
        if (!found.length) return 'The folder is empty.';
        return found.join('\n') + (found.length >= MAX_LISTED_FILES ? `\n[stopped at ${MAX_LISTED_FILES} files]` : '');
    }

    function readFile({ path: rel } = {}) {
        const full = projectPath(rel);
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new ToolError(`No file at '${rel}'. Call list_files to see what exists.`);
        const text = fs.readFileSync(full, 'utf8');
        return text.length > MAX_READ_CHARS ? text.slice(0, MAX_READ_CHARS) + `\n[truncated at ${MAX_READ_CHARS} characters]` : text;
    }

    function writeFile({ path: rel, content } = {}) {
        if (typeof content !== 'string') throw new ToolError("write_file needs 'content' as a string");
        const full = projectPath(rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
        return `Wrote ${content.length} characters to ${rel}.`;
    }

    function editFile({ path: rel, old_text: oldText, new_text: newText } = {}) {
        if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string') {
            throw new ToolError("edit_file needs non-empty 'old_text' and a 'new_text' string");
        }
        const full = projectPath(rel);
        if (!fs.existsSync(full)) throw new ToolError(`No file at '${rel}'`);
        const text = fs.readFileSync(full, 'utf8');
        const count = text.split(oldText).length - 1;
        if (count !== 1) throw new ToolError(`old_text must appear exactly once in the file; it appears ${count} times`);
        fs.writeFileSync(full, text.replace(oldText, () => newText), 'utf8');
        return `Edited ${rel}.`;
    }

    function runCommand({ command, cwd, timeout_seconds: timeoutSeconds } = {}) {
        if (typeof command !== 'string' || !command.trim()) throw new ToolError("run_command needs a 'command' string");
        const seconds = Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Number(timeoutSeconds) || 120));
        const dir = projectPath(cwd);
        return new Promise(resolve => {
            exec(command, { cwd: dir, timeout: seconds * 1000, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
                const timedOut = !!(err && err.killed);
                const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
                resolve(`Exit code: ${code}${timedOut ? ' (timed out)' : ''}\n--- stdout ---\n${String(stdout).slice(-MAX_OUTPUT_CHARS)}\n--- stderr ---\n${String(stderr).slice(-MAX_OUTPUT_CHARS)}`);
            });
        });
    }

    const pathProp = { type: 'string', description: 'Path relative to the project folder, with / separators.' };
    const TOOLS = [
        { name: 'list_files', run: listFiles, annotations: { readOnlyHint: true },
          description: "List files in the user's project folder on their computer (recursively, skipping .git and node_modules).",
          inputSchema: { type: 'object', properties: { path: { ...pathProp, description: 'Sub-folder to list; omit for the whole project.' } } } },
        { name: 'read_file', run: readFile, annotations: { readOnlyHint: true },
          description: "Read a text file from the user's project folder.",
          inputSchema: { type: 'object', properties: { path: pathProp }, required: ['path'] } },
        { name: 'write_file', run: writeFile, annotations: { readOnlyHint: false, destructiveHint: true },
          description: "Create or overwrite a file in the user's project folder with the given content. Folders are created as needed.",
          inputSchema: { type: 'object', properties: { path: pathProp, content: { type: 'string', description: 'The complete new file content.' } }, required: ['path', 'content'] } },
        { name: 'edit_file', run: editFile, annotations: { readOnlyHint: false, destructiveHint: true },
          description: 'Replace one exact snippet of a file in the project folder. old_text must appear exactly once; read the file first.',
          inputSchema: { type: 'object', properties: { path: pathProp, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
        { name: 'run_command', run: runCommand, annotations: { readOnlyHint: false, destructiveHint: true },
          description: "Run a shell command (Windows cmd) in the user's project folder and get exit code, stdout and stderr. Use it to run code, tests, builds and scripts.",
          inputSchema: { type: 'object', properties: {
              command: { type: 'string', description: 'The command line to run.' },
              cwd: { ...pathProp, description: 'Sub-folder to run in; omit for the project folder.' },
              timeout_seconds: { type: 'integer', description: `Stop after this many seconds (default 120, max ${MAX_TIMEOUT_SECONDS}).` } },
              required: ['command'] } }
    ];

    // Answers one JSON-RPC message the same way an MCP server would.
    return async function handle(msg) {
        const id = msg && msg.id;
        const ok = result => ({ jsonrpc: '2.0', id, result });
        if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
            return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
        }
        if (msg.method === 'initialize') {
            return ok({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } },
                        serverInfo: { name: 'codev-desktop', version: '1.0.0' } });
        }
        if (msg.method === 'ping') return ok({});
        if (msg.method === 'tools/list') {
            const tools = getProjectDir() ? TOOLS.map(({ run, ...t }) => t) : [];
            return ok({ tools });
        }
        if (msg.method === 'tools/call') {
            const tool = TOOLS.find(t => t.name === msg.params?.name);
            if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${msg.params?.name}` } };
            try {
                const text = await tool.run(msg.params.arguments || {});
                return ok({ content: [{ type: 'text', text }], isError: false });
            } catch (err) {
                return ok({ content: [{ type: 'text', text: err instanceof ToolError ? err.message : `${err.name}: ${err.message}` }], isError: true });
            }
        }
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    };
}

module.exports = { createMcpTools };
