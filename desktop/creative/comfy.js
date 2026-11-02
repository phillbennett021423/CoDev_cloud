// ComfyUI, the free open-source image engine, running on the user's own computer
// (default http://127.0.0.1:8188, or CODEV_COMFYUI_URL). CoDev builds its graphs in
// ComfyUI's API format, queues them with POST /prompt, waits on /history/<id> and
// fetches the pictures with /view. Whatever checkpoints, LoRAs, ControlNets,
// upscalers and IP-Adapter nodes are installed there are what CoDev can use: GET
// /object_info lists them, and any required input a graph leaves out is filled
// with the default ComfyUI reports, so the graphs survive node updates.
//
//   createComfy({ url, fetchImpl }) -> { info(), models(), has(cls), upload(buf, name),
//     run(graph, { timeoutMs }) -> [Buffer], reachable() }
//   graphs.* build the graphs (pure functions, tested without ComfyUI).
const DEFAULT_URL = 'http://127.0.0.1:8188';

function createComfy({ url = process.env.CODEV_COMFYUI_URL || DEFAULT_URL, fetchImpl = globalThis.fetch } = {}) {
    const base = String(url).replace(/\/+$/, '');
    let infoCache = null;
    let infoAt = 0;

    async function request(pathname, init = {}, timeoutMs = 15000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(base + pathname, { ...init, signal: controller.signal });
            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(`ComfyUI answered HTTP ${response.status} for ${pathname}${body ? `: ${body.slice(0, 600)}` : ''}`);
            }
            return response;
        } catch (err) {
            if (err.name === 'AbortError') throw new Error(`ComfyUI at ${base} didn't answer in ${Math.round(timeoutMs / 1000)} s.`);
            if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(err.message)) throw new Error(`ComfyUI isn't running at ${base}.`);
            throw err;
        } finally { clearTimeout(timer); }
    }

    async function info(force = false) {
        if (!force && infoCache && Date.now() - infoAt < 60000) return infoCache;
        infoCache = await (await request('/object_info', {}, 20000)).json();
        infoAt = Date.now();
        return infoCache;
    }

    async function reachable() {
        try { await info(true); return true; } catch { return false; }
    }

    // The choices ComfyUI offers for one input of one node (its installed files).
    function choices(objectInfo, cls, input) {
        const node = objectInfo[cls];
        const spec = node && ((node.input.required || {})[input] || (node.input.optional || {})[input]);
        if (!spec) return [];
        if (Array.isArray(spec[0])) return spec[0];
        // Newer ComfyUI: ["COMBO", { options: [...] }]
        if (spec[0] === 'COMBO' && spec[1] && Array.isArray(spec[1].options)) return spec[1].options;
        return [];
    }

    async function models() {
        const oi = await info();
        return {
            checkpoints: choices(oi, 'CheckpointLoaderSimple', 'ckpt_name'),
            loras: choices(oi, 'LoraLoader', 'lora_name'),
            controlnets: choices(oi, 'ControlNetLoader', 'control_net_name'),
            upscalers: choices(oi, 'UpscaleModelLoader', 'model_name'),
            ipadapter: Boolean(oi.IPAdapterUnifiedLoader && oi.IPAdapter),
            rembg: Object.keys(oi).find(k => /^(Image Rembg|RemBGSession\+|BRIA_RMBG_ModelLoader_Zho|InspyrenetRembg)/.test(k)) || '',
            referenceLatent: Boolean(oi.ReferenceLatent && oi.FluxGuidance)
        };
    }

    async function has(cls) { return Boolean((await info())[cls]); }

    async function upload(buffer, name, type = 'image/png') {
        const form = new FormData();
        form.append('image', new Blob([buffer], { type }), name);
        form.append('overwrite', 'true');
        form.append('subfolder', 'codev');
        const reply = await (await request('/upload/image', { method: 'POST', body: form }, 60000)).json();
        return reply.subfolder ? `${reply.subfolder}/${reply.name}` : reply.name;
    }

    // Required inputs a graph didn't set get ComfyUI's own default.
    function fillDefaults(graph, oi) {
        for (const node of Object.values(graph)) {
            const spec = oi[node.class_type];
            if (!spec) throw new Error(`ComfyUI has no "${node.class_type}" node. Install it (ComfyUI Manager) or update ComfyUI.`);
            for (const [name, def] of Object.entries(spec.input.required || {})) {
                if (node.inputs[name] !== undefined) continue;
                const opts = def[1] || {};
                if (opts.default !== undefined) node.inputs[name] = opts.default;
                else if (Array.isArray(def[0]) && def[0].length) node.inputs[name] = def[0][0];
            }
        }
        return graph;
    }

    async function run(graph, { timeoutMs = 600000, onProgress } = {}) {
        const oi = await info();
        fillDefaults(graph, oi);
        const queued = await (await request('/prompt', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: graph, client_id: 'codev' })
        }, 30000)).json();
        if (queued.error) throw new Error(`ComfyUI refused the graph: ${JSON.stringify(queued.node_errors || queued.error).slice(0, 800)}`);
        const id = queued.prompt_id;
        const started = Date.now();
        let wait = 400;
        while (Date.now() - started < timeoutMs) {
            await new Promise(r => setTimeout(r, wait));
            wait = Math.min(wait * 1.5, 3000);
            const history = await (await request(`/history/${encodeURIComponent(id)}`)).json();
            const entry = history[id];
            if (!entry) { if (onProgress) onProgress(Date.now() - started); continue; }
            const status = entry.status || {};
            if (status.status_str === 'error') {
                const msg = (status.messages || []).find(m => m[0] === 'execution_error');
                throw new Error(`ComfyUI failed: ${msg ? `${msg[1].node_type}: ${msg[1].exception_message}` : 'see the ComfyUI window'}`.trim());
            }
            const images = [];
            for (const out of Object.values(entry.outputs || {})) for (const img of out.images || []) if (img.type !== 'temp') images.push(img);
            if (!images.length && status.completed === false) continue;
            const files = [];
            for (const img of images) {
                const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
                files.push(Buffer.from(await (await request(`/view?${q}`, {}, 60000)).arrayBuffer()));
            }
            return files;
        }
        throw new Error(`ComfyUI took longer than ${Math.round(timeoutMs / 1000)} s.`);
    }

    return { url: base, info, models, has, upload, run, reachable, fillDefaults, choices };
}

