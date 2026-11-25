---
name: stylized-base-and-hair
description: Build a stylized character's base body (box-modelled body, hands, feet) and its hair, brows and lashes the Kenny Praise way, by script. Includes the GN groom recipes and the conversion to game hair cards for Godot and Roblox.
---

# Stylized base body and hair

Kenny Praise's sources: box-modelled body without sculpting (Hdkm7UZ6Oqs), hands (5RFhA0PG0XE), feet
(Z1kABJANH2o), masterclass ch. 4 (body) and ch. 10 (hair), the 2.5 h hair course (8eVlQZuQOj4), procedural
hair (zV4tnpVhadM), brows and lashes (C284k-WJDF8), and grooming brushes (G_iPk5SrEHc). Exact settings are
in `references/`.

## A. Base body (script, no sculpting)

```bash
python scripts/box_model_body.py -- --preset stylized --height 1.7 --female 1 --hands --head-proxy --out body.blend
```

- Kenny box-models from a cube: chest, torso, legs from 4 faces, arms from 4 side faces in an A-pose, a neck
  from an inset, LoopTools Circle on every ring, Subsurf, Inflate, and **4-face inset patches at the knees and
  elbows** for deformation. The script builds the same thing as a half skeleton of vertices with elliptical
  skin radii from a proportion table in head units. Mirror (clipping) goes under a Skin modifier, then
  Subsurf. The result is all quads with round rings, 3 rings at every knee and elbow, a forward-leaning neck,
  the seat back and the chest forward, a heel wider than the ankle, and the forearm turned slightly forward.
- Presets: `chibi` (3.5 heads), `stylized` (6), `hero` (7), `heroic` (8). Widths are in head heights
  (shoulders about 1.85–2.35 H, hips about 1.45 H, thigh about 0.6 H). Edit the PRESETS row to match
  `refs/proportions.json` from the blockout.
- Hands = Kenny's method: a palm block plus **skin-modifier finger chains** (one vertex chain, Skin, Subsurf).
  There are 3 segments per finger, matching the Rigify finger bones. The knuckles sit on an arc. The middle
  finger is longest and the pinky shortest. The curl is relaxed and never parallel. The thumb sits on the pad.
  Kenny's feet are a wedge plus 4 linked toes (Alt D). For shoe-wearing game characters, skip toes (the shoe
  hides them).
- `--head-proxy` gives an egg with a jaw wedge plus eyes on the half line, **for blockout only**. The real
  head comes from image-to-3D plus cleanup (`stylized-face-proportions`).
- Then: QA (`stylized-4view-qa`), fix the proportions in the table, rebuild. After the head and hands are
  final, join and merge them to the body at the neck and wrist rings (the edge counts must match;
  `stylized-retopology` has the counts).

Manual refinements Kenny makes, which you can do with Grab-equivalent edits or Shrinkwrap to an image-to-3D
body: hips wider on females, belly pulled out slightly, back crease (a loop pushed in at the spine), knee
and elbow shapes on the inset patches, ankle bones (the inner one higher).

## B. Hair: groom (GN), the Kenny way

Kenny's order is always: **scalp, then guides, then interpolate, then clump, then noise**.

```bash
python scripts/hair_groom_gn.py -- --blend char.blend --head GEO-head --preset curly --out char_hair.blend
# presets: curly (zV4tnpVhadM), straight (masterclass), short, brows (C284k)
# real characters: paint a vertex group "scalp" on the head and pass --group scalp
```

- **Scalp** = the head's faces inside the hairline, duplicated, cleaned (no modifiers, shape keys, vertex
  groups or materials) and **UV-unwrapped. The UV is mandatory**, because Generate/Interpolate read it.
  Kenny draws the hairline with an annotation and builds a clean quad scalp with F2. A duplicate plus a
  Shrinkwrap does the same job.
- Curves render as **Strip** (not Strand) so Set Hair Curve Profile radius works (0.001 m typical).
- Curly: Curl guide distance 0 (each guide curls alone, existing guide map OFF) with radius 0.01, then
  Interpolate 50k–100k, then a second Curl with guide distance 0.015, then a secondary clump at 0.05 and a
  primary at 0.015 (factor 0.7), then Noise with cumulative OFF, scale along 20, scale 5, offset per curve
  0.2, applied to a random subset of curves only (Random, then ColorRamp black 0.4, into Factor).
  Fill a sparse scalp with a second short layer (density 5000, length 0.02–0.03) joined in.
- Straight/groomed styles (masterclass): guide brushes (brow length 0.007, 20–30 points), density masks
  painted at 2048, Interpolate 50k–800k, Clump 0.04/0.02, Delete Geometry 0.95 then Create Guide Index Map,
  Blend Hair Curves radius 0.01 with a pattern vertex group, noise subsets via Separate/Join, Trim for
  flyaways, Part by Mesh Islands. Hair course: Group ID stops left/right clump bleed; Duplicate Hair Curves
  (200 at 0.001–0.003) thickens a style; Spline Parameter into a ColorRamp into Clump Shape for ponytails;
  braid presets are in `references/hair_course_curls_braids_ponytails.md`.
- Brows: a brow scalp from the head's brow faces, guides 0.01 long combed (Projected), Interpolate
  100k–1M **masked by a painted 2K density texture**, a small Clump. Lashes: separate upper and lower lid
  scalps (V-rip at the corners), short guides, about 7k children, Clump with a tiny distance and Tip Spread;
  the lower lashes are fewer and thinner.
- Material (script): Principled Hair, melanin model, on the Cycles output, with `--melanin` 0.1 blond to
  0.85 dark. Principled BSDF with an Intercept ramp (root dark to tip light) times per-strand Random on the
  EEVEE output (masterclass ch. 11).
- Keep Interpolate's viewport amount at 0.1 while working (Kenny), and full for renders.

## C. Hair for games: cards (mandatory for Godot/Roblox)

```bash
python scripts/hair_to_cards.py -- --blend char_hair.blend --hair HAIR-curly --cards 400 --width 0.012 --out cards.blend
# brows / lashes: --cards 40 --width 0.004 --segments 3
```

The script evaluates the groom, samples N curves (one per clump), and builds tapered ribbons that face away
from the head with a slight twist, using UVs root (V = 0) to tip (V = 1) inside a 4-tile strand atlas. It
makes a procedural RGBA strand texture (root darker) and an alpha-clip material, then reports tris against the
hair budget (default 12k; each piece must stay under 20k).
Godot: alpha scissor (glTF alpha MASK). Roblox: SurfaceAppearance with alpha. For hero quality, bake the
groom's colour and alpha onto the atlas tiles instead of the procedural strands (Cycles bake, Selected to
Active, from the curves to card planes laid flat in a bake scene).

## D. QA (mandatory)

Run `stylized-4view-qa` after each script, with `--ignore hand:body,hair:head,scalp:head` until hands and
scalp are merged. Check against `stylized-4view-qa/references/inspection_checklist.md`:
- Body: silhouette, A-pose, joint rings, feet on Z = 0, the neck leaning forward.
- Hair: no bald scalp from the front or back, root darker than tip, no spaghetti from the side, the parting
  where the concept has it. Cards show red in the diag pass by design, so judge them on `sheet.png`.

## Scripts
- `scripts/box_model_body.py`: body, hands, head proxy. Tested on Blender 5.2.
- `scripts/hair_groom_gn.py`: scalp plus the GN groom stack (Essentials hair node groups) plus the hair material.
- `scripts/hair_to_cards.py`: curves to game cards plus the strand atlas plus the alpha material.
