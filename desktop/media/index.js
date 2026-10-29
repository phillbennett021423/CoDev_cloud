// Video and audio editing for agents, with four free, open-source tools run in
// Docker on this computer: FFmpeg, Whisper (faster-whisper), Demucs and
// DeepFilterNet. They live in the codev-media image (image/Dockerfile), and
// image/codev_media.py turns an agent's plain steps ("clean_speech", then
// "add_music" at 15%) into runs of them.
//
// The user attaches a video in the chat; the page uploads it to the media
// folder (<data folder>/media/uploads), the agent edits it with the media_*
// tools, and the page shows what lands in media/outputs with a player and a
// download button. Each job runs in its own `docker run --rm` container that
// sees only the media folder, with no network, no Linux capabilities and a
// read-only root filesystem. One job runs at a time, since they're heavy.
//
// The image is pulled from GitHub's registry (built by .github/workflows/media-image.yml),
// or built here from image/ when it can't be pulled. That's about 4 GB, once.
//
// The same service can run on a server for other people's phones. The host then
// passes resolveUser (each user gets their own folder) and authorize (the plan
// check and the monthly minutes); on the user's own PC both are left out and
// everything is allowed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { docker } = require('../sandbox/container-manager');

const DEFAULT_IMAGE = 'ghcr.io/phillbennett021423/codev-media:1';
const LOCAL_IMAGE = 'codev-media:local';
const IMAGE_DIR = path.join(__dirname, 'image').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const MAX_UPLOAD_BYTES = Number(process.env.CODEV_MEDIA_MAX_UPLOAD_MB || 2048) * 1024 * 1024;
const JOB_TIMEOUT_MS = Number(process.env.CODEV_MEDIA_TIMEOUT_MINUTES || 60) * 60 * 1000;
const MAX_LISTED = 200;
const KINDS = {
    video: ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'],
    audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.weba'],
    image: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
    text: ['.srt', '.vtt', '.txt']
};
const TYPES = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
    '.flac': 'audio/flac', '.weba': 'audio/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.txt': 'text/plain; charset=utf-8'
};

class MediaError extends Error {}

function kindOf(name) {
    const ext = path.extname(String(name)).toLowerCase();
    return Object.keys(KINDS).find(kind => KINDS[kind].includes(ext)) || null;
}

// A file name that is safe on every system, keeping its extension.
function safeName(name) {
    const base = path.basename(String(name || '').replace(/\\/g, '/'));
    const ext = path.extname(base).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 8);
    const stem = path.basename(base, path.extname(base)).normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 80) || 'file';
    return stem + ext;
}

function cleanId(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 64);
}

