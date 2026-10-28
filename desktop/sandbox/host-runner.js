// run_command without Docker: runs the command on this computer, in the agent's
// sandbox copy of the project (never the real project folder). There is no
// container around it, so CoDev's page asks the user before each command that
// isn't a plain test, build or run step, and the sandbox only runs a command
// the page marked as allowed (see index.js).
const { spawn } = require('child_process');
const path = require('path');

const MAX_TIMEOUT_SECONDS = 600;
const MAX_CAPTURE_CHARS = 200000;
// Keys and tokens in CoDev's own environment never reach an agent's command.
const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION)/i;

function cleanEnv(env = process.env) {
    const out = {};
    for (const [name, value] of Object.entries(env)) if (!SECRET_ENV.test(name)) out[name] = value;
    return out;
}

// hostDir: the staging copy; cwd: a sub-folder of it. Resolves { exitCode, stdout, stderr, timedOut }.
function runOnHost(hostDir, command, { cwd = '.', timeoutSeconds = 120 } = {}) {
    const seconds = Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Number(timeoutSeconds) || 120));
    const root = path.resolve(hostDir);
    const dir = path.resolve(root, String(cwd || '.'));
    if (dir !== root && !dir.startsWith(root + path.sep)) return Promise.reject(new Error(`cwd '${cwd}' is outside the project.`));
    return new Promise(resolve => {
        const windows = process.platform === 'win32';
        const child = spawn(command, { cwd: dir, shell: true, env: cleanEnv(), windowsHide: true, detached: !windows });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const keep = (text, chunk) => (text + chunk).slice(-MAX_CAPTURE_CHARS);
        child.stdout.on('data', chunk => { stdout = keep(stdout, chunk); });
        child.stderr.on('data', chunk => { stderr = keep(stderr, chunk); });
        // The whole process tree goes, not just the shell.
        const timer = setTimeout(() => {
            timedOut = true;
            try {
                if (windows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
                else process.kill(-child.pid, 'SIGKILL');
            } catch { /* already gone */ }
        }, seconds * 1000);
        let finished = false;
        const done = exitCode => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            resolve({ exitCode, stdout, stderr, timedOut });
        };
        child.on('error', err => { stderr += `\n${err.message}`; done(127); });
        child.on('close', code => done(code === null ? 137 : code));
    });
}

module.exports = { runOnHost, cleanEnv };
