// TRIPO 3D MODELS
// Loaded after media-tools.js. With the user's Tripo API key (Settings > Tripo 3D
// models), agents get generate_3d_model, which turns a description or a picture
// into a textured 3D model (.glb), and Tripo can make the pictures for
// generate_image too. Models show under the reply, open in the Project Files 3D
// viewer and download as .glb.
//
// Tripo's API doesn't answer web pages (CORS), so calls go through whatever this
// page runs in: the Android app's native HTTP, the Windows app, or server.js on
// this computer (both use desktop/tripo-relay.js). The key goes with each call
// and is kept only in this page's storage.
//
// Tripo bills in credits (about 1 cent each). Every call is checked against the
// per-task and daily limits in Settings before it is sent, using Tripo's price
// list, and what Tripo actually charged is counted afterwards.

const TRIPO_API = "https://openapi.tripo3d.com/v3";
const TRIPO_POLL_MS = 3000;
const TRIPO_TASK_TIMEOUT_MS = 8 * 60 * 1000;
const TRIPO_USD_PER_CREDIT = 0.01;
// Tripo's price list (developers.tripo3d.com/en/pricing), in credits.
const TRIPO_COSTS = { text: 10, image: 20, texture: 10, detailed: 10, lowPoly: 10, picture: 5 };
const TRIPO_QUALITIES = {
    draft: { label: "Draft: shape only, no colors", body: { texture: false, pbr: false } },
    standard: { label: "Standard texture", body: { texture: true, pbr: true, texture_quality: "standard" } },
    detailed: { label: "Detailed texture", body: { texture: true, pbr: true, texture_quality: "detailed" } }
};
const TRIPO_PICTURE_MODEL = "seedream_v4";
const TRIPO_PICTURE_SIZES = { "1:1": "2048x2048", "16:9": "2560x1440", "9:16": "1440x2560", "4:3": "2304x1728", "3:4": "1728x2304", "3:2": "2496x1664", "2:3": "1664x2496" };
const DEFAULT_TRIPO_MODELS_PER_TASK = 2;
const DEFAULT_TRIPO_DAILY_CREDITS = 100;
const MAX_KEPT_MODELS = 20;

