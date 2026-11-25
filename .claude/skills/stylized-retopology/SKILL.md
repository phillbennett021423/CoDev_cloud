---
name: stylized-retopology
description: Retopologise a stylized character for games the Kenny Praise way (deformation loops, ring counts that match between parts, clothes that share the body's topology), with an automatic QuadriFlow route plus Kenny's topology checks by script.
---

# Stylized retopology (Kenny Praise, masterclass ch. 6–8, retopo series gnVeCRQVc-s, 5wiu7WvJgw8, k8DdH_wExtE)

Kenny calls the clothes retopo "the most important chapter". Rules first, then the scripted route.

## Kenny's rules
- All quads where it deforms. Only 3-poles and 5-poles, never 6+ (they pinch). Loops follow the forms.
- **Face loops for animation**: around each eye (so the lids close), around the nose, **around the mouth (the
  most important)**, the nasolabial loop (nose wing to mouth corner to chin), the face contour (forehead, side,
  chin), around the ear. Every starting ring has **8 edges**; extrude rings outward (E, S). The mouth loop has
  the same count top and bottom. Grid Fill needs an even count.
- **Body loops**: shoulder loops over the deltoid to the back plus loops around the armpit; a bevelled patch on
  the back of the elbow and the front of the knee (bevel a loop, merge, dissolve the tris); several close
  loops at the wrist; loops around the glutes so volume holds when the leg lifts. Even counts down the limbs.
- **Ring counts that must match** where parts join: neck ring = head's neck ring (**14** in Kenny's build),
  armhole **20**, wrist **20** (palm reduces 34 → 22 → 20), thumb root 20. Join with Bridge Edge Loops.
- Fingers: a box per finger, 2 faces across the top, 3 down each side, **two loops at every joint**; the thumb
  has 2 joints. Feet: like the fingers for toes, or a closed shoe.
- **Clothes share the body's topology**: duplicate the retopo body, delete the faces the garment doesn't
  cover, Shrinkwrap it to the cloth, then line loops up with seams and fold high and low points; bevel seams for
  support loops. Cloth with different topology clips through the body when posed (Kenny demos this).
  `cloth_from_body.py` already works this way: its garments are made from the body faces.
- Real-world scale before retopo: 1.6–1.8 m, feet on Z = 0, transforms applied.
- Detail transfer (VAAhoJAIm0E): Multires ×2 on the low, Shrinkwrap to the high, apply, then either keep it for a
  normal bake or Apply Base (simple stylized forms).

## Scripted route
```bash
# image-to-3D head / remeshed parts -> all-quad low mesh, projected and relaxed, with a report
python scripts/retopo_auto.py -- --blend char_head.blend --high GEO-head --faces 1500 --name GEO-head-low --out low.blend
# checks only (any mesh, including hand-made retopo)
python scripts/retopo_auto.py -- --blend low.blend --check GEO-body,GEO-head-low,GEO-shirt
```
- **QuadriFlow** (X symmetry, boundary kept) builds the quads, then Shrinkwrap, a length-weighted relax and a
  second Shrinkwrap put them back on the surface. A broken high falls back to Decimate (reported).
  `--detail multires` keeps two Multires levels shrinkwrapped to the high for the normal bake;
  `--detail apply-base` pushes the volume into the cage.
- The report gives tris, quad share, n-gons, poles (3 / 5 / 6+), **open boundary rings with vertex counts
  and heights** (to match the neck and wrist rings before joining), and how far the high surface sits from
  the low (mean / p95 / max mm = lost detail, which the normal bake must carry).
- The box-model body from `box_model_body.py` is already game topology (all quads, joint rings, 1.4k tris); check
  it, don't retopologise it.
- QuadriFlow loops don't follow the eyes and mouth exactly. For a hero face that talks or blinks, hand-fix
  the eye and mouth rings using the report and Kenny's loop plan, or give the face a hand-made retopo and
  use this script only to check it.

## Budgets
Head + eyes + mouth bag 3k–4k tris, body with hands and feet 5k–7k, clothes 4k–6k (Godot hero total 15k–20k).
Every piece under 20k for Roblox. Faces: target `--faces` ≈ tris ÷ 2.

## QA (mandatory)
1. Topology report: quad share ≥ 0.95 on deforming parts, 6+ poles = 0 on the face and joints, n-gons 0, ring
   counts match across joins, deviation p95 under about 1 mm on a 1.7 m character (bake the rest).
2. `stylized-4view-qa`: clay shading smooth (no stripes or pinches), no red, eyes inside sockets.

Tested: a 12k-tri image-to-3D style head became 2,972 tris, 100% quads, 0 6+ poles, with a mean deviation
of 0.25 mm and p95 of 0.6 mm. The body check found the neck rings (14) and a 12 ring; the pants check found
4 six-poles at the crotch, to fix before rigging.

## Scripts
- `scripts/retopo_auto.py`: QuadriFlow retopo, projection, relax, optional Multires detail, plus Kenny's topology report.

## Fast route for a generated full character (tested on the katana hero, Meshy, 1.6M tris)
When the whole character comes from image-to-3D and only a game mesh is needed quickly:
1. **Weld first** (`remove_doubles` 1e-5). Generated meshes split vertices along UV seams; decimating split
   vertices tears visible cracks down the face (the first try showed a lit/unlit split through the nose).
2. **Split by budget, not by object**: head+hair (z above the collar) and body as two pieces, each Collapse-
   decimated to ~19k tris, so the face and locs keep their density. A Decimate vertex group does NOT do this.
   **Lock the cut**: put every vertex except the cut edge (and one ring in) in a Decimate vertex group, so both
   pieces keep the identical seam. After rigging, **copy the body's weights onto the head's seam vertices**
   (KD-tree, same position). Without both steps the collar tore open in the posed render (user caught it).
3. **Fresh UVs + bake from the full model** (Smart UV Project, then Cycles selected-to-active DIFFUSE color,
   NORMAL and ROUGHNESS at 2048, cage 0.015, ray 0.06). The generated UVs and normal map stop matching after
   decimation.
4. Rig with `rig_and_export.py --body <body> --head <head> --rigid katana:LeftHand`. On a non-welded mesh, bone
   heat fails; weight a voxel-remeshed proxy (0.012) and Data Transfer the weights instead.
