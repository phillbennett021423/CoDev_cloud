"""Mandatory 4-view QA render + mesh checks for stylized game characters.

Run headless after EVERY build or shader script:

    blender -b character.blend -P render_4view.py -- --out qa/run_01
    blender -b character.blend -P render_4view.py -- --out qa/run_02 --baseline qa/run_01/metrics.json

or, with Blender as a Python module (pip install bpy==5.2.*):

    python render_4view.py -- --blend character.blend --out qa/run_01

Writes to --out:
    front.png left.png right.png back.png        beauty renders (the scene's own materials)
    diag_front.png ... diag_back.png             diagnostic renders: back faces RED, clipping MAGENTA
    sheet.png  diag_sheet.png                    2x2 contact sheets (front, left / right, back)
    report.md  report.json  metrics.json         checks + numbers; metrics.json is the next run's baseline

It never saves the .blend: every QA object is built in memory and the file on disk is untouched.
Character convention (Kenny Praise / Rigify): the character faces -Y, Z up, feet on Z = 0.
"left" = the character's own left side (+X), seen by a camera standing on +X.
"""
import argparse
import json
import math
import os
import sys

import bpy  # first: in bpy-module mode bmesh/mathutils only exist after bpy is imported
import bmesh
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

QA = "QA_4VIEW"
VIEWS = (("front", 0), ("left", 90), ("back", 180), ("right", 270))
TRI_BUDGET = 20000  # per mesh piece: Roblox hard cap, our Godot rule too


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--blend", help="open this .blend first (python-module mode)")
    p.add_argument("--out", required=True)
    p.add_argument("--collection", help="only check/render objects in this collection (recursive)")
    p.add_argument("--engine", default="CYCLES", choices=["CYCLES", "BLENDER_EEVEE", "BLENDER_WORKBENCH"])
    p.add_argument("--samples", type=int, default=24)
    p.add_argument("--res", type=int, default=800, help="width; height = width * 1.25 (Kenny's 1200x1500 ratio)")
    p.add_argument("--persp", action="store_true", help="85 mm perspective instead of orthographic")
    p.add_argument("--inner", default="", help="comma list of skin/body objects for clipping (auto: names with body/skin/head)")
    p.add_argument("--outer", default="", help="comma list of clothing/gear objects (auto: every other mesh)")
    p.add_argument("--band", type=float, default=0.025, help="clipping search band as a fraction of height")
    p.add_argument("--baseline", help="metrics.json from an earlier run, to catch proportion drift")
    p.add_argument("--drift", type=float, default=0.02, help="allowed relative change vs baseline (2 %)")
    p.add_argument("--tri-budget", type=int, default=TRI_BUDGET)
    p.add_argument("--no-diag", action="store_true")
    p.add_argument("--ignore", default="", help="comma list of name pairs a:b whose contact is intended (hand:body)")
    return p.parse_args(argv)


# ----------------------------------------------------------------- scene helpers
def collection_objects(name):
    col = bpy.data.collections.get(name)
    if not col:
        raise SystemExit(f"collection {name!r} not found")
    return set(col.all_objects)


def target_objects(args):
    pool = collection_objects(args.collection) if args.collection else set(bpy.context.scene.objects)
    out = []
    for ob in pool:
        if ob.name.startswith("QA_") or ob.hide_render or not ob.visible_get():
            continue
        if ob.type in {"MESH", "CURVES", "CURVE", "SURFACE", "META", "FONT"}:
            out.append(ob)
    if not out:
        raise SystemExit("no renderable objects found")
    return sorted(out, key=lambda o: o.name)


