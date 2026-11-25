"""Clothes from the body, Kenny Praise style (v_WMJLudpvg, masterclass ch. 5 and 8), with no hand modelling.

Kenny blocks clothes OUT OF THE BODY: duplicate the body faces, Shrinkwrap them to the body with a small
offset, Subsurf, apply, then sculpt folds on a Multires and add thickness with Solidify. The Solidify rim and
shell go into their own vertex groups, and each gets a Smooth modifier (repeat 3 on the rim, 4 on the shell),
so hems read soft instead of boxy. This script does that for a garment preset, or for a vertex group you
painted on the body.

    python cloth_from_body.py -- --blend body.blend --body GEO-body --garment shirt --out dressed.blend
    python cloth_from_body.py -- --blend body.blend --body GEO-body --group pants_area --name GEO-pants
    python cloth_from_body.py -- --blend dressed.blend --z 0.565,0.6 --x 0.15 --layer 2 --thickness 0.012 --name GEO-belt
    add --cut-body to DELETE the body faces hidden under the cloth (games: fewer tris, no poke-through)

Presets use fractions of the body height (feet on Z = 0): shirt, tshirt, tanktop, pants, shorts, skirt_base.
Thickness defaults to Kenny's 0.007 m. Run the 4-view QA afterwards: magenta in diag_sheet = body poking through.
"""
import argparse
import os
import sys

import bpy
import bmesh
from mathutils import Vector

# z range (fraction of height) and sleeve/leg cut-off: |x| limit as a fraction of height (None = no limit)
GARMENTS = {
    # layer 0 sits on the skin, layer 1 goes over layer 0 (the shirt hem over the pants waist):
    # offset = 0.006 + layer * (thickness + 0.004)
    "shirt":      dict(z=(0.47, 0.79), x=0.36, layer=1),   # long sleeves to the wrist (A-pose)
    "tshirt":     dict(z=(0.47, 0.79), x=0.215, layer=1),
    "tanktop":    dict(z=(0.47, 0.78), x=0.105, layer=1),
    "pants":      dict(z=(0.055, 0.60), x=0.15, layer=0),  # x limit keeps the A-posed forearms out
    "shorts":     dict(z=(0.33, 0.60), x=0.15, layer=0),
    "skirt_base": dict(z=(0.36, 0.60), x=0.15, layer=0),   # then pull the hem out (or proxy + Surface Deform)
}


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--blend")
    p.add_argument("--body", default="GEO-body")
    p.add_argument("--garment", choices=sorted(GARMENTS))
    p.add_argument("--group", help="vertex group on the body that marks the garment area (overrides --garment)")
    p.add_argument("--z", help="custom band: z0,z1 as fractions of height (belt: 0.57,0.6)")
    p.add_argument("--x", type=float, help="custom |x| limit as a fraction of height")
    p.add_argument("--garment-z", help="override the garment's z0,z1 (fractions of height), e.g. a cropped jacket")
    p.add_argument("--layer", type=int, help="custom layer (0 skin, 1 over layer 0, 2 belts/straps)")
    p.add_argument("--name")
    p.add_argument("--offset", type=float, help="Shrinkwrap offset (m)")
    p.add_argument("--thickness", type=float, default=0.007, help="Solidify thickness (Kenny: 0.007)")
    p.add_argument("--subsurf", type=int, default=1)
    p.add_argument("--hem-relax", type=int, default=8, help="relax iterations on open edges (0 = off)")
    p.add_argument("--cut-body", action="store_true", help="delete body faces fully hidden under the cloth")
    p.add_argument("--keep-modifiers", action="store_true", help="leave Solidify/Smooth live (default: apply)")
    p.add_argument("--color", default="0.18,0.24,0.42")
    p.add_argument("--out")
    return p.parse_args(argv)


