// Docker containers for spawned agents, through the docker CLI (child_process,
// never a shell, so nothing an agent writes is parsed by the host's shell).
// Each agent gets its own ephemeral container (`docker run --rm`). The only
// thing mounted in it is that agent's staging folder, at /workspace: the real
// project never is. Containers have no network by default, no Linux
// capabilities, a read-only root filesystem, and memory/CPU/process limits.
// They are removed when their workspace is discarded, after IDLE_MS without
// use, and when CoDev exits; containers left by a CoDev that crashed are
// removed the next time it starts.
const { spawn } = require('child_process');
const crypto = require('crypto');

const LABEL = 'codev.sandbox';
const DEFAULT_IMAGE = 'node:22-bookworm-slim';
const WORKDIR = '/workspace';
const IDLE_MS = 15 * 60 * 1000;
const DETECT_CACHE_MS = 30000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TIMEOUT_SECONDS = 600;

// Runs the docker CLI with an argument list. Resolves { code, stdout, stderr },
// or { code: null, missing: true } when docker isn't installed.
function docker(args, { timeoutMs = 60000, maxBytes = MAX_OUTPUT_BYTES, dockerPath = 'docker' } = {}) {
    return new Promise(resolve => {
        let child;
        try {
            child = spawn(dockerPath, args, { windowsHide: true });
        } catch (err) {
            return resolve({ code: null, missing: true, stdout: '', stderr: err.message });
        }
        let stdout = '', stderr = '', truncated = false, timedOut = false;
        const collect = which => chunk => {
            const text = chunk.toString();
            if (which === 'out') { if (stdout.length < maxBytes) stdout += text; else truncated = true; }
            else if (stderr.length < maxBytes) stderr += text; else truncated = true;
        };
        child.stdout.on('data', collect('out'));
        child.stderr.on('data', collect('err'));
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
        child.on('error', err => {
            clearTimeout(timer);
            resolve({ code: null, missing: err.code === 'ENOENT', stdout, stderr: stderr || err.message });
        });
        child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, truncated, timedOut }); });
        child.stdin.end();
    });
}

