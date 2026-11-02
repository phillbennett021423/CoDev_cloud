// CoDev's art pipeline for game skins and assets: what a platform like Layer does,
// built from free, open-source tools that run on the user's own computer.
//
//   Layer 1  identity      style LoRAs (kohya), edit LoRAs from before/after pairs
//                          (ai-toolkit), caption review, settings picked for you,
//                          instant style clones from a few reference pictures
//   Layer 2  2D concepts   every model installed in ComfyUI, several directions at
//                          once, inpainting, virtual try-on, sketch-to-image
//   Layer 3  3D surfaces   batches of tileable material concepts, PBR maps, weathering
//                          from factory-fresh to ruined; in Blender: remesh to a poly
//                          budget, UV unwrap, PBR baking, rigging, animation retargeting
//   Layer 4  marketing     playable ads (MRAID HTML), reframing to every ad size,
//                          cutouts, 2x/4x upscaling, voice lines, voice filters, sound
//                          effects, consented voice cloning
//   Layer 5  bridge        codev-studio.json (studio rules every tool follows) and
//                          codev-mcp.js, which hands all of this to Claude Code or Cursor
//
//   createCreativeService({ getProjectDir, log, env, fetchImpl }) ->
//     { name, tools, callTool(name, args), handleMcp(message, next), status(), close() }
//
// Like desktop/gamedev, the Windows app adds these tools over codev:browser-mcp
// (handleMcp) and server.js loads agents/creative, which wraps this. Every file read
// or written is inside the project folder. Nothing here uploads anything: ComfyUI,
// Blender, Python and the trainers all run on the same computer, and the only
// online call is the free Pollinations picture service when ComfyUI isn't running.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createComfy, graphs, sizeFor, pickCheckpoint, samplerFor } = require('./comfy');
const R = require('./rules');
const L = require('./lore');
const T = require('./training');
const { buildPlayable, TEMPLATES } = require('./playable');

const ART_TOOLS = path.join(__dirname, 'python', 'art_tools.py');
const BPY_PIPELINE = path.join(__dirname, 'bpy', 'asset_pipeline.py');
const POLLINATIONS = 'https://image.pollinations.ai/prompt/';
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };

const ASPECT_PRESETS = {
    mobile_vertical: '9:16', story: '9:16', tiktok: '9:16', square: '1:1', feed: '4:5', portrait: '4:5',
    widescreen: '16:9', youtube: '16:9', banner: '191:100', twitter_header: '3:1', store_feature: '1024:500', ultrawide: '21:9'
};
const VOICE_FX = {
    robot: "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75,aecho=0.8:0.88:6:0.4",
    mech: "asetrate=44100*0.86,aresample=44100,atempo=1.163,afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75,acrusher=bits=8:mix=0.25,aecho=0.8:0.7:12:0.35,highpass=f=90,lowpass=f=6500",
    radio: 'highpass=f=300,lowpass=f=3400,acrusher=bits=10:mix=0.2,volume=1.6',
    helmet: 'aecho=0.8:0.9:8|14:0.5|0.3,lowpass=f=5000,highpass=f=120',
    hologram: 'chorus=0.6:0.9:50|60:0.4|0.32:0.25|0.4:2|2.3,aphaser,highpass=f=200',
    demon: 'asetrate=44100*0.7,aresample=44100,atempo=1.428,aecho=0.8:0.8:40:0.4,lowpass=f=4000',
    giant: 'asetrate=44100*0.8,aresample=44100,atempo=1.25,aecho=0.8:0.6:60:0.3',
    tiny: 'asetrate=44100*1.35,aresample=44100,atempo=0.74',
    cave: 'aecho=0.8:0.85:120|240:0.4|0.25'
};

function text(value, isError = false, extra = []) {
    return { content: [{ type: 'text', text: String(value) }, ...extra], ...(isError ? { isError: true } : {}) };
}

function slug(s, max = 40) {
    return R.words(s).join('_').slice(0, max).replace(/_+$/, '') || 'asset';
}

function isFile(file) { try { return fs.statSync(file).isFile(); } catch { return false; } }
function isDir(dir) { try { return fs.statSync(dir).isDirectory(); } catch { return false; } }

function onPath(names, env) {
    const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const dir of dirs) for (const name of names) for (const ext of exts) if (isFile(path.join(dir, name + ext))) return path.join(dir, name + ext);
    return '';
}

// A Python inside a tool's own folder (its venv), else the system one.
function venvPython(dir) {
    for (const rel of ['venv/Scripts/python.exe', '.venv/Scripts/python.exe', 'venv/bin/python', '.venv/bin/python']) if (isFile(path.join(dir, rel))) return path.join(dir, rel);
    return '';
}

// Keys and tokens from CoDev's own environment never reach the tools it runs.
function childEnv(env, extra = {}) {
    const clean = {};
    for (const [k, v] of Object.entries(env)) if (!/(KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE)/i.test(k)) clean[k] = v;
    return { ...clean, ...extra };
}

function exec(file, args, { cwd, env, timeoutMs = 300000, input } = {}) {
    return new Promise(resolve => {
        let out = '';
        let child;
        try { child = spawn(file, args, { cwd, env, windowsHide: true }); } catch (err) { return resolve({ code: -1, output: err.message, missing: true }); }
        const timer = setTimeout(() => { child.kill(); out += `\n[stopped after ${Math.round(timeoutMs / 1000)} s]`; }, timeoutMs);
        child.stdout.on('data', d => { out += d; if (out.length > 4e6) out = out.slice(-2e6); });
        child.stderr.on('data', d => { out += d; if (out.length > 4e6) out = out.slice(-2e6); });
        child.on('error', err => { clearTimeout(timer); resolve({ code: -1, output: err.message, missing: err.code === 'ENOENT' }); });
        child.on('close', code => { clearTimeout(timer); resolve({ code, output: out }); });
        if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    });
}

