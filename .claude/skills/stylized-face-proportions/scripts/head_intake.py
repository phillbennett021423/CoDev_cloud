"""Image-to-3D head (or full character) intake and cleanup: our replacement for Kenny's sphere-sculpted head.

Image-to-3D models arrive messy: random orientation and scale, triangle soup, duplicate verts, floating
bits, asymmetric noise, flipped normals, baked-in lighting textures. This does the cleanup Kenny's
sculpt would give us for free:
  1 import (.glb/.gltf/.obj/.fbx/.ply/.stl), join the meshes, apply all transforms
  2 orient: --forward tells which axis the face looks along in the file; it is rotated to face -Y, Z up
  3 scale so the head is --head-height metres tall (or the whole model --height), feet/chin on --base-z,
    centred at x = 0, y = 0
  4 clean: merge by distance, delete loose parts smaller than --min-part of the biggest, recalc normals outside,
    fill small holes
  5 --symmetrize: bisect at x = 0 and mirror +X to -X (Kenny keeps X symmetry ON for heads)
  6 --remesh VOXEL (m) then --decimate to --tris: a clean, even surface to retopologise or to use as a
    Shrinkwrap/bake source. The original stays hidden as REF-<name>-raw for colour/normal baking.
    python head_intake.py -- --in head.glb --forward=+Y --head-height 0.24 --base-z 1.46 --symmetrize \
        --remesh 0.004 --tris 20000 --name GEO-head --into char.blend --out char_head.blend
"""
import argparse
import math
import os
import sys

import bpy
import bmesh
from mathutils import Matrix, Vector

AXES = {"+X": Vector((1, 0, 0)), "-X": Vector((-1, 0, 0)), "+Y": Vector((0, 1, 0)), "-Y": Vector((0, -1, 0)),
        "+Z": Vector((0, 0, 1)), "-Z": Vector((0, 0, -1))}


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="inp", required=True)
    p.add_argument("--into", help="open this .blend first and add the head to it")
    p.add_argument("--name", default="GEO-head")
    p.add_argument("--forward", default="-Y", choices=sorted(AXES), help="axis the face looks along in the file")
    p.add_argument("--up", default="+Z", choices=sorted(AXES), help="up axis in the file (after import)")
    p.add_argument("--head-height", type=float, help="target crown-to-chin(-or-neck-cut) height in m")
    p.add_argument("--height", type=float, help="target height of the whole model in m")
    p.add_argument("--base-z", type=float, default=0.0, help="z of the lowest point after scaling")
    p.add_argument("--min-part", type=float, default=0.05, help="delete loose parts below this share of verts")
    p.add_argument("--symmetrize", action="store_true")
    p.add_argument("--remesh", type=float, default=0.0, help="voxel size in m (0 = keep the topology)")
    p.add_argument("--tris", type=int, default=0, help="decimate to about this many triangles")
    p.add_argument("--out")
    return p.parse_args(argv)


def do_import(path):
    before = set(bpy.data.objects)
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".ply":
        bpy.ops.wm.ply_import(filepath=path)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=path)
    else:
        raise SystemExit(f"unsupported {ext}")
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    if not meshes:
        raise SystemExit("no mesh in the file")
    return meshes, [o for o in new if o.type != "MESH"]


