# CoDev Studio

The app is a single page, `mobile/www/index.html`. It talks to Groq directly from the browser, so there's no backend server to run. The Android app is in `mobile/` (see `mobile/README.md`).

## Windows desktop app

Download and run the installer: https://github.com/phillbennett021423/CoDev_cloud/releases/latest/download/CoDev-Studio-Setup.exe
It adds CoDev Studio to the Start menu and the desktop. Web search works in it without the Python helper. Windows may warn that the app is from an unknown publisher because it isn't code-signed; choose **More info → Run anyway**.

The app's code is in `desktop/` (Electron). To run it from source: `cd desktop && npm install && npm start`.

## Run it in a browser on your computer

**Windows:** double-click `start-codev.bat`. It opens http://localhost:3000 and, if Python is installed, starts the free search helper too.

**Any system:** `npm start`, then open http://localhost:3000. For web search on desktop, also run `python tools/ddgs-helper/ddgs_helper.py` (see `tools/ddgs-helper/README.md`).

`server.js` serves the page on your own computer. It needs Node.js; `npm install` (which `start-codev.bat` runs for you) adds the MCP SDK so the page can use MCP servers on this computer.

## "System Error: Failed to fetch"

This means the request never reached Groq (api.groq.com). Check that the computer is online, and that a firewall, antivirus web shield, VPN, proxy or ad blocker isn't blocking api.groq.com. A wrong API key shows a different error from Groq itself.

## MCP servers

CoDev connects to external MCP servers with the official SDK (`@modelcontextprotocol/sdk`). Add them under **Settings → Web grounding & local tools → MCP servers**, in the same `mcpServers` JSON most MCP servers document:

```json
{ "mcpServers": {
    "files":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\code"] },
    "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ..." } } } }
```

Then press **Save & connect**. Each server's tools reach the agents as `<server>__<tool>`, and its resources through `mcp_list_resources` / `mcp_read_resource`.

| Where CoDev runs | `command` (stdio) servers | `url` servers |
| --- | --- | --- |
| Windows app | yes, started by the app | yes |
| Browser via `start-codev.bat` / `npm start` | yes, started by `server.js` | yes |
| Android app | no: a phone can't start them | yes (Streamable HTTP; no CORS needed) |
| Browser from anywhere else | no | yes, if the server allows the page's origin (CORS) |

A `url` server is tried with Streamable HTTP first, then the older HTTP+SSE; set `"type": "http"` or `"sse"` to pick one. To use a stdio server from the phone, run it on a computer behind an HTTP MCP server or proxy and give the phone its `url`.

The shared client code is `mobile/www/mcp/mcp-hub-core.js`; `desktop/mcp-hub.js` adds stdio for the Windows app and `server.js`, and the page loads a browser build of the SDK from `mobile/www/vendor/mcp` (rebuild it with `cd mobile && npm run build:mcp-sdk`).
