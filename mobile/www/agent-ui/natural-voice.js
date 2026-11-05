// Natural read-aloud voices made on the device itself: Kokoro (vendor/kokoro), no key and
// no account. Kore is Kokoro's af_kore, the same voice the Windows media tools use.
//
//   CodevNaturalVoice.VOICES                      the voices offered, Kore first
//   CodevNaturalVoice.isVoice(id)                 one of them?
//   CodevNaturalVoice.supported()                 can this browser run it (WebAssembly + module workers)
//   CodevNaturalVoice.create({ workerUrl, onProgress, makeWorker, stallMs, native, onFallback })
//       { speak(text, voice) -> Promise<Blob (audio/wav)>, cancel(), warm(voice), loaded(),
//         downloaded() -> Promise<boolean> }
//
// native is the Windows app's engine (window.codevDesktop.naturalVoice and its progress events):
// Kokoro on every CPU core, several times faster than the WebAssembly worker, which only phones
// and the web page use. If it can't run on that computer, the worker takes over (onFallback).
//   CodevNaturalVoice.downloaded(caches)          Promise<boolean>: is the worker's model saved here
//
// The model (about 90 MB) downloads the first time a natural voice is used, with progress
// reported through onProgress, and stays in the browser's cache after that.
//
// Making speech on a phone's processor can take longer than the speech itself, so the page asks
// for every piece at once (the worker makes them in order while earlier ones play), and cancel()
// drops them all when the user stops. A worker that goes quiet for stallMs (the
// phone ran out of memory, say) while loading is restarted and its pieces fail, so the page never
// waits forever. Once loaded it's never cut off: a slow phone just takes its time.
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevNaturalVoice = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const VOICES = [
        { id: "af_kore", name: "Kore", note: "American, warm and clear" },
        { id: "af_heart", name: "Heart", note: "American, bright" },
        { id: "af_bella", name: "Bella", note: "American, expressive" },
        { id: "af_nicole", name: "Nicole", note: "American, soft" },
        { id: "af_sarah", name: "Sarah", note: "American" },
        { id: "am_michael", name: "Michael", note: "American, male" },
        { id: "am_fenrir", name: "Fenrir", note: "American, male, deep" },
        { id: "am_puck", name: "Puck", note: "American, male, upbeat" },
        { id: "bf_emma", name: "Emma", note: "British" },
        { id: "bm_george", name: "George", note: "British, male" }
    ];
    const isVoice = id => VOICES.some(v => v.id === id);

    function supported(g = typeof self !== "undefined" ? self : {}) {
        return typeof g.WebAssembly === "object" && typeof g.Worker === "function";
    }

    const MODEL_URL = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx";

    async function downloaded(cacheStorage = typeof caches !== "undefined" ? caches : null) {
        try {
            if (!cacheStorage) return false;
            const cache = await cacheStorage.open("transformers-cache");
            return !!(await cache.match(MODEL_URL));
        } catch (err) { return false; }
    }

    function create(opts = {}) {
        return opts.native && typeof opts.native.request === "function" ? createNative(opts) : createWorker(opts);
    }

    function stoppedError() {
        const err = new Error("stopped");
        err.stopped = true;
        return err;
    }

    function createNative(opts) {
        const native = opts.native;
        let ready = false;
        let fallback = null;
        if (typeof native.onProgress === "function" && opts.onProgress) native.onProgress(p => opts.onProgress(p || {}));
        const ask = req => Promise.resolve().then(() => native.request(req)).catch(err => ({ ok: false, message: String((err && err.message) || err), unavailable: true }));
        const useWorker = message => {
            if (!fallback) { fallback = createWorker(opts); if (opts.onFallback) opts.onFallback(message); }
            return fallback;
        };
        return {
            async speak(text, voice = "af_kore") {
                if (fallback) return fallback.speak(text, voice);
                const r = (await ask({ op: "speak", text: String(text || ""), voice: isVoice(voice) ? voice : "af_kore" })) || {};
                if (r.ok && r.wav) { ready = true; return new Blob([r.wav], { type: "audio/wav" }); }
                if (r.stopped) throw stoppedError();
                if (r.unavailable && !ready) return useWorker(r.message).speak(text, voice);
                throw new Error(r.message || "the natural voice failed");
            },
            cancel() { if (fallback) fallback.cancel(); else ask({ op: "cancel" }); },
            warm(voice = "af_kore") { if (fallback) fallback.warm(voice); else ask({ op: "warm", voice: isVoice(voice) ? voice : "af_kore" }); },
            loaded: () => (fallback ? fallback.loaded() : ready),
            downloaded: () => (fallback ? fallback.downloaded() : ask({ op: "downloaded" }).then(r => !!(r && r.downloaded)))
        };
    }

    function createWorker(opts) {
        const stallMs = opts.stallMs || 120000;
        let worker = null;
        let seq = 0;
        let ready = false;
        let lastHeard = 0;
        let watchdog = null;
        let lastVoice = "af_kore";
        const pending = new Map();

        function failAll(err) {
            for (const job of pending.values()) job.reject(err);
            pending.clear();
        }

        function restart(err) {
            failAll(err);
            if (worker) { try { worker.terminate(); } catch (e) { /* already gone */ } }
            worker = null;
            ready = false;
            clearInterval(watchdog);
            watchdog = null;
        }

        function start() {
            if (worker) return worker;
            worker = opts.makeWorker ? opts.makeWorker() : new Worker(opts.workerUrl, { type: "module" });
            lastHeard = Date.now();
            worker.onmessage = event => {
                lastHeard = Date.now();
                const msg = event.data || {};
                if (msg.type === "progress") { if (opts.onProgress) opts.onProgress(msg); return; }
                if (msg.type === "ready") { ready = true; return; }
                const job = pending.get(msg.id);
                if (!job) return;
                pending.delete(msg.id);
                if (msg.type === "audio") { ready = true; job.resolve(new Blob([msg.wav], { type: "audio/wav" })); }
                else job.reject(new Error(msg.message || "the natural voice failed"));
            };
            worker.onerror = event => {
                if (event && event.preventDefault) event.preventDefault();
                restart(new Error((event && event.message) || "the natural voice couldn't start"));
            };
            watchdog = setInterval(() => {
                if (!ready && pending.size && Date.now() - lastHeard > stallMs) restart(new Error("the natural voice stopped responding"));
            }, Math.min(5000, stallMs));
            if (watchdog && watchdog.unref) watchdog.unref();
            return worker;
        }

        return {
            speak(text, voice = "af_kore") {
                return new Promise((resolve, reject) => {
                    const id = ++seq;
                    lastVoice = isVoice(voice) ? voice : "af_kore";
                    try {
                        const w = start();
                        if (!pending.size) lastHeard = Date.now();
                        pending.set(id, { resolve, reject });
                        w.postMessage({ type: "speak", id, text: String(text || ""), voice: lastVoice });
                    } catch (err) { pending.delete(id); reject(err); }
                });
            },
            // Drops every piece asked for so far. A piece being made can take longer than the speech
            // itself on a phone, so a busy worker is replaced (and warmed again if it was loaded)
            // instead of finishing words nobody will hear.
            cancel() {
                if (!worker || !pending.size) return;
                const wasReady = ready;
                restart(stoppedError());
                if (wasReady) { try { start().postMessage({ type: "warm", voice: lastVoice }); } catch (e) { /* not supported */ } }
            },
            warm(voice = "af_kore") { try { start().postMessage({ type: "warm", voice: isVoice(voice) ? voice : "af_kore" }); } catch (err) { /* not supported here */ } },
            loaded: () => ready,
            downloaded: () => downloaded()
        };
    }

    return { VOICES, MODEL_URL, isVoice, supported, downloaded, create };
});