def tri_count(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


def drop_loose(me, min_part):
    """delete floaters BEFORE measuring: one stray blob ruins the centring, scale and the x = 0 symmetry plane"""
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
    # loose parts
    parts, seen = [], set()
    for v in bm.verts:
        if v in seen:
            continue
        comp, stack = [], [v]
        seen.add(v)
        while stack:
            c = stack.pop()
            comp.append(c)
            for e in c.link_edges:
                w = e.other_vert(c)
                if w not in seen:
                    seen.add(w)
                    stack.append(w)
        parts.append(comp)
    big = max(len(p) for p in parts)
    junk = [v for p in parts if len(p) < min_part * big for v in p]
    bmesh.ops.delete(bm, geom=junk, context="VERTS")
    bm.to_mesh(me)
    bm.free()
    return len(junk)


def main():
    args = parse()
    if args.into:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.into))
    meshes, extras = do_import(os.path.abspath(args.inp))
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    for o in meshes:  # unparent but keep the world transform, so empties' scale/rotation are not lost
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    if len(meshes) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    for e in extras:
        bpy.data.objects.remove(e, do_unlink=True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # orient: forward -> -Y, up -> +Z
    f, u = AXES[args.forward], AXES[args.up]
    if abs(f.dot(u)) > 0.5:
        raise SystemExit("--forward and --up must differ")
    src = Matrix((f, u, f.cross(u))).transposed()
    dst = Matrix((Vector((0, -1, 0)), Vector((0, 0, 1)), Vector((0, -1, 0)).cross(Vector((0, 0, 1))))).transposed()
    rot = (dst @ src.inverted()).to_4x4()
    ob.data.transform(rot)
    dropped = drop_loose(ob.data, args.min_part)

    # scale + place
    vs = [v.co for v in ob.data.vertices]
    lo = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
    hi = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
    h = hi.z - lo.z
    target = args.head_height or args.height
    s = target / h if target else 1.0
    centre = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    ob.data.transform(Matrix.Translation(Vector((0, 0, args.base_z))) @ Matrix.Scale(s, 4) @ Matrix.Translation(-centre))
    ob.data.update()

    # keep the raw scan for colour/normal bakes
    raw = ob.copy()
    raw.data = ob.data.copy()
    raw.name = f"REF-{args.name}-raw"
    for c in ob.users_collection:
        c.objects.link(raw)
    raw.hide_render = True
    raw.hide_set(True)

    # clean
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=0.0002 * (target or h))
    bmesh.ops.holes_fill(bm, edges=bm.edges[:], sides=12)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    if args.symmetrize:
        n_before = len(bm.verts)
        geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
        bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, 0), plane_no=(1, 0, 0), clear_inner=True)
        if len(bm.verts) < 0.3 * n_before:
            raise SystemExit("symmetrize would keep under 30% of the model: it is not centred on x = 0 "
                             "(check --forward/--up, or floaters bigger than --min-part)")
        for v in bm.verts:
            if abs(v.co.x) < 1e-5:
                v.co.x = 0
        res = bmesh.ops.duplicate(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:])
        dverts = [g for g in res["geom"] if isinstance(g, bmesh.types.BMVert)]
        bmesh.ops.scale(bm, vec=(-1, 1, 1), verts=dverts)
        dfaces = [g for g in res["geom"] if isinstance(g, bmesh.types.BMFace)]
        bmesh.ops.reverse_faces(bm, faces=dfaces)
        bmesh.ops.remove_doubles(bm, verts=[v for v in bm.verts if abs(v.co.x) < 1e-4], dist=1e-4)
    bm.to_mesh(ob.data)
    bm.free()
    ob.name = args.name
    ob.data.name = args.name

    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    if args.remesh > 0:
        m = ob.modifiers.new("Remesh", "REMESH")
        m.mode = "VOXEL"
        m.voxel_size = args.remesh
        m.use_smooth_shade = True
        bpy.ops.object.modifier_apply(modifier=m.name)
    if args.tris and tri_count(ob.data) > args.tris:
        m = ob.modifiers.new("Decimate", "DECIMATE")
        m.ratio = args.tris / tri_count(ob.data)
        m.use_symmetry = args.symmetrize
        m.symmetry_axis = "X"
        bpy.ops.object.modifier_apply(modifier=m.name)
    for p in ob.data.polygons:
        p.use_smooth = True
    lo_z = min(v.co.z for v in ob.data.vertices)
    hi_z = max(v.co.z for v in ob.data.vertices)
    print(f"{ob.name}: {tri_count(ob.data)} tris, {hi_z - lo_z:.3f} m tall, z {lo_z:.3f}..{hi_z:.3f}; raw kept as {raw.name}, {dropped} floater verts removed")
    if args.out:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.out))


if __name__ == "__main__":
    main()
