// Writes the keys in the CODEV_SHARED_* environment variables into
// mobile/www/shared-keys.js for a private build (.github/workflows/private-build.yml).
// Never commit the file after running this.
const fs = require("fs");
const path = require("path");

const NAMES = { groq: "GROQ", openrouter: "OPENROUTER", anthropic: "ANTHROPIC", gemini: "GEMINI", tavily: "TAVILY", azureSpeech: "AZURE_SPEECH", azureSpeechRegion: "AZURE_SPEECH_REGION", odds: "ODDS" };
const keys = {};
for (const [name, env] of Object.entries(NAMES)) {
    const value = String(process.env[`CODEV_SHARED_${env}`] || "").trim();
    if (value) keys[name] = value;
}
const file = path.join(__dirname, "..", "mobile", "www", "shared-keys.js");
const source = fs.readFileSync(file, "utf8");
const empty = "window.CODEV_SHARED_KEYS = {};";
if (!source.includes(empty)) throw new Error(`${file} doesn't have the empty key list to fill in.`);
let filled = source.replace(empty, `window.CODEV_SHARED_KEYS = ${JSON.stringify(keys)};`);
// Where testers' feedback emails go: an email address, or nothing.
const feedbackTo = String(process.env.CODEV_FEEDBACK_EMAIL || "").trim();
if (feedbackTo && /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/.test(feedbackTo)) filled = filled.replace('window.CODEV_FEEDBACK_TO = "";', `window.CODEV_FEEDBACK_TO = ${JSON.stringify(feedbackTo)};`);
fs.writeFileSync(file, filled);
// Names only, never the keys.
console.log(`Built-in keys: ${Object.keys(keys).join(", ") || "none"}${feedbackTo ? "; feedback email set" : ""}`);
