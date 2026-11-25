"""Game translation of Kenny's GN hair: curves -> alpha hair CARDS (Godot / Roblox can't render 100k curves).

Kenny's hair is a Geometry Nodes curve groom (often 50k–800k strands). Games need a few hundred textured
ribbons. This script:
  1. evaluates the hair object at a LOW child density (each card stands for one clump; use --cards to set
     how many curves to keep; it samples the evaluated curves evenly),
  2. builds a ribbon per curve: width tapers root -> tip, it faces away from the head centre and gets a slight
     twist so it doesn't look flat from the side, with UVs U = across the card (inside one atlas tile) and
     V = root (0) -> tip (1),
  3. makes a procedural strand texture atlas (4 tiles, base colour + alpha) and an alpha-clip material
     (Godot: alpha scissor; Roblox: SurfaceAppearance AlphaMode Transparency or Overlay),
  4. checks the triangle budget (default 12k for hair; each piece must stay under 20k).

    python hair_to_cards.py -- --blend char_hair.blend --hair HAIR-curly --cards 400 --width 0.012 --out cards.blend

Brows/lashes: run on the brow/lash grooms with --cards 40 --width 0.004 --segments 3 (masterclass: alpha cards).
Then run the 4-view QA: cards must not show their flat edge from the side, and no bald scalp may show through.
"""
import argparse
import math
import os
import random
import sys

import bpy
import numpy as np
from mathutils import Vector


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--blend")
    p.add_argument("--hair", required=True, help="hair curves object")
    p.add_argument("--cards", type=int, default=400)
    p.add_argument("--width", type=float, default=0.012, help="card width at the root (m)")
    p.add_argument("--tip", type=float, default=0.35, help="tip width as a fraction of the root width")
    p.add_argument("--segments", type=int, default=6, help="segments along each card")
    p.add_argument("--budget", type=int, default=12000)
    p.add_argument("--tex", type=int, default=1024, help="atlas size (Roblox max 1024)")
    p.add_argument("--color", default="0.06,0.035,0.022")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--out")
    return p.parse_args(argv)


