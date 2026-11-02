// The agents' headless browser, put together: one browser per agent
// (browser-manager.js), the encrypted vault of saved logins and sessions
// (credential-vault.js), the tools agents call (browser-tools.js) and the
// user's live view of those browsers (live-view.js).
// The Windows app uses it over IPC; server.js through agents/browser.
const os = require('os');
const path = require('path');
const { createBrowserManager } = require('./browser-manager');
const { createCredentialVault } = require('./credential-vault');
const { createBrowserTools } = require('./browser-tools');
const { createLiveView } = require('./live-view');

// CoDev's own pages and the search/commands helper: an agent's browser must
// never be able to reach them (they start programs and spend API keys).
function defaultBlockedOrigins() {
    const ports = new Set([3000, Number(process.env.PORT) || 3000, 8787]);
    return [...ports].map(port => `http://127.0.0.1:${port}`);
}

// dataDir holds the vault and screenshots and must be outside the repo, in the
// user's own app-data folder.
// keepSignIns: each agent's browser profile (cookies, local storage, sign-ins) is kept
// in dataDir/browser-profiles and reused next time. On unless CODEV_BROWSER_KEEP_SIGNINS=0.
function createBrowserService({ dataDir, profileRoot = path.join(os.tmpdir(), 'codev-browser-profiles'), safeStorage, passphrase,
    getProjectDir, blockedOrigins = defaultBlockedOrigins(), keepSignIns = process.env.CODEV_BROWSER_KEEP_SIGNINS !== '0', log = console.log } = {}) {
    const manager = createBrowserManager({ profileRoot, keepRoot: keepSignIns && dataDir ? path.join(dataDir, 'browser-profiles') : null, blockedOrigins, log });
    const vault = createCredentialVault({ dir: dataDir, safeStorage, passphrase, log });
    const live = createLiveView({ manager, isBlockedUrl: url => manager.isBlocked(url), log });
    const tools = createBrowserTools({ manager, vault, getProjectDir, screenshotDir: path.join(dataDir, 'browser-screenshots'),
        log });
    return { ...tools, live, manager };
}

module.exports = { createBrowserService, defaultBlockedOrigins };
