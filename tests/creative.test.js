// The art pipeline (desktop/creative): studio rules, ComfyUI graphs and client against a
// stand-in ComfyUI server, the free Python picture and sound tools, LoRA dataset prep
// and caption review, playable ads, the Blender pipeline's Node side with a stand-in
// Blender, consent for voice cloning, and the tools reaching server.js and the MCP server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { execFileSync } = require('child_process');
const R = require('../desktop/creative/rules');
const { createComfy, graphs, samplerFor, sizeFor, pickCheckpoint } = require('../desktop/creative/comfy');
const T = require('../desktop/creative/training');
const { buildPlayable } = require('../desktop/creative/playable');
const { createCreativeService } = require('../desktop/creative');
const Q = require('../desktop/creative/skin-quality');
const { loadServices } = require('../agent-services');
const { createCodevMcp } = require('../codev-mcp');

const unix = process.platform !== 'win32';
const hasPython = (() => {
    try { execFileSync(process.env.CODEV_PYTHON || (unix ? 'python3' : 'python'), ['-c', 'import numpy, PIL'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

// A 1x1 PNG (and a bigger one made by Python where needed).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function project() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-art-'));
    fs.mkdirSync(path.join(dir, 'refs'));
    return dir;
}

function makePng(file, w = 64, h = 64, color = '(40,90,150)') {
    execFileSync(unix ? 'python3' : 'python', ['-c', `from PIL import Image, ImageDraw\nim=Image.new('RGB',(${w},${h}),${color})\nImageDraw.Draw(im).rectangle([${w / 4},${h / 4},${w / 2},${h}],fill=(200,200,210))\nim.save(r'${file}')`]);
}

function textOf(result) { return result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'); }

// A stand-in ComfyUI: object_info, upload, prompt, history and view.
function fakeComfy({ checkpoints = ['flux1-schnell-fp8.safetensors', 'sdxl_base.safetensors', 'sdxl-inpaint.safetensors'], ipadapter = false } = {}) {
    const prompts = [];
    const uploads = [];
    const auth = [];
    const objectInfo = {
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [checkpoints] } } },
        LoraLoader: { input: { required: { model: ['MODEL'], clip: ['CLIP'], lora_name: [['studio_style.safetensors']], strength_model: ['FLOAT', { default: 1 }], strength_clip: ['FLOAT', { default: 1 }] } } },
        ControlNetLoader: { input: { required: { control_net_name: [['controlnet-scribble-sdxl.safetensors']] } } },
        UpscaleModelLoader: { input: { required: { model_name: [['4x-UltraSharp.pth']] } } },
        CLIPTextEncode: { input: { required: { text: ['STRING'], clip: ['CLIP'] } } },
        FluxGuidance: { input: { required: { conditioning: ['CONDITIONING'], guidance: ['FLOAT', { default: 3.5 }] } } },
        EmptyLatentImage: { input: { required: { width: ['INT', { default: 512 }], height: ['INT', { default: 512 }], batch_size: ['INT', { default: 1 }] } } },
        KSampler: { input: { required: { model: ['MODEL'], seed: ['INT'], steps: ['INT'], cfg: ['FLOAT'], sampler_name: [['euler']], scheduler: [['normal']], positive: ['C'], negative: ['C'], latent_image: ['L'], denoise: ['FLOAT', { default: 1 }] } } },
        VAEDecode: { input: { required: { samples: ['L'], vae: ['VAE'] } } },
        VAEEncode: { input: { required: { pixels: ['I'], vae: ['VAE'] } } },
        VAEEncodeForInpaint: { input: { required: { pixels: ['I'], vae: ['VAE'], mask: ['M'], grow_mask_by: ['INT', { default: 6 }] } } },
        SaveImage: { input: { required: { images: ['I'], filename_prefix: ['STRING', { default: 'ComfyUI' }] } } },
        LoadImage: { input: { required: { image: [['x.png']] } } },
        LoadImageMask: { input: { required: { image: [['x.png']], channel: [['alpha', 'red']] } } },
        SetLatentNoiseMask: { input: { required: { samples: ['L'], mask: ['M'] } } },
        ImagePadForOutpaint: { input: { required: { image: ['I'], left: ['INT'], top: ['INT'], right: ['INT'], bottom: ['INT'], feathering: ['INT', { default: 40 }] } } },
        ImageInvert: { input: { required: { image: ['I'] } } },
        ControlNetApplyAdvanced: { input: { required: { positive: ['C'], negative: ['C'], control_net: ['CN'], image: ['I'], strength: ['FLOAT'], start_percent: ['FLOAT'], end_percent: ['FLOAT'] } } },
        ImageUpscaleWithModel: { input: { required: { upscale_model: ['U'], image: ['I'] } } },
        ImageBatch: { input: { required: { image1: ['I'], image2: ['I'] } } }
    };
    if (ipadapter) {
        objectInfo.IPAdapterUnifiedLoader = { input: { required: { model: ['MODEL'], preset: [['PLUS (high strength)']] } } };
        objectInfo.IPAdapter = { input: { required: { model: ['MODEL'], ipadapter: ['IP'], image: ['I'], weight: ['FLOAT'], start_at: ['FLOAT'], end_at: ['FLOAT'], weight_type: [['standard', 'style transfer']] } } };
    }
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        auth.push(req.headers.authorization || '');
        let body = [];
        req.on('data', c => body.push(c));
        req.on('end', () => {
            body = Buffer.concat(body);
            const json = v => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(v)); };
            if (url.pathname === '/object_info') return json(objectInfo);
            if (url.pathname === '/upload/image') { const name = (body.toString('latin1').match(/filename="([^"]+)"/) || [])[1]; uploads.push(name); return json({ name, subfolder: 'codev', type: 'input' }); }
            if (url.pathname === '/prompt') { const p = JSON.parse(body); prompts.push(p.prompt); return json({ prompt_id: `p${prompts.length}` }); }
            if (url.pathname.startsWith('/history/')) {
                const id = url.pathname.split('/').pop();
                const graph = prompts[Number(id.slice(1)) - 1];
                const latent = Object.values(graph).find(n => n.class_type === 'EmptyLatentImage');
                const n = latent ? latent.inputs.batch_size : 1;
                return json({ [id]: { status: { status_str: 'success', completed: true }, outputs: { 9: { images: Array.from({ length: n }, (_, i) => ({ filename: `out_${i}.png`, subfolder: '', type: 'output' })) } } } });
            }
            if (url.pathname === '/view') { res.setHeader('Content-Type', 'image/png'); return res.end(PNG); }
            res.statusCode = 404; res.end('nope');
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, prompts, uploads, auth, close: () => server.close() })));
}

