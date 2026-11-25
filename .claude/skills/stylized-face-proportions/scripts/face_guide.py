"""Kenny Praise's face proportion guide (UiuGcNmbY-A, masterclass ch. 3) as a headless overlay + numeric check.

Renders the head front and side (orthographic, 150 mm-equivalent flat look) and draws Kenny's guide lines on
the images:
  crown / chin, EYE LINE at half the head height, hairline -> chin split in thirds (brow line, nose bottom),
  mouth line (bottom of the lower lip) halfway between nose bottom and chin, the profile middle line
  (jaw/cranium split; the ear sits BEHIND it), and in the front view the eye centres, one-eye-width spacing
  marks and the iris-centre verticals that mouth corners must not pass.
Then it measures what it can from the meshes:
  eye centre height vs the half line, gap between the eyes vs eye width, eye width vs head width,
  head height in metres and heads-tall of the whole character.

    python face_guide.py -- --blend char.blend --head GEO-head --out qa_face [--hairline 0.82] [--chin-z 1.43]
    (--hairline / --chin-z: fractions of head height or a world z, if the head mesh includes the neck)
"""
import argparse
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--blend")
    p.add_argument("--head", default="GEO-head")
    p.add_argument("--eyes", default="", help="comma list; default = meshes named *eye* (not brow/lash)")
    p.add_argument("--chin-z", type=float, help="world z of the chin (default: lowest point of the head mesh)")
    p.add_argument("--hairline", type=float, default=0.82,
                   help="hairline height as a fraction from chin (0) to crown (1); Kenny's thirds start here")
    p.add_argument("--res", type=int, default=700)
    p.add_argument("--samples", type=int, default=16)
    p.add_argument("--out", default="qa_face")
    return p.parse_args(argv)


def world_bbox(objs):
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def mesh_extent(o):
    mw = o.matrix_world
    pts = [mw @ v.co for v in o.data.vertices]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi, sum(pts, Vector()) / len(pts)


