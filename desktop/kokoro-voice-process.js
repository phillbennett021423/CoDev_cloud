// The utility process that makes the natural voices (see kokoro-voice.js): started by main.js
// with utilityProcess.fork, so Kokoro's process-wide handlers stay out of the main process.
'use strict';
const { serveKokoro } = require('./kokoro-voice');

serveKokoro(process.parentPort);
