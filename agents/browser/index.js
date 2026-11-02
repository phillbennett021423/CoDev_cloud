// The agents' headless browser as a server.js agent-tools service. The code is in
// desktop/browser, where the Windows app's installer can include it.
// The vault of saved logins stays out of the repo, in this user's app-data folder.
const os = require('os');
const path = require('path');

function serverDataDir() {
    if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'codev-server');
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'codev-server');
}

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

// config.workspace.browserProfilesDir: where the temporary browser profiles go.
// config.secrets.vaultKey (CODEV_VAULT_KEY): the vault's passphrase, when set.
function createService(config = {}, { log = console.log } = {}) {
    const { createBrowserService } = require('../../desktop/browser');
    const workspace = config.workspace || {};
    const browser = createBrowserService({
        dataDir: serverDataDir(),
        profileRoot: workspace.browserProfilesDir || undefined,
        passphrase: (config.secrets && config.secrets.vaultKey) || process.env.CODEV_VAULT_PASSPHRASE,
        getProjectDir: () => workspace.root || workspace.projectDir || '',
        log
    });
    return {
        name: 'browser',
        tools: browser.tools,
        // ctx: { agentId, agentName } from the page's params._meta["codev/agentId"].
        callTool: (name, args, ctx = {}) => browser.callTool(name, args, browser.context({ 'codev/agentId': ctx.agentId, 'codev/agentName': ctx.agentName })),
        // Page-only routes (same own-origin checks as /mcp-hub); never tools.
        routes: {
            'POST /browser/approve': async (req, res, body) => sendJson(res, 200, await browser.approve(body && body.id, body && body.approved === true)),
            'POST /browser/vault': async (req, res, body) => {
                const reply = await browser.vaultRequest(body || {});
                sendJson(res, reply.error ? 400 : 200, reply);
            },
            // Live view as server-sent events: ?agent=<id> streams that browser, no agent just the list.
            'GET /browser/live': (req, res) => {
                const agentId = new URL(req.url, 'http://localhost').searchParams.get('agent') || '';
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
                res.write('retry: 2000\n\n');
                // A slow tab skips frames instead of piling them up; other events always go.
                let backedUp = false;
                res.on('drain', () => { backedUp = false; });
                const stop = browser.live.subscribe(agentId, update => {
                    if (update.type === 'frame' && backedUp) return;
                    if (!res.write(`data: ${JSON.stringify(update)}\n\n`)) backedUp = true;
                });
                const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
                req.on('close', () => { clearInterval(heartbeat); stop(); });
            },
            // Deletes the kept sign-ins of one agent's browser ({ agentId }) or every agent's.
            'POST /browser/forget-signins': async (req, res, body) => sendJson(res, 200, await browser.manager.forgetSignIns((body && body.agentId) || null)),
            'POST /browser/live/control': async (req, res, body) => {
                try { sendJson(res, 200, await browser.live.control(body && body.agentId, (body && body.control) || {})); } catch (err) {
                    sendJson(res, 400, { error: err.message });
                }
            }
        },
        // For other services: the same browsers and live view (the Outlier
        // pipeline keeps its signed-in browser here so the user can see and drive it).
        shared: { manager: browser.manager, live: browser.live },
        status: () => browser.status(),
        close: () => browser.close()
    };
}

module.exports = { createService };
