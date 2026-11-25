---
name: stylized-outfit-and-gear
description: Make clothes, belts, straps, shoes and accessories for a stylized game character the Kenny Praise way (clothes grown out of the body, folds only at tension and compression, Solidify thickness with soft hems), by script, with game rules for hidden body faces and tris.
---

# Stylized outfit and gear

Sources: masterclass ch. 5 (clothes, shoes, accessories) and ch. 8 (clothes retopology), cloth sculpting
(v_WMJLudpvg), easy shirt with fake seams (j8LGGNylMOY), hoodie, and project breakdowns (CdrKqrln4ig,
F93u9iBaIlA). Exact numbers are in `references/`.

## Kenny's cloth rules (apply to every garment)
- Cloth behaves like water: it takes the shape of the body under it. Every fold is **tension** (pulled from a
  point, giving straight or radiating folds) or **compression** (pushed together, giving zigzag or spiral
  bunching). Find those points (armpits, crotch, elbow and knee insides, behind the knee, waist under a belt)
  and put folds only there.
- Game and animation characters get **few, subtle folds**, so they still read when the rig bends them. Never
  parallel or identical folds; use curves and diagonals. Stylized folds are **sharp** (Crease Polish + Pinch).
- Folds are asymmetric: symmetry OFF for folds, ON for the base shape.
- Layer order: pants over the tucked shirt, or the shirt over the pants waist. Belts go over the layer they hold.
- Everything has thickness (Solidify), and hems and cuffs read soft (smoothed rim).

## 1. Garment from the body (script)
```bash
python scripts/cloth_from_body.py -- --blend body.blend --garment pants  --cut-body --color 0.2,0.25,0.4 --out a.blend
python scripts/cloth_from_body.py -- --blend a.blend   --garment tshirt --cut-body --color 0.8,0.8,0.75 --out b.blend
python scripts/cloth_from_body.py -- --blend b.blend   --z 0.545,0.575 --x 0.15 --layer 1 --thickness 0.012 \
       --name GEO-belt --color 0.25,0.15,0.08 --out c.blend          # belt / strap / cuff band
python scripts/cloth_from_body.py -- --blend c.blend   --group skirt_area --name GEO-skirt   # painted area
```
What it does, matching Kenny's v_WMJLudpvg steps:
1. Takes the body faces in the garment region (preset z range and |x| limit in fractions of the height, or a
   painted vertex group) from an untouched `REF-<body>` copy and duplicates them (Kenny: Shift D, P).
2. Relaxes the open edges (LoopTools Relax on openings, 8 iterations), then **Subsurf 1, then Shrinkwrap
   (Outside Surface) last**, applied. Offset = 0.006 + layer × (thickness + 0.004): layer 0 hugs the skin,
   layer 1 goes over layer 0, and so on. Never put a smoothing modifier after the Shrinkwrap (it pulls the
   cloth back inside).
3. **Solidify 0.007 m** (Kenny's value), offset +1 (outward), even thickness, with rim and shell vertex groups,
   then Smooth on the rim (×3) and on the shell (×4), applied. This gives soft hems.
4. `--cut-body` deletes the body faces fully hidden under the garment, keeping a 1-ring border so no gap
   opens when the rig bends it. For games this is mandatory: fewer tris and no poke-through.
5. Bands (`--z` without a group): a clean 48-segment quad ring is ray-cast from the torso centre, offset
   directly, with no Shrinkwrap or Subsurf, giving a belt in about 800 tris with zero intersections.

Presets: shirt (long sleeves), tshirt, tanktop (layer 1), pants, shorts, skirt_base (layer 0, |x| ≤ 0.15 H,
so A-posed forearms stay out). Tested on the box-model body: pants + tshirt + belt give 1–3 clipping verts
(the 1-ring border at the waist) and 0 belt intersections.

## 2. Shape, folds and detail (what the script does not do)
- Skirts and hems that hang away from the body: take `skirt_base`, then move the hem ring out and down
  (proportional edit, or a Simple Deform taper on the lower rows) before Solidify. Kenny's pleated skirt is fully
  procedural (a 33-vert circle, Checker Deselect, scale in to make a star, extrude), see
  `references/masterclass_clothes.md`.
- Folds for games are **baked, not modelled**: put a Multires (2–3 levels) on a copy, draw tension and
  compression folds there (or displace with a fold texture), then bake a normal map to the low cloth
  (`stylized-shaders-and-baking`). Keep the game mesh smooth.
- **Seams without sculpting** (j8LGGNylMOY): Mark Sharp on the seam loop, an Edge Split modifier (edge angle
  OFF) ABOVE Solidify and Subsurf, Solidify crease inner 1 and rim 1. Seams and pockets on hero cloth are
  normal-map details.
- Shoes: Kenny extrudes a cube down the leg and forward along the foot, flattens the sole (S Z 0), extrudes the
  heel, and slices the sole line with Line Project. By script: `--z 0,0.06 --x 0.15 --layer 1` gives the shoe
  upper band around the foot; join a flattened sole slab and remove the toes under it (`--cut-body`).
- Accessories (project breakdowns): necklace = **Array + Curve modifier** on a Bezier; gems = Extra Objects
  **Diamond**; embroidery = a strip duplicated from the hem loop with an image UV-aligned on it; straps and
  bands = the `--z` band mode or a Bezier with a rectangle bevel. Weapons and armour plates are hard-surface:
  bevel weighted edges and keep them as separate rigid pieces parented to one bone.
- Hoodies: hood as a separate piece merged in, inset with B for the face opening, Solidify, then shade smooth.

## 3. Game rules
- Each garment piece stays under 20k tris (Roblox). Hero targets: all clothes and gear together 4k–6k after
  retopo (`stylized-retopology` has Kenny's clothes retopo: follow the main loops, 2 support loops at hems).
- Delete the hidden body under the clothes (`--cut-body`). For Roblox layered clothing, keep the body whole and
  build an inner/outer cage instead.
- Single-sided cloth seen from inside (open sleeves, skirt underside) needs Solidify or a duplicated flipped
  shell; QA shows it as red otherwise.

## 4. QA (mandatory)
After each garment, run:
```bash
python ../stylized-4view-qa/scripts/render_4view.py -- --blend c.blend --out qa_c --ignore hand:body
```
Then check `diag_sheet.png`. MAGENTA means body through cloth: raise `--offset`, thicken, or `--cut-body`.
RED means you see back faces (an open hem from inside). Extra spikes or fins mean a bad vertex; the band
mode and the doubles cleanup exist because QA caught both. Expected intersections: the 1-ring body border
under a hem, and layer-0/layer-1 rims at a waist overlap. Everything else gets fixed.

## Scripts
- `scripts/cloth_from_body.py`: garments, bands and gear rings from the body; Solidify with soft rims; hidden
  body deletion. Tested on Blender 5.2 with the 4-view QA.
