// The cloud 3D worker: runs art_mesh's Blender jobs on GitHub Actions
// (.github/workflows/cloud-3d.yml) instead of this computer. Free on the GitHub
// account the user already has; nothing to sign up for. CPU only.
//
//   createCloudWorker({ env, fetchImpl, sleep }) -> { configured(), describe(), run(job, opts) }
//
// run(job) takes the same job art_mesh would give Blender (absolute local paths)
// and returns Blender's report with local paths, after writing every file the
// job made where it would have been written locally:
//   1 a draft release is made, holding job.json (with relative paths) and the
//     input files (assets named in__<n>_<name>);
//   2 the workflow is started with the release's id;
//   3 the worker uploads what Blender wrote, then result.json, to the release;
//   4 CoDev downloads them into the project and deletes the release.
//
// Settings: CODEV_CLOUD_TOKEN (a fine-grained GitHub token for the repo with
// Contents and Actions read and write), CODEV_CLOUD_REPO (owner/name; the repo
// with the workflow), CODEV_CLOUD_REF (branch, default main), CODEV_CLOUD_3D
// (auto: use the cloud when Blender isn't on this computer; always; off).
const fs = require('fs');
const path = require('path');

const WORKFLOW = 'cloud-3d.yml';
const API = 'https://api.github.com';
const INPUT_KEYS = ['input', 'high_poly', 'base', 'animations'];

function createCloudWorker({ env = process.env, fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), pollMs = 10000 } = {}) {
    const token = () => String(env.CODEV_CLOUD_TOKEN || '').trim();
    const repo = () => String(env.CODEV_CLOUD_REPO || '').trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
    const mode = () => String(env.CODEV_CLOUD_3D || 'auto').trim().toLowerCase();

    function configured() { return Boolean(token() && /^[\w.-]+\/[\w.-]+$/.test(repo()) && mode() !== 'off'); }

    function describe() {
        if (mode() === 'off') return 'Cloud 3D worker: off (CODEV_CLOUD_3D=off).';
        if (!configured()) return 'Cloud 3D worker: not set up. Set CODEV_CLOUD_REPO (owner/name of the repo with .github/workflows/cloud-3d.yml) and CODEV_CLOUD_TOKEN (a fine-grained GitHub token for that repo with Contents and Actions read and write) to run art_mesh on GitHub\'s computers for free.';
        return `Cloud 3D worker: ready on ${repo()} (GitHub Actions, CPU; ${mode() === 'always' ? 'every art_mesh job runs there' : 'used when Blender isn\'t on this computer, or with where "cloud"'}).`;
    }

    async function gh(method, url, { body, headers = {}, raw = false, ok = [200, 201, 202, 204] } = {}) {
        const res = await fetchImpl(url.startsWith('http') ? url : `${API}${url}`, {
            method, body, redirect: raw ? 'manual' : 'follow',
            headers: { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'codev', ...headers }
        });
        if (raw && res.status >= 300 && res.status < 400) {
            // Release files redirect to storage that must not get the GitHub token.
            const file = await fetchImpl(res.headers.get('location'), { headers: { 'User-Agent': 'codev' } });
            if (!file.ok) throw new Error(`download failed (${file.status})`);
            return Buffer.from(await file.arrayBuffer());
        }
        if (!ok.includes(res.status)) {
            let msg = '';
            try { msg = (await res.json()).message || ''; } catch { /* no body */ }
            const hint = res.status === 401 ? ' The token was refused: check CODEV_CLOUD_TOKEN.'
                : res.status === 403 || res.status === 404 ? ` Check CODEV_CLOUD_REPO and that the token can read and write Contents and Actions on ${repo()}.` : '';
            throw new Error(`GitHub ${method} ${url.replace(/\?.*/, '')} failed (${res.status}${msg ? `: ${msg}` : ''}).${hint}`);
        }
        if (raw) return Buffer.from(await res.arrayBuffer());
        return res.status === 204 ? null : res.json().catch(() => null);
    }

    function assetName(s) { return s.replace(/[^\w.-]/g, '_'); }

    async function run(job, { timeoutSeconds = 900, log = () => {}, label = '' } = {}) {
        if (!configured()) throw new Error(describe());
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const remote = JSON.parse(JSON.stringify(job));
        const uploads = [];
        const inputs = {};
        const add = (local) => {
            if (!local) return local;
            if (inputs[local]) return inputs[local];
            const rel = `in/${uploads.length}_${assetName(path.basename(local))}`;
            inputs[local] = rel;
            uploads.push({ local, name: `in__${rel.slice(3)}` });
            return rel;
        };
        for (const k of INPUT_KEYS) if (remote[k]) remote[k] = add(remote[k]);
        if (remote.maps && typeof remote.maps === 'object' && !Array.isArray(remote.maps)) for (const k of Object.keys(remote.maps)) remote.maps[k] = add(remote.maps[k]);
        if (job.output) remote.output = `out/output/${path.basename(job.output)}`;
        if (job.out_dir) remote.out_dir = 'out/dir';
        remote.result = 'out/result.json';
        remote.timeout_seconds = timeoutSeconds;

        const release = await gh('POST', `/repos/${repo()}/releases`, { body: JSON.stringify({ tag_name: `codev-3d-${id}`, name: `3D job ${id}${label ? ` (${label})` : ''}`, draft: true,
            body: 'Temporary: a CoDev cloud 3D job. CoDev deletes it once it has the results; any left over are safe to delete.' }), headers: { 'Content-Type': 'application/json' } });
        const uploadUrl = String(release.upload_url).replace(/\{.*\}$/, '');
        try {
            log(`Cloud 3D job ${id}: sending ${uploads.length} file(s) to ${repo()}.`);
            for (const u of uploads) await gh('POST', `${uploadUrl}?name=${encodeURIComponent(u.name)}`, { body: fs.readFileSync(u.local), headers: { 'Content-Type': 'application/octet-stream' } });
            await gh('POST', `${uploadUrl}?name=job.json`, { body: JSON.stringify(remote), headers: { 'Content-Type': 'application/json' } });
            await gh('POST', `/repos/${repo()}/actions/workflows/${WORKFLOW}/dispatches`, { body: JSON.stringify({ ref: String(env.CODEV_CLOUD_REF || 'main'), inputs: { job_id: id, release_id: String(release.id) } }), headers: { 'Content-Type': 'application/json' } });
            log(`Cloud 3D job ${id}: started on GitHub Actions.`);

            // Queueing and setting up Blender take a few minutes on top of the job itself.
            const deadline = Date.now() + (timeoutSeconds + 20 * 60) * 1000;
            let report = null;
            let polls = 0;
            while (!report) {
                if (Date.now() > deadline) throw new Error(`the cloud job didn't finish in time; see ${await runUrl(id) || `the Actions tab of ${repo()}`}.`);
                await sleep(pollMs);
                polls++;
                const assets = await gh('GET', `/repos/${repo()}/releases/${release.id}/assets?per_page=100`);
                const result = (assets || []).find(a => a.name === 'result.json');
                if (result) {
                    report = JSON.parse((await gh('GET', `/repos/${repo()}/releases/assets/${result.id}`, { raw: true, headers: { Accept: 'application/octet-stream' } })).toString('utf8'));
                    const byName = new Map(assets.map(a => [a.name, a]));
                    for (const [name, rel] of Object.entries(report.cloud_files || {})) {
                        const local = toLocal(rel, job, inputs);
                        const asset = byName.get(name);
                        if (!local || !asset) continue;
                        fs.mkdirSync(path.dirname(local), { recursive: true });
                        fs.writeFileSync(local, await gh('GET', `/repos/${repo()}/releases/assets/${asset.id}`, { raw: true, headers: { Accept: 'application/octet-stream' } }));
                    }
                } else if (polls % 6 === 0) {
                    const r = await findRun(id);
                    if (r && r.status === 'completed' && r.conclusion !== 'success') {
                        // The worker uploads result.json even when Blender fails; give it one more look.
                        const again = await gh('GET', `/repos/${repo()}/releases/${release.id}/assets?per_page=100`);
                        if (!(again || []).some(a => a.name === 'result.json')) throw new Error(`the cloud run ended (${r.conclusion}) without a result: ${r.html_url}`);
                    }
                }
            }
            const files = report.cloud_files;
            delete report.cloud_files;
            const mapped = mapReport(report, job, inputs);
            mapped.cloud_files = Object.values(files || {}).map(rel => toLocal(rel, job, inputs)).filter(Boolean);
            return mapped;
        } finally {
            await gh('DELETE', `/repos/${repo()}/releases/${release.id}`).catch(() => {});
        }
    }

    async function findRun(id) {
        try {
            const runs = await gh('GET', `/repos/${repo()}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=30`);
            return ((runs && runs.workflow_runs) || []).find(r => String(r.display_title || r.name || '').includes(id)) || null;
        } catch { return null; }
    }

    async function runUrl(id) { const r = await findRun(id); return r ? r.html_url : ''; }

    return { configured, describe, run, mode };
}

