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
