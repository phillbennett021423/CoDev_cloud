"""Automatic game retopology + Kenny's topology checks (masterclass ch. 6-8, retopo series).

Kenny retopologises by hand: rings of 8 around the eyes, nose and mouth, a nasolabial loop, face contour,
even counts down the limbs, matching neck (14) and wrist (20) rings, bevel patches at the elbow and knee. We
can't hand-place loops headless, so this script:
  1 builds an all-quad low mesh from the high (image-to-3D head, remeshed sculpt, cloth) with QuadriFlow
    (symmetry X, target face count), falling back to a planar+collapse Decimate if QuadriFlow fails
  2 projects it back onto the high (Shrinkwrap Project/Nearest, then Smooth Corrective to relax) and
  3 optionally transfers detail the Kenny way: Multires on the low, Shrinkwrap the levels onto the high,
    then either keep it for a normal bake or Apply Base (VAAhoJAIm0E)
  4 REPORTS the things Kenny checks: tris, quad share, n-gons, poles (valence 3/5 fine, 6+ = pinch),
    open boundary rings with their vertex counts and heights (neck ring must match the body's, wrist 20),
    how far the high surface is from the low (mean / p95 / max mm: lost detail).

    python retopo_auto.py -- --blend char_head.blend --high GEO-head --faces 2500 --name GEO-head-low --out low.blend
    python retopo_auto.py -- --blend low.blend --check GEO-body       (report only)
For hero faces, use the report to fix the loops by hand afterwards (eye and mouth rings), or retopologise the
face by hand from Kenny's loop plan (references/) and let this script check it.
"""
import argparse
import json
import os
import statistics
import sys

import bpy
import bmesh
from mathutils.bvhtree import BVHTree


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--blend")
    p.add_argument("--high", help="high-res source object")
    p.add_argument("--name", help="name of the new low object (default <high>-low)")
    p.add_argument("--faces", type=int, default=3000, help="QuadriFlow target faces (quads); tris = about 2x")
    p.add_argument("--no-symmetry", action="store_true")
    p.add_argument("--detail", choices=["none", "multires", "apply-base"], default="none")
    p.add_argument("--check", help="only report on this object (comma list ok)")
    p.add_argument("--out")
    p.add_argument("--report")
    return p.parse_args(argv)


def topo_report(o, high=None):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.transform(o.matrix_world)
    faces = len(bm.faces)
    quads = sum(1 for f in bm.faces if len(f.verts) == 4)
    ngons = sum(1 for f in bm.faces if len(f.verts) > 4)
    tris = sum(len(f.verts) - 2 for f in bm.faces)
    interior = [v for v in bm.verts if not v.is_boundary]
    val = [len(v.link_edges) for v in interior]
    poles = {"3": val.count(3), "5": val.count(5), "6+": sum(1 for x in val if x >= 6)}
    # boundary rings
    rings, seen = [], set()
    for e in bm.edges:
        if not e.is_boundary or e in seen:
            continue
        ring, cur, v = [], e, e.verts[0]
        while cur and cur not in seen:
            seen.add(cur)
            ring.append(v)
            v = cur.other_vert(v)
            nxt = [x for x in v.link_edges if x.is_boundary and x not in seen]
            cur = nxt[0] if nxt else None
        zs = [x.co.z for x in ring]
        xs = [x.co.x for x in ring]
        rings.append({"verts": len(ring), "z": round(sum(zs) / len(zs), 3), "x": round(sum(xs) / len(xs), 3)})
    rep = {"tris": tris, "faces": faces, "quad_share": round(quads / max(faces, 1), 3), "ngons": ngons,
           "poles": poles, "boundary_rings": sorted(rings, key=lambda r: -r["z"])}
    if high is not None:
        # high -> low distance: how much of the high's shape the low LOSES (low -> high is ~0 after Shrinkwrap)
        bvh = BVHTree.FromBMesh(bm)
        hb = bmesh.new()
        hb.from_mesh(high.data)
        hb.transform(high.matrix_world)
        d = [bvh.find_nearest(v.co)[3] for v in hb.verts]
        d = [x for x in d if x is not None]
        hb.free()
        if d:
            d.sort()
            rep["deviation_mm"] = {"mean": round(statistics.mean(d) * 1000, 2),
                                   "p95": round(d[int(len(d) * 0.95)] * 1000, 2), "max": round(d[-1] * 1000, 2)}
    bm.free()
    return rep


