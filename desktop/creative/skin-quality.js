// The visible-first rules for skins: what art_skin_pipeline holds every skin to.
//
// A player judges a skin by what they can see: the face, the hair, the outer armour and
// clothing, the hands, the weapon, and the back and underside of the model. Those have
// to look perfect; geometry nobody can see is low priority. This file turns that rule
// into things the tools can act on:
//
//   briefOf(args)                 the structured brief (theme, palette, materials,
//                                 silhouette changes, reference pictures) as one text
//   conceptPrompt / materialPrompt / negativeWords
//                                 the generation words, visible-first words included
//   problemsFrom(report, rules)   what a Blender review (art_mesh op "review") found that
//                                 a player would notice, each with the fix to try
//   PASSES, nextPass(state)       the approval passes: concept, mesh, textures, FX/SFX
//
// Pure functions, so they're tested without Blender or ComfyUI. The numbers live in
// codev-studio.json under skin_quality (rules.js has the defaults).
const PASSES = ['concept', 'mesh', 'textures', 'fx'];
const PASS_NAMES = { concept: 'concept art', mesh: 'mesh', textures: 'textures', fx: 'effects and sounds' };
const BRIEF_KEYS = ['brief', 'theme', 'palette', 'materials', 'silhouette', 'references', 'reference_views', 'character', 'slot', 'variants', 'tier', 'rarity', 'material', 'stages', 'style',
    'tile_scale', 'texture_size', 'sfx', 'stats', 'tags', 'category', 'godot_dir', 'remesh', 'concepts', 'install'];

const list = v => [].concat(v === undefined || v === null || v === '' ? [] : v).map(String).map(s => s.trim()).filter(Boolean);

// The brief as one text, from the user's words plus the structured fields.
function briefOf(s) {
    const parts = [String(s.brief || '').trim()];
    if (s.theme) parts.push(`Theme: ${s.theme}`);
    if (list(s.palette).length) parts.push(`Colour palette: ${list(s.palette).join(', ')}`);
    if (list(s.materials).length) parts.push(`Materials: ${list(s.materials).join(', ')}`);
    if (s.silhouette) parts.push(`Silhouette changes: ${s.silhouette}`);
    return parts.filter(Boolean).join('. ');
}

function conceptPrompt(s, q, variant = '', feedback = '') {
    return [briefOf(s), variant, feedback ? `Changes asked for: ${feedback}` : '',
        'full character turnaround, front and back visible, head to toe including hands and feet', q.prompt_words].filter(Boolean).join(', ');
}

function materialPrompt(s, variant = '', feedback = '') {
    const mats = s.material || list(s.materials).join(', ') || String(s.brief || '');
    return [mats, list(s.palette).length ? `palette ${list(s.palette).join(' ')}` : '', variant, feedback].filter(Boolean).join(', ');
}

function negativeWords(q) { return q.negative_words || ''; }

// What a review found that a player would notice. Each problem says what's wrong in plain
// words, and fix names the art_mesh op the pipeline tries (none: it needs a person or a
// new picture).
function problemsFrom(report, q, { textured = false, budget = 0 } = {}) {
    const lim = q.limits || {};
    const m = report.mesh_checks || {};
    const imgs = report.image_checks || {};
    const out = [];
    const add = (code, message, fix = '') => out.push({ code, message, fix });
    if (m.visible_open_edges > (lim.max_open_edges ?? 0)) add('holes', `${m.visible_open_edges} open edges where a player can see them (holes, gaps or unclosed seams)`, 'cleanup');
    if (m.nonmanifold_edges > (lim.max_nonmanifold_edges ?? 0)) add('nonmanifold', `${m.nonmanifold_edges} tangled edges (more than two faces meet), which shade badly`, 'cleanup');
    if (m.flipped_visible > (lim.max_flipped ?? 0.005)) add('flipped', `${pct(m.flipped_visible)} of the visible surface faces inward (it shows up dark or see-through)`, 'cleanup');
    if ((m.meshes_without_uvs || []).length) add('no_uv', `no UVs on ${m.meshes_without_uvs.join(', ')}, so textures can't sit right`, 'uv');
    if (m.uv_stretched_visible > (lim.max_uv_stretch ?? 0.05)) add('uv_stretch', `${pct(m.uv_stretched_visible)} of the visible surface has stretched or squashed texture`, 'uv');
    if (budget && report.triangles > budget) add('over_budget', `${report.triangles} triangles is over the ${budget} budget`, 'cleanup');
    for (const [view, c] of Object.entries(imgs)) {
        if (c.coverage < (lim.min_coverage ?? 0.005)) add('empty_view', `the ${view} view is almost empty (the model may be tiny, huge or off-centre)`);
        if (textured && c.missing_texture > (lim.max_missing_texture ?? 0.002)) add('missing_texture', `pink "missing texture" patches in the ${view} view`, 'texture');
    }
    const face = imgs.face;
    if (textured && face && face.coverage >= 0.05 && face.detail < (lim.min_face_detail ?? 0.00005)) add('soft_face', 'the face close-up looks flat or blurry (texture too soft there)');
    return out;
}

function pct(x) { return `${Math.round(Number(x) * 1000) / 10}%`; }

// A short report: the problems, and how much of the budget is spent where nobody looks.
function reviewSummary(report, problems) {
    const m = report.mesh_checks || {};
    const lines = [problems.length ? `${problems.length} problem(s) a player would notice:` : 'Passed: nothing a player would notice from any angle.'];
    for (const p of problems) lines.push(`- ${p.message}${p.fix ? ` (fix: art_mesh op "${p.fix}")` : ' (needs a look: fix it by hand, with art_edit, or redo the pass with feedback)'}`);
    if (m.hidden_tris) lines.push(`${m.hidden_tris} of ${m.hidden_tris + (m.visible_tris || 0)} triangles can't be seen from any angle; art_mesh op "cleanup" with drop_hidden true frees them for the parts players see.`);
    return lines.join('\n');
}

// The first pass that isn't approved yet ('' when every pass is).
function nextPass(state) {
    return PASSES.find(p => !['approved', 'skipped'].includes(((state.passes || {})[p] || {}).status)) || '';
}

module.exports = { PASSES, PASS_NAMES, BRIEF_KEYS, list, briefOf, conceptPrompt, materialPrompt, negativeWords, problemsFrom, reviewSummary, nextPass };