test('studio rules: defaults, deep merge with null deletes, names, styles', () => {
    const dir = project();
    const r = R.loadRules(dir);
    assert.equal(r.budgets.platform, 'godot4-mobile');
    assert.equal(R.trisBudget(r, 'weapon'), 5000);
    assert.equal(R.trisBudget(r, 'unknown'), 10000);
    const merged = R.merge(r, { budgets: { tris: { weapon: 4000 } }, notes: ['Keep emissives under 2 per skin'], naming: { case: 'kebab' } });
    assert.equal(merged.budgets.tris.weapon, 4000);
    assert.equal(merged.budgets.tris.prop, 3000);
    assert.equal(R.merge(merged, { budgets: { tris: { weapon: null } } }).budgets.tris.weapon, undefined);
    R.saveRules(dir, merged);
    const back = R.loadRules(dir);
    assert.equal(R.assetName(back, { category: 'Skin', name: 'Neon Samurai', variant: 'v2' }), 'skin-neon-samurai-v2');
    assert.deepEqual(R.checkName(back, 'NeonSamurai.glb'), { ok: false, suggestion: 'neon-samurai.glb' });
    assert.equal(R.assetName(R.loadRules(project()), { category: 'skin', name: 'mech' }), 'skin_mech');
    back.styles.neon = { prompt: 'neon rim light', references: ['art/styles/neon/ref_01.png'], palette: ['#ff00aa'], lora: { name: 'neon.safetensors', trigger: 'neonstyle' } };
    back.art_direction.style_prompt = 'stylised, hand-painted';
    const s = R.styleFor(back, 'neon');
    assert.match(s.prompt, /neon rim light.*hand-painted.*neonstyle.*#ff00aa/);
    assert.equal(R.styleFor(back, '').prompt, 'stylised, hand-painted');
    assert.throws(() => R.styleFor(back, 'missing'), /No saved style "missing"/);
    fs.writeFileSync(path.join(dir, R.RULES_FILE), '{oops');
    assert.throws(() => R.loadRules(dir), /isn't valid JSON/);
});

test('ComfyUI graphs: models, LoRAs, style references, inpaint masks, sketches, outpainting', () => {
    assert.equal(samplerFor('flux1-schnell.safetensors').steps, 4);
    assert.equal(samplerFor('juggernautXL.safetensors').family, 'sdxl');
    assert.equal(samplerFor('dreamshaper_8.safetensors').size, 512);
    assert.deepEqual(sizeFor('16:9', 1024), { width: 1344, height: 768 });
    assert.deepEqual(sizeFor('1:1', 512), { width: 512, height: 512 });
    const list = ['sdxl-inpaint.safetensors', 'flux1-schnell.safetensors', 'juggernautXL.safetensors'];
    assert.equal(pickCheckpoint(list, 'jugger'), 'juggernautXL.safetensors');
    assert.equal(pickCheckpoint(list, '', 'inpaint'), 'sdxl-inpaint.safetensors');
    assert.equal(pickCheckpoint(list, '', 'fast'), 'flux1-schnell.safetensors');
    assert.equal(pickCheckpoint(list, ''), 'juggernautXL.safetensors');

    const types = g => Object.values(g).map(n => n.class_type);
    const t2i = graphs.txt2img({ checkpoint: 'flux1-schnell.safetensors', prompt: 'mech', width: 1024, height: 1024, seed: 5, loras: [{ name: 'a.safetensors', weight: 0.7 }], styleRefs: ['codev/r1.png', 'codev/r2.png'], count: 3 });
    assert.deepEqual(types(t2i).slice(0, 2), ['CheckpointLoaderSimple', 'LoraLoader']);
    assert.ok(types(t2i).includes('IPAdapter') && types(t2i).includes('ImageBatch'));
    assert.ok(!types(t2i).includes('FluxGuidance'), 'schnell takes no guidance');
    assert.ok(types(graphs.txt2img({ checkpoint: 'flux1-dev.safetensors', prompt: 'm', width: 64, height: 64, seed: 1 })).includes('FluxGuidance'));
    const ks = Object.values(t2i).find(n => n.class_type === 'KSampler');
    assert.equal(ks.inputs.steps, 4);
    assert.equal(ks.inputs.cfg, 1);
    assert.equal(Object.values(t2i).find(n => n.class_type === 'EmptyLatentImage').inputs.batch_size, 3);
    // Links point at nodes that exist.
    for (const n of Object.values(t2i)) for (const v of Object.values(n.inputs)) if (Array.isArray(v) && typeof v[0] === 'string') assert.ok(t2i[v[0]], `link to missing node ${v[0]}`);

    const inpaint = graphs.edit({ checkpoint: 'sdxl.safetensors', prompt: 'visor', image: 'codev/a.png', mask: 'codev/m.png', denoise: 0.9, seed: 1 });
    assert.ok(types(inpaint).includes('SetLatentNoiseMask'));
    assert.equal(Object.values(inpaint).find(n => n.class_type === 'LoadImageMask').inputs.channel, 'red');
    assert.equal(Object.values(inpaint).find(n => n.class_type === 'KSampler').inputs.denoise, 0.9);
    const kontext = graphs.edit({ checkpoint: 'flux1-kontext-dev.safetensors', prompt: 'apply the grade', image: 'codev/a.png', seed: 1 });
    assert.ok(types(kontext).includes('ReferenceLatent'));
    const sketch = graphs.sketch({ checkpoint: 'sdxl.safetensors', prompt: 'knight', image: 'codev/s.png', controlnet: 'controlnet-scribble-sdxl.safetensors', width: 1024, height: 1024, seed: 1 });
    assert.ok(types(sketch).includes('ImageInvert') && types(sketch).includes('ControlNetApplyAdvanced'));
    assert.ok(types(graphs.sketch({ checkpoint: 'sdxl.safetensors', prompt: 'k', image: 'x', seed: 1 })).includes('VAEEncode'), 'no ControlNet falls back to img2img');
    const out = graphs.outpaint({ checkpoint: 'sdxl.safetensors', prompt: 'p', image: 'x', left: 10, right: 10, top: 0, bottom: 0, seed: 1 });
    assert.ok(types(out).includes('ImagePadForOutpaint') && types(out).includes('VAEEncodeForInpaint'));
});

test('the ComfyUI client fills defaults, queues, waits and downloads; a missing node is explained', async () => {
    const fake = await fakeComfy();
    try {
        const comfy = createComfy({ url: fake.url });
        const models = await comfy.models();
        assert.deepEqual(models.loras, ['studio_style.safetensors']);
        assert.equal(models.ipadapter, false);
        const pics = await comfy.run(graphs.txt2img({ checkpoint: 'sdxl_base.safetensors', prompt: 'x', width: 64, height: 64, seed: 1, count: 2 }));
        assert.equal(pics.length, 2);
        assert.ok(pics[0].equals(PNG));
        assert.equal(Object.values(fake.prompts[0]).find(n => n.class_type === 'SaveImage').inputs.filename_prefix, 'codev');
        const name = await comfy.upload(PNG, 'a.png');
        assert.equal(name, 'codev/a.png');
        await assert.rejects(comfy.run({ 1: { class_type: 'NotANode', inputs: {} } }), /no "NotANode" node/);
    } finally { fake.close(); }
    await assert.rejects(createComfy({ url: 'http://127.0.0.1:1' }).info(), /isn't running/);
});

test('LoRA training: settings from the dataset, kohya command, ai-toolkit config, caption review, progress', () => {
    const s = T.autoSettings({ base: 'sdxl', kind: 'style', images: 30, vramGb: 24 });
    assert.equal(s.trainer, 'kohya');
    assert.equal(s.network_dim, 32);
    assert.ok(s.steps >= 1200 && s.steps <= 3300, `steps ${s.steps}`);
    assert.equal(T.autoSettings({ base: 'sdxl', images: 8, vramGb: 8 }).network_dim, 16);
    const k = T.autoSettings({ base: 'kontext', kind: 'edit', images: 20 });
    assert.equal(k.trainer, 'ai-toolkit');
    assert.throws(() => T.autoSettings({ base: 'nope' }), /Unknown base/);

    const cmd = T.kohyaCommand({ kohyaDir: '/k', python: 'py', settings: s, modelPath: '/m.safetensors', dataDir: '/d', outDir: '/o', name: 'neon' });
    assert.equal(path.basename(cmd.args[0]), 'sdxl_train_network.py');
    assert.ok(cmd.args.includes('--network_train_unet_only'));
    assert.ok(!cmd.args.includes('--caption_dropout_rate'), 'cached text encoder outputs exclude caption dropout');
    const yaml = T.aiToolkitConfig({ settings: k, name: 'grade', trigger: '', afterDir: '/a', beforeDir: '/b', outDir: '/o' });
    assert.match(yaml, /arch: "flux_kontext"/);
    assert.match(yaml, /control_path: "\/b"/);
    assert.match(yaml, /folder_path: "\/a"/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-cap-'));
    const img = n => { const f = path.join(dir, n); fs.writeFileSync(f, PNG); return f; };
    const a = img('a.png'); fs.writeFileSync(a.replace('.png', '.txt'), 'neonstyle, a knight in armour standing');
    const b = img('b.png'); fs.writeFileSync(b.replace('.png', '.txt'), 'a knight in the style of neon artstation');
    const c = img('c.png');
    const d = img('d.png'); fs.writeFileSync(d.replace('.png', '.txt'), 'neonstyle, a knight in armour standing');
    const review = T.reviewCaptions({ images: [a, b, c, d], trigger: 'neonstyle', kind: 'style', minSize: 512 });
    assert.equal(review.ready, false);
    const problems = review.issues.map(i => `${i.file}: ${i.problem}`).join('\n');
    assert.match(problems, /c\.png: no caption/);
    assert.match(problems, /b\.png: caption doesn't contain the trigger/);
    assert.match(problems, /b\.png: describes the style itself/);
    assert.match(problems, /d\.png: same caption as a\.png/);
    assert.match(problems, /a\.png: small \(1×1\)/);
    assert.equal(review.issues[0].level, 'error');
    assert.deepEqual(T.imageSize(a), { width: 1, height: 1 });

    const jobs = T.createJobs();
    assert.deepEqual(jobs.progressOf('steps:  10%|█ | 100/1000 [00:10<01:30, avr_loss=0.123]\nsteps:  20%|██ | 200/1000 [00:20<01:20, avr_loss=0.101]'), { step: 200, total: 1000, loss: 0.101 });
});

test('training runs in the background and the finished LoRA is attached to the style', { skip: !unix }, async () => {
    const dir = project();
    for (let i = 0; i < 3; i++) { fs.writeFileSync(path.join(dir, 'refs', `r${i}.png`), PNG); fs.writeFileSync(path.join(dir, 'refs', `r${i}.txt`), `knight number ${i} with a sword`); }
    const kohya = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-kohya-'));
    // A stand-in trainer: prints progress and writes the LoRA where --output_dir says.
    fs.writeFileSync(path.join(kohya, 'sdxl_train_network.py'), `import sys, os\na = sys.argv\nout = a[a.index('--output_dir') + 1]\nname = a[a.index('--output_name') + 1]\nprint('steps: 50%| | 5/10 [00:01<00:01, avr_loss=0.2]', flush=True)\nopen(os.path.join(out, name + '.safetensors'), 'w').write('x')\n`);
    const comfyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-comfydir-'));
    fs.writeFileSync(path.join(dir, 'base.safetensors'), 'model');
    const svc = createCreativeService({ getProjectDir: () => dir, env: { ...process.env, CODEV_KOHYA_DIR: kohya, CODEV_COMFYUI_DIR: comfyDir, CODEV_COMFYUI_URL: 'http://127.0.0.1:1' } });
    const prep = await svc.callTool('art_lora_train', { op: 'prepare', name: 'Neon Knights', images: ['refs'], trigger: 'neonknt' });
    assert.ok(!prep.isError, textOf(prep));
    assert.match(textOf(prep), /Prepared "neon_knights".*3 picture/);
    const sub = fs.readdirSync(path.join(dir, 'art/training/neon_knights/dataset'))[0];
    assert.match(sub, /^\d+_neonknt illustration$/);
    assert.match(fs.readFileSync(path.join(dir, 'art/training/neon_knights/dataset', sub, 'img_001.txt'), 'utf8'), /^neonknt, knight number 0/);
    const noModel = await svc.callTool('art_lora_train', { op: 'start', name: 'neon knights', model_path: 'missing.safetensors' });
    assert.match(textOf(noModel), /kohya needs model_path/);
    const started = await svc.callTool('art_lora_train', { op: 'start', name: 'neon knights', model_path: path.join(dir, 'base.safetensors'), force: true });
    assert.match(textOf(started), /Started training "neon_knights"/, textOf(started));
    for (let i = 0; i < 100 && !/finished|failed/.test(textOf(await svc.callTool('art_lora_train', { op: 'status', name: 'neon knights' }))); i++) await new Promise(r => setTimeout(r, 100));
    const status = textOf(await svc.callTool('art_lora_train', { op: 'status', name: 'neon knights' }));
    assert.match(status, /finished/);
    assert.match(status, /step 5 of 10/);
    assert.ok(fs.existsSync(path.join(comfyDir, 'models/loras/codev/neon_knights.safetensors')));
    assert.deepEqual(R.loadRules(dir).styles.neon_knights.lora, { name: 'codev/neon_knights.safetensors', weight: 0.8, trigger: 'neonknt' });
    const caps = await svc.callTool('art_captions', { run: 'neon knights', op: 'set', captions: { 'img_002.png': 'a different knight kneeling' } });
    assert.match(textOf(caps), /img_002\.png: neonknt, a different knight kneeling/);
});

test('edit LoRAs pair before and after pictures by file name', async () => {
    const dir = project();
    fs.mkdirSync(path.join(dir, 'before')); fs.mkdirSync(path.join(dir, 'after'));
    for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(dir, 'after', `${n}.png`), PNG);
    for (const n of ['a', 'b']) fs.writeFileSync(path.join(dir, 'before', `${n}.png`), PNG);
    const svc = createCreativeService({ getProjectDir: () => dir, env: { ...process.env, CODEV_COMFYUI_URL: 'http://127.0.0.1:1' } });
    const res = await svc.callTool('art_lora_train', { op: 'prepare', name: 'grade pass', kind: 'edit', before: ['before'], after: ['after'], instruction: 'apply the studio colour grade' });
    const out = textOf(res);
    assert.match(out, /edit LoRA on kontext.*2 pair/);
    assert.match(out, /c\.png: has an "after" picture but no matching "before"/);
    assert.equal(fs.readFileSync(path.join(dir, 'art/training/grade_pass/dataset/after/pair_001.txt'), 'utf8').trim(), 'apply the studio colour grade');
    assert.ok(fs.existsSync(path.join(dir, 'art/training/grade_pass/dataset/before/pair_002.png')));
    const bad = await svc.callTool('art_lora_train', { op: 'prepare', name: 'x', kind: 'edit', base: 'sdxl', before: ['before'], after: ['after'] });
    assert.ok(bad.isError);
});

test('playable ads: one MRAID file per template, script compiles, size and store warnings', () => {
    const skin = `data:image/png;base64,${PNG.toString('base64')}`;
    for (const template of ['reveal', 'equip', 'runner', 'spin']) {
        const { html, warnings } = buildPlayable({ template, title: 'Neon <Knight>', skins: [skin, skin], storeUrl: 'https://play.google.com/store/apps/details?id=x' });
        assert.match(html, /<script src="mraid.js"><\/script>/);
        assert.match(html, /mraid\.open\(url\)/);
        assert.match(html, /Neon &lt;Knight&gt;/);
        assert.deepEqual(warnings, []);
        const js = html.match(/<script>([\s\S]*)<\/script>/)[1];
        assert.doesNotThrow(() => new vm.Script(js), template);
    }
    const big = buildPlayable({ skins: [skin], maxMb: 0.0001 });
    assert.match(big.warnings.join(' '), /over the 0.0001 MB/);
    assert.match(big.warnings.join(' '), /No store link/);
    assert.throws(() => buildPlayable({ template: 'nope', skins: [skin] }), /Unknown template/);
    assert.throws(() => buildPlayable({}), /at least one skin/);
});

test('art tools with a stand-in ComfyUI: concepts across models and directions, edits, try-on, reframing', { skip: !hasPython }, async () => {
    const fake = await fakeComfy({ ipadapter: true });
    const dir = project();
    try {
        makePng(path.join(dir, 'refs', 'hero.png'), 96, 128);
        makePng(path.join(dir, 'refs', 'look.png'), 64, 64, '(220,40,120)');
        const svc = createCreativeService({ getProjectDir: () => dir, env: { ...process.env, CODEV_COMFYUI_URL: fake.url } });
        const style = await svc.callTool('art_style', { op: 'clone', name: 'Season 4 Neon', references: ['refs/look.png'], description: 'neon rim light, cel shaded', set_default: true });
        assert.ok(!style.isError, textOf(style));
        assert.match(textOf(style), /Saved style "season_4_neon".*palette #/);
        assert.equal(R.loadRules(dir).art_direction.default_style, 'season_4_neon');

        const gen = await svc.callTool('art_generate', { prompt: 'mech knight skin', directions: ['chrome samurai', 'bio chitin'], models: ['flux', 'sdxl_base'], count: 1, category: 'skin', name: 'mech knight' });
        assert.ok(!gen.isError, textOf(gen));
        assert.match(textOf(gen), /Made 4 picture/);
        assert.equal(gen.content.filter(c => c.type === 'image').length, 1, 'one contact sheet');
        assert.equal(fs.readdirSync(path.join(dir, 'art/concepts/mech_knight')).length, 4);
        const first = fake.prompts[0];
        const text0 = Object.values(first).filter(n => n.class_type === 'CLIPTextEncode').map(n => n.inputs.text).join('|');
        assert.match(text0, /mech knight skin, chrome samurai, neon rim light, cel shaded/);
        assert.ok(Object.values(first).some(n => n.class_type === 'IPAdapter'), 'style references go through IP-Adapter');

        const edit = await svc.callTool('art_edit', { image: 'refs/hero.png', prompt: 'glowing cyan visor', mask_box: [0.3, 0.05, 0.4, 0.2] });
        assert.match(textOf(edit), /Changed the masked area with sdxl-inpaint/, textOf(edit));
        const sketch = await svc.callTool('art_edit', { mode: 'sketch', image_data: `data:image/png;base64,${PNG.toString('base64')}`, image_name: 'sketch_live', prompt: 'knight', return_data: true, no_preview: true });
        assert.match(textOf(sketch), /Redrew the sketch/);
        assert.match(sketch.structuredContent.dataUrl, /^data:image\/png;base64,/);
        assert.equal(sketch.structuredContent.file, 'art/concepts/edits/sketch_live_sketch.png');
        assert.ok(Object.values(fake.prompts.at(-1)).some(n => n.class_type === 'ControlNetApplyAdvanced'));

        const tryOn = await svc.callTool('art_try_on', { character: 'refs/hero.png', outfit_prompt: 'carbon fibre plate armour', region: 'upper' });
        assert.match(textOf(tryOn), /Put the outfit on the character \(upper\)/, textOf(tryOn));

        const ref = await svc.callTool('art_reframe', { image: 'refs/hero.png', presets: ['mobile_vertical', 'widescreen'] });
        assert.match(textOf(ref), /Reframed hero\.png into 2 size/, textOf(ref));
        assert.ok(Object.values(fake.prompts.at(-1)).some(n => n.class_type === 'ImagePadForOutpaint'));
        const bad = await svc.callTool('art_edit', { image: '../outside.png', prompt: 'x' });
        assert.ok(bad.isError);
        assert.match(textOf(bad), /inside the project folder/);
    } finally { fake.close(); }
});

test('free tools without ComfyUI: PBR maps, weathering stages, fill reframing, upscaling, sound effects', { skip: !hasPython }, async () => {
    const dir = project();
    makePng(path.join(dir, 'refs', 'plate.png'), 128, 128);
    const svc = createCreativeService({ getProjectDir: () => dir, env: { ...process.env, CODEV_COMFYUI_URL: 'http://127.0.0.1:1' } });
    const pbr = await svc.callTool('art_pbr_maps', { image: 'refs/plate.png', name: 'Hull Plate', metal_from_color: true });
    assert.ok(!pbr.isError, textOf(pbr));
    for (const k of ['albedo', 'normal', 'roughness', 'metallic', 'ao', 'height', 'curvature', 'orm']) assert.ok(fs.existsSync(path.join(dir, `art/textures/hull_plate/hull_plate_${k}.png`)), k);
    const w = await svc.callTool('art_weathering', { albedo: 'art/textures/hull_plate/hull_plate_albedo.png', stages: ['factory', 'battle'] });
    assert.ok(!w.isError, textOf(w));
    assert.ok(fs.existsSync(path.join(dir, 'art/textures/hull_plate/weathered/hull_plate_battle_orm.png')));
    const rf = await svc.callTool('art_reframe', { image: 'refs/plate.png', aspects: ['9:16'] });
    assert.match(textOf(rf), /colour-matched fill/);
    const size = T.imageSize(path.join(dir, 'marketing/reframed/plate/plate_9x16.png'));
    assert.deepEqual(size, { width: 128, height: 228 });
    const up = await svc.callTool('art_upscale', { images: ['refs/plate.png'], scale: 2, method: 'basic' });
    assert.match(textOf(up), /Upscaled 1 picture\(s\) 2x/);
    const sfx = await svc.callTool('art_audio', { op: 'sfx', preset: 'power_up', name: 'Mech Power Up' });
    assert.match(textOf(sfx), /audio\/sfx\/mech_power_up\.wav/);
    const gen = await svc.callTool('art_generate', { prompt: 'x', directions: ['a', 'b', 'c'], count: 3 });
    assert.ok(gen.isError);
    assert.match(textOf(gen), /at most 8/);
    const edit = await svc.callTool('art_edit', { image: 'refs/plate.png', prompt: 'x' });
    assert.match(textOf(edit), /needs ComfyUI, which isn't reachable/);
});

test('art_mesh runs the Blender pipeline with budgets and naming; voice cloning needs consent', { skip: !unix }, async () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, 'refs', 'armor.glb'), 'glb');
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-fakeblender-'));
    const blender = path.join(bin, 'blender');
    // A stand-in Blender: reads the job and writes a report like asset_pipeline.py does.
    fs.writeFileSync(blender, `#!${process.execPath}\nconst fs = require('fs');\nconst a = process.argv.slice(2);\nconst job = JSON.parse(fs.readFileSync(a[a.indexOf('--') + 1], 'utf8'));\nfs.writeFileSync(process.env.FAKE_JOB, JSON.stringify(job));\nif (job.output) fs.writeFileSync(job.output, 'glb');\nfs.writeFileSync(job.result, JSON.stringify({ ok: true, op: job.op, output: job.output, before_triangles: 40000, triangles: job.op === 'cleanup' ? job.target_tris : 40000, materials: 3, armatures: [{ name: 'Armature', bones: 80 }] }));\n`);
    fs.chmodSync(blender, 0o755);
    const jobFile = path.join(bin, 'job.json');
    const svc = createCreativeService({ getProjectDir: () => dir, env: { ...process.env, FAKE_JOB: jobFile, CODEV_COMFYUI_URL: 'http://127.0.0.1:1' }, findBlender: () => blender });
    const clean = await svc.callTool('art_mesh', { op: 'cleanup', input: 'refs/armor.glb', category: 'weapon', name: 'Plasma Blade' });
    const out = textOf(clean);
    assert.ok(!clean.isError, out);
    assert.match(out, /Saved art\/models\/weapon_plasma_blade_lod0\.glb/);
    assert.match(out, /Triangles: 40000 → 5000/);
    assert.match(out, /Within the weapon budget of 5000/);
    assert.match(out, /3 materials; the studio allows 2/);
    assert.match(out, /80 bones; the mobile budget is 64/);
    assert.equal(JSON.parse(fs.readFileSync(jobFile, 'utf8')).target_tris, 5000);
    const over = await svc.callTool('art_mesh', { op: 'uv', input: 'refs/armor.glb', category: 'prop' });
    assert.match(textOf(over), /Over budget: the studio allows 3000/);
    const noBase = await svc.callTool('art_mesh', { op: 'rig', input: 'refs/armor.glb' });
    assert.match(textOf(noBase), /needs base/);

    const clone = await svc.callTool('art_voice_clone', { text: 'For the guild!', reference_audio: ['refs/x.wav'], voice_owner: 'Sam' });
    assert.ok(clone.isError);
    assert.match(textOf(clone), /needs the voice owner's consent/);
    assert.ok(svc.tools.find(t => t.name === 'art_voice_clone')._meta['codev/alwaysAsk']);
    assert.ok(svc.tools.find(t => t.name === 'art_lora_train')._meta['codev/alwaysAsk']);
});

test('art_mesh dress fits a whole outfit, checks it in poses and reports what pokes through', { skip: !unix }, async () => {
    const dir = project();
    for (const f of ['base.glb', 'jacket.glb', 'boot_L.glb']) fs.writeFileSync(path.join(dir, 'refs', f), 'glb');
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-fakeblender-'));
    const blender = path.join(bin, 'blender');
    fs.writeFileSync(blender, `#!${process.execPath}\nconst fs = require('fs'); const path = require('path');\nconst a = process.argv.slice(2);\nconst job = JSON.parse(fs.readFileSync(a[a.indexOf('--') + 1], 'utf8'));\nfs.writeFileSync(process.env.FAKE_JOB, JSON.stringify(job));\nconst out = path.join(job.out_dir || '.', 'x_outfit.glb'); if (job.out_dir) { fs.mkdirSync(job.out_dir, { recursive: true }); fs.writeFileSync(out, 'glb'); }\nfs.writeFileSync(job.result, JSON.stringify({ ok: true, op: job.op, output: job.out_dir ? out : job.output, triangles: 9000, materials: 2, armatures: [{ name: 'Armature', bones: 60 }], layer_order: ['boot_L', 'jacket'], body_faces_hidden: 1200, helpers: ['LeftArmHelper'], pieces: { jacket: { slot: 'torso', main_bones: ['Spine', 'LeftArm'], pushed_verts: 12, faces_hidden: 0 }, boot_L: { slot: 'feet', side: 'left', main_bones: ['LeftFoot'] } }, pose_checks: { arms_up: { 'shirt through jacket': { checked: 40, poking: 3, share: 0.07, worst_mm: 6.5 } }, run: {} }, passed: false, files: { jacket: out, body: out, outfit: out } }));\n`);
    fs.chmodSync(blender, 0o755);
    const jobFile = path.join(bin, 'job.json');
    const svc = createCreativeService({ getProjectDir: () => dir, env: { ...process.env, FAKE_JOB: jobFile, CODEV_COMFYUI_URL: 'http://127.0.0.1:1' }, findBlender: () => blender });
    const none = await svc.callTool('art_mesh', { op: 'dress', base: 'refs/base.glb' });
    assert.ok(none.isError);
    assert.match(textOf(none), /dress needs inputs/);
    const res = await svc.callTool('art_mesh', { op: 'dress', base: 'refs/base.glb', inputs: ['refs/jacket.glb', 'refs/boot_L.glb'], name: 'Night Shift', slots: { jacket: 'torso' }, rigid: { helmet: 'Head' }, poses: ['arms_up', 'run'] });
    const out = textOf(res);
    assert.ok(!res.isError, out);
    const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
    assert.equal(job.op, 'dress');
    assert.equal(job.inputs.length, 2);
    assert.ok(job.inputs.every(p => path.isAbsolute(p)));
    assert.equal(job.output, undefined);
    assert.match(job.out_dir, /night_shift/);
    assert.deepEqual(job.slots, { jacket: 'torso' });
    assert.deepEqual(job.poses, ['arms_up', 'run']);
    assert.equal(job.hide_body, true);
    assert.match(out, /Layer order \(inside to outside\): boot_L → jacket/);
    assert.match(out, /arms_up: shirt through jacket 3 pts, worst 6\.5 mm/);
    assert.match(out, /- run: clean/);
    assert.match(out, /jacket: slot torso, follows Spine, LeftArm, 12 vertices pushed out/);
    assert.match(out, /Helper bones \(LeftArmHelper\)/);
    assert.match(out, /body_model/);
    const rig = await svc.callTool('art_mesh', { op: 'rig', input: 'refs/jacket.glb', base: 'refs/base.glb', slot: 'torso', rigid_bone: 'Spine2', margin: 0.006 });
    assert.ok(!rig.isError, textOf(rig));
    const rj = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
    assert.equal(rj.slot, 'torso');
    assert.equal(rj.rigid_bone, 'Spine2');
    assert.equal(rj.margin, 0.006);
    const rev = await svc.callTool('art_mesh', { op: 'review', input: 'refs/jacket.glb', pose: 'arms_up' });
    assert.equal(JSON.parse(fs.readFileSync(jobFile, 'utf8')).pose, 'arms_up');
    assert.ok(rev);
});

test('the skin-fit core passes its own tests (numpy)', { skip: !unix }, () => {
    const { spawnSync } = require('child_process');
    const probe = spawnSync('python3', ['-c', 'import numpy'], { encoding: 'utf8' });
    if (probe.status !== 0) return;
    const run = spawnSync('python3', ['-m', 'unittest', path.join(__dirname, '..', 'desktop', 'creative', 'bpy', 'test_skin_fit.py')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
});

test('studio rules tool and the tools reaching server.js and the MCP server', async () => {
    const dir = project();
    const svc = createCreativeService({ getProjectDir: () => dir, env: { ...process.env, CODEV_COMFYUI_URL: 'http://127.0.0.1:1' } });
    await svc.callTool('art_rules', { op: 'set', patch: { budgets: { tris: { skin: 9000 } }, naming: { case: 'kebab' } } });
    await svc.callTool('art_rules', { op: 'note', note: 'Visors always glow team colour' });
    const got = textOf(await svc.callTool('art_rules', { op: 'get' }));
    assert.match(got, /skin 9000/);
    assert.match(got, /Visors always glow team colour/);
    assert.equal(textOf(await svc.callTool('art_rules', { op: 'name', category: 'skin', name: 'Neon Knight', variant: 'battle' })), 'skin-neon-knight-battle');
    const none = createCreativeService({ getProjectDir: () => '' });
    assert.match(textOf(await none.callTool('art_rules', {})), /No project folder/);

    const router = await loadServices({ workspace: { root: dir } }, { log: () => {} });
    const listed = await router.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = listed.result.tools.map(t => t.name);
    for (const n of ['art_status', 'art_generate', 'art_mesh', 'art_playable_ad', 'art_lora_train']) assert.ok(names.includes(n), n);
    const called = await router.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'art_rules', arguments: { op: 'name', category: 'prop', name: 'crate' } } });
    assert.equal(called.result.content[0].text, 'prop-crate');
    await router.close();

    const mcp = createCodevMcp({ workspace: dir });
    const tools = mcp.tools();
    assert.ok(tools.some(t => t.name === 'art_materials') && tools.some(t => t.name === 'blender_run'));
    assert.ok(tools.every(t => !t._meta), 'CoDev-only _meta stays out of MCP clients');
    assert.match(mcp.instructions(), /skin 9000/);
    assert.match(mcp.readResource('codev://studio-rules').contents[0].text, /Visors always glow/);
    assert.equal((await mcp.call('art_rules', { op: 'name', category: 'skin', name: 'x' })).content[0].text, 'skin-x');
    await mcp.close();
});

test('the Windows app path: handleMcp adds art tools to the list and answers their calls', async () => {
    const svc = createCreativeService({ getProjectDir: () => project(), env: { ...process.env, CODEV_COMFYUI_URL: 'http://127.0.0.1:1' } });
    const next = async m => ({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'browser_open' }] } });
    const list = await svc.handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, next);
    assert.ok(list.result.tools.some(t => t.name === 'browser_open') && list.result.tools.some(t => t.name === 'art_reframe'));
    const call = await svc.handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'art_rules', arguments: { op: 'name', name: 'a' } } }, next);
    assert.equal(call.result.content[0].text, 'a');
});

