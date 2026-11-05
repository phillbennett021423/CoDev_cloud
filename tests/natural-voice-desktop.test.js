// The Windows app's natural voices: Kokoro made natively in a utility process (desktop/kokoro-voice.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createKokoroVoice, createKokoroHost, serveKokoro, wav16, MODEL_ID } = require('../desktop/kokoro-voice.js');

// A stand-in for kokoro-js: records what it was asked, and makes a short tone per piece.
function fakeModules(log, { failLoad } = {}) {
    const transformers = { env: {} };
    const kokoro = {
        KokoroTTS: {
            async from_pretrained(id, opts) {
                log.push({ load: id, dtype: opts.dtype, device: opts.device, cacheDir: transformers.env.cacheDir });
                if (failLoad) throw new Error(failLoad);
                opts.progress_callback({ status: 'progress', loaded: 5, total: 10, file: 'onnx/model.onnx' });
                return {
                    async generate(text, { voice }) {
                        log.push({ text, voice });
                        await new Promise(r => setTimeout(r, 10));
                        return { audio: new Float32Array([0, 0.5, -0.5, 1, -1]), sampling_rate: 24000 };
                    }
                };
            }
        }
    };
    return () => ({ kokoro, transformers });
}

// Two in-memory ends standing in for Electron's utilityProcess and its parentPort.
function memoryFork(serveOpts) {
    const hostListeners = { message: [], exit: [] };
    const childListeners = [];
    const port = {
        on: (type, fn) => { if (type === 'message') childListeners.push(fn); },
        postMessage: msg => setImmediate(() => hostListeners.message.forEach(fn => fn(msg)))
    };
    serveKokoro(port, serveOpts);
    const proc = {
        on: (type, fn) => hostListeners[type].push(fn),
        postMessage: msg => setImmediate(() => childListeners.forEach(fn => fn({ data: msg }))),
        kill: () => hostListeners.exit.forEach(fn => fn(1))
    };
    return proc;
}

test('wav16 makes a 16-bit mono WAV the page can play', () => {
    const wav = wav16(new Float32Array([0, 1, -1, 2]), 24000);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(24), 24000);
    assert.equal(wav.length, 44 + 8);
    assert.equal(wav.readInt16LE(46), 32767);
    assert.equal(wav.readInt16LE(48), -32768);
    assert.equal(wav.readInt16LE(50), 32767, 'loud samples are clipped, not wrapped');
});

test('the engine loads the full model on the CPU into its own folder, in order, and cancel skips what is waiting', async () => {
    const log = [];
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-cache-'));
    const progress = [];
    const voice = createKokoroVoice({ cacheDir, loadModules: fakeModules(log), onProgress: p => progress.push(p) });
    assert.equal(voice.downloaded(), false);
    const a = voice.speak('First.', 'af_kore');
    const b = voice.speak('Second.', 'bad voice!');
    const wav = await a;
    voice.cancel();
    await assert.rejects(b, err => err.stopped === true);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.deepEqual(log[0], { load: MODEL_ID, dtype: 'fp32', device: 'cpu', cacheDir });
    assert.deepEqual(log.slice(1), [{ text: 'First.', voice: 'af_kore' }], 'the cancelled piece is never made');
    assert.deepEqual(progress, [{ loaded: 5, total: 10, file: 'onnx/model.onnx' }]);
    // After a cancel, new pieces are made again.
    await voice.speak('Third.', 'am_michael');
    assert.deepEqual(log.at(-1), { text: 'Third.', voice: 'am_michael' });
    fs.mkdirSync(path.join(cacheDir, MODEL_ID, 'onnx'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, MODEL_ID, 'onnx/model.onnx'), 'x');
    assert.equal(voice.downloaded(), true);
});

test('the host talks to the voice process: audio, progress, stops, and a load failure the page can fall back from', async () => {
    const log = [];
    const progress = [];
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-host-'));
    let forks = 0;
    const host = createKokoroHost({ cacheDir, onProgress: p => progress.push(p), fork: () => { forks++; return memoryFork({ loadModules: fakeModules(log) }); } });
    assert.deepEqual(await host.request({ op: 'downloaded' }), { ok: true, downloaded: false });
    assert.equal(forks, 0, 'checking the download starts nothing');
    assert.deepEqual(await host.request({ op: 'cancel' }), { ok: true });
    assert.equal(forks, 0);
    const first = host.request({ op: 'speak', text: 'Hello there.', voice: 'af_kore' });
    const second = host.request({ op: 'speak', text: 'Never made.', voice: 'af_kore' });
    const cancelled = host.request({ op: 'cancel' });
    const one = await first;
    assert.equal(one.ok, true, 'the piece already being made finishes');
    assert.equal(Buffer.from(one.wav).toString('ascii', 0, 4), 'RIFF');
    assert.deepEqual(await cancelled, { ok: true });
    const two = await second;
    assert.equal(two.ok, false);
    assert.equal(two.stopped, true);
    assert.equal(log[0].cacheDir, cacheDir);
    assert.deepEqual(progress, [{ loaded: 5, total: 10, file: 'onnx/model.onnx' }]);
    assert.equal(forks, 1);
    // A process that dies fails what it was doing, and the next request starts a new one.
    const waiting = host.request({ op: 'speak', text: 'Cut off.', voice: 'af_kore' });
    host.stop();
    const cut = await waiting;
    assert.equal(cut.ok, false);
    assert.equal(cut.unavailable, true);
    assert.equal((await host.request({ op: 'speak', text: 'Back again.', voice: 'af_kore' })).ok, true);
    assert.equal(forks, 2);

    // Kokoro's native runtime missing on this computer: marked so the page uses its own worker.
    const broken = createKokoroHost({ cacheDir, fork: () => memoryFork({ loadModules: fakeModules([], { failLoad: "Cannot find module 'onnxruntime-node'" }) }) });
    const failed = await broken.request({ op: 'speak', text: 'Hi.', voice: 'af_kore' });
    assert.equal(failed.ok, false);
    assert.equal(failed.unavailable, true);
    assert.match(failed.message, /onnxruntime-node/);
});

test('the Windows app ships the voice process and the native runtime for Windows only', () => {
    const pkg = require('../desktop/package.json');
    assert.ok(pkg.dependencies['kokoro-js']);
    assert.ok(pkg.build.files.includes('kokoro-voice.js'));
    assert.ok(pkg.build.files.includes('kokoro-voice-process.js'));
    assert.ok(pkg.build.asarUnpack.includes('node_modules/onnxruntime-node/**'));
    assert.ok(pkg.build.files.includes('!node_modules/onnxruntime-node/bin/napi-v3/linux/**'));
    const main = fs.readFileSync(path.join(__dirname, '../desktop/main.js'), 'utf8');
    assert.match(main, /utilityProcess\.fork\(path\.join\(__dirname, 'kokoro-voice-process\.js'\)/);
    assert.doesNotMatch(main, /require\('kokoro-js'\)/, 'Kokoro never loads in the main process');
    const preload = fs.readFileSync(path.join(__dirname, '../desktop/preload.js'), 'utf8');
    assert.match(preload, /naturalVoice: req => ipcRenderer\.invoke\('codev:natural-voice', req\)/);
});
