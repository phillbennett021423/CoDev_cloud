// Runs Kokoro (vendor/kokoro) off the page's main thread, so the chat stays smooth while a
// natural voice is being made. Loaded by natural-voice.js as a module worker.
//
//   in:  { type: "speak", id, text, voice }   out: { type: "audio", id, wav (ArrayBuffer) }
//                                                   { type: "error", id, message }
//   in:  { type: "warm", voice }              load the model and make one short word, so the
//                                             first real piece starts quickly
//   out while the model loads the first time: { type: "progress", loaded, total, file }
//   out once the model is loaded:             { type: "ready" }
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const CDN = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";

let ttsPromise = null;

async function loadKokoro() {
    try {
        return await import("../vendor/kokoro/kokoro.web.js");
    } catch (err) {
        // Pages opened straight from disk can't import local modules.
        return import(CDN);
    }
}

function loadTts() {
    if (!ttsPromise) {
        ttsPromise = loadKokoro().then(({ KokoroTTS }) => KokoroTTS.from_pretrained(MODEL_ID, {
            dtype: "q8",
            device: "wasm",
            progress_callback: p => {
                if (p && p.status === "progress") self.postMessage({ type: "progress", loaded: p.loaded || 0, total: p.total || 0, file: p.file || "" });
            }
        })).then(tts => { self.postMessage({ type: "ready" }); return tts; }, err => { ttsPromise = null; throw err; });
    }
    return ttsPromise;
}

// 16-bit PCM WAV: every browser plays it (iPhones don't all play Kokoro's own 32-bit float WAV).
function wav16(samples, rate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buffer);
    const ascii = (at, text) => { for (let i = 0; i < text.length; i++) v.setUint8(at + i, text.charCodeAt(i)); };
    ascii(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); ascii(8, "WAVE");
    ascii(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ascii(36, "data"); v.setUint32(40, samples.length * 2, true);
    for (let i = 0, at = 44; i < samples.length; i++, at += 2) {
        const x = Math.max(-1, Math.min(1, samples[i]));
        v.setInt16(at, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return buffer;
}

// One request at a time: the model isn't safe to run twice at once.
let queue = Promise.resolve();

self.onmessage = event => {
    const { type, id, text, voice } = event.data || {};
    if (type === "warm") {
        queue = queue.then(() => loadTts().then(tts => tts.generate("Hi.", { voice: voice || "af_kore" })).catch(() => {}));
        return;
    }
    if (type !== "speak") return;
    queue = queue.then(async () => {
        try {
            const tts = await loadTts();
            const audio = await tts.generate(String(text || ""), { voice: voice || "af_kore" });
            const wav = wav16(audio.audio, audio.sampling_rate);
            self.postMessage({ type: "audio", id, wav }, [wav]);
        } catch (err) {
            self.postMessage({ type: "error", id, message: String((err && err.message) || err) });
        }
    });
};