def eval_mesh(ob, dg):
    """World-space evaluated mesh as (verts Nx3, tris Mx3, tri normals), or None."""
    eo = ob.evaluated_get(dg)
    try:
        me = eo.to_mesh()
    except RuntimeError:
        return None
    if me is None or not me.vertices:
        eo.to_mesh_clear()
        return None
    me.calc_loop_triangles()
    mw = eo.matrix_world
    v = np.empty(len(me.vertices) * 3, np.float32)
    me.vertices.foreach_get("co", v)
    v = v.reshape(-1, 3)
    v = (np.c_[v, np.ones(len(v))] @ np.array(mw).T)[:, :3]
    t = np.empty(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get("vertices", t)
    t = t.reshape(-1, 3)
    eo.to_mesh_clear()
    return v, t


def world_bbox(objs, dg):
    lo = Vector((1e9,) * 3)
    hi = Vector((-1e9,) * 3)
    for ob in objs:
        eo = ob.evaluated_get(dg)
        for c in eo.bound_box:
            w = eo.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    return lo, hi


# ----------------------------------------------------------------- checks
def mesh_checks(ob, dg, budget):
    res = {"name": ob.name, "type": ob.type}
    res["scale_applied"] = all(abs(s - 1) < 1e-4 for s in ob.scale)
    res["rotation_applied"] = all(abs(r) < 1e-4 for r in ob.rotation_euler)
    data = eval_mesh(ob, dg)
    if data is None:
        res["tris"] = 0
        return res, None
    v, t = data
    res["verts"] = int(len(v))
    res["tris"] = int(len(t))
    res["over_budget"] = len(t) > budget
    if ob.type == "MESH":
        bm = bmesh.new()
        eo = ob.evaluated_get(dg)
        bm.from_mesh(eo.to_mesh())
        eo.to_mesh_clear()
        res["non_manifold_edges"] = sum(1 for e in bm.edges if not e.is_manifold and not e.is_boundary)
        res["boundary_edges"] = sum(1 for e in bm.edges if e.is_boundary)
        res["loose_verts"] = sum(1 for x in bm.verts if not x.link_edges)
        res["zero_area_faces"] = sum(1 for f in bm.faces if f.calc_area() < 1e-10)
        # signed volume per connected piece: a closed piece with negative volume has inverted normals
        inverted = 0
        pieces = 0
        seen = set()
        for f0 in bm.faces:
            if f0.index in seen:
                continue
            stack, comp = [f0], []
            seen.add(f0.index)
            while stack:
                f = stack.pop()
                comp.append(f)
                for e in f.edges:
                    for g in e.link_faces:
                        if g.index not in seen:
                            seen.add(g.index)
                            stack.append(g)
            closed = all(e.is_manifold for f in comp for e in f.edges)
            if not closed:
                continue
            pieces += 1
            vol = 0.0
            for f in comp:
                vs = [x.co for x in f.verts]
                for i in range(1, len(vs) - 1):
                    vol += vs[0].dot(vs[i].cross(vs[i + 1])) / 6.0
            if vol < 0:
                inverted += 1
        res["closed_pieces"] = pieces
        res["inverted_closed_pieces"] = inverted
        bm.free()
    return res, data


IGNORE = []


def ignored(a, b):
    a, b = a.lower(), b.lower()
    for x, y in IGNORE:
        if (x in a and y in b) or (x in b and y in a):
            return True
    return False


def vertex_normals(v, t):
    fn = np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]])
    vn = np.zeros_like(v)
    for i in range(3):
        np.add.at(vn, t[:, i], fn)
    return vn / np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)


def clipping(inner, outer, meshes, height, band):
    """Inner (skin) vertices that sit OUTSIDE an outer (cloth/gear) surface within the band = poke-through."""
    hits = {}
    per_vertex = {}
    dist = band * height
    for oname in outer:
        if oname not in meshes:
            continue
        ov, ot = meshes[oname]
        tree = BVHTree.FromPolygons([tuple(x) for x in ov], [tuple(x) for x in ot], all_triangles=True)
        for iname in inner:
            if iname == oname or iname not in meshes or ignored(iname, oname):
                continue
            iv, it = meshes[iname]
            vn = vertex_normals(iv, it)
            mask = per_vertex.setdefault(iname, np.zeros(len(iv), bool))
            n = 0
            for k, p in enumerate(iv):
                loc, nor, idx, d = tree.find_nearest(Vector(p), dist)
                if loc is None:
                    continue
                # only count it when the cloth surface there faces the same way as the skin: this skips
                # the hem/cuff rims of open garments, where the skin legitimately continues past the edge
                if nor.dot(Vector(vn[k])) < 0.5:
                    continue
                if (Vector(p) - loc).dot(nor) > 1e-5:
                    mask[k] = True
                    n += 1
            if n and not ignored(iname, oname):
                hits[f"{iname} through {oname}"] = n
    return hits, per_vertex


