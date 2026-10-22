"""Local helper for CoDev Studio: free DuckDuckGo search, an MCP tool server, and local commands.

Browsers block web pages from calling DuckDuckGo directly (CORS), so when
CoDev runs in a desktop browser it asks this helper instead. The helper uses
the free `ddgs` library (formerly `duckduckgo_search`): no API key, no
account, nothing paid.

It is also a Model Context Protocol (MCP) server over Streamable HTTP at /mcp.
CoDev's agents (or any MCP client) can list and read files in the project
folder and run the commands you listed in allowed_commands.json. Start it with
--autonomous and agents can also write and edit files in the project folder
and run any shell command there, on their own, without asking first.

    pip install -r requirements.txt
    python ddgs_helper.py --project ~/my-game               # search, read files, approved commands
    python ddgs_helper.py --project ~/my-game --autonomous  # agents also edit files and run code

GET  /search?q=<query>&max=<1-10>  ->  {"results": [{"title", "href", "body"}]}
GET  /commands                     ->  {"commands": [{"name", "description", "argv", "cwd"}]}
POST /run {"name": "<command>"}    ->  {"exit_code", "stdout", "stderr", "timed_out"}
POST /mcp  JSON-RPC 2.0 (initialize, tools/list, tools/call, ping)
GET  /health                       ->  {"ok": true, "autonomous": bool}

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
MAX_COMMAND_TIMEOUT_SECONDS = 600
MAX_READ_CHARS = 100000
MAX_LISTED_FILES = 500
MAX_SEARCH_MATCHES = 200
MAX_SEARCHED_FILES = 2000
MAX_SEARCHED_FILE_BYTES = 1024 * 1024
MAX_MCP_BODY_BYTES = 2 * 1024 * 1024
SKIPPED_DIRS = {".git", "node_modules", "__pycache__", ".godot", ".import", "venv", ".venv", "dist", "build"}


# Files that can hold API keys and secrets, which agents never see: hidden files
# and folders (.env, .git, anything starting with a dot), env files like
# production.env, key and certificate files, and secrets.* / credentials.*.
SECRET_NAME = re.compile(r"^\.|\.(env|pem|key|pfx|p12|keystore|jks)$|^(secrets|credentials)\.", re.IGNORECASE)


def is_secret_name(name):
    return name not in (".", "..") and bool(SECRET_NAME.search(name))
MCP_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")

# Only CoDev itself may call the helper: pages opened from disk send "null",
# the Android app uses https://localhost, and dev servers use localhost/127.0.0.1.
ALLOWED_ORIGIN = re.compile(r"^(null|https?://(localhost|127\.0\.0\.1)(:\d+)?|capacitor://localhost|app://codev)$")
# Running commands is stricter: sandboxed pages on any website also send "null",
# so /run needs CoDev served from localhost or the desktop app (see README).
RUN_ORIGIN = re.compile(r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|app://codev)$")
ALLOWED_HOST = re.compile(r"^(localhost|127\.0\.0\.1)(:\d+)?$")

COMMANDS = {}
PROJECT_DIR = os.getcwd()
AUTONOMOUS = False


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


# MCP TOOLS
# Each tool: description, inputSchema, MCP annotations, and the function that runs it.
# Paths are relative to the project folder and can't point outside it.

class ToolError(Exception):
    pass


def project_path(rel):
    rel = str(rel or ".").strip() or "."
    full = os.path.realpath(os.path.join(PROJECT_DIR, os.path.expanduser(rel)))
    root = os.path.realpath(PROJECT_DIR)
    if full != root and not full.startswith(root + os.sep):
        raise ToolError(f"'{rel}' is outside the project folder {PROJECT_DIR}")
    if any(is_secret_name(part) for part in os.path.relpath(full, root).split(os.sep)):
        raise ToolError(f"'{rel}' is a hidden or env file (it may hold keys), which agents can't access")
    return full


def tool_list_files(args):
    start = project_path(args.get("path", "."))
    if not os.path.isdir(start):
        raise ToolError(f"'{args.get('path')}' is not a folder")
    root = os.path.realpath(PROJECT_DIR)
    found = []
    for folder, dirs, files in os.walk(start):
        dirs[:] = sorted(d for d in dirs if d not in SKIPPED_DIRS and not is_secret_name(d))
        for name in sorted(n for n in files if not is_secret_name(n)):
            found.append(os.path.relpath(os.path.join(folder, name), root).replace(os.sep, "/"))
            if len(found) >= MAX_LISTED_FILES:
                return "\n".join(found) + f"\n[stopped at {MAX_LISTED_FILES} files]"
    return "\n".join(found) or "The folder is empty."


def tool_read_file(args):
    path = project_path(args.get("path"))
    if not os.path.isfile(path):
        raise ToolError(f"No file at '{args.get('path')}'. Call list_files to see what exists.")
    with open(path, encoding="utf-8", errors="replace") as f:
        text = f.read(MAX_READ_CHARS + 1)
    return text if len(text) <= MAX_READ_CHARS else text[:MAX_READ_CHARS] + f"\n[truncated at {MAX_READ_CHARS} characters]"


def tool_search_files(args):
    query = args.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ToolError("search_files needs a 'query' string")
    needle = query.lower()
    start = project_path(args.get("path", "."))
    if not os.path.isdir(start):
        raise ToolError(f"'{args.get('path')}' is not a folder")
    root = os.path.realpath(PROJECT_DIR)
    hits, searched = [], 0
    for folder, dirs, files in os.walk(start):
        dirs[:] = sorted(d for d in dirs if d not in SKIPPED_DIRS and not is_secret_name(d))
        for name in sorted(n for n in files if not is_secret_name(n)):
            full = os.path.join(folder, name)
            searched += 1
            if searched > MAX_SEARCHED_FILES:
                return "\n".join(hits) or f'No matches for "{query}" in the first {MAX_SEARCHED_FILES} files.'
            if os.path.getsize(full) > MAX_SEARCHED_FILE_BYTES:
                continue
            with open(full, encoding="utf-8", errors="replace") as f:
                text = f.read()
            if "\0" in text:  # binary
                continue
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            for number, line in enumerate(text.split("\n"), 1):
                if needle in line.lower():
                    hits.append(f"{rel}:{number}: {line.strip()[:200]}")
                    if len(hits) >= MAX_SEARCH_MATCHES:
                        return "\n".join(hits) + f"\n[stopped at {MAX_SEARCH_MATCHES} matches]"
    return "\n".join(hits) or f'No matches for "{query}".'


def tool_write_file(args):
    path = project_path(args.get("path"))
    content = args.get("content")
    if not isinstance(content, str):
        raise ToolError("write_file needs 'content' as a string")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    sys.stderr.write(f"[codev-helper] wrote {path}\n")
    return f"Wrote {len(content)} characters to {args.get('path')}."


def tool_edit_file(args):
    path = project_path(args.get("path"))
    old, new = args.get("old_text"), args.get("new_text")
    if not isinstance(old, str) or not old or not isinstance(new, str):
        raise ToolError("edit_file needs non-empty 'old_text' and a 'new_text' string")
    if not os.path.isfile(path):
        raise ToolError(f"No file at '{args.get('path')}'")
    with open(path, encoding="utf-8", newline="") as f:
        text = f.read()
    count = text.count(old)
    if count != 1:
        raise ToolError(f"old_text must appear exactly once in the file; it appears {count} times")
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text.replace(old, new, 1))
    sys.stderr.write(f"[codev-helper] edited {path}\n")
    return f"Edited {args.get('path')}."


def format_run(result):
    return (f"Exit code: {result['exit_code']}{' (timed out)' if result['timed_out'] else ''}\n"
            f"--- stdout ---\n{result['stdout']}\n--- stderr ---\n{result['stderr']}")


def tool_run_command(args):
    command = args.get("command")
    if not isinstance(command, str) or not command.strip():
        raise ToolError("run_command needs a 'command' string")
    try:
        timeout = max(1, min(MAX_COMMAND_TIMEOUT_SECONDS, int(args.get("timeout_seconds") or 120)))
    except (TypeError, ValueError):
        timeout = 120
    cwd = project_path(args.get("cwd", "."))
    sys.stderr.write(f"[codev-helper] running in {cwd}: {command}\n")
    try:
        done = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout, shell=True)
        result = {"exit_code": done.returncode, "stdout": done.stdout[-MAX_OUTPUT_CHARS:],
                  "stderr": done.stderr[-MAX_OUTPUT_CHARS:], "timed_out": False}
    except subprocess.TimeoutExpired as err:
        out = err.stdout.decode(errors="replace") if isinstance(err.stdout, bytes) else (err.stdout or "")
        result = {"exit_code": None, "stdout": out[-MAX_OUTPUT_CHARS:], "stderr": "", "timed_out": True}
    return format_run(result)


def tool_run_approved_command(args):
    name = args.get("name")
    if name not in COMMANDS:
        raise ToolError(f"'{name}' is not in allowed_commands.json")
    sys.stderr.write(f"[codev-helper] running {name}: {' '.join(COMMANDS[name]['argv'])}\n")
    return format_run(run_command(name))


def mcp_tools():
    path_prop = {"type": "string", "description": "Path relative to the project folder, with / separators."}
    tools = [
        {"name": "list_files", "run": tool_list_files,
         "description": "List files in the user's project folder on their computer (recursively, skipping .git and node_modules).",
         "inputSchema": {"type": "object", "properties": {"path": {**path_prop, "description": "Sub-folder to list; omit for the whole project."}}},
         "annotations": {"readOnlyHint": True}},
        {"name": "read_file", "run": tool_read_file,
         "description": "Read a text file from the user's project folder.",
         "inputSchema": {"type": "object", "properties": {"path": path_prop}, "required": ["path"]},
         "annotations": {"readOnlyHint": True}},
        {"name": "search_files", "run": tool_search_files,
         "description": "Search the text of every file in the user's project folder (case-insensitive) and get matching lines as path:line: text. Use it to find where something is defined or used.",
         "inputSchema": {"type": "object", "properties": {"query": {"type": "string", "description": "Text to look for."},
                                                         "path": {**path_prop, "description": "Sub-folder to search; omit for the whole project."}}, "required": ["query"]},
         "annotations": {"readOnlyHint": True}},
    ]
    if COMMANDS:
        tools.append({"name": "run_approved_command", "run": tool_run_approved_command,
                      "description": "Run one of the user's pre-approved commands (build, test, lint) in the project folder and get its output. Available: "
                                     + "; ".join(f"{n} ({c['description'] or ' '.join(c['argv'])})" for n, c in COMMANDS.items()),
                      "inputSchema": {"type": "object", "properties": {"name": {"type": "string", "enum": list(COMMANDS)}}, "required": ["name"]},
                      "annotations": {"readOnlyHint": False, "destructiveHint": False}})
    if AUTONOMOUS:
        tools += [
            {"name": "write_file", "run": tool_write_file,
             "description": "Create or overwrite a file in the user's project folder with the given content. Folders are created as needed.",
             "inputSchema": {"type": "object", "properties": {"path": path_prop, "content": {"type": "string", "description": "The complete new file content."}}, "required": ["path", "content"]},
             "annotations": {"readOnlyHint": False, "destructiveHint": True}},
            {"name": "edit_file", "run": tool_edit_file,
             "description": "Replace one exact snippet of a file in the project folder. old_text must appear exactly once; read the file first.",
             "inputSchema": {"type": "object", "properties": {"path": path_prop, "old_text": {"type": "string"}, "new_text": {"type": "string"}}, "required": ["path", "old_text", "new_text"]},
             "annotations": {"readOnlyHint": False, "destructiveHint": True}},
            {"name": "run_command", "run": tool_run_command,
             "description": f"Run a shell command in the user's project folder on their computer ({'Windows cmd' if os.name == 'nt' else 'sh'}) and get exit code, stdout and stderr. Use it to run code, tests, builds and scripts.",
             "inputSchema": {"type": "object", "properties": {
                 "command": {"type": "string", "description": "The command line to run."},
                 "cwd": {**path_prop, "description": "Sub-folder to run in; omit for the project folder."},
                 "timeout_seconds": {"type": "integer", "description": f"Stop after this many seconds (default 120, max {MAX_COMMAND_TIMEOUT_SECONDS})."}},
                 "required": ["command"]},
             "annotations": {"readOnlyHint": False, "destructiveHint": True}},
        ]
    return tools


def handle_mcp_message(msg):
    """Handles one JSON-RPC message; returns the response, or None for notifications."""
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
        return {"jsonrpc": "2.0", "id": msg.get("id") if isinstance(msg, dict) else None,
                "error": {"code": -32600, "message": "Invalid Request"}}
    if "id" not in msg:
        return None  # notifications/initialized and friends need no answer
    method, params, msg_id = msg["method"], msg.get("params") or {}, msg["id"]

    def ok(result):
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    if method == "initialize":
        asked = params.get("protocolVersion")
        return ok({"protocolVersion": asked if asked in MCP_PROTOCOL_VERSIONS else MCP_PROTOCOL_VERSIONS[0],
                   "capabilities": {"tools": {"listChanged": False}},
                   "serverInfo": {"name": "codev-helper", "version": "2.0.0"},
                   "instructions": f"Tools work inside the project folder {PROJECT_DIR}."})
    if method == "ping":
        return ok({})
    if method == "tools/list":
        return ok({"tools": [{k: t[k] for k in ("name", "description", "inputSchema", "annotations")} for t in mcp_tools()]})
    if method == "tools/call":
        tool = next((t for t in mcp_tools() if t["name"] == params.get("name")), None)
        if not tool:
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32602, "message": f"Unknown tool: {params.get('name')}"}}
        args = params.get("arguments") or {}
        try:
            text, is_error = tool["run"](args if isinstance(args, dict) else {}), False
        except ToolError as err:
            text, is_error = str(err), True
        except OSError as err:
            text, is_error = f"{type(err).__name__}: {err}", True
        return ok({"content": [{"type": "text", "text": text}], "isError": is_error})
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}


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
                                               "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version",
                                               "Access-Control-Max-Age": "600"})

    def do_GET(self):
        if self._rejected():
            return
        url = urlparse(self.path)
        if url.path == "/health":
            return self._send(200, {"ok": True, "autonomous": AUTONOMOUS})
        if url.path == "/mcp":
            return self._send(405, {"error": "this MCP server answers POST requests only"}, {"Allow": "POST"})
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
        if urlparse(self.path).path == "/mcp":
            return self._handle_mcp()
        if urlparse(self.path).path != "/run":
            return self._send(404, {"error": "use POST /run or POST /mcp"})
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

    def _handle_mcp(self):
        # Browsers always send Origin on POST: only CoDev served from localhost or the
        # desktop app gets in. Local MCP clients (no Origin) are processes on this computer.
        origin = self.headers.get("Origin")
        if origin is not None and not RUN_ORIGIN.match(origin):
            return self._send(403, {"error": "MCP is only available to CoDev served on localhost or the desktop app"})
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            return self._send(415, {"error": "send application/json"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > MAX_MCP_BODY_BYTES:
                return self._send(413, {"error": "request too large"})
            payload = json.loads(self.rfile.read(length) or b"null")
        except (ValueError, UnicodeDecodeError):
            return self._send(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
        if isinstance(payload, list):
            replies = [r for r in (handle_mcp_message(m) for m in payload) if r is not None]
        else:
            replies = handle_mcp_message(payload)
        if not replies:
            self.send_response(202)
            origin = self.headers.get("Origin")
            if origin and ALLOWED_ORIGIN.match(origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        return self._send(200, replies)

    def log_message(self, fmt, *args):
        sys.stderr.write("[codev-helper] " + (fmt % args) + "\n")


def main():
    global COMMANDS, PROJECT_DIR, AUTONOMOUS
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--project", default=".", help="folder the approved commands run in (default: current folder)")
    parser.add_argument("--commands", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "allowed_commands.json"),
                        help="JSON file listing the commands agents may ask to run")
    parser.add_argument("--autonomous", action="store_true",
                        help="let agents write and edit files in the project folder and run any shell command there, without asking")
    args = parser.parse_args()
    AUTONOMOUS = args.autonomous
    PROJECT_DIR = os.path.abspath(os.path.expanduser(args.project))
    COMMANDS = load_commands(args.commands, PROJECT_DIR)
    # Bound to 127.0.0.1 so nothing outside this computer can use it.
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"CoDev helper running on http://127.0.0.1:{args.port} (Ctrl+C to stop)")
    print(f"Approved commands: {', '.join(COMMANDS) or 'none'}; project folder: {PROJECT_DIR}")
    print(f"MCP server: http://127.0.0.1:{args.port}/mcp"
          + (" (autonomous: agents can edit files and run any command in the project folder)" if AUTONOMOUS else " (read-only plus approved commands)"))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
