"""Kenny Praise's presentation setup (masterclass ch. 13, YA-MzLhHHb8, 7F0O4ARh43s): cyclorama, 3-point Area
lighting with a light-linked coloured rim, backdrop halo, wide + close-up cameras and a turntable where the
camera, lights AND backdrop rotate together (so the lighting is the same from every side).

    python turntable.py -- --blend hero_posed.blend --out render/ --stills            # wide + close-up PNG
    python turntable.py -- --blend hero.blend --out render/ --turntable --step 8       # every 8th frame of 3-195
    python turntable.py -- --blend hero.blend --out render/ --save-scene hero_present.blend   # just build it
Kenny's numbers: 1200x1500 (portrait) at 150% resolution scale, 80-90 mm lens (85 here), 24 fps x 8 s =
frames 3..195 for the turn (frame 1 = close-up, frame 2 = wide), Cycles ~150 samples (lower for previews),
backdrop dark from the character palette, Roughness 1, Specular 0. Rim much stronger than the key, coloured,
light-linked to EXCLUDE the backdrop. Fill much weaker and larger than the key.
"""
import argparse
import math
import os
import shutil
import subprocess
import sys

import bpy
import bmesh
from mathutils import Vector


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--blend")
    p.add_argument("--out", default="render")
    p.add_argument("--res", default="1200x1500")
    p.add_argument("--scale", type=int, default=150, help="resolution percentage (Kenny: 150)")
    p.add_argument("--samples", type=int, default=150)
    p.add_argument("--lens", type=float, default=85)
    p.add_argument("--backdrop", default="0.05,0.07,0.12", help="dark backdrop colour (pick from the palette)")
    p.add_argument("--rim-color", default="1.0,0.45,0.25")
    p.add_argument("--stills", action="store_true")
    p.add_argument("--turntable", action="store_true")
    p.add_argument("--step", type=int, default=1, help="render every Nth turntable frame")
    p.add_argument("--save-scene")
    return p.parse_args(argv)


def char_bounds():
    objs = [o for o in bpy.context.scene.objects if o.type in {"MESH", "CURVES"} and not o.hide_render
            and not o.name.startswith(("REF-", "QA_", "PRES-"))]
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in objs:
        pts += [o.matrix_world @ Vector(c) for c in o.evaluated_get(dg).bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi, objs


def cyclorama(r, h, col, coll):
    """Kenny: Circle -> fill -> extrude the back half up -> bevel the corner -> smooth (no visible edges)"""
    bm = bmesh.new()
    seg = 64
    ring = [bm.verts.new((r * math.cos(2 * math.pi * i / seg), r * math.sin(2 * math.pi * i / seg), 0))
            for i in range(seg)]
    bm.faces.new(ring)
    back = [v for v in ring if v.co.y > -0.05 * r]
    edges = [e for e in bm.edges if all(v in back for v in e.verts)]
    ext = bmesh.ops.extrude_edge_only(bm, edges=edges)
    nv = [g for g in ext["geom"] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=(0, 0, h), verts=nv)
    corner = [e for e in edges]
    bmesh.ops.bevel(bm, geom=corner, offset=0.35 * r, segments=10, affect="EDGES", profile=0.5)
    me = bpy.data.meshes.new("PRES-backdrop")
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new("PRES-backdrop", me)
    coll.objects.link(ob)
    mat = bpy.data.materials.new("PRES-backdrop")
    mat.use_nodes = True
    b = mat.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*col, 1)
    b.inputs["Roughness"].default_value = 1.0
    b.inputs["Specular IOR Level"].default_value = 0.0
    me.materials.append(mat)
    return ob


def area(name, coll, loc, target, power, size, col=(1, 1, 1), size_y=None):
    ld = bpy.data.lights.new(name, "AREA")
    ld.energy = power
    ld.color = col
    if size_y:
        ld.shape = "RECTANGLE"
        ld.size, ld.size_y = size, size_y
    else:
        ld.size = size
    ob = bpy.data.objects.new(name, ld)
    coll.objects.link(ob)
    ob.location = loc
    d = (target - Vector(loc)).normalized()
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    return ob


