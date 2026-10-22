// Syntax checks a staged file must pass before it may be written to the real
// project. Nothing here runs the agent's code: JSON is parsed, JavaScript goes
// through `node --check`, the inline scripts of an HTML page likewise, and
// Python through ast.parse. A file type with no checker is "skipped", which
// doesn't block it; a "failed" check does.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CHECK_TIMEOUT_MS = 20000;
const CONFLICT_MARKER = /^(<{7}|>{7})( |$)/m;

function run(command, args, { input, env } = {}) {
    return new Promise(resolve => {
        let child;
        try {
            child = spawn(command, args, { env: { ...process.env, ...env }, windowsHide: true });
        } catch (err) {
            return resolve({ missing: true, error: err.message });
        }
        let stdout = '', stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), CHECK_TIMEOUT_MS);
        child.stdout.on('data', chunk => { if (stdout.length < 20000) stdout += chunk; });
        child.stderr.on('data', chunk => { if (stderr.length < 20000) stderr += chunk; });
        child.on('error', err => { clearTimeout(timer); resolve({ missing: err.code === 'ENOENT', error: err.message }); });
        child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
        if (input !== undefined) child.stdin.end(input);
        else child.stdin.end();
    });
}

// `node --check` with this process's Node. In the Windows app that's Electron,
// which acts as plain Node with ELECTRON_RUN_AS_NODE.
async function nodeCheck(source, ext) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-check-'));
    const file = path.join(dir, `check${ext}`);
    try {
        fs.writeFileSync(file, source);
        const result = await run(process.execPath, ['--check', file], { env: { ELECTRON_RUN_AS_NODE: '1' } });
        if (result.missing || result.error) return { status: 'skipped', message: `Node couldn't run: ${result.error}` };
        if (result.code === 0) return { status: 'passed' };
        // Node prints "<file>:<line>" first; show the error without our temp path.
        return { status: 'failed', message: result.stderr.split(file).join('').trim().split('\n').slice(0, 8).join('\n') };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

let pythonCommand;
async function findPython() {
    if (pythonCommand !== undefined) return pythonCommand;
    pythonCommand = null;
    for (const [cmd, args] of [['python3', []], ['python', []], ['py', ['-3']]]) {
        const result = await run(cmd, [...args, '-c', 'import sys; print(sys.version_info[0])']);
        if (result.code === 0 && result.stdout.trim() === '3') { pythonCommand = [cmd, args]; break; }
    }
    return pythonCommand;
}

async function pythonCheck(source, name) {
    const python = await findPython();
    if (!python) return { status: 'skipped', message: 'Python 3 isn\'t installed on this computer, so Python syntax wasn\'t checked.' };
    // -I: ignore the environment and the current folder, so nothing of the project is imported.
    const script = 'import ast,sys\nsrc=sys.stdin.buffer.read()\ntry:\n ast.parse(src, sys.argv[1])\nexcept SyntaxError as e:\n print(f"line {e.lineno}: {e.msg}"); sys.exit(1)';
    const result = await run(python[0], [...python[1], '-I', '-c', script, name], { input: source });
    if (result.code === 0) return { status: 'passed' };
    return { status: 'failed', message: (result.stdout || result.stderr).trim().slice(0, 1000) };
}

// Inline <script> blocks (no src) that are classic or module JavaScript.
function inlineScripts(html) {
    const scripts = [];
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let match;
    while ((match = re.exec(html))) {
        const attrs = match[1];
        if (/\bsrc\s*=/i.test(attrs)) continue;
        const type = (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1];
        if (type && !/^(module|text\/javascript|application\/javascript)$/i.test(type)) continue;
        const line = html.slice(0, match.index + match[0].indexOf('>') + 1).split('\n').length;
        scripts.push({ code: match[2], module: /^module$/i.test(type || ''), line });
    }
    return scripts;
}

async function htmlCheck(source) {
    const scripts = inlineScripts(source);
    if (!scripts.length) return { status: 'skipped', message: 'No inline scripts to check.' };
    for (const script of scripts) {
        // Pad with newlines so Node's line numbers match the HTML file.
        const result = await nodeCheck('\n'.repeat(script.line - 1) + script.code, script.module ? '.mjs' : '.js');
        if (result.status === 'failed') return { status: 'failed', message: `Inline <script> starting on line ${script.line}:\n${result.message}` };
        if (result.status === 'skipped') return result;
    }
    return { status: 'passed', message: `${scripts.length} inline script(s) checked.` };
}

// { status: 'passed' | 'failed' | 'skipped', message? } for one file's new content.
async function validateFile(relPath, content) {
    if (content === null) return { status: 'skipped', message: 'Deleted.' };
    if (typeof content !== 'string') return { status: 'skipped', message: 'Binary file.' };
    const conflict = CONFLICT_MARKER.exec(content);
    if (conflict) {
        return { status: 'failed', message: `Unresolved merge conflict marker on line ${content.slice(0, conflict.index).split('\n').length}.` };
    }
    const ext = path.extname(relPath).toLowerCase();
    if (ext === '.json') {
        try { JSON.parse(content); return { status: 'passed' }; } catch (err) { return { status: 'failed', message: err.message }; }
    }
    if (ext === '.js') {
        // A .js file may be an ES module (package.json "type": "module").
        const result = await nodeCheck(content, '.js');
        return result.status === 'failed' && (await nodeCheck(content, '.mjs')).status === 'passed' ? { status: 'passed' } : result;
    }
    if (ext === '.cjs' || ext === '.mjs') return nodeCheck(content, ext);
    if (ext === '.html' || ext === '.htm') return htmlCheck(content);
    if (ext === '.py') return pythonCheck(content, relPath);
    return { status: 'skipped', message: `No syntax checker for ${ext || 'files without an extension'}.` };
}

module.exports = { validateFile, inlineScripts };
