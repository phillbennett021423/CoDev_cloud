// Cloud runs: CoDev's agents working on GitHub's servers while the phone or PC is off.
//
// The queue is a branch of the user's own GitHub repo (agent-queue by default):
//   tasks/<id>.json     one task: when it runs next, how it repeats, and the sealed prompt
//   results/<id>.json   its latest runs: status in the clear, the replies and files sealed
//   state/spend.json    what the cloud runs spent today, for the daily limit
// The page writes tasks with the user's GitHub token and starts the "Cloud agents"
// workflow; scripts/cloud-agent.js runs them in the real CoDev page on the runner and
// writes the results back. The repo is public, so everything the user wrote or the
// agents made is sealed with AES-256-GCM under a passphrase only the user knows (it is
// the CODEV_CLOUD_PASSPHRASE secret on GitHub). Timing and status stay readable so the
// runner knows what is due without opening anything.
//
//   CodevCloud.seal(value, passphrase) / open(sealed, passphrase)
//   CodevCloud.createGitHub({ repo, token, branch, fetch })      contents API, refs, dispatch
//   CodevCloud.createQueue({ github, passphrase })               tasks, results, spend
//   CodevCloud.nextRun(repeat, after, timeZone)                   when a repeating task runs next
//   CodevCloud.isDue(task, now)
//
// The same file runs in the page and in Node (the runner and the tests).
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.CodevCloud = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    const BRANCH = "agent-queue";
    const WORKFLOW = "cloud-agent.yml";
    const KDF_ROUNDS = 210000;
    const MAX_RUNS_KEPT = 5;
    // Per run, before sealing. GitHub's contents API takes up to 100 MB; this stays well under.
    const MAX_RESULT_FILE_BYTES = 15 * 1024 * 1024;
    const REPEATS = ["once", "hourly", "daily", "weekdays", "weekly"];

    const subtle = () => {
        const c = (typeof globalThis !== "undefined" && globalThis.crypto) || null;
        if (!c || !c.subtle) throw new Error("This device has no Web Crypto, which cloud runs need to seal tasks.");
        return c.subtle;
    };
    const randomBytes = n => globalThis.crypto.getRandomValues(new Uint8Array(n));

    function toBase64(bytes) {
        let text = "";
        for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(text);
    }
    function fromBase64(text) {
        const raw = atob(String(text || "").replace(/\s+/g, ""));
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }
    const utf8 = text => new TextEncoder().encode(text);
    const fromUtf8 = bytes => new TextDecoder().decode(bytes);

    async function deriveKey(passphrase, salt) {
        const pass = String(passphrase || "");
        if (pass.length < 12) throw new Error("The cloud passphrase needs at least 12 characters.");
        const base = await subtle().importKey("raw", utf8(pass), "PBKDF2", false, ["deriveKey"]);
        return subtle().deriveKey({ name: "PBKDF2", salt, iterations: KDF_ROUNDS, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    }

    // Any JSON value in, { alg, salt, iv, data } out (base64).
    async function seal(value, passphrase) {
        const salt = randomBytes(16), iv = randomBytes(12);
        const key = await deriveKey(passphrase, salt);
        const data = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv }, key, utf8(JSON.stringify(value))));
        return { alg: "AES-256-GCM/PBKDF2-SHA256", rounds: KDF_ROUNDS, salt: toBase64(salt), iv: toBase64(iv), data: toBase64(data) };
    }

    async function open(sealed, passphrase) {
        if (!sealed || !sealed.data) throw new Error("Nothing sealed to open.");
        const key = await deriveKey(passphrase, fromBase64(sealed.salt));
        let plain;
        try {
            plain = await subtle().decrypt({ name: "AES-GCM", iv: fromBase64(sealed.iv) }, key, fromBase64(sealed.data));
        } catch (err) {
            throw new Error("Couldn't open it: the cloud passphrase doesn't match the one it was sealed with.");
        }
        return JSON.parse(fromUtf8(new Uint8Array(plain)));
    }

    // ---------- GitHub ----------

    function createGitHub({ repo, token, branch = BRANCH, fetch: fetchImpl, api = "https://api.github.com" }) {
        const doFetch = fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
        if (!doFetch) throw new Error("No fetch available.");
        const name = String(repo || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
        if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error(`"${repo}" isn't a GitHub repo. Write it as owner/name.`);
        const path = p => String(p).split("/").map(encodeURIComponent).join("/");

        async function call(method, url, body, accept) {
            const headers = { Accept: accept || "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
            if (token) headers.Authorization = `Bearer ${String(token).trim()}`;
            if (body !== undefined) headers["Content-Type"] = "application/json";
            const response = await doFetch(`${api}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
            const text = await response.text();
            if (!response.ok) {
                let message = text;
                try { message = JSON.parse(text).message || text; } catch (err) { /* plain text */ }
                const error = new Error(`GitHub ${method} ${url.split("?")[0]}: ${response.status} ${String(message).slice(0, 300)}`);
                error.status = response.status;
                throw error;
            }
            if (accept && accept.includes("raw")) return text;
            return text ? JSON.parse(text) : null;
        }

        const ref = `?ref=${encodeURIComponent(branch)}`;
        return {
            repo: name, branch,
            call,
            repoInfo: () => call("GET", `/repos/${name}`),
            async getFile(p) {
                try {
                    const meta = await call("GET", `/repos/${name}/contents/${path(p)}${ref}`);
                    if (Array.isArray(meta)) throw new Error(`${p} is a folder.`);
                    let text = meta.content ? fromUtf8(fromBase64(meta.content)) : "";
                    // Over 1 MB the JSON form leaves content out; the raw form has it.
                    if (!text && meta.size > 0) text = await call("GET", `/repos/${name}/contents/${path(p)}${ref}`, undefined, "application/vnd.github.raw+json");
                    return { sha: meta.sha, text };
                } catch (err) {
                    if (err.status === 404) return null;
                    throw err;
                }
            },
            async listDir(p) {
                try {
                    const list = await call("GET", `/repos/${name}/contents/${path(p)}${ref}`);
                    return Array.isArray(list) ? list.filter(f => f.type === "file").map(f => ({ name: f.name, path: f.path, sha: f.sha, size: f.size })) : [];
                } catch (err) {
                    if (err.status === 404) return [];
                    throw err;
                }
            },
            putFile: (p, text, message, sha) => call("PUT", `/repos/${name}/contents/${path(p)}`,
                { message, content: toBase64(utf8(text)), branch, ...(sha ? { sha } : {}) }),
            deleteFile: (p, sha, message) => call("DELETE", `/repos/${name}/contents/${path(p)}`, { message, sha, branch }),
            async branchExists() {
                try { await call("GET", `/repos/${name}/git/ref/heads/${encodeURIComponent(branch)}`); return true; } catch (err) {
                    if (err.status === 404) return false;
                    throw err;
                }
            },
            // A branch with no history of its own, so the queue never mixes with the code.
            async createQueueBranch() {
                const readme = "# CoDev cloud queue\n\nTasks and results for CoDev's cloud runs. Everything in here except timing and status is sealed with your cloud passphrase. Don't merge this branch.\n";
                const tree = await call("POST", `/repos/${name}/git/trees`, { tree: [{ path: "README.md", mode: "100644", type: "blob", content: readme }] });
                const commit = await call("POST", `/repos/${name}/git/commits`, { message: "Start the CoDev cloud queue", tree: tree.sha, parents: [] });
                return call("POST", `/repos/${name}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
            },
            dispatch: (workflow = WORKFLOW, onRef = "main", inputs) => call("POST", `/repos/${name}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref: onRef, ...(inputs ? { inputs } : {}) }),
            latestRuns: (workflow = WORKFLOW) => call("GET", `/repos/${name}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=5`)
        };
    }

    // ---------- Schedules ----------

    // The wall-clock parts of an instant in a time zone.
    function zoned(ms, timeZone) {
        const parts = {};
        new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" })
            .formatToParts(new Date(ms)).forEach(p => { parts[p.type] = p.value; });
        const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
        return { y: +parts.year, mo: +parts.month, d: +parts.day, h: +parts.hour % 24, mi: +parts.minute, s: +parts.second, weekday };
    }
    // The instant when it is y-mo-d h:mi in timeZone.
    function fromZoned(y, mo, d, h, mi, timeZone) {
        let guess = Date.UTC(y, mo - 1, d, h, mi);
        for (let i = 0; i < 2; i++) {
            const z = zoned(guess, timeZone);
            const offset = Date.UTC(z.y, z.mo - 1, z.d, z.h, z.mi) - guess;
            guess = Date.UTC(y, mo - 1, d, h, mi) - offset;
        }
        return guess;
    }

    function cleanRepeat(repeat) {
        const every = REPEATS.includes(repeat && repeat.every) ? repeat.every : "once";
        const at = /^([01]\d|2[0-3]):[0-5]\d$/.test(repeat && repeat.at) ? repeat.at : "08:00";
        const day = Number.isInteger(repeat && repeat.day) && repeat.day >= 0 && repeat.day <= 6 ? repeat.day : 1;
        return { every, at, day };
    }

    // The first run strictly after `after` (ms), or null for a one-off.
    function nextRun(repeat, after, timeZone = "UTC") {
        const r = cleanRepeat(repeat);
        if (r.every === "once") return null;
        if (r.every === "hourly") return after + 60 * 60 * 1000;
        const [h, mi] = r.at.split(":").map(Number);
        const today = zoned(after, timeZone);
        for (let add = 0; add < 9; add++) {
            const noon = Date.UTC(today.y, today.mo - 1, today.d + add, 12);
            const day = new Date(noon);
            const at = fromZoned(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, timeZone);
            if (at <= after) continue;
            const weekday = zoned(at, timeZone).weekday;
            if (r.every === "weekdays" && (weekday === 0 || weekday === 6)) continue;
            if (r.every === "weekly" && weekday !== r.day) continue;
            return at;
        }
        return null;
    }

    const isDue = (task, now = Date.now()) => !!task && !task.paused && typeof task.nextRun === "number" && task.nextRun <= now;

    function describeRepeat(repeat) {
        const r = cleanRepeat(repeat);
        if (r.every === "once") return "Once";
        if (r.every === "hourly") return "Every hour";
        if (r.every === "daily") return `Every day at ${r.at}`;
        if (r.every === "weekdays") return `Weekdays at ${r.at}`;
        return `Every ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][r.day]} at ${r.at}`;
    }

    const newId = () => `t${Date.now().toString(36)}${toBase64(randomBytes(6)).replace(/[^a-z0-9]/gi, "").slice(0, 6).toLowerCase()}`;

    // ---------- The queue ----------

    function createQueue({ github, passphrase }) {
        const taskPath = id => `tasks/${id}.json`;
        const resultPath = id => `results/${id}.json`;
        const readJson = async p => {
            const file = await github.getFile(p);
            if (!file) return null;
            try { return { sha: file.sha, value: JSON.parse(file.text) }; } catch (err) { return null; }
        };
        // A write that lost a race with another one reads again and retries.
        async function update(p, change, message) {
            for (let attempt = 0; attempt < 4; attempt++) {
                const current = await readJson(p);
                const next = await change(current ? current.value : null);
                if (next === undefined) return current ? current.value : null;
                try {
                    if (next === null) { if (current) await github.deleteFile(p, current.sha, message); return null; }
                    await github.putFile(p, JSON.stringify(next, null, 1), message, current && current.sha);
                    return next;
                } catch (err) {
                    if (err.status !== 409 && err.status !== 422 || attempt === 3) throw err;
                }
            }
            return null;
        }

        return {
            async ensureBranch() {
                if (!(await github.branchExists())) await github.createQueueBranch();
            },
            // body: { prompt, agent, limits: { daily, task }, chatId, title } ; repeat: { every, at, day }
            async addTask({ body, repeat, timeZone = "UTC", runNow = true }) {
                const id = newId();
                const r = cleanRepeat(repeat);
                const now = Date.now();
                const task = { v: 1, id, created: now, repeat: r, timeZone, nextRun: runNow || r.every === "once" ? now : nextRun(r, now, timeZone), sealed: await seal(body, passphrase) };
                await github.putFile(taskPath(id), JSON.stringify(task, null, 1), `Queue cloud task ${id}`);
                return task;
            },
            async listTasks() {
                const files = await github.listDir("tasks");
                const tasks = await Promise.all(files.filter(f => f.name.endsWith(".json")).map(async f => {
                    const read = await readJson(f.path);
                    return read && read.value && read.value.id ? read.value : null;
                }));
                return tasks.filter(Boolean);
            },
            getTask: async id => { const r = await readJson(taskPath(id)); return r ? r.value : null; },
            openTask: task => open(task.sealed, passphrase),
            updateTask: (id, change) => update(taskPath(id), async task => (task ? change(task) : undefined), `Update cloud task ${id}`),
            async removeTask(id) {
                await update(taskPath(id), () => null, `Remove cloud task ${id}`);
                await update(resultPath(id), () => null, `Remove cloud results ${id}`);
            },
            async runNow(id) {
                return update(taskPath(id), task => (task ? { ...task, nextRun: Date.now(), paused: false } : undefined), `Run cloud task ${id} now`);
            },
            // The clear part of results: { id, status, updated, runs: n, sealed }
            getResult: async id => { const r = await readJson(resultPath(id)); return r ? r.value : null; },
            openResult: result => (result && result.sealed ? open(result.sealed, passphrase) : Promise.resolve({ runs: [] })),
            // Adds or replaces a run (by its start time) and keeps the newest few.
            async saveRun(id, run) {
                return update(resultPath(id), async current => {
                    const previous = current && current.sealed ? await open(current.sealed, passphrase) : { runs: [] };
                    const runs = previous.runs.filter(r => r.started !== run.started).concat(run).sort((a, b) => a.started - b.started).slice(-MAX_RUNS_KEPT);
                    return { v: 1, id, status: run.status, updated: Date.now(), runs: runs.length, lastStarted: run.started, sealed: await seal({ runs }, passphrase) };
                }, `Cloud task ${id}: ${run.status}`);
            },
            async getSpend(day) {
                const r = await readJson("state/spend.json");
                return r && r.value && r.value.day === day ? r.value : { day, usd: 0, requests: 0, inputTokens: 0, outputTokens: 0 };
            },
            setSpend: spend => update("state/spend.json", () => spend, `Cloud spend ${spend.day}: $${(spend.usd || 0).toFixed(4)}`)
        };
    }

    return { BRANCH, WORKFLOW, REPEATS, MAX_RESULT_FILE_BYTES, seal, open, toBase64, fromBase64, createGitHub, createQueue, nextRun, isDue, describeRepeat, cleanRepeat };
});