def main():
    args = parse()
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.blend))
    sc = bpy.context.scene
    os.makedirs(args.out, exist_ok=True)
    lo, hi, objs = char_bounds()
    H = hi.z - lo.z
    c = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    k = (H / 1.7) ** 2  # Kenny's powers were for a 1.7 m character

    coll = bpy.data.collections.new("PRES-render")
    sc.collection.children.link(coll)
    pivot = bpy.data.objects.new("camera_turnaround_ctrl", None)
    pivot.empty_display_type = "SPHERE"
    pivot.location = c
    coll.objects.link(pivot)

    back = cyclorama(H * 3.0, H * 2.5, [float(x) for x in args.backdrop.split(",")], coll)
    back.location = c + Vector((0, H * 0.6, 0))
    chest = c + Vector((0, 0, H * 0.72))
    key = area("light_key", coll, c + Vector((-1.3 * H, -1.2 * H, 1.35 * H)), chest, 450 * k, 0.6 * H)
    fill = area("light_fill", coll, c + Vector((1.5 * H, -1.0 * H, 0.8 * H)), chest, 90 * k, 1.6 * H)
    rimc = tuple(float(x) for x in args.rim_color.split(","))
    rim = area("light_rim", coll, c + Vector((1.0 * H, 1.1 * H, 1.0 * H)), chest, 1400 * k, 0.12 * H, rimc, 1.1 * H)
    legs = area("light_key_legs", coll, c + Vector((-1.3 * H, -1.2 * H, 0.45 * H)), c + Vector((0, 0, 0.3 * H)),
                0, 0.6 * H)
    legs.data = key.data  # Kenny: Ctrl L Link Object Data, so the pair shares one power
    halo_d = bpy.data.lights.new("light_backdrop", "POINT")
    halo_d.energy = 120 * k
    halo_d.color = (0.35, 0.55, 1.0)
    halo_d.shadow_soft_size = 0.3 * H
    halo = bpy.data.objects.new("light_backdrop", halo_d)
    halo.location = c + Vector((0, 0.45 * H, 0.75 * H))
    coll.objects.link(halo)
    # light linking: the rim must not hot-spot the backdrop (Kenny: Light Linking > Exclude)
    try:
        ex = bpy.data.collections.new("PRES-rim-exclude")
        ex.objects.link(back)
        rim.light_linking.receiver_collection = ex
        idx = list(ex.objects).index(back)  # collection_objects has no name lookup; same order as .objects
        ex.collection_objects[idx].light_linking.link_state = "EXCLUDE"
        linked = True
    except Exception as e:  # older Blender: fall back to a narrower rim
        print("light linking unavailable:", e)
        linked = False
    for ob in (back, key, fill, rim, legs, halo):
        ob.parent = pivot
        ob.matrix_parent_inverse = pivot.matrix_world.inverted()

    world = bpy.data.worlds.new("PRES-world")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.4, 0.42, 0.48, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.12
    sc.world = world

    def camera(name, lens, target, dist_h):
        cd = bpy.data.cameras.new(name)
        cd.lens = lens
        cam = bpy.data.objects.new(name, cd)
        coll.objects.link(cam)
        cam.location = target + Vector((0, -dist_h, 0.02 * H))
        cam.rotation_euler = (math.radians(90 - 1.5), 0, 0)
        return cam

    rx, ry = (int(t) for t in args.res.split("x"))
    sensor = 36.0
    # sensor fit AUTO: the 36 mm sensor spans the LONGER side of the frame
    fov_v = 2 * math.atan(sensor / 2 / args.lens) if ry >= rx else 2 * math.atan(sensor * ry / rx / 2 / args.lens)
    wide_d = (H * 0.60) / math.tan(fov_v / 2)  # character fills ~83% of the frame height
    wide = camera("camera_wide_shot", args.lens, c + Vector((0, 0, 0.5 * H)), wide_d)
    close = camera("camera_close_up", args.lens, c + Vector((0, 0, 0.86 * H)), wide_d * 0.38)
    turn = camera("camera_turnaround", args.lens, c + Vector((0, 0, 0.5 * H)), wide_d)
    turn.parent = pivot
    turn.matrix_parent_inverse = pivot.matrix_world.inverted()

    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = args.samples
    sc.cycles.use_denoising = True
    sc.render.resolution_x, sc.render.resolution_y = rx, ry
    sc.render.resolution_percentage = args.scale
    sc.render.fps = 24
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Medium High Contrast"
    sc.frame_start, sc.frame_end = 3, 195
    pivot.rotation_euler = (0, 0, 0)
    pivot.keyframe_insert("rotation_euler", index=2, frame=3)
    pivot.rotation_euler = (0, 0, math.radians(360))
    pivot.keyframe_insert("rotation_euler", index=2, frame=195)
    fc = pivot.animation_data.action
    try:
        for f in fc.fcurves:
            for kp in f.keyframe_points:
                kp.interpolation = "LINEAR"
    except AttributeError:  # Blender 5 layered actions
        for layer in fc.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    for f in bag.fcurves:
                        for kp in f.keyframe_points:
                            kp.interpolation = "LINEAR"
    sc.camera = wide
    print(f"presentation scene: H={H:.2f} m, rim light-linked={linked}, cameras wide/close/turn, frames 3-195")

    if args.save_scene:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.save_scene), copy=True)
    if args.stills:
        for cam in (wide, close):
            sc.camera = cam
            sc.frame_set(1)
            sc.render.filepath = os.path.join(os.path.abspath(args.out), f"{cam.name}.png")
            bpy.ops.render.render(write_still=True)
    if args.turntable:
        sc.camera = turn
        fdir = os.path.join(os.path.abspath(args.out), "turntable")
        os.makedirs(fdir, exist_ok=True)
        for i, f in enumerate(range(3, 196, args.step)):
            sc.frame_set(f)
            sc.render.filepath = os.path.join(fdir, f"frame_{i:04d}.png")
            bpy.ops.render.render(write_still=True)
        if shutil.which("ffmpeg"):
            fps = max(1, round(24 / args.step))
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps), "-i",
                            os.path.join(fdir, "frame_%04d.png"), "-pix_fmt", "yuv420p", "-vf",
                            "scale=trunc(iw/2)*2:trunc(ih/2)*2", os.path.join(os.path.abspath(args.out), "turntable.mp4")],
                           check=False)
            print("turntable.mp4 written")


if __name__ == "__main__":
    main()
