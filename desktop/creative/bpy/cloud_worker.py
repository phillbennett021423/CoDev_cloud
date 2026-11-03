"""CoDev's cloud 3D worker: runs asset_pipeline.py jobs on a GitHub Actions runner,
so the 3D steps of the skin pipeline run without the user's phone or PC.

Plain Python 3 (no Blender inside); it starts Blender itself. Three modes:

  --release ID    a job CoDev sent: the draft release ID holds job.json and the
                  input files (assets named in__<name>). The job runs, then every
                  file it wrote is uploaded back to the release, with result.json
                  last, so CoDev knows the job is finished when result.json appears.
  --mesh-url URL  a job started by hand from the Actions tab (e.g. on the GitHub
                  phone app): downloads a .glb/.fbx/.obj and runs --ops on it in
                  order (default cleanup,uv,review). Results go to --out.
  --self-test     makes a test mesh and runs cleanup, uv and review on it.

The job's paths are relative ("in/...", "out/..."); they're made absolute here
and turned back into relative ones in the report, so CoDev can map them onto the
user's project.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PIPELINE = os.path.join(HERE, "asset_pipeline.py")
API = "https://api.github.com"
UPLOADS = "https://uploads.github.com"


def request(url, method="GET", data=None, headers=None, token=None, raw=False):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    req.add_header("User-Agent", "codev-cloud-worker")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if token:
        # Unredirected: release downloads redirect to storage that rejects a GitHub token.
        req.add_unredirected_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=600) as res:
        body = res.read()
    return body if raw else (json.loads(body) if body else None)


def absolute(value, work):
    if isinstance(value, str) and re.match(r"^(in|out)/", value):
        return os.path.join(work, value)
    if isinstance(value, list):
        return [absolute(v, work) for v in value]
    if isinstance(value, dict):
        return {k: absolute(v, work) for k, v in value.items()}
    return value


def relative(value, work):
    prefix = work.rstrip("/") + "/"
    if isinstance(value, str):
        return value.replace(prefix, "")
    if isinstance(value, list):
        return [relative(v, work) for v in value]
    if isinstance(value, dict):
        return {k: relative(v, work) for k, v in value.items()}
    return value


def run_blender(blender, job, work, timeout):
    """Runs one asset_pipeline.py job; job paths are absolute. Returns the report."""
    for key in ("output", "result"):
        if job.get(key):
            os.makedirs(os.path.dirname(job[key]), exist_ok=True)
    if job.get("out_dir"):
        os.makedirs(job["out_dir"], exist_ok=True)
    # No graphics card here: reviews render with Cycles and bakes on the CPU.
    if job.get("op") == "review":
        job["engine"] = "cycles"
    if job.get("op") == "bake":
        job["gpu"] = False
    job_file = os.path.join(work, "job-%s.json" % job.get("op", "run"))
    with open(job_file, "w", encoding="utf-8") as f:
        json.dump(job, f)
    if os.path.exists(job["result"]):
        os.remove(job["result"])
    started = time.time()
    try:
        run = subprocess.run([blender, "--background", "--factory-startup", "--python-exit-code", "1", "--python", PIPELINE, "--", job_file],
                             cwd=work, capture_output=True, text=True, timeout=timeout)
        output, code = (run.stdout or "") + (run.stderr or ""), run.returncode
    except subprocess.TimeoutExpired as err:
        output, code = str(err.stdout or "") + "\nStopped after %d seconds." % timeout, -1
    try:
        with open(job["result"], encoding="utf-8") as f:
            report = json.load(f)
    except (OSError, ValueError):
        report = {"ok": False, "op": job.get("op"), "error": "Blender stopped before finishing (exit %s)." % code, "trace": output[-2000:]}
    report["cloud_seconds"] = round(time.time() - started, 1)
    print(output[-4000:])
    return report


def from_release(args, blender):
    token, repo, rid = os.environ["GH_TOKEN"], os.environ["GITHUB_REPOSITORY"], args.release
    work = os.path.abspath(args.work)
    os.makedirs(os.path.join(work, "in"), exist_ok=True)
    base = "%s/repos/%s/releases/%s" % (API, repo, rid)
    report = {"ok": False, "error": "The worker stopped before running the job."}
    try:
        assets = request(base + "/assets?per_page=100", token=token)
        job = None
        for a in assets:
            data = request("%s/repos/%s/releases/assets/%s" % (API, repo, a["id"]), headers={"Accept": "application/octet-stream"}, token=token, raw=True)
            if a["name"] == "job.json":
                job = json.loads(data)
            elif a["name"].startswith("in__"):
                with open(os.path.join(work, "in", a["name"][4:]), "wb") as f:
                    f.write(data)
        if job is None:
            raise RuntimeError("The release has no job.json.")
        timeout = min(int(job.pop("timeout_seconds", 900) or 900), 3 * 3600)
        report = run_blender(blender, absolute(job, work), work, timeout)
    except Exception as err:  # the report always goes back, so CoDev never waits forever
        report = {"ok": False, "error": "Cloud worker: %s" % err}
    report = relative(report, work)
    files = {}
    out = os.path.join(work, "out")
    n = 0
    for folder, _, names in os.walk(out):
        for name in sorted(names):
            full = os.path.join(folder, name)
            rel = os.path.relpath(full, work).replace(os.sep, "/")
            if rel == "out/result.json":
                continue
            n += 1
            asset = "o%d_%s" % (n, re.sub(r"[^\w.-]", "_", name))
            with open(full, "rb") as f:
                request("%s/repos/%s/releases/%s/assets?name=%s" % (UPLOADS, repo, rid, asset), method="POST", data=f.read(),
                        headers={"Content-Type": "application/octet-stream"}, token=token)
            files[asset] = rel
    report["cloud_files"] = files
    report["cloud_run"] = "%s/%s/actions/runs/%s" % (os.environ.get("GITHUB_SERVER_URL", "https://github.com"), repo, os.environ.get("GITHUB_RUN_ID", ""))
    request("%s/repos/%s/releases/%s/assets?name=result.json" % (UPLOADS, repo, rid), method="POST", data=json.dumps(report).encode(),
            headers={"Content-Type": "application/json"}, token=token)
    print(json.dumps({k: v for k, v in report.items() if k != "trace"}, indent=2)[:6000])
    return 0 if report.get("ok") else 1


def chain(blender, work, src, ops, category, target_tris, name):
    """Runs ops on src in order, each step's .glb feeding the next. Returns the reports."""
    reports = []
    current = src
    for i, op in enumerate(ops):
        job = {"op": op, "input": current, "result": os.path.join(work, "out", "%d-%s.json" % (i + 1, op)), "name": name}
        if op in ("cleanup", "uv"):
            job["output"] = os.path.join(work, "out", "%s_%s.glb" % (name, {"cleanup": "lod0", "uv": "uv"}[op]))
        if op == "cleanup":
            job["target_tris"] = target_tris
        if op == "review":
            job.update(out_dir=os.path.join(work, "out", "review"), size=512, samples=8)
        if op == "bake":
            job.update(out_dir=os.path.join(work, "out", "textures"), output=os.path.join(work, "out", "%s_baked.glb" % name), size=1024, samples=8)
        if op not in ("inspect", "cleanup", "uv", "review", "bake"):
            raise SystemExit("Ops started by hand are inspect, cleanup, uv, bake and review; %s needs CoDev." % op)
        report = run_blender(blender, job, work, 3600)
        report = relative(report, work)
        reports.append(report)
        print("%s: %s" % (op, json.dumps({k: v for k, v in report.items() if k not in ("trace", "views")})[:1500]))
        if not report.get("ok"):
            break
        if report.get("output"):
            current = os.path.join(work, report["output"])
    return reports