def build_low(high, args):
    low = high.copy()
    low.data = high.data.copy()
    low.name = args.name or f"{high.name}-low"
    low.data.name = low.name
    for c in high.users_collection:
        c.objects.link(low)
    low.modifiers.clear()
    bpy.ops.object.select_all(action="DESELECT")
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    method = "quadriflow"
    try:
        r = bpy.ops.object.quadriflow_remesh(target_faces=args.faces, use_mesh_symmetry=not args.no_symmetry,
                                             use_preserve_sharp=False, use_preserve_boundary=True,
                                             smooth_normals=False, mode="FACES", seed=0)
        if "FINISHED" not in r or len(low.data.polygons) < args.faces * 0.3:
            raise RuntimeError("quadriflow gave too few faces")
    except Exception as ex:  # QuadriFlow needs a clean manifold; fall back to decimate
        print("QuadriFlow failed:", ex, "-> decimate")
        method = "decimate"
        low.data = high.data.copy()
        m = low.modifiers.new("Decimate", "DECIMATE")
        m.ratio = min(1.0, args.faces * 2 / max(1, sum(len(p.vertices) - 2 for p in low.data.polygons)))
        m.use_symmetry = not args.no_symmetry
        bpy.ops.object.modifier_apply(modifier=m.name)
    # project back on the high and relax (Kenny: Shrinkwrap + Relax/Smooth brush)
    sw = low.modifiers.new("Shrinkwrap", "SHRINKWRAP")
    sw.target = high
    sw.wrap_method = "NEAREST_SURFACEPOINT"
    cs = low.modifiers.new("Relax", "CORRECTIVE_SMOOTH")
    cs.iterations = 5
    cs.smooth_type = "LENGTH_WEIGHTED"
    cs.use_only_smooth = True
    cs.rest_source = "ORCO"
    sw2 = low.modifiers.new("Shrinkwrap2", "SHRINKWRAP")
    sw2.target = high
    sw2.wrap_method = "NEAREST_SURFACEPOINT"
    for m in list(low.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)
    for p in low.data.polygons:
        p.use_smooth = True
    if args.detail != "none":
        mr = low.modifiers.new("Multires", "MULTIRES")
        for _ in range(2):
            bpy.ops.object.multires_subdivide(modifier=mr.name, mode="CATMULL_CLARK")
        sw3 = low.modifiers.new("ShrinkDetail", "SHRINKWRAP")
        sw3.target = high
        sw3.wrap_method = "PROJECT"
        sw3.use_negative_direction = True
        bpy.ops.object.modifier_apply(modifier=sw3.name)  # applied INTO the multires levels
        if args.detail == "apply-base":
            bpy.ops.object.multires_base_apply(modifier=mr.name)
            low.modifiers.remove(mr)
    high.hide_render = True
    high.hide_set(True)
    return low, method


def main():
    args = parse()
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.blend))
    out = {}
    if args.check:
        for n in args.check.split(","):
            out[n] = topo_report(bpy.data.objects[n])
    else:
        high = bpy.data.objects[args.high]
        low, method = build_low(high, args)
        out[low.name] = topo_report(low, high)
        out[low.name]["method"] = method
        if args.out:
            bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.out))
    print(json.dumps(out, indent=1))
    rp = args.report or (os.path.splitext(args.out)[0] + "_topo.json" if args.out else None)
    if rp:
        with open(rp, "w") as f:
            json.dump(out, f, indent=1)


if __name__ == "__main__":
    main()
