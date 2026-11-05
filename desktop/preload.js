// Gives the page a native web fetch, shaped like the Android app's CapacitorHttp.get,
// so CoDev's DuckDuckGo search works without the Python helper, and Azure
// Speech for the natural Ava voice.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codevDesktop', {
    http: {
        get: ({ url, headers }) => ipcRenderer.invoke('codev:http-get', { url, headers }),
        // The Odds API for line tracking, with its credit headers (x-requests-remaining...).
        odds: ({ url }) => ipcRenderer.invoke('codev:http-odds', { url }),
        // ESPN's free stats JSON for the prop model's game logs.
        espn: ({ url }) => ipcRenderer.invoke('codev:http-espn', { url }),
        // Tavily web search with the key from Settings: ({ key, body }) -> { status, data }.
        tavily: ({ key, body }) => ipcRenderer.invoke('codev:http-tavily', { key, body })
    },
    azureTts: ({ region, key, ssml }) => ipcRenderer.invoke('codev:azure-tts', { region, key, ssml }),
    // The natural voices (Kokoro) made natively: ({ op: speak | cancel | warm | downloaded, text, voice })
    // -> { ok, wav?, downloaded?, message?, stopped?, unavailable? }; the model download's progress
    // comes through onNaturalVoiceProgress.
    naturalVoice: req => ipcRenderer.invoke('codev:natural-voice', req),
    onNaturalVoiceProgress: callback => {
        const listener = (_event, progress) => callback(progress);
        ipcRenderer.on('codev:natural-voice-progress', listener);
        return () => ipcRenderer.removeListener('codev:natural-voice-progress', listener);
    },
    // Writes the page's saved chats and run checkpoints to disk now, so a crash right after loses nothing.
    flushStorage: () => ipcRenderer.send('codev:flush-storage'),
    // Gives keyboard focus back to the page after a native alert or confirm.
    refocus: () => ipcRenderer.send('codev:refocus'),
    // The Google account for the YouTube, Maps and Gmail tools: { op, ... } (see google-connect.js).
    google: req => ipcRenderer.invoke('codev:google', req),
    // The MEGA session for the MEGA cloud tools: { op, ... } (see mega-connect.js).
    mega: req => ipcRenderer.invoke('codev:mega', req),
    // Azgaar's Fantasy Map Generator for the map_generate tool: { op: "generate", seed, ... } (see azgaar-map.js).
    azgaar: req => ipcRenderer.invoke('codev:azgaar', req),
    // Built-in MCP tools for the chosen project folder.
    mcp: message => ipcRenderer.invoke('codev:mcp', message),
    mcpFolder: () => ipcRenderer.invoke('codev:mcp-folder'),
    // Screenshots in any folder on this computer, by full path: { op: "list", folder } or { op: "read", path }.
    imageFolder: req => ipcRenderer.invoke('codev:image-folder', req),
    pickMcpFolder: () => ipcRenderer.invoke('codev:mcp-pick-folder'),
    // External MCP servers (stdio and remote), run by the main process's MCP hub.
    mcpHub: req => ipcRenderer.invoke('codev:mcp-hub', req),
    // Sandboxed agent tools (JSON-RPC, like mcp) and the review routes server.js
    // serves under /agent/: ({ method, path, body }) -> { status, body }.
    sandboxMcp: message => ipcRenderer.invoke('codev:sandbox-mcp', message),
    agentRequest: req => ipcRenderer.invoke('codev:agent-request', req),
    // Video and audio editing: { op: status | prepare | files | delete | upload | read | mcp, ... }.
    media: req => ipcRenderer.invoke('codev:media', req),
    // Agents' headless browsers and the saved web logins (JSON-RPC, like mcp).
    browserMcp: message => ipcRenderer.invoke('codev:browser-mcp', message),
    // The 📈 Outlier tab's requests, the routes server.js serves under /outlier/: ({ method, path, body }) -> { status, body }.
    outlierRequest: req => ipcRenderer.invoke('codev:outlier-request', req),
    // Live view of those browsers: watch/unwatch/control, and the stream of frames and events.
    browserLive: req => ipcRenderer.invoke('codev:browser-live', req),
    onBrowserLive: callback => {
        const listener = (_event, update) => callback(update);
        ipcRenderer.on('codev:browser-live-event', listener);
        return () => ipcRenderer.removeListener('codev:browser-live-event', listener);
    }
});
