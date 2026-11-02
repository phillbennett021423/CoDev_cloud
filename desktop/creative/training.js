// Layer 1, the "identity" engine: teaches an image model the studio's own look.
//
//   style LoRA   kohya's sd-scripts (SDXL or SD 1.5), from a folder of the studio's art
//   edit LoRA    ostris' ai-toolkit (FLUX Kontext or Qwen-Image-Edit), from before/after
//                pairs, so a post-processing pass (colour grade, edge highlights,
//                weathering) can be applied to new pictures
//   FLUX LoRA    ai-toolkit too
//
// Both trainers are free and run on the user's own GPU. CoDev lays out the dataset the
// way each trainer wants it, checks the captions, picks the settings from the dataset
// size and the GPU memory, starts the run in the background and copies the finished
// LoRA into ComfyUI's models/loras so art_generate can use it at once.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp)$/i;

function listImages(dir) {
    try { return fs.readdirSync(dir).filter(n => IMAGE_EXT.test(n)).sort().map(n => path.join(dir, n)); } catch { return []; }
}

// Width and height from a PNG, JPEG or WebP header, without decoding it.
function imageSize(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(65536);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
            const kind = buf.toString('ascii', 12, 16);
            if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
            if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
            if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }; }
        }
        if (buf[0] === 0xff && buf[1] === 0xd8) {
            let i = 2;
            while (i < n - 9) {
                if (buf[i] !== 0xff) { i++; continue; }
                const marker = buf[i + 1];
                const len = buf.readUInt16BE(i + 2);
                if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
                i += 2 + len;
            }
        }
    } catch { /* unreadable */ } finally { if (fd !== undefined) fs.closeSync(fd); }
    return null;
}

const BASES = {
    sdxl: { trainer: 'kohya', script: 'sdxl_train_network.py', resolution: 1024 },
    sd15: { trainer: 'kohya', script: 'train_network.py', resolution: 512 },
    'flux-dev': { trainer: 'ai-toolkit', arch: 'flux', model: 'black-forest-labs/FLUX.1-dev', resolution: 1024 },
    'flux-schnell': { trainer: 'ai-toolkit', arch: 'flux', model: 'black-forest-labs/FLUX.1-schnell', assistant: 'ostris/FLUX.1-schnell-training-adapter', resolution: 1024 },
    kontext: { trainer: 'ai-toolkit', arch: 'flux_kontext', model: 'black-forest-labs/FLUX.1-Kontext-dev', resolution: 1024, edit: true },
    'qwen-edit': { trainer: 'ai-toolkit', arch: 'qwen_image_edit', model: 'Qwen/Qwen-Image-Edit', resolution: 1024, edit: true }
};

// Training settings from the dataset size, the kind of LoRA and the GPU memory.
function autoSettings({ base = 'sdxl', kind = 'style', images = 10, vramGb = 12 }) {
    const spec = BASES[base];
    if (!spec) throw new Error(`Unknown base "${base}". Bases: ${Object.keys(BASES).join(', ')}.`);
    const n = Math.max(1, images);
    const low = vramGb <= 10;
    if (spec.trainer === 'kohya') {
        const target = Math.min(Math.max(n * (kind === 'character' ? 120 : 100), 1200), 3000);
        const epochs = 10;
        const repeats = Math.min(Math.max(Math.ceil(target / (n * epochs)), 1), 40);
        const dim = n < 20 || low ? 16 : 32;
        return {
            trainer: 'kohya', base, repeats, epochs, steps: n * repeats * epochs,
            network_dim: dim, network_alpha: dim / 2, learning_rate: 1e-4,
            text_encoder_lr: base === 'sdxl' ? 0 : 5e-5, unet_only: base === 'sdxl',
            batch_size: low ? 1 : 2, optimizer: 'AdamW8bit', scheduler: 'cosine_with_restarts',
            resolution: spec.resolution, mixed_precision: 'bf16', gradient_checkpointing: true,
            save_every_n_epochs: 2, caption_dropout: kind === 'style' ? 0.05 : 0
        };
    }
    const steps = Math.min(Math.max(n * (spec.edit ? 120 : 100), 1000), 3000);
    return {
        trainer: 'ai-toolkit', base, arch: spec.arch, steps, rank: n < 20 || low ? 16 : 32, learning_rate: 1e-4,
        batch_size: 1, optimizer: 'adamw8bit', quantize: true, low_vram: low, resolution: [512, 768, spec.resolution],
        save_every: Math.max(250, Math.round(steps / 8 / 50) * 50), caption_dropout: spec.edit ? 0 : 0.05
    };
}