test('Godot skin files: ORM materials, manifest upserts, the autoload entry and the registry script', () => {
    const G = require('../desktop/creative/godot-skins');
    const tres = G.materialTres({ albedo: 'res://a.png', orm: 'res://o.png', normal: 'res://n.png', tile: 2 });
    assert.match(tres, /^\[gd_resource type="ORMMaterial3D" load_steps=4 format=3\]/);
    assert.match(tres, /\[ext_resource type="Texture2D" path="res:\/\/o.png" id="2"\]/);
    assert.match(tres, /orm_texture = ExtResource\("2"\)\nmetallic = 1.0/);
    assert.match(tres, /normal_enabled = true\nnormal_texture = ExtResource\("3"\)/);
    assert.match(tres, /uv1_scale = Vector3\(2, 2, 1\)/);
    let m = G.upsertManifest('', { id: 'relay_chest_a', character: 'relay', slot: 'chest', created: 't1' });
    m = G.upsertManifest(m, { id: 'relay_helmet_b', character: 'relay', slot: 'helmet', created: 't2' });
    m = G.upsertManifest(m, { id: 'relay_chest_a', character: 'relay', slot: 'chest', name: 'New', created: 't3' });
    const data = JSON.parse(m);
    assert.equal(data.version, 1);
    assert.deepEqual(data.skins.map(s => s.id), ['relay_chest_a', 'relay_helmet_b']);
    assert.equal(data.skins[0].name, 'New');
    assert.equal(data.skins[0].created, 't1', 'first install time kept');
    assert.throws(() => G.upsertManifest('{"items": []}', { id: 'x' }), /no "skins" list/);
    assert.throws(() => G.upsertManifest('{oops', { id: 'x' }), /isn't valid JSON/);
    const fresh = G.addAutoload('config_version=5\n\n[application]\nconfig/name="G"\n', 'SkinRegistry', 'res://s.gd');
    assert.match(fresh, /\[autoload\]\n\nSkinRegistry="\*res:\/\/s.gd"\n$/);
    const other = G.addAutoload('[autoload]\n\nAudio="*res://audio.gd"\n\n[rendering]\nx=1\n', 'SkinRegistry', 'res://s.gd');
    assert.match(other, /Audio="\*res:\/\/audio.gd"\nSkinRegistry="\*res:\/\/s.gd"\n\n\[rendering\]\nx=1/);
    assert.equal(G.addAutoload(other, 'SkinRegistry', 'res://s.gd'), other);
    const gd = G.registryScript('res://data/skin_manifest.json');
    assert.match(gd, /^extends Node/);
    assert.match(gd, /const MANIFEST := "res:\/\/data\/skin_manifest.json"/);
    assert.match(gd, /func equip\(character_node: Node3D, skin_id: String, variant: String = ""\) -> Node3D:/);
    assert.ok(!/^ {2,}\S/m.test(gd), 'GDScript indented with tabs only');
    assert.match(gd, /const HELPERS := "res:\/\/data\/CoDevHelperBones.gd"/);
    assert.match(gd, /func ensure_helpers\(sk: Skeleton3D\)/);
    assert.match(gd, /body_model/);
    const hs = G.helperScript();
    assert.match(hs, /extends SkeletonModifier3D/);
    assert.match(hs, /ends_with\("Helper"\)/);
    assert.ok(!/^ {2,}\S/m.test(hs), 'GDScript indented with tabs only');
});

function godotProject() {
    const dir = project();
    fs.mkdirSync(path.join(dir, 'game'));
    fs.writeFileSync(path.join(dir, 'game', 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Continuum"\n');
    return dir;
}

test('art_godot_skin installs an equippable skin: files, materials per stage, manifest, autoload', async () => {
    const dir = godotProject();
    fs.writeFileSync(path.join(dir, 'refs', 'aegis.glb'), 'glb');
    for (const s of ['factory', 'battle']) for (const k of ['albedo', 'orm']) fs.writeFileSync(path.join(dir, 'refs', `${s}_${k}.png`), PNG);
    fs.writeFileSync(path.join(dir, 'refs', 'normal.png'), PNG);
    const svc = createCreativeService({ getProjectDir: () => dir, env: { ...process.env, CODEV_COMFYUI_URL: 'http://127.0.0.1:1' }, findBlender: () => '' });
    const variants = Object.fromEntries(['factory', 'battle'].map(s => [s, { albedo: `refs/${s}_albedo.png`, orm: `refs/${s}_orm.png`, normal: 'refs/normal.png' }]));
    const res = await svc.callTool('art_godot_skin', { model: 'refs/aegis.glb', name: 'AEGIS Armour', character: 'Relay', slot: 'chest', tier: 3, variants, tile_scale: 2, stats: { armor: 40 }, tris: 9000 });
    const out = textOf(res);
    assert.ok(!res.isError, out);
    const id = 'relay_chest_aegis_armour_epic';
    assert.equal(res.structuredContent.id, id);
    const skinDir = path.join(dir, 'game/assets/skins/relay', id);
    assert.ok(fs.existsSync(path.join(skinDir, `${id}.glb`)));
    assert.match(fs.readFileSync(path.join(skinDir, `${id}_battle.tres`), 'utf8'), new RegExp(`path="res://assets/skins/relay/${id}/textures/battle_orm.png"`));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'game/data/skin_manifest.json'), 'utf8'));
    const entry = manifest.skins[0];
    assert.equal(entry.model, `res://assets/skins/relay/${id}/${id}.glb`);
    assert.equal(entry.rarity, 'epic');
    assert.equal(entry.default_variant, 'factory');
    assert.deepEqual(Object.keys(entry.materials), ['factory', 'battle']);
    assert.deepEqual(entry.stats, { armor: 40 });
    assert.match(fs.readFileSync(path.join(dir, 'game/project.godot'), 'utf8'), /\[autoload\]\n\nSkinRegistry="\*res:\/\/scripts\/codev\/skin_registry.gd"/);
    assert.match(fs.readFileSync(path.join(dir, 'game/scripts/codev/skin_registry.gd'), 'utf8'), /res:\/\/data\/skin_manifest.json/);
    assert.match(out, /SkinRegistry\.equip\(\$Relay, "relay_chest_aegis_armour_epic", "factory"\)/);
    // A second install updates, doesn't duplicate, and a hand-edited registry is left alone.
    fs.writeFileSync(path.join(dir, 'game/scripts/codev/skin_registry.gd'), 'extends Node\n# mine\n');
    const again = await svc.callTool('art_godot_skin', { model: 'refs/aegis.glb', name: 'AEGIS Armour', character: 'relay', slot: 'chest', tier: 3, maps: variants.factory, tris: 20000 });
    assert.match(textOf(again), /was changed by hand/);
    assert.match(textOf(again), /20000 triangles is over the skin budget of 12000/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'game/data/skin_manifest.json'), 'utf8')).skins.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'game/project.godot'), 'utf8').match(/SkinRegistry=/g).length, 1);
    const noGodot = await createCreativeService({ getProjectDir: () => project(), findBlender: () => '' }).callTool('art_godot_skin', { model: 'x.glb', name: 'a', character: 'b', slot: 'c' });
    assert.match(textOf(noGodot), /No Godot project|There's no x.glb/);
});