// Sampler settings by model family, guessed from the checkpoint's file name.
function samplerFor(ckpt = '') {
    const n = String(ckpt).toLowerCase();
    if (/schnell/.test(n)) return { family: 'flux', steps: 4, cfg: 1, sampler: 'euler', scheduler: 'simple', size: 1024, negative: false };
    if (/flux|kontext/.test(n)) return { family: 'flux', steps: 20, cfg: 1, sampler: 'euler', scheduler: 'simple', size: 1024, negative: false, guidance: 3.5 };
    if (/turbo|lightning|hyper|lcm/.test(n)) return { family: 'sdxl', steps: 6, cfg: 1.5, sampler: 'euler_ancestral', scheduler: 'sgm_uniform', size: 1024, negative: true };
    if (/xl|pony|illustrious|noob/.test(n)) return { family: 'sdxl', steps: 28, cfg: 6, sampler: 'dpmpp_2m', scheduler: 'karras', size: 1024, negative: true };
    if (/sd3|3\.5/.test(n)) return { family: 'sd3', steps: 28, cfg: 4.5, sampler: 'dpmpp_2m', scheduler: 'sgm_uniform', size: 1024, negative: true };
    return { family: 'sd15', steps: 28, cfg: 7, sampler: 'dpmpp_2m', scheduler: 'karras', size: 512, negative: true };
}

// Width and height for an aspect ratio at a model's native size, in steps of 64.
function sizeFor(aspect = '1:1', base = 1024) {
    const [w, h] = String(aspect).split(':').map(Number);
    const ratio = w > 0 && h > 0 ? w / h : 1;
    const area = base * base;
    const width = Math.round(Math.sqrt(area * ratio) / 64) * 64;
    const height = Math.round(Math.sqrt(area / ratio) / 64) * 64;
    return { width: Math.max(256, width), height: Math.max(256, height) };
}

// A graph under construction: add(class, inputs) returns the node's id; out(id, n)
// is a link to its nth output.
function builder() {
    const graph = {};
    let next = 1;
    return {
        graph,
        add(class_type, inputs = {}) { const id = String(next++); graph[id] = { class_type, inputs }; return id; },
        out(id, n = 0) { return [id, n]; }
    };
}

