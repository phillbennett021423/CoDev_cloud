// The studio's rules, kept in the project as codev-studio.json: the art direction
// (style words, negative words, palette, the default style and LoRA), saved styles,
// polygon and texture budgets for the target platform (Godot 4 mobile to start),
// naming conventions, output folders and free-text notes. Every art_ tool reads it,
// so whatever an agent (or Claude Code, Cursor over MCP) makes follows the same
// rules without being told again. It's a plain file, so it's versioned with the
// project and the user can edit it by hand.
const fs = require('fs');
const path = require('path');

const RULES_FILE = 'codev-studio.json';

const DEFAULT_RULES = {
    art_direction: {
        style_prompt: '',
        negative_prompt: 'blurry, lowres, jpeg artifacts, watermark, text, signature, deformed hands, extra limbs',
        palette: [],
        default_style: '',
        default_checkpoint: '',
        lora: null
    },
    styles: {},
    budgets: {
        platform: 'godot4-mobile',
        tris: { character: 15000, skin: 12000, weapon: 5000, vehicle: 20000, prop: 3000, environment: 30000, default: 10000 },
        texture_size: 1024,
        max_materials: 2,
        max_bones: 64,
        playable_ad_mb: 5
    },
    naming: { pattern: '{category}_{name}_{variant}', case: 'snake' },
    folders: {
        concepts: 'art/concepts', textures: 'art/textures', models: 'art/models', styles: 'art/styles',
        training: 'art/training', marketing: 'marketing', audio: 'audio'
    },
    notes: []
};

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// Deep merge where the patch wins; null deletes a key.
function merge(base, patch) {
    if (!isPlainObject(patch)) return patch;
    const out = isPlainObject(base) ? { ...base } : {};
    for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete out[k];
        else out[k] = isPlainObject(v) && isPlainObject(out[k]) ? merge(out[k], v) : v;
    }
    return out;
}

function loadRules(root) {
    if (!root) return merge(DEFAULT_RULES, {});
    const file = path.join(root, RULES_FILE);
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
        if (err.code !== 'ENOENT') throw new Error(`${RULES_FILE} isn't valid JSON (${err.message}). Fix it or delete it to start over.`);
    }
    return merge(DEFAULT_RULES, saved);
}

function saveRules(root, rules) {
    fs.writeFileSync(path.join(root, RULES_FILE), JSON.stringify(rules, null, 2) + '\n');
    return rules;
}

function words(s) {
    return String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function applyCase(parts, style) {
    if (style === 'kebab') return parts.join('-');
    if (style === 'pascal') return parts.map(p => p[0].toUpperCase() + p.slice(1)).join('');
    if (style === 'camel') return parts.map((p, i) => (i ? p[0].toUpperCase() + p.slice(1) : p)).join('');
    return parts.join('_');
}

// A file name that follows the naming rule. Empty fields are dropped with their separator.
function assetName(rules, { category = '', name = '', variant = '' } = {}) {
    const pattern = (rules.naming && rules.naming.pattern) || DEFAULT_RULES.naming.pattern;
    const style = (rules.naming && rules.naming.case) || 'snake';
    const fields = { category, name, variant };
    const parts = pattern.split(/(\{\w+\})/).filter(Boolean).map(tok => {
        const m = tok.match(/^\{(\w+)\}$/);
        return m ? words(fields[m[1]] || '') : null;
    }).filter(p => p && p.length).flat();
    return applyCase(parts.length ? parts : ['asset'], style);
}

// Whether a name already follows the naming rule.
function checkName(rules, file) {
    const base = path.basename(String(file)).replace(/\.[^.]+$/, '');
    const style = (rules.naming && rules.naming.case) || 'snake';
    const re = { snake: /^[a-z0-9]+(_[a-z0-9]+)*$/, kebab: /^[a-z0-9]+(-[a-z0-9]+)*$/, pascal: /^[A-Z][A-Za-z0-9]*$/, camel: /^[a-z][A-Za-z0-9]*$/ }[style];
    const fixed = applyCase(words(base).length ? words(base) : ['asset'], style);
    return { ok: re ? re.test(base) : true, suggestion: fixed + path.extname(String(file)) };
}

function trisBudget(rules, category) {
    const tris = (rules.budgets && rules.budgets.tris) || {};
    return Number(tris[category] || tris.default || 10000);
}

// The style words for a generation: the art direction, then a saved style.
function styleFor(rules, styleName) {
    const dir = rules.art_direction || {};
    const name = styleName === undefined ? dir.default_style : styleName;
    const style = name ? (rules.styles || {})[name] : null;
    if (name && !style) throw new Error(`No saved style "${name}". Saved styles: ${Object.keys(rules.styles || {}).join(', ') || 'none yet (art_style op "clone")'}.`);
    const palette = (style && style.palette && style.palette.length ? style.palette : dir.palette) || [];
    const lora = (style && style.lora) || dir.lora || null;
    return {
        name: name || '',
        prompt: [style && style.prompt, dir.style_prompt, lora && lora.trigger, palette.length ? `color palette ${palette.slice(0, 6).join(' ')}` : ''].filter(Boolean).join(', '),
        negative: [dir.negative_prompt, style && style.negative].filter(Boolean).join(', '),
        references: (style && style.references) || [],
        lora,
        checkpoint: (style && style.checkpoint) || dir.default_checkpoint || ''
    };
}

// A short version for tool replies, so agents keep the rules in mind.
function summary(rules) {
    const b = rules.budgets || {};
    const lines = [
        `Studio rules (${RULES_FILE}): platform ${b.platform}, textures up to ${b.texture_size}px, triangles ${Object.entries(b.tris || {}).map(([k, v]) => `${k} ${v}`).join(', ')}, naming ${rules.naming.pattern} (${rules.naming.case}).`
    ];
    if (rules.art_direction.style_prompt) lines.push(`Art direction: ${rules.art_direction.style_prompt}`);
    if (rules.art_direction.default_style) lines.push(`Default style: ${rules.art_direction.default_style}`);
    const styles = Object.keys(rules.styles || {});
    if (styles.length) lines.push(`Saved styles: ${styles.join(', ')}`);
    if ((rules.notes || []).length) lines.push(`Notes: ${rules.notes.slice(-10).map(n => `- ${n}`).join('\n')}`);
    return lines.join('\n');
}

module.exports = { RULES_FILE, DEFAULT_RULES, loadRules, saveRules, merge, assetName, checkName, trisBudget, styleFor, summary, words };
