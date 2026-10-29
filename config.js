// One place that turns the environment (and .env, through env.js) into the
// settings server.js, scripts/setup.js and the agent services use.
// loadConfig() never throws for a missing key or folder: each problem is listed
// in config.problems so the caller decides what is fatal. Key values are kept
// out of everything printable; describeConfig() shows only whether each is set.
const fs = require('fs');
const path = require('path');
const { loadEnvFile } = require('./env');

const REPO_DIR = __dirname;

// Each provider key: where it comes from, what it should look like, and whether
// CoDev can run without it. None is required: the page can use keys entered in
// Settings, so a missing one is a warning and only a malformed one is an error.
const KEYS = {
    anthropic: { env: 'ANTHROPIC_API_KEY', prefix: 'sk-ant-', label: 'Anthropic', use: 'Anthropic relay (/anthropic/v1/messages)' },
    openrouter: { env: 'OPENROUTER_API_KEY', prefix: 'sk-or-', label: 'OpenRouter', use: 'OpenRouter models' },
    manus: { env: 'MANUS_API_KEY', prefix: '', label: 'Manus', use: 'Q tasks' },
    oddsApi: { env: 'ODDS_API_KEY', prefix: '', label: 'The Odds API', use: 'free-tier market odds in the Outlier tab' },
    googleApi: { env: 'GOOGLE_API_KEY', prefix: 'AIza', label: 'Google API', use: 'YouTube and Google Maps tools' }
};

function readKey({ env, prefix, label }) {
    // Stray quotes or spaces from copy-pasting are the usual mistake; drop them.
    const raw = process.env[env];
    const key = String(raw || '').trim().replace(/^["'`]+|["'`]+$/g, '');
    if (!key) return { key: null, state: 'missing', message: `${env} is not set.` };
    // .env.example's placeholder, copied but not filled in.
    if (/your-.*-here/i.test(key)) return { key: null, state: 'missing', message: `${env} is still the example placeholder.` };
    if (prefix && !key.startsWith(prefix)) {
        return { key: null, state: 'malformed', message: `${env} does not look like an ${label} key (they start with "${prefix}"). Check for a typo.` };
    }
    if (/\s/.test(key)) return { key: null, state: 'malformed', message: `${env} contains spaces. Check for a typo.` };
    return { key, state: 'ok', message: `${env} is set.` };
}

// The project folder agents work in: the first argument (start-codev.bat passes
// it), then CODEV_WORKSPACE. Relative paths are taken from the current folder.
function resolveWorkspace(argv, problems) {
    const arg = argv.find(a => !a.startsWith('-'));
    const raw = arg || process.env.CODEV_WORKSPACE || '';
    if (!raw.trim()) return null;
    const dir = path.resolve(raw.trim().replace(/^"|"$/g, ''));
    let stat;
    try { stat = fs.statSync(dir); } catch {
        problems.push({ level: 'warn', message: `Workspace folder ${dir} does not exist; agents will have no project folder.` });
        return null;
    }
    if (!stat.isDirectory()) {
        problems.push({ level: 'warn', message: `Workspace ${dir} is a file, not a folder; agents will have no project folder.` });
        return null;
    }
    return fs.realpathSync(dir);
}

function loadConfig({ argv = process.argv.slice(2), envFile } = {}) {
    const problems = [];
    try { loadEnvFile(envFile); } catch (err) { problems.push({ level: 'error', message: err.message }); }

    const keys = {};
    for (const [name, spec] of Object.entries(KEYS)) {
        const result = readKey(spec);
        keys[name] = result;
        if (result.state === 'malformed') problems.push({ level: 'error', message: result.message });
    }

    // PORT=0 picks a free port (tests use it); server.js prints the one it got.
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        problems.push({ level: 'error', message: `PORT=${process.env.PORT} is not a port number (0-65535).` });
    }

    // Scratch space for sandboxes, staged diffs and browser profiles. Gitignored.
    const dataDir = path.resolve(process.env.CODEV_DATA_DIR || path.join(REPO_DIR, '.codev'));
    const root = resolveWorkspace(argv, problems);
    if (root && (dataDir === root || dataDir.startsWith(root + path.sep))) {
        problems.push({ level: 'warn', message: `CODEV_DATA_DIR is inside the workspace; agent scratch files will show up in your project.` });
    }

    return {
        repoDir: REPO_DIR,
        port: Number.isInteger(port) ? port : 3000,
        keys: Object.fromEntries(Object.entries(keys).map(([name, k]) => [name, k.key])),
        keyStates: Object.fromEntries(Object.entries(keys).map(([name, k]) => [name, k.state])),
        workspace: {
            root,
            dataDir,
            sandboxDir: path.join(dataDir, 'sandboxes'),
            stagingDir: path.join(dataDir, 'staging'),
            browserProfilesDir: path.join(dataDir, 'browser-profiles')
        },
        // Filled in by server.js / setup.js after probing (see scripts/checks.js).
        docker: { available: false, version: null, detail: 'not checked' },
        // The user's own "Desktop app" OAuth client for Gmail and Drive (docs/google-apps.md).
        google: {
            apiKey: keys.googleApi.key,
            clientId: String(process.env.GOOGLE_CLIENT_ID || '').trim() || null,
            clientSecret: String(process.env.GOOGLE_CLIENT_SECRET || '').trim() || null
        },
        secrets: { vaultKey: String(process.env.CODEV_VAULT_KEY || '').trim() || null },
        problems
    };
}

// Lines safe to print: key presence only, never values.
function describeConfig(config) {
    const lines = [];
    for (const [name, spec] of Object.entries(KEYS)) {
        const state = config.keyStates[name];
        const mark = state === 'ok' ? 'set' : state === 'missing' ? 'not set' : 'MALFORMED';
        lines.push(`${spec.label} key (${spec.env}): ${mark}${state === 'missing' ? ` - optional, used for ${spec.use}` : ''}`);
    }
    lines.push(`Workspace: ${config.workspace.root || 'none (pass a folder to start-codev.bat or set CODEV_WORKSPACE)'}`);
    lines.push(`Data folder: ${config.workspace.dataDir}`);
    return lines;
}

// Creates the scratch folders. Returns an error message instead of throwing.
function ensureDataDirs(config) {
    const { dataDir, sandboxDir, stagingDir, browserProfilesDir } = config.workspace;
    try {
        for (const dir of [dataDir, sandboxDir, stagingDir, browserProfilesDir]) fs.mkdirSync(dir, { recursive: true });
        return null;
    } catch (err) {
        return `Could not create ${dataDir}: ${err.message}`;
    }
}

module.exports = { loadConfig, describeConfig, ensureDataDirs, KEYS };
