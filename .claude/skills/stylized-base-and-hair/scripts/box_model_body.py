"""Stylized base body without sculpting: Kenny Praise's box-model body as a script.

Kenny box-models the body (Hdkm7UZ6Oqs): chest block, extrude the torso, legs from 4 faces, arms from
4 side faces in an A-pose, neck from an inset, LoopTools Circle on every limb ring, Subsurf, Inflate, and a
4-face inset patch at every knee and elbow so the joints deform. He builds fingers and toes from a single
vertex with a Skin modifier. This script does the same job in one pass: a half skeleton of vertices, each
with an elliptical skin radius taken from a proportion table in head units. A Mirror (clipping) goes under a
Skin, then Subsurf, so the result is all quads with round rings and an extra ring at each joint.

    blender -b -P box_model_body.py -- --preset stylized --height 1.7 --out body.blend
    python box_model_body.py -- --preset hero --height 1.8 --out body.blend      (bpy module)

Options: --preset stylized|hero|heroic|chibi, --height metres, --female 0..1 (hip/shoulder/chest blend),
--apply (apply all modifiers, default on), --head-proxy (an egg head + eyes for blockout only), --hands.
The character faces -Y, Z up, feet on Z = 0, transforms applied. Object names follow Kenny's convention:
GEO-body, GEO-hand.L/R, GEO-head-proxy, GEO-eye.L/R.
Afterwards: run the 4-view QA (stylized-4view-qa) and fix proportions against your reference before any detail.
"""
import argparse
import math
import os
import sys

import bpy
from mathutils import Vector

# Landmarks in HEAD units (1 H = head height, chin to crown). z = height above the floor.
# Kenny's stylized body (front/side reference): the eye line sits halfway down the head, the neck leans forward,
# the heel is wider than the ankle, and the legs are spread a little more than the reference for an A-pose.
PRESETS = {
    # Full WIDTHS in head heights (front view). Real adult reference: shoulders ~2 H, hips ~1.5 H, thigh ~0.6 H.
    #            heads  shoulder hip   chest  waist  thigh  calf  upper-arm forearm neck
    "chibi":    (3.5,   1.50,    1.35, 1.25,  1.15,  0.55,  0.42, 0.36,     0.32,   0.45),
    "stylized": (6.0,   1.85,    1.45, 1.30,  1.05,  0.62,  0.44, 0.40,     0.34,   0.48),
    "hero":     (7.0,   2.00,    1.45, 1.35,  1.05,  0.60,  0.44, 0.42,     0.35,   0.50),
    "heroic":   (8.0,   2.35,    1.50, 1.55,  1.15,  0.64,  0.48, 0.48,     0.40,   0.55),
}


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--preset", default="stylized", choices=sorted(PRESETS))
    p.add_argument("--height", type=float, default=1.7)
    p.add_argument("--female", type=float, default=0.0)
    p.add_argument("--no-apply", action="store_true")
    p.add_argument("--head-proxy", action="store_true")
    p.add_argument("--hands", action="store_true")
    p.add_argument("--subsurf", type=int, default=1)
    p.add_argument("--out")
    return p.parse_args(argv)