test('art_skin_pipeline: one command from brief to equippable skins in Godot', { skip: !hasPython || !unix }, async () => {
    const fake = await fakeComfy();
    const dir = godotProject();
    try {
        fs.writeFileSync(path.join(dir, 'refs', 'aegis_raw.glb'), 'glb');
        fs.writeFileSync(path.join(dir, 'refs', 'relay_base.glb'), 'glb');
        const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-fakeblender-'));
        const blender = path.join(bin, 'blender');
        const ops = path.join(bin, 'ops.log');
        fs.writeFileSync(blender, `#!${process.execPath}\nconst fs = require('fs');\nconst a = process.argv.slice(2);\nconst job = JSON.parse(fs.readFileSync(a[a.indexOf('--') + 1], 'utf8'));\nfs.appendFileSync(${JSON.stringify(ops)}, job.op + (job.maps ? ' ' + Object.keys(job.maps).join(',') : '') + '\\n');\nif (job.output) fs.writeFileSync(job.output, 'glb');\nfs.writeFileSync(job.result, JSON.stringify({ ok: true, op: job.op, output: job.output, triangles: 8000, materials: 1, armatures: job.op === 'rig' || job.op === 'inspect' ? [{ name: 'Armature', bones: 40 }] : [] }));\n`);
        fs.chmodSync(blender, 0o755);
        const svc = createCreativeService({ getProjectDir: () => dir, env: { ...process.env, CODEV_COMFYUI_URL: fake.url }, findBlender: () => blender });
        const res = await svc.callTool('art_skin_pipeline', { brief: 'A.E.G.I.S. armour for Relay, angular plates, cyan energy seams', name: 'AEGIS', character: 'relay', slot: 'chest', tier: 3,
            variants: ['crimson', 'void'], mesh: 'refs/aegis_raw.glb', base: 'refs/relay_base.glb', stages: ['factory', 'battle'], pass: 'all', sfx: ['power_up'] });
        const out = textOf(res);
        assert.ok(!res.isError, out);
        assert.match(out, /✓ mesh cleaned to the skin budget/);
        assert.match(out, /✓ concept for AEGIS crimson/);
        assert.match(out, /✓ weathering \(factory, battle\) for AEGIS void/);
        assert.match(out, /✓ rigged to refs\/relay_base.glb/);
        assert.deepEqual(res.structuredContent.installed, ['relay_chest_aegis_crimson_epic', 'relay_chest_aegis_void_epic']);
        assert.deepEqual(fs.readFileSync(ops, 'utf8').trim().split('\n').map(l => l.split(' ')[0]), ['cleanup', 'uv', 'rig', 'review', 'texture', 'review', 'texture', 'review', 'review', 'review', 'inspect', 'inspect']);
        assert.match(out, /✓ sound: power_up/);
        assert.match(out, /Visible-first: Anything the player can see must look perfect/);
        // The base rig is remembered for the character, and the settings are kept as a template.
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'codev-studio.json'), 'utf8'));
        assert.equal(saved.skin_quality.base_rigs.relay, 'refs/relay_base.glb');
        assert.deepEqual(saved.skin_quality.templates.aegis.sfx, ['power_up']);
        assert.match(fs.readFileSync(ops, 'utf8'), /texture albedo,normal,roughness,metallic/);
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'game/data/skin_manifest.json'), 'utf8'));
        assert.equal(manifest.skins.length, 2);
        assert.ok(manifest.skins.every(s => s.rigged && s.icon && s.materials.battle && s.bones === 40));
        assert.ok(fs.existsSync(path.join(dir, 'game/assets/skins/relay/relay_chest_aegis_void_epic/icon.png')));
        const noMesh = await svc.callTool('art_skin_pipeline', { brief: 'chitin gauntlets', character: 'relay', slot: 'arms', concepts: false, pass: 'all' });
        assert.match(textOf(noMesh), /No mesh was given/);
    } finally { fake.close(); }
});