BUDGETS = {"character": 15000, "skin": 12000, "weapon": 5000, "vehicle": 20000, "prop": 3000, "environment": 30000}


def by_hand(args, blender):
    work = os.path.abspath(args.work)
    os.makedirs(os.path.join(work, "in"), exist_ok=True)
    url = args.mesh_url
    if not re.match(r"^https://", url):
        raise SystemExit("mesh_url must be an https link to a .glb, .gltf, .fbx or .obj file.")
    ext = os.path.splitext(url.split("?")[0])[1].lower()
    if ext not in (".glb", ".gltf", ".fbx", ".obj", ".stl"):
        ext = ".glb"
    src = os.path.join(work, "in", "mesh" + ext)
    with open(src, "wb") as f:
        f.write(request(url, raw=True))
    name = re.sub(r"[^\w-]", "_", args.name or "asset")[:40]
    ops = [o.strip() for o in args.ops.split(",") if o.strip()]
    target = int(args.target_tris or 0) or BUDGETS.get(args.category, 10000)
    reports = chain(blender, work, src, ops, args.category, target, name)
    with open(os.path.join(work, "out", "summary.json"), "w", encoding="utf-8") as f:
        json.dump(reports, f, indent=2)
    return 0 if reports and all(r.get("ok") for r in reports) else 1