// The model, clip and vae with the LoRAs stacked on.
function loadModel(b, { checkpoint, loras = [] }) {
    const ck = b.add('CheckpointLoaderSimple', { ckpt_name: checkpoint });
    let model = b.out(ck, 0);
    let clip = b.out(ck, 1);
    for (const l of loras) {
        if (!l || !l.name) continue;
        const weight = Number.isFinite(Number(l.weight)) ? Number(l.weight) : 0.8;
        const id = b.add('LoraLoader', { model, clip, lora_name: l.name, strength_model: weight, strength_clip: weight });
        model = b.out(id, 0);
        clip = b.out(id, 1);
    }
    return { model, clip, vae: b.out(ck, 2) };
}

function conditioning(b, m, { prompt, negative = '', settings }) {
    let positive = b.out(b.add('CLIPTextEncode', { text: prompt, clip: m.clip }));
    if (settings.guidance) positive = b.out(b.add('FluxGuidance', { conditioning: positive, guidance: settings.guidance }));
    const neg = b.out(b.add('CLIPTextEncode', { text: settings.negative ? negative : '', clip: m.clip }));
    return { positive, negative: neg };
}

// Reference pictures steer the style through IP-Adapter (ComfyUI_IPAdapter_plus).
function applyStyleRefs(b, m, refs, weight = 0.6, weightType = 'style transfer') {
    if (!refs || !refs.length) return m;
    let image = b.out(b.add('LoadImage', { image: refs[0] }));
    for (const ref of refs.slice(1, 4)) image = b.out(b.add('ImageBatch', { image1: image, image2: b.out(b.add('LoadImage', { image: ref })) }));
    const loader = b.add('IPAdapterUnifiedLoader', { model: m.model, preset: 'PLUS (high strength)' });
    const ip = b.add('IPAdapter', { model: b.out(loader, 0), ipadapter: b.out(loader, 1), image, weight, start_at: 0, end_at: 1, weight_type: weightType });
    return { ...m, model: b.out(ip, 0) };
}

function sample(b, m, cond, latent, { seed, settings, denoise = 1 }) {
    return b.out(b.add('KSampler', {
        model: m.model, seed: Number(seed) >>> 0, steps: settings.steps, cfg: settings.cfg, sampler_name: settings.sampler,
        scheduler: settings.scheduler, positive: cond.positive, negative: cond.negative, latent_image: latent, denoise
    }));
}

function save(b, m, samples, prefix = 'codev') {
    const image = b.out(b.add('VAEDecode', { samples, vae: m.vae }));
    b.add('SaveImage', { images: image, filename_prefix: prefix });
    return image;
}