def region_faces(body, args):
    me = body.data
    mw = body.matrix_world
    zs = [(mw @ v.co).z for v in me.vertices]
    z0 = min(zs)
    # character height = top of ANY mesh (the head is often a separate object), not just the body
    top = max((o.matrix_world @ Vector(c)).z for o in bpy.context.scene.objects
              if o.type == "MESH" and not o.hide_render for c in o.bound_box)
    h = top - z0
    if args.group:
        gi = body.vertex_groups[args.group].index
        inside = {v.index for v in me.vertices if any(g.group == gi and g.weight > 0.5 for g in v.groups)}
    else:
        g = dict(GARMENTS[args.garment]) if args.garment else dict(z=(0.0, 1.0), x=None, layer=0)
        if args.z:
            g["z"] = tuple(float(t) for t in args.z.split(","))
        if args.garment_z:  # reshape a garment (cropped jacket, capri pants) without turning it into a band
            g["z"] = tuple(float(t) for t in args.garment_z.split(","))
        if args.x is not None:
            g["x"] = args.x
        lo, hi = z0 + g["z"][0] * h, z0 + g["z"][1] * h
        inside = set()
        for v in me.vertices:
            w = mw @ v.co
            if lo <= w.z <= hi and (g["x"] is None or abs(w.x) <= g["x"] * h):
                inside.add(v.index)
    if args.z and not args.group:
        # thin bands (belts, straps) can be narrower than one face ring: take faces whose centre is inside
        g0, g1 = (z0 + float(t) * h for t in args.z.split(","))
        xl = args.x * h if args.x is not None else None
        out = []
        for p in me.polygons:
            c = mw @ p.center
            if g0 <= c.z <= g1 and (xl is None or abs(c.x) <= xl):
                out.append(p.index)
        return out, h
    return [p.index for p in me.polygons if all(i in inside for i in p.vertices)], h


def band_ring(ref, args, h, offset, segments=48, rows=4):
    from mathutils.bvhtree import BVHTree
    import math
    mw = ref.matrix_world
    bmw = bmesh.new()
    bmw.from_mesh(ref.data)
    bmw.transform(mw)
    bvh = BVHTree.FromBMesh(bmw)
    zmin = min(v.co.z for v in bmw.verts)
    g0, g1 = (zmin + float(t) * h for t in args.z.split(","))
    xl = (args.x if args.x is not None else 0.15) * h
    out = bmesh.new()
    rings = []
    for r in range(rows):
        z = g0 + (g1 - g0) * r / (rows - 1)
        near = [v.co for v in bmw.verts if abs(v.co.z - z) < 0.03 and abs(v.co.x) < xl]
        if not near:
            raise SystemExit(f"no body at z={z:.3f}")
        c = sum(near, Vector()) / len(near)
        c.z = z
        ring = []
        for i in range(segments):
            a = 2 * math.pi * i / segments
            d = Vector((math.sin(a), -math.cos(a), 0))
            hit, n, _, _ = bvh.ray_cast(c, d, 1.0)
            if hit is None:
                raise SystemExit(f"band ray missed the body at z={z:.3f}")
            n = Vector((n.x, n.y, 0)).normalized() if n.xy.length > 1e-4 else d
            ring.append(out.verts.new(mw.inverted() @ (hit + n * offset)))
        rings.append(ring)
    for r in range(rows - 1):
        for i in range(segments):
            j = (i + 1) % segments
            out.faces.new((rings[r][i], rings[r][j], rings[r + 1][j], rings[r + 1][i]))
    bmesh.ops.recalc_face_normals(out, faces=out.faces[:])
    bmw.free()
    return out


