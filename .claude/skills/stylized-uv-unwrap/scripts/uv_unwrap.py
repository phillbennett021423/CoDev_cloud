"""UV unwrap a stylized character the Kenny Praise way (masterclass ch. 9), headless.

Kenny's 3 steps: 1 cut seams, 2 fix stretching, 3 arrange. This script does:
  1. Seams: keeps seams you (or the retopo script) already marked. Adds seams on the borders of vertex groups
     you name (--seam-groups), on the back centre line (--back-seam, Kenny's back-of-head / back seam), and on
     sharp edges (--sharp-angle). An object with NO seams falls back to Smart UV Project (reported, so you
     know to mark real seams for a hero asset).
  2. Unwrap: Minimum Stretch (Kenny: better than Angle Based for characters), Average Islands Scale.
  3. Texel density priority: --priority GEO-head:1.6,GEO-hand:1.2,GEO-pants:0.7 (Kenny scales the face UP and
     unseen parts DOWN), then ONE shared atlas: Pack Islands (rotation on, margin) over all objects together.
  4. Report: islands, stretch (area and angle distortion), texel density in px/m at the target texture size,
     overlaps. Optional checker preview .blend (Kenny's 'UV grid' Color Grid checker) for the 4-view QA.

    python uv_unwrap.py -- --blend char.blend --objects GEO-body,GEO-head,GEO-shirt --tex 1024 \
        --priority GEO-head:1.6 --back-seam GEO-head --out char_uv.blend --checker-out char_checker.blend
    then: render_4view.py -- --blend char_checker.blend --out qa_uv   (look at the checker: even squares)
"""
import argparse
import json
import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--blend")
    p.add_argument("--objects", help="comma list (default: all visible render meshes except REF-/QA_)")
    p.add_argument("--uv-name", default="UVMap")
    p.add_argument("--seam-groups", default="", help="vertex groups whose borders become seams")
    p.add_argument("--back-seam", default="", help="objects that get a seam on the back centre line (x=0, y>0)")
    p.add_argument("--sharp-angle", type=float, default=0.0, help="mark edges sharper than this (deg) as seams")
    p.add_argument("--keep-uvs", action="store_true", help="don't unwrap, only re-pack and report")
    p.add_argument("--priority", default="", help="obj:scale,... texel-density multipliers")
    p.add_argument("--max-stretch", type=float, default=0.6,
                   help="an object whose seams give more area stretch than this (or collapsed faces) is redone "
                        "with Smart UV Project and flagged: mark proper seams on it for a hero asset")
    p.add_argument("--margin", type=float, default=0.008, help="island gap; 0.008 = 8 px at 1024 (bake bleed 4 px)")
    p.add_argument("--tex", type=int, default=1024, help="target texture size for the texel report")
    p.add_argument("--out")
    p.add_argument("--checker-out", help="save a copy with a Color Grid checker on every object")
    p.add_argument("--report", default=None, help="json report path (default next to --out)")
    return p.parse_args(argv)


def pick_objects(args):
    if args.objects:
        return [bpy.data.objects[n] for n in args.objects.split(",")]
    return [o for o in bpy.context.scene.objects if o.type == "MESH" and not o.hide_render
            and not o.name.startswith(("REF-", "QA_"))]


def mark_seams(o, args):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    added = 0
    groups = [g for g in args.seam_groups.split(",") if g and g in o.vertex_groups]
    if groups:
        dl = bm.verts.layers.deform.verify()
        for g in groups:
            gi = o.vertex_groups[g].index
            inside = {v for v in bm.verts if dl in v and v[dl].get(gi, 0) > 0.5}
            for e in bm.edges:
                # border = edge whose two faces are on different sides of the group
                fs = e.link_faces
                if len(fs) == 2:
                    a = all(v in inside for v in fs[0].verts)
                    b = all(v in inside for v in fs[1].verts)
                    if a != b and not e.seam:
                        e.seam = True
                        added += 1
    if o.name in args.back_seam.split(","):
        eps = max(1e-4, 0.002 * (max(v.co.z for v in bm.verts) - min(v.co.z for v in bm.verts)))
        for e in bm.edges:
            if all(abs(v.co.x) < eps and v.co.y > 0 for v in e.verts) and not e.seam:
                e.seam = True
                added += 1
    if args.sharp_angle > 0:
        lim = math.radians(args.sharp_angle)
        for e in bm.edges:
            if len(e.link_faces) == 2 and e.calc_face_angle(0) > lim and not e.seam:
                e.seam = True
                added += 1
    has = any(e.seam for e in bm.edges)
    bm.to_mesh(o.data)
    bm.free()
    return added, has


def edit(objs):
    bpy.ops.object.mode_set(mode="OBJECT") if bpy.context.object and bpy.context.object.mode != "OBJECT" else None
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.context.scene.tool_settings.use_uv_select_sync = True


