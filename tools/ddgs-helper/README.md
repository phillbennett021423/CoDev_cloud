# CoDev search helper (desktop browsers)

CoDev grounds technical answers in live DuckDuckGo results. It's free: no API key or subscription.

- **Android app:** works out of the box. The app calls DuckDuckGo directly through the phone.
- **Desktop browser:** browsers don't let a web page call DuckDuckGo directly, so run this small helper. It uses the free [`ddgs`](https://pypi.org/project/ddgs/) library and only listens on your own computer (127.0.0.1).

```
cd tools/ddgs-helper
pip install -r requirements.txt
python ddgs_helper.py
```

Keep it running while you use CoDev. To use another port, run `python ddgs_helper.py --port 9000` and change the address under Settings → 🔎 Web grounding.

Quick check: open http://127.0.0.1:8787/search?q=godot+move_and_slide in a browser.

DuckDuckGo rate-limits heavy use. If searches start failing, wait a minute. CoDev caches each query for 10 minutes to stay under the limit.

## Local tools for agents (MCP)

CoDev's agents call tools on their own while they answer: `web_search` (DuckDuckGo), `list_workspace_files`, `read_workspace_file` and `write_workspace_file` (the project folder you loaded in CoDev). Turn this off under Settings → 🔎 Web grounding & local tools.

On desktop, the helper is also a Model Context Protocol (MCP) server at `http://127.0.0.1:8787/mcp` (Streamable HTTP, JSON-RPC). CoDev connects to it automatically and hands its tools to the agents:

| Tool | Available |
| --- | --- |
| `list_files`, `read_file` | always, inside the project folder |
| `run_approved_command` | when `allowed_commands.json` lists commands |
| `write_file`, `edit_file`, `run_command` (any shell command) | only with `--autonomous` |

Start it on your project with autonomous editing and code execution:

```
python ddgs_helper.py --project ~/my-game --autonomous
```

On Windows you can pass the folder to the launcher instead: `start-codev.bat C:\path\to\my-game`.

With **Settings → Run file edits and commands without asking me first** on (the default), agents write files and run commands with no confirm dialog. Turn it off to approve each change. File paths can't leave the project folder, commands run in it and stop after 120 seconds by default (10 minutes at most), and the helper only listens on 127.0.0.1. Only CoDev served from localhost or the desktop app can use `/mcp` from a browser; other websites are refused. Other MCP clients on your computer can use the same address. To use a different MCP server, change **MCP server** in Settings (leave it empty to turn MCP off).

`allowed_commands.json` still works: copy `allowed_commands.example.json`, keep the commands you want, and agents can run them by name. Each one is a fixed `argv` list run without a shell, stops after 60 seconds, and returns up to 8,000 characters of output.

Serve CoDev from localhost rather than opening the file directly, for example `npm start` and open http://localhost:3000. The helper refuses to edit or run anything for pages opened from disk, because sandboxed pages on any website look the same to it.

The Android app has search and project files but can't reach the helper, so it can't run commands.