def skeleton(preset, height, female):
    """Half skeleton (x >= 0). Returns verts [(co, (rx, ry))], edges, and the joint names."""
    heads, sh, hip, chest, waist, thigh, calf, uarm, farm, neck = PRESETS[preset]
    H = height / heads
    # female blend: narrower shoulders, wider hips, smaller waist (Kenny: "the hips need to be much wider")
    sh *= 1 - 0.12 * female
    hip *= 1 + 0.12 * female
    waist *= 1 - 0.10 * female

    leg_len = heads * 0.47          # crotch height in heads (long-legged stylized)
    crotch = leg_len * H
    knee = crotch * 0.52
    ankle = H * 0.33
    chin = height - H
    neck_base = chin - 0.28 * H
    shoulder_z = neck_base - 0.12 * H
    chest_z = shoulder_z - 0.45 * H
    waist_z = crotch + (chest_z - crotch) * 0.45
    pelvis_z = crotch + 0.32 * H

    V, E, J = [], [], {}

    def v(name, x, y, z, rx, ry=None):
        V.append(((x, y, z), (rx, ry if ry is not None else rx)))
        J[name] = len(V) - 1
        return J[name]

    def chain(*names):
        for a, b in zip(names, names[1:]):
            E.append((J[a], J[b]))

    # centre chain (x = 0): Mirror merges these
    v("pelvis", 0, 0.05 * H, pelvis_z, hip * H * 0.42, hip * H * (0.36 + 0.04 * female))  # seat goes back
    v("waist", 0, 0.02 * H, waist_z, waist * H * 0.50, waist * H * 0.38)
    v("chest", 0, -0.05 * H, chest_z, chest * H * 0.50, chest * H * (0.42 + 0.06 * female))  # chest forward
    v("upchest", 0, 0.00, shoulder_z - 0.12 * H, chest * H * 0.48, chest * H * 0.36)
    v("neck0", 0, 0.03 * H, neck_base, neck * H * 0.50)
    v("neck1", 0, -0.02 * H, chin + 0.10 * H, neck * H * 0.44)   # neck leans forward (Kenny: never vertical)
    chain("pelvis", "waist", "chest", "upchest", "neck0", "neck1")

    # leg: hip joint, upper thigh, knee patch (3 rings), calf, ankle, heel, ball, toe
    hx = hip * H * 0.5 - thigh * H * 0.42   # leg centre: thigh hugs the hip edge, legs spread a touch
    v("hip", hx, 0, crotch + 0.10 * H, thigh * H * 0.52, thigh * H * 0.50)
    v("thigh", hx * 1.02, -0.01 * H, crotch - 0.35 * H, thigh * H * 0.47)
    v("knee_a", hx * 0.98, -0.02 * H, knee + 0.12 * H, thigh * H * 0.36)
    v("knee", hx * 0.97, -0.03 * H, knee, thigh * H * 0.33)        # knee patch: 3 rings, Kenny's inset
    v("knee_b", hx * 0.96, -0.02 * H, knee - 0.12 * H, calf * H * 0.44)
    v("calf", hx * 0.95, 0.01 * H, knee - 0.45 * (knee - ankle), calf * H * 0.50)
    v("ankle", hx * 0.94, 0.02 * H, ankle, calf * H * 0.30)
    v("heel", hx * 0.94, 0.10 * H, ankle * 0.40, calf * H * 0.30, calf * H * 0.26)  # heel wider than the ankle
    v("ball", hx * 0.99, -0.55 * H, ankle * 0.30, calf * H * 0.40, calf * H * 0.17)
    v("toe", hx * 1.00, -0.80 * H, ankle * 0.26, calf * H * 0.30, calf * H * 0.13)
    E.append((J["pelvis"], J["hip"]))
    chain("hip", "thigh", "knee_a", "knee", "knee_b", "calf", "ankle", "heel")
    chain("ankle", "ball", "toe")

    # arm in an A-pose (45 deg), forearm turned slightly forward on Y (Kenny: rotation needed for deformation)
    sx = sh * H * 0.5 - uarm * H * 0.45   # shoulder joint sits inside the deltoid
    v("clav", sx * 0.50, 0.0, shoulder_z + 0.01 * H, uarm * H * 0.56)
    v("shoulder", sx, 0.01 * H, shoulder_z - 0.04 * H, uarm * H * 0.58)
    a = math.radians(45)
    ulen, flen = 1.35 * H, 1.20 * H
    d = Vector((math.sin(a), 0, -math.cos(a)))
    sh_p = Vector((sx, 0.01 * H, shoulder_z - 0.02 * H))
    el = sh_p + d * ulen
    v("uarm", *(sh_p + d * ulen * 0.45), uarm * H * 0.52)
    v("elbow_a", *(sh_p + d * (ulen - 0.10 * H)), uarm * H * 0.44)
    v("elbow", *el, uarm * H * 0.40)
    d2 = (d + Vector((0, -0.18, 0))).normalized()
    v("elbow_b", *(el + d2 * 0.10 * H), farm * H * 0.48)
    v("farm", *(el + d2 * flen * 0.40), farm * H * 0.50)
    wr = el + d2 * flen
    v("wrist", *wr, farm * H * 0.30, farm * H * 0.24)
    E.append((J["upchest"], J["clav"]))
    chain("clav", "shoulder", "uarm", "elbow_a", "elbow", "elbow_b", "farm", "wrist")
    return V, E, J, H, wr, d2