function createMedia({ dataDir, log = () => {}, dockerPath, resolveUser, authorize, image } = {}) {
    if (!dataDir) throw new Error('The media service needs a data folder.');
    const root = path.join(dataDir, 'media');
    const run = (args, opts = {}) => docker(args, { dockerPath: dockerPath || process.env.CODEV_DOCKER || 'docker', ...opts });
    const wantedImage = image || process.env.CODEV_MEDIA_IMAGE || DEFAULT_IMAGE;
    const config = {
        memory: process.env.CODEV_MEDIA_MEMORY || '6g',
        cpus: process.env.CODEV_MEDIA_CPUS || String(Math.max(1, Math.min(8, require('os').cpus().length - 1)))
    };
    // Image state: unknown -> checking -> ready | missing -> preparing -> ready | failed.
    const setup = { state: 'unknown', image: null, detail: '', startedAt: 0, promise: null };
    let queue = Promise.resolve();
    let dockerState = { at: 0, available: false, reason: '' };

    async function dockerUp() {
        if (Date.now() - dockerState.at < 30000) return dockerState;
        const reply = await run(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 8000 });
        dockerState = reply.missing ? { at: Date.now(), available: false, reason: 'Docker isn\'t installed on this computer. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) to edit videos with CoDev.' }
            : reply.code !== 0 ? { at: Date.now(), available: false, reason: 'Docker is installed but not running. Start Docker Desktop and try again.' }
            : { at: Date.now(), available: true, reason: '', version: reply.stdout.trim() };
        return dockerState;
    }

    async function hasImage(name) {
        return (await run(['image', 'inspect', '--format', '{{.Id}}', name], { timeoutMs: 15000 })).code === 0;
    }

    // Which image is here already, without downloading anything.
    async function checkImage() {
        if (setup.state === 'ready' || setup.state === 'preparing') return setup;
        for (const name of [wantedImage, LOCAL_IMAGE]) {
            if (await hasImage(name)) Object.assign(setup, { state: 'ready', image: name, detail: '' });
            if (setup.state === 'ready') return setup;
        }
        if (setup.state !== 'failed') Object.assign(setup, { state: 'missing', detail: 'The video tools aren\'t downloaded yet (about 4 GB, once).' });
        return setup;
    }

    // Pulls the image, or builds it from image/ when it can't be pulled. Runs once
    // in the background; callers can await setup.promise.
    function prepare() {
        if (setup.promise) return setup.promise;
        setup.promise = (async () => {
            const up = await dockerUp();
            if (!up.available) throw new MediaError(up.reason);
            if ((await checkImage()).state === 'ready') return setup;
            Object.assign(setup, { state: 'preparing', startedAt: Date.now(), detail: 'Downloading the video tools (about 4 GB, once)…' });
            log(`Downloading ${wantedImage} for video editing.`);
            const pull = await run(['pull', wantedImage], { timeoutMs: 60 * 60 * 1000 });
            if (pull.code === 0) return Object.assign(setup, { state: 'ready', image: wantedImage, detail: '' });
            log(`Couldn't download ${wantedImage} (${lastLine(pull.stderr)}); building it here from ${IMAGE_DIR} instead.`);
            Object.assign(setup, { detail: 'Building the video tools on this computer (10 to 20 minutes, once)…' });
            const build = await run(['build', '-t', LOCAL_IMAGE, IMAGE_DIR], { timeoutMs: 90 * 60 * 1000, maxBytes: 4 * 1024 * 1024 });
            if (build.code !== 0) throw new MediaError(`Couldn't build the video tools: ${lastLine(build.stderr || build.stdout)}`);
            return Object.assign(setup, { state: 'ready', image: LOCAL_IMAGE, detail: '' });
        })().then(result => {
            log('The video tools are ready.');
            return result;
        }, err => {
            Object.assign(setup, { state: 'failed', detail: err.message });
            log(err.message);
            return setup;
        }).finally(() => { setup.promise = null; });
        return setup.promise;
    }

    // Each user's own folder: one on the user's PC, one per account on a server.
    function folderFor(ctx = {}) {
        const user = resolveUser ? cleanId(resolveUser(ctx)) : 'local';
        if (!user) throw new MediaError('Sign in to use video editing.');
        const dir = user === 'local' ? root : path.join(root, 'users', user);
        for (const sub of ['uploads', 'outputs', '.jobs']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
        return dir;
    }

    // Absolute path of a file the agent or the page named, inside the user's folder.
    function fileIn(dir, rel, { mustExist = true } = {}) {
        const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
        if (!clean) throw new MediaError('A file name is missing.');
        const full = path.resolve(dir, clean);
        if (!full.startsWith(dir + path.sep) || clean.split('/').some(part => part.startsWith('.'))) throw new MediaError(`'${rel}' isn't in the media folder.`);
        if (mustExist && !(fs.existsSync(full) && fs.statSync(full).isFile())) {
            // "clip.mp4" for "uploads/clip.mp4": agents often leave the folder off.
            for (const sub of ['uploads', 'outputs']) {
                const guess = path.join(dir, sub, clean);
                if (!clean.includes('/') && fs.existsSync(guess)) return guess;
            }
            throw new MediaError(`There's no file '${rel}'. Call media_files to see what's there.`);
        }
        return full;
    }

    function listFiles(dir) {
        const files = [];
        for (const sub of ['uploads', 'outputs']) {
            let names = [];
            try { names = fs.readdirSync(path.join(dir, sub)); } catch { continue; }
            for (const name of names) {
                const full = path.join(dir, sub, name);
                let stat;
                try { stat = fs.statSync(full); } catch { continue; }
                if (!stat.isFile() || name.startsWith('.')) continue;
                files.push({ name: `${sub}/${name}`, kind: kindOf(name), size: stat.size, modified: stat.mtimeMs, made: sub === 'outputs' });
            }
        }
        return files.sort((a, b) => b.modified - a.modified).slice(0, MAX_LISTED);
    }

    // Runs codev_media.py in a fresh container on the user's folder. One at a time.
    function runJob(dir, command, spec) {
        const job = queue.then(async () => {
            const ready = await prepare();
            if (ready.state !== 'ready') throw new MediaError(ready.detail || 'The video tools aren\'t ready.');
            const id = crypto.randomBytes(6).toString('hex');
            const specFile = path.join(dir, '.jobs', `${id}.json`);
            fs.writeFileSync(specFile, JSON.stringify(spec));
            const name = `codev-media-${id}`;
            const args = ['run', '--rm', '--name', name, '--label', 'codev.media', '--label', `codev.media.pid=${process.pid}`,
                '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
                '--tmpfs', '/tmp:rw,exec,size=1g', '--memory', config.memory, '--cpus', config.cpus, '--pids-limit', '512',
                '--mount', `type=bind,source=${dir},target=/media`, '--env', 'HOME=/tmp'];
            if (typeof process.getuid === 'function') args.push('--user', `${process.getuid()}:${process.getgid()}`);
            args.push(setup.image, command, `.jobs/${id}.json`);
            const started = Date.now();
            try {
                const reply = await run(args, { timeoutMs: JOB_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024 });
                if (reply.timedOut) {
                    await run(['rm', '-f', name], { timeoutMs: 30000 });
                    throw new MediaError(`The edit took longer than ${Math.round(JOB_TIMEOUT_MS / 60000)} minutes and was stopped. Try a shorter clip or fewer steps.`);
                }
                const result = parseResult(reply);
                log(`${command} ${spec.input || ''} -> ${result.ok ? (result.output || (result.files || []).join(', ') || 'done') : result.error} (${Math.round((Date.now() - started) / 1000)}s)`);
                return result;
            } finally {
                fs.rm(specFile, { force: true }, () => {});
            }
        });
        queue = job.catch(() => {});
        return job;
    }

    // Removes the containers of a CoDev that crashed mid-job, and leftover scratch files.
    async function cleanup() {
        const reply = await run(['ps', '-a', '--filter', 'label=codev.media', '--format', '{{.ID}} {{.Label "codev.media.pid"}}'], { timeoutMs: 15000 });
        if (reply.code === 0) {
            const stale = reply.stdout.split('\n').map(line => line.trim().split(' ')).filter(([id, pid]) => {
                if (!id) return false;
                try { process.kill(Number(pid), 0); return false; } catch { return true; }
            }).map(([id]) => id);
            if (stale.length) await run(['rm', '-f', ...stale], { timeoutMs: 30000 });
        }
        fs.rmSync(path.join(root, '.work'), { recursive: true, force: true });
    }

    // TOOLS

    async function gate(ctx, tool, args) {
        if (!authorize) return;
        const refusal = await authorize(ctx, { tool, args });
        if (refusal) throw new MediaError(refusal);
    }

    async function ready() {
        const up = await dockerUp();
        if (!up.available) throw new MediaError(`Video editing needs Docker: ${up.reason}`);
        const state = await checkImage();
        if (state.state === 'ready') return;
        prepare();
        const minutes = setup.startedAt ? Math.round((Date.now() - setup.startedAt) / 60000) : 0;
        throw new MediaError(`Nothing was edited yet: ${setup.detail || 'the video tools are being set up.'}${minutes ? ` (started ${minutes} min ago)` : ''} `
            + 'This happens once and takes 5 to 20 minutes. Tell the user, and try again when they say so; their file stays in the media folder.');
    }

    function describe(result, dir) {
        const files = (result.files || []).map(rel => {
            let size = 0;
            try { size = fs.statSync(path.join(dir, rel)).size; } catch { /* listed anyway */ }
            return { name: rel, kind: kindOf(rel), size };
        });
        return files;
    }

    function resultText(result, files) {
        const lines = [];
        if (result.output) lines.push(`Made ${result.output}${result.info && result.info.duration ? ` (${formatInfo(result.info)})` : ''}.`);
        else if (files.length) lines.push(`Made ${files.map(f => f.name).join(', ')}.`);
        if (result.output && files.length > 1) lines.push(`Also saved: ${files.slice(1).map(f => f.name).join(', ')}.`);
        for (const note of result.notes || []) lines.push(note);
        lines.push('The user sees the new file under your reply with a player and a download button, so you don\'t need to link it.');
        return lines.join('\n');
    }

    async function toolFiles(_args, ctx) {
        const dir = folderFor(ctx);
        const files = listFiles(dir);
        if (!files.length) return { text: 'The media folder is empty. Ask the user to attach the video or audio with 📎 in the chat.' };
        return { text: files.map(f => `${f.name}  ${f.kind || 'file'}  ${formatBytes(f.size)}${f.made ? '  (made by CoDev)' : ''}`).join('\n') };
    }

    async function toolInfo({ file } = {}, ctx) {
        await ready();
        const dir = folderFor(ctx);
        const rel = path.relative(dir, fileIn(dir, file)).replace(/\\/g, '/');
        const reply = await runInfo(dir, rel);
        return { text: `${rel}: ${formatInfo(reply)}` };
    }

    function runInfo(dir, rel) {
        // info takes the file name itself, not a spec file.
        const job = queue.then(async () => {
            const args = ['run', '--rm', '--label', 'codev.media', '--label', `codev.media.pid=${process.pid}`, '--network', 'none', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges', '--read-only', '--mount', `type=bind,source=${dir},target=/media,readonly`];
            if (typeof process.getuid === 'function') args.push('--user', `${process.getuid()}:${process.getgid()}`);
            const result = parseResult(await run([...args, setup.image, 'info', rel], { timeoutMs: 120000 }));
            if (!result.ok) throw new MediaError(result.error);
            return result;
        });
        queue = job.catch(() => {});
        return job;
    }

    async function toolEdit({ input, steps, output_name: outputName } = {}, ctx) {
        if (!Array.isArray(steps) || !steps.length) throw new MediaError('media_edit needs steps, like [{"op": "clean_speech"}, {"op": "add_music", "file": "uploads/song.mp3", "volume": 0.15}].');
        await gate(ctx, 'media_edit', { input, steps });
        await ready();
        const dir = folderFor(ctx);
        const rel = path.relative(dir, fileIn(dir, input)).replace(/\\/g, '/');
        // Files a step names (music, logos, clips to join) may also leave the folder off.
        const fixed = steps.map(step => {
            if (!step || typeof step !== 'object') return step;
            const copy = { ...step };
            if (typeof copy.file === 'string') copy.file = path.relative(dir, fileIn(dir, copy.file)).replace(/\\/g, '/');
            for (const key of ['files', 'before']) if (Array.isArray(copy[key])) copy[key] = copy[key].map(f => path.relative(dir, fileIn(dir, f)).replace(/\\/g, '/'));
            return copy;
        });
        const stem = safeName(outputName || `${path.basename(rel, path.extname(rel))}-edited`).replace(/\.[a-z0-9]+$/i, '');
        const result = await runJob(dir, 'edit', { input: rel, steps: fixed, output: `outputs/${stem}` });
        if (!result.ok) throw new MediaError(`The edit didn't work: ${result.error}`);
        const files = describe(result, dir);
        return { text: resultText(result, files), files };
    }

    async function toolTranscribe({ file, language } = {}, ctx) {
        await gate(ctx, 'media_transcribe', { file });
        await ready();
        const dir = folderFor(ctx);
        const rel = path.relative(dir, fileIn(dir, file)).replace(/\\/g, '/');
        const result = await runJob(dir, 'transcribe', { input: rel, language: language || null });
        if (!result.ok) throw new MediaError(`Couldn't transcribe it: ${result.error}`);
        const files = describe(result, dir);
        const transcript = String(result.transcript || '');
        return { text: `Whisper's transcript of ${rel} (language: ${result.language}), saved as ${files.map(f => f.name).join(' and ')}:\n\n`
            + (transcript.length > 20000 ? transcript.slice(0, 20000) + '\n[cut here; the .txt file has the rest]' : transcript || '(no speech heard)'), files };
    }

    async function toolFind({ file, query, language } = {}, ctx) {
        await gate(ctx, 'media_find', { file });
        await ready();
        const dir = folderFor(ctx);
        const rel = path.relative(dir, fileIn(dir, file)).replace(/\\/g, '/');
        const result = await runJob(dir, 'find', { input: rel, query, language: language || null });
        if (!result.ok) throw new MediaError(`Couldn't search it: ${result.error}`);
        if (!result.matches.length) return { text: `"${query}" isn't said in ${rel} (Whisper heard ${result.segments} passages). Try other words, or media_transcribe to read everything.` };
        return { text: `Where "${query}" is said in ${rel} (seconds; pad a second either side when cutting):\n`
            + result.matches.map(m => `${m.start}s - ${m.end}s: ${m.text}`).join('\n') };
    }

    async function toolSeparate({ file, stems } = {}, ctx) {
        await gate(ctx, 'media_separate', { file });
        await ready();
        const dir = folderFor(ctx);
        const rel = path.relative(dir, fileIn(dir, file)).replace(/\\/g, '/');
        const result = await runJob(dir, 'separate', { input: rel, stems: stems === 'all' ? 'all' : 'vocals', output: `outputs/${path.basename(rel, path.extname(rel))}` });
        if (!result.ok) throw new MediaError(`Couldn't separate it: ${result.error}`);
        const files = describe(result, dir);
        return { text: `Demucs split ${rel} into: ${files.map(f => f.name).join(', ')}. The user can play and download each one under your reply.`, files };
    }

    // MUSIC AND CLIPS ALREADY ON THIS COMPUTER (only on the user's own PC, never on a server)

    function musicFolders() {
        const home = require('os').homedir();
        return ['Music', 'Videos', 'Movies', 'Downloads', 'Desktop', path.join('OneDrive', 'Music')].map(d => path.join(home, d)).filter(d => fs.existsSync(d));
    }

    async function toolLocalFind({ folder, query, kind } = {}) {
        const roots = folder ? [path.resolve(String(folder).replace(/^~(?=$|[\\/])/, require('os').homedir()))] : musicFolders();
        if (!roots.length) return { text: 'No Music, Videos or Downloads folder was found. Ask the user where their music is (a full folder path).' };
        const want = kind === 'video' ? ['video'] : kind === 'any' ? ['video', 'audio', 'image'] : ['audio'];
        const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
        const found = [];
        const walk = (dir, depth) => {
            if (found.length >= 400 || depth > 6) return;
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                if (e.name.startsWith('.') || /^(node_modules|AppData|\$Recycle\.Bin)$/i.test(e.name)) continue;
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full, depth + 1);
                else if (want.includes(kindOf(e.name)) && words.every(w => full.toLowerCase().includes(w))) {
                    let size = 0;
                    try { size = fs.statSync(full).size; } catch { continue; }
                    found.push({ full, size });
                }
            }
        };
        for (const r of roots) {
            if (!fs.existsSync(r) || !fs.statSync(r).isDirectory()) return { text: `There's no folder ${r} on this computer.` };
            walk(r, 0);
        }
        if (!found.length) return { text: `No ${want.join(' or ')} files${words.length ? ` matching "${query}"` : ''} in ${roots.join(', ')}. Ask the user which folder their music is in.` };
        return { text: `On the user's computer (${roots.join(', ')}):\n${found.slice(0, 100).map(f => `${f.full}  ${formatBytes(f.size)}`).join('\n')}`
            + (found.length > 100 ? `\n[${found.length - 100} more; narrow it with query]` : '') + '\nCopy one into the media folder with media_import before using it in media_edit.' };
    }

    async function toolImport({ path: source } = {}, ctx) {
        const full = path.resolve(String(source || '').replace(/^~(?=$|[\\/])/, require('os').homedir()));
        if (!['video', 'audio', 'image'].includes(kindOf(full))) throw new MediaError('Only videos, audio files and pictures can be copied into the media folder.');
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new MediaError(`There's no file ${full} on this computer.`);
        const saved = await saveUpload(ctx, path.basename(full), fs.createReadStream(full));
        return { text: `Copied ${full} into the media folder as ${saved.name}. Use that name in media_edit (the original stays where it was).` };
    }

    async function toolHighlights({ file, length, count, language } = {}, ctx) {
        await gate(ctx, 'media_highlights', { file });
        await ready();
        const dir = folderFor(ctx);
        const rel = path.relative(dir, fileIn(dir, file)).replace(/\\/g, '/');
        const result = await runJob(dir, 'highlights', { input: rel, length: length || 30, count: count || 5, language: language || null });
        if (!result.ok) throw new MediaError(`Couldn't find highlights: ${result.error}`);
        return { text: `Likely highlights in ${rel} (${Math.round(result.duration)}s long), ranked by how lively the sound is and what's said. Read them and pick; then keep or trim with media_edit:\n`
            + result.highlights.map(h => `${h.start}s - ${h.end}s (score ${h.score}): ${h.text}`).join('\n') };
    }

    async function toolSpeak({ text, voice, engine, speed, output_name: outputName } = {}, ctx) {
        await gate(ctx, 'media_speak', { text });
        await ready();
        const dir = folderFor(ctx);
        const stem = safeName(outputName || 'voiceover').replace(/\.[a-z0-9]+$/i, '');
        const result = await runJob(dir, 'speak', { text, voice, engine, speed, output: `outputs/${stem}` });
        if (!result.ok) throw new MediaError(`Couldn't make the voice: ${result.error}`);
        const files = describe(result, dir);
        return { text: `Made ${files.map(f => f.name).join(', ')} (${Math.round((result.info || {}).duration || 0)}s). Use it in media_edit (voiceover {file}) or give it to the user as is.`, files };
    }

    const fileProp = { type: 'string', description: 'A file in the media folder, like "uploads/clip.mp4" (from media_files or the attachment note).' };
    const TOOLS = [
        { name: 'media_files', run: toolFiles, annotations: { readOnlyHint: true },
          description: 'List the videos, audio and pictures in CoDev\'s media folder: what the user attached in the chat (uploads/) and what you made (outputs/). Use it when you need a file\'s exact name for the other media tools; for files elsewhere on the computer use media_find_on_computer instead.',
          inputSchema: { type: 'object', properties: {} } },
        { name: 'media_info', run: toolInfo, annotations: { readOnlyHint: true },
          description: 'Length, size, frame rate and sound of a video or audio file in the media folder (ffprobe). Use it before an edit that depends on the length or shape of the clip; don\'t call it for pictures.',
          inputSchema: { type: 'object', properties: { file: fileProp }, required: ['file'] } },
        { name: 'media_edit', run: toolEdit, annotations: { readOnlyHint: false, destructiveHint: false },
          description: 'Edit a video or audio file the user attached, with free tools on their computer (FFmpeg, Whisper, Demucs, DeepFilterNet). '
            + 'The original is never changed; the result is a new file the user can play and download. Turn the user\'s words into steps, run in order:\n'
            + '- trim {start, end}: keep only that part. keep {ranges: [{start, end}, ...]}: keep several parts, joined. cut {ranges}: remove parts.\n'
            + '- join {files: ["uploads/b.mp4"]}: add clips after this one (before: [...] puts some first).\n'
            + '- speed {factor}: 2 is twice as fast, 0.5 slow motion.\n'
            + '- reframe {aspect: "9:16" | "1:1" | "4:5" | "16:9", fit: "crop" | "blur" | "pad"}: vertical for TikTok, Reels and Shorts is 9:16; blur keeps the whole picture over a blurred background.\n'
            + '- clean_speech {strength?}: remove background noise (wind, hum, crowd, traffic) and keep the people talking (DeepFilterNet).\n'
            + '- keep_voice: keep only voices, removing music and other sounds; remove_voice: keep the music, remove voices (Demucs).\n'
            + '- add_music {file, volume: 0.15, duck: true, start?, fade_out?}: music under the clip, looped, dipping while people talk; "quietly underneath" is 0.1 to 0.15.\n'
            + '- voiceover {file, start?, volume?}: a voice recording on top, the clip\'s sound dipping under it. Or voiceover {text, voice?, engine?: "kokoro" | "piper", speed?, start?}: a free AI voice reads the text (voices below). replace_audio {file}. mute. volume {volume: "-6dB" or 1.5}. normalize: even loudness for social media.\n'
            + '- remove_silence {min_silence?: 0.6, padding?: 0.15}: cut the pauses. remove_fillers {words?: ["you know"]}: cut "um", "uh" and the like (Whisper).\n'
            + '- captions {position?: "bottom" | "center" | "top", words_per_line?: 4 (0 = whole sentences), style?: "highlight" (each word lights up as it\'s said), color?, size?, burn?: true, language?, translate?: true (English captions for any language)}: Whisper writes them and burns them in; an .srt file is saved too.\n'
            + '- text {text, position?, start?, end?, size?, color?, box?, animation?: "fade" | "slide_up" | "slide_left" | "pop" | "typewriter"}. logo {file, position?: "top-right", scale?: 0.15, opacity?}. fade {in?: 0.5, out?: 1}.\n'
            + '- speed_ramp {ranges: [{start, end, factor}]}: fast or slow parts, the rest normal. slow_motion {factor: 0.5, start?, end?}: smooth slow motion (motion-interpolated frames).\n'
            + '- join also takes transition: "fade" | "dissolve" | "fadeblack" | "wipeleft" | "slideleft" | "slideup" | "circleopen" | "zoomin" | "pixelize"... and duration (0.5).\n'
            + '- look {preset?: "warm" | "cool" | "vibrant" | "cinematic" | "vintage" | "sepia" | "bw" | "faded" | "bright" | "moody", brightness?, contrast?, saturation?, gamma?, vignette?, strength?: 0-1}.\n'
            + '- montage {files: [clips and pictures], music, beats_per_cut?: 2, aspect?, duration?}: cuts the input and the files to the beat of the music (pictures get a slow zoom).\n'
            + '- remove_background {replace?: "green" | "blur" | "color" | "image" | "transparent" (pictures only), color?, file?}: takes the person off the background (RobustVideoMatting; rembg for pictures). Up to 5 minutes of video.\n'
            + '- upscale {scale: 2 | 3 | 4}: sharper and bigger with Real-ESRGAN. Fast for pictures; video is slow on a CPU (about a second per frame), so keep clips short.\n'
            + '- resize {width?, height?}. rotate {angle: 90 | -90 | 180, or direction: "flip"}. compress {quality: "high" | "medium" | "small", max_height?}. convert {format: mp4 | webm | mov | mp3 | wav}.\n'
            + '- Last step only: gif {start?, duration?, width?, fps?}, extract_audio {format?: "mp3"}, thumbnail {time}.\n'
            + 'Times are seconds or "m:ss". Example, "remove the background noise, keep the people talking and add music quietly underneath": '
            + '[{"op": "clean_speech"}, {"op": "add_music", "file": "uploads/song.mp3", "volume": 0.12}]. '
            + 'Music, logos and voiceovers must be files in the media folder: attached by the user, or found on their computer with media_find_on_computer and copied in with media_import. If none fits, ask the user rather than inventing one. '
            + 'Voices: Kokoro af_sarah (default), af_bella, af_nicole, af_sky, am_adam, am_michael, bf_emma, bf_isabella, bm_george, bm_lewis (a American, b British, f female, m male); Piper lessac, amy, ryan, alan (quicker). '
            + 'Long clips take minutes (Whisper and Demucs run about as long as the clip). Use it whenever the user asks to change a video or audio file; to only read what is said use media_transcribe instead.',
          inputSchema: { type: 'object', properties: {
              input: fileProp,
              steps: { type: 'array', description: 'The edit, in order. Each step is an object with "op" and its options.', items: { type: 'object', properties: { op: { type: 'string', description: 'The step, like "trim" or "add_music" (listed above).' } }, required: ['op'] } },
              output_name: { type: 'string', description: 'Optional: a short name for the new file, without extension (like "beach-reel").' }
          }, required: ['input', 'steps'] } },
        { name: 'media_transcribe', run: toolTranscribe, annotations: { readOnlyHint: false, destructiveHint: false },
          description: 'Write down everything said in a video or audio file, with times, using Whisper on the user\'s computer. Saves a .txt and an .srt (subtitle) file. Use it for transcripts, subtitles files, and to read a clip before choosing what to cut. Don\'t use it to find one phrase: media_find does that faster.',
          inputSchema: { type: 'object', properties: { file: fileProp, language: { type: 'string', description: 'Optional: a language code like "en" or "es"; detected when left out.' } }, required: ['file'] } },
        { name: 'media_find', run: toolFind, annotations: { readOnlyHint: true },
          description: 'Find when something is said in a video or audio file (Whisper): returns the start and end seconds of each passage, ready for media_edit\'s trim, keep or cut. Use it when the user names something said that they want kept or cut; for the whole text use media_transcribe instead.',
          inputSchema: { type: 'object', properties: { file: fileProp, query: { type: 'string', description: 'Words or a phrase, like "welcome to the channel".' }, language: { type: 'string', description: 'Optional: a language code like "en"; detected when left out.' } }, required: ['file', 'query'] } },
        { name: 'media_separate', run: toolSeparate, annotations: { readOnlyHint: false, destructiveHint: false },
          description: 'Split a song or a clip\'s sound into separate audio files with Demucs: stems "vocals" gives the voice and everything else (music and sounds); stems "all" gives voice, drums, bass and other. Use it for a karaoke track, an a cappella, or to reuse the music as a file; to only remove noise or voices inside an edit use media_edit instead.',
          inputSchema: { type: 'object', properties: { file: fileProp, stems: { type: 'string', enum: ['vocals', 'all'], description: 'vocals (voice and the rest) or all (four stems). Default vocals.' } }, required: ['file'] } },
        { name: 'media_highlights', run: toolHighlights, annotations: { readOnlyHint: true },
          description: 'Find the best moments of a long video (a stream, a podcast, a game) for clips: Whisper\'s transcript plus how loud and lively each part is, ranked. Returns start and end seconds with what\'s said, for media_edit\'s keep or trim.',
          inputSchema: { type: 'object', properties: { file: fileProp, length: { type: 'number', description: 'About how long each highlight should be, in seconds (default 30).' },
              count: { type: 'integer', description: 'How many to find (default 5).' }, language: { type: 'string' } }, required: ['file'] } },
        { name: 'media_speak', run: toolSpeak, annotations: { readOnlyHint: false, destructiveHint: false },
          description: 'Read text aloud with a free AI voice on the user\'s computer (Kokoro, natural; or Piper, quicker) and save it as an MP3: for voiceovers, narration, intros. Voices: Kokoro af_sarah (default), af_bella, af_nicole, af_sky, am_adam, am_michael, bf_emma, bf_isabella, bm_george, bm_lewis; Piper lessac, amy, ryan, alan. English only.',
          inputSchema: { type: 'object', properties: { text: { type: 'string' }, voice: { type: 'string' }, engine: { type: 'string', enum: ['kokoro', 'piper'] },
              speed: { type: 'number', description: '0.5 to 2 (default 1).' }, output_name: { type: 'string' } }, required: ['text'] } }
    ];

    // On a server there is no "user's computer" to search, so these two are left out.
    const LOCAL_TOOLS = [
        { name: 'media_find_on_computer', run: toolLocalFind, annotations: { readOnlyHint: true },
          description: 'Find music (or videos) already on the user\'s computer, by name: searches their Music, Videos, Downloads and Desktop folders, or a folder they name. '
            + 'Use it when the user asks for "my music", a song by name, or background music without attaching one; then copy the pick in with media_import. Use only music the user owns or chose; don\'t use it for files already in the media folder (media_files lists those).',
          inputSchema: { type: 'object', properties: {
              query: { type: 'string', description: 'Optional: words from the file or folder name, like "lofi" or an artist.' },
              folder: { type: 'string', description: 'Optional: a full folder path the user gave.' },
              kind: { type: 'string', enum: ['audio', 'video', 'any'], description: 'Default audio.' } } } },
        { name: 'media_import', run: toolImport, annotations: { readOnlyHint: false, destructiveHint: false },
          description: 'Copy a video, song or picture from anywhere on the user\'s computer (a full path from media_find_on_computer or the user) into the media folder, so media_edit can use it. The original isn\'t touched. Use it after media_find_on_computer picks a file; not needed for what the user attached in the chat, which is already there.',
          inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'The file\'s full path.' } }, required: ['path'] } }
    ];
    const allTools = () => (resolveUser ? TOOLS : TOOLS.concat(LOCAL_TOOLS));

    async function listTools() {
        const up = await dockerUp();
        if (!up.available) return [];
        return allTools().map(({ run: _run, ...tool }) => tool);
    }

    // MCP CallToolResult. _meta["codev/mediaFiles"] lists new files for the page to show.
    async function callTool(name, args, ctx = {}) {
        const tool = allTools().find(t => t.name === name);
        if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
        try {
            const { text, files } = await tool.run(args || {}, ctx);
            return { content: [{ type: 'text', text }], isError: false, ...(files && files.length ? { _meta: { 'codev/mediaFiles': files } } : {}) };
        } catch (err) {
            const known = err instanceof MediaError;
            return { content: [{ type: 'text', text: known ? err.message : `${err.name}: ${err.message}` }], isError: true };
        }
    }

    // THE PAGE'S SIDE (never offered to agents)

    async function status(ctx) {
        const up = await dockerUp();
        if (up.available) await checkImage();
        return {
            available: up.available,
            docker: up.available ? { available: true, version: up.version } : { available: false, error: up.reason },
            setup: { state: up.available ? setup.state : 'no-docker', detail: up.available ? setup.detail : up.reason, image: setup.image || wantedImage },
            folder: (() => { try { return folderFor(ctx); } catch { return null; } })(),
            busy: false
        };
    }

    // Saves an upload under uploads/, renamed when the name is taken. Returns { name, size }.
    async function saveUpload(ctx, name, source) {
        const kind = kindOf(name);
        if (!['video', 'audio', 'image'].includes(kind)) throw new MediaError(`${name}: only videos, audio and pictures can go in the media folder.`);
        const dir = folderFor(ctx);
        const clean = safeName(name);
        let target = path.join(dir, 'uploads', clean);
        for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, 'uploads', `${path.basename(clean, path.extname(clean))}-${i}${path.extname(clean)}`);
        const temp = path.join(dir, '.jobs', `upload-${crypto.randomBytes(4).toString('hex')}`);
        try {
            if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
                if (source.length > MAX_UPLOAD_BYTES) throw new MediaError(`${name} is over the ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB limit.`);
                fs.writeFileSync(temp, source);
            } else {
                await new Promise((resolve, reject) => {
                    let size = 0;
                    const out = fs.createWriteStream(temp);
                    source.on('data', chunk => {
                        size += chunk.length;
                        if (size > MAX_UPLOAD_BYTES) { source.destroy(); out.destroy(); reject(new MediaError(`${name} is over the ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB limit.`)); }
                    });
                    source.on('error', reject);
                    out.on('error', reject);
                    out.on('finish', resolve);
                    source.pipe(out);
                });
            }
            fs.renameSync(temp, target);
        } finally {
            fs.rmSync(temp, { force: true });
        }
        const rel = `uploads/${path.basename(target)}`;
        log(`Saved ${rel} (${formatBytes(fs.statSync(target).size)}).`);
        return { name: rel, kind, size: fs.statSync(target).size };
    }

    function openFile(ctx, rel) {
        const dir = folderFor(ctx);
        const full = fileIn(dir, rel);
        return { full, size: fs.statSync(full).size, type: TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream', name: path.basename(full) };
    }

    function deleteFile(ctx, rel) {
        const dir = folderFor(ctx);
        fs.rmSync(fileIn(dir, rel));
        return { ok: true };
    }

    // JSON routes under /agent/media/ (server.js and the Windows app's IPC).
    async function handleRequest(method, pathname, query = {}, body = {}, ctx = {}) {
        const parts = String(pathname || '').split('/').filter(Boolean);
        if (parts[0] !== 'agent' || parts[1] !== 'media') return null;
        const m = String(method || 'GET').toUpperCase();
        try {
            if (parts[2] === 'status' && m === 'GET') return { status: 200, body: await status(ctx) };
            if (parts[2] === 'prepare' && m === 'POST') { prepare(); return { status: 202, body: await status(ctx) }; }
            if (parts[2] === 'files' && m === 'GET') return { status: 200, body: listFiles(folderFor(ctx)) };
            if (parts[2] === 'files' && m === 'DELETE') return { status: 200, body: deleteFile(ctx, query.name) };
            return null;
        } catch (err) {
            return { status: err instanceof MediaError ? 400 : 500, body: { error: err.message } };
        }
    }

    function close() { /* jobs are `docker run --rm`: nothing stays running between them */ }

    cleanup().catch(() => {});
    return { listTools, callTool, handleRequest, status, prepare, saveUpload, openFile, deleteFile, listFiles: ctx => listFiles(folderFor(ctx)), close, root, TOOLS, LOCAL_TOOLS };
}

