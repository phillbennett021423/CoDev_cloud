// Probes for what the agent services need on this computer: the Docker daemon
// and Playwright's Chromium. Shared by scripts/setup.js and server.js. Nothing
// here throws; each check returns { available, ... , detail }.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const REPO_DIR = path.join(__dirname, '..');

function run(command, args, timeoutMs) {
    return new Promise(resolve => {
        execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
            resolve({ err, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
        });
    });
}

// `docker version` only checks the CLI; `docker info` needs the daemon, which
// is what fails when Docker Desktop is installed but not started.
async function checkDocker() {
    const { err, stdout, stderr } = await run('docker', ['info', '--format', '{{.ServerVersion}}'], 15000);
    if (!err && stdout) return { available: true, version: stdout, detail: `Docker ${stdout} is running.` };
    if (err && err.code === 'ENOENT') {
        return { available: false, version: null, detail: 'Docker is not installed. Agent sandboxes will be off. Get Docker Desktop from https://www.docker.com/products/docker-desktop/' };
    }
    if (err && err.killed) return { available: false, version: null, detail: 'Docker did not answer within 15 seconds. Agent sandboxes will be off.' };
    const why = (stderr.split(/\r?\n/).find(Boolean) || '').slice(0, 200);
    return { available: false, version: null, detail: `Docker is installed but its engine is not running${why ? ` (${why})` : ''}. Start Docker Desktop to turn agent sandboxes on.` };
}

// Playwright is a dependency only once the browser tools are installed, and the
// Chromium it drives is a separate download (npx playwright install chromium).
// The browser tools depend on playwright-core; plain playwright works the same.
function findPlaywright() {
    for (const name of ['playwright-core', 'playwright']) {
        try { return { name, module: require(require.resolve(name, { paths: [REPO_DIR] })) }; } catch { /* try the next */ }
    }
    return null;
}

function checkPlaywright() {
    const found = findPlaywright();
    if (!found) {
        return { installed: false, available: false, detail: 'Playwright is not installed (run "npm install"). Browser tools will be off.' };
    }
    const playwright = found.module;
    let executable = null;
    try { executable = playwright.chromium.executablePath(); } catch { /* reported below */ }
    if (executable && fs.existsSync(executable)) return { installed: true, cli: found.name, available: true, detail: 'Playwright Chromium is installed.' };
    return { installed: true, cli: found.name, available: false, detail: 'Playwright Chromium is not downloaded yet. Run "npm run setup" to get it.' };
}

module.exports = { checkDocker, checkPlaywright, REPO_DIR };