def intersections(meshes, names):
    """Triangle-pair overlaps between every pair of pieces (generic clipping/interpenetration)."""
    trees = {}
    for nm in names:
        v, t = meshes[nm]
        trees[nm] = BVHTree.FromPolygons([tuple(x) for x in v], [tuple(x) for x in t], all_triangles=True)
    out = {}
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            n = len(trees[a].overlap(trees[b]))
            if n and not ignored(a, b):
                out[f"{a} x {b}"] = n
    return out


# ----------------------------------------------------------------- QA rig
def qa_collection():
    col = bpy.data.collections.get(QA) or bpy.data.collections.new(QA)
    if col.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(col)
    return col


def mat_grey(name, value=0.5):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (value, value, value, 1)
    b.inputs["Roughness"].default_value = 0.8
    return m


def make_cyclorama(col, lo, hi):
    """Kenny's backdrop: a floor that curves up behind the character (made from a bevelled L)."""
    h = hi.z - lo.z
    size = max(hi.x - lo.x, hi.y - lo.y, h)
    w = size * 8.0      # wide enough for the 85 mm camera at any angle
    depth = size * 2.4  # the wall stays close behind the character so the key light reaches it
    bm = bmesh.new()
    r = h * 0.6
    prof = [(-depth * 0.5, 0.0)]
    for i in range(9):
        a = math.radians(90 * i / 8)
        prof.append((depth * 0.5 - r + math.sin(a) * r, r - math.cos(a) * r))
    prof.append((depth * 0.5, h * 6.0))
    rows = []
    for x in (-w / 2, w / 2):
        rows.append([bm.verts.new((x, y, z)) for y, z in prof])
    for i in range(len(prof) - 1):
        bm.faces.new((rows[0][i], rows[1][i], rows[1][i + 1], rows[0][i + 1]))
    me = bpy.data.meshes.new("QA_cyc")
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new("QA_cyclorama", me)
    ob.location = ((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z - 0.001)
    ob.data.materials.append(mat_grey("QA_backdrop", 0.42))
    col.objects.link(ob)
    return ob


def build_rig(lo, hi, persp):
    col = qa_collection()
    centre = (lo + hi) / 2
    h = hi.z - lo.z
    size = max(h, (hi.x - lo.x), (hi.y - lo.y))
    pivot = bpy.data.objects.new("QA_pivot", None)
    pivot.location = (centre.x, centre.y, lo.z)
    col.objects.link(pivot)

    cam_data = bpy.data.cameras.new("QA_cam")
    if persp:
        cam_data.lens = 85.0  # Kenny: 80-90 mm for character presentation
        fov = 2 * math.atan(cam_data.sensor_width / (2 * cam_data.lens))  # sensor fit AUTO = the tall side
        span = max(h, (hi.x - lo.x) / 0.8)
        dist = (span * 0.56) / math.tan(fov / 2)
    else:
        cam_data.type = "ORTHO"
        cam_data.ortho_scale = size * 1.18
        dist = size * 4
    cam_data.clip_end = dist * 10
    cam = bpy.data.objects.new("QA_cam", cam_data)
    cam.parent = pivot
    # 4 degrees down so the cyclorama floor fills the bottom edge; ortho proportions change < 0.3 %
    pitch = math.radians(4)
    cam.location = (0, -dist, h * 0.5 + dist * math.tan(pitch))
    cam.rotation_euler = (math.radians(90) - pitch, 0, 0)
    col.objects.link(cam)
    bpy.context.scene.camera = cam

    def area(name, loc, energy, sz, colr=(1, 1, 1)):
        ld = bpy.data.lights.new(name, "AREA")
        ld.energy = energy
        ld.size = sz
        ld.color = colr
        lo_ = bpy.data.objects.new(name, ld)
        lo_.parent = pivot
        lo_.location = loc
        col.objects.link(lo_)
        tgt = Vector((0, 0, h * 0.55))
        d = tgt - Vector(loc)
        lo_.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        return lo_

    k = (h / 1.8) ** 2  # energy scales with distance squared, tuned for a 1.8 m character
    area("QA_key", (-h * 1.1, -h * 1.4, h * 1.3), 380 * k, h * 0.9)                # front-left, soft
    area("QA_fill", (h * 1.3, -h * 1.1, h * 0.7), 120 * k, h * 1.2, (0.9, 0.95, 1))  # front-right, weaker
    area("QA_rim", (h * 0.6, h * 1.5, h * 1.4), 700 * k, h * 0.5)                   # behind, separates silhouette
    cyc = make_cyclorama(col, lo, hi)
    cyc.parent = pivot
    cyc.location = (0, 0, -0.001)
    return pivot


def diag_material():
    """Back faces red; clipping verts (attribute qa_clip) magenta; everything else neutral clay."""
    m = bpy.data.materials.new("QA_diag")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    clay = nt.nodes.new("ShaderNodeBsdfDiffuse")
    clay.inputs["Color"].default_value = (0.62, 0.6, 0.58, 1)
    red = nt.nodes.new("ShaderNodeEmission")
    red.inputs["Color"].default_value = (1, 0, 0, 1)
    red.inputs["Strength"].default_value = 1.0
    mag = nt.nodes.new("ShaderNodeEmission")
    mag.inputs["Color"].default_value = (1, 0, 1, 1)
    mag.inputs["Strength"].default_value = 2.0
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "qa_clip"
    gt = nt.nodes.new("ShaderNodeMath")
    gt.operation = "GREATER_THAN"
    gt.inputs[1].default_value = 0.5
    nt.links.new(attr.outputs["Fac"], gt.inputs[0])
    mix1 = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(gt.outputs[0], mix1.inputs[0])
    nt.links.new(clay.outputs[0], mix1.inputs[1])
    nt.links.new(mag.outputs[0], mix1.inputs[2])
    mix2 = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(geo.outputs["Backfacing"], mix2.inputs[0])
    nt.links.new(mix1.outputs[0], mix2.inputs[1])
    nt.links.new(red.outputs[0], mix2.inputs[2])
    nt.links.new(mix2.outputs[0], out.inputs["Surface"])
    m.use_backface_culling = False
    return m


# ----------------------------------------------------------------- render
def setup_render(args):
    sc = bpy.context.scene
    sc.render.engine = args.engine
    sc.render.resolution_x = args.res
    sc.render.resolution_y = int(args.res * 1.25)
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = "PNG"
    sc.render.film_transparent = False
    if args.engine == "CYCLES":
        sc.cycles.device = "CPU"
        sc.cycles.samples = args.samples
        sc.cycles.use_denoising = True
        sc.cycles.max_bounces = 6
    elif args.engine == "BLENDER_EEVEE":
        sc.eevee.taa_render_samples = max(16, args.samples)
    if sc.world is None:
        sc.world = bpy.data.worlds.new("QA_world")
    sc.world.use_nodes = True
    bg = sc.world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Strength"].default_value = 0.15  # Kenny: low-strength world, the lights do the work


def render_views(pivot, out, prefix):
    paths = {}
    for name, ang in VIEWS:
        pivot.rotation_euler = (0, 0, math.radians(ang))
        bpy.context.view_layer.update()
        p = os.path.join(out, f"{prefix}{name}.png")
        bpy.context.scene.render.filepath = p
        bpy.ops.render.render(write_still=True)
        paths[name] = p
    return paths


def contact_sheet(paths, dest):
    order = ["front", "left", "right", "back"]
    imgs = []
    for k in order:
        im = bpy.data.images.load(paths[k])
        w, h = im.size
        px = np.array(im.pixels[:], np.float32).reshape(h, w, 4)
        imgs.append(px)
        bpy.data.images.remove(im)
    h, w = imgs[0].shape[:2]
    gap = 6
    sheet = np.ones((h * 2 + gap, w * 2 + gap, 4), np.float32)
    # Blender pixel rows start at the bottom: top row of the sheet = front, left
    sheet[h + gap:, :w] = imgs[0]
    sheet[h + gap:, w + gap:] = imgs[1]
    sheet[:h, :w] = imgs[2]
    sheet[:h, w + gap:] = imgs[3]
    out = bpy.data.images.new("QA_sheet", sheet.shape[1], sheet.shape[0], alpha=True)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = dest
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)


