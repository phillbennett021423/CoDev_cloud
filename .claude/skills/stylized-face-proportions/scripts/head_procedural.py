"""Procedural stylized head with Kenny Praise's proportions, for when no image-to-3D model is available.

Kenny's head = cranium (box-ish round cube) + jaw wedge, sides sliced flat, eye line at HALF the head height,
hairline -> chin in thirds (brow line, nose bottom), mouth halfway between nose bottom and chin, ears between
brow and nose lines and BEHIND the profile middle line, eyes INSIDE sockets, nose = triangular block projecting
the most, upper lip in front of the lower lip, neck leaning forward. This builds that with smooth, named
"brush strokes" (Gaussian pushes along the surface normal) on an even quad sphere, so every feature is a
number you can tune per character (FEATURES below, or --set name=amount).

    python head_procedural.py -- --blend body.blend --proxy GEO-head-proxy --style female --out head.blend
    python head_procedural.py -- --blend body.blend --proxy GEO-head-proxy --set nose=1.3,lips=1.4,jaw_narrow=0.5
It replaces the proxy (kept hidden as REF-head-proxy), moves the eyes into the sockets, adds ears, and names the
result GEO-head. Then run face_guide.py and the 4-view QA, and tune.
"""
import argparse
import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector

# u = x / half-width (+ = character's left), v = (z - eye line) / half-height (+ up), front = -Y.
# each stroke: (u, v, radius_u, radius_v, push in units of head half-depth; + = outward), mirrored in X if u != 0
STYLES = {
    "female": dict(jaw_narrow=0.42, chin_point=0.35, cranium_back=1.08, side_flat=0.12, nose=1.0, nose_width=0.9,
                   lips=1.15, brow=0.8, cheek=1.0, eye_socket=1.0, eye_scale=1.0, ear=1.0),
    "male": dict(jaw_narrow=0.28, chin_point=0.15, cranium_back=1.05, side_flat=0.18, nose=1.15, nose_width=1.1,
                 lips=0.9, brow=1.2, cheek=0.9, eye_socket=1.1, eye_scale=0.9, ear=1.05),
}


def strokes(s):
    n, nw, lp = s["nose"], s["nose_width"], s["lips"]
    return [
        # name,          u,     v,     ru,   rv,   push
        ("eye_socket",  0.36,  0.00,  0.20, 0.13, -0.10 * s["eye_socket"]),
        ("brow",        0.36,  0.17,  0.26, 0.07,  0.035 * s["brow"]),
        ("brow_mid",    0.00,  0.16,  0.16, 0.06,  0.02 * s["brow"]),
        ("nose_bridge", 0.00, -0.08,  0.07 * nw, 0.12, 0.06 * n),
        ("nose_tip",    0.00, -0.30,  0.10 * nw, 0.08, 0.16 * n),
        ("nose_wing",   0.12, -0.33,  0.07 * nw, 0.05, 0.06 * n),
        ("nostril",     0.06, -0.37,  0.035,      0.025, -0.03 * n),
        ("muzzle",      0.00, -0.55,  0.32, 0.20,  0.05),
        ("upper_lip",   0.00, -0.50,  0.20, 0.045, 0.07 * lp),
        ("mouth_line",  0.00, -0.555, 0.22, 0.016, -0.04 * lp),
        ("lower_lip",   0.00, -0.61,  0.17, 0.045, 0.05 * lp),
        ("under_lip",   0.00, -0.69,  0.14, 0.03, -0.025),
        ("mouth_corner", 0.21, -0.555, 0.04, 0.03, -0.03),
        ("chin",        0.00, -0.86,  0.16, 0.09,  0.05),
        ("cheekbone",   0.50, -0.12,  0.20, 0.12,  0.045 * s["cheek"]),
        ("cheek_hollow", 0.55, -0.42, 0.18, 0.12, -0.03 * s["cheek"]),
        ("temple",      0.80,  0.25,  0.18, 0.20, -0.04),
        ("nasolabial",  0.20, -0.42,  0.04, 0.10, -0.015),
    ]


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--blend")
    p.add_argument("--proxy", default="GEO-head-proxy", help="object whose bounds give the head size and place")
    p.add_argument("--style", default="female", choices=sorted(STYLES))
    p.add_argument("--set", default="", help="override style values: nose=1.2,lips=1.3")
    p.add_argument("--res", type=int, default=64, help="sphere segments (rings = 3/4)")
    p.add_argument("--name", default="GEO-head")
    p.add_argument("--out")
    return p.parse_args(argv)