// The problems in a dataset's captions, worst first.
function reviewCaptions({ images, trigger = '', kind = 'style', minSize = 512, pairs = null }) {
    const issues = [];
    const seen = new Map();
    let ok = 0;
    for (const file of images) {
        const rel = path.basename(file);
        const capFile = file.replace(/\.[^.]+$/, '.txt');
        const size = imageSize(file);
        if (size && Math.min(size.width, size.height) < minSize) issues.push({ file: rel, level: 'warn', problem: `small (${size.width}×${size.height}); under ${minSize}px it trains blurry. Upscale it (art_upscale) or drop it.` });
        let caption = '';
        try { caption = fs.readFileSync(capFile, 'utf8').trim(); } catch { /* none */ }
        if (!caption) { issues.push({ file: rel, level: 'error', problem: 'no caption' }); continue; }
        const wordsCount = caption.split(/\s+/).length;
        if (trigger && !caption.toLowerCase().includes(trigger.toLowerCase())) issues.push({ file: rel, level: 'error', problem: `caption doesn't contain the trigger word "${trigger}"` });
        else if (trigger && kind === 'style' && !caption.toLowerCase().startsWith(trigger.toLowerCase())) issues.push({ file: rel, level: 'info', problem: 'trigger word isn\'t first; style LoRAs learn best with it first' });
        if (wordsCount > 70) issues.push({ file: rel, level: 'warn', problem: `${wordsCount} words; past about 75 tokens the rest is cut off` });
        if (wordsCount < 3) issues.push({ file: rel, level: 'warn', problem: 'very short; describe what\'s in the picture (subject, pose, background) so the LoRA learns only the style' });
        if (kind === 'style' && /\b(in the style of|art ?style|style of|artstation|trending)\b/i.test(caption)) issues.push({ file: rel, level: 'warn', problem: 'describes the style itself; leave style words out so the trigger word carries the style' });
        if (/\b(a picture of|an image of|this image)\b/i.test(caption)) issues.push({ file: rel, level: 'info', problem: 'filler words ("an image of"); say what\'s in it instead' });
        const key = caption.toLowerCase();
        if (seen.has(key)) issues.push({ file: rel, level: 'warn', problem: `same caption as ${seen.get(key)}; vary them so the LoRA doesn't tie one description to the style` });
        else seen.set(key, rel);
        ok++;
    }
    if (pairs) for (const name of pairs.missing) issues.push({ file: name, level: 'error', problem: 'has an "after" picture but no matching "before" picture (same file name)' });
    if (images.length < (kind === 'edit' ? 8 : 10)) issues.push({ file: '(dataset)', level: 'warn', problem: `only ${images.length} picture(s); ${kind === 'edit' ? '15 to 40 pairs' : '20 to 60 pictures'} train a steadier LoRA` });
    const rank = { error: 0, warn: 1, info: 2 };
    issues.sort((a, b) => rank[a.level] - rank[b.level]);
    return { captioned: ok, total: images.length, issues, ready: !issues.some(i => i.level === 'error') };
}

function kohyaCommand({ kohyaDir, python, settings, modelPath, dataDir, outDir, name }) {
    const s = settings;
    const args = [
        path.join(kohyaDir, BASES[s.base].script),
        '--pretrained_model_name_or_path', modelPath, '--train_data_dir', dataDir, '--output_dir', outDir, '--output_name', name,
        '--network_module', 'networks.lora', '--network_dim', String(s.network_dim), '--network_alpha', String(s.network_alpha),
        '--resolution', `${s.resolution},${s.resolution}`, '--train_batch_size', String(s.batch_size), '--max_train_epochs', String(s.epochs),
        '--learning_rate', String(s.learning_rate), '--unet_lr', String(s.learning_rate), '--optimizer_type', s.optimizer,
        '--lr_scheduler', s.scheduler, '--mixed_precision', s.mixed_precision, '--save_precision', 'fp16', '--save_model_as', 'safetensors',
        '--caption_extension', '.txt', '--enable_bucket', '--min_bucket_reso', '256', '--max_bucket_reso', String(s.resolution * 2),
        '--cache_latents', '--sdpa', '--save_every_n_epochs', String(s.save_every_n_epochs), '--max_data_loader_n_workers', '1', '--seed', '42'
    ];
    if (s.gradient_checkpointing) args.push('--gradient_checkpointing');
    if (s.unet_only) args.push('--network_train_unet_only', '--cache_text_encoder_outputs');
    else args.push('--text_encoder_lr', String(s.text_encoder_lr));
    // Cached text-encoder outputs can't be combined with caption dropout.
    if (s.caption_dropout && !s.unet_only) args.push('--caption_dropout_rate', String(s.caption_dropout));
    return { file: python, args, cwd: kohyaDir };
}