def self_test(args, blender):
    """A lumpy, over-dense sphere: cleanup must bring it under budget, uv and review must pass."""
    import math
    work = os.path.abspath(args.work)
    os.makedirs(os.path.join(work, "in"), exist_ok=True)
    src = os.path.join(work, "in", "lumpy.obj")
    rings, segs = 120, 160
    lines = []
    for i in range(rings + 1):
        th = math.pi * i / rings
        for j in range(segs):
            ph = 2 * math.pi * j / segs
            r = 1 + 0.08 * math.sin(5 * th) * math.cos(4 * ph)
            lines.append("v %f %f %f" % (r * math.sin(th) * math.cos(ph), r * math.sin(th) * math.sin(ph), r * math.cos(th)))
    for i in range(rings):
        for j in range(segs):
            a, b = i * segs + j + 1, i * segs + (j + 1) % segs + 1
            c, d = a + segs, b + segs
            lines.append("f %d %d %d %d" % (a, b, d, c))
    with open(src, "w") as f:
        f.write("\n".join(lines))
    reports = chain(blender, work, src, ["inspect", "cleanup", "uv", "review"], "prop", 3000, "selftest")
    ok = len(reports) == 4 and all(r.get("ok") for r in reports)
    if ok:
        before, after = reports[0]["triangles"], reports[1]["triangles"]
        ok = before > 30000 and after <= 3000 and len(reports[3].get("views") or {}) >= 6
        for f in (reports[3].get("views") or {}).values():
            ok = ok and os.path.getsize(os.path.join(work, f)) > 1000
        print("Self-test: %d -> %d triangles, %d review views." % (before, after, len(reports[3].get("views") or {})))
    print("SELF-TEST " + ("PASSED" if ok else "FAILED"))
    return 0 if ok else 1


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--blender", required=True)
    p.add_argument("--work", default="cloud-work")
    p.add_argument("--release")
    p.add_argument("--mesh-url")
    p.add_argument("--ops", default="cleanup,uv,review")
    p.add_argument("--category", default="skin")
    p.add_argument("--target-tris", default="")
    p.add_argument("--name", default="asset")
    p.add_argument("--self-test", action="store_true")
    a = p.parse_args()
    if a.self_test:
        return self_test(a, a.blender)
    if a.release:
        if not re.match(r"^\d+$", a.release):
            raise SystemExit("release must be a number.")
        return from_release(a, a.blender)
    if a.mesh_url:
        return by_hand(a, a.blender)
    raise SystemExit("Pass --release, --mesh-url or --self-test.")


if __name__ == "__main__":
    sys.exit(main())
