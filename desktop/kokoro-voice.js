// The natural read-aloud voices (Kokoro) for the Windows app, run natively on every CPU core
// with onnxruntime-node. In the page's WebAssembly worker Kokoro takes about three times longer
// than the speech it makes, so an answer stalls after its first sentence; here it's several
// times faster than real time, so a whole answer reads in one go.
//
// It runs in a utility process of its own (see createKokoroHost below).
//
//   createKokoroVoice({ cacheDir, onProgress, loadModules })
//       { speak(text, voice) -> Promise<Buffer (16-bit WAV)>, cancel(), warm(voice), downloaded() }
//
// The full-precision model (about 310 MB) downloads from Hugging Face the first time, with
// onProgress({ loaded, total, file }), into cacheDir; after that it loads from disk.
'use strict';

const fs = require('fs');
const path = require('path');

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DTYPE = 'fp32';
const MODEL_FILE = 'onnx/model.onnx';
const VOICE_ID = /^[a-z]{2}_[a-z]+$/;

// 16-bit PCM WAV, the same as the page's worker makes.
function wav16(samples, rate) {
    const buffer = Buffer.alloc(44 + samples.length * 2);
    buffer.write('RIFF', 0, 'ascii'); buffer.writeUInt32LE(36 + samples.length * 2, 4); buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii'); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36, 'ascii'); buffer.writeUInt32LE(samples.length * 2, 40);
    for (let i = 0, at = 44; i < samples.length; i++, at += 2) {
        const x = Math.max(-1, Math.min(1, samples[i]));
        buffer.writeInt16LE(Math.round(x < 0 ? x * 0x8000 : x * 0x7fff), at);
    }
    return buffer;
}

function stoppedError() {
    const err = new Error('stopped');
    err.stopped = true;
    return err;
}

function createKokoroVoice({ cacheDir, onProgress, loadModules } = {}) {
    const load = loadModules || (() => ({ kokoro: require('kokoro-js'), transformers: require('@huggingface/transformers') }));
    let ttsPromise = null;
    let queue = Promise.resolve();
    let epoch = 0;

    function getTts() {
        if (!ttsPromise) {
            ttsPromise = (async () => {
                const { kokoro, transformers } = load();
                if (cacheDir) {
                    fs.mkdirSync(cacheDir, { recursive: true });
                    transformers.env.cacheDir = cacheDir;
                }
                return kokoro.KokoroTTS.from_pretrained(MODEL_ID, {
                    dtype: DTYPE,
                    device: 'cpu',
                    progress_callback: p => {
                        if (p && p.status === 'progress' && onProgress) onProgress({ loaded: p.loaded || 0, total: p.total || 0, file: p.file || '' });
                    }
                });
            })().catch(err => { ttsPromise = null; throw err; });
        }
        return ttsPromise;
    }

    // One piece at a time, in order; cancel() skips the ones not started yet.
    function run(job) {
        const mine = epoch;
        const result = queue.then(() => {
            if (mine !== epoch) throw stoppedError();
            return job();
        });
        queue = result.catch(() => {});
        return result;
    }

    return {
        speak(text, voice) {
            const v = VOICE_ID.test(String(voice || '')) ? voice : 'af_kore';
            return run(async () => {
                const tts = await getTts();
                const audio = await tts.generate(String(text || ''), { voice: v });
                return wav16(audio.audio, audio.sampling_rate);
            });
        },
        cancel() { epoch++; },
        warm(voice) {
            const v = VOICE_ID.test(String(voice || '')) ? voice : 'af_kore';
            return run(async () => { const tts = await getTts(); await tts.generate('Hi.', { voice: v }); }).catch(() => {});
        },
        downloaded() {
            return !!cacheDir && fs.existsSync(path.join(cacheDir, MODEL_ID, MODEL_FILE));
        }
    };
}


// Kokoro's phonemizer installs process-wide handlers that turn any unhandled promise rejection
// into a crash, so it never loads in the main process: it runs in its own utility process
// (kokoro-voice-process.js), and this host talks to it.
//
//   createKokoroHost({ fork, cacheDir, onProgress })
//       { request({ op, text, voice }) -> Promise<{ ok, wav?, downloaded?, message?, stopped?, unavailable? }> }
//
// fork() returns { postMessage(msg), on('message', fn), on('exit', fn), kill() }, the shape of
// Electron's utilityProcess. A process that dies fails its requests and is started again next time.
function createKokoroHost({ fork, cacheDir, onProgress }) {
    let child = null;
    let seq = 0;
    const pending = new Map();

    function start() {
        if (child) return child;
        const proc = fork();
        child = proc;
        proc.on('message', msg => {
            if (!msg) return;
            if (msg.type === 'progress') { if (onProgress) onProgress(msg.progress); return; }
            const done = pending.get(msg.id);
            if (!done) return;
            pending.delete(msg.id);
            done(msg.result);
        });
        proc.on('exit', code => {
            if (child === proc) child = null;
            for (const done of pending.values()) done({ ok: false, message: `the voice process stopped (code ${code})`, unavailable: true });
            pending.clear();
        });
        proc.postMessage({ type: 'init', cacheDir });
        return proc;
    }

    return {
        request(req) {
            const op = req && req.op;
            if (op === 'downloaded') return Promise.resolve({ ok: true, downloaded: !!cacheDir && fs.existsSync(path.join(cacheDir, MODEL_ID, MODEL_FILE)) });
            if (op === 'cancel' && !child) return Promise.resolve({ ok: true });
            return new Promise(resolve => {
                const id = ++seq;
                pending.set(id, resolve);
                try { start().postMessage({ type: 'request', id, req: { op, text: String((req && req.text) || ''), voice: req && req.voice } }); }
                catch (err) { pending.delete(id); resolve({ ok: false, message: String(err.message || err), unavailable: true }); }
            });
        },
        stop() { if (child) { try { child.kill(); } catch (e) { /* gone */ } } }
    };
}

// The utility process's side: answers the host's requests with a createKokoroVoice engine.
function serveKokoro(port, { loadModules } = {}) {
    let voice = null;
    port.on('message', async event => {
        const msg = (event && event.data) || event || {};
        if (msg.type === 'init') {
            // The download reports thousands of times; a few a second are plenty for the page.
            let sentAt = 0;
            voice = createKokoroVoice({
                cacheDir: msg.cacheDir,
                loadModules,
                onProgress: progress => {
                    const now = Date.now();
                    if (now - sentAt < 250 && progress.loaded < progress.total) return;
                    sentAt = now;
                    port.postMessage({ type: 'progress', progress });
                }
            });
            return;
        }
        if (msg.type !== 'request') return;
        const { op, text, voice: v } = msg.req || {};
        let result;
        try {
            if (!voice) throw new Error('the voice process was not set up');
            if (op === 'speak') result = { ok: true, wav: await voice.speak(text, v) };
            else if (op === 'cancel') { voice.cancel(); result = { ok: true }; }
            else if (op === 'warm') { voice.warm(v); result = { ok: true }; }
            else result = { ok: false, message: 'unknown request' };
        } catch (err) {
            const message = String((err && err.message) || err);
            result = { ok: false, message, stopped: !!(err && err.stopped), unavailable: /Cannot find module|onnxruntime|\.node\b|dlopen|DLL/i.test(message) };
        }
        port.postMessage({ type: 'reply', id: msg.id, result });
    });
}

module.exports = { createKokoroVoice, createKokoroHost, serveKokoro, wav16, MODEL_ID, DTYPE };