def uv_stats(o, tex):
    """area-weighted stretch: how far each face's UV/3D area ratio is from the object's mean,
    plus texel density (px per metre) = sqrt(uv_area / world_area) * tex."""
    me = o.data
    uv = me.uv_layers.active.data
    mw = o.matrix_world
    rows = []
    for p in me.polygons:
        wpts = [mw @ me.vertices[i].co for i in p.vertices]
        a3 = sum(((wpts[0] - wpts[k]).cross(wpts[0] - wpts[k + 1])).length / 2 for k in range(1, len(wpts) - 1))
        upts = [Vector((*uv[li].uv, 0)) for li in p.loop_indices]
        a2 = sum(((upts[0] - upts[k]).cross(upts[0] - upts[k + 1])).length / 2 for k in range(1, len(upts) - 1))
        if a3 > 1e-10:
            rows.append((a3, a2))
    tot3 = sum(r[0] for r in rows) or 1
    tot2 = sum(r[1] for r in rows)
    mean = tot2 / tot3
    dev = sum(r[0] * abs(math.log((r[1] / r[0] + 1e-12) / (mean + 1e-12))) for r in rows) / tot3
    zero = sum(1 for r in rows if r[1] < 1e-9)
    return dict(uv_area=round(tot2, 4), world_area_m2=round(tot3, 4),
                texel_px_per_m=round(math.sqrt(max(mean, 0)) * tex, 1),
                area_stretch=round(dev, 3), zero_area_uv_faces=zero)


def islands(o):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    uvl = bm.loops.layers.uv.active
    seen, n = set(), 0
    for f in bm.faces:
        if f in seen:
            continue
        n += 1
        stack = [f]
        seen.add(f)
        while stack:
            c = stack.pop()
            for e in c.edges:
                if e.seam:
                    continue
                for g in e.link_faces:
                    if g not in seen:
                        seen.add(g)
                        stack.append(g)
    bm.free()
    return n


def checker_copy(objs, path, tex):
    img = bpy.data.images.new("UV grid", tex, tex)
    img.generated_type = "COLOR_GRID"
    mat = bpy.data.materials.new("QA_checker")
    mat.use_nodes = True
    nt = mat.node_tree
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = img
    nt.links.new(t.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
    for o in objs:
        o.data.materials.clear()
        o.data.materials.append(mat)
    img.pack()
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(path), copy=True)


def main():
    args = parse()
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.blend))
    objs = pick_objects(args)
    report = {"objects": {}}
    smart = []
    for o in objs:
        if not o.data.uv_layers:
            o.data.uv_layers.new(name=args.uv_name)
        added, has = mark_seams(o, args)
        report["objects"][o.name] = {"seams_added": added}
        if not has:
            smart.append(o)

    if not args.keep_uvs:
        seamed = [o for o in objs if o not in smart]
        if seamed:
            edit(seamed)
            bpy.ops.uv.unwrap(method="MINIMUM_STRETCH", margin=args.margin)
            bpy.ops.object.mode_set(mode="OBJECT")
        for o in smart:
            edit([o])
            bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=args.margin)
            bpy.ops.object.mode_set(mode="OBJECT")
            report["objects"][o.name]["fallback"] = "smart_project (no seams marked)"

    # 1b. a closed tube with too few seams collapses (zero-area UV faces) or stretches: redo it as auto islands
    if not args.keep_uvs:
        for o in objs:
            if o in smart:
                continue
            st = uv_stats(o, args.tex)
            if st["zero_area_uv_faces"] > 0 or st["area_stretch"] > args.max_stretch:
                edit([o])
                bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=args.margin)
                bpy.ops.object.mode_set(mode="OBJECT")
                smart.append(o)
                report["objects"][o.name]["fallback"] = (
                    f"smart_project (seams gave stretch {st['area_stretch']}, {st['zero_area_uv_faces']} collapsed faces)")

    # 2. equal texel density, then the per-object priority multipliers
    edit(objs)
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.average_islands_scale()
    bpy.ops.object.mode_set(mode="OBJECT")
    pri = dict((k, float(v)) for k, v in (t.split(":") for t in args.priority.split(",") if t))
    for o in objs:
        s = pri.get(o.name, 1.0)
        if s != 1.0:
            for d in o.data.uv_layers.active.data:
                d.uv = (d.uv - Vector((0.5, 0.5))) * s + Vector((0.5, 0.5))
    # 3. one shared atlas
    edit(objs)
    bpy.ops.uv.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(rotate=True, scale=True, margin=args.margin)
    bpy.ops.object.mode_set(mode="OBJECT")

    for o in objs:
        st = uv_stats(o, args.tex)
        st["islands"] = islands(o) if o not in smart else "auto"
        report["objects"][o.name].update(st)
    dens = [r["texel_px_per_m"] for r in report["objects"].values()]
    report["tex"] = args.tex
    report["texel_range_px_per_m"] = [min(dens), max(dens)]
    print(json.dumps(report, indent=1))
    if args.out:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.out))
    rp = args.report or (os.path.splitext(args.out)[0] + "_uv_report.json" if args.out else None)
    if rp:
        with open(rp, "w") as f:
            json.dump(report, f, indent=1)
    if args.checker_out:
        checker_copy(objs, args.checker_out, args.tex)


if __name__ == "__main__":
    main()
