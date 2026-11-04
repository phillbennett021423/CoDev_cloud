kokoro-js 1.2.1 (npm kokoro-js, Apache-2.0): Kokoro-82M text-to-speech running in the page
(transformers.js + ONNX Runtime Web, bundled in dist/kokoro.web.js). Used by
agent-ui/kokoro-worker.js for the natural read-aloud voices (Kore is af_kore). The model
(onnx-community/Kokoro-82M-v1.0-ONNX, q8, about 90 MB) downloads from Hugging Face the
first time and is kept in the browser's cache after that.
