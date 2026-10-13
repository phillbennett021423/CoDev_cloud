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

## Local tools for agents

CoDev's agents call tools on their own while they answer: `web_search` (DuckDuckGo), `list_workspace_files` and `read_workspace_file` (the project folder you loaded in CoDev). Turn this off under Settings → 🔎 Web grounding & local tools.

On desktop, the helper can also run a short list of commands you approve, such as your tests or a lint. Agents see them as a `run_local_command` tool, and CoDev asks you before every run.

1. Copy `allowed_commands.example.json` to `allowed_commands.json` and keep only the commands you want. Each one is a fixed `argv` list; agents choose a command by name and can't change its arguments. Commands run without a shell, stop after 60 seconds, and return up to 8,000 characters of output.
2. Start the helper in your project: `python ddgs_helper.py --project ~/my-game`.
3. Serve CoDev from localhost rather than opening the file directly, for example `cd mobile/www && python -m http.server 8000` and open http://localhost:8000. The helper refuses to run commands for pages opened from disk, because sandboxed pages on any website look the same to it.

With no `allowed_commands.json`, the helper only searches. The Android app has search and project files but can't run commands.
