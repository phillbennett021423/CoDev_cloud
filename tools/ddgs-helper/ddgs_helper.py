"""Local DuckDuckGo search helper for CoDev Studio.

Browsers block web pages from calling DuckDuckGo directly (CORS), so when
CoDev runs in a desktop browser it asks this helper instead. The helper uses
the free `ddgs` library: no API key, no account, nothing paid.

    pip install -r requirements.txt
    python ddgs_helper.py            # listens on http://127.0.0.1:8787

GET /search?q=<query>&max=<1-10>  ->  {"results": [{"title", "href", "body"}]}
GET /health                       ->  {"ok": true}

The Android app doesn't need this; it searches DuckDuckGo natively.
"""

import argparse
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:
    from ddgs import DDGS
except ImportError:  # pragma: no cover - message for people running it the first time
    sys.exit("The ddgs library is missing. Run: pip install -r requirements.txt")

MAX_RESULTS = 10
MAX_QUERY_CHARS = 300

# Only CoDev itself may call the helper: pages opened from disk send "null",
# the Android app uses https://localhost, and dev servers use localhost/127.0.0.1.
ALLOWED_ORIGIN = re.compile(r"^(null|https?://(localhost|127\.0\.0\.1)(:\d+)?|capacitor://localhost)$")


def search(query, max_results):
    with DDGS() as ddgs:
        rows = ddgs.text(query, max_results=max_results, backend="duckduckgo")
    return [{"title": r.get("title", ""), "href": r.get("href", ""), "body": r.get("body", "")} for r in rows]


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        origin = self.headers.get("Origin")
        if origin and ALLOWED_ORIGIN.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        origin = self.headers.get("Origin")
        if origin and not ALLOWED_ORIGIN.match(origin):
            return self._send(403, {"error": f"origin {origin} is not allowed"})
        if url.path == "/health":
            return self._send(200, {"ok": True})
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

    def log_message(self, fmt, *args):
        sys.stderr.write("[ddgs-helper] " + (fmt % args) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    # Bound to 127.0.0.1 so nothing outside this computer can use it.
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"CoDev search helper running on http://127.0.0.1:{args.port} (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