def build_body(args):
    V, E, J, H, wrist, arm_dir = skeleton(args.preset, args.height, args.female)
    me = bpy.data.meshes.new("GEO-body")
    me.from_pydata([c for c, _ in V], E, [])
    ob = bpy.data.objects.new("GEO-body", me)
    bpy.context.scene.collection.objects.link(ob)

    mir = ob.modifiers.new("Mirror", "MIRROR")
    mir.use_clip = True
    mir.use_mirror_merge = True
    mir.merge_threshold = 1e-4
    skin = ob.modifiers.new("Skin", "SKIN")
    skin.use_smooth_shade = True
    skin.branch_smoothing = 0.6
    sv = me.skin_vertices[0].data
    for i, (_, r) in enumerate(V):
        sv[i].radius = r
        sv[i].use_root = (i == J["pelvis"])
    ss = ob.modifiers.new("Subsurf", "SUBSURF")
    ss.levels = args.subsurf
    ss.render_levels = args.subsurf
    if not args.no_apply:
        bpy.context.view_layer.objects.active = ob
        for m in list(ob.modifiers):
            bpy.ops.object.modifier_apply(modifier=m.name)
        smooth = ob.modifiers.new("Relax", "SMOOTH")  # Kenny: gentle Shift-smooth after each pass
        smooth.factor = 0.35
        smooth.iterations = 4
        bpy.ops.object.modifier_apply(modifier=smooth.name)
        for p in ob.data.polygons:
            p.use_smooth = True
    return ob, H, wrist, arm_dir


def skin_chain(name, pts, radii, loc=(0, 0, 0)):
    """Kenny's finger/toe trick: a vertex chain + Skin + Subsurf (viewport 2)."""
    me = bpy.data.meshes.new(name)
    me.from_pydata(pts, [(i, i + 1) for i in range(len(pts) - 1)], [])
    ob = bpy.data.objects.new(name, me)
    ob.location = loc
    bpy.context.scene.collection.objects.link(ob)
    sk = ob.modifiers.new("Skin", "SKIN")
    sk.use_smooth_shade = True
    for i, r in enumerate(radii):
        me.skin_vertices[0].data[i].radius = r if isinstance(r, tuple) else (r, r)
    me.skin_vertices[0].data[0].use_root = True
    ss = ob.modifiers.new("Subsurf", "SUBSURF")
    ss.levels = 2
    ss.render_levels = 2
    return ob