def main():
    args = parse()
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.blend))
    s = dict(STYLES[args.style])
    for kv in [t for t in args.set.split(",") if t]:
        k, v = kv.split("=")
        s[k] = float(v)
    proxy = bpy.data.objects[args.proxy]
    pts = [proxy.matrix_world @ Vector(c) for c in proxy.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    H = hi.z - lo.z
    cx, cy = (lo.x + hi.x) / 2, (lo.y + hi.y) / 2
    eye_z = lo.z + H / 2
    hw, hh, hd = 0.36 * H, H / 2, 0.43 * H  # half width / height / depth (female head ~0.72 H wide)

    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=args.res, v_segments=int(args.res * 0.75), radius=1.0)
    for v in bm.verts:
        x, y, z = v.co
        # cranium + jaw: below the eye line the head narrows to the jaw and comes to a chin
        t = max(0.0, -z)  # 0 at eye line, 1 at the chin
        narrow = 1 - s["jaw_narrow"] * t ** 1.6
        x *= narrow
        y *= 1 - 0.12 * t  # jaw shallower front-to-back
        if y > 0:  # back of the skull: fuller above, slanting into the neck below (no bulge)
            y *= s["cranium_back"] * (1 - 0.35 * t) if z < 0 else s["cranium_back"]
        if z < -0.6 and y < 0:  # chin forward and pointed
            y -= 0.08 * (t - 0.6) * (1 - abs(x) / max(narrow, 1e-3)) * (1 + s["chin_point"])
        # sides sliced flat (Line Project) above the jaw
        if abs(x) > 0.7 and z > -0.3:
            x = math.copysign(0.7 + (abs(x) - 0.7) * (1 - s["side_flat"] * 3), x)
        # top of the cranium a bit flatter / boxy
        if z > 0.6:
            z = 0.6 + (z - 0.6) * 0.85
        v.co = Vector((x * hw, y * hd, z * hh))
    bm.normal_update()
    # face strokes along the normal, front half only
    feats = strokes(s)
    for v in bm.verts:
        if v.co.y > 0.1 * hd:
            continue
        u, w = v.co.x / hw, v.co.z / hh
        d = 0.0
        for name, fu, fv, ru, rv, push in feats:
            for sgn in ((1, -1) if fu else (1,)):
                du, dv = (u - sgn * fu) / ru, (w - fv) / rv
                g = math.exp(-0.5 * (du * du + dv * dv))
                if g > 1e-3:
                    d += push * g
        front = max(0.0, min(1.0, -v.co.y / hd * 1.6))  # fade out toward the sides
        v.co += v.normal * d * hd * front
    me = bpy.data.meshes.new(args.name)
    bm.to_mesh(me)
    bm.free()
    head = bpy.data.objects.new(args.name, me)
    for c in proxy.users_collection:
        c.objects.link(head)
    head.location = (cx, cy, eye_z)
    for p in me.polygons:
        p.use_smooth = True
    # keep the proxy as a hidden reference
    proxy.name = "REF-head-proxy"
    proxy.hide_render = True
    proxy.hide_set(True)

    # eyes into the sockets: centre at +-0.36 hw, on the eye line, sunk so ~40% of the ball shows
    er = 0.105 * H * s["eye_scale"] * 0.5
    eyes = [o for o in bpy.data.objects if o.type == "MESH" and o.name.startswith("GEO-eye")]
    for e in eyes:
        side = 1 if e.name.endswith(".L") else -1
        sc = er / max(e.dimensions.x / 2, 1e-6)
        # scale baked into the mesh (the QA flags unapplied scale; engines want scale 1)
        e.data.transform(__import__("mathutils").Matrix.Diagonal((*[a * sc for a in e.scale], 1.0)))
        e.scale = (1, 1, 1)
        bpy.context.view_layer.update()
        # surface y at the socket centre (after the socket push), measured on the head
        sy = min((head.matrix_world @ v.co).y for v in me.vertices
                 if abs(v.co.x - side * 0.36 * hw) < 0.03 * hw and abs(v.co.z) < 0.04 * hh)
        e.location = (cx + side * 0.36 * hw, sy + er * 0.55, eye_z)
    # ears: flattened, tilted ellipsoids between the brow and nose lines, behind the middle line
    for side, sfx in ((1, "L"), (-1, "R")):
        eb = bmesh.new()
        bmesh.ops.create_uvsphere(eb, u_segments=16, v_segments=12, radius=1.0)
        for v in eb.verts:
            x, y, z = v.co
            rim = 1.0 if x * side > 0 else 0.6  # outer side fuller (helix), inner side flatter
            v.co = Vector((x * 0.012 * H * rim * s["ear"], y * 0.11 * H * 0.5 * s["ear"], z * 0.27 * H * 0.5 * s["ear"]))
        em = bpy.data.meshes.new(f"GEO-ear.{sfx}")
        eb.to_mesh(em)
        eb.free()
        ear = bpy.data.objects.new(f"GEO-ear.{sfx}", em)
        for c in proxy.users_collection:
            c.objects.link(ear)
        ear.location = (cx + side * hw * 0.93, cy + 0.06 * H, eye_z - 0.12 * H)
        ear.rotation_euler = (math.radians(-12), 0, math.radians(side * 18))  # tilted back, not facing front
        for p in em.polygons:
            p.use_smooth = True
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    print(f"{args.name}: {tris} tris, H {H:.3f} m, style {args.style}, eyes r {er:.4f}")
    if args.out:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.out))


if __name__ == "__main__":
    main()