function parseResult(reply) {
    const line = String(reply.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    try { return JSON.parse(line); } catch {
        if (reply.code === 137) return { ok: false, error: 'it ran out of memory. Try a shorter clip, or give Docker Desktop more memory (Settings > Resources).' };
        return { ok: false, error: lastLine(reply.stderr) || `the video tools stopped (exit code ${reply.code})` };
    }
}

function lastLine(text) {
    return String(text || '').trim().split('\n').filter(Boolean).pop() || 'no details';
}

function formatBytes(n) {
    return n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

function formatInfo(info) {
    const parts = [];
    if (info.duration) parts.push(`${Math.floor(info.duration / 60)}:${String(Math.round(info.duration % 60)).padStart(2, '0')} long`);
    if (info.has_video) parts.push(`${info.width}x${info.height}${info.fps ? ` at ${info.fps} fps` : ''}`);
    parts.push(info.has_audio ? `sound${info.channels ? ` (${info.channels === 1 ? 'mono' : 'stereo'})` : ''}` : 'no sound');
    if (info.size_bytes) parts.push(formatBytes(info.size_bytes));
    return parts.join(', ');
}

// The service shape agent-services.js loads for server.js.
function createService(config = {}, { log } = {}) {
    const media = createMedia({ dataDir: (config.workspace || {}).dataDir || path.join(__dirname, '..', '..', '.codev'), log: log || console.log });
    // GET /agent/media/download?name=uploads/clip.mp4: the file itself, with Range
    // support so the page's video player can seek.
    const download = async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        let file;
        try { file = media.openFile({}, url.searchParams.get('name')); } catch (err) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
        }
        sendFile(req, res, file, url.searchParams.get('download') === '1');
    };
    // POST /agent/media/upload?name=clip.mp4 with the file as the body.
    const upload = async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        try {
            const saved = await media.saveUpload({}, url.searchParams.get('name'), req);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(saved));
        } catch (err) {
            res.writeHead(err instanceof MediaError ? 400 : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
    };
    return {
        name: 'media',
        listTools: media.listTools,
        callTool: media.callTool,
        handleRequest: (method, pathname, query, body) => media.handleRequest(method, pathname, query, body, {}),
        routes: { 'GET /agent/media/download': download },
        // Streamed bodies: server.js hands these the request before reading it.
        rawRoutes: { 'POST /agent/media/upload': upload },
        status: async () => {
            const s = await media.status({});
            const detail = !s.available ? s.docker.error
                : s.setup.state === 'ready' ? `FFmpeg, Whisper, Demucs and DeepFilterNet are ready (${s.setup.image}).`
                : s.setup.detail || 'The video tools download the first time they are used.';
            return { available: s.available, detail, ...s };
        },
        close: media.close,
        media
    };
}

function sendFile(req, res, file, asDownload) {
    const headers = { 'Content-Type': file.type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (asDownload) headers['Content-Disposition'] = `attachment; filename="${file.name.replace(/"/g, '')}"`;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range && file.size) {
        let start = range[1] === '' ? Math.max(0, file.size - Number(range[2])) : Number(range[1]);
        let end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), file.size - 1) : file.size - 1;
        if (start > end || start >= file.size) {
            res.writeHead(416, { 'Content-Range': `bytes */${file.size}` });
            return res.end();
        }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${file.size}`, 'Content-Length': end - start + 1 });
        return fs.createReadStream(file.full, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': file.size });
    fs.createReadStream(file.full).pipe(res);
}

module.exports = { createMedia, createService, sendFile, safeName, kindOf, MediaError, DEFAULT_IMAGE, LOCAL_IMAGE, IMAGE_DIR };