def build_hand(H, wrist, arm_dir, side=1):
    """Palm block + 4 fingers on the knuckle arc + thumb on the pad, relaxed curl (5RFhA0PG0XE)."""
    parts = []
    s = H * 0.14  # palm half-size: hand length ~0.75 H (chin to hairline covers the hand)
    d = arm_dir.copy()
    d.x *= side
    w = Vector((wrist.x * side, wrist.y, wrist.z))
    palm_c = w + d * s * 1.2
    parts.append(skin_chain("palm", [tuple(w), tuple(palm_c), tuple(palm_c + d * s * 0.9)],
                            [(s * 0.55, s * 0.30), (s * 0.95, s * 0.36), (s * 0.95, s * 0.32)]))
    # finger lengths: middle longest, pinky shortest; knuckles on an arc that steepens outward
    lengths = (0.92, 1.0, 0.94, 0.75)
    side_axis = Vector((0, -1, 0))  # across the palm for an A-posed arm
    curl_axis = d.cross(side_axis).normalized()
    base = palm_c + d * s * 0.95
    for i, L in enumerate(lengths):
        off = (i - 1.5) * s * 0.48
        k = base + side_axis * off - d * abs(i - 1.3) * s * 0.10
        seg = s * 0.62 * L
        pts = [tuple(k)]
        dir_ = d.copy()
        cur = k.copy()
        for j in range(3):  # 3 segments = 3 Rigify finger bones; 2 close verts sharpen the knuckle
            dir_ = (dir_ + curl_axis * 0.22).normalized()  # relaxed curl, never parallel creases
            cur = cur + dir_ * seg
            pts.append(tuple(cur))
        r = s * 0.17
        parts.append(skin_chain(f"finger{i}", pts, [r, r * 0.95, r * 0.88, r * 0.78]))
    tb = palm_c - side_axis * s * 0.75 - d * s * 0.2
    tdir = (d - side_axis * 0.9).normalized()
    tp = [tuple(tb + tdir * s * 0.55 * j) for j in range(4)]
    parts.append(skin_chain("thumb", tp, [s * 0.26, s * 0.22, s * 0.19, s * 0.16]))
    for p in parts:
        bpy.context.view_layer.objects.active = p
        for m in list(p.modifiers):
            bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    hand = bpy.context.view_layer.objects.active
    hand.name = "GEO-hand.L" if side > 0 else "GEO-hand.R"
    return hand


def build_head_proxy(args, H):
    """Blockout-only head: an egg (cranium) with the jaw pulled down, eyes on the half line.
    Replace it with an image-to-3D head (see the skill) before any face work."""
    chin = args.height - H
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=16, radius=H * 0.5,
                                         location=(0, -0.02 * H, chin + H * 0.5))
    head = bpy.context.active_object
    head.name = "GEO-head-proxy"
    head.scale = (0.78, 0.92, 1.0)
    bpy.ops.object.transform_apply(scale=True)
    for vx in head.data.vertices:  # jaw wedge: taper the lower half and push the chin forward
        if vx.co.z < 0:
            k = max(0.0, -vx.co.z / (H * 0.5))
            vx.co.x *= 1 - 0.35 * k
            vx.co.y -= 0.05 * H * k
    bpy.ops.object.shade_smooth()
    eyes = []
    for side in (1, -1):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=16, radius=H * 0.085,
                                             location=(side * H * 0.17, -0.02 * H - H * 0.27, chin + H * 0.5),
                                             rotation=(math.radians(90), 0, 0))
        e = bpy.context.active_object
        e.name = "GEO-eye.L" if side > 0 else "GEO-eye.R"
        bpy.ops.object.shade_smooth()
        eyes.append(e)
    return head, eyes


def main():
    args = parse()
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob)
    body, H, wrist, arm_dir = build_body(args)
    if args.hands:
        build_hand(H, wrist, arm_dir, 1)
        build_hand(H, wrist, arm_dir, -1)
    if args.head_proxy:
        build_head_proxy(args, H)
    # feet on Z = 0, transforms applied (QA checks this)
    lo = min((o.matrix_world @ Vector(c)).z for o in bpy.data.objects if o.type == "MESH" for c in o.bound_box)
    for o in bpy.data.objects:
        o.location.z -= lo
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    tris = sum(len(p.vertices) - 2 for o in bpy.data.objects if o.type == "MESH" for p in o.data.polygons)
    print(f"built {args.preset} body {args.height} m, {tris} tris")
    if args.out:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.out))


if __name__ == "__main__":
    main()