const graphs = {
    // A new picture from a prompt.
    txt2img({ checkpoint, prompt, negative, width, height, seed, loras, styleRefs, styleWeight, count = 1 }) {
        const settings = samplerFor(checkpoint);
        const b = builder();
        let m = loadModel(b, { checkpoint, loras });
        m = applyStyleRefs(b, m, styleRefs, styleWeight);
        const cond = conditioning(b, m, { prompt, negative, settings });
        const latent = b.out(b.add('EmptyLatentImage', { width, height, batch_size: Math.min(Math.max(count, 1), 8) }));
        save(b, m, sample(b, m, cond, latent, { seed, settings }));
        return b.graph;
    },

    // Changes a picture: everywhere (img2img), or only under the mask (inpaint).
    edit({ checkpoint, prompt, negative, image, mask, denoise = 0.6, seed, loras, styleRefs, styleWeight, refWeightType }) {
        const settings = samplerFor(checkpoint);
        const b = builder();
        let m = loadModel(b, { checkpoint, loras });
        m = applyStyleRefs(b, m, styleRefs, styleWeight, refWeightType);
        const pixels = b.out(b.add('LoadImage', { image }));
        let latent = b.out(b.add('VAEEncode', { pixels, vae: m.vae }));
        let cond = conditioning(b, m, { prompt, negative, settings });
        if (/kontext/i.test(checkpoint)) {
            // FLUX Kontext edits by instruction with the picture as a reference latent.
            cond = { ...cond, positive: b.out(b.add('ReferenceLatent', { conditioning: cond.positive, latent })) };
        }
        if (mask) {
            const maskOut = b.out(b.add('LoadImageMask', { image: mask, channel: 'red' }));
            latent = b.out(b.add('SetLatentNoiseMask', { samples: latent, mask: maskOut }));
        }
        save(b, m, sample(b, m, cond, latent, { seed, settings, denoise: /kontext/i.test(checkpoint) ? 1 : denoise }));
        return b.graph;
    },

    // A rough sketch redrawn in the style: ControlNet (scribble/lineart) when one is
    // installed, otherwise img2img on the sketch.
    sketch({ checkpoint, prompt, negative, image, controlnet, strength = 0.85, seed, loras, styleRefs, styleWeight, width, height }) {
        const settings = samplerFor(checkpoint);
        if (!controlnet) return graphs.edit({ checkpoint, prompt, negative, image, denoise: 0.82, seed, loras, styleRefs, styleWeight });
        const b = builder();
        let m = loadModel(b, { checkpoint, loras });
        m = applyStyleRefs(b, m, styleRefs, styleWeight);
        let cond = conditioning(b, m, { prompt, negative, settings });
        let hint = b.out(b.add('LoadImage', { image }));
        // Scribble ControlNets want white lines on black; sketches are dark on white.
        if (/scribble|lineart|sketch|canny|union/i.test(controlnet)) hint = b.out(b.add('ImageInvert', { image: hint }));
        const cn = b.add('ControlNetLoader', { control_net_name: controlnet });
        const applied = b.add('ControlNetApplyAdvanced', { positive: cond.positive, negative: cond.negative, control_net: b.out(cn), image: hint, strength, start_percent: 0, end_percent: 1, vae: m.vae });
        cond = { positive: b.out(applied, 0), negative: b.out(applied, 1) };
        const latent = b.out(b.add('EmptyLatentImage', { width, height, batch_size: 1 }));
        save(b, m, sample(b, m, cond, latent, { seed, settings }));
        return b.graph;
    },

    // Grows the canvas and paints the new area to match (reframing key art).
    outpaint({ checkpoint, prompt, negative, image, left, top, right, bottom, seed, loras }) {
        const settings = samplerFor(checkpoint);
        const b = builder();
        const m = loadModel(b, { checkpoint, loras });
        const pixels = b.out(b.add('LoadImage', { image }));
        const pad = b.add('ImagePadForOutpaint', { image: pixels, left, top, right, bottom, feathering: 48 });
        const latent = b.out(b.add('VAEEncodeForInpaint', { pixels: b.out(pad, 0), vae: m.vae, mask: b.out(pad, 1), grow_mask_by: 16 }));
        const cond = conditioning(b, m, { prompt, negative, settings });
        save(b, m, sample(b, m, cond, latent, { seed, settings }));
        return b.graph;
    },

    upscale({ image, model }) {
        const b = builder();
        const loader = b.add('UpscaleModelLoader', { model_name: model });
        const up = b.add('ImageUpscaleWithModel', { upscale_model: b.out(loader), image: b.out(b.add('LoadImage', { image })) });
        b.add('SaveImage', { images: b.out(up), filename_prefix: 'codev_up' });
        return b.graph;
    }
};

// The checkpoint to use: the one asked for (by name or part of it), the studio's
// default, or the best installed one for the job.
function pickCheckpoint(list, wanted, purpose = 'general') {
    if (!list.length) return '';
    const find = w => w && (list.find(c => c === w) || list.find(c => c.toLowerCase().includes(String(w).toLowerCase())));
    const asked = find(wanted);
    if (asked) return asked;
    const pref = purpose === 'inpaint' ? [/inpaint/i, /xl/i, /flux/i] : purpose === 'fast' ? [/schnell|turbo|lightning|hyper/i, /xl/i] : [/xl|pony|illustrious/i, /flux/i];
    for (const re of pref) { const hit = list.find(c => re.test(c) && (purpose === 'inpaint' || !/inpaint|refiner/i.test(c))); if (hit) return hit; }
    return list.find(c => !/inpaint|refiner/i.test(c)) || list[0];
}

module.exports = { createComfy, graphs, samplerFor, sizeFor, pickCheckpoint, DEFAULT_URL };