function aiToolkitConfig({ settings, name, trigger, afterDir, beforeDir, outDir, modelPath, samplePrompts = [] }) {
    const s = settings;
    const spec = BASES[s.base];
    const q = v => JSON.stringify(String(v));
    const lines = [
        'job: extension', 'config:', `  name: ${q(name)}`, '  process:', '    - type: sd_trainer',
        `      training_folder: ${q(outDir)}`, '      device: cuda:0'
    ];
    if (trigger) lines.push(`      trigger_word: ${q(trigger)}`);
    lines.push('      network:', '        type: lora', `        linear: ${s.rank}`, `        linear_alpha: ${s.rank}`,
        '      save:', '        dtype: float16', `        save_every: ${s.save_every}`, '        max_step_saves_to_keep: 4',
        '      datasets:', `        - folder_path: ${q(afterDir)}`, '          caption_ext: txt',
        `          caption_dropout_rate: ${s.caption_dropout}`, '          cache_latents_to_disk: true', `          resolution: [${s.resolution.join(', ')}]`);
    if (beforeDir) lines.push(`          control_path: ${q(beforeDir)}`);
    lines.push('      train:', `        batch_size: ${s.batch_size}`, `        steps: ${s.steps}`, '        gradient_accumulation_steps: 1',
        '        train_unet: true', '        train_text_encoder: false', '        gradient_checkpointing: true', '        noise_scheduler: flowmatch',
        `        optimizer: ${s.optimizer}`, `        lr: ${s.learning_rate}`, '        dtype: bf16',
        '      model:', `        name_or_path: ${q(modelPath || spec.model)}`, `        arch: ${q(spec.arch)}`, `        quantize: ${s.quantize}`);
    if (s.low_vram) lines.push('        low_vram: true');
    if (spec.assistant) lines.push(`        assistant_lora_path: ${q(spec.assistant)}`);
    if (samplePrompts.length) {
        lines.push('      sample:', '        sampler: flowmatch', `        sample_every: ${s.save_every}`, '        width: 1024', '        height: 1024', '        prompts:');
        for (const p of samplePrompts.slice(0, 4)) lines.push(`          - ${q(p)}`);
        lines.push('        guidance_scale: 4', '        sample_steps: 20');
    }
    return lines.join('\n') + '\n';
}

// Training runs in the background; its log and state live in the run's folder.
function createJobs({ log = () => {} } = {}) {
    const running = new Map();

    function progressOf(text) {
        const all = [...String(text).matchAll(/(\d+)\/(\d+) \[/g)];
        const last = all[all.length - 1];
        const loss = [...String(text).matchAll(/(?:avr_loss|loss)[=:]\s*([\d.]+)/g)].pop();
        return last ? { step: Number(last[1]), total: Number(last[2]), loss: loss ? Number(loss[1]) : null } : null;
    }

    function start(id, { file, args, cwd, env, dir, onDone }) {
        if (running.has(id)) throw new Error(`"${id}" is already training.`);
        fs.mkdirSync(dir, { recursive: true });
        const logFile = path.join(dir, 'train.log');
        const out = fs.openSync(logFile, 'w');
        const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['ignore', out, out] });
        const state = { id, pid: child.pid, started: new Date().toISOString(), status: 'running', logFile };
        fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(state, null, 2));
        running.set(id, { child, state, dir });
        const finish = async (code, err) => {
            fs.closeSync(out);
            running.delete(id);
            state.status = err ? 'failed' : code === 0 ? 'finished' : state.status === 'cancelled' ? 'cancelled' : 'failed';
            state.exitCode = code;
            state.ended = new Date().toISOString();
            if (err) state.error = err.message;
            if (state.status === 'finished' && onDone) {
                try { Object.assign(state, await onDone()); } catch (e) { state.afterError = e.message; }
            }
            fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(state, null, 2));
            log(`Training ${id} ${state.status}.`);
        };
        child.on('error', err => finish(null, err.code === 'ENOENT' ? new Error(`${file} wasn't found`) : err));
        child.on('close', code => { if (running.has(id)) finish(code); });
        return state;
    }

    function status(id, dir) {
        let state = null;
        try { state = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')); } catch { return null; }
        let tailText = '';
        try {
            const textAll = fs.readFileSync(state.logFile || path.join(dir, 'train.log'), 'utf8');
            state.progress = progressOf(textAll.slice(-20000));
            tailText = textAll.split(/\r|\n/).filter(l => l.trim()).slice(-12).join('\n');
        } catch { /* no log yet */ }
        if (state.status === 'running' && !running.has(id)) state.status = 'stopped (CoDev restarted while it ran; check the log)';
        return { ...state, tail: tailText };
    }

    function cancel(id) {
        const job = running.get(id);
        if (!job) return false;
        job.state.status = 'cancelled';
        job.child.kill();
        return true;
    }

    function closeAll() { for (const id of running.keys()) cancel(id); }

    return { start, status, cancel, closeAll, progressOf, running };
}

module.exports = { BASES, autoSettings, reviewCaptions, kohyaCommand, aiToolkitConfig, createJobs, listImages, imageSize, IMAGE_EXT };