function createContainerManager(options = {}) {
    const dockerPath = options.dockerPath || process.env.CODEV_DOCKER || 'docker';
    const run = (args, opts = {}) => docker(args, { dockerPath, ...opts });
    const instance = `${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    let config = {
        image: process.env.CODEV_SANDBOX_IMAGE || DEFAULT_IMAGE,
        network: process.env.CODEV_SANDBOX_NETWORK === 'bridge' ? 'bridge' : 'none',
        memory: process.env.CODEV_SANDBOX_MEMORY || '2g',
        cpus: process.env.CODEV_SANDBOX_CPUS || '2',
        pidsLimit: 256
    };
    let detected = null;
    let staleCleanup = null;
    const containers = new Map(); // key -> { name, hostDir, lastUsed, starting }
    const reaper = setInterval(() => reapIdle().catch(() => {}), 60000);
    if (reaper.unref) reaper.unref();

    // { available, version?, reason? }, cached briefly so every tool list doesn't shell out.
    async function detect(force = false) {
        if (!force && detected && Date.now() - detected.at < DETECT_CACHE_MS) return detected.result;
        const reply = await run(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 8000 });
        let result;
        if (reply.missing) {
            result = { available: false, reason: 'Docker isn\'t installed on this computer. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) to run agents\' commands in sandboxes.' };
        } else if (reply.code !== 0 || !reply.stdout.trim()) {
            const why = (reply.stderr || '').trim().split('\n').pop() || 'no reply';
            result = { available: false, reason: `Docker is installed but its engine isn't running. Start Docker Desktop and try again. (${reply.timedOut ? 'timed out' : why})` };
        } else {
            result = { available: true, version: reply.stdout.trim() };
            if (!staleCleanup) staleCleanup = removeStaleContainers().catch(() => {});
        }
        detected = { at: Date.now(), result };
        return result;
    }

    // Containers whose CoDev process is gone (a crash, a killed window).
    async function removeStaleContainers() {
        const reply = await run(['ps', '-a', '--filter', `label=${LABEL}`, '--format', `{{.ID}} {{.Label "${LABEL}.pid"}}`], { timeoutMs: 15000 });
        if (reply.code !== 0) return;
        const stale = reply.stdout.split('\n').map(line => line.trim().split(' ')).filter(([id, pid]) => {
            if (!id) return false;
            try { process.kill(Number(pid), 0); return false; } catch { return true; }
        }).map(([id]) => id);
        if (stale.length) await run(['rm', '-f', ...stale], { timeoutMs: 30000 });
    }

    function configure(next = {}) {
        if (typeof next.image === 'string' && next.image.trim()) {
            const image = next.image.trim();
            // An image reference, not docker flags.
            if (!/^[a-zA-Z0-9][a-zA-Z0-9._\/:@-]{0,254}$/.test(image)) throw new Error(`"${image}" isn't a Docker image name.`);
            config.image = image;
        }
        if (next.network === 'none' || next.network === 'bridge') config.network = next.network;
        return getConfig();
    }

    function getConfig() {
        return { ...config };
    }

    async function ensureImage() {
        const inspect = await run(['image', 'inspect', '--format', '{{.Id}}', config.image], { timeoutMs: 15000 });
        if (inspect.code === 0) return;
        const pull = await run(['pull', config.image], { timeoutMs: 10 * 60 * 1000 });
        if (pull.code !== 0) throw new Error(`Couldn't download the sandbox image ${config.image}: ${(pull.stderr || '').trim().split('\n').pop()}`);
    }

    // Starts (or reuses) the container for one agent on one staging folder.
    async function acquire(agentId, workspaceId, hostDir) {
        const key = `${workspaceId}\u0000${agentId}`;
        const existing = containers.get(key);
        if (existing) {
            existing.lastUsed = Date.now();
            if (existing.starting) await existing.starting;
            if (await isRunning(existing.name)) return existing;
            containers.delete(key);
        }
        const status = await detect();
        if (!status.available) throw new Error(status.reason);
        const name = `codev-${slug(workspaceId)}-${slug(agentId)}-${crypto.randomBytes(3).toString('hex')}`;
        const entry = { name, hostDir, workspaceId, agentId, lastUsed: Date.now(), starting: null };
        containers.set(key, entry);
        entry.starting = (async () => {
            await ensureImage();
            const args = [
                'run', '-d', '--rm', '--name', name,
                '--label', LABEL, '--label', `${LABEL}.pid=${process.pid}`, '--label', `${LABEL}.instance=${instance}`,
                '--label', `${LABEL}.workspace=${workspaceId}`, '--label', `${LABEL}.agent=${agentId}`,
                '--network', config.network,
                '--memory', config.memory, '--cpus', config.cpus, '--pids-limit', String(config.pidsLimit),
                '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--read-only', '--tmpfs', '/tmp:rw,exec,size=512m',
                '--mount', `type=bind,source=${hostDir},target=${WORKDIR}`,
                '--workdir', WORKDIR,
                '--env', 'HOME=/tmp', '--env', 'CI=1', '--env', 'npm_config_cache=/tmp/.npm'
            ];
            // On Linux and macOS, files the agent creates belong to the user, not root.
            if (typeof process.getuid === 'function') args.push('--user', `${process.getuid()}:${process.getgid()}`);
            args.push('--entrypoint', 'sleep', config.image, 'infinity');
            const reply = await run(args, { timeoutMs: 120000 });
            if (reply.code !== 0) throw new Error(`Couldn't start a sandbox container: ${(reply.stderr || '').trim().split('\n').pop()}`);
        })();
        try {
            await entry.starting;
        } catch (err) {
            containers.delete(key);
            throw err;
        } finally {
            entry.starting = null;
        }
        return entry;
    }

    async function isRunning(name) {
        const reply = await run(['inspect', '--format', '{{.State.Running}}', name], { timeoutMs: 10000 });
        return reply.code === 0 && reply.stdout.trim() === 'true';
    }

    // Runs a command with `sh -c` inside the agent's container, in /workspace or
    // a folder under it. The command never touches the host's shell.
    async function exec(agentId, workspaceId, hostDir, command, { cwd = '.', timeoutSeconds = 120 } = {}) {
        const seconds = Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Number(timeoutSeconds) || 120));
        const dir = containerPath(cwd);
        const entry = await acquire(agentId, workspaceId, hostDir);
        entry.lastUsed = Date.now();
        // `timeout` inside the container stops the command itself; killing the
        // docker client alone would leave it running.
        const reply = await run(['exec', '--workdir', dir, entry.name, 'timeout', '-s', 'KILL', String(seconds), 'sh', '-c', command],
            { timeoutMs: (seconds + 15) * 1000 });
        entry.lastUsed = Date.now();
        if (reply.missing) throw new Error('Docker disappeared while running the command.');
        return {
            exitCode: reply.code,
            // 137 is SIGKILL from `timeout`.
            timedOut: reply.timedOut || reply.code === 137,
            stdout: reply.stdout,
            stderr: reply.stderr,
            truncated: Boolean(reply.truncated)
        };
    }

    async function release(workspaceId, agentId) {
        const doomed = [...containers.entries()].filter(([, c]) => c.workspaceId === workspaceId && (!agentId || c.agentId === agentId));
        for (const [key] of doomed) containers.delete(key);
        if (doomed.length) await run(['rm', '-f', ...doomed.map(([, c]) => c.name)], { timeoutMs: 30000 });
    }

    async function reapIdle() {
        const idle = [...containers.entries()].filter(([, c]) => !c.starting && Date.now() - c.lastUsed > IDLE_MS);
        for (const [key] of idle) containers.delete(key);
        if (idle.length) await run(['rm', '-f', ...idle.map(([, c]) => c.name)], { timeoutMs: 30000 });
    }

    function list() {
        return [...containers.values()].map(c => ({ name: c.name, workspace: c.workspaceId, agent: c.agentId, idleSeconds: Math.round((Date.now() - c.lastUsed) / 1000) }));
    }

    async function closeAll() {
        clearInterval(reaper);
        const names = [...containers.values()].map(c => c.name);
        containers.clear();
        if (names.length) await run(['rm', '-f', ...names], { timeoutMs: 30000 });
    }

    // Synchronous version for process exit handlers, where promises never settle.
    function closeAllSync() {
        clearInterval(reaper);
        const names = [...containers.values()].map(c => c.name);
        containers.clear();
        if (!names.length) return;
        try { require('child_process').spawnSync(dockerPath, ['rm', '-f', ...names], { timeout: 20000, windowsHide: true }); } catch { /* best effort */ }
    }

    return { detect, configure, getConfig, acquire, exec, release, list, closeAll, closeAllSync };
}

// "/workspace/<rel>" for a folder an agent names; never outside /workspace.
function containerPath(rel) {
    const parts = [];
    for (const part of String(rel || '.').replace(/\\/g, '/').split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (!parts.length) throw new Error(`'${rel}' is outside the sandbox workspace`);
            parts.pop();
        } else parts.push(part);
    }
    return [WORKDIR, ...parts].join('/');
}

function slug(text) {
    return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'x';
}

module.exports = { createContainerManager, containerPath, docker, DEFAULT_IMAGE, WORKDIR };
