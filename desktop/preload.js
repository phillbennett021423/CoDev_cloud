// Gives the page a native web fetch, shaped like the Android app's CapacitorHttp.get,
// so CoDev's DuckDuckGo search works without the Python helper, and Azure
// Speech for the natural Ava voice.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codevDesktop', {
    http: {
        get: ({ url, headers }) => ipcRenderer.invoke('codev:http-get', { url, headers })
    },
    azureTts: ({ region, key, ssml }) => ipcRenderer.invoke('codev:azure-tts', { region, key, ssml }),
    // Gives keyboard focus back to the page after a native alert or confirm.
    refocus: () => ipcRenderer.send('codev:refocus'),
    // Built-in MCP tools for the chosen project folder.
    mcp: message => ipcRenderer.invoke('codev:mcp', message),
    mcpFolder: () => ipcRenderer.invoke('codev:mcp-folder'),
    pickMcpFolder: () => ipcRenderer.invoke('codev:mcp-pick-folder'),
    // External MCP servers (stdio and remote), run by the main process's MCP hub.
    mcpHub: req => ipcRenderer.invoke('codev:mcp-hub', req),
    // Agents' headless browsers and the saved web logins (JSON-RPC, like mcp).
    browserMcp: message => ipcRenderer.invoke('codev:browser-mcp', message),
    // Live view of those browsers: watch/unwatch/control, and the stream of frames and events.
    browserLive: req => ipcRenderer.invoke('codev:browser-live', req),
    onBrowserLive: callback => {
        const listener = (_event, update) => callback(update);
        ipcRenderer.on('codev:browser-live-event', listener);
        return () => ipcRenderer.removeListener('codev:browser-live-event', listener);
    }
});
