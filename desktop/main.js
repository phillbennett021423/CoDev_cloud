// CoDev Studio desktop app: the same page as the Android app (mobile/www),
// in its own window. The page talks to Groq directly; the main process only
// does what a page can't, like fetching DuckDuckGo results without CORS.
const { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { createMcpTools } = require('./mcp-tools');
const { createNodeMcpHub } = require('./mcp-hub');
const { createBrowserService } = require('./browser');
const { pathToFileURL } = require('url');

const WWW = path.join(__dirname, 'www');
// Served from app://codev/ so the page has a fixed origin (its saved settings
// and chats survive restarts) and ES modules like three.js load normally.
protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

// Only DuckDuckGo's HTML results page, the same one the Android app uses.
const ALLOWED_HTTP = /^https:\/\/html\.duckduckgo\.com\/html\/\?/;

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
    win.loadURL('app://codev/index.html');
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

    // Built-in MCP tools: agents work in the project folder chosen in Settings.
    const settingsFile = path.join(app.getPath('userData'), 'codev-desktop.json');
    let desktopSettings = {};
    try { desktopSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { desktopSettings = {}; }
    const getProjectDir = () => (desktopSettings.projectDir && fs.existsSync(desktopSettings.projectDir) ? desktopSettings.projectDir : '');
    const handleMcp = createMcpTools(getProjectDir);
    ipcMain.handle('codev:mcp', (_event, message) => handleMcp(message));
    ipcMain.handle('codev:mcp-folder', () => getProjectDir());

    // Agents' headless browsers. Saved logins are encrypted with safeStorage (DPAPI
    // on Windows) in this app's user data folder; the page asks the user before any is used.
    const browserTools = createBrowserService({ dataDir: app.getPath('userData'), safeStorage, getProjectDir });
    ipcMain.handle('codev:browser-mcp', (_event, message) => browserTools.handle(message));

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
    app.on('before-quit', () => { mcpHub.close(); browserTools.close(); });
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

    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