# ----------------------------------------------------------------- main
def main():
    args = parse_args()
    IGNORE.extend(tuple(p.lower().split(":")) for p in args.ignore.split(",") if ":" in p)
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.blend))
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    objs = target_objects(args)
    dg = bpy.context.evaluated_depsgraph_get()
    lo, hi = world_bbox(objs, dg)
    height = hi.z - lo.z

    report = {"objects": [], "issues": [], "metrics": {}}
    meshes = {}
    total_tris = 0
    for ob in objs:
        r, data = mesh_checks(ob, dg, args.tri_budget)
        report["objects"].append(r)
        total_tris += r.get("tris", 0)
        if data is not None and ob.type == "MESH":
            meshes[ob.name] = data
        if r.get("over_budget"):
            report["issues"].append(f"{ob.name}: {r['tris']} tris is over the {args.tri_budget} per-piece budget")
        if not r["scale_applied"]:
            report["issues"].append(f"{ob.name}: scale not applied (Ctrl A > Scale)")
        if r.get("inverted_closed_pieces"):
            report["issues"].append(f"{ob.name}: {r['inverted_closed_pieces']} closed piece(s) have inverted normals (Shift N)")
        if r.get("non_manifold_edges"):
            report["issues"].append(f"{ob.name}: {r['non_manifold_edges']} non-manifold edges")
        if r.get("zero_area_faces"):
            report["issues"].append(f"{ob.name}: {r['zero_area_faces']} zero-area faces")

    names = list(meshes)
    auto_inner = [n for n in names if any(k in n.lower() for k in ("body", "skin", "head", "torso"))]
    inner = [s for s in args.inner.split(",") if s] or auto_inner
    skip = ("eye", "teeth", "tongue", "brow", "lash", "hair", "scalp", "cornea", "iris")
    outer = [s for s in args.outer.split(",") if s] or [n for n in names if n not in inner
                                                         and not any(k in n.lower() for k in skip)]
    clip, per_vertex = clipping(inner, outer, meshes, height, args.band)
    for k, n in clip.items():
        report["issues"].append(f"clipping: {n} verts of {k}")
    inter = intersections(meshes, names) if len(names) < 40 else {}
    report["intersections"] = inter
    report["clipping"] = clip

    # paint the clipping verts into a temporary attribute so the diagnostic pass shows them magenta
    for nm, mask in per_vertex.items():
        ob = bpy.data.objects[nm]
        if not mask.any() or ob.modifiers or len(ob.data.vertices) != len(mask):
            continue  # modifier stacks change the vertex count; the report still lists them
        a = ob.data.attributes.get("qa_clip") or ob.data.attributes.new("qa_clip", "FLOAT", "POINT")
        a.data.foreach_set("value", mask.astype(np.float32))

    m = report["metrics"]
    m["height"] = round(height, 4)
    m["width"] = round(hi.x - lo.x, 4)
    m["depth"] = round(hi.y - lo.y, 4)
    m["min_z"] = round(lo.z, 4)
    m["total_tris"] = total_tris
    head = next((o for o in objs if "head" in o.name.lower() and o.type == "MESH"), None)
    if head:
        hlo, hhi = world_bbox([head], dg)
        m["head_height"] = round(hhi.z - hlo.z, 4)
        m["heads_tall"] = round(height / max(hhi.z - hlo.z, 1e-6), 3)
    m["per_object_dims"] = {}
    for ob in objs:
        olo, ohi = world_bbox([ob], dg)
        m["per_object_dims"][ob.name] = [round(x, 4) for x in (ohi - olo)] + [round(x, 4) for x in (olo + ohi) / 2]
    if abs(lo.z) > 0.01 * max(height, 1e-6):
        report["issues"].append(f"feet are not on Z = 0 (lowest point {lo.z:.4f})")

    if args.baseline and os.path.exists(args.baseline):
        base = json.load(open(args.baseline))
        drift = []
        for k in ("height", "width", "depth", "heads_tall", "head_height"):
            if k in base and k in m and base[k]:
                rel = (m[k] - base[k]) / base[k]
                if abs(rel) > args.drift:
                    drift.append(f"{k} {base[k]} -> {m[k]} ({rel:+.1%})")
        for nm, dims in m["per_object_dims"].items():
            b = base.get("per_object_dims", {}).get(nm)
            if not b:
                continue
            for i, axis in enumerate("XYZ"):
                if b[i] > 1e-4 and abs(dims[i] - b[i]) / b[i] > args.drift:
                    drift.append(f"{nm} size {axis} {b[i]} -> {dims[i]}")
            for i, axis in enumerate("XYZ"):
                if abs(dims[3 + i] - b[3 + i]) > args.drift * max(height, 1e-6):
                    drift.append(f"{nm} moved on {axis} {b[3 + i]} -> {dims[3 + i]}")
        report["drift"] = drift
        report["issues"] += [f"proportion drift: {d}" for d in drift]

    setup_render(args)
    pivot = build_rig(lo, hi, args.persp)
    beauty = render_views(pivot, out, "")
    contact_sheet(beauty, os.path.join(out, "sheet.png"))
    if not args.no_diag:
        vl = bpy.context.view_layer
        vl.material_override = diag_material()
        diag = render_views(pivot, out, "diag_")
        vl.material_override = None
        contact_sheet(diag, os.path.join(out, "diag_sheet.png"))

    json.dump(report, open(os.path.join(out, "report.json"), "w"), indent=2)
    json.dump(m, open(os.path.join(out, "metrics.json"), "w"), indent=2)
    lines = [f"# 4-view QA: {os.path.basename(bpy.data.filepath) or 'unsaved scene'}", "",
             f"Height {m['height']} m, width {m['width']} m, depth {m['depth']} m, {total_tris} tris in total."]
    if "heads_tall" in m:
        lines.append(f"Head height {m['head_height']} m, {m['heads_tall']} heads tall.")
    lines += ["", "## Issues" if report["issues"] else "## Issues: none found by the automatic checks", ""]
    lines += [f"- {i}" for i in report["issues"]]
    if inter:
        lines += ["", "## Mesh intersections (triangle pairs; expected only where pieces are meant to touch)", ""]
        lines += [f"- {k}: {n}" for k, n in sorted(inter.items(), key=lambda x: -x[1])]
    lines += ["", "## Pieces", "", "| object | tris | non-manifold | inverted | scale ok |", "|---|---|---|---|---|"]
    for r in report["objects"]:
        lines.append(f"| {r['name']} | {r.get('tris', 0)} | {r.get('non_manifold_edges', '-')} | "
                     f"{r.get('inverted_closed_pieces', '-')} | {'yes' if r['scale_applied'] else 'NO'} |")
    lines += ["", "Now LOOK at sheet.png and diag_sheet.png (see the skill's inspection checklist)."]
    open(os.path.join(out, "report.md"), "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