test('visible-first rules: the brief, the prompt words, review problems and the passes', () => {
    const q = R.DEFAULT_RULES.skin_quality;
    const s = { brief: 'Santa hat for Relay', theme: 'winter festival', palette: ['red', '#ffffff'], materials: ['velvet', 'fur trim'], silhouette: 'a tall floppy hat' };
    assert.equal(Q.briefOf(s), 'Santa hat for Relay. Theme: winter festival. Colour palette: red, #ffffff. Materials: velvet, fur trim. Silhouette changes: a tall floppy hat');
    const prompt = Q.conceptPrompt(s, q, 'gold', 'bigger pompom');
    assert.match(prompt, /sharp detailed face/);
    assert.match(prompt, /front and back visible/);
    assert.match(prompt, /Changes asked for: bigger pompom/);
    assert.match(Q.materialPrompt(s), /^velvet, fur trim, palette red #ffffff/);
    assert.match(Q.negativeWords(q), /melted details/);
    const report = { triangles: 14000, mesh_checks: { visible_open_edges: 6, nonmanifold_edges: 0, flipped_visible: 0.03, uv_stretched_visible: 0.2, meshes_without_uvs: [], hidden_tris: 900, visible_tris: 13100 },
        image_checks: { front: { coverage: 0.3, missing_texture: 0.01, detail: 0.01 }, top: { coverage: 0.001, missing_texture: 0, detail: 0 }, face: { coverage: 0.6, missing_texture: 0, detail: 0.00001 } } };
    const problems = Q.problemsFrom(report, q, { textured: true, budget: 12000 });
    assert.deepEqual(problems.map(p => p.code), ['holes', 'flipped', 'uv_stretch', 'over_budget', 'missing_texture', 'empty_view', 'soft_face']);
    assert.deepEqual(problems.map(p => p.fix), ['cleanup', 'cleanup', 'uv', 'cleanup', 'texture', '', '']);
    // Clay renders (the mesh pass) don't judge textures.
    assert.deepEqual(Q.problemsFrom(report, q, { textured: false }).map(p => p.code), ['holes', 'flipped', 'uv_stretch', 'empty_view']);
    const summary = Q.reviewSummary(report, problems);
    assert.match(summary, /7 problem\(s\) a player would notice/);
    assert.match(summary, /900 of 14000 triangles can't be seen/);
    assert.match(Q.reviewSummary({}, []), /^Passed/);
    assert.equal(Q.nextPass({ passes: {} }), 'concept');
    assert.equal(Q.nextPass({ passes: { concept: { status: 'skipped' }, mesh: { status: 'approved' }, textures: { status: 'ready' } } }), 'textures');
    assert.equal(Q.nextPass({ passes: Object.fromEntries(Q.PASSES.map(p => [p, { status: 'approved' }])) }), '');
    assert.match(R.summary(R.loadRules('')), /Skins: Anything the player can see must look perfect/);
});

test('a remote ComfyUI (a RunPod pod): the project setting wins and the token is sent', async () => {
    const fake = await fakeComfy();
    try {
        const comfy = createComfy({ url: fake.url + '/', token: 'pod-secret' });
        assert.equal(comfy.url, fake.url);
        await comfy.models();
        assert.equal(fake.auth[0], 'Bearer pod-secret');
        const dir = project();
        const svc = createCreativeService({ getProjectDir: () => dir, env: { ...process.env, CODEV_COMFYUI_URL: 'http://127.0.0.1:1', CODEV_COMFYUI_TOKEN: 'tok' } });
        assert.match(textOf(await svc.callTool('art_rules', { op: 'set', patch: { comfyui: { url: fake.url } } })), /Saved/);
        assert.match((await svc.status()).detail, /ComfyUI running at http:\/\/127\.0\.0\.1:\d+/);
        assert.equal(fake.auth[fake.auth.length - 1], 'Bearer tok');
        await svc.callTool('art_rules', { op: 'set', patch: { comfyui: null } });
        assert.match((await svc.status()).detail, /not running at http:\/\/127\.0\.0\.1:1/);
    } finally { fake.close(); }
});

// A stand-in Blender whose reviews find problems until a cleanup has run, to drive the fix loop.
function reviewingBlender({ stubborn = false } = {}) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-fakeblender-'));
    const blender = path.join(bin, 'blender');
    const ops = path.join(bin, 'ops.log');
    fs.writeFileSync(blender, `#!${process.execPath}
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2);
const job = JSON.parse(fs.readFileSync(a[a.indexOf('--') + 1], 'utf8'));
fs.appendFileSync(${JSON.stringify(ops)}, job.op + ' ' + path.basename(job.input) + (job.clay ? ' clay' : '') + '\\n');
if (job.output) fs.writeFileSync(job.output, 'glb');
const report = { ok: true, op: job.op, output: job.output, triangles: 8000, materials: 1, armatures: [] };
if (job.op === 'review') {
    const fixed = ${stubborn ? 'false' : "fs.readFileSync(" + JSON.stringify(ops) + ", 'utf8').split('\\n').filter(l => l.startsWith('cleanup')).length >= 2"};
    report.mesh_checks = { visible_open_edges: fixed ? 0 : 4, nonmanifold_edges: 0, flipped_visible: 0, uv_stretched_visible: 0, meshes_without_uvs: [], hidden_tris: 300, visible_tris: 7700 };
    report.views = {}; report.image_checks = {};
    for (const v of job.views) { const f = path.join(job.out_dir, job.name + '_' + v + '.png'); fs.writeFileSync(f, Buffer.from(${JSON.stringify(PNG.toString('base64'))}, 'base64')); report.views[v] = f; report.image_checks[v] = { coverage: 0.3, missing_texture: 0, detail: 0.01 }; }
}
fs.writeFileSync(job.result, JSON.stringify(report));
`);
    fs.chmodSync(blender, 0o755);
    return { blender, ops: () => fs.readFileSync(ops, 'utf8').trim().split('\n') };
}

test('art_mesh op review: every angle, the problems a player would notice, the renders', { skip: !unix }, async () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, 'refs', 'hat.glb'), 'glb');
    const fb = reviewingBlender();
    const svc = createCreativeService({ getProjectDir: () => dir, env: { ...process.env, CODEV_COMFYUI_URL: 'http://127.0.0.1:1' }, findBlender: () => fb.blender });
    const res = await svc.callTool('art_mesh', { op: 'review', input: 'refs/hat.glb', name: 'santa hat', clay: true, no_preview: true });
    const out = textOf(res);
    assert.ok(!res.isError, out);
    assert.match(out, /from 8 angle\(s\) \(front, back, left, right, top, below, face, game\)/);
    assert.match(out, /4 open edges where a player can see them/);
    assert.match(out, /300 of 8000 triangles can't be seen/);
    assert.equal(res.structuredContent.passed, false);
    assert.equal(res.structuredContent.views.face, 'art/reviews/santa_hat/santa_hat_face.png');
    assert.ok(fs.existsSync(path.join(dir, 'art/reviews/santa_hat/santa_hat_below.png')));
});

