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

## Setup and agent services

`npm run setup` (which `start-codev.bat` runs every time; it skips what's already done) gets a computer ready:

1. checks Node.js and installs the npm packages,
2. creates `.env` from `.env.example` if there is none and checks the keys in it (it only says whether each is set and well-formed, never the value),
3. checks that the Docker engine is running, for agent sandboxes,
4. downloads Chromium for the browser tools (`npx playwright install chromium`, using the Playwright version in `node_modules`),
5. creates the `.codev` data folder for sandboxes, staged changes and browser profiles (gitignored).

Missing Docker or keys are only warnings: CoDev runs without them, with those features off. Setup fails only for an old Node.js, a failed `npm install`, a malformed key or a bad `PORT`. `npm run check` reports without installing anything; `npm run setup -- --skip-browsers` skips the Chromium download.

Settings are read by `config.js` from the environment or `.env`:

| Variable | What for |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic relay (`sk-ant-...`) |
| `OPENROUTER_API_KEY` | OpenRouter (`sk-or-...`) |
| `MANUS_API_KEY` | Q tasks |
| `CODEV_WORKSPACE` | the project folder agents work in; `start-codev.bat C:\path\to\project` sets it too |
| `CODEV_DATA_DIR` | where `.codev` goes |
| `CODEV_VAULT_KEY` | passphrase for the browser tools' saved logins |
| `PORT` | default 3000; `0` picks a free port |

`server.js` loads the agent services through `agent-services.js`: the sandbox containers and diff review (`desktop/sandbox`) and the headless browser (`agents/browser`). A service that isn't installed is skipped. The page reaches their tools at `POST /agent-tools` (MCP JSON-RPC: `initialize`, `tools/list`, `tools/call`), the review gate under `/agent/`, and what's on at `GET /agent/status`. All of these answer CoDev's own page only. Ctrl+C removes the agents' containers and browser profiles.

## Autonomous developer workspace

Every message is treated as a task on your project. You don't type file paths or paste code:

- **Workspace auto-injection.** Each agent request carries the project's file tree, the file open in the editor, the files agents just changed and the files that best match the task. The amount is capped per provider (about 14k characters on Groq, whose free tier has small per-minute token limits, 30k on OpenRouter, 80k on Anthropic); agents read anything else with their tools.
- **Autonomous execution.** Agents search the project, edit files and, where a command tool exists, run the code, tests or build themselves. Tools are always on.
- **Locked developer roles.** Each agent has a role (Agent Configuration → Developer Role): **Architect** plans and implements, **Swarm** builds on the team's changes, **Self-Healing** re-reads changed files, runs what can be run and fixes failures. A role's prompt always applies; an agent's own instructions only add to it. In Group Swarm the agents run Architect → Swarm → Self-Healing, each seeing what the others changed. With 🛡️ Self-Healing on, a solo or background task that changed files gets a verify-and-fix pass afterwards.

**Run file edits and commands without asking me first** (Settings) is on by default, so agents save files and run commands with no confirm dialog. Turn it off to approve each change.

| Where CoDev runs | Project the agents see | Edits | Run code |
| --- | --- | --- | --- |
| Windows app | project folder chosen in Settings | saved to disk | yes |
| Browser via `start-codev.bat C:\path\to\project` | that folder, through the helper | saved to disk | yes |
| Desktop Chrome/Edge via `npm start` | 📁 Connect Local Folder (sub-folders included) | saved to disk | only with the helper |
| Android app | files picked in Project Files | kept in CoDev; Save copies them | no |

## Agent sandboxes and change review

On a computer (the Windows app, or `server.js`), agents can work in a sandbox instead of on the project folder itself. The code is in `desktop/sandbox/`.

- **Staging copy.** Each sandbox is a copy of the project (without `.git`, `node_modules`, `build`, `dist` and the like) in a temporary folder. Agents' `write_file`, `edit_file` and `delete_file` change only that copy.
- **A container per agent.** `run_command` runs inside the agent's own Docker container, which sees only the staging copy, mounted at `/workspace`. Containers have no network (unless allowed), no Linux capabilities, a read-only system, 2 GB of memory, 2 CPUs and at most 256 processes. They're removed when the review is done, after 15 idle minutes, and when CoDev closes. The default image is `node:22-bookworm-slim`; set `CODEV_SANDBOX_IMAGE` (for example `python:3.12-slim`) or `CODEV_SANDBOX_NETWORK=bridge` to change that.
- **Review before anything reaches the disk.** CoDev shows the changes as a git diff, file by file, with a syntax check for each: JSON is parsed, JavaScript goes through `node --check`, the inline scripts of HTML pages too, and Python through `ast.parse`. Nothing is executed for the check. You approve or reject files; a file whose check failed can't be approved. A file is also held back if it changed in the sandbox after you reviewed it, or if you changed it on disk since the agent started.

Without Docker, the staging copy and the review still work, but agents can't run commands in the sandbox; the status says whether Docker is missing or just not running. The Android app and the web version have no sandbox, since a phone or a browser tab can't run Docker.

Tests: `node --test desktop/sandbox/test/sandbox.test.js` (the container tests run when Docker is running).

## Agents' web browser

On the Windows app and `npm start`, agents get a headless Chromium of their own (Playwright): `browser_navigate`, `browser_click`, `browser_fill`, `browser_press_key`, `browser_get_text` (rendered text, accessibility tree or HTML), `browser_wait_for`, `browser_screenshot` and `browser_close`. Each agent has a separate temporary profile (cache, cookies, storage) that is deleted when its browser closes or after 15 idle minutes. They can test your local dev server (`http://localhost:5173` and so on) but can't open CoDev's own server or helper.

The browser is Playwright's Chromium (`npx playwright install chromium`, which `npm run setup` does), or else the Edge or Chrome already installed. Set `CODEV_BROWSER_PATH` to use a specific one.

**Saved logins.** Add them under **Settings → Agents' web browser & saved logins**. They are encrypted on your computer, never in the repo or the page's storage: with Windows' data protection (DPAPI) in the Windows app's data folder, or for `server.js` in `%APPDATA%\codev-server` (`~/.config/codev-server` elsewhere) with `CODEV_VAULT_KEY` as the passphrase if you set it, otherwise DPAPI on Windows or a key file only your user can read. Agents see only names, sites and user names. `browser_login` types the password into the login's own site itself, `browser_save_session` keeps a signed-in site's cookies, and `browser_load_session` puts them back in a later task. CoDev asks you every time any of these three is used, even with *Run file edits and commands without asking me first* on.

The Android app and the web version have no browser tools: a phone or a browser tab can't start Chromium.

## Sandbox and change review

When CoDev runs from `npm start` (or the Windows app) with a project folder, the chat's **🧪 Sandbox & Review Changes** mode is available and on by default. Each agent then works on a staging copy of the project, in its own Docker container when Docker is running, and nothing reaches your files until you approve it:

- After a task, a review screen lists every changed file with its diff and syntax check. Files that fail the check can't be approved; untick any file you don't want.
- **Approve & save** writes the ticked files, **Reject all** throws the changes away, and **Keep for later** leaves them waiting under **📝 Review changes** in the header.
- Without Docker, agents still edit the staging copy, but can't run code. On Android and on the web the mode is greyed out and agents edit as before.

The page code is `mobile/www/agent-ui/` (`agent-client.js` talks to the `/agent/*` routes and `/agent-tools`, `diff-review.js` is the review screen).

## Testing the agent setup

`npm run test:agents` runs the agent tests:

- `tests/agent-client.test.js`: the diff parser, review model and API client (no setup needed).
- `tests/agent-ui.test.js`: the page's sandbox mode and review screen in headless Chromium, against a stand-in server (needs Playwright and Chromium, Chrome or Edge).
- `tests/agent-integration.test.js`: starts the real `server.js` with a throwaway project, sends a sample coding prompt through the page, checks the diff gate (bad files blocked, nothing written before approval, nothing written on reject), runs commands in an ephemeral Docker container and checks it's removed afterwards, then runs a headless browser task against the page the agent saved.

Each test that needs Docker, Chromium or a server feature that isn't there is skipped with the reason, so the suite also passes on a computer without them. On Windows, start Docker Desktop and run `npm run setup` first to test everything. The model is scripted in these tests, so no API key is needed.

## Anthropic API key

`server.js` reads the key only from the `ANTHROPIC_API_KEY` environment variable at startup; never paste it into the code. Either:

- copy `.env.example` to `.env` next to `server.js` and put your key in it (`.env` is gitignored), or
- set it on Windows with `setx ANTHROPIC_API_KEY "sk-ant-..."` in a Command Prompt, then open a new window before running `start-codev.bat`.

If the key is missing, the server starts with a note saying so; if it's set but doesn't look like an Anthropic key, the server stops and tells you.

## Using Anthropic (Claude) as the AI provider

In Settings, pick **Anthropic** under *AI provider*. The app uses `claude-haiku-5-5`.

- On Android, the Windows app or any browser, paste your Anthropic key (it starts with `sk-ant-`) into the **Anthropic API Key** field. It is stored on that device only and sent straight to api.anthropic.com.
- When you run `npm start` and `ANTHROPIC_API_KEY` is set, you can leave that field empty: the page sends its requests to `server.js`, which adds the key and passes them on, so the key never reaches the browser.

Voice input still uses Groq Whisper, so add a Groq key too if you want the mic button.

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
