// Natural read-aloud voices made on the device itself: Kokoro (vendor/kokoro), no key and
// no account. Kore is Kokoro's af_kore, the same voice the Windows media tools use.
//
//   CodevNaturalVoice.VOICES                      the voices offered, Kore first
//   CodevNaturalVoice.isVoice(id)                 one of them?
//   CodevNaturalVoice.supported()                 can this browser run it (WebAssembly + module workers)
//   CodevNaturalVoice.create({ workerUrl, onProgress, makeWorker })
//       { speak(text, voice) -> Promise<Blob (audio/wav)>, warm(), loaded() }
//
// The model (about 90 MB) downloads the first time a natural voice is used, with progress
// reported through onProgress, and stays in the browser's cache after that.
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

    function create(opts = {}) {
        let worker = null;
        let seq = 0;
        let ready = false;
        const pending = new Map();

        function start() {
            if (worker) return worker;
            worker = opts.makeWorker ? opts.makeWorker() : new Worker(opts.workerUrl, { type: "module" });
            worker.onmessage = event => {
                const msg = event.data || {};
                if (msg.type === "progress") { if (opts.onProgress) opts.onProgress(msg); return; }
                const job = pending.get(msg.id);
                if (!job) return;
                pending.delete(msg.id);
                if (msg.type === "audio") { ready = true; job.resolve(new Blob([msg.wav], { type: "audio/wav" })); }
                else job.reject(new Error(msg.message || "the natural voice failed"));
            };
            worker.onerror = event => {
                const err = new Error((event && event.message) || "the natural voice couldn't start");
                for (const job of pending.values()) job.reject(err);
                pending.clear();
                try { worker.terminate(); } catch (e) { /* already gone */ }
                worker = null;
            };
            return worker;
        }

        return {
            speak(text, voice = "af_kore") {
                return new Promise((resolve, reject) => {
                    const id = ++seq;
                    pending.set(id, { resolve, reject });
                    try { start().postMessage({ type: "speak", id, text: String(text || ""), voice: isVoice(voice) ? voice : "af_kore" }); }
                    catch (err) { pending.delete(id); reject(err); }
                });
            },
            warm() { try { start().postMessage({ type: "warm" }); } catch (err) { /* not supported here */ } },
            loaded: () => ready
        };
    }

    return { VOICES, isVoice, supported, create };
});
