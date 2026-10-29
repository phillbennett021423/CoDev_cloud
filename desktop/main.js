// CoDev Studio desktop app: the same page as the Android app (mobile/www),
// in its own window. The page talks to Groq directly; the main process only
// does what a page can't, like fetching DuckDuckGo results without CORS.
const { app, BrowserWindow, crashReporter, dialog, ipcMain, net, protocol, safeStorage, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { createMcpTools } = require('./mcp-tools');
const { handleImageFolder } = require('./image-folder');
const { createNodeMcpHub } = require('./mcp-hub');
const { createSandbox } = require('./sandbox');
const { createMedia } = require('./media');
const { createBrowserService } = require('./browser');
const { createOutlierBridge } = require('./outlier-bridge');
const { createGoogleConnect } = require('./google-connect');
const { pathToFileURL } = require('url');

const WWW = path.join(__dirname, 'www');
// Served from app://codev/ so the page has a fixed origin (its saved settings
// and chats survive restarts) and ES modules like three.js load normally.
protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

// Only DuckDuckGo's HTML results page, the same one the Android app uses, and the
// free keyless services behind the Google tools' fallbacks: OpenStreetMap places and
// routes, and YouTube's video titles.
const ODDS_API = /^https:\/\/api\.the-odds-api\.com\/v4\/sports(\/|\?)/;
const ODDS_HEADERS = ['x-requests-remaining', 'x-requests-used', 'x-requests-last'];
const ALLOWED_HTTP = /^https:\/\/(html\.duckduckgo\.com\/html\/\?|nominatim\.openstreetmap\.org\/search\?|router\.project-osrm\.org\/route\/v1\/|www\.youtube\.com\/oembed\?)/;

// A crash log in the app's user data folder (CoDev-crash.log), so an error in the
// main process is written down instead of closing the app, and the cause can be
// found afterwards.
function crashLog(kind, detail) {
    try {
        const file = path.join(app.getPath('userData'), 'CoDev-crash.log');
        // Kept short: the newest entries, up to about 200 KB.
        let old = '';
        try { old = fs.readFileSync(file, 'utf8').slice(-200000); } catch { /* first entry */ }
        fs.writeFileSync(file, `${old}[${new Date().toISOString()}] ${kind}: ${detail && detail.stack ? detail.stack : String(detail)}\n`);
    } catch { /* nothing more to do */ }
}
process.on('uncaughtException', err => { crashLog('uncaughtException', err); console.error(err); });
process.on('unhandledRejection', err => { crashLog('unhandledRejection', err); console.error(err); });
// A crash that skips JavaScript altogether (out of memory, a native fault) leaves a
// dump in the app's Crashpad folder instead of nothing. Kept on this computer.
crashReporter.start({ uploadToServer: false });

// A heartbeat every minute with each process's memory, removed on a normal quit. One
// still there at the next start means the app was closed by a crash, and the log
// gets its last reading, so memory that kept growing shows in the log.
const heartbeatFile = () => path.join(app.getPath('userData'), 'CoDev-heartbeat.json');
function memoryNow() {
    const mb = kb => Math.round(kb / 1024);
    return app.getAppMetrics().map(m => `${m.type} ${mb(m.memory.workingSetSize)} MB`).join(', ');
}
function beat() {
    try { fs.writeFileSync(heartbeatFile(), JSON.stringify({ at: new Date().toISOString(), memory: memoryNow() })); } catch { /* next minute */ }
}
// Returns true when the last run ended without a normal quit (and logs it).
function lastRunCrashed() {
    let last = null;
    try { last = JSON.parse(fs.readFileSync(heartbeatFile(), 'utf8')); } catch { return false; }
    let dumps = [];
    try { dumps = fs.readdirSync(path.join(app.getPath('crashDumps'), 'reports')).filter(f => f.endsWith('.dmp')); } catch { /* none */ }
    crashLog('previous-run-ended', `the app closed without quitting; last seen ${last.at} with ${last.memory}${dumps.length ? `; crash dumps: ${dumps.slice(-3).join(', ')}` : ''}`);
    return true;
}
app.on('will-quit', () => { try { fs.rmSync(heartbeatFile(), { force: true }); } catch { /* gone */ } });

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 860,
        minWidth: 380,
        title: 'CoDev Studio',
        icon: path.join(__dirname, 'build', 'icon.png'),
        autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true }
    });
    // Links (search sources, docs) open in the normal browser, not inside CoDev.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('app://codev/')) { event.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
    });
    // The page died (out of memory, a renderer crash) or froze: logged, and reloaded,
    // so it comes back with the chats it saved instead of a closed window.
    win.webContents.on('render-process-gone', (_event, details) => {
        crashLog('render-process-gone', `${details.reason} (exit code ${details.exitCode})`);
        if (details.reason !== 'clean-exit' && !win.isDestroyed()) setTimeout(() => { if (!win.isDestroyed()) win.webContents.reload(); }, 500);
    });
    // A window that stops answering is logged; if it is still stuck after 45 seconds,
    // its page is restarted (render-process-gone reloads it) instead of staying frozen.
    let stuck = null;
    win.on('unresponsive', () => {
        crashLog('unresponsive', `the window stopped responding (${memoryNow()})`);
        if (stuck) return;
        const since = Date.now();
        stuck = setTimeout(() => {
            stuck = null;
            if (win.isDestroyed()) return;
            crashLog('unresponsive', `still stuck after ${Math.round((Date.now() - since) / 1000)}s: restarting the page (${memoryNow()})`);
            win.webContents.forcefullyCrashRenderer();
        }, 45000);
    });
    win.on('responsive', () => {
        if (stuck) { clearTimeout(stuck); stuck = null; crashLog('responsive', 'the window answers again'); }
    });
    // The page's own errors, the first 50 a run, so a page crash comes with what led to it.
    let pageErrors = 0;
    win.webContents.on('console-message', ({ level, message, sourceId, lineNumber }) => {
        if (level === 'error' && pageErrors++ < 50) crashLog('page-error', `${message} (${sourceId}:${lineNumber})`);
    });
    win.loadURL('app://codev/index.html');
    return win;
}

