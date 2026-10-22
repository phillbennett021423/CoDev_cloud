// Reads settings for server.js from the environment. A .env file next to this one
// is loaded first if it exists (it's gitignored; copy .env.example to start one).
// Variables already set in the environment win over the file.
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '.env');

function loadEnvFile(file = ENV_FILE) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
        if (err.code === 'ENOENT') return;
        throw new Error(`Could not read ${file}: ${err.message}`);
    }
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;
        let value = match[2];
        if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
        else value = value.replace(/\s+#.*$/, '');
        if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
}

// Returns { key } or { error } so the caller decides whether a missing key is fatal.
// The key itself is never logged.
function readAnthropicKey() {
    const key = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!key) {
        return { error: 'ANTHROPIC_API_KEY is not set. Put it in a .env file next to server.js '
            + '(copy .env.example) or set it in your environment, then restart.' };
    }
    if (!key.startsWith('sk-ant-')) {
        return { error: 'ANTHROPIC_API_KEY does not look like an Anthropic key (they start with "sk-ant-"). '
            + 'Check for a typo or stray quotes, then restart.' };
    }
    return { key };
}

// The Manus API key for Q tasks, from MANUS_API_KEY. It's optional: without it
// the page can still use a key entered in Settings. Never logged.
function readManusKey() {
    return String(process.env.MANUS_API_KEY || '').replace(/[\s"'`]+/g, '');
}

module.exports = { loadEnvFile, readAnthropicKey, readManusKey };