def main():
    args = parse()
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.blend))
    body = bpy.data.objects[args.body]
    # an untouched copy of the body is the Shrinkwrap target, so a body cut by an earlier garment
    # (--cut-body) never makes the next garment snap into holes
    ref = bpy.data.objects.get("REF-" + body.name)
    if ref is None:
        ref = bpy.data.objects.new("REF-" + body.name, body.data.copy())
        ref.matrix_world = body.matrix_world.copy()
        for c in body.users_collection:
            c.objects.link(ref)
        ref.hide_render = True
        ref.hide_set(True)
    faces, h = region_faces(ref, args)  # the uncut copy: earlier --cut-body passes leave holes in the body
    if not args.garment and not args.group and not args.z:
        raise SystemExit("give --garment, --group or --z")
    if not faces and not args.z:
        raise SystemExit("no faces in the garment region")
    name = args.name or f"GEO-{args.garment or args.group or 'band'}"
    layer = GARMENTS[args.garment]["layer"] if args.garment else 0
    if args.layer is not None:
        layer = args.layer
    offset = args.offset if args.offset is not None else 0.006 + layer * (args.thickness + 0.004)

    # 1. duplicate the faces into a new object (Kenny: Shift D, P > Selection)
    bm = bmesh.new()
    bm.from_mesh(ref.data)
    if args.z and not args.group:
        # bands (belts, straps, cuffs): a clean quad ring built by casting rays from the torso centre outward,
        # so it is a full, even loop even on a coarse body (Kenny: belt = a loop extruded off the pants)
        bm.free()
        bm = band_ring(ref, args, h, offset)
    else:
        keep = set(faces)
        for f in list(bm.faces):
            if f.index not in keep:
                bm.faces.remove(f)
    for v in list(bm.verts):
        if not v.link_faces:
            bm.verts.remove(v)
    # slivers and near-duplicate verts make Solidify's even offset throw spikes
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=0.003)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges[:], dist=0.002)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    cloth = bpy.data.objects.new(name, me)
    cloth.matrix_world = body.matrix_world.copy()
    for c in body.users_collection:
        c.objects.link(cloth)
    for vg in list(cloth.vertex_groups):
        cloth.vertex_groups.remove(vg)
    bpy.context.view_layer.objects.active = cloth
    bpy.ops.object.select_all(action="DESELECT")
    cloth.select_set(True)

    # 1b. relax the open hems/cuffs (Kenny: LoopTools Relax on every opening) before the Shrinkwrap re-projects them,
    #     so they read as clean lines, not the stair-step of the body's face rows
    bm = bmesh.new()
    bm.from_mesh(cloth.data)
    edge_v = [v for v in bm.verts if v.is_boundary]
    for _ in range(0 if (args.z and not args.group) else args.hem_relax):
        new = {}
        for v in edge_v:
            nb = [e.other_vert(v) for e in v.link_edges if e.is_boundary]
            if len(nb) == 2:
                new[v] = v.co * 0.5 + (nb[0].co + nb[1].co) * 0.25
        for v, co in new.items():
            v.co = co
    bm.to_mesh(cloth.data)
    bm.free()

    # 2. Shrinkwrap (offset) + Subsurf, applied: the blockout follows the body (Kenny step 1)
    band = bool(args.z and not args.group)  # the ray-cast ring already sits at the offset
    if args.subsurf > 0 and not band:
        ss = cloth.modifiers.new("Subsurf", "SUBSURF")
        ss.levels = args.subsurf
    if not band:
        sw = cloth.modifiers.new("Shrinkwrap", "SHRINKWRAP")  # LAST, so nothing pulls the cloth back inside
        sw.target = ref
        sw.wrap_method = "NEAREST_SURFACEPOINT"
        sw.wrap_mode = "OUTSIDE_SURFACE"
        sw.offset = offset
    for m in list(cloth.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)

    # 3. thickness: Solidify with rim/shell vertex groups, each smoothed (rim x3, shell x4)
    rim = cloth.vertex_groups.new(name="rim")
    shell = cloth.vertex_groups.new(name="shell")
    so = cloth.modifiers.new("Solidify", "SOLIDIFY")
    so.thickness = args.thickness
    so.offset = 1.0  # grow outward, away from the skin
    so.use_even_offset = True
    so.shell_vertex_group = shell.name
    so.rim_vertex_group = rim.name
    for grp, rep in ((rim, 3), (shell, 4)):
        s = cloth.modifiers.new(f"Smooth_{grp.name}", "SMOOTH")
        s.vertex_group = grp.name
        s.iterations = rep
        s.factor = 0.5
    if not args.keep_modifiers:
        for m in list(cloth.modifiers):
            bpy.ops.object.modifier_apply(modifier=m.name)
    for p in cloth.data.polygons:
        p.use_smooth = True

    mat = bpy.data.materials.new("MAT-" + name[4:])
    mat.use_nodes = True
    col = [float(x) for x in args.color.split(",")]
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (*col, 1)
    mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.7
    cloth.data.materials.append(mat)

    # 4. games: delete the body faces under the cloth, keeping a 1-ring border so no gap opens when it bends
    if args.cut_body:
        bm = bmesh.new()
        bm.from_mesh(body.data)
        bm.faces.ensure_lookup_table()
        hidden = set(region_faces(body, args)[0])  # indices on the (maybe already cut) body itself
        border = {v for i in hidden for v in bm.faces[i].verts
                  if any(f.index not in hidden for f in v.link_faces)}
        kill = [bm.faces[i] for i in hidden if not any(v in border for v in bm.faces[i].verts)]
        bmesh.ops.delete(bm, geom=kill, context="FACES")
        bm.to_mesh(body.data)
        bm.free()
        print(f"cut {len(kill)} hidden body faces")
    tris = sum(len(p.vertices) - 2 for p in cloth.data.polygons)
    print(f"{name}: {tris} tris, offset {offset} m, thickness {args.thickness} m")
    if args.out:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.out))


if __name__ == "__main__":
    main()