test('art_skin_pipeline in approval passes: concept, mesh with a fix loop, textures, effects, then install', { skip: !hasPython || !unix }, async () => {
    const fake = await fakeComfy();
    const dir = godotProject();
    try {
        fs.writeFileSync(path.join(dir, 'refs', 'hat_tripo.glb'), 'glb');
        fs.writeFileSync(path.join(dir, 'refs', 'Relay_CarbonSkin.glb'), 'glb');
        const fb = reviewingBlender();
        const svc = createCreativeService({ getProjectDir: () => dir, env: { ...process.env, CODEV_COMFYUI_URL: fake.url }, findBlender: () => fb.blender });
        const call = args => svc.callTool('art_skin_pipeline', { name: 'Santa hat', no_preview: true, ...args });
        // Pass 1: concept art, with the structured brief and the visible-first words.
        let res = await call({ brief: 'Santa hat for Relay', theme: 'winter festival', palette: ['red', 'white'], materials: ['velvet', 'fur trim'], silhouette: 'tall floppy hat', character: 'relay', slot: 'helmet', tier: 3, base: 'refs/Relay_CarbonSkin.glb', sfx: ['coin'], stages: ['factory'] });
        assert.ok(!res.isError, textOf(res));
        assert.match(textOf(res), /Pass 1 of 4 \(concept art\) for "Santa hat" passed its checks and is ready for the user/);
        const prompt = JSON.stringify(fake.prompts[0]);
        assert.match(prompt, /Theme: winter festival/);
        assert.match(prompt, /sharp detailed face/);
        assert.match(prompt, /melted details/);
        // Asking again without approving doesn't redo the work.
        assert.match(textOf(await call({})), /is waiting for the user/);
        // Feedback makes the pass again with the user's words.
        res = await call({ feedback: 'make the pompom bigger' });
        assert.match(JSON.stringify(fake.prompts[fake.prompts.length - 1]), /Changes asked for: make the pompom bigger/);
        // Pass 2 waits for the mesh from Tripo or Meshy.
        res = await call({ approve: true });
        assert.match(textOf(res), /✓ the user approved the concept art/);
        assert.match(textOf(res), /waiting for a mesh.*Tripo or Meshy/s);
        // With the mesh: cleaned, unwrapped, rigged onto the Relay rig, reviewed, fixed, reviewed again.
        res = await call({ mesh: 'refs/hat_tripo.glb' });
        const meshOut = textOf(res);
        assert.ok(!res.isError, meshOut);
        assert.match(meshOut, /✓ rigged to refs\/Relay_CarbonSkin.glb/);
        assert.match(meshOut, /closed gaps, merged seams and turned faces outward/);
        assert.match(meshOut, /review from every angle \(after fix 1\)/);
        assert.match(meshOut, /Pass 2 of 4 \(mesh\).*ready for the user/);
        // Pass 3: textures on the mesh, reviewed with the real materials.
        res = await call({ approve: true });
        assert.match(textOf(res), /Pass 3 of 4 \(textures\).*ready for the user/);
        // Pass 4: sounds and the in-game camera.
        res = await call({ approve: true });
        assert.match(textOf(res), /✓ sound: coin/);
        assert.match(textOf(res), /in-game camera check/);
        assert.ok(fs.existsSync(path.join(dir, 'audio/sfx/santa_hat_coin.wav')));
        // The last approval installs it in Godot and keeps the settings as a template.
        res = await call({ approve: true });
        assert.match(textOf(res), /Installed in Godot: relay_helmet_santa_hat_epic/);
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'game/data/skin_manifest.json'), 'utf8'));
        assert.equal(manifest.skins[0].id, 'relay_helmet_santa_hat_epic');
        assert.match(manifest.skins[0].description, /Silhouette changes: tall floppy hat/);
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'art/skins/santa_hat/skin.json'), 'utf8'));
        assert.deepEqual(Object.values(state.passes).map(p => p.status), ['approved', 'approved', 'approved', 'approved']);
        const rules = JSON.parse(fs.readFileSync(path.join(dir, 'codev-studio.json'), 'utf8'));
        assert.deepEqual(rules.skin_quality.templates.santa_hat.sfx, ['coin']);
        assert.match(textOf(await call({})), /is finished and installed/);
        const ops = fb.ops().map(l => l.split(' ')[0]);
        assert.deepEqual(ops.slice(0, 7), ['cleanup', 'uv', 'rig', 'review', 'cleanup', 'review', 'texture']);
        assert.ok(fb.ops()[3].endsWith('clay'), 'the mesh pass is judged in plain clay');
        // A template carries the sounds over to the next skin.
        res = await svc.callTool('art_skin_pipeline', { brief: 'Elf hat', character: 'relay', slot: 'helmet', template: 'santa hat', concepts: false, no_preview: true });
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'art/skins/elf_hat/skin.json'), 'utf8')).sfx[0], 'coin');
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'art/skins/elf_hat/skin.json'), 'utf8')).base, 'refs/Relay_CarbonSkin.glb', 'the base rig is remembered for relay');
    } finally { fake.close(); }
});

