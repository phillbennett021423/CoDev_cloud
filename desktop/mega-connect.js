// The user's MEGA account for CoDev's MEGA tools (see mobile/www/agent-ui/mega-cloud.js,
// which holds the shared logic). Used by server.js (POST /mega) and the Windows app
// (IPC codev:mega), so the page never holds the MEGA session on the computer.
//
// Talks to MEGA with megajs (npm, MIT), MEGA's free open-source JavaScript SDK.
// The password is used once to sign in and never saved; the session (its id and
// the account key) is kept in sessionFile, encrypted by the Windows app.
const fs = require('fs');
const path = require('path');

// The shared module: next to the repo's page, or in the Windows app's copy of it.
function loadShared() {
    for (const candidate of ['../mobile/www/agent-ui/mega-cloud.js', './www/agent-ui/mega-cloud.js']) {
        const file = path.join(__dirname, candidate);
        if (fs.existsSync(file)) return require(file);
    }
    throw new Error('mega-cloud.js is missing from this copy of CoDev.');
}

// sessionFile: where the session is kept. protect/unprotect: optional encryption
// (the Windows app uses safeStorage). Storage: megajs's Storage (tests pass a stand-in).
function createMegaConnect({ sessionFile, protect = s => s, unprotect = s => s, Storage = null, log = () => {} }) {
    const { createMegaAccount } = loadShared();
    const account = createMegaAccount({
        Storage: Storage || (async () => require('megajs').Storage),
        load: () => {
            try { return JSON.parse(unprotect(fs.readFileSync(sessionFile, 'utf8'))); } catch { return null; }
        },
        save: value => {
            if (!value) { fs.rmSync(sessionFile, { force: true }); return; }
            fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
            fs.writeFileSync(sessionFile, protect(JSON.stringify(value)), { mode: 0o600 });
        },
        log
    });
    return { handle: req => account.handle(req), close: account.close };
}

module.exports = { createMegaConnect };