def setup(scene, centre, size, res, samples):
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.render.resolution_x = scene.render.resolution_y = res
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("QA_face_world")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.5, 0.5, 0.5, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    scene.world = world
    cam_data = bpy.data.cameras.new("QA_face_cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = size
    cam = bpy.data.objects.new("QA_face_cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    key = bpy.data.lights.new("QA_face_key", "SUN")
    key.energy = 2.5
    k = bpy.data.objects.new("QA_face_key", key)
    k.rotation_euler = (math.radians(50), 0, math.radians(-30))
    scene.collection.objects.link(k)
    return cam


def render(scene, cam, loc, rot, path):
    cam.location = loc
    cam.rotation_euler = rot
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def load(path):
    im = bpy.data.images.load(path)
    a = np.empty(im.size[0] * im.size[1] * 4, np.float32)
    im.pixels.foreach_get(a)
    return a.reshape(im.size[1], im.size[0], 4), im


def save(arr, im, path):
    im.pixels.foreach_set(arr.ravel())
    im.filepath_raw = path
    im.file_format = "PNG"
    im.save()


def hline(a, y, col, w=2):
    y = int(round(y))
    if 0 <= y < a.shape[0]:
        a[max(0, y - w // 2):y + (w + 1) // 2, :, :3] = col


def vline(a, x, col, w=2, dash=False):
    x = int(round(x))
    if 0 <= x < a.shape[1]:
        rows = np.arange(a.shape[0])
        if dash:
            rows = rows[(rows // 8) % 2 == 0]
        a[rows, max(0, x - w // 2):x + (w + 1) // 2, :3] = col


def main():
    args = parse()
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.blend))
    os.makedirs(args.out, exist_ok=True)
    scene = bpy.context.scene
    head = bpy.data.objects[args.head]
    eyes = ([bpy.data.objects[n] for n in args.eyes.split(",") if n] if args.eyes else
            [o for o in scene.objects if o.type == "MESH" and "eye" in o.name.lower()
             and not any(t in o.name.lower() for t in ("brow", "lash", "lid")) and not o.hide_render])
    hlo, hhi, _ = mesh_extent(head)
    crown = hhi.z
    chin = args.chin_z if args.chin_z is not None else hlo.z
    H = crown - chin
    mid = chin + H * 0.5
    hair = chin + H * args.hairline
    brow = hair - (hair - chin) / 3
    nose = hair - 2 * (hair - chin) / 3
    mouth = nose - (nose - chin) * 0.5

    # isolate the head (+ eyes, brows, lashes, hair cards near the head) for the render
    keep = {head.name} | {o.name for o in eyes}
    for o in scene.objects:
        if o.type == "MESH" and not o.hide_render:
            lo, hi = world_bbox([o])
            if lo.z > chin - 0.02 and o.name not in keep and not o.name.startswith("REF-"):
                keep.add(o.name)
    hidden = []
    for o in scene.objects:
        if o.type in {"MESH", "CURVES"} and o.name not in keep and not o.hide_render:
            o.hide_render = True
            hidden.append(o)
    lo, hi = world_bbox([bpy.data.objects[n] for n in keep])
    size = max(H, hi.x - lo.x, hi.y - lo.y) * 1.35
    cx, cy, cz = (lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (chin + crown) / 2
    cam = setup(scene, (cx, cy, cz), size, args.res, args.samples)
    front = os.path.join(os.path.abspath(args.out), "face_front.png")
    side = os.path.join(os.path.abspath(args.out), "face_side.png")
    render(scene, cam, (cx, cy - 5, cz), (math.radians(90), 0, 0), front)
    render(scene, cam, (cx - 5, cy, cz), (math.radians(90), 0, math.radians(-90)), side)  # left side, faces -Y = left in image

    px = args.res / size

    def zpix(z):  # image rows run bottom-up in Blender pixel arrays
        return args.res / 2 + (z - cz) * px

    lines = [(crown, (0.1, 0.1, 0.1)), (chin, (0.1, 0.1, 0.1)), (mid, (0.0, 0.8, 1.0)),
             (hair, (1.0, 0.6, 0.0)), (brow, (1.0, 0.85, 0.0)), (nose, (1.0, 0.85, 0.0)), (mouth, (1.0, 0.2, 0.6))]
    report = {"head_height_m": round(H, 4), "eye_line_z": round(mid, 4), "brow_z": round(brow, 4),
              "nose_bottom_z": round(nose, 4), "mouth_line_z": round(mouth, 4), "checks": []}
    a, im = load(front)
    for z, c in lines:
        hline(a, zpix(z), c)
    eye_info = []
    for e in eyes:
        elo, ehi, ec = mesh_extent(e)
        eye_info.append((ec, ehi.x - elo.x, ehi.z - elo.z))
        for x, c, d in ((ec.x, (0.0, 0.8, 1.0), True), (elo.x, (0.2, 1, 0.2), False), (ehi.x, (0.2, 1, 0.2), False)):
            vline(a, args.res / 2 + (x - cx) * px, c, 1 if d else 2, dash=d)
    save(a, im, front)
    a, im = load(side)
    for z, c in lines:
        hline(a, zpix(z), c)
    vline(a, args.res / 2 + 0, (1, 0.3, 0.3), 2, dash=True)  # profile middle (jaw/cranium split; ear behind it)
    save(a, im, side)

    # numeric checks
    if len(eye_info) >= 2:
        eye_info.sort(key=lambda t: t[0].x)
        (l, lw, lh), (r, rw, rh) = eye_info[0], eye_info[-1]
        ez = (l.z + r.z) / 2
        dev = (ez - mid) / H
        ew = (lw + rw) / 2
        gap = (r.x - l.x) - ew
        hw = hhi.x - hlo.x
        report.update(eye_center_z=round(ez, 4), eye_width_m=round(ew, 4), eye_gap_m=round(gap, 4),
                      head_width_m=round(hw, 4))
        report["checks"].append(("eye line at half head height", f"{dev*100:+.1f}% of H", abs(dev) <= 0.06,
                                 "stylized may sit lower (big cranium); over 6% is drift"))
        report["checks"].append(("gap between eyes = 1 eye width", f"{gap/ew:.2f} eye widths", 0.7 <= gap / ew <= 1.5,
                                 "Kenny: one eye width; stylized/anime may widen"))
        report["checks"].append(("eye width vs head width", f"{ew/hw:.2f}", 0.15 <= ew / hw <= 0.32,
                                 "about 1/5 of head width; stylized up to ~0.3"))
        report["checks"].append(("left/right eyes level", f"{abs(l.z-r.z)*1000:.1f} mm", abs(l.z - r.z) < 0.002, ""))
        report["mouth_corner_limit_x"] = [round(l.x, 4), round(r.x, 4)]
    allmesh = [o for o in scene.objects if o.type == "MESH" and (not o.hide_render or o in hidden)
               and not o.name.startswith(("REF-", "QA_"))]
    clo, chi = world_bbox(allmesh)
    report["heads_tall"] = round((chi.z - clo.z) / H, 2) if H > 0 else None
    for o in hidden:
        o.hide_render = False

    md = [f"# Face guide: {args.head}", "", f"- head height {H:.3f} m, character {report['heads_tall']} heads tall", "",
          "| check | value | ok | note |", "|---|---|---|---|"]
    for name, val, ok, note in report["checks"]:
        md.append(f"| {name} | {val} | {'yes' if ok else '**NO**'} | {note} |")
    md += ["", "Lines on face_front.png / face_side.png: black crown+chin, CYAN eye line (half), ORANGE hairline,",
           "YELLOW brow + nose bottom (thirds), PINK mouth line (bottom of lower lip). Front: green eye edges,",
           "dashed cyan iris centres (mouth corners stay inside them). Side: dashed red = middle line, ear BEHIND it.",
           "Look: eyes on the cyan line, ear top at the brow line and bottom at the nose line, nose bottom on its line."]
    with open(os.path.join(args.out, "face_report.md"), "w") as f:
        f.write("\n".join(md))
    with open(os.path.join(args.out, "face_report.json"), "w") as f:
        json.dump(report, f, indent=1)
    print("\n".join(md))


if __name__ == "__main__":
    main()
