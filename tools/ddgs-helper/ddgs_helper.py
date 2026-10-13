"""Local helper for CoDev Studio: free DuckDuckGo search and approved local commands.

Browsers block web pages from calling DuckDuckGo directly (CORS), so when
CoDev runs in a desktop browser it asks this helper instead. The helper uses
the free `ddgs` library (formerly `duckduckgo_search`): no API key, no
account, nothing paid.

It can also run a short list of commands you approve in allowed_commands.json
(copy allowed_commands.example.json to start). CoDev's agents can ask to run
them, and CoDev asks you to confirm every run. Nothing else can be run.

    pip install -r requirements.txt
    python ddgs_helper.py --project ~/my-game   # listens on http://127.0.0.1:8787

GET  /search?q=<query>&max=<1-10>  ->  {"results": [{"title", "href", "body"}]}
GET  /commands                     ->  {"commands": [{"name", "description", "argv", "cwd"}]}
POST /run {"name": "<command>"}    ->  {"exit_code", "stdout", "stderr", "timed_out"}
GET  /health                       ->  {"ok": true}

The Android app doesn't need this; it searches DuckDuckGo natively.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:
    from ddgs import DDGS
except ImportError:
    try:  # older installs still have the library under its previous name
        from duckduckgo_search import DDGS
    except ImportError:  # pragma: no cover - message for people running it the first time
        sys.exit("The ddgs library is missing. Run: pip install -r requirements.txt")

MAX_RESULTS = 10
MAX_QUERY_CHARS = 300
MAX_OUTPUT_CHARS = 8000
COMMAND_TIMEOUT_SECONDS = 60

# Only CoDev itself may call the helper: pages opened from disk send "null",
# the Android app uses https://localhost, and dev servers use localhost/127.0.0.1.
ALLOWED_ORIGIN = re.compile(r"^(null|https?://(localhost|127\.0\.0\.1)(:\d+)?|capacitor://localhost|app://codev)$")
# Running commands is stricter: sandboxed pages on any website also send "null",
# so /run needs CoDev served from localhost or the desktop app (see README).
RUN_ORIGIN = re.compile(r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|app://codev)$")
ALLOWED_HOST = re.compile(r"^(localhost|127\.0\.0\.1)(:\d+)?$")

COMMANDS = {}
PROJECT_DIR = os.getcwd()


def search(query, max_results):
    with DDGS() as ddgs:
        rows = ddgs.text(query, max_results=max_results, backend="duckduckgo")
    return [{"title": r.get("title", ""), "href": r.get("href", ""), "body": r.get("body", "")} for r in rows]


def load_commands(path, project_dir):
    """Reads {"name": {"argv": [...], "description": "...", "cwd": "..."}} and validates it."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    commands = {}
    for name, spec in raw.items():
        argv = spec.get("argv")
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,40}", name) or not isinstance(argv, list) or not argv \
                or not all(isinstance(a, str) for a in argv):
            sys.exit(f"allowed_commands.json: '{name}' needs a simple name and an \"argv\" list of strings")
        cwd = os.path.abspath(os.path.join(project_dir, os.path.expanduser(spec.get("cwd", "."))))
        commands[name] = {"argv": argv, "description": str(spec.get("description", "")), "cwd": cwd}
    return commands


def run_command(name):
    spec = COMMANDS[name]
    # Fixed argv, no shell: the agent picks a name, never the command text.
    try:
        done = subprocess.run(spec["argv"], cwd=spec["cwd"], capture_output=True, text=True,
                              timeout=COMMAND_TIMEOUT_SECONDS, shell=False)
        return {"exit_code": done.returncode, "stdout": done.stdout[-MAX_OUTPUT_CHARS:],
                "stderr": done.stderr[-MAX_OUTPUT_CHARS:], "timed_out": False}
    except subprocess.TimeoutExpired as err:
        out = err.stdout.decode(errors="replace") if isinstance(err.stdout, bytes) else (err.stdout or "")
        return {"exit_code": None, "stdout": out[-MAX_OUTPUT_CHARS:], "stderr": "", "timed_out": True}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload, extra_headers=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        origin = self.headers.get("Origin")
        if origin and ALLOWED_ORIGIN.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _rejected(self):
        """Blocks other websites (by Origin) and DNS-rebinding tricks (by Host)."""
        if not ALLOWED_HOST.match(self.headers.get("Host", "")):
            self._send(403, {"error": "unexpected Host header"})
            return True
        origin = self.headers.get("Origin")
        if origin and not ALLOWED_ORIGIN.match(origin):
            self._send(403, {"error": f"origin {origin} is not allowed"})
            return True
        return False

    def do_OPTIONS(self):
        if self._rejected():
            return
        self._send(200, {}, {"Access-Control-Allow-Methods": "GET, POST",
                                               "Access-Control-Allow-Headers": "Content-Type",
                                               "Access-Control-Max-Age": "600"})

    def do_GET(self):
        if self._rejected():
            return
        url = urlparse(self.path)
        if url.path == "/health":
            return self._send(200, {"ok": True})
        if url.path == "/commands":
            return self._send(200, {"commands": [{"name": n, **c} for n, c in COMMANDS.items()]})
        if url.path != "/search":
            return self._send(404, {"error": "use /search?q=..."})
        params = parse_qs(url.query)
        query = (params.get("q", [""])[0]).strip()[:MAX_QUERY_CHARS]
        if not query:
            return self._send(400, {"error": "missing q"})
        try:
            max_results = max(1, min(MAX_RESULTS, int(params.get("max", ["5"])[0])))
        except ValueError:
            max_results = 5
        try:
            return self._send(200, {"results": search(query, max_results)})
        except Exception as err:  # ddgs raises on rate limits and timeouts
            return self._send(502, {"error": f"DuckDuckGo search failed: {err}"})

    def do_POST(self):
        if self._rejected():
            return
        if urlparse(self.path).path != "/run":
            return self._send(404, {"error": "use POST /run"})
        if not RUN_ORIGIN.match(self.headers.get("Origin", "")):
            return self._send(403, {"error": "commands can only be run from CoDev served on localhost"})
        # JSON content type forces a browser preflight, so other pages can't post blindly.
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            return self._send(415, {"error": "send application/json"})
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 4096)
            name = json.loads(self.rfile.read(length) or b"{}").get("name", "")
        except (ValueError, AttributeError):
            return self._send(400, {"error": "bad JSON"})
        if name not in COMMANDS:
            return self._send(404, {"error": f"'{name}' is not in allowed_commands.json"})
        sys.stderr.write(f"[codev-helper] running {name}: {' '.join(COMMANDS[name]['argv'])}\n")
        return self._send(200, run_command(name))

    def log_message(self, fmt, *args):
        sys.stderr.write("[codev-helper] " + (fmt % args) + "\n")


def main():
    global COMMANDS, PROJECT_DIR
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--project", default=".", help="folder the approved commands run in (default: current folder)")
    parser.add_argument("--commands", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "allowed_commands.json"),
                        help="JSON file listing the commands agents may ask to run")
    args = parser.parse_args()
    PROJECT_DIR = os.path.abspath(os.path.expanduser(args.project))
    COMMANDS = load_commands(args.commands, PROJECT_DIR)
    # Bound to 127.0.0.1 so nothing outside this computer can use it.
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"CoDev helper running on http://127.0.0.1:{args.port} (Ctrl+C to stop)")
    print(f"Approved commands: {', '.join(COMMANDS) or 'none (search only)'}; project folder: {PROJECT_DIR}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
