// Gives the page a native web fetch, shaped like the Android app's CapacitorHttp.get,
// so CoDev's DuckDuckGo search works without the Python helper.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codevDesktop', {
    http: {
        get: ({ url, headers }) => ipcRenderer.invoke('codev:http-get', { url, headers })
    }
});
