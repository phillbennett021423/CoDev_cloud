// Gives the page a native web fetch, shaped like the Android app's CapacitorHttp.get,
// so CoDev's DuckDuckGo search works without the Python helper, and Azure
// Speech for the natural Ava voice.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codevDesktop', {
    http: {
        get: ({ url, headers }) => ipcRenderer.invoke('codev:http-get', { url, headers })
    },
    azureTts: ({ region, key, ssml }) => ipcRenderer.invoke('codev:azure-tts', { region, key, ssml })
});