function createCreativeService({ getProjectDir = () => '', log = () => {}, env = process.env, fetchImpl = globalThis.fetch, comfy: comfyClient, findBlender } = {}) {
    const comfy = comfyClient || createComfy({ url: env.CODEV_COMFYUI_URL, fetchImpl });
    const jobs = T.createJobs({ log });
    findBlender = findBlender || (() => require('../gamedev').findBlender(env));
    let pythonCmd = null;

    // ---------- folders and files ----------

    function root() {
        const dir = getProjectDir();
        if (!dir || !isDir(dir)) throw new Error('No project folder is open, so there is nowhere to read or save art. Open (connect) the game\'s project folder first.');
        return path.resolve(dir);
    }

    // A path inside the project (no "..", no hidden folders), or an error.
    function inProject(rel, { mustExist = false, label = 'path' } = {}) {
        const base = root();
        const raw = String(rel || '').replace(/^res:\/\//, '').replace(/\\/g, '/');
        const full = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);
        if (!raw || !(full === base || full.startsWith(base + path.sep)) || path.relative(base, full).split(path.sep).some(p => p === '..' || p.startsWith('.'))) {
            throw new Error(`${label} must be inside the project folder (got "${rel}").`);
        }
        if (mustExist && !fs.existsSync(full)) throw new Error(`There's no ${raw} in the project folder.`);
        return full;
    }

    function relOf(file) { return path.relative(root(), file).split(path.sep).join('/'); }

    function rules() { return R.loadRules(root()); }

    function folder(key, ...sub) {
        const r = rules();
        const dir = inProject(path.join((r.folders && r.folders[key]) || R.DEFAULT_RULES.folders[key], ...sub));
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    // Pictures from a list of paths and/or folders.
    function imagesFrom(list, { label = 'images' } = {}) {
        const out = [];
        for (const item of [].concat(list || [])) {
            const full = inProject(item, { mustExist: true, label });
            if (isDir(full)) out.push(...T.listImages(full));
            else out.push(full);
        }
        return out;
    }

    // A data: URL (the sketch pad sends one) saved into the project.
    function saveDataUrl(dataUrl, dir, name) {
        const m = String(dataUrl).match(/^data:image\/(png|jpe?g|webp);base64,([\s\S]+)$/);
        if (!m) throw new Error('image_data must be a data:image/png;base64,... URL.');
        const file = path.join(dir, `${name}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
        fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
        return file;
    }

    function dataUri(file) {
        const mime = MIME[path.extname(file).toLowerCase()];
        if (!mime) throw new Error(`${path.basename(file)} isn't a picture CoDev can inline (PNG, JPEG, WebP, GIF).`);
        return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
    }

    // ---------- helpers that run other programs ----------

    async function python() {
        if (pythonCmd) return pythonCmd;
        const candidates = env.CODEV_PYTHON ? [env.CODEV_PYTHON] : process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
        for (const c of candidates) {
            const r = await exec(c, ['-c', 'import sys; print(sys.version_info[0])'], { timeoutMs: 20000, env: childEnv(env) });
            if (r.code === 0 && /3/.test(r.output)) { pythonCmd = c; return c; }
        }
        throw new Error('Python 3 wasn\'t found. Install it free from python.org (tick "Add to PATH"), then run: pip install numpy pillow');
    }

    async function py(cmd, args, timeoutMs = 600000) {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-art-'));
        const argFile = path.join(work, 'args.json');
        fs.writeFileSync(argFile, JSON.stringify(args));
        try {
            const r = await exec(await python(), ['-I', ART_TOOLS, cmd, argFile], { timeoutMs, env: childEnv(env) });
            const line = r.output.trim().split(/\r?\n/).reverse().find(l => l.startsWith('{'));
            let result;
            try { result = JSON.parse(line); } catch { throw new Error(`art_tools ${cmd} failed: ${r.output.trim().slice(-800)}`); }
            if (!result.ok) throw new Error(result.error);
            return result;
        } finally { fs.rmSync(work, { recursive: true, force: true }); }
    }

    // One contact sheet of what was made, as a picture the agent (and user) can see.
    async function preview(files, labels = []) {
        if (!files.length) return [];
        try {
            const out = path.join(os.tmpdir(), `codev-sheet-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`);
            await py('contact', { items: files.slice(0, 16).map((f, i) => ({ path: f, label: labels[i] || path.basename(f) })), output: out, thumb: files.length > 6 ? 240 : 320 });
            const data = fs.readFileSync(out).toString('base64');
            fs.rmSync(out, { force: true });
            return [{ type: 'image', data, mimeType: 'image/jpeg' }];
        } catch (err) { log(`Preview: ${err.message}`); return []; }
    }

    async function comfyUp() { return comfy.reachable(); }

    async function uploadToComfy(file) { return comfy.upload(fs.readFileSync(file), `${Date.now().toString(36)}_${path.basename(file).replace(/[^\w.-]/g, '_')}`); }

    async function styleRefsFor(style, models, warnings) {
        if (!style.references.length) return [];
        if (!models.ipadapter) { warnings.push(`Style "${style.name}" has reference pictures, but ComfyUI has no IP-Adapter nodes (install ComfyUI_IPAdapter_plus through ComfyUI Manager), so only its words and palette were used.`); return []; }
        const refs = [];
        for (const rel of style.references.slice(0, 4)) {
            try { refs.push(await uploadToComfy(inProject(rel, { mustExist: true }))); } catch (err) { warnings.push(`Skipped style reference ${rel}: ${err.message}`); }
        }
        return refs;
    }

    function lorasFor(style, extra, models, warnings) {
        const list = [];
        for (const l of [style.lora, ...[].concat(extra || [])]) {
            if (!l) continue;
            const want = typeof l === 'string' ? { name: l } : l;
            const hit = models.loras.find(n => n === want.name) || models.loras.find(n => n.toLowerCase().includes(String(want.name).toLowerCase().replace(/\.safetensors$/, '')));
            if (hit) list.push({ name: hit, weight: want.weight ?? 0.8 });
            else warnings.push(`LoRA "${want.name}" isn't in ComfyUI's models/loras folder; generated without it.`);
        }
        return list;
    }

    async function pollinations(prompt, { width, height, seed, model = 'flux' }) {
        const q = new URLSearchParams({ width: String(width), height: String(height), seed: String(seed), model, nologo: 'true', private: 'true' });
        for (let attempt = 0; attempt < 2; attempt++) {
            const response = await fetchImpl(`${POLLINATIONS}${encodeURIComponent(prompt.slice(0, 1500))}?${q}`);
            if (response.status === 429 && attempt === 0) { await new Promise(r => setTimeout(r, 20000)); continue; }
            if (!response.ok) throw new Error(`the free picture service answered HTTP ${response.status}`);
            return Buffer.from(await response.arrayBuffer());
        }
        throw new Error('the free picture service is busy; try again in a minute');
    }

    function seedOf(seed, i = 0) { return (Number.isFinite(Number(seed)) ? Number(seed) : Math.floor(Math.random() * 2 ** 31)) + i; }

    // ---------- Layer 5: studio rules ----------

    async function artRules({ op = 'get', patch, note, category, name, variant, file } = {}) {
        const dir = root();
        const r = rules();
        if (op === 'get') return text(`${R.summary(r)}\n\n${JSON.stringify(r, null, 2)}`);
        if (op === 'set') {
            if (!patch || typeof patch !== 'object') return text('op "set" needs patch: the parts of the rules to change, e.g. {"budgets": {"tris": {"skin": 9000}}}. null removes a key.', true);
            const saved = R.saveRules(dir, R.merge(r, patch));
            return text(`Saved ${R.RULES_FILE}.\n${R.summary(saved)}`);
        }
        if (op === 'note') {
            if (!String(note || '').trim()) return text('op "note" needs note: a rule in plain words.', true);
            r.notes = [...(r.notes || []), String(note).trim()];
            R.saveRules(dir, r);
            return text(`Noted. Studio notes now:\n${r.notes.map(n => `- ${n}`).join('\n')}`);
        }
        if (op === 'name') {
            if (file) { const c = R.checkName(r, file); return text(c.ok ? `${file} follows the naming rule.` : `${file} doesn't follow the naming rule (${r.naming.pattern}, ${r.naming.case}); try ${c.suggestion}.`); }
            return text(R.assetName(r, { category, name, variant }));
        }
        return text(`Unknown op "${op}". Ops: get, set, note, name.`, true);
    }

    // ---------- status ----------

    function tools_found() {
        const kohya = env.CODEV_KOHYA_DIR && isFile(path.join(env.CODEV_KOHYA_DIR, 'sdxl_train_network.py')) ? env.CODEV_KOHYA_DIR : '';
        const aitk = env.CODEV_AITOOLKIT_DIR && isFile(path.join(env.CODEV_AITOOLKIT_DIR, 'run.py')) ? env.CODEV_AITOOLKIT_DIR : '';
        return {
            kohya, aitk,
            blender: (() => { try { return findBlender(); } catch { return ''; } })(),
            realesrgan: (env.CODEV_REALESRGAN_PATH && isFile(env.CODEV_REALESRGAN_PATH) ? env.CODEV_REALESRGAN_PATH : '') || onPath(['realesrgan-ncnn-vulkan'], env),
            piper: (env.CODEV_PIPER_PATH && isFile(env.CODEV_PIPER_PATH) ? env.CODEV_PIPER_PATH : '') || onPath(['piper'], env),
            ffmpeg: (env.CODEV_FFMPEG_PATH && isFile(env.CODEV_FFMPEG_PATH) ? env.CODEV_FFMPEG_PATH : '') || onPath(['ffmpeg'], env),
            tts: (env.CODEV_TTS_PATH && isFile(env.CODEV_TTS_PATH) ? env.CODEV_TTS_PATH : '') || onPath(['tts'], env)
        };
    }

    async function artStatus() {
        const lines = [];
        const t = tools_found();
        let models = null;
        try { models = await comfy.models(); } catch (err) { lines.push(`ComfyUI: not running at ${comfy.url} (${err.message}). Pictures fall back to free Pollinations; inpainting, try-on, sketches and AI reframing need ComfyUI (free: github.com/comfyanonymous/ComfyUI, or the ComfyUI Desktop app). Set CODEV_COMFYUI_URL if it runs elsewhere.`); }
        if (models) {
            lines.push(`ComfyUI: running at ${comfy.url}. ${models.checkpoints.length} checkpoint(s)${models.checkpoints.length ? `: ${models.checkpoints.slice(0, 12).join(', ')}` : ' (put .safetensors models in ComfyUI/models/checkpoints)'}.`);
            lines.push(`  LoRAs ${models.loras.length}, ControlNets ${models.controlnets.length}, upscalers ${models.upscalers.length}, IP-Adapter ${models.ipadapter ? 'yes' : 'no (ComfyUI_IPAdapter_plus adds style references and try-on references)'}.`);
        }
        try { const info = await py('info', {}, 60000); lines.push(`Python: ${await python()} with numpy and Pillow${info.have.rembg ? ' and rembg' : '; cutouts need: pip install rembg'}.`); } catch (err) { lines.push(`Python tools: ${err.message}`); }
        lines.push(`Blender: ${t.blender || 'not found (free from blender.org; set CODEV_BLENDER_PATH)'}; art_mesh needs it.`);
        lines.push(`LoRA training: kohya sd-scripts ${t.kohya || 'not set (CODEV_KOHYA_DIR = the sd-scripts folder, github.com/kohya-ss/sd-scripts)'}; ai-toolkit ${t.aitk || 'not set (CODEV_AITOOLKIT_DIR, github.com/ostris/ai-toolkit) for FLUX and edit LoRAs'}.`);
        lines.push(`Upscaling: ${t.realesrgan ? `Real-ESRGAN at ${t.realesrgan}` : models && models.upscalers.length ? 'ComfyUI upscale models' : 'basic resize only (Real-ESRGAN ncnn is free: github.com/xinntao/Real-ESRGAN/releases; set CODEV_REALESRGAN_PATH)'}.`);
        lines.push(`Voice: Piper ${t.piper || 'not found (free: github.com/rhasspy/piper; set CODEV_PIPER_PATH and CODEV_PIPER_VOICES)'}; FFmpeg ${t.ffmpeg || 'not found (voice filters need it)'}; Coqui TTS for consented cloning ${t.tts || 'not found (pip install coqui-tts)'}.`);
        try { lines.push(R.summary(rules())); } catch (err) { lines.push(err.message); }
        lines.push(`Running training: ${[...jobs.running.keys()].join(', ') || 'none'}.`);
        return text(lines.join('\n'));
    }

    // ---------- Layer 2: concepts ----------

    async function artModels() {
        const m = await comfy.models();
        return text(JSON.stringify({ checkpoints: m.checkpoints, loras: m.loras, controlnets: m.controlnets, upscalers: m.upscalers, ipadapter: m.ipadapter,
            settings: Object.fromEntries(m.checkpoints.map(c => [c, samplerFor(c)])) }, null, 2));
    }

    async function artGenerate(args = {}) {
        const prompt = String(args.prompt || '').trim();
        if (!prompt) return text('art_generate needs a prompt (the brief: what the skin or asset is).', true);
        const r = rules();
        const style = R.styleFor(r, args.style);
        const directions = [].concat(args.directions || []).map(String).filter(Boolean).slice(0, 8);
        const count = Math.min(Math.max(Number(args.count) || (directions.length ? 1 : 2), 1), 8);
        const warnings = [];
        const made = [];
        const labels = [];
        const name = args.name || prompt;
        const dir = args.out_dir ? inProject(args.out_dir) : folder('concepts', slug(name));
        fs.mkdirSync(dir, { recursive: true });
        // Canon looks from the universe bible for whoever the brief names (args.lore false skips it).
        const lore = args.lore === false || args.tileable ? { words: '', used: [] } : L.loreHint(root(), r, `${prompt} ${args.lore_subject || ''}`);
        if (lore.used.length) warnings.push(`Lore: added the look of ${lore.used.join(', ')} from the universe bible (lore false skips it).`);
        const fullPrompt = d => [prompt, d, lore.words, style.prompt, args.tileable ? 'seamless tileable texture, flat even lighting, top-down, no shadows' : ''].filter(Boolean).join(', ');
        const negative = [style.negative, args.negative].filter(Boolean).join(', ');
        const variants = directions.length ? directions : [''];
        if (await comfyUp()) {
            const models = await comfy.models();
            if (!models.checkpoints.length) return text('ComfyUI is running but has no checkpoints. Put a model (.safetensors) in ComfyUI/models/checkpoints, e.g. FLUX.1-schnell (Apache 2.0) or an SDXL model, then try again.', true);
            let ckpts = [].concat(args.models || []).map(String);
            if (ckpts.includes('all')) ckpts = models.checkpoints.filter(c => !/inpaint|refiner/i.test(c)).slice(0, 6);
            else ckpts = ckpts.length ? ckpts.slice(0, 6).map(w => pickCheckpoint(models.checkpoints, w)) : [pickCheckpoint(models.checkpoints, style.checkpoint)];
            if (variants.length * ckpts.length * count > 24) return text(`That's ${variants.length * ckpts.length * count} pictures; the limit for one call is 24. Use fewer directions, models or count.`, true);
            const refs = await styleRefsFor(style, models, warnings);
            const loras = lorasFor(style, args.lora, models, warnings);
            for (const ck of [...new Set(ckpts)]) {
                const s = samplerFor(ck);
                const { width, height } = args.width && args.height ? { width: Number(args.width), height: Number(args.height) } : sizeFor(args.aspect || '1:1', s.size);
                for (const [vi, d] of variants.entries()) {
                    const graph = graphs.txt2img({ checkpoint: ck, prompt: fullPrompt(d), negative, width, height, seed: seedOf(args.seed, vi), loras, styleRefs: refs, styleWeight: Number(args.style_strength) || 0.6, count });
                    const pics = await comfy.run(graph);
                    pics.forEach((buf, i) => {
                        const file = path.join(dir, `${R.assetName(r, { category: args.category || 'concept', name: slug(name, 24), variant: `${d ? `d${vi + 1}` : ''}${slug(ck.replace(/\.\w+$/, ''), 14)}_${i + 1}` })}.png`);
                        fs.writeFileSync(file, buf);
                        made.push(file);
                        labels.push(`${d ? `${d.slice(0, 18)} · ` : ''}${ck.replace(/\.\w+$/, '').slice(0, 20)}`);
                    });
                }
            }
        } else {
            const services = [].concat(args.models || []).map(String).filter(m => ['flux', 'turbo'].includes(m));
            const list = services.length ? services : ['flux'];
            if (variants.length * list.length * count > 8) return text('Without ComfyUI the free picture service is slow (one picture every 15 to 45 s), so one call makes at most 8. Use fewer directions or count, or start ComfyUI.', true);
            warnings.push('ComfyUI isn\'t running, so these came from the free Pollinations service (FLUX) without the studio\'s LoRAs or style references. Start ComfyUI for the full pipeline.');
            for (const svc of list) for (const [vi, d] of variants.entries()) for (let i = 0; i < count; i++) {
                const { width, height } = sizeFor(args.aspect || '1:1', 1024);
                const buf = await pollinations(fullPrompt(d), { width, height, seed: seedOf(args.seed, vi * 10 + i), model: svc });
                const file = path.join(dir, `${R.assetName(r, { category: args.category || 'concept', name: slug(name, 24), variant: `${d ? `d${vi + 1}` : ''}${svc}_${i + 1}` })}.jpg`);
                fs.writeFileSync(file, buf);
                made.push(file);
                labels.push(`${d ? `${d.slice(0, 18)} · ` : ''}${svc}`);
            }
        }
        if (args.tileable) for (const f of made) { try { await py('seamless', { input: f, output: f.replace(/\.\w+$/, '.png') }); } catch (err) { warnings.push(`Tiling ${path.basename(f)}: ${err.message}`); } }
        const result = text([`Made ${made.length} picture(s) in ${relOf(dir)}:`, ...made.map(f => `- ${relOf(f)}`), ...warnings.map(w => `Note: ${w}`)].join('\n'), false, args.no_preview ? [] : await preview(made, labels));
        result.structuredContent = { files: made.map(relOf), warnings };
        return result;
    }

    async function inputImage(args, key = 'image') {
        // image_name reuses one file (the live sketch pad), instead of a new one per stroke.
        if (args[`${key}_data`]) return saveDataUrl(args[`${key}_data`], folder('concepts', 'sketches'), args[`${key}_name`] ? slug(args[`${key}_name`], 30) : `${key}_${Date.now().toString(36)}`);
        if (!args[key]) throw new Error(`${key} is needed: a picture in the project folder (or ${key}_data, a data URL).`);
        return inProject(args[key], { mustExist: true, label: key });
    }

    async function needComfy(what) {
        if (!(await comfyUp())) throw new Error(`${what} needs ComfyUI running on this computer (${comfy.url}). It's free: github.com/comfyanonymous/ComfyUI or the ComfyUI Desktop app. Start it, or set CODEV_COMFYUI_URL.`);
        const models = await comfy.models();
        if (!models.checkpoints.length) throw new Error('ComfyUI has no checkpoints; put a model in ComfyUI/models/checkpoints.');
        return models;
    }

    async function artEdit(args = {}) {
        const mode = args.mode || (args.mask || args.mask_box ? 'inpaint' : 'img2img');
        if (!['inpaint', 'img2img', 'sketch'].includes(mode)) return text('mode is inpaint, img2img or sketch.', true);
        const prompt = String(args.prompt || '').trim();
        if (!prompt) return text('art_edit needs a prompt: what the changed part should be (e.g. "glowing cyan visor") or, for sketches, what the sketch is.', true);
        const models = await needComfy(mode === 'sketch' ? 'Sketch-to-image' : 'Editing');
        const r = rules();
        const style = R.styleFor(r, args.style);
        const warnings = [];
        const src = await inputImage(args);
        const ck = pickCheckpoint(models.checkpoints, args.checkpoint || (mode === 'sketch' && args.fast ? 'turbo' : style.checkpoint), mode === 'inpaint' ? 'inpaint' : mode === 'sketch' && args.fast ? 'fast' : 'general');
        const loras = lorasFor(style, args.lora, models, warnings);
        const refs = await styleRefsFor(style, models, warnings);
        const image = await uploadToComfy(src);
        let mask = '';
        let tmpMask = '';
        if (mode === 'inpaint') {
            if (args.mask) mask = await uploadToComfy(inProject(args.mask, { mustExist: true, label: 'mask' }));
            else if (args.mask_box) {
                tmpMask = path.join(os.tmpdir(), `codev-mask-${Date.now()}.png`);
                const boxes = Array.isArray(args.mask_box[0]) ? args.mask_box : [args.mask_box];
                await py('box_mask', { input: src, boxes, output: tmpMask, feather: 8 });
                mask = await uploadToComfy(tmpMask);
            } else return text('Inpainting needs mask (a black-and-white picture, white = change) or mask_box [x, y, width, height] as fractions of the picture (0 to 1).', true);
        }
        const fullPrompt = [prompt, style.prompt].filter(Boolean).join(', ');
        const negative = [style.negative, args.negative].filter(Boolean).join(', ');
        let graph;
        if (mode === 'sketch') {
            const size = T.imageSize(src) || { width: 1024, height: 1024 };
            const dims = sizeFor(`${size.width}:${size.height}`, samplerFor(ck).size);
            const cn = args.controlnet ? models.controlnets.find(c => c.includes(args.controlnet)) : models.controlnets.find(c => /scribble|lineart|sketch|union/i.test(c));
            if (!cn) warnings.push('No scribble/lineart ControlNet in ComfyUI/models/controlnet, so the sketch was redrawn with img2img (looser). A free one: xinsir controlnet-union-sdxl or controlnet-scribble-sdxl.');
            graph = graphs.sketch({ checkpoint: ck, prompt: fullPrompt, negative, image, controlnet: cn, strength: Number(args.strength) || 0.85, seed: seedOf(args.seed), loras, styleRefs: refs, ...dims });
        } else {
            graph = graphs.edit({ checkpoint: ck, prompt: fullPrompt, negative, image, mask, denoise: Number(args.denoise) || (mode === 'inpaint' ? 0.9 : 0.55), seed: seedOf(args.seed), loras, styleRefs: refs });
        }
        const pics = await comfy.run(graph);
        if (tmpMask) fs.rmSync(tmpMask, { force: true });
        const out = args.output ? inProject(args.output) : path.join(folder('concepts', 'edits'), `${path.basename(src).replace(/\.\w+$/, '')}_${mode}${args.image_name ? '' : `_${Date.now().toString(36)}`}.png`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, pics[0]);
        const result = text([`${mode === 'sketch' ? 'Redrew the sketch' : mode === 'inpaint' ? 'Changed the masked area' : 'Reworked the picture'} with ${ck}: ${relOf(out)}`, ...warnings.map(w => `Note: ${w}`)].join('\n'), false, args.no_preview ? [] : await preview([src, out], ['before', 'after']));
        result.structuredContent = { file: relOf(out), dataUrl: args.return_data ? dataUri(out) : undefined };
        return result;
    }

    async function artTryOn(args = {}) {
        const models = await needComfy('Try-on');
        const r = rules();
        const style = R.styleFor(r, args.style);
        const warnings = [];
        const character = await inputImage(args, 'character');
        const region = args.region || 'outfit';
        const maskFile = path.join(os.tmpdir(), `codev-tryon-${Date.now()}.png`);
        if (args.mask) fs.copyFileSync(inProject(args.mask, { mustExist: true }), maskFile);
        else await py('region_mask', { input: character, region, output: maskFile, grow: Number(args.grow) || 14 });
        let refs = [];
        if (args.outfit_image) {
            const outfit = inProject(args.outfit_image, { mustExist: true, label: 'outfit_image' });
            if (models.ipadapter) refs = [await uploadToComfy(outfit)];
            else warnings.push('ComfyUI has no IP-Adapter nodes, so the outfit picture couldn\'t be copied directly; the outfit was drawn from outfit_prompt. Install ComfyUI_IPAdapter_plus for picture-to-picture try-on.');
        }
        const prompt = [args.outfit_prompt || 'the outfit from the reference', 'worn by the character, same pose, same body, fitted to the silhouette', style.prompt].filter(Boolean).join(', ');
        if (!args.outfit_prompt && !refs.length) return text('Try-on needs outfit_prompt (describe the armour/garment) or outfit_image with IP-Adapter installed.', true);
        const ck = pickCheckpoint(models.checkpoints, args.checkpoint || style.checkpoint, 'inpaint');
        const graph = graphs.edit({ checkpoint: ck, prompt, negative: style.negative, image: await uploadToComfy(character), mask: await uploadToComfy(maskFile),
            denoise: Number(args.denoise) || 0.88, seed: seedOf(args.seed), loras: lorasFor(style, args.lora, models, warnings), styleRefs: refs, styleWeight: 0.85, refWeightType: 'standard' });
        const pics = await comfy.run(graph);
        const out = args.output ? inProject(args.output) : path.join(folder('concepts', 'try_on'), `${path.basename(character).replace(/\.\w+$/, '')}_${slug(args.outfit_prompt || path.basename(args.outfit_image || 'outfit'), 20)}_${Date.now().toString(36)}.png`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, pics[0]);
        const sheet = await preview([character, maskFile, out], ['base', `mask (${region})`, 'try-on']);
        fs.rmSync(maskFile, { force: true });
        return text([`Put the outfit on the character (${region}) with ${ck}: ${relOf(out)}`, ...warnings.map(w => `Note: ${w}`)].join('\n'), false, sheet);
    }

    // ---------- Layer 1: styles and training ----------

    async function artStyle(args = {}) {
        const op = args.op || 'list';
        const dir = root();
        const r = rules();
        if (op === 'list') {
            const list = Object.entries(r.styles || {});
            return text(list.length ? list.map(([n, s]) => `- ${n}${n === r.art_direction.default_style ? ' (default)' : ''}: ${s.prompt || ''}${s.lora ? ` · LoRA ${s.lora.name}` : ''} · ${s.references.length} reference(s) · palette ${(s.palette || []).join(' ')}`).join('\n') : 'No saved styles yet. art_style op "clone" makes one from a few reference pictures.');
        }
        const name = slug(args.name || '', 30);
        if (!args.name) return text('A style needs a name.', true);
        if (op === 'delete') {
            if (!r.styles[name]) return text(`No style "${name}".`, true);
            delete r.styles[name];
            if (r.art_direction.default_style === name) r.art_direction.default_style = '';
            R.saveRules(dir, r);
            return text(`Deleted style "${name}" (its reference pictures are still in ${r.folders.styles}/${name}).`);
        }
        if (op === 'set_default') {
            if (!r.styles[name]) return text(`No style "${name}".`, true);
            r.art_direction.default_style = name;
            R.saveRules(dir, r);
            return text(`"${name}" is now the default style for every generation.`);
        }
        if (op !== 'clone' && op !== 'update') return text('op is clone, update, list, set_default or delete.', true);
        const refs = imagesFrom(args.references || [], { label: 'references' }).slice(0, 12);
        if (op === 'clone' && !refs.length) return text('Cloning a style needs references: 2 to 8 pictures (or a folder) that show the look.', true);
        const styleDir = folder('styles', name);
        const kept = refs.map((f, i) => {
            const dest = path.join(styleDir, `ref_${String(i + 1).padStart(2, '0')}${path.extname(f).toLowerCase()}`);
            if (path.resolve(f) !== path.resolve(dest)) fs.copyFileSync(f, dest);
            return relOf(dest);
        });
        let look = {};
        if (refs.length) look = await py('palette', { inputs: refs, count: 6 });
        const prev = r.styles[name] || {};
        r.styles[name] = {
            prompt: args.description || prev.prompt || '',
            negative: args.negative || prev.negative || '',
            references: kept.length ? kept : prev.references || [],
            palette: look.palette || prev.palette || [],
            look: look.palette ? { brightness: look.brightness, saturation: look.saturation, contrast: look.contrast } : prev.look,
            lora: args.lora ? { name: args.lora, weight: args.lora_weight ?? 0.8, trigger: args.trigger || '' } : prev.lora || null,
            checkpoint: args.checkpoint || prev.checkpoint || '',
            created: prev.created || new Date().toISOString()
        };
        if (args.set_default) r.art_direction.default_style = name;
        R.saveRules(dir, r);
        let ip = false;
        try { ip = (await comfy.models()).ipadapter; } catch { /* not running */ }
        return text([
            `Saved style "${name}" with ${r.styles[name].references.length} reference picture(s) in ${relOf(styleDir)}; palette ${r.styles[name].palette.join(' ')}.`,
            r.styles[name].prompt ? `Words: ${r.styles[name].prompt}` : 'Tip: add description (the look in words: line weight, shading, materials, mood) so it also works without IP-Adapter. Look at the reference pictures and describe them.',
            ip ? 'ComfyUI has IP-Adapter, so generations with style "' + name + '" copy the look from the pictures directly.' : 'ComfyUI\'s IP-Adapter isn\'t available, so the style applies through its words and palette until a LoRA is trained (art_lora_train).',
            `Use it with art_generate style "${name}"${args.set_default ? ' (it\'s the default now)' : ''}.`
        ].join('\n'), false, await preview(refs.slice(0, 8)));
    }

    function runDir(name) { return folder('training', slug(name, 40)); }

    function readRun(name) {
        const dir = runDir(name);
        try { return { dir, run: JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) }; } catch { return { dir, run: null }; }
    }

    function datasetImages(run, dir) {
        if (run.kind === 'edit') return T.listImages(path.join(dir, 'dataset', 'after'));
        const ds = path.join(dir, 'dataset');
        const sub = isDir(ds) ? fs.readdirSync(ds).find(n => /^\d+_/.test(n)) : '';
        return sub ? T.listImages(path.join(ds, sub)) : [];
    }

    function datasetFolder(run, dir) {
        if (run.kind === 'edit') return path.join(dir, 'dataset', 'after');
        const ds = path.join(dir, 'dataset');
        const sub = isDir(ds) ? fs.readdirSync(ds).find(n => /^\d+_/.test(n)) : '';
        return sub ? path.join(ds, sub) : ds;
    }

    async function artCaptions(args = {}) {
        if (!args.run) return text('Which training run? Pass run (its name from art_lora_train op "prepare").', true);
        const { dir, run } = readRun(args.run);
        if (!run) return text(`No training run "${args.run}". Make one with art_lora_train op "prepare".`, true);
        const op = args.op || 'review';
        const images = datasetImages(run, dir);
        const imgDir = datasetFolder(run, dir);
        if (op === 'set') {
            const caps = args.captions && typeof args.captions === 'object' ? args.captions : null;
            if (!caps) return text('op "set" needs captions: {"file name": "caption", ...}.', true);
            let n = 0;
            for (const [file, cap] of Object.entries(caps)) {
                const img = images.find(f => path.basename(f) === path.basename(file) || path.basename(f).replace(/\.\w+$/, '') === path.basename(file).replace(/\.\w+$/, ''));
                if (!img) continue;
                let c = String(cap).trim().replace(/\s+/g, ' ');
                if (run.trigger && !c.toLowerCase().includes(run.trigger.toLowerCase())) c = `${run.trigger}, ${c}`;
                fs.writeFileSync(img.replace(/\.[^.]+$/, '.txt'), c + '\n');
                n++;
            }
            if (!n) return text(`None of those file names are in the dataset. Files: ${images.map(f => path.basename(f)).join(', ')}`, true);
            args.op = 'review';
        } else if (op === 'auto') {
            const t = tools_found();
            if (!t.kohya) return text(`Automatic captions use kohya's BLIP captioner (set CODEV_KOHYA_DIR). Without it, look at each picture yourself and write captions with op "set". Pictures: ${images.map(f => relOf(f)).join(', ')}`, true);
            const r2 = await exec(venvPython(t.kohya) || await python(), [path.join(t.kohya, 'finetune', 'make_captions.py'), imgDir, '--caption_extension', '.txt', '--batch_size', '1', '--max_length', '60'], { cwd: t.kohya, env: childEnv(env), timeoutMs: 1800000 });
            if (r2.code !== 0) return text(`The captioner failed:\n${r2.output.slice(-1500)}`, true);
            for (const img of images) {
                const capFile = img.replace(/\.[^.]+$/, '.txt');
                let c = isFile(capFile) ? fs.readFileSync(capFile, 'utf8').trim() : '';
                if (run.trigger && c && !c.toLowerCase().includes(run.trigger.toLowerCase())) fs.writeFileSync(capFile, `${run.trigger}, ${c}\n`);
            }
        } else if (op !== 'review') return text('op is review, auto or set.', true);
        const review = T.reviewCaptions({ images, trigger: run.trigger, kind: run.kind, minSize: run.settings.trainer === 'kohya' && run.base === 'sd15' ? 512 : 768, pairs: run.pairs });
        const caps = images.slice(0, 40).map(f => { const c = f.replace(/\.[^.]+$/, '.txt'); return `- ${path.basename(f)}: ${isFile(c) ? fs.readFileSync(c, 'utf8').trim() : '(none)'}`; });
        return text([`${run.name}: ${review.captioned}/${review.total} captioned, ${review.ready ? 'ready to train' : 'not ready yet'}.`,
            review.issues.length ? `Issues:\n${review.issues.slice(0, 40).map(i => `- [${i.level}] ${i.file}: ${i.problem}`).join('\n')}` : 'No issues found.',
            `Captions:\n${caps.join('\n')}`].join('\n\n'));
    }

    async function artLoraTrain(args = {}) {
        const op = args.op || 'status';
        if (!args.name) return text('A training run needs a name (it becomes the LoRA\'s file name).', true);
        const name = slug(args.name, 40);
        if (op === 'prepare') {
            const kind = args.kind || 'style';
            const base = args.base || (kind === 'edit' ? 'kontext' : 'sdxl');
            const spec = T.BASES[base];
            if (!spec) return text(`base is one of ${Object.keys(T.BASES).join(', ')}.`, true);
            if (kind === 'edit' && !spec.edit) return text('Edit LoRAs learn from before/after pairs; use base "kontext" (FLUX.1 Kontext dev) or "qwen-edit" (Qwen-Image-Edit, Apache 2.0).', true);
            const trigger = String(args.trigger || (kind === 'edit' ? '' : `${name.replace(/_/g, '')}style`)).trim();
            const dir = runDir(name);
            fs.rmSync(path.join(dir, 'dataset'), { recursive: true, force: true });
            let pairs = null;
            let count;
            if (kind === 'edit') {
                const after = imagesFrom(args.after || [], { label: 'after' });
                const before = imagesFrom(args.before || [], { label: 'before' });
                if (!after.length || !before.length) return text('An edit LoRA needs after (the finished pictures) and before (the same pictures before your pass), matched by file name.', true);
                const key = f => path.basename(f).replace(/\.[^.]+$/, '').toLowerCase();
                const byName = new Map(before.map(f => [key(f), f]));
                fs.mkdirSync(path.join(dir, 'dataset', 'after'), { recursive: true });
                fs.mkdirSync(path.join(dir, 'dataset', 'before'), { recursive: true });
                pairs = { matched: 0, missing: [] };
                for (const a of after) {
                    const b = byName.get(key(a));
                    if (!b) { pairs.missing.push(path.basename(a)); continue; }
                    const stem = `pair_${String(++pairs.matched).padStart(3, '0')}`;
                    fs.copyFileSync(a, path.join(dir, 'dataset', 'after', stem + path.extname(a).toLowerCase()));
                    fs.copyFileSync(b, path.join(dir, 'dataset', 'before', stem + path.extname(a).toLowerCase()));
                    const cap = a.replace(/\.[^.]+$/, '.txt');
                    fs.writeFileSync(path.join(dir, 'dataset', 'after', `${stem}.txt`), (isFile(cap) ? fs.readFileSync(cap, 'utf8').trim() : String(args.instruction || 'apply the studio finishing pass')) + '\n');
                }
                count = pairs.matched;
            } else {
                const imgs = imagesFrom(args.images || [], { label: 'images' });
                if (!imgs.length) return text('A style or character LoRA needs images: the studio\'s pictures (a folder or a list), 20 to 60 is best.', true);
                count = imgs.length;
                const settings0 = T.autoSettings({ base, kind, images: count, vramGb: Number(args.vram_gb) || 12 });
                const classWord = slug(args.class_word || (kind === 'character' ? 'character' : 'illustration'), 20);
                const sub = spec.trainer === 'kohya' ? `${settings0.repeats}_${trigger} ${classWord}` : 'images';
                const target = path.join(dir, 'dataset', sub);
                fs.mkdirSync(target, { recursive: true });
                imgs.forEach((f, i) => {
                    const stem = `img_${String(i + 1).padStart(3, '0')}`;
                    fs.copyFileSync(f, path.join(target, stem + path.extname(f).toLowerCase()));
                    const cap = f.replace(/\.[^.]+$/, '.txt');
                    if (isFile(cap)) {
                        let c = fs.readFileSync(cap, 'utf8').trim();
                        if (trigger && !c.toLowerCase().includes(trigger.toLowerCase())) c = `${trigger}, ${c}`;
                        fs.writeFileSync(path.join(target, `${stem}.txt`), c + '\n');
                    }
                });
            }
            const settings = { ...T.autoSettings({ base, kind, images: count, vramGb: Number(args.vram_gb) || 12 }), ...(args.settings || {}) };
            const run = { name, kind, base, trigger, style: args.style ? slug(args.style, 30) : name, settings, pairs, images: count, model_path: args.model_path || '', created: new Date().toISOString() };
            fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
            const review = await artCaptions({ run: name, op: 'review' });
            return text([`Prepared "${name}" (${kind} LoRA on ${base}, ${spec.trainer}) with ${count} ${kind === 'edit' ? 'pair(s)' : 'picture(s)'} in ${relOf(dir)}.`,
                `Settings picked for you: ${JSON.stringify(settings)}`,
                trigger ? `Trigger word: ${trigger}` : '',
                'Next: fix the captions (art_captions op "auto", or look at each picture and op "set"), then op "start".',
                review.content[0].text].filter(Boolean).join('\n\n'));
        }
        const { dir, run } = readRun(name);
        if (!run) return text(`No training run "${name}". Use op "prepare" first.`, true);
        if (op === 'status') {
            const s = jobs.status(name, dir);
            if (!s) return text(`"${name}" is prepared but hasn't started. Settings: ${JSON.stringify(run.settings)}`);
            const p = s.progress;
            return text([`"${name}": ${s.status}${p ? `, step ${p.step} of ${p.total} (${Math.round(p.step / p.total * 100)}%)${p.loss != null ? `, loss ${p.loss}` : ''}` : ''}. Started ${s.started}${s.ended ? `, ended ${s.ended}` : ''}.`,
                s.lora ? `LoRA: ${s.lora}${s.copiedTo ? ` (copied to ${s.copiedTo})` : ''}` : '', s.afterError ? `After training: ${s.afterError}` : '', `Log (${relOf(path.join(dir, 'train.log'))}):\n${s.tail}`].filter(Boolean).join('\n'));
        }
        if (op === 'cancel') return text(jobs.cancel(name) ? `Stopping "${name}".` : `"${name}" isn't running.`);
        if (op !== 'start') return text('op is prepare, start, status or cancel.', true);
        const images = datasetImages(run, dir);
        const review = T.reviewCaptions({ images, trigger: run.trigger, kind: run.kind, pairs: run.pairs });
        if (!review.ready && !args.force) return text(`Not started: the dataset has problems. Run art_captions op "review" and fix them, or pass force true.\n${review.issues.filter(i => i.level === 'error').slice(0, 15).map(i => `- ${i.file}: ${i.problem}`).join('\n')}`, true);
        const t = tools_found();
        const out = path.join(dir, 'output');
        fs.mkdirSync(out, { recursive: true });
        const settings = { ...run.settings, ...(args.settings || {}) };
        let cmd;
        if (settings.trainer === 'kohya') {
            if (!t.kohya) return text('kohya sd-scripts isn\'t set up. Install it free (github.com/kohya-ss/sd-scripts, follow its README to make the venv), then set CODEV_KOHYA_DIR to that folder and restart CoDev.', true);
            let model = args.model_path || run.model_path;
            if (model && !path.isAbsolute(model) && env.CODEV_COMFYUI_DIR) model = path.join(env.CODEV_COMFYUI_DIR, 'models', 'checkpoints', model);
            if (!model || !isFile(model)) return text(`kohya needs model_path: the base ${run.base === 'sdxl' ? 'SDXL' : 'SD 1.5'} checkpoint file (.safetensors) on this computer${env.CODEV_COMFYUI_DIR ? ', or the name of one in ComfyUI/models/checkpoints' : ''}.`, true);
            cmd = T.kohyaCommand({ kohyaDir: t.kohya, python: venvPython(t.kohya) || await python(), settings, modelPath: model, dataDir: path.join(dir, 'dataset'), outDir: out, name });
        } else {
            if (!t.aitk) return text('ai-toolkit isn\'t set up. Install it free (github.com/ostris/ai-toolkit, follow its README), set CODEV_AITOOLKIT_DIR to that folder and restart CoDev. FLUX models download from Hugging Face the first time (FLUX.1-dev and Kontext-dev need you to accept their licence there; Qwen-Image-Edit is Apache 2.0).', true);
            const config = T.aiToolkitConfig({ settings, name, trigger: run.trigger, afterDir: run.kind === 'edit' ? path.join(dir, 'dataset', 'after') : datasetFolder(run, dir),
                beforeDir: run.kind === 'edit' ? path.join(dir, 'dataset', 'before') : '', outDir: out, modelPath: args.model_path || run.model_path, samplePrompts: args.sample_prompts || [] });
            fs.writeFileSync(path.join(dir, 'config.yaml'), config);
            cmd = { file: venvPython(t.aitk) || await python(), args: ['run.py', path.join(dir, 'config.yaml')], cwd: t.aitk };
        }
        const state = jobs.start(name, {
            ...cmd, dir, env: childEnv(env, { PYTHONUNBUFFERED: '1' }),
            onDone: async () => {
                const found = [];
                const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.safetensors$/.test(e.name)) found.push(f); } };
                walk(out);
                found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
                const final = found.find(f => path.basename(f) === `${name}.safetensors`) || found[0];
                if (!final) return { afterError: 'no .safetensors was written' };
                const result = { lora: relOf(final) };
                const loraName = `${name}.safetensors`;
                if (env.CODEV_COMFYUI_DIR) {
                    const dest = path.join(env.CODEV_COMFYUI_DIR, 'models', 'loras', 'codev', loraName);
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    fs.copyFileSync(final, dest);
                    result.copiedTo = dest;
                }
                const r = rules();
                r.styles[run.style] = { ...(r.styles[run.style] || { prompt: '', references: [], palette: [] }), lora: { name: env.CODEV_COMFYUI_DIR ? `codev/${loraName}` : loraName, weight: 0.8, trigger: run.trigger } };
                R.saveRules(root(), r);
                return result;
            }
        });
        return text([`Started training "${name}" (${settings.trainer}, about ${settings.steps} steps) in the background. PID ${state.pid}.`,
            'Check it with op "status". When it finishes, the LoRA is saved to the run\'s output folder' + (env.CODEV_COMFYUI_DIR ? ', copied into ComfyUI/models/loras/codev' : ' (set CODEV_COMFYUI_DIR so CoDev copies it into ComfyUI)') + `, and style "${run.style}" uses it.`].join('\n'));
    }

    // ---------- Layer 3: materials and surfaces ----------

    async function artMaterials(args = {}) {
        const list = [].concat(args.materials || []).map(String).filter(Boolean);
        const theme = String(args.theme || '').trim();
        const count = Math.min(Math.max(Number(args.count) || list.length || 8, 1), 40);
        const items = list.length ? list.slice(0, 40) : theme ? Array.from({ length: count }, (_, i) => `${theme}, variation ${i + 1}`) : [];
        if (!items.length) return text('art_materials needs materials (e.g. ["alien chitin", "battle-scarred steel", "carbon-fibre weave"]) or a theme and count.', true);
        const r = rules();
        const style = R.styleFor(r, args.style === undefined ? '' : args.style);
        const size = Math.min(Number(args.size) || r.budgets.texture_size || 1024, 2048);
        const useComfy = await comfyUp();
        if (!useComfy && items.length > 8) return text('Without ComfyUI, one call makes at most 8 materials (the free service is slow). Start ComfyUI for batches of up to 40.', true);
        const models = useComfy ? await comfy.models() : null;
        const ck = models ? pickCheckpoint(models.checkpoints, args.checkpoint || style.checkpoint, items.length > 12 ? 'fast' : 'general') : '';
        const warnings = useComfy ? [] : ['Made with the free Pollinations service because ComfyUI isn\'t running.'];
        const loras = models ? lorasFor(style, args.lora, models, warnings) : [];
        const made = [];
        const labels = [];
        for (const [i, m] of items.entries()) {
            const prompt = `seamless tileable texture of ${m}, flat even lighting, orthographic top-down, PBR albedo, no shadows, no perspective, highly detailed surface${style.prompt ? `, ${style.prompt}` : ''}`;
            const dir = folder('textures', slug(m, 32));
            const file = path.join(dir, `${slug(m, 32)}_source.png`);
            let buf;
            if (useComfy) {
                const s = samplerFor(ck);
                buf = (await comfy.run(graphs.txt2img({ checkpoint: ck, prompt, negative: style.negative, width: s.size, height: s.size, seed: seedOf(args.seed, i), loras })))[0];
            } else buf = await pollinations(prompt, { width: 1024, height: 1024, seed: seedOf(args.seed, i) });
            fs.writeFileSync(file, buf);
            const tiled = path.join(dir, `${slug(m, 32)}_tile.png`);
            await py('seamless', { input: file, output: tiled });
            if (args.pbr !== false) {
                await py('pbr', { input: tiled, out_dir: dir, name: slug(m, 32), size, metal_from_color: /metal|steel|iron|chrome|gold|copper|brass|alloy|plating/i.test(m) });
                made.push(path.join(dir, `${slug(m, 32)}_albedo.png`));
            } else made.push(tiled);
            labels.push(m.slice(0, 28));
        }
        const sets = items.map(m => {
            const d = folder('textures', slug(m, 32));
            const s = slug(m, 32);
            const f = k => (isFile(path.join(d, `${s}_${k}.png`)) ? relOf(path.join(d, `${s}_${k}.png`)) : undefined);
            return { material: m, dir: relOf(d), albedo: f('albedo') || relOf(path.join(d, `${s}_tile.png`)), normal: f('normal'), roughness: f('roughness'), metallic: f('metallic'), ao: f('ao'), curvature: f('curvature'), orm: f('orm'), emission: f('emissive') };
        });
        const result = text([`Made ${items.length} material concept(s)${args.pbr !== false ? ' with full PBR sets (albedo, normal, roughness, metallic, ao, height, curvature, ORM for Godot)' : ''} in ${relOf(folder('textures'))}:`,
            ...items.map(m => `- ${slug(m, 32)}/`), ...warnings.map(w => `Note: ${w}`), 'art_weathering ages any of them from factory-fresh to ruined.'].join('\n'), false, args.no_preview ? [] : await preview(made, labels));
        result.structuredContent = { sets, warnings };
        return result;
    }

    async function artPbrMaps(args = {}) {
        const src = inProject(args.image, { mustExist: true, label: 'image' });
        const r = rules();
        const name = slug(args.name || path.basename(src).replace(/\.\w+$/, ''), 40);
        const dir = args.out_dir ? inProject(args.out_dir) : folder('textures', name);
        const size = Number(args.size) || 0;
        const warnings = [];
        if (size > r.budgets.texture_size) warnings.push(`${size}px is over the studio's ${r.budgets.texture_size}px texture budget (${r.budgets.platform}).`);
        const res = await py('pbr', { input: src, out_dir: dir, name, size, seamless: Boolean(args.seamless), metallic: args.metallic_mask ? inProject(args.metallic_mask, { mustExist: true }) : Number(args.metallic) || 0,
            metal_from_color: Boolean(args.metal_from_color), normal_format: args.normal_format === 'dx' ? 'dx' : 'gl', roughness_bias: Number(args.roughness_bias) || 0, normal_strength: Number(args.normal_strength) || 2, delight: args.delight ?? 0.5 });
        const files = Object.entries(res.files);
        if (!size && Math.max(...res.size) > r.budgets.texture_size) warnings.push(`The maps are ${res.size.join('×')}, over the ${r.budgets.texture_size}px budget; pass size ${r.budgets.texture_size}.`);
        return text([`PBR maps for ${name} in ${relOf(dir)} (normal map ${args.normal_format === 'dx' ? 'DirectX' : 'OpenGL, as Godot and Blender expect'}):`, ...files.map(([k, f]) => `- ${k}: ${relOf(f)}`),
            'In Godot: albedo → Albedo, normal → Normal Map, orm → ORM (StandardMaterial3D → ORMMaterial3D), emissive → Emission.', ...warnings.map(w => `Note: ${w}`)].join('\n'), false, await preview(files.map(f => f[1]), files.map(f => f[0])));
    }

    async function artWeathering(args = {}) {
        const albedo = inProject(args.albedo, { mustExist: true, label: 'albedo' });
        const opt = k => (args[k] ? inProject(args[k], { mustExist: true, label: k }) : undefined);
        const base = path.basename(albedo).replace(/_albedo(\.\w+)$|\.\w+$/, '');
        // Missing maps next to the albedo (from art_pbr_maps or art_mesh bake) are found automatically.
        const sib = k => { const f = albedo.replace(/_albedo(\.\w+)$/, `_${k}$1`); return f !== albedo && isFile(f) ? f : undefined; };
        const name = slug(args.name || base, 40);
        const dir = args.out_dir ? inProject(args.out_dir) : path.join(path.dirname(albedo), 'weathered');
        const stages = [].concat(args.stages || ['factory', 'light', 'worn', 'battle', 'ruined']);
        const res = await py('weather', { albedo, roughness: opt('roughness') || sib('roughness'), metallic: opt('metallic') || sib('metallic'), ao: opt('ao') || sib('ao'), curvature: opt('curvature') || sib('curvature'),
            out_dir: dir, name, stages, seed: Number(args.seed) || 7, overrides: args.overrides || {} });
        const albedos = Object.entries(res.stages).map(([s, f]) => [s, f.albedo]);
        const result = text([`Weathered ${name} into ${stages.length} stage(s) in ${relOf(dir)}:`, ...Object.entries(res.stages).map(([s, f]) => `- ${s}: ${Object.values(f).map(relOf).join(', ')}`),
            'Each stage has albedo, roughness, metallic and a Godot ORM map; normal and height maps stay the same.', 'overrides tunes a stage: {"battle": {"rust": 0.6, "scorch": 0.2}} (edge, scratch, rust, scorch, grime, dust, 0 to 1).'].join('\n'), false, args.no_preview ? [] : await preview(albedos.map(a => a[1]), albedos.map(a => a[0])));
        result.structuredContent = { stages: Object.fromEntries(Object.entries(res.stages).map(([s, f]) => [s, Object.fromEntries(Object.entries(f).map(([k, v]) => [k, relOf(v)]))])) };
        return result;
    }

    async function artMesh(args = {}) {
        const op = args.op;
        if (!['inspect', 'cleanup', 'uv', 'bake', 'texture', 'rig', 'retarget'].includes(op)) return text('op is inspect, cleanup, uv, bake, texture, rig or retarget.', true);
        const blender = findBlender();
        if (!blender) return text('Blender isn\'t installed where CoDev can find it. It\'s free from blender.org; or set CODEV_BLENDER_PATH.', true);
        const r = rules();
        const input = inProject(args.input, { mustExist: true, label: 'input' });
        const category = args.category || 'skin';
        const budget = R.trisBudget(r, category);
        const stem = path.basename(input).replace(/\.\w+$/, '');
        const outName = args.output ? inProject(args.output) : path.join(folder('models'), `${R.assetName(r, { category, name: args.name || stem.replace(new RegExp(`^${category}_`), ''), variant: { cleanup: 'lod0', uv: 'uv', bake: '', texture: 'textured', rig: 'rigged', retarget: 'anim' }[op] || '' })}.glb`);
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-mesh-'));
        const job = { op, input, result: path.join(work, 'result.json') };
        if (op !== 'inspect') job.output = outName;
        if (op === 'cleanup') Object.assign(job, { target_tris: Number(args.target_tris) || budget, remesh: Boolean(args.remesh), remesh_resolution: Number(args.remesh_resolution) || 256, smooth_angle: Number(args.smooth_angle) || 40 });
        if (op === 'uv') Object.assign(job, { margin: Number(args.margin) || 0.01, keep_existing: Boolean(args.keep_existing) });
        if (op === 'bake') {
            const size = Math.min(Number(args.size) || r.budgets.texture_size, 4096);
            Object.assign(job, { high_poly: args.high_poly ? inProject(args.high_poly, { mustExist: true, label: 'high_poly' }) : '', size, maps: args.maps, samples: Number(args.samples) || 16,
                out_dir: path.join(folder('textures'), slug(args.name || stem, 40)), name: slug(args.name || stem, 40), cage_extrusion: Number(args.cage_extrusion) || 0.02, gpu: args.gpu !== false });
        }
        if (op === 'texture') {
            const maps = args.maps && typeof args.maps === 'object' ? args.maps : null;
            if (!maps || !maps.albedo) { fs.rmSync(work, { recursive: true, force: true }); return text('texture needs maps: {albedo, normal, roughness, metallic, ao, emission} (paths, e.g. from art_materials or art_weathering).', true); }
            const full = {};
            for (const [k, v] of Object.entries(maps)) if (v) full[k] = inProject(v, { mustExist: true, label: `maps.${k}` });
            Object.assign(job, { maps: full, tile_scale: Number(args.tile_scale) || 1, name: slug(args.name || stem, 40) });
        }
        if (op === 'rig') {
            if (!args.base) { fs.rmSync(work, { recursive: true, force: true }); return text('Rigging needs base: the base character (.glb/.fbx) with its skeleton and body.', true); }
            Object.assign(job, { base: inProject(args.base, { mustExist: true, label: 'base' }), method: args.method, keep_body: Boolean(args.keep_body) });
        }
        if (op === 'retarget') {
            if (!args.animations) { fs.rmSync(work, { recursive: true, force: true }); return text('Retargeting needs animations: a .glb/.fbx whose skeleton has the motions (e.g. Mixamo clips).', true); }
            Object.assign(job, { animations: inProject(args.animations, { mustExist: true, label: 'animations' }), bone_map: args.bone_map, actions: args.actions });
        }
        const jobFile = path.join(work, 'job.json');
        fs.writeFileSync(jobFile, JSON.stringify(job));
        const run = await exec(blender, ['--background', '--factory-startup', '--python-exit-code', '1', '--python', BPY_PIPELINE, '--', jobFile], { cwd: work, env: childEnv(env), timeoutMs: Math.min(Number(args.timeout_seconds) || 900, 3600) * 1000 });
        let report;
        try { report = JSON.parse(fs.readFileSync(job.result, 'utf8')); } catch { report = { ok: false, error: `Blender stopped before finishing (exit ${run.code}).`, trace: run.output.slice(-2000) }; }
        fs.rmSync(work, { recursive: true, force: true });
        if (!report.ok) return text(`Blender ${op} failed: ${report.error}\n${report.trace || ''}`, true);
        const lines = [];
        if (report.output) lines.push(`Saved ${relOf(report.output)}.`);
        if (report.before_triangles) lines.push(`Triangles: ${report.before_triangles} → ${report.triangles}.`);
        else if (report.triangles !== undefined) lines.push(`Triangles: ${report.triangles}.`);
        if (report.triangles > budget) lines.push(`Over budget: the studio allows ${budget} triangles for a ${category} on ${r.budgets.platform}. art_mesh op "cleanup" with target_tris ${budget} brings it down.`);
        else if (report.triangles !== undefined) lines.push(`Within the ${category} budget of ${budget} triangles.`);
        if (report.materials > r.budgets.max_materials) lines.push(`${report.materials} materials; the studio allows ${r.budgets.max_materials} (bake them into one with op "bake").`);
        for (const a of report.armatures || []) if (a.bones > r.budgets.max_bones) lines.push(`Skeleton ${a.name} has ${a.bones} bones; the mobile budget is ${r.budgets.max_bones}.`);
        if (report.maps) lines.push(`Baked maps: ${Object.entries(report.maps).map(([k, f]) => `${k} ${relOf(f)}`).join(', ')}.`, 'art_weathering on the baked albedo ages it (it uses the baked curvature and ao for edge wear and grime).');
        if (report.method) lines.push(`Rigged by ${report.method === 'transfer' ? 'copying skin weights from the base body' : 'Blender\'s automatic weights'}: ${JSON.stringify(report.weighted_groups)}.`);
        if (report.animations_made) lines.push(`Retargeted ${report.animations_made.length} animation(s) (${report.bones_matched} bones matched): ${report.animations_made.map(a => a.name).join(', ')}.${report.bones_unmatched.length ? ` Unmatched bones: ${report.bones_unmatched.join(', ')} (bone_map fixes them).` : ''}`);
        if (op === 'inspect') lines.push(JSON.stringify(report, null, 2));
        if (report.output) { const c = R.checkName(r, report.output); if (!c.ok) lines.push(`Naming: ${path.basename(report.output)} doesn't follow ${r.naming.pattern}; ${c.suggestion} would.`); }
        if (report.output && /\.glb$/i.test(report.output)) lines.push('For Godot: art_godot_skin installs it as an equippable skin, or godot_editor action "rescan" imports it.');
        const result = text(lines.join('\n'), false, report.maps && !args.no_preview ? await preview(Object.values(report.maps), Object.keys(report.maps)) : []);
        result.structuredContent = { ...report, output: report.output ? relOf(report.output) : undefined, budget, over_budget: report.triangles > budget };
        return result;
    }

    // ---------- Layer 4: marketing ----------

    async function artReframe(args = {}) {
        const src = inProject(args.image, { mustExist: true, label: 'image' });
        const aspects = [...new Set([].concat(args.aspects || []).concat([].concat(args.presets || []).map(p => ASPECT_PRESETS[p]).filter(Boolean)))];
        const list = aspects.length ? aspects : ['9:16', '1:1', '4:5', '16:9', '191:100'];
        const bad = list.find(a => !/^\d+(\.\d+)?:\d+(\.\d+)?$/.test(a));
        if (bad) return text(`"${bad}" isn't an aspect ratio like 9:16. Presets: ${Object.entries(ASPECT_PRESETS).map(([k, v]) => `${k} ${v}`).join(', ')}.`, true);
        const name = slug(args.name || path.basename(src).replace(/\.\w+$/, ''), 40);
        const dir = args.out_dir ? inProject(args.out_dir) : folder('marketing', 'reframed', name);
        const method = args.method || 'auto';
        const made = [];
        const notes = [];
        if (method !== 'fill' && (await comfyUp())) {
            const models = await comfy.models();
            const ck = pickCheckpoint(models.checkpoints, args.checkpoint, 'inpaint');
            const plan = await py('pad_plan', { input: src, aspects: list });
            const image = await uploadToComfy(src);
            for (const a of list) {
                const p = plan.plans[a];
                const file = path.join(dir, `${name}_${a.replace(':', 'x')}.png`);
                if (!p.left && !p.right && !p.top && !p.bottom) { fs.copyFileSync(src, file); made.push(file); continue; }
                const pics = await comfy.run(graphs.outpaint({ checkpoint: ck, prompt: args.prompt || 'extend the scene naturally, matching background, same lighting and style', negative: 'text, watermark, border, frame, people cut off', image, ...p, seed: seedOf(args.seed) }));
                fs.writeFileSync(file, pics[0]);
                made.push(file);
            }
            notes.push(`Outpainted with ${ck}; the original stays untouched in the middle.`);
        } else {
            if (method === 'ai') return text('AI reframing needs ComfyUI running.', true);
            const res = await py('reframe_fill', { input: src, aspects: list, out_dir: dir, name });
            made.push(...Object.values(res.files));
            notes.push('ComfyUI isn\'t running, so the new space is a soft, colour-matched fill made from the picture (no stretching). Start ComfyUI for painted-in backgrounds.');
        }
        return text([`Reframed ${path.basename(src)} into ${made.length} size(s) in ${relOf(dir)}:`, ...made.map(f => `- ${relOf(f)}`), ...notes].join('\n'), false, await preview(made, list));
    }

    async function artCutout(args = {}) {
        const inputs = imagesFrom(args.images || [], { label: 'images' });
        if (!inputs.length) return text('art_cutout needs images (pictures or a folder in the project).', true);
        if (inputs.length > 200) return text('At most 200 pictures in one call.', true);
        const dir = args.out_dir ? inProject(args.out_dir) : folder('marketing', 'cutouts');
        const res = await py('cutout', { inputs, out_dir: dir, trim: args.trim !== false, padding: Number(args.padding) || 8, fine_edges: Boolean(args.fine_edges), model: args.model || 'isnet-general-use' }, 1800000);
        return text([`Cut out ${res.files.length} picture(s) into ${relOf(dir)} (transparent PNG):`, ...res.files.slice(0, 50).map(f => `- ${relOf(f)}`)].join('\n'), false, await preview(res.files.slice(0, 8)));
    }

    async function artUpscale(args = {}) {
        const inputs = imagesFrom(args.images || [], { label: 'images' });
        if (!inputs.length) return text('art_upscale needs images (pictures or a folder in the project).', true);
        if (inputs.length > 100) return text('At most 100 pictures in one call.', true);
        const scale = Number(args.scale) === 2 ? 2 : 4;
        const dir = args.out_dir ? inProject(args.out_dir) : folder('marketing', 'upscaled');
        const t = tools_found();
        const made = [];
        let how = '';
        const method = args.method || 'auto';
        if ((method === 'auto' || method === 'realesrgan') && t.realesrgan) {
            const model = args.model || (args.anime ? 'realesrgan-x4plus-anime' : 'realesrgan-x4plus');
            for (const f of inputs) {
                const out = path.join(dir, `${path.basename(f).replace(/\.\w+$/, '')}_x${scale}.png`);
                const r2 = await exec(t.realesrgan, ['-i', f, '-o', out, '-s', String(scale), '-n', model], { cwd: path.dirname(t.realesrgan), env: childEnv(env), timeoutMs: 600000 });
                if (r2.code !== 0 || !isFile(out)) return text(`Real-ESRGAN failed on ${path.basename(f)}:\n${r2.output.slice(-800)}`, true);
                made.push(out);
            }
            how = `Real-ESRGAN (${model})`;
        } else if ((method === 'auto' || method === 'comfy') && (await comfyUp()) && (await comfy.models()).upscalers.length) {
            const ups = (await comfy.models()).upscalers;
            const model = (args.model && ups.find(u => u.includes(args.model))) || ups.find(u => /4x|x4/i.test(u)) || ups[0];
            for (const f of inputs) {
                const out = path.join(dir, `${path.basename(f).replace(/\.\w+$/, '')}_x${scale}.png`);
                fs.writeFileSync(out, (await comfy.run(graphs.upscale({ image: await uploadToComfy(f), model })))[0]);
                made.push(out);
            }
            how = `ComfyUI ${model}${scale === 2 && /4x|x4/i.test(model) ? ' (a 4x model; the result is 4x)' : ''}`;
        } else {
            const res = await py('upscale', { inputs, scale, out_dir: dir });
            made.push(...res.files);
            how = 'a sharpened Lanczos resize (no AI upscaler found: Real-ESRGAN ncnn is free, set CODEV_REALESRGAN_PATH, or put a 4x model in ComfyUI/models/upscale_models)';
        }
        return text([`Upscaled ${made.length} picture(s) ${scale}x with ${how} into ${relOf(dir)}:`, ...made.slice(0, 50).map(f => `- ${relOf(f)}`)].join('\n'));
    }

    async function artPlayableAd(args = {}) {
        const r = rules();
        const skins = imagesFrom(args.skins || [], { label: 'skins' }).slice(0, 12);
        const frames = imagesFrom(args.frames || [], { label: 'frames' }).slice(0, 72);
        const one = k => (args[k] ? dataUri(inProject(args[k], { mustExist: true, label: k })) : '');
        const built = buildPlayable({
            template: args.template || 'reveal', title: args.title || '', subtitle: args.subtitle || '', cta: args.cta || 'Play now',
            storeUrl: args.store_url || '', iosUrl: args.ios_url || '', androidUrl: args.android_url || '',
            skins: skins.map(dataUri), frames: frames.map(dataUri), background: one('background'), obstacle: one('obstacle'), logo: one('logo'),
            colors: args.colors || {}, seconds: args.seconds, hint: args.hint || '', maxMb: r.budgets.playable_ad_mb || 5
        });
        const name = slug(args.name || `${args.title || 'skin'}_${args.template || 'reveal'}`, 40);
        const file = args.output ? inProject(args.output) : path.join(folder('marketing', 'playables'), `${name}.html`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, built.html);
        return text([`Built the ${args.template || 'reveal'} playable ad: ${relOf(file)} (${(built.bytes / 1024).toFixed(0)} KB, one file, works offline).`,
            'It speaks MRAID 2.0 (waits for "ready", the button calls mraid.open) for AppLovin, Unity, ironSource, Mintegral and Google, and opens in any browser to test. It fits portrait and landscape.',
            ...built.warnings.map(w => `Note: ${w}`), `Templates: ${TEMPLATES.join(', ')}.`].join('\n'));
    }

    async function artAudio(args = {}) {
        const op = args.op;
        const t = tools_found();
        const dir = folder('audio', op === 'sfx' ? 'sfx' : 'voice');
        if (op === 'sfx') {
            const presets = ['whoosh', 'zap', 'laser', 'power_up', 'impact', 'explosion', 'hum', 'servo', 'shield', 'coin'];
            if (!presets.includes(args.preset)) return text(`preset is one of ${presets.join(', ')}.`, true);
            const out = args.output ? inProject(args.output) : path.join(dir, `${slug(args.name || args.preset)}.wav`);
            const res = await py('sfx', { preset: args.preset, output: out, duration: args.duration, seed: args.seed, pitch: args.pitch });
            let final = out;
            if (args.fx) final = await voiceFx(out, args.fx, t);
            return text(`Made the ${args.preset} sound (${res.seconds} s): ${relOf(final)}. Change seed for a variation, pitch to make it bigger (0.7) or smaller (1.4).`);
        }
        if (op === 'fx') {
            const input = inProject(args.input, { mustExist: true, label: 'input' });
            const out = await voiceFx(input, args.fx || args.preset, t, args.output);
            return text(`Applied the ${args.fx || args.preset} filter: ${relOf(out)}`);
        }
        if (op === 'speak') {
            if (!t.piper) return text('Text-to-speech uses Piper, which is free and runs offline: download it from github.com/rhasspy/piper/releases, plus a voice (.onnx and .onnx.json) from huggingface.co/rhasspy/piper-voices. Then set CODEV_PIPER_PATH (piper.exe) and CODEV_PIPER_VOICES (the voices folder).', true);
            if (!String(args.text || '').trim()) return text('op "speak" needs text: the line to say.', true);
            const voices = env.CODEV_PIPER_VOICES && isDir(env.CODEV_PIPER_VOICES) ? fs.readdirSync(env.CODEV_PIPER_VOICES).filter(n => n.endsWith('.onnx')) : [];
            let voice = '';
            if (args.voice && /\.onnx$/.test(args.voice) && !path.isAbsolute(args.voice)) voice = inProject(args.voice, { mustExist: true, label: 'voice' });
            else if (voices.length) voice = path.join(env.CODEV_PIPER_VOICES, voices.find(v => args.voice && v.includes(args.voice)) || voices[0]);
            if (!voice) return text('No Piper voice found. Put voices (.onnx + .onnx.json) in the CODEV_PIPER_VOICES folder, or pass voice as a path in the project.', true);
            const out = args.output ? inProject(args.output) : path.join(dir, `${slug(args.name || args.text, 32)}.wav`);
            fs.mkdirSync(path.dirname(out), { recursive: true });
            const pa = ['--model', voice, '--output_file', out];
            if (args.speed) pa.push('--length_scale', String(1 / Math.min(Math.max(Number(args.speed), 0.5), 2)));
            const r2 = await exec(t.piper, pa, { input: String(args.text), env: childEnv(env), timeoutMs: 120000 });
            if (r2.code !== 0 || !isFile(out)) return text(`Piper failed:\n${r2.output.slice(-800)}`, true);
            const final = args.fx ? await voiceFx(out, args.fx, t) : out;
            return text(`Said "${String(args.text).slice(0, 80)}" with ${path.basename(voice)}${args.fx ? ` and the ${args.fx} filter` : ''}: ${relOf(final)}. Voices available: ${voices.join(', ') || path.basename(voice)}.`);
        }
        return text(`op is speak, fx or sfx. Voice filters: ${Object.keys(VOICE_FX).join(', ')}.`, true);
    }

    async function voiceFx(input, fx, t, output) {
        const chain = VOICE_FX[fx];
        if (!chain) throw new Error(`Unknown filter "${fx}". Filters: ${Object.keys(VOICE_FX).join(', ')}.`);
        if (!t.ffmpeg) throw new Error('Voice filters need FFmpeg (free, ffmpeg.org; or set CODEV_FFMPEG_PATH).');
        const out = output ? inProject(output) : input.replace(/(\.\w+)$/, `_${fx}$1`);
        const r2 = await exec(t.ffmpeg, ['-y', '-i', input, '-af', `aresample=44100,${chain}`, out], { env: childEnv(env), timeoutMs: 120000 });
        if (r2.code !== 0) throw new Error(`FFmpeg failed: ${r2.output.slice(-600)}`);
        return out;
    }

    async function artVoiceClone(args = {}) {
        if (args.consent_confirmed !== true || !String(args.voice_owner || '').trim()) {
            return text('Not done: cloning a voice needs the voice owner\'s consent. Ask the user whose voice it is and whether that person agreed to have it cloned for this use, then call again with voice_owner (their name) and consent_confirmed true. Never clone a voice without that.', true);
        }
        const t = tools_found();
        if (!t.tts) return text('Voice cloning uses Coqui TTS with XTTS-v2, free to run on your computer: pip install coqui-tts (then set CODEV_TTS_PATH to its "tts" program if it isn\'t on the PATH). XTTS-v2\'s model licence (Coqui Public Model License) allows non-commercial use only; for a commercial game, record the actor with Piper-style training or license a commercial model.', true);
        const refs = imagesFromAudio(args.reference_audio);
        if (!refs.length) return text('reference_audio: one or more clean recordings (WAV, 6 to 30 seconds) of the voice, in the project.', true);
        if (!String(args.text || '').trim()) return text('text: the line to say in that voice.', true);
        const dir = folder('audio', 'voice', slug(args.voice_owner, 30));
        const out = args.output ? inProject(args.output) : path.join(dir, `${slug(args.name || args.text, 32)}.wav`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const logFile = path.join(folder('audio', 'voice'), 'consent_log.json');
        let consent = [];
        try { consent = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch { /* new */ }
        consent.push({ at: new Date().toISOString(), voice_owner: String(args.voice_owner), note: String(args.consent_note || ''), references: refs.map(relOf), output: relOf(out) });
        fs.writeFileSync(logFile, JSON.stringify(consent, null, 2));
        const r2 = await exec(t.tts, ['--model_name', 'tts_models/multilingual/multi-dataset/xtts_v2', '--text', String(args.text), '--speaker_wav', ...refs, '--language_idx', args.language || 'en', '--out_path', out],
            { env: childEnv(env, { COQUI_TOS_AGREED: '1' }), timeoutMs: 900000 });
        if (r2.code !== 0 || !isFile(out)) return text(`XTTS failed:\n${r2.output.slice(-1000)}`, true);
        const final = args.fx ? await voiceFx(out, args.fx, t) : out;
        return text(`Said the line in ${args.voice_owner}'s voice: ${relOf(final)}. Consent is recorded in ${relOf(logFile)}. XTTS-v2 is licensed for non-commercial use only.`);
    }

    function imagesFromAudio(list) {
        return [].concat(list || []).map(f => inProject(f, { mustExist: true, label: 'reference_audio' })).filter(f => /\.(wav|mp3|flac|ogg|m4a)$/i.test(f)).slice(0, 6);
    }

    // ---------- into Godot: the skin compiler and the one-command pipeline ----------

    function godotRootFor(args) {
        const dir = args.godot_dir ? inProject(args.godot_dir, { mustExist: true, label: 'godot_dir' }) : require('../gamedev').findGodotRoot(root());
        if (!dir || !isFile(path.join(dir, 'project.godot'))) throw new Error('No Godot project (project.godot) in the project folder or up to three folders down. Pass godot_dir if it lives elsewhere in the project.');
        return dir;
    }

    async function artGodotSkin(args = {}) {
        for (const k of ['model', 'name', 'character', 'slot']) if (!String(args[k] || '').trim()) return text(`art_godot_skin needs ${k}.`, true);
        const r = rules();
        const g = { ...R.DEFAULT_RULES.godot, ...(r.godot || {}) };
        const godot = godotRootFor(args);
        const inGodot = rel => {
            const full = path.resolve(godot, rel);
            if (!full.startsWith(godot + path.sep)) throw new Error(`${rel} would land outside the Godot project.`);
            return full;
        };
        const model = inProject(args.model, { mustExist: true, label: 'model' });
        if (!/\.(glb|gltf)$/i.test(model)) return text('model must be a .glb or .gltf (art_mesh exports .glb).', true);
        const warnings = [];
        const character = slug(args.character, 30);
        const slot = slug(args.slot, 30);
        if (!g.slots.includes(slot)) warnings.push(`"${slot}" isn't one of the studio's slots (${g.slots.join(', ')}); add it with art_rules if it's new.`);
        const tier = Number(args.tier) || 0;
        const rarity = args.rarity ? slug(args.rarity, 20) : (g.tiers[tier] || '');
        const id = args.id ? slug(args.id, 60) : R.assetName({ naming: { pattern: '{category}_{name}_{variant}', case: 'snake' } }, { category: `${character} ${slot}`, name: args.name, variant: rarity });
        const dir = inGodot(path.join(g.skins_dir, character, id));
        fs.mkdirSync(path.join(dir, 'textures'), { recursive: true });
        const modelDest = path.join(dir, `${id}${path.extname(model).toLowerCase()}`);
        fs.copyFileSync(model, modelDest);
        const G = require('./godot-skins');
        const variants = args.variants && typeof args.variants === 'object' ? args.variants : args.maps ? { [g.default_variant]: args.maps } : {};
        const materials = {};
        const maxTex = r.budgets.texture_size;
        for (const [stage, maps] of Object.entries(variants)) {
            const copied = {};
            for (const kind of ['albedo', 'orm', 'normal', 'emission']) {
                if (!maps || !maps[kind]) continue;
                const src = inProject(maps[kind], { mustExist: true, label: `${stage}.${kind}` });
                const size = T.imageSize(src);
                if (size && Math.max(size.width, size.height) > maxTex) warnings.push(`${stage} ${kind} is ${size.width}×${size.height}, over the ${maxTex}px texture budget.`);
                const dest = path.join(dir, 'textures', `${slug(stage, 20)}_${kind}${path.extname(src).toLowerCase()}`);
                fs.copyFileSync(src, dest);
                copied[kind] = G.res(godot, dest);
            }
            if (!copied.albedo) { warnings.push(`Variant "${stage}" has no albedo; skipped.`); continue; }
            const tres = path.join(dir, `${id}_${slug(stage, 20)}.tres`);
            fs.writeFileSync(tres, G.materialTres({ ...copied, tile: Number(args.tile_scale) || 1 }));
            materials[slug(stage, 20)] = G.res(godot, tres);
        }
        let icon;
        if (args.icon) {
            const out = path.join(dir, 'icon.png');
            try { await py('thumb', { input: inProject(args.icon, { mustExist: true, label: 'icon' }), output: out, size: g.icon_size || 256 }); icon = G.res(godot, out); } catch (err) { warnings.push(`Icon: ${err.message}`); }
        }
        // Triangles and bones from Blender when it's there, checked against the budget.
        let tris = Number(args.tris) || undefined;
        let bones;
        const category = args.category || 'skin';
        if (!tris && findBlender()) {
            const inspect = await artMesh({ op: 'inspect', input: relOf(model), category });
            if (inspect.structuredContent) { tris = inspect.structuredContent.triangles; bones = (inspect.structuredContent.armatures || [])[0]; }
        }
        if (tris && tris > R.trisBudget(r, category)) warnings.push(`${tris} triangles is over the ${category} budget of ${R.trisBudget(r, category)} (art_mesh op "cleanup" fixes it).`);
        const entry = {
            id, name: String(args.display_name || args.name), character, slot, tier: tier || undefined, rarity: rarity || undefined,
            model: G.res(godot, modelDest), rigged: Boolean(args.rigged), materials, default_variant: materials[g.default_variant] ? g.default_variant : Object.keys(materials)[0] || '',
            icon, description: args.description ? String(args.description) : undefined, stats: args.stats && typeof args.stats === 'object' ? args.stats : undefined,
            tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined, triangles: tris, bones: bones ? bones.bones : undefined,
            created: new Date().toISOString(), updated: new Date().toISOString()
        };
        const manifest = inGodot(g.manifest);
        fs.mkdirSync(path.dirname(manifest), { recursive: true });
        fs.writeFileSync(manifest, G.upsertManifest(isFile(manifest) ? fs.readFileSync(manifest, 'utf8') : '', JSON.parse(JSON.stringify(entry))));
        const lines = [`Installed skin "${id}" in the Godot project:`, `- model ${entry.model}`, ...Object.entries(materials).map(([s, m]) => `- ${s} material ${m}`), icon ? `- icon ${icon}` : '', `- manifest ${G.res(godot, manifest)} (${JSON.parse(fs.readFileSync(manifest, 'utf8')).skins.length} skin(s))`].filter(Boolean);
        if (args.registry !== false) {
            const reg = inGodot(g.registry);
            const existing = isFile(reg) ? fs.readFileSync(reg, 'utf8') : '';
            if (!existing || existing.includes('(made by CoDev)')) {
                fs.mkdirSync(path.dirname(reg), { recursive: true });
                fs.writeFileSync(reg, G.registryScript(G.res(godot, manifest)));
            } else warnings.push(`${G.res(godot, reg)} was changed by hand, so CoDev left it alone.`);
            const projFile = path.join(godot, 'project.godot');
            const before = fs.readFileSync(projFile, 'utf8');
            const after = G.addAutoload(before, g.autoload, G.res(godot, reg));
            if (after !== before) { fs.writeFileSync(projFile, after); lines.push(`- added the ${g.autoload} autoload to project.godot`); }
            lines.push(`In GDScript: ${g.autoload}.equip($Relay, "${id}", "${entry.default_variant || 'factory'}"). The skin goes on a child node named "${slot}" (a BoneAttachment3D works)${entry.rigged ? '; as a rigged skin it binds to the character\'s Skeleton3D instead' : ''}.`);
        }
        lines.push('godot_editor action "rescan" imports the new files if the editor is open.');
        const result = text([...lines, ...warnings.map(w => `Note: ${w}`)].join('\n'));
        result.structuredContent = { id, entry, manifest: G.res(godot, manifest), warnings };
        return result;
    }

    async function artSkinPipeline(args = {}) {
        const brief = String(args.brief || '').trim();
        if (!brief) return text('art_skin_pipeline needs brief: what the skin is (e.g. "A.E.G.I.S. armour for Relay, angular plates, cyan energy seams").', true);
        if (!args.character || !args.slot) return text('art_skin_pipeline needs character (e.g. relay) and slot (e.g. chest).', true);
        const r = rules();
        const name = String(args.name || brief.split(/[,.]/)[0]).slice(0, 40);
        const variants = Array.isArray(args.variants) ? args.variants.map(String).slice(0, 6) : Array.from({ length: Math.min(Math.max(Number(args.variants) || 1, 1), 6) }, (_, i) => (Number(args.variants) > 1 ? `variant ${i + 1}` : ''));
        const stages = [].concat(args.stages || ['factory', 'worn', 'battle']);
        const category = args.category || 'skin';
        const log = [];
        const sheet = [];
        const labels = [];
        const step = async (label, fn) => {
            const res = await fn();
            if (res.isError) throw new Error(`${label}: ${textOf(res)}`);
            log.push(`✓ ${label}`);
            return res.structuredContent || {};
        };
        const textOf = res => res.content.filter(c => c.type === 'text').map(c => c.text).join(' ').slice(0, 600);
        const installed = [];
        try {
            let base = null;
            if (args.mesh) {
                const clean = await step(`mesh cleaned to the ${category} budget`, () => artMesh({ op: 'cleanup', input: args.mesh, category, name, remesh: Boolean(args.remesh), no_preview: true }));
                const uv = await step('UVs unwrapped', () => artMesh({ op: 'uv', input: clean.output, category, name, no_preview: true }));
                base = uv.output;
            }
            for (const v of variants) {
                const vName = v ? `${name} ${v}` : name;
                let concept;
                if (args.concepts !== false) {
                    try {
                        const c = await step(`concept for ${vName}`, () => artGenerate({ prompt: `${brief}${v ? `, ${v}` : ''}`, count: 1, category, name: vName, style: args.style, lore_subject: args.character, no_preview: true }));
                        concept = c.files && c.files[0];
                        if (concept) { sheet.push(inProject(concept)); labels.push(`${vName} concept`); }
                    } catch (err) { log.push(`✗ concept for ${vName} (${err.message.slice(0, 200)}); carrying on`); }
                }
                const mats = await step(`PBR material for ${vName}`, () => artMaterials({ materials: [`${args.material || brief}${v ? `, ${v}` : ''}`], style: args.style, size: args.texture_size, no_preview: true }));
                const set = mats.sets[0];
                const aged = await step(`weathering (${stages.join(', ')}) for ${vName}`, () => artWeathering({ albedo: set.albedo, roughness: set.roughness, metallic: set.metallic, ao: set.ao, curvature: set.curvature, stages, name: slug(vName, 40), no_preview: true }));
                for (const [s, f] of Object.entries(aged.stages)) { if (s === stages[stages.length - 1]) { sheet.push(inProject(f.albedo)); labels.push(`${vName} ${s}`); } }
                if (!base) continue;
                const maps = { albedo: set.albedo, normal: set.normal, roughness: set.roughness, metallic: set.metallic, emission: set.emission };
                const tex = await step(`material on the mesh for ${vName}`, () => artMesh({ op: 'texture', input: base, category, name: vName, maps, tile_scale: args.tile_scale || 2, no_preview: true }));
                let model = tex.output;
                if (args.base) model = (await step(`rigged to ${args.base}`, () => artMesh({ op: 'rig', input: model, base: args.base, category, name: vName, no_preview: true }))).output;
                if (args.install !== false) {
                    const variantsMaps = Object.fromEntries(Object.entries(aged.stages).map(([s, f]) => [s, { albedo: f.albedo, orm: f.orm, normal: set.normal, emission: set.emission }]));
                    const done = await step(`installed ${vName} in Godot`, () => artGodotSkin({ model, name: vName, character: args.character, slot: args.slot, tier: args.tier, rarity: args.rarity, variants: variantsMaps,
                        icon: concept, rigged: Boolean(args.base), tile_scale: args.tile_scale || 2, description: brief, stats: args.stats, tags: args.tags, category, godot_dir: args.godot_dir }));
                    installed.push(done.id);
                }
            }
        } catch (err) {
            return text([`Stopped: ${err.message}`, 'Done before that:', ...log].join('\n'), true, await preview(sheet, labels));
        }
        if (!args.mesh) log.push('No mesh was given, so the 3D steps were skipped: pass mesh (a .glb/.fbx/.obj of the armour, from Blender, Tripo or any image-to-3D tool) to texture, rig and install it in Godot.');
        const result = text([`Skin pipeline for "${name}" (${variants.length} variant(s)):`, ...log, installed.length ? `Equippable in Godot: ${installed.join(', ')}` : '', R.summary(r).split('\n')[0]].filter(Boolean).join('\n'), false, await preview(sheet, labels));
        result.structuredContent = { installed, log };
        return result;
    }

    // ---------- tool list ----------

    const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
    const arr = (description, items = { type: 'string' }) => ({ type: 'array', items, description });
    const num = description => ({ type: 'number', description });
    const bool = description => ({ type: 'boolean', description });
    const tools = [
        { name: 'art_status', description: 'Check the art pipeline on this computer: ComfyUI and its models, Python tools, Blender, LoRA trainers, upscaler, voice tools, and the studio rules. Call it first in an art task, then use the tools it says are ready; when it says ComfyUI or a tool is missing, tell the user what to install instead of calling tools that need it. Once per task is enough.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
        { name: 'art_rules', description: 'Read or change the studio rules in codev-studio.json (workspace memory every art tool follows): art direction words, negative words, palette, default style and checkpoint, triangle budgets per category, texture size, bone and material limits for the platform (Godot 4 mobile by default), naming pattern, output folders, free-text notes. op "name" makes a file name that follows the naming rule (or checks one with file). Use it when the user states a lasting art rule (op note or set) and before naming new files (op name); don\'t keep rules in your head instead. Read (op get) is free; set only what the user asked to change.',
            inputSchema: { type: 'object', properties: { op: str('get, set, note or name', { enum: ['get', 'set', 'note', 'name'] }), patch: { type: 'object', description: 'For set: the parts to change (deep-merged; null removes a key)' }, note: str('For note: a studio rule in plain words'), category: str('For name: the asset category, like skin or weapon'), name: str('For name: the asset name, like AEGIS armour'), variant: str('For name: the variant, like crimson'), file: str('For name: a file name to check') } } },
        { name: 'art_models', description: 'List the models installed in ComfyUI (checkpoints, LoRAs, ControlNets, upscalers, IP-Adapter) with the sampler settings CoDev uses for each. Use it to pick a checkpoint, LoRA or ControlNet by its real name before passing one to another art_ tool; don\'t guess model names.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
        { name: 'art_generate', description: 'Concept art for a skin or asset brief. Pitches several creative directions across several models at once (any checkpoints in ComfyUI: FLUX, SDXL, custom ones; "all" tries each), with the studio\'s style, LoRA and reference pictures applied, and returns a contact sheet. Without ComfyUI it uses the free Pollinations FLUX service. Saves into art/concepts. Use it for game art from a brief; for one picture in the chat use generate_image instead, and to change an existing picture use art_edit.',
            inputSchema: { type: 'object', properties: { lore: bool('Add the look of characters, items and places the brief names, from the universe bible (default true)'), lore_subject: str('Who it is for, when the prompt doesn\'t name them (e.g. relay)'), prompt: str('The brief: what the skin/asset is'), directions: arr('Creative directions to pitch side by side, e.g. ["chrome samurai", "bio-organic chitin", "salvaged scrap"]'), models: arr('Checkpoint names (or parts of them), or ["all"]'), count: num('Pictures per direction per model (1-8)'), aspect: str('Picture shape, e.g. 1:1 (default), 3:4, 16:9'), style: str('A saved style name; "" for none; default is the studio default'), lora: arr('Extra LoRAs: names or {name, weight}', { type: ['string', 'object'] }), style_strength: num('How strongly reference pictures steer (0-1)'), negative: str('Extra things to avoid'), seed: num('Seed for repeatable results; leave it out for a new random one'), tileable: bool('Make tileable textures'), category: str('For file names, e.g. skin'), name: str('Short name for the files'), out_dir: str('Folder in the project') }, required: ['prompt'] } },
        { name: 'art_edit', description: 'Change part of a picture while keeping the rest (inpainting: swap a pauldron, change a visor glow, alter chest plating), rework the whole picture (img2img), or turn a rough sketch into finished art in the studio style (sketch: ControlNet scribble/lineart when installed). Needs ComfyUI. Use it when the user wants an existing picture changed; for new concepts use art_generate instead, and to put an outfit on a character use art_try_on.',
            inputSchema: { type: 'object', properties: { image: str('Picture in the project'), image_data: str('Or a data:image/png;base64 URL'), mode: str('inpaint, img2img or sketch', { enum: ['inpaint', 'img2img', 'sketch'] }), prompt: str('What the changed part (or the sketch) should become'), mask: str('Mask picture in the project: white = change'), mask_box: arr('Or [x, y, width, height] as fractions 0-1 (or a list of boxes)', { type: ['number', 'array'] }), denoise: num('0-1: how much to change (inpaint 0.9, img2img 0.55)'), checkpoint: str('ComfyUI checkpoint name or part of it (art_models lists them); default: the studio default'), style: str('A saved style name (art_style op list); default: the studio default style'), lora: arr('Extra LoRAs on top of the style\'s: names, or {name, weight} with weight 0-1.5', { type: ['string', 'object'] }), controlnet: str('For sketch: ControlNet name'), strength: num('For sketch: how closely to follow the lines (0-1)'), fast: bool('For sketch: use a turbo/schnell model for speed'), seed: num('Seed for repeatable results; leave it out for a new random one'), output: str('Output path in the project; default: the studio rules\' folder and naming') }, required: ['prompt'] } },
        { name: 'art_try_on', description: 'Virtual try-on: put a garment, armour set or rig onto an existing character picture, fitted to their pose and silhouette. The region (head, upper, torso, arms, lower, legs, feet, full, outfit) is masked inside the character\'s outline automatically. Needs ComfyUI; an outfit picture needs IP-Adapter. Use it when the user wants a garment or armour shown on a character picture; for other changes to a picture use art_edit instead.',
            inputSchema: { type: 'object', properties: { character: str('The base character picture'), outfit_image: str('A picture of the outfit/armour'), outfit_prompt: str('Or describe the outfit'), region: str('head, helmet, upper, torso, arms, lower, legs, feet, full or outfit'), mask: str('Your own mask picture in the project instead (white = change)'), denoise: num('0-1: how much the region may change (default 0.88)'), grow: num('Pixels to grow the mask past the body'), checkpoint: str('ComfyUI checkpoint name or part of it (art_models lists them); default: the studio default'), style: str('A saved style name (art_style op list); default: the studio default style'), lora: arr('Extra LoRAs on top of the style\'s: names, or {name, weight} with weight 0-1.5', { type: ['string', 'object'] }), seed: num('Seed for repeatable results; leave it out for a new random one'), output: str('Output path in the project; default: the studio rules\' folder and naming') }, required: ['character'] } },
        { name: 'art_style', description: 'Instant style cloning: save a look from a handful of reference pictures (copied into art/styles, palette measured) as a named style that art_generate, art_edit, art_materials and try-on apply (through IP-Adapter when ComfyUI has it, and always through its words and palette). Also list, update, set_default, delete. Use it when the user gives reference pictures for a look to reuse. For a lasting style, train a LoRA with art_lora_train instead.',
            inputSchema: { type: 'object', properties: { op: str('clone, update, list, set_default or delete', { enum: ['clone', 'update', 'list', 'set_default', 'delete'] }), name: str('Style name, e.g. season4_neon'), references: arr('2-8 pictures or a folder'), description: str('The look in words (look at the references: line work, shading, materials, colour, mood)'), negative: str('What this style avoids'), lora: str('A LoRA that carries this style'), lora_weight: num('How strongly the LoRA applies, 0-1.5 (default 0.8)'), trigger: str('The LoRA\'s trigger word'), checkpoint: str('Checkpoint this style works best with (art_models lists them)'), set_default: bool('Make it the default style') } } },
        { name: 'art_captions', description: 'Review and fix a LoRA training run\'s captions: flags missing captions, missing trigger words, style words that would leak into prompts, captions too long or duplicated, and pictures too small. op "auto" captions with kohya\'s BLIP; op "set" writes your own (look at each picture). Use it after art_lora_train op prepare and before op start; don\'t start training while it reports errors.',
            inputSchema: { type: 'object', properties: { run: str('Training run name'), op: str('review, auto or set', { enum: ['review', 'auto', 'set'] }), captions: { type: 'object', description: 'For set: {"img_001.png": "caption", ...}' } }, required: ['run'] } },
        { name: 'art_lora_train', description: 'Train a custom LoRA so generations match the studio\'s own art. kind "style" or "character" learns from the studio\'s pictures (kohya sd-scripts on SDXL or SD 1.5, or ai-toolkit on FLUX); kind "edit" learns a post-processing pass from before/after pairs (ai-toolkit on FLUX Kontext or Qwen-Image-Edit). op "prepare" lays out the dataset and picks the settings from the dataset size and GPU memory, "start" runs it in the background, "status" shows progress, "cancel" stops it. When done, the LoRA is copied into ComfyUI and attached to the style. Use it only when the user asks for a trained style or character model; for a quick look from a few pictures use art_style instead. Run art_captions before op start; training takes hours, so check with op status rather than waiting.',
            inputSchema: { type: 'object', properties: { op: str('prepare, start, status or cancel', { enum: ['prepare', 'start', 'status', 'cancel'] }), name: str('Run and LoRA name'), kind: str('style, character or edit', { enum: ['style', 'character', 'edit'] }), base: str(`Base model: ${Object.keys(T.BASES).join(', ')}`), images: arr('For style/character: pictures or folders'), before: arr('For edit: the pictures before the pass'), after: arr('For edit: the same pictures after it (same file names)'), instruction: str('For edit: what the pass does, in words'), trigger: str('Trigger word'), class_word: str('What the pictures are, e.g. character, weapon, illustration'), style: str('Style to attach the LoRA to'), vram_gb: num('GPU memory, for the settings'), model_path: str('Base checkpoint file (kohya) or Hugging Face id (ai-toolkit)'), settings: { type: 'object', description: 'Override any picked setting' }, sample_prompts: arr('ai-toolkit sample prompts'), force: bool('Start even with caption errors') }, required: ['name'] },
            _meta: { 'codev/alwaysAsk': true } },
        { name: 'art_materials', description: 'Material exploration: 1 to 40 tileable material concepts in one go (alien chitin, battle-scarred steel, carbon-fibre weave, iridescent energy plating...), each made seamless and turned into a full PBR set (albedo, normal, roughness, metallic, AO, height, curvature, Godot ORM) in art/textures, with a contact sheet. Use it to explore new tileable surfaces from words; to turn a texture picture the user already has into maps use art_pbr_maps instead.',
            inputSchema: { type: 'object', properties: { materials: arr('Materials to make'), theme: str('Or a theme to vary'), count: num('With theme: how many (max 40)'), size: num('Map size in px (default: the studio budget)'), pbr: bool('Make PBR maps (default true)'), style: str('Saved style (default none)'), checkpoint: str('ComfyUI checkpoint name or part of it (art_models lists them); default: the studio default'), lora: arr('Extra LoRAs on top of the style\'s: names, or {name, weight} with weight 0-1.5', { type: ['string', 'object'] }), seed: num('Seed for repeatable results; leave it out for a new random one') } } },
        { name: 'art_pbr_maps', description: 'Full PBR material set from one texture picture: de-lit albedo, normal (OpenGL or DirectX), height, roughness, metallic, AO, curvature, emissive and a Godot ORM map. Runs on this computer with Python. Use it when the user has a texture picture; to invent materials from words use art_materials instead.',
            inputSchema: { type: 'object', properties: { image: str('Texture picture'), name: str('Material name'), out_dir: str('Output folder in the project; default: the studio rules\' folder for this kind of file'), size: num('Resize to (px, square)'), seamless: bool('Make it tile first'), metallic: num('Metallic 0-1'), metallic_mask: str('Or a mask picture'), metal_from_color: bool('Guess metal from grey, bright areas'), normal_format: str('gl for Godot and Blender (default), dx for DirectX engines'), normal_strength: num('How deep the normal map reads (default 2)'), roughness_bias: num('Shift roughness from -0.5 (glossier) to 0.5 (rougher); default 0'), delight: num('0-1: remove baked-in shading') }, required: ['image'] } },
        { name: 'art_weathering', description: 'Surface weathering and age variations: turns a texture set into stages from factory-fresh to light wear, worn, battle-damaged and ruined (edge wear and chipped paint on convex edges, scratches, rust in cavities, scorch marks, grime, dust), each with albedo, roughness, metallic and ORM. Uses the curvature and AO maps next to the albedo when present. Use it after a PBR set exists (art_pbr_maps or art_materials); don\'t use it on concept art.',
            inputSchema: { type: 'object', properties: { albedo: str('Albedo/base colour picture'), roughness: str('Optional matching map from the same texture set; read from next to the albedo when left out'), metallic: str('Optional matching map from the same texture set; read from next to the albedo when left out'), ao: str('Optional matching map from the same texture set; read from next to the albedo when left out'), curvature: str('Optional matching map from the same texture set; read from next to the albedo when left out'), stages: arr('Any of factory, light, worn, battle, ruined'), overrides: { type: 'object', description: '{"battle": {"rust": 0.6}}: edge, scratch, rust, scorch, grime, dust 0-1' }, name: str('Short name used in the output file names'), out_dir: str('Output folder in the project; default: the studio rules\' folder for this kind of file'), seed: num('Seed for repeatable results; leave it out for a new random one') }, required: ['albedo'] } },
        { name: 'art_mesh', description: 'Game-ready 3D in Blender (runs in the background): "inspect" counts triangles, materials, bones; "cleanup" fixes raw AI meshes (merge, loose parts, normals, optional voxel remesh) and decimates to the studio\'s triangle budget for the category; "uv" unwraps and packs; "bake" bakes PBR maps (albedo, normal, roughness, metallic, emission, AO, curvature), from a high-poly when given, into one material; "texture" puts a tileable PBR set (maps) on the mesh, tiled by tile_scale; "rig" puts a cosmetic mesh on a base character\'s skeleton (copies the body\'s skin weights); "retarget" moves animations from another skeleton (Mixamo, Rigify, UE names matched). Exports .glb for Godot and checks budgets and naming. Use it for any step on a 3D asset; for a custom Blender script use blender_run instead. Run op inspect first when you don\'t know the mesh.',
            inputSchema: { type: 'object', properties: { op: str('inspect, cleanup, uv, bake, texture, rig or retarget', { enum: ['inspect', 'cleanup', 'uv', 'bake', 'texture', 'rig', 'retarget'] }), maps: { type: 'object', description: 'texture: {albedo, normal, roughness, metallic, ao, emission} paths' }, tile_scale: num('texture: how many times the material repeats across the UVs'), input: str('.glb/.gltf/.fbx/.obj/.stl/.blend in the project'), output: str('Where to save (.glb by default)'), category: str('Budget category: character, skin, weapon, vehicle, prop, environment'), name: str('Asset name for file names'), target_tris: num('cleanup: triangle target (default: the budget)'), remesh: bool('cleanup: voxel remesh first'), remesh_resolution: num('cleanup: voxels across the longest side'), high_poly: str('bake: high-poly source'), maps: arr('bake: which maps'), size: num('bake: map size'), samples: num('bake: Cycles samples'), base: str('rig: base character with skeleton'), method: str('rig: transfer or auto'), keep_body: bool('rig: keep the base body in the file'), animations: str('retarget: file with the animations'), bone_map: { type: 'object', description: 'retarget: {target_bone: source_bone}' }, actions: arr('retarget: only these animations'), timeout_seconds: num('Stop Blender after this many seconds (default 900)') }, required: ['op', 'input'] } },
        { name: 'art_reframe', description: 'Dynamic reframing: expands a hero key-art picture to every ad and store size (vertical mobile 9:16, square, feed 4:5, widescreen 16:9, banner 1.91:1, headers...) without stretching or cropping it, painting the new space with ComfyUI outpainting (or a soft colour-matched fill without ComfyUI). Use it when the user needs key art in other ad or store sizes; don\'t use it to change what the picture shows (use art_edit).',
            inputSchema: { type: 'object', properties: { image: str('The hero key-art picture in the project'), aspects: arr('e.g. ["9:16", "16:9"]'), presets: arr(`Named sizes: ${Object.keys(ASPECT_PRESETS).join(', ')}`), prompt: str('What the extended background is'), method: str('auto, ai or fill'), checkpoint: str('ComfyUI checkpoint name or part of it (art_models lists them); default: the studio default'), name: str('Short name used in the output file names'), out_dir: str('Output folder in the project; default: the studio rules\' folder for this kind of file'), seed: num('Seed for repeatable results; leave it out for a new random one') }, required: ['image'] } },
        { name: 'art_cutout', description: 'Batch background removal: transparent PNG cut-outs of characters and items (rembg, on this computer), trimmed to the subject. Use it when the user needs transparent cut-outs, such as for a playable ad; don\'t use it on textures.',
            inputSchema: { type: 'object', properties: { images: arr('Pictures or folders'), out_dir: str('Output folder in the project; default: the studio rules\' folder for this kind of file'), trim: bool('Trim to the subject (default true)'), padding: num('Pixels of empty space kept around the subject after trimming (default 8)'), fine_edges: bool('Alpha matting for hair and fur'), model: str('rembg model, e.g. isnet-general-use, isnet-anime, birefnet-general') }, required: ['images'] } },
        { name: 'art_upscale', description: 'Batch 2x or 4x upscaling for store banners and print without softening detail: Real-ESRGAN (free, any GPU), a ComfyUI upscale model, or a sharpened resize as a last resort. Use it when pictures must be bigger for banners or print; don\'t upscale textures that feed art_pbr_maps unless the user asks.',
            inputSchema: { type: 'object', properties: { images: arr('Pictures or folders'), scale: num('Upscale factor: 2 or 4 (default 4)'), method: str('auto, realesrgan, comfy or basic'), model: str('ComfyUI checkpoint name or part of it (art_models lists them); default: the studio default'), anime: bool('Stylised/anime art model'), out_dir: str('Output folder in the project; default: the studio rules\' folder for this kind of file') }, required: ['images'] } },
        { name: 'art_playable_ad', description: 'Build an interactive HTML playable ad from skin art: one offline file, MRAID 2.0 for the ad networks, portrait and landscape. Templates: reveal (scratch to reveal the skin), equip (swipe through skins, tap Equip), runner (a 15-second dodge game played as the skin), spin (turntable from frames, or a tilt card). Ends on a store end card. Use it only when the user asks for a playable or interactive ad; cut skins out with art_cutout first for the best result.',
            inputSchema: { type: 'object', properties: { template: str(TEMPLATES.join(', '), { enum: TEMPLATES }), title: str('The ad\'s headline text'), subtitle: str('Second line of text under the headline'), cta: str('Call-to-action button text, like "Play now"'), store_url: str('One store link for every platform'), ios_url: str('App Store link'), android_url: str('Google Play link'), skins: arr('Skin pictures (cut-outs work best)'), frames: arr('spin: turntable frames in order'), background: str('Background picture'), obstacle: str('runner: obstacle picture'), logo: str('Logo picture'), colors: { type: 'object', description: '{background, accent, text} as #hex' }, seconds: num('Seconds of play before the end card shows'), hint: str('reveal: the cover text'), name: str('Short name used in the output file name (the studio naming rule applies)'), output: str('Output path in the project; default: the studio rules\' folder and naming') }, required: ['skins'] } },
        { name: 'art_audio', description: 'Audio for skins and ads, on this computer: "speak" says barks and dialogue lines with Piper (free offline voices); "fx" puts a voice filter on a recording (robot, mech, radio, helmet, hologram, demon, giant, tiny, cave) with FFmpeg, e.g. an armoured robotic voice for a mech skin; "sfx" makes procedural sound effects (whoosh, zap, laser, power_up, impact, explosion, hum, servo, shield, coin). Use it for game sound and voice lines; to say a line in a real person\'s voice use art_voice_clone instead.',
            inputSchema: { type: 'object', properties: { op: str('speak, fx or sfx', { enum: ['speak', 'fx', 'sfx'] }), text: str('speak: the line'), voice: str('speak: Piper voice name or .onnx path'), speed: num('speak: 0.5-2'), input: str('fx: recording'), fx: str(`Filter: ${Object.keys(VOICE_FX).join(', ')}`), preset: str('sfx: the sound, one of whoosh, zap, laser, power_up, impact, explosion, hum, servo, shield, coin'), duration: num('sfx: seconds'), pitch: num('sfx: pitch from 0.5 (lower) to 2 (higher); default 1'), seed: num('sfx: variation'), name: str('Short name used in the output file name (the studio naming rule applies)'), output: str('Output path in the project; default: the studio rules\' folder and naming') }, required: ['op'] } },
        { name: 'art_voice_clone', description: 'Say a line in a specific person\'s voice from a few clean recordings (XTTS-v2, on this computer). Use it only for voices the user owns or has the owner\'s consent for: ask the user, then pass voice_owner and consent_confirmed true; never set consent_confirmed without the user saying so. For stock voices use art_audio op speak instead. Consent is logged. XTTS-v2 is licensed for non-commercial use.',
            inputSchema: { type: 'object', properties: { text: str('The line to say in that voice'), reference_audio: arr('6-30 s WAV recordings of the voice'), voice_owner: str('Whose voice it is'), consent_confirmed: bool('The owner agreed to this use'), consent_note: str('How consent was given'), language: str('e.g. en, es, fr, de, ja'), fx: str('Optional voice filter'), name: str('Short name used in the output file name (the studio naming rule applies)'), output: str('Output path in the project; default: the studio rules\' folder and naming') }, required: ['text', 'reference_audio', 'voice_owner', 'consent_confirmed'] },
            _meta: { 'codev/alwaysAsk': true } },
        { name: 'art_godot_skin', description: 'Install a finished skin in the Godot 4 project as an equippable item: copies the .glb, its textures and an icon into the skins folder, writes one ORMMaterial3D per weathering stage, adds or updates the skin in the skin manifest JSON (id, name, character, slot, tier, rarity, model, materials, icon, stats, triangles), and keeps a SkinRegistry autoload that equips skins by slot (SkinRegistry.equip(character, id, variant)). Folders, slots and tiers come from the godot section of codev-studio.json. Use it when a finished .glb skin should become equippable in the game; to run every step from a brief use art_skin_pipeline instead.',
            inputSchema: { type: 'object', properties: { model: str('.glb from art_mesh'), name: str('Skin name, e.g. AEGIS armour'), display_name: str('Shown in game, if different'), character: str('The character the skin is for, e.g. relay'), slot: str('e.g. helmet, chest, arms, legs, weapon, full_body'), tier: num('1-5 (studio tiers map to rarities)'), rarity: str('Or the rarity itself'), variants: { type: 'object', description: '{stage: {albedo, orm, normal, emission}} from art_weathering' }, maps: { type: 'object', description: 'Or one map set {albedo, orm, normal, emission}' }, icon: str('Picture for the icon (a concept or render)'), rigged: bool('Skinned to the character\'s skeleton (art_mesh op "rig")'), tile_scale: num('Texture tiling used on the mesh'), stats: { type: 'object', description: 'Game stats to store' }, tags: arr('Tags stored with the skin, like ["neon", "season4"]'), description: str('Item description'), tris: num('Triangle count if known'), category: str('Budget category (default skin)'), id: str('A fixed skin id to keep (default: made from the name); pass the old id to update a skin'), godot_dir: str('Folder with project.godot'), registry: bool('Write the SkinRegistry autoload (default true)') }, required: ['model', 'name', 'character', 'slot'] } },
        { name: 'art_skin_pipeline', description: 'One command from a skin brief to an equippable skin in Godot, run locally end to end: concept art per variant, a tileable PBR material per variant, the mesh cleaned to the poly budget and UV-unwrapped, the material put on it, weathering stages (factory to battle-worn), rigged onto the base character, then art_godot_skin installs it with the manifest entry. E.g. "three tier-3 epic variants of Relay\'s A.E.G.I.S. armour". Without a mesh it stops after concepts, materials and weathering. Use it when the user wants a skin made end to end; for a single step call that step\'s tool instead (art_generate, art_materials, art_mesh, art_godot_skin).',
            inputSchema: { type: 'object', properties: { brief: str('What the skin is, in the user\'s words'), character: str('The character the skin is for, e.g. relay'), slot: str('The equipment slot, e.g. chest or helmet'), name: str('Skin name, e.g. AEGIS armour (default: from the brief)'), variants: { type: ['array', 'number'], items: { type: 'string' }, description: 'Variant names (e.g. ["crimson", "void", "gold"]) or a count, max 6' }, tier: num('Tier 1-5; the studio rules map tiers to rarities'), rarity: str('Or the rarity itself, like "epic" (default: from the tier)'), mesh: str('The armour/garment mesh (.glb/.fbx/.obj/.blend) in the project'), base: str('Base character with skeleton, to rig onto'), material: str('Material words if different from the brief'), stages: arr('Weathering stages (default factory, worn, battle)'), style: str('A saved style name (art_style op list); default: the studio default style'), tile_scale: num('Texture tiling (default 2)'), texture_size: num('Texture map size in px (default: the studio budget)'), remesh: bool('Voxel remesh raw AI meshes first'), concepts: bool('Make concept art (default true)'), install: bool('Install in Godot (default true)'), stats: { type: 'object', description: 'Game stats to store with the skin, like {"armor": 12}' }, tags: arr('Tags stored with the skin, like ["neon", "season4"]'), category: str('Budget category (default skin)'), godot_dir: str('Folder with project.godot') }, required: ['brief', 'character', 'slot'] } },
        { name: 'art_lore', description: 'Read the universe bible the art tools use: the Chronicler vault in lore/ and Story Studio\'s game_data/story_bible.json (sources set in codev-studio.json lore). With no name it lists every character, faction, place and item; with name it returns that entry (appearance, powers, relationships); with query it finds entries that mention something. Read it before a skin or asset for a named character so the art stays on canon; art_generate also adds the look of anyone the brief names on its own. Use it when the user asks what a character or place looks like, or before art for a named one; to change the lore use the Story Studio tools instead.',
            inputSchema: { type: 'object', properties: { name: str('An entry\'s name or alias, e.g. Relay'), query: str('Words to find in every entry') } }, annotations: { readOnlyHint: true } }
    ];

    // The universe bible, read-only: what the art tools know about a character or place.
    async function artLore(args = {}) {
        const r = rules();
        const { entries, read, problems } = L.loadLore(root(), r);
        const where = (r.lore && r.lore.sources) || [];
        if (!entries.length) return text([`No universe bible found in ${where.join(' or ') || 'the lore sources'}. Export the Chronicler vault from Story Studio (🧭 World tools) into lore/, or story_bible.json into game_data/, or set lore.sources with art_rules.`, ...problems].join('\n'));
        const q = String(args.name || args.query || '').trim();
        if (!q) return text([`Universe bible: ${read.join(', ')}. ${entries.length} entries:`, ...entries.slice(0, 200).map(e => `- ${e.kind}: ${e.name}${e.summary ? ` (${e.summary.slice(0, 100)})` : ''}`), ...problems].join('\n'));
        const named = entries.filter(e => e.name.toLowerCase() === q.toLowerCase() || String((e.fields || {}).aliases || '').toLowerCase().split(/\s*,\s*/).includes(q.toLowerCase()));
        const hits = named.length ? named : entries.filter(e => L.describe(e).toLowerCase().includes(q.toLowerCase())).slice(0, 6);
        return text(hits.length ? hits.map(L.describe).join('\n\n---\n\n') : `Nothing in the universe bible mentions "${q}".`);
    }

    const handlers = {
        art_status: artStatus, art_rules: artRules, art_models: artModels, art_generate: artGenerate, art_edit: artEdit, art_try_on: artTryOn,
        art_style: artStyle, art_captions: artCaptions, art_lora_train: artLoraTrain, art_materials: artMaterials, art_pbr_maps: artPbrMaps,
        art_weathering: artWeathering, art_mesh: artMesh, art_reframe: artReframe, art_cutout: artCutout, art_upscale: artUpscale,
        art_playable_ad: artPlayableAd, art_audio: artAudio, art_voice_clone: artVoiceClone,
        art_godot_skin: artGodotSkin, art_skin_pipeline: artSkinPipeline, art_lore: artLore
    };

    async function callTool(name, args = {}) {
        const handler = handlers[name];
        if (!handler) return text(`Unknown tool: ${name}`, true);
        try { return await handler(args || {}); } catch (err) { return text(err.message || String(err), true); }
    }

    // The Windows app: these tools join the browser's on codev:browser-mcp.
    async function handleMcp(message, next) {
        if (message && message.method === 'tools/call' && handlers[message.params && message.params.name]) {
            return { jsonrpc: '2.0', id: message.id, result: await callTool(message.params.name, message.params.arguments || {}) };
        }
        const reply = await next(message);
        if (message && message.method === 'tools/list' && reply && reply.result) reply.result = { ...reply.result, tools: [...(reply.result.tools || []), ...tools] };
        return reply;
    }

    return {
        name: 'creative',
        tools,
        callTool,
        handleMcp,
        status: async () => ({ available: true, detail: `ComfyUI ${(await comfyUp()) ? 'running' : 'not running'} at ${comfy.url}` }),
        close: () => jobs.closeAll()
    };
}

module.exports = { createCreativeService, ASPECT_PRESETS, VOICE_FX };