def curves_points(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    cd = ev.data
    n = len(cd.points)
    pos = np.empty(n * 3, np.float32)
    cd.attributes["position"].data.foreach_get("vector", pos)
    pos = pos.reshape(-1, 3)
    mw = np.array(ev.matrix_world)
    pos = (np.c_[pos, np.ones(n)] @ mw.T)[:, :3]
    offs = np.empty(len(cd.curves) + 1, np.int32)
    cd.curve_offset_data.foreach_get("value", offs)
    return [pos[offs[i]:offs[i + 1]] for i in range(len(cd.curves))]


def resample(pts, k):
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    L = np.r_[0, np.cumsum(seg)]
    if L[-1] < 1e-6:
        return None
    t = np.linspace(0, L[-1], k + 1)
    return np.stack([np.interp(t, L, pts[:, i]) for i in range(3)], 1)


def strand_atlas(size, color, seed):
    """4 vertical tiles of strands: dense, medium, wispy, clumped. RGBA, alpha tapers to the tip."""
    rng = np.random.default_rng(seed)
    img = np.zeros((size, size, 4), np.float32)
    tile = size // 4
    c = np.array(color)
    v = np.linspace(0, 1, size)[:, None]  # v: 0 root (bottom row) -> 1 tip (top row)
    for t, (count, wmin, wmax, fade) in enumerate(((70, 1.5, 3.5, 0.75), (45, 1.2, 3.0, 0.65),
                                                   (22, 1.0, 2.2, 0.5), (55, 2.0, 4.5, 0.85))):
        x0 = t * tile
        for _ in range(count):
            cx = rng.uniform(4, tile - 4)
            w = rng.uniform(wmin, wmax) * size / 1024
            length = rng.uniform(fade, 1.0)
            wav = rng.uniform(0, 3) * size / 1024
            ph = rng.uniform(0, 6.28)
            xs = np.arange(tile)[None, :]
            centre = cx + wav * np.sin(v * 9 + ph)
            d = np.abs(xs - centre) / w
            a = np.clip(1 - d, 0, 1) * (v < length) * np.clip((length - v) / 0.25, 0, 1)
            shade = 0.75 + 0.5 * rng.random()
            col = np.clip(c * shade * (1 + 1.4 * v), 0, 1)  # root darker than the tip (Kenny's Intercept ramp)
            blk = img[:, x0:x0 + tile]
            blk[..., 3] = np.maximum(blk[..., 3], a)
            for ch in range(3):
                blk[..., ch] = np.where(a > 0.05, col[:, ch:ch + 1] if col.ndim == 2 else col[ch], blk[..., ch])
    img[..., :3] = np.where(img[..., 3:4] > 0, img[..., :3], c)  # no dark halos around alpha edges
    im = bpy.data.images.new("TEX-hair-cards", size, size, alpha=True)
    im.pixels.foreach_set(img.ravel())
    im.pack()
    return im


def card_material(im):
    m = bpy.data.materials.new("MAT-hair-cards")
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes.get("Principled BSDF")
    tx = nt.nodes.new("ShaderNodeTexImage")
    tx.image = im
    nt.links.new(tx.outputs["Color"], b.inputs["Base Color"])
    nt.links.new(tx.outputs["Alpha"], b.inputs["Alpha"])
    b.inputs["Roughness"].default_value = 0.45
    if hasattr(m, "surface_render_method"):
        m.surface_render_method = "DITHERED"  # EEVEE: alpha-hashed look; glTF exports as alpha MASK
    m.use_backface_culling = False
    return m


def main():
    args = parse()
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.blend))
    hair = bpy.data.objects[args.hair]
    strands = [s for s in curves_points(hair) if len(s) >= 2]
    random.seed(args.seed)
    if len(strands) > args.cards:
        strands = random.sample(strands, args.cards)
    surf = hair.data.surface
    centre = Vector(np.mean([Vector(c) for c in surf.bound_box], axis=0)) if surf else Vector()
    if surf:
        centre = surf.matrix_world @ centre
    verts, faces, uvs = [], [], []
    k = args.segments
    for i, s in enumerate(strands):
        r = resample(s, k)
        if r is None:
            continue
        tile = i % 4
        twist = random.uniform(-0.5, 0.5)
        root_w = args.width * random.uniform(0.8, 1.25)
        base = len(verts)
        for j in range(k + 1):
            p = Vector(r[j])
            tan = Vector(r[min(j + 1, k)] - r[max(j - 1, 0)]).normalized()
            out = (p - centre).normalized()
            side = tan.cross(out).normalized()
            ang = twist * j / k
            side = (side * math.cos(ang) + out * math.sin(ang)).normalized()
            w = root_w * (1 - (1 - args.tip) * j / k) * 0.5
            verts += [p - side * w, p + side * w]
            v = j / k
            uvs += [(tile * 0.25 + 0.01, v), (tile * 0.25 + 0.24, v)]
        for j in range(k):
            a = base + 2 * j
            faces.append((a, a + 1, a + 3, a + 2))
    me = bpy.data.meshes.new("GEO-hair-cards")
    me.from_pydata(verts, [], faces)
    uvl = me.uv_layers.new(name="UVMap")
    for poly in me.polygons:
        for li in poly.loop_indices:
            uvl.data[li].uv = uvs[me.loops[li].vertex_index]
        poly.use_smooth = True
    ob = bpy.data.objects.new("GEO-hair-cards", me)
    for c in hair.users_collection:
        c.objects.link(ob)
    ob.data.materials.append(card_material(strand_atlas(args.tex, [float(x) for x in args.color.split(",")], args.seed)))
    hair.hide_render = True
    hair.hide_set(True)
    tris = len(faces) * 2
    print(f"{len(faces) // k} cards, {tris} tris (budget {args.budget})" + ("  OVER BUDGET" if tris > args.budget else ""))
    if args.out:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.out))


if __name__ == "__main__":
    main()
