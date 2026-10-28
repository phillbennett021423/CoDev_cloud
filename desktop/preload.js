// Gives the page a native web fetch, shaped like the Android app's CapacitorHttp.get,
// so CoDev's DuckDuckGo search works without the Python helper, and Azure
// Speech for the natural Ava voice.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codevDesktop', {
    http: {
        get: ({ url, headers }) => ipcRenderer.invoke('codev:http-get', { url, headers })
    },
    azureTts: ({ region, key, ssml }) => ipcRenderer.invoke('codev:azure-tts', { region, key, ssml }),
    // Writes the page's saved chats and run checkpoints to disk now, so a crash right after loses nothing.
    flushStorage: () => ipcRenderer.send('codev:flush-storage'),
    // Gives keyboard focus back to the page after a native alert or confirm.
    refocus: () => ipcRenderer.send('codev:refocus'),
    // The Google account for the YouTube, Maps, Gmail and Drive tools: { op, ... } (see google-connect.js).
    google: req => ipcRenderer.invoke('codev:google', req),
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
