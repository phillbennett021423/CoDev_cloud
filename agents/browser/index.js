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
            }
        },
        status: () => browser.status(),
        close: () => browser.close()
    };
}

module.exports = { createService };