// "out/dir/x.png" -> <job.out_dir>/x.png; "out/output/a.glb" -> job.output; "in/0_a.glb" -> the local input.
function toLocal(rel, job, inputs) {
    if (typeof rel !== 'string') return rel;
    const clean = rel.replace(/\\/g, '/');
    if (clean.split('/').includes('..')) return '';
    if (job.out_dir && (clean === 'out/dir' || clean.startsWith('out/dir/'))) return path.join(job.out_dir, ...clean.slice('out/dir'.length).split('/').filter(Boolean));
    if (job.output && clean.startsWith('out/output/')) {
        const rest = clean.slice('out/output/'.length);
        return rest === path.basename(job.output) ? job.output : path.join(path.dirname(job.output), ...rest.split('/'));
    }
    if (clean.startsWith('in/')) {
        const found = Object.entries(inputs).find(([, r]) => r === clean);
        return found ? found[0] : '';
    }
    if (clean.startsWith('out/')) {
        const base = job.out_dir || (job.output ? path.dirname(job.output) : '');
        return base ? path.join(base, ...clean.slice(4).split('/')) : '';
    }
    return null;
}

function mapReport(value, job, inputs) {
    if (typeof value === 'string') { const l = /^(in|out)\//.test(value) ? toLocal(value, job, inputs) : null; return l || value; }
    if (Array.isArray(value)) return value.map(v => mapReport(v, job, inputs));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapReport(v, job, inputs)]));
    return value;
}

module.exports = { createCloudWorker, toLocal, mapReport, WORKFLOW };