app.whenReady().then(() => {
    protocol.handle('app', request => {
        const { host, pathname } = new URL(request.url);
        const file = path.normalize(path.join(WWW, decodeURIComponent(pathname)));
        if (host !== 'codev' || !file.startsWith(WWW + path.sep)) return new Response('Not found', { status: 404 });
        return net.fetch(pathToFileURL(file).toString());
    });

    ipcMain.handle('codev:http-get', async (_event, { url, headers }) => {
        if (typeof url !== 'string' || !ALLOWED_HTTP.test(url)) throw new Error('This address is not allowed.');
        const response = await net.fetch(url, { headers: headers || {} });
        return { status: response.status, data: await response.text(), headers: {} };
    });

    // The Odds API (line tracking): only its v4 API, and only the credit headers come back.
    ipcMain.handle('codev:http-odds', async (_event, { url }) => {
        if (typeof url !== 'string' || !ODDS_API.test(url)) throw new Error('This address is not allowed.');
        const response = await net.fetch(url);
        const headers = {};
        for (const name of ODDS_HEADERS) if (response.headers.get(name) != null) headers[name] = response.headers.get(name);
        return { status: response.status, data: await response.text(), headers };
    });

    // Built-in MCP tools: agents work in the project folder chosen in Settings.
    const settingsFile = path.join(app.getPath('userData'), 'codev-desktop.json');
    let desktopSettings = {};
    try { desktopSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { desktopSettings = {}; }
    const getProjectDir = () => (desktopSettings.projectDir && fs.existsSync(desktopSettings.projectDir) ? desktopSettings.projectDir : '');
    const handleMcp = createMcpTools(getProjectDir);
    ipcMain.handle('codev:mcp', (_event, message) => handleMcp(message));

    // The Google account for the YouTube, Maps, Gmail and Drive tools, encrypted
    // with safeStorage when Windows offers it. Sign-in opens in the normal browser.
    const canEncrypt = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
    const google = createGoogleConnect({
        tokenFile: path.join(app.getPath('userData'), 'google-account.json'),
        env: { apiKey: process.env.GOOGLE_API_KEY || null, clientId: process.env.GOOGLE_CLIENT_ID || null, clientSecret: process.env.GOOGLE_CLIENT_SECRET || null },
        protect: text => (canEncrypt() ? `enc:${safeStorage.encryptString(text).toString('base64')}` : text),
        unprotect: text => (text.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(text.slice(4), 'base64')) : text),
        openExternal: url => shell.openExternal(url)
    });
    ipcMain.handle('codev:google', (_event, req) => google.handle(req));
    app.on('will-quit', () => google.close());
    ipcMain.handle('codev:mcp-folder', () => getProjectDir());
    // Chromium writes the page's storage to disk only every few seconds, so a crash
    // could lose the last chat messages and run checkpoint. The page asks for a write
    // after each save; at most one a second.
    let flushTimer = null;
    ipcMain.on('codev:flush-storage', () => {
        if (flushTimer) return;
        flushTimer = setTimeout(() => { flushTimer = null; session.defaultSession.flushStorageData(); }, 1000);
    });
    // Screenshots in a folder named by its full path (read_screenshots).
    ipcMain.handle('codev:image-folder', async (event, req) => {
        if (req?.op !== 'pick') return handleImageFolder(req);
        const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
            title: 'Choose your screenshots folder', properties: ['openDirectory']
        });
        return result.canceled || !result.filePaths[0] ? { ok: false, canceled: true } : { ok: true, folder: result.filePaths[0] };
    });

    // Sandboxed agents: tools that work in a staging copy of the project, commands in
    // per-agent Docker containers, and the review gate (the only path that writes
    // agents' changes to the project folder, after the user approves the diff).
    const sandbox = createSandbox({ getProjectDir, log: line => console.log(line) });
    ipcMain.handle('codev:sandbox-mcp', (_event, message) => sandbox.handleMcp(message));
    ipcMain.handle('codev:agent-request', async (_event, req) => {
        const { method, path: urlPath, body } = req || {};
        const url = new URL(String(urlPath || '/'), 'app://codev');
        const reply = await sandbox.handleRequest(method, url.pathname, Object.fromEntries(url.searchParams), body);
        return reply || { status: 404, body: { error: 'Not found' } };
    });
    app.on('before-quit', () => { sandbox.closeSync(); });

    // Video and audio editing (FFmpeg, Whisper, Demucs, DeepFilterNet in Docker): the
    // agents' media_* tools, the page's uploads, and the files it shows under replies.
    const media = createMedia({ dataDir: app.getPath('userData'), log: line => console.log(`[media] ${line}`) });
    ipcMain.handle('codev:media', async (_event, req = {}) => {
        try {
            if (req.op === 'mcp') return await handleMediaMcp(media, req.message);
            if (req.op === 'status') return await media.status({});
            if (req.op === 'prepare') { media.prepare(); return await media.status({}); }
            if (req.op === 'files') return media.listFiles({});
            if (req.op === 'delete') return media.deleteFile({}, req.name);
            if (req.op === 'upload') return await media.saveUpload({}, req.name, Buffer.from(req.data));
            if (req.op === 'read') {
                const file = media.openFile({}, req.name);
                return { data: fs.readFileSync(file.full), type: file.type };
            }
            return { error: `Unknown media request ${req.op}` };
        } catch (err) {
            return { error: err.message };
        }
    });

    // Agents' headless browsers. Saved logins are encrypted with safeStorage (DPAPI
    // on Windows) in this app's user data folder; the page asks the user before any is used.
    const browserTools = createBrowserService({ dataDir: app.getPath('userData'), safeStorage, getProjectDir });
    // The Outlier pipeline: its agent tools ride along with the browser's, and the
    // 📈 Outlier tab's requests come over their own channel.
    const outlier = createOutlierBridge({ browser: browserTools, getProjectDir, log: line => console.log(line) });
    ipcMain.handle('codev:browser-mcp', (_event, message) => (outlier ? outlier.handleMcp(message, browserTools.handle) : browserTools.handle(message)));
    ipcMain.handle('codev:outlier-request', (_event, req) => (outlier ? outlier.request(req || {}) : { status: 404, body: { error: 'The Outlier pipeline isn\'t included in this build.' } }));
    // Live view: frames and inspector events go to the window that asked for them.
    const liveWatches = new Map(); // webContents id -> unsubscribe
    ipcMain.handle('codev:browser-live', async (event, req = {}) => {
        const sender = event.sender;
        if (req.op === 'watch') {
            if (liveWatches.has(sender.id)) liveWatches.get(sender.id)();
            const stop = browserTools.live.subscribe(String(req.agentId || ''), update => { if (!sender.isDestroyed()) sender.send('codev:browser-live-event', update); });
            liveWatches.set(sender.id, stop);
            sender.once('destroyed', () => { stop(); liveWatches.delete(sender.id); });
            return { ok: true };
        }
        if (req.op === 'unwatch') {
            if (liveWatches.has(sender.id)) liveWatches.get(sender.id)();
            liveWatches.delete(sender.id);
            return { ok: true };
        }
        if (req.op === 'forget-signins') return browserTools.manager.forgetSignIns(req.agentId || null);
        try { return await browserTools.live.control(req.agentId, req.control || {}); } catch (err) { return { error: err.message }; }
    });

    // External MCP servers from Settings (stdio processes and remote URLs), through the official SDK.
    const mcpHub = createNodeMcpHub({
        readConfig: () => desktopSettings.mcpServers,
        writeConfig: config => {
            desktopSettings.mcpServers = config;
            fs.writeFileSync(settingsFile, JSON.stringify(desktopSettings, null, 2));
        }
    });
    ipcMain.handle('codev:mcp-hub', (_event, req) => mcpHub.handle(req));
    // Stop the server processes the hub started.
    app.on('before-quit', () => { mcpHub.close(); if (outlier) outlier.close(); browserTools.close(); });
    ipcMain.handle('codev:mcp-pick-folder', async event => {
        const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
            title: 'Choose the project folder agents can work in',
            properties: ['openDirectory']
        });
        if (!result.canceled && result.filePaths[0]) {
            desktopSettings.projectDir = result.filePaths[0];
            fs.writeFileSync(settingsFile, JSON.stringify(desktopSettings, null, 2));
        }
        return getProjectDir();
    });

    // Electron on Windows leaves text boxes dead after alert()/confirm() until the
    // window loses and regains focus, so the page asks for exactly that.
    ipcMain.on('codev:refocus', event => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) return;
        win.blur();
        win.focus();
        event.sender.focus();
    });

    // Azure Speech for the natural Ava voice, from the main process so CORS can't block it.
    ipcMain.handle('codev:azure-tts', async (_event, { region, key, ssml }) => {
        if (typeof region !== 'string' || !/^[a-z0-9]+$/.test(region) || typeof key !== 'string' || typeof ssml !== 'string') {
            throw new Error('Bad Azure Speech request.');
        }
        const response = await net.fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': key,
                'Content-Type': 'application/ssml+xml',
                'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
                'User-Agent': 'CoDevStudio'
            },
            body: ssml
        });
        return { status: response.status, audio: response.status === 200 ? new Uint8Array(await response.arrayBuffer()) : null };
    });

    app.on('child-process-gone', (_event, details) => {
        if (details.reason !== 'clean-exit' && details.reason !== 'killed') crashLog('child-process-gone', `${details.type} ${details.reason} (exit code ${details.exitCode})`);
    });
    const crashed = lastRunCrashed();
    beat();
    setInterval(beat, 60000).unref();
    const win = createWindow();
    // After a crash, say so and offer the log, so it can be sent along.
    if (crashed) {
        win.webContents.once('did-finish-load', async () => {
            const { response } = await dialog.showMessageBox(win, {
                type: 'warning',
                message: 'CoDev closed unexpectedly last time.',
                detail: 'What happened is written in CoDev-crash.log. Send that file to get it fixed.',
                buttons: ['Show the crash log', 'OK'],
                defaultId: 0,
                cancelId: 1
            });
            if (response === 0) shell.showItemInFolder(path.join(app.getPath('userData'), 'CoDev-crash.log'));
            if (!win.isDestroyed()) { win.blur(); win.focus(); win.webContents.focus(); }
        });
    }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// The media tools as MCP JSON-RPC, like the sandbox's over codev:sandbox-mcp.
async function handleMediaMcp(media, msg) {
    const id = msg && msg.id;
    if (!msg || msg.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: await media.listTools() } };
    if (msg.method === 'tools/call') {
        const meta = (msg.params && msg.params._meta) || {};
        return { jsonrpc: '2.0', id, result: await media.callTool(msg.params.name, msg.params.arguments, { agentId: meta['codev/agentId'], meta }) };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
}