const cleanTripoKey = value => String(value || "").replace(/[\s​-‍﻿"'`]+/g, "");
let tripoKey = cleanTripoKey(localStorage.getItem("codev_tripo_key"));
let tripoQuality = TRIPO_QUALITIES[localStorage.getItem("codev_tripo_quality")] ? localStorage.getItem("codev_tripo_quality") : "standard";
let tripoModelsPerTask = Number(localStorage.getItem("codev_tripo_per_task") ?? DEFAULT_TRIPO_MODELS_PER_TASK);
let tripoDailyCredits = Number(localStorage.getItem("codev_tripo_daily_credits") ?? DEFAULT_TRIPO_DAILY_CREDITS);
if (!Number.isFinite(tripoModelsPerTask)) tripoModelsPerTask = DEFAULT_TRIPO_MODELS_PER_TASK;
if (!Number.isFinite(tripoDailyCredits)) tripoDailyCredits = DEFAULT_TRIPO_DAILY_CREDITS;

function hasTripoKey() { return tripoKey.length >= 16; }

function tripoDollars(credits) { return `$${(credits * TRIPO_USD_PER_CREDIT).toFixed(2)}`; }

// ---------- Reaching Tripo ----------

function tripoError(message, status) {
    const err = new Error(message);
    err.status = status;
    return err;
}

// The Android app: Capacitor's native HTTP, which CORS doesn't apply to.
async function tripoNativeRequest(http, message) {
    const auth = { Authorization: `Bearer ${message.key}` };
    let reply;
    if (message.op === "api") {
        const post = message.method === "POST";
        reply = await http.request({ url: TRIPO_API + message.path, method: post ? "POST" : "GET", headers: { ...auth, ...(post ? { "Content-Type": "application/json" } : {}) },
            data: post ? message.body : undefined, responseType: "json", connectTimeout: 30000, readTimeout: 60000 });
    } else if (message.op === "upload") {
        const boundary = `----CoDevTripo${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
        reply = await http.request({ url: `${TRIPO_API}/files`, method: "POST", headers: { ...auth, "Content-Type": `multipart/form-data; boundary=${boundary}` },
            dataType: "formData", data: [{ key: "file", value: message.base64, type: "base64File", contentType: message.type, fileName: message.name }], responseType: "json", connectTimeout: 30000, readTimeout: 60000 });
    } else {
        reply = await http.request({ url: message.url, method: "GET", responseType: "arraybuffer", connectTimeout: 30000, readTimeout: 180000 });
        const headers = reply.headers || {};
        return { status: reply.status, contentType: headers["Content-Type"] || headers["content-type"] || "", base64: reply.data };
    }
    let body = reply.data;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (err) { body = { message: body.slice(0, 500) }; } }
    return { status: reply.status, body };
}

// A page opened some other way: straight to Tripo, which works only if Tripo allows it.
async function tripoDirectRequest(message) {
    try {
        if (message.op === "download") {
            const response = await fetch(message.url);
            const blob = await response.blob();
            return { status: response.status, contentType: blob.type, base64: await blobToBase64(blob) };
        }
        let response;
        if (message.op === "upload") {
            const form = new FormData();
            const bytes = Uint8Array.from(atob(message.base64), c => c.charCodeAt(0));
            form.append("file", new Blob([bytes], { type: message.type }), message.name);
            response = await fetch(`${TRIPO_API}/files`, { method: "POST", headers: { Authorization: `Bearer ${message.key}` }, body: form });
        } else {
            const post = message.method === "POST";
            response = await fetch(TRIPO_API + message.path, { method: post ? "POST" : "GET",
                headers: { Authorization: `Bearer ${message.key}`, ...(post ? { "Content-Type": "application/json" } : {}) }, body: post ? JSON.stringify(message.body || {}) : undefined });
        }
        return { status: response.status, body: await response.json().catch(() => ({})) };
    } catch (err) {
        return { error: `Tripo can't be reached from a page opened this way (${err.message}). Use the Android or Windows app, or start CoDev with start-codev.bat or npm start` };
    }
}

async function tripoRequest(message) {
    const http = typeof getNativeSpeechPlugin === "function" ? getNativeSpeechPlugin("CapacitorHttp") : null;
    if (http) {
        try { return await tripoNativeRequest(http, message); } catch (err) { return { error: `couldn't reach Tripo (${err.message || err})` }; }
    }
    if (window.codevDesktop?.tripo) return window.codevDesktop.tripo(message);
    if (/^https?:$/.test(location.protocol) && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
        try {
            const response = await fetch("/tripo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(message) });
            // An older server.js without the relay: try Tripo directly.
            if (response.status !== 404) return await response.json();
        } catch (err) { /* try directly */ }
    }
    return tripoDirectRequest(message);
}

// Calls Tripo's API and returns its data, or throws with a message for the user.
async function tripoApi(method, path, body) {
    const reply = await tripoRequest({ op: "api", key: tripoKey, method, path, body });
    return tripoData(reply);
}

function tripoData(reply) {
    if (!reply || reply.error) throw tripoError(reply ? reply.error : "no answer from Tripo");
    const body = reply.body || {};
    const said = String(body.message || body.msg || body.error || "").slice(0, 300);
    if (reply.status === 401 || reply.status === 403) throw tripoError(`Tripo rejected the API key${said ? ` (${said})` : ""}. Check it in Settings > Tripo 3D models`, reply.status);
    if (reply.status === 429) throw tripoError("Tripo says too many requests right now. Try again in a minute", 429);
    if (reply.status >= 400 || (body.code !== undefined && body.code !== 0)) {
        const credits = /credit|balance|insufficient/i.test(said) ? " Your Tripo account may be out of credits: top up at developers.tripo3d.com" : "";
        throw tripoError(`Tripo answered ${reply.status}${body.code ? ` (code ${body.code})` : ""}${said ? `: ${said}` : ""}.${credits}`, reply.status);
    }
    return body.data || {};
}

// Starts a task and waits for it, reporting progress. Returns the finished task.
async function runTripoTask(endpoint, body, onProgress) {
    const created = await tripoApi("POST", `/generation/${endpoint}`, body);
    if (!created.task_id) throw tripoError("Tripo didn't start the task");
    const started = Date.now();
    let last = -1;
    for (;;) {
        await new Promise(resolve => setTimeout(resolve, TRIPO_POLL_MS));
        const task = await tripoApi("GET", `/tasks/${encodeURIComponent(created.task_id)}`);
        if (task.status === "success") return { ...task, task_id: task.task_id || created.task_id };
        if (task.status === "failed" || task.status === "cancelled") {
            throw tripoError(`Tripo's task ${task.status}${task.error_message ? `: ${task.error_message}` : task.error_code ? ` (error ${task.error_code})` : ""}. Failed tasks aren't charged`);
        }
        if (Date.now() - started > TRIPO_TASK_TIMEOUT_MS) throw tripoError(`Tripo's task ${created.task_id} is still running after ${TRIPO_TASK_TIMEOUT_MS / 60000} minutes; CoDev stopped waiting`);
        const progress = Number(task.progress) || 0;
        if (onProgress && progress !== last) { last = progress; onProgress(progress, task.status); }
    }
}

// Tripo's links last only a few minutes, so results are fetched at once.
async function downloadTripoFile(url) {
    let reply;
    for (let attempt = 0; attempt < 2; attempt++) {
        reply = await tripoRequest({ op: "download", url });
        if (reply && !reply.error && reply.status < 400 && reply.base64) return reply;
    }
    throw tripoError(reply?.error || `the download answered ${reply?.status}`);
}

async function uploadPictureToTripo(dataUrl) {
    // At most 2048 px, as JPEG: well within Tripo's 20 MB and the relay's limits.
    const shrunk = await shrinkDataUrl(dataUrl, 2048, 0.9);
    const parts = dataUrlParts(shrunk || dataUrl);
    if (!parts) throw tripoError("the picture couldn't be read");
    const reply = await tripoRequest({ op: "upload", key: tripoKey, name: "codev-picture.jpg", type: parts.mimeType, base64: parts.data });
    const data = tripoData(reply);
    if (!data.file_token) throw tripoError("Tripo didn't accept the picture");
    return data.file_token;
}

// ---------- Credits used today ----------

function tripoUsageToday() {
    const fresh = { day: new Date().toDateString(), credits: 0, models: 0, pictures: 0 };
    try {
        const saved = JSON.parse(localStorage.getItem("codev_tripo_usage") || "{}");
        return saved.day === fresh.day ? { ...fresh, ...saved } : fresh;
    } catch (err) { return fresh; }
}

function countTripoCredits(credits, kind) {
    const usage = tripoUsageToday();
    usage.credits = Math.round((usage.credits + credits) * 100) / 100;
    usage[kind] = (usage[kind] || 0) + 1;
    try { localStorage.setItem("codev_tripo_usage", JSON.stringify(usage)); } catch (err) { /* not counted */ }
    return usage;
}

// Why a call costing this much can't run today, or "".
function tripoDailyLimitProblem(credits) {
    const usage = tripoUsageToday();
    if (usage.credits + credits <= tripoDailyCredits) return "";
    return `Not made: it would cost about ${credits} Tripo credits, and ${usage.credits} of today's ${tripoDailyCredits}-credit limit is used (Settings > Tripo 3D models changes it). Tell the user.`;
}

function estimateModelCredits(fromImage, quality, lowPoly) {
    let credits = fromImage ? TRIPO_COSTS.image : TRIPO_COSTS.text;
    if (quality !== "draft") credits += TRIPO_COSTS.texture;
    if (quality === "detailed") credits += TRIPO_COSTS.detailed;
    if (lowPoly) credits += TRIPO_COSTS.lowPoly;
    return credits;
}

// ---------- Pictures for generate_image ----------

async function makeImageWithTripo(prompt, aspect) {
    const problem = tripoDailyLimitProblem(TRIPO_COSTS.picture);
    if (problem) throw tripoError(problem.replace(/^Not made: /, "").replace(/ Tell the user\.$/, ""));
    const task = await runTripoTask("text-to-image", { prompt: prompt.slice(0, 3000), model: TRIPO_PICTURE_MODEL, size: TRIPO_PICTURE_SIZES[aspect] || TRIPO_PICTURE_SIZES["1:1"], output_format: "png" });
    const credits = Number(task.credits_consumed) || TRIPO_COSTS.picture;
    countTripoCredits(credits, "pictures");
    const url = task.output?.generated_image_url || task.output?.image_url;
    if (!url) throw tripoError("Tripo made no picture");
    const file = await downloadTripoFile(url);
    return { url: `data:${/^image\//.test(file.contentType) ? file.contentType.split(";")[0] : "image/png"};base64,${file.base64}`, model: `Tripo ${TRIPO_PICTURE_MODEL}`, cost: credits * TRIPO_USD_PER_CREDIT, tripoTaskId: task.task_id };
}

// ---------- 3D models ----------

function modelFileName(prompt) {
    return `${String(prompt || "").replace(/[^\w ]+/g, "").trim().split(/\s+/).slice(0, 5).join("-").toLowerCase() || "model"}.glb`;
}

// The picture to turn into a model: one attached to this message, or one made in this chat.
async function findPictureForModel(choice, ctx) {
    const wanted = String(choice || "").trim().toLowerCase();
    const attached = Array.isArray(ctx.attachedImages) ? ctx.attachedImages : [];
    if (!wanted || wanted === "attached") {
        if (attached.length) return { dataUrl: attached[0] };
        if (wanted === "attached") return null;
    }
    const made = (ctx.generatedImages || []).filter(a => a.kind === "image");
    const hit = made.find(a => a.name.toLowerCase() === wanted) || (!wanted ? made[made.length - 1] : null);
    if (hit) return { dataUrl: hit.fullUrl, tripoTaskId: hit.tripoTaskId };
    // Pictures made earlier in this chat are kept in IndexedDB.
    const session = typeof chatSessions !== "undefined" ? chatSessions.find(s => s.id === ctx.sessionId) : null;
    const earlier = (session?.messages || []).flatMap(m => m.attachments || []).filter(a => a.generatedId && a.kind === "image");
    const match = earlier.filter(a => a.name.toLowerCase() === wanted || (!wanted)).pop();
    if (!match) return null;
    const saved = await loadGeneratedImage(match.generatedId);
    return saved ? { dataUrl: saved.url, tripoTaskId: saved.tripoTaskId } : null;
}

// Keeps a model and drops the oldest past MAX_KEPT_MODELS (they can be big).
async function keepModel(record) {
    await mediaStore("images", "readwrite", store => store.put(record));
    let ids = [];
    try { ids = JSON.parse(localStorage.getItem("codev_tripo_models") || "[]"); } catch (err) { /* start over */ }
    ids = ids.filter(id => id !== record.id).concat(record.id);
    for (const old of ids.splice(0, Math.max(0, ids.length - MAX_KEPT_MODELS))) await mediaStore("images", "readwrite", store => store.delete(old));
    try { localStorage.setItem("codev_tripo_models", JSON.stringify(ids)); } catch (err) { /* pruned next time */ }
}

async function generateModelForTask(args, ctx) {
    if (!hasTripoKey()) return "There's no Tripo API key. Tell the user to add one in Settings > Tripo 3D models.";
    const prompt = String(args.prompt || "").trim();
    const fromImage = Boolean(args.image) || (!prompt && Array.isArray(ctx.attachedImages) && ctx.attachedImages.length > 0);
    if (!prompt && !fromImage) return "generate_3d_model needs a prompt describing the object, or a picture (image).";
    ctx.generatedModels = ctx.generatedModels || 0;
    if (ctx.generatedModels >= tripoModelsPerTask) {
        return tripoModelsPerTask === 0
            ? "3D models are turned off (Settings > Tripo 3D models sets how many each task may make). Tell the user."
            : `Not made: ${tripoModelsPerTask} 3D model${tripoModelsPerTask === 1 ? " is" : "s is"} the limit for one task, to keep Tripo credits down. Show the user what you made and ask before making more.`;
    }
    // The agent may pick the Settings quality or a cheaper one, never a dearer one.
    const rank = Object.keys(TRIPO_QUALITIES);
    const quality = TRIPO_QUALITIES[args.quality] && rank.indexOf(args.quality) <= rank.indexOf(tripoQuality) ? args.quality : tripoQuality;
    const lowPoly = Boolean(args.low_poly);
    const estimate = estimateModelCredits(fromImage, quality, lowPoly);
    const problem = tripoDailyLimitProblem(estimate);
    if (problem) return problem;

    const body = { ...TRIPO_QUALITIES[quality].body };
    if (lowPoly) {
        body.smart_low_poly = true;
        body.face_limit = Math.max(500, Math.min(20000, Math.round(Number(args.face_limit) || 5000)));
    } else if (Number(args.face_limit) > 0) {
        body.face_limit = Math.max(1000, Math.min(500000, Math.round(Number(args.face_limit))));
    }
    const step = text => { if (ctx.onStep) ctx.onStep(text); };
    let task;
    try {
        if (fromImage) {
            const picture = await findPictureForModel(args.image, ctx);
            if (!picture) return `There's no picture "${args.image || "attached"}" to turn into a model. Ask the user to attach one, or make one first with generate_image, or describe the object in prompt instead.`;
            let input = picture.tripoTaskId;
            if (!input) {
                step("🧊 Sending the picture to Tripo…");
                input = await uploadPictureToTripo(picture.dataUrl);
            }
            step(`🧊 Tripo is building the 3D model (about ${estimate} credits)…`);
            task = await runTripoTask("image-to-model", { input, ...body }, p => step(`🧊 Tripo is building the 3D model… ${p}%`));
        } else {
            step(`🧊 Tripo is building the 3D model (about ${estimate} credits)…`);
            const request = { prompt: prompt.slice(0, 1024), ...body };
            if (args.negative_prompt) request.negative_prompt = String(args.negative_prompt).slice(0, 255);
            task = await runTripoTask("text-to-model", request, p => step(`🧊 Tripo is building the 3D model… ${p}%`));
        }
    } catch (err) {
        return `Error: the 3D model couldn't be made: ${err.message}.`;
    }
    const credits = Number(task.credits_consumed) || estimate;
    ctx.generatedModels++;
    const today = countTripoCredits(credits, "models");
    const modelUrl = task.output?.pbr_model_url || task.output?.model_url || task.output?.pbr_model || task.output?.model;
    if (!modelUrl) return `Error: Tripo finished task ${task.task_id} (${credits} credits) but sent no model file. Tell the user.`;
    let model;
    try {
        step("🧊 Downloading the model…");
        model = await downloadTripoFile(modelUrl);
    } catch (err) {
        return `Error: Tripo made the model (task ${task.task_id}, ${credits} credits) but it couldn't be downloaded: ${err.message}. Tell the user it may still be in their Tripo account's task history.`;
    }
    let preview = "";
    const previewUrl = task.output?.rendered_image_url || task.output?.rendered_image;
    if (previewUrl) {
        try {
            const image = await downloadTripoFile(previewUrl);
            preview = await shrinkDataUrl(`data:${/^image\//.test(image.contentType) ? image.contentType.split(";")[0] : "image/webp"};base64,${image.base64}`, 720, 0.85);
        } catch (err) { /* the model matters, not its preview */ }
    }
    const name = modelFileName(prompt || "model-from-picture");
    const id = `mdl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const bytes = Uint8Array.from(atob(model.base64), c => c.charCodeAt(0));
    await keepModel({ id, kind: "model", name, blob: new Blob([bytes], { type: "model/gltf-binary" }), preview, prompt: prompt || "(from a picture)", credits, tripoTaskId: task.task_id, at: Date.now() });
    ctx.generatedImages = ctx.generatedImages || [];
    ctx.generatedImages.push({ name, kind: "model", thumb: preview ? await shrinkDataUrl(preview, 360, 0.78) : "", generatedId: id });
    const sizeMb = (bytes.length / 1048576).toFixed(1);
    logMediaActivity(`[Tripo] Made "${name}" (${sizeMb} MB, ${credits} credits, about ${tripoDollars(credits)}). Today: ${today.credits} of ${tripoDailyCredits} credits.`);
    return `Made the 3D model "${name}" (${sizeMb} MB .glb) with Tripo for ${credits} credits (about ${tripoDollars(credits)}; ${today.credits} of today's ${tripoDailyCredits} used). `
        + "It is shown under your reply, where the user can open it in the 3D viewer or download it. Don't paste links or data for it. In your reply, say briefly what you made and what it cost.";
}

function buildTripoTools() {
    if (!hasTripoKey() || tripoModelsPerTask <= 0) return [];
    const cost = q => `${estimateModelCredits(false, q, false)} credits from a description, ${estimateModelCredits(true, q, false)} from a picture`;
    return [{
        name: "generate_3d_model",
        description: "Make a 3D model (.glb with textures, for games, Godot, Blender, 3D printing or AR) with Tripo, from a description or from a picture. "
            + "Only call it when the user asks for a 3D model or asset; it spends the user's Tripo credits and takes 1 to 3 minutes. "
            + `Settings quality: ${TRIPO_QUALITIES[tripoQuality].label}, about ${cost(tripoQuality)} (1 credit is about 1 cent). At most ${tripoModelsPerTask} per task. `
            + "Describe one object: its shape, material, colors and style, not a scene. For a picture, set image to \"attached\" (the picture attached to this message) or the name of a picture made in this chat.",
        inputSchema: { type: "object", properties: {
            prompt: { type: "string", description: "The object to make, in detail (up to 1024 characters). Optional when image is set." },
            image: { type: "string", description: "Optional: \"attached\", or the file name of a picture made with generate_image in this chat, to build the model from that picture." },
            negative_prompt: { type: "string", description: "Optional: what to avoid." },
            quality: { type: "string", enum: Object.keys(TRIPO_QUALITIES), description: "Optional: draft (shape only, cheapest) or a texture quality up to the one in Settings. Default: Settings." },
            low_poly: { type: "boolean", description: `Optional: clean low-poly topology for games (+${TRIPO_COSTS.lowPoly} credits). Best for simple objects.` },
            face_limit: { type: "integer", description: "Optional: the most triangles (500 to 20,000 with low_poly)." }
        } },
        run: async (args, toolCtx) => generateModelForTask(args, toolCtx || {})
    }];
}

// ---------- Viewing and downloading ----------

async function loadGeneratedModel(id) {
    const saved = await mediaStore("images", "readonly", store => store.get(id));
    return saved && saved.blob ? saved : null;
}

// Opens a made model in the Project Files 3D viewer.
async function openModelInViewer(id) {
    const saved = await loadGeneratedModel(id);
    if (!saved) return false;
    const path = `tripo/${saved.name}`;
    loadedModelAssets[path] = new File([saved.blob], saved.name, { type: "model/gltf-binary" });
    switchView("project");
    selectProjectFile(path);
    return true;
}

function downloadGeneratedModel(saved) {
    const url = URL.createObjectURL(saved.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = saved.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// What tapping a made model under a reply shows: its preview, open and download.
async function openGeneratedModel(id) {
    const saved = await loadGeneratedModel(id);
    const existing = document.getElementById("generatedImageViewer");
    if (existing) existing.remove();
    const viewer = document.createElement("div");
    viewer.id = "generatedImageViewer";
    viewer.className = "generated-viewer";
    viewer.onclick = event => { if (event.target === viewer) viewer.remove(); };
    const box = document.createElement("div");
    box.className = "generated-viewer-box";
    if (!saved) {
        box.textContent = `This model is no longer saved on this device (CoDev keeps the newest ${MAX_KEPT_MODELS}).`;
    } else {
        if (saved.preview) {
            const img = document.createElement("img");
            img.src = saved.preview;
            img.alt = saved.prompt;
            box.appendChild(img);
        }
        const caption = document.createElement("div");
        caption.className = "generated-viewer-caption";
        caption.textContent = `${saved.name} · ${(saved.blob.size / 1048576).toFixed(1)} MB · ${saved.credits} Tripo credits · ${saved.prompt}`;
        const buttons = document.createElement("div");
        buttons.style.cssText = "display: flex; gap: 8px; flex-wrap: wrap; justify-content: center;";
        const open = document.createElement("button");
        open.className = "btn-primary";
        open.textContent = "🧊 Open in 3D viewer";
        open.onclick = async () => { viewer.remove(); await openModelInViewer(id); };
        const download = document.createElement("button");
        download.className = "btn-secondary";
        download.textContent = "⬇ Download .glb";
        download.onclick = () => downloadGeneratedModel(saved);
        buttons.append(open, download);
        box.append(caption, buttons);
    }
    const close = document.createElement("button");
    close.textContent = "✕";
    close.className = "generated-viewer-close";
    close.title = "Close";
    close.onclick = () => viewer.remove();
    box.prepend(close);
    viewer.appendChild(box);
    document.body.appendChild(viewer);
}

// ---------- Settings ----------

function fillTripoSettings() {
    const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
    set("modalTripoKey", tripoKey);
    set("modalTripoQuality", tripoQuality);
    set("modalTripoPerTask", String(tripoModelsPerTask));
    set("modalTripoDailyCredits", String(tripoDailyCredits));
    updateTripoStatus();
}

function updateTripoStatus(extra = "") {
    const status = document.getElementById("tripoStatus");
    if (!status) return;
    const usage = tripoUsageToday();
    const q = tripoQuality;
    status.textContent = [
        hasTripoKey() ? `On. Each model costs about ${estimateModelCredits(false, q, false)} credits from a description or ${estimateModelCredits(true, q, false)} from a picture at this quality; a Tripo picture costs ${TRIPO_COSTS.picture}.` : "Off: paste your Tripo API key to turn it on.",
        `Used today: ${usage.credits} of ${tripoDailyCredits} credits (about ${tripoDollars(usage.credits)}): ${usage.models} model${usage.models === 1 ? "" : "s"}, ${usage.pictures} picture${usage.pictures === 1 ? "" : "s"}.`,
        extra
    ].filter(Boolean).join("\n");
}

// Returns an error message, or "" when saved.
function saveTripoSettings() {
    const value = id => String(document.getElementById(id)?.value || "").trim();
    const newKey = cleanTripoKey(value("modalTripoKey"));
    if (newKey && newKey.length < 16) return "That doesn't look like a Tripo API key. Copy it again from developers.tripo3d.com (API Keys).";
    tripoKey = newKey;
    tripoQuality = TRIPO_QUALITIES[value("modalTripoQuality")] ? value("modalTripoQuality") : "standard";
    const perTask = Number(value("modalTripoPerTask"));
    tripoModelsPerTask = Number.isFinite(perTask) && value("modalTripoPerTask") !== "" ? Math.max(0, Math.min(10, Math.round(perTask))) : DEFAULT_TRIPO_MODELS_PER_TASK;
    const daily = Number(value("modalTripoDailyCredits"));
    tripoDailyCredits = Number.isFinite(daily) && value("modalTripoDailyCredits") !== "" ? Math.max(0, Math.min(10000, Math.round(daily))) : DEFAULT_TRIPO_DAILY_CREDITS;
    localStorage.setItem("codev_tripo_key", tripoKey);
    localStorage.setItem("codev_tripo_quality", tripoQuality);
    localStorage.setItem("codev_tripo_per_task", String(tripoModelsPerTask));
    localStorage.setItem("codev_tripo_daily_credits", String(tripoDailyCredits));
    updateTripoStatus();
    return "";
}

// The Check button: the typed key's balance, without saving it.
async function checkTripoBalance() {
    const typed = cleanTripoKey(document.getElementById("modalTripoKey")?.value);
    if (!typed) return updateTripoStatus("Paste a key first.");
    updateTripoStatus("Checking…");
    const saved = tripoKey;
    tripoKey = typed;
    try {
        const data = await tripoApi("GET", "/account/balance");
        updateTripoStatus(`✓ Key works. Balance: ${data.balance ?? "?"} credits (about ${tripoDollars(Number(data.balance) || 0)})${Number(data.frozen) ? `, ${data.frozen} held for running tasks` : ""}.`);
    } catch (err) {
        updateTripoStatus(`✗ ${err.message}.`);
    } finally {
        tripoKey = saved;
    }
}