test('a pass that still fails its checks after the fix rounds is held back from the user', { skip: !hasPython || !unix }, async () => {
    const dir = godotProject();
    fs.writeFileSync(path.join(dir, 'refs', 'cape.glb'), 'glb');
    const fb = reviewingBlender({ stubborn: true });
    const svc = createCreativeService({ getProjectDir: () => dir, env: { ...process.env, CODEV_COMFYUI_URL: 'http://127.0.0.1:1' }, findBlender: () => fb.blender });
    const call = args => svc.callTool('art_skin_pipeline', { name: 'Cape', no_preview: true, ...args });
    let res = await call({ brief: 'torn cape', character: 'relay', slot: 'back', concepts: false, mesh: 'refs/cape.glb' });
    assert.match(textOf(res), /Pass 2 of 4 \(mesh\).*still has problems after 2 automatic fix round\(s\), so don't show it/s);
    assert.equal(fb.ops().filter(l => l.startsWith('review')).length, 3);
    res = await call({ approve: true });
    assert.ok(res.isError);
    assert.match(textOf(res), /accept_issues true only if the user said/);
    res = await call({ approve: true, accept_issues: true });
    assert.match(textOf(res), /✓ the user approved the mesh/);
    // pass "all" stops at a failing pass instead of installing it.
    const all = await svc.callTool('art_skin_pipeline', { brief: 'torn cape two', character: 'relay', slot: 'back', concepts: false, mesh: 'refs/cape.glb', pass: 'all', no_preview: true });
    assert.match(textOf(all), /still has problems/);
    assert.ok(!fs.existsSync(path.join(dir, 'game/data/skin_manifest.json')));
});

// The real Blender script, when a Blender is around (CODEV_TEST_BLENDER, a blender binary
// or a wrapper around the bpy module): a box with a hole, faces turned inward and a hidden
// box inside it.
test('the Blender review finds holes, flipped faces and hidden triangles', { skip: !process.env.CODEV_TEST_BLENDER && 'set CODEV_TEST_BLENDER to a Blender to run it' }, async () => {
    const dir = project();
    const make = path.join(dir, 'make.py');
    fs.writeFileSync(make, `import bpy, bmesh, sys
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 1)); body = bpy.context.object; body.scale = (0.4, 0.25, 1)
bpy.ops.object.transform_apply(scale=True)
bm = bmesh.new(); bm.from_mesh(body.data)
bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=4, use_grid_fill=True)
bm.faces.ensure_lookup_table()
bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.normal.y > 0.9][:1], context='FACES')
bm.faces.ensure_lookup_table()
bmesh.ops.reverse_faces(bm, faces=[f for f in bm.faces if f.normal.y < -0.9][:3])
bm.to_mesh(body.data); bm.free()
bpy.ops.mesh.primitive_cube_add(size=0.2, location=(0, 0, 1))
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=sys.argv[-1], export_format='GLB')
`);
    execFileSync(process.env.CODEV_TEST_BLENDER, ['--background', '--factory-startup', '--python', make, '--', path.join(dir, 'refs', 'box.glb')], { stdio: 'ignore' });
    const svc = createCreativeService({ getProjectDir: () => dir, env: { ...process.env, CODEV_COMFYUI_URL: 'http://127.0.0.1:1' }, findBlender: () => process.env.CODEV_TEST_BLENDER });
    const res = await svc.callTool('art_mesh', { op: 'review', input: 'refs/box.glb', clay: true, engine: 'cycles', size: 128, samples: 4, no_preview: true });
    assert.ok(!res.isError, textOf(res));
    const m = res.structuredContent.mesh_checks;
    assert.equal(m.visible_open_edges, 4, 'the one missing face on the back');
    assert.ok(m.flipped_visible > 0 && m.flipped_visible < 0.1, `flipped ${m.flipped_visible}`);
    assert.equal(m.hidden_tris, 12, 'the box inside');
    assert.deepEqual(res.structuredContent.problems.map(p => p.code), ['holes', 'flipped']);
    assert.equal(Object.keys(res.structuredContent.views).length, 8);
    assert.ok(Object.values(res.structuredContent.image_checks).every(c => c.coverage > 0.05));
    // drop_hidden spends the budget where players look.
    const clean = await svc.callTool('art_mesh', { op: 'cleanup', input: 'refs/box.glb', drop_hidden: true, no_preview: true });
    assert.match(textOf(clean), /Dropped 12 triangles no camera angle can see/);
});

// Reference pictures: what an agent made is held against them detail by detail.
function helmetPicture(file, { visor = '(0,220,220)', crest = true, stripes = true } = {}) {
    execFileSync(unix ? 'python3' : 'python', ['-c', [
        'from PIL import Image, ImageDraw',
        'im = Image.new("RGB", (400, 600), (255, 255, 255)); d = ImageDraw.Draw(im)',
        'd.ellipse([120, 40, 280, 200], fill=(60, 60, 70))',
        `d.rectangle([140, 100, 260, 140], fill=${visor})`,
        crest ? 'd.polygon([(200, 0), (215, 45), (185, 45)], fill=(200, 40, 40))' : 'pass',
        'd.rectangle([110, 200, 290, 520], fill=(80, 80, 90))',
        stripes ? '[d.line([(120, y), (280, y)], fill=(200, 200, 210), width=3) for y in range(220, 500, 16)]' : 'pass',
        `im.save(r"${file}")`].join('\n')]);
}

test('art_compare_reference: the render beside the reference, what differs and where, as pictures', { skip: !hasPython }, async () => {
    const dir = project();
    helmetPicture(path.join(dir, 'refs', 'ref.png'));
    helmetPicture(path.join(dir, 'refs', 'render.png'), { visor: '(220,120,0)', crest: false, stripes: false });
    helmetPicture(path.join(dir, 'refs', 'same.png'));
    const svc = createCreativeService({ getProjectDir: () => dir, env: { ...process.env, CODEV_COMFYUI_URL: 'http://127.0.0.1:1' } });
    assert.ok(svc.tools.some(t => t.name === 'art_compare_reference'));
    const res = await svc.callTool('art_compare_reference', { references: [{ image: 'refs/ref.png', view: 'front' }], renders: ['refs/render.png'], name: 'aegis helmet' });
    const out = textOf(res);
    assert.ok(!res.isError, out);
    assert.equal(res.structuredContent.passed, false);
    assert.match(out, /^front: \d+% match \(below the 80% target\); shape \d+%, colours \d+%, fine detail \d+%\./m);
    assert.match(out, /colours differ: the reference is #\w{6}, the render #\w{6}/);
    assert.match(out, /the reference has [\d.]+x the fine detail here/);
    assert.match(out, /Colours in the reference the render lacks: #\w{6}/);
    assert.match(out, /list each difference/);
    assert.equal(res.content.filter(c => c.type === 'image').length, 2, 'the sheet and the close-ups');
    const pair = res.structuredContent.pairs[0];
    assert.ok(fs.existsSync(path.join(dir, pair.sheet)) && fs.existsSync(path.join(dir, pair.closeups)));
    assert.match(pair.sheet, /^art\/reviews\/aegis_helmet-match\//);
    // The same picture matches.
    const same = await svc.callTool('art_compare_reference', { references: ['refs/ref.png'], renders: ['refs/same.png'], no_preview: true });
    assert.equal(same.structuredContent.passed, true, textOf(same));
    assert.ok(same.structuredContent.pairs[0].overall > 0.97);
    assert.equal(same.content.filter(c => c.type === 'image').length, 0);
    // Shape only (a clay render): colours don't count.
    const shape = await svc.callTool('art_compare_reference', { references: ['refs/ref.png'], renders: ['refs/render.png'], mode: 'shape', no_preview: true });
    assert.equal(shape.structuredContent.mode, 'shape');
    assert.doesNotMatch(textOf(shape), /colours differ/);
    // Nothing to compare with.
    assert.ok((await svc.callTool('art_compare_reference', { references: ['refs/ref.png'] })).isError);
    assert.ok((await svc.callTool('art_compare_reference', {})).isError);
});

test('art_skin_pipeline holds each pass to the reference pictures before the user sees it', { skip: !hasPython || !unix }, async () => {
    const fake = await fakeComfy();
    const dir = godotProject();
    try {
        helmetPicture(path.join(dir, 'refs', 'aegis_front.png'));
        const svc = createCreativeService({ getProjectDir: () => dir, env: { ...process.env, CODEV_COMFYUI_URL: fake.url } });
        // The stand-in ComfyUI makes a 1x1 picture, which is nothing like the reference.
        const res = await svc.callTool('art_skin_pipeline', { brief: 'AEGIS helmet', character: 'relay', slot: 'helmet', references: ['refs/aegis_front.png'], reference_views: ['front'], no_preview: true });
        const out = textOf(res);
        assert.ok(!res.isError, out);
        assert.match(out, /✓ AEGIS helmet concept: held against the reference \(front \d+%\)/);
        assert.match(out, /Pass 1 of 4 \(concept art\) for "AEGIS helmet" still has problems, so don't show it/);
        assert.match(out, /doesn't match the reference "front" yet/);
        assert.match(out, /It doesn't look like the reference yet\. Open the comparison sheets/);
        assert.equal(res.structuredContent.problems[0].code, 'reference');
        const state = JSON.parse(fs.readFileSync(path.join(dir, 'art/skins/aegis_helmet/skin.json'), 'utf8'));
        assert.deepEqual(state.reference_views, ['front']);
        assert.equal(state.passes.concept.status, 'needs_fix');
    } finally { fake.close(); }
});
