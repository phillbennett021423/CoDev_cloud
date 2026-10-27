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
| `ODDS_API_KEY` | free-tier market odds in the Outlier tab (the-odds-api.com) |
| `CODEV_WORKSPACE` | the project folder agents work in; `start-codev.bat C:\path\to\project` sets it too |
| `CODEV_DATA_DIR` | where `.codev` goes |
| `CODEV_VAULT_KEY` | passphrase for the browser tools' saved logins |
| `PORT` | default 3000; `0` picks a free port |

`server.js` loads the agent services through `agent-services.js`: the sandbox containers and diff review (`desktop/sandbox`) and the headless browser (`agents/browser`). A service that isn't installed is skipped. The page reaches their tools at `POST /agent-tools` (MCP JSON-RPC: `initialize`, `tools/list`, `tools/call`), the review gate under `/agent/`, and what's on at `GET /agent/status`. All of these answer CoDev's own page only. Ctrl+C removes the agents' containers and browser profiles.

## Outlier slips

The **📈 Outlier** tab (when CoDev runs on your computer with `npm start` or `start-codev.bat`) reads your signed-in Outlier pages, scores the props and recommends 4-leg power and flex entries (6-leg optional), weighing same-game correlation, with a fractional-Kelly stake for each and closing line value tracked for the entries you play:

1. **Sign in to Outlier** opens a browser window. Sign in there once and close it. That sign-in is kept in a browser profile used only by this pipeline, in your app-data folder (`codev-server/outlier/profile`), never in the repo, so it carries over between runs. **Forget Outlier sign-in** deletes it.
2. **Scrape & analyze** opens the pages listed under **Pages and sign-in** in a hidden browser, reads the prop cards and odds tables into JSON (`agents/outlier/extract.js`), and runs `tools/outlier-analytics/analyze.py` on them (needs Python 3; set `CODEV_PYTHON` if it isn't on the PATH). **Auto** repeats it every few minutes while the tab is open.
3. With a free `ODDS_API_KEY` (the-odds-api.com), ESPN's public scoreboard and any public odds-comparison pages you list, each scrape cross-references every prop against the other books: no-vig fair price (sharp books first), each book's juice, best price (`tools/outlier-analytics/market_data.py`, stored in `market.db`).
4. **I played this** tracks an entry; mark its legs hit/miss when they settle and the filters retune themselves (see `tools/outlier-analytics/README.md`).
5. **Strategy: Consistency (-119)** looks for props near -119 whose players hit 60–75% with a steady 3/4/5-game baseline and a minutes floor, reads matchup, usage, pace and potential-volume stats off the page, and builds 4–6 leg parlay tickets with their combined odds. These are estimates; no filter guarantees a win.
6. On top of either strategy, the analysis also:
   - flags **orphaned lines**, where a soft book is still near -119 after the sharp books (Pinnacle and the like) moved to -130 or past;
   - keeps legs that work against each other off the same ticket;
   - shares a ruled-out starter's usage out to his teammates' props (from the page's injury notes or a list you type in);
   - drops players whose minutes fell 10% or more over the last two games, or who face one of the stingiest defenses.
7. **⏺ Passive capture** collects props while you scroll Outlier yourself in the live view. A MutationObserver in the page notes each prop card as it appears, including cards a long board removes once they scroll away. Every few seconds CoDev parses them into a scratchpad and the latest read, and re-scores at most every 15 seconds. It never scrolls, clicks or moves your view.
8. The **Under value engine** looks at the props the strategy didn't keep from the under side. A prop is tagged an **Under Value Leg** when at least two under signals line up and the under price still leaves a 2-point edge. The signals are a slow game, a lockdown defense, a teammate's usage coming back, and an inflated public over. A prop is routed to the core picks or the under list, never both, and under legs stay off the over tickets.
9. **Board files in your project folder.** Every analysis writes the whole board to `downloads/new folder/outlier_live_board_dump.json`: props, injuries, each leg's metrics and route, tickets and under legs. A board JSON you save into `downloads/new folder` is read in and audited automatically. It can be a list of props, `{ "props": [...] }`, or CoDev's own dump. Agents do the same with the `outlier_import_board` tool. Both paths are set under **Pages and sign-in**, and an empty field turns that one off.
10. **Ask an agent to scan Outlier.** For a prompt like "go to Outlier and build me a ticket", agents use the `outlier_scan_board` tool. It runs the scan in your signed-in Outlier browser (in a background tab if you're using it) and returns the tickets and under legs. The agent never gets that browser or its cookies, and it can only open app.outlier.bet pages. The scan reads the board after every scroll step, including boards that scroll inside a panel and remove rows as they go, and stops at the end of the board (up to 40 steps). Typed on its own, "outlier" or "outlier.com" opens app.outlier.bet.

    It also moves around Outlier for you. Ask "NBA props for the 8pm game" (or "the 3 o'clock game", "Lakers tonight", "Points for the Celtics game") and the agent passes the sport, game and stat to the tool. The scan clicks Outlier's sport tab, any stat filter and the game card with that start time or those teams, reads that game's board and builds tickets from that game's props only. Times are your computer's local time, as Outlier shows them. If it can't find the game, it lists the games it saw so the agent can ask you which one. It only clicks tabs, filters and game cards, never a pick or an entry button, and it never enters anything on Outlier, Underdog or Dabble: the ticket comes back as the agent's reply in chat.

The parser doesn't depend on Outlier's markup, but if it misses props, **Save page snapshot** stores the page (HTML and the data it loaded) in the same folder so selectors can be added to `config.json` there. Agents can read the latest entries with the read-only `outlier_slips` tool. Automated reading may be against Outlier's terms; that's your call. The numbers are estimates, not guarantees.

## Agents start blank

Every agent, the three built in (Architect, Swarm, Self-Healing) and any you add, starts with empty memory, no shared-memory links and generic instructions: it takes its domain (code, data, research, betting analytics…) from your task, not from a project built into CoDev. New agents get the **General** role, which adapts to any task; the developer roles below are for work on a connected project. Engine-specific rules (Godot) are only added when the task is about that engine. When you switch to an unrelated task, **🧹 New task (clear context)** in the menu empties every agent's memory and shared-memory links, opens an empty chat and can unload the project files, so nothing from the old task carries over; **Clear** next to an agent's memory empties just that one.

## Reading screenshots (Dabble slips and more)

Click **📸** next to the chat box and pick the folder you save screenshots in (on a phone, pick the screenshots themselves). Then ask in plain words: "look at my screenshots and research these props", or "read the newest 3 screenshots". The agent's `read_screenshots` tool sends the images, newest first, to the vision model, which writes down every leg on a slip (player, stat, line, Over/Under, sport, game) or the text of any other image. Prop legs go straight on to `outlier_research_list`, the same research a typed list gets. It reads every screenshot in the folder (up to 100), counts a leg that shows up on several screenshots once, and remembers what it already read, so when you swap screenshots in and out only the new ones go to the vision model. CoDev remembers the folder after a restart; the first time you ask after one, the browser asks you to allow it again. A Google Drive for Desktop folder (like `G:\My Drive\...`) works, online-only files included: they download as they're read, and a slow one is tried again. A folder inside your project works too ("read the screenshots in the Dabble folder"), and so do screenshots attached with 📎: the vision model reads them first so the agent can still use its tools.

## Every request is sorted first

CoDev is a multi-purpose agent. Before an agent runs, CoDev sorts the request: **code or project files**, **sports props**, **screenshots or images**, or **a general question**. A short follow-up ("now fix it") keeps the type of the message before it. Only code and file tasks get the project's files put in the prompt and the developer rules below; for anything else the Architect and Swarm agents answer like the General agent and leave the project folder alone unless you ask about a file. The Console shows how each request was sorted.

## Autonomous developer workspace

Every code or file task is treated as a task on your project. You don't type file paths or paste code:

- **Workspace auto-injection.** Each agent request carries the project's file tree, the file open in the editor, the files agents just changed and the files that best match the task. The amount is capped per provider (about 14k characters on Groq, whose free tier has small per-minute token limits, 30k on OpenRouter, 80k on Anthropic); agents read anything else with their tools.
- **Autonomous execution.** Agents search the project, edit files and, where a command tool exists, run the code, tests or build themselves. Tools are always on.
- **Locked developer roles.** Each agent has a role (Agent Configuration → Developer Role): **Architect** plans and implements, **Swarm** builds on the team's changes, **Self-Healing** re-reads changed files, runs what can be run and fixes failures. A role's prompt always applies; an agent's own instructions only add to it. In Group Swarm the agents run Architect → Swarm → Self-Healing, each seeing what the others changed. With 🛡️ Self-Healing on, a solo or background task that changed files gets a verify-and-fix pass afterwards.

**Files with keys stay hidden.** Agents can't list, search, read or write hidden files and folders (`.env`, `.git`, anything whose name starts with a dot), env files like `production.env`, key and certificate files (`.pem`, `.key`, `.pfx`, `.p12`, `.keystore`, `.jks`) or `secrets.*` and `credentials.*`, whichever folder tools they use: the sandbox, the Windows app's, the Python helper's or the page's own. Commands an agent runs directly on your computer (outside the sandbox) aren't filtered, so leave those off if that matters to you.

**Run file edits and commands without asking me first** (Settings) is on by default, so agents save files and run commands with no confirm dialog. Turn it off to approve each change.

| Where CoDev runs | Project the agents see | Edits | Run code |
| --- | --- | --- | --- |
| Windows app | project folder chosen in Settings | saved to disk | yes |
| Browser via `start-codev.bat C:\path\to\project` | that folder, through the helper (read and search) and the agent sandbox | staged for your diff review; with `CODEV_HELPER_AUTONOMOUS=1` the helper also saves them directly | in the sandbox with Docker; directly with `CODEV_HELPER_AUTONOMOUS=1` |
| Desktop Chrome/Edge via `npm start` | 📁 Connect Local Folder (sub-folders included) | saved to disk | only with the helper |
| Android app | files picked in Project Files | kept in CoDev; Save copies them | no |

## Agent sandboxes and change review

On a computer (the Windows app, or `server.js`), agents can work in a sandbox instead of on the project folder itself. The code is in `desktop/sandbox/`.

- **Staging copy.** Each sandbox is a copy of the project (without `.git`, `node_modules`, `build`, `dist` and the like) in a temporary folder. Agents' `write_file`, `edit_file` and `delete_file` change only that copy. A project too big to copy (over 5,000 files or 200 MB) is staged file by file instead: agents read the real project, and a file is copied into the sandbox the first time they change it. Commands don't run on such a project, since a container would see only the changed files. Hidden files and folders (`.env`, `.git` and anything else whose name starts with a dot), env files like `production.env`, key and certificate files (`.pem`, `.key`, `.pfx`, `.p12`, `.keystore`, `.jks`) and `secrets.*` / `credentials.*` are never copied, and agents can't list, read or write them, so API keys stay out of their reach.
- **A container per agent.** `run_command` runs inside the agent's own Docker container, which sees only the staging copy, mounted at `/workspace`. Containers have no network (unless allowed), no Linux capabilities, a read-only system, 2 GB of memory, 2 CPUs and at most 256 processes. They're removed when the review is done, after 15 idle minutes, and when CoDev closes. The default image is `node:22-bookworm-slim`; set `CODEV_SANDBOX_IMAGE` (for example `python:3.12-slim`) or `CODEV_SANDBOX_NETWORK=bridge` to change that.
- **Review before anything reaches the disk.** CoDev shows the changes as a git diff, file by file, with a syntax check for each: JSON is parsed, JavaScript goes through `node --check`, the inline scripts of HTML pages too, and Python through `ast.parse`. Nothing is executed for the check. You approve or reject files; a file whose check failed can't be approved. A file is also held back if it changed in the sandbox after you reviewed it, or if you changed it on disk since the agent started.

Without Docker, the staging copy and the review still work, but agents can't run commands in the sandbox; the status says whether Docker is missing or just not running. The Android app and the web version have no sandbox, since a phone or a browser tab can't run Docker.

Tests: `node --test desktop/sandbox/test/sandbox.test.js` (the container tests run when Docker is running).

## Agents' web browser

On the Windows app and `npm start`, agents get a headless Chromium of their own (Playwright): `browser_navigate`, `browser_click`, `browser_fill`, `browser_press_key`, `browser_get_text` (rendered text, accessibility tree or HTML), `browser_wait_for`, `browser_screenshot` and `browser_close`. Each agent has a separate browser profile (cache, cookies, local storage), kept in your app-data folder (`codev-server/browser-profiles/<agent>`, or the Windows app's own data folder), never in the repo. A site you sign in to in an agent's browser, from the live view or through the agent, stays signed in next time, even after a restart. Agents never see each other's sign-ins. **🧹 Forget sign-ins** in the live view deletes the shown agent's profile. Set `CODEV_BROWSER_KEEP_SIGNINS=0` in `.env` to go back to temporary profiles that are deleted when the browser closes. An agent's browser that nobody has used or watched closes after 15 idle minutes, but its profile stays. A browser you've opened, driven or been handed in the live view is yours: it stays open whether or not an agent is using it, isn't closed to make room for another agent's, and an agent's `browser_close` leaves it open. **⏻ Close browser** in the live view closes it. They can test your local dev server (`http://localhost:5173` and so on) but can't open CoDev's own server or helper.

The browser is Playwright's Chromium (`npx playwright install chromium`, which `npm run setup` does), or else the Edge or Chrome already installed. Set `CODEV_BROWSER_PATH` to use a specific one.

**Saved logins.** Add them under **Settings → Agents' web browser & saved logins**. They are encrypted on your computer, never in the repo or the page's storage: with Windows' data protection (DPAPI) in the Windows app's data folder, or for `server.js` in `%APPDATA%\codev-server` (`~/.config/codev-server` elsewhere) with `CODEV_VAULT_KEY` as the passphrase if you set it, otherwise DPAPI on Windows or a key file only your user can read. Agents see only names, sites and user names. `browser_login` types the password into the login's own site itself, `browser_save_session` keeps a signed-in site's cookies, and `browser_load_session` puts them back in a later task. CoDev asks you every time any of these three is used, even with *Run file edits and commands without asking me first* on.

**Live view.** Press **🖥️ Live view** in the header to watch an agent's browser as it works. Click, scroll or type in it to take over (on a phone, tap to click and drag to scroll): you keep control until you press **Hand back**. Meanwhile the agent isn't blocked: its reading tools read your page, and anything it does (navigating, clicking, typing) happens in a background tab of the same browser, with the same sign-ins, that starts on your page. Your tab is never touched, and handing back shows the agent's tab. The address bar and back/forward/reload buttons work while you drive. The same live picture also shows in the card of the agent that's using the browser, in the agents list: click and type on it there to take over, ✋/↩️ to take over or hand back, and ⤢ to open the full view. A side panel shows the page's console messages and errors, its network requests (address and status only, no headers or bodies) and a summary of its DOM changes. The picture is Chromium's own screencast over the DevTools protocol, so it needs no VNC, X server or Docker: the browsers run on your computer.

**Browsing yourself.** Pick any agent in the live view's list, even one whose browser isn't open, and type in the address bar: a full address, a bare domain (`espn.com`), a shortcut (`outlier`, `espn`) or words to search for (DuckDuckGo). That opens the browser with you in control, so you can search, sign in or set up a page before the agent starts. A page that doesn't load, returns 404, or turns out to be a parked "this domain is for sale" page (GoDaddy, Sedo, Afternic…) opens with a warning instead of passing as the real site. When an agent's `browser_navigate` or an Outlier scrape lands on one (or Outlier redirects to its sign-in page), the browser isn't closed: it stays open on that page, paused and handed to you in the live view (which opens on it), and the agent is told to wait; it can't close a paused browser, and idle browsers that are paused aren't closed either. Fix the address or sign in, then press **Hand back**. Addresses on outlierbet.com (and similar look-alikes) always go to Outlier's real sign-in portal, https://app.outlier.bet/login. On CoDev's server the list also has **📈 Outlier (signed in)**: the Outlier pipeline's own browser with your saved sign-in. Browse it yourself (or press **🖥️ Browse** in the Outlier view, which opens it at Outlier's sign-in portal, https://app.outlier.bet/login), then **📄 Read this page** adds the props on the open page to the analysis without taking the browser from you; **Scrape & analyze** reads your configured pages in a background tab while you browse. Agents can run the same extraction on their own browser with `outlier_extract_page`, never on the signed-in one.

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
- `tests/secret-files.test.js`: the Windows app's and the Python helper's folder tools never show agents `.env` or other files that can hold keys (the helper part needs Python).
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
