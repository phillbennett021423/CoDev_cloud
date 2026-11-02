// The universe bible for the art tools: a Chronicler vault (or any Markdown pages) and/or
// Story Studio's story_bible.json export, read from the project folder. When a brief
// names a character, item, place or faction (by name or alias), art_generate adds how
// it looks to the prompt, so a skin for Relay starts from Relay's canon look instead
// of whatever the model guesses. Where to look is the lore section of codev-studio.json:
//   "lore": { "sources": ["lore", "game_data/story_bible.json"], "use_in_prompts": true }
// The note format is lore-bridges.js's, shared with Story Studio in the page.
const fs = require('fs');
const path = require('path');

const Bridges = (() => {
    for (const rel of ['../www/agent-ui/lore-bridges.js', '../../mobile/www/agent-ui/lore-bridges.js']) {
        try { return require(rel); } catch { /* try the next */ }
    }
    return null;
})();

const MAX_FILES = 2000;
const MAX_FILE_BYTES = 512 * 1024;
const KNOWN = new Set(['id', 'kind', 'name', 'summary', 'tags', 'links', 'lines', 'beats', 'order']);

function walk(dir, base, out) {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
        if (out.length >= MAX_FILES) return;
        if (d.name.startsWith('.') || d.name === 'node_modules') continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) walk(full, base, out);
        else if (/\.md$/i.test(d.name)) {
            try { if (fs.statSync(full).size <= MAX_FILE_BYTES) out.push({ path: path.relative(base, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') }); } catch { /* unreadable */ }
        }
    }
}

// story_bible.json from Story Studio: fields sit at the top level of each entry.
function fromBibleJson(text) {
    const data = JSON.parse(text);
    const groups = data.entries_by_kind || {};
    const list = Array.isArray(data.entries) ? data.entries : Object.values(groups).flat();
    return list.filter(e => e && e.name).map(e => {
        const fields = Object.assign({}, e.fields || {});
        for (const [k, v] of Object.entries(e)) if (!KNOWN.has(k) && typeof v === 'string') fields[k] = v;
        return { kind: e.kind || 'lore', name: e.name, summary: e.summary || '', fields, tags: e.tags || [] };
    });
}

// Every entry from the configured sources, each with where it came from.
function loadLore(root, rules) {
    const conf = (rules && rules.lore) || {};
    const sources = [].concat(conf.sources || ['lore', 'game_data/story_bible.json']).map(String);
    const entries = [];
    const read = [];
    const problems = [];
    if (!Bridges) return { entries, read, problems: ['The lore reader (lore-bridges.js) is missing from this install.'] };
    for (const rel of sources) {
        const full = path.resolve(root, rel);
        if (!(full === root || full.startsWith(root + path.sep))) { problems.push(`${rel} is outside the project folder, so it was skipped.`); continue; }
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        try {
            if (stat.isDirectory()) {
                const files = [];
                walk(full, full, files);
                const vault = Bridges.parseVault(files);
                vault.entries.forEach(e => entries.push({ ...e, source: rel }));
                if (vault.entries.length) read.push(`${rel}/ (${vault.entries.length} notes)`);
            } else if (/\.json$/i.test(full)) {
                const list = fromBibleJson(fs.readFileSync(full, 'utf8'));
                list.forEach(e => entries.push({ ...e, source: rel }));
                if (list.length) read.push(`${rel} (${list.length} entries)`);
            } else if (/\.md$/i.test(full)) {
                const vault = Bridges.parseVault([{ path: path.basename(full), text: fs.readFileSync(full, 'utf8') }]);
                vault.entries.forEach(e => entries.push({ ...e, source: rel }));
                if (vault.entries.length) read.push(rel);
            }
        } catch (err) { problems.push(`${rel}: ${err.message}`); }
    }
    return { entries, read, problems };
}

// The look of whatever the brief names: { words, used } (words go into the prompt).
function loreHint(root, rules, text, max = 2) {
    if (!Bridges || (rules && rules.lore && rules.lore.use_in_prompts === false)) return { words: '', used: [] };
    const { entries } = loadLore(root, rules);
    const hits = Bridges.loreMatches(entries, text, ['character', 'item', 'location', 'faction', 'ability'])
        .map(e => ({ e, look: Bridges.lookFor(e) })).filter(h => h.look).slice(0, max);
    return { words: hits.map(h => `${h.e.name}: ${h.look}`).join(', '), used: hits.map(h => `${h.e.name} (${h.e.source})`) };
}

function describe(e) {
    const out = [`${e.kind}: ${e.name} (from ${e.source})`];
    if (e.summary) out.push(e.summary);
    for (const [k, v] of Object.entries(e.fields || {})) out.push(`${k.replace(/_/g, ' ')}: ${v}`);
    if (e.links && e.links.length) out.push(`relationships: ${e.links.map(l => `${l.type} ${l.to}${l.note ? ` (${l.note})` : ''}`).join('; ')}`);
    if (e.tags && e.tags.length) out.push(`tags: ${e.tags.join(', ')}`);
    return out.join('\n');
}

module.exports = { loadLore, loreHint, describe, fromBibleJson, available: !!Bridges };
