#!/usr/bin/env node
// Gets this computer ready to run CoDev: npm run setup (start-codev.bat runs it
// for you). Safe to run again; each step skips what is already done.
//   1. Node.js version and npm dependencies
//   2. .env: created from .env.example if missing, then the keys are checked
//      (only whether each is set and well-formed; values are never printed)
//   3. Docker daemon, for agent sandboxes
//   4. Playwright Chromium, for the browser tools (npx playwright install chromium)
//   5. The .codev data folder for sandboxes, staged diffs and browser profiles
// Missing Docker or optional keys are warnings. Setup exits with code 1 only
// for problems that stop server.js itself: old Node, failed npm install, a
// malformed key or an unusable PORT.
// Options: --check (report only, install nothing), --skip-browsers.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkDocker, checkPlaywright, REPO_DIR } = require('./checks');

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check');
const SKIP_BROWSERS = args.has('--skip-browsers');
const MIN_NODE_MAJOR = 18;
const IS_WINDOWS = process.platform === 'win32';

let errors = 0;
let warnings = 0;
const ok = msg => console.log(`  [ok]   ${msg}`);
const warn = msg => { warnings++; console.log(`  [warn] ${msg}`); };
const fail = msg => { errors++; console.log(`  [fail] ${msg}`); };
const step = title => console.log(`\n${title}`);

// npm and npx are .cmd files on Windows, which need a shell to start.
function runTool(command, commandArgs) {
    const result = spawnSync(command, commandArgs, { cwd: REPO_DIR, stdio: 'inherit', shell: IS_WINDOWS });
    return result.status === 0;
}

async function main() {
    console.log(`CoDev setup${CHECK_ONLY ? ' (check only)' : ''} in ${REPO_DIR}`);

    step('1. Node.js and dependencies');
    const major = Number(process.versions.node.split('.')[0]);
    if (major < MIN_NODE_MAJOR) fail(`Node.js ${process.versions.node} is too old; install ${MIN_NODE_MAJOR} or newer from https://nodejs.org`);
    else ok(`Node.js ${process.versions.node}`);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
    const missing = Object.keys(pkg.dependencies || {}).filter(dep => !fs.existsSync(path.join(REPO_DIR, 'node_modules', dep, 'package.json')));
    if (!missing.length) ok('npm dependencies are installed');
    else if (CHECK_ONLY) warn(`Missing npm packages: ${missing.join(', ')}. Run "npm install".`);
    else {
        console.log(`  Installing ${missing.join(', ')}...`);
        if (runTool('npm', ['install', '--no-audit', '--no-fund'])) ok('npm dependencies installed');
        else fail('"npm install" failed; see the output above.');
    }

    step('2. .env and API keys');
    const envFile = path.join(REPO_DIR, '.env');
    if (!fs.existsSync(envFile)) {
        if (CHECK_ONLY) warn('No .env file. Copy .env.example to .env and add your keys.');
        else {
            fs.copyFileSync(path.join(REPO_DIR, '.env.example'), envFile);
            warn(`Created ${envFile} from .env.example. Open it and add your keys.`);
        }
    }
    // Required here, after npm install, so config.js sees a fresh environment.
    const { loadConfig, describeConfig, ensureDataDirs } = require('../config');
    const config = loadConfig({ argv: [] });
    for (const line of describeConfig(config).slice(0, -2)) {
        if (line.includes('MALFORMED')) continue; // reported as a problem below
        if (line.includes(': set')) ok(line); else warn(line);
    }
    for (const problem of config.problems) (problem.level === 'error' ? fail : warn)(problem.message);
    if (!config.keys.anthropic && !config.keys.openrouter) {
        warn('No Anthropic or OpenRouter key in .env. CoDev still runs, using keys entered in Settings.');
    }

    step('3. Docker (agent sandboxes)');
    const docker = await checkDocker();
    (docker.available ? ok : warn)(docker.detail);

    step('4. Playwright Chromium (browser tools)');
    let browser = checkPlaywright();
    if (browser.available) ok(browser.detail);
    else if (!browser.installed) warn(browser.detail);
    else if (SKIP_BROWSERS || CHECK_ONLY) warn(browser.detail);
    else {
        // --no-install: use the Playwright in node_modules, whose version the
        // Chromium build has to match, never a different one fetched by npx.
        console.log('  Downloading Chromium for Playwright (about 150 MB, once)...');
        const installed = runTool('npx', ['--no-install', browser.cli, 'install', 'chromium']);
        browser = checkPlaywright();
        if (installed && browser.available) ok(browser.detail);
        else warn('Chromium download failed. Browser tools will be off; run "npx playwright install chromium" to retry. (On Windows the browser tools can also use Edge or Chrome.)');
    }

    step('5. Data folder');
    if (CHECK_ONLY) ok(`Data folder: ${config.workspace.dataDir}${fs.existsSync(config.workspace.dataDir) ? '' : ' (created on first start)'}`);
    else {
        const err = ensureDataDirs(config);
        if (err) fail(err); else ok(`Data folder ready: ${config.workspace.dataDir}`);
    }

    console.log(`\n${errors ? `Setup found ${errors} problem(s) to fix` : 'Setup complete'}${warnings ? `, ${warnings} warning(s)` : ''}.`);
    if (!errors) console.log('Start CoDev with "npm start" or start-codev.bat.');
    process.exitCode = errors ? 1 : 0;
}

main().catch(err => {
    console.error(`Setup stopped: ${err.message}`);
    process.exitCode = 1;
});
