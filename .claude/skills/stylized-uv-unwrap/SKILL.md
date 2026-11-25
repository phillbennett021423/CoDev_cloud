---
name: stylized-uv-unwrap
description: UV unwrap a retopologised stylized character the Kenny Praise way (seams on hidden or natural breaks, Minimum Stretch, even texel density with the face scaled up, one packed atlas), by script with a stretch and texel report and a checker 4-view check.
---

# Stylized UV unwrap (Kenny Praise, masterclass ch. 9, k81DRUN1wsA)

Kenny's three steps: **1 cut seams, 2 fix stretching, 3 arrange UVs.** UVs come after retopology. Never
unwrap a sculpt or a Multires level.

## 1. Seams (Kenny's placement rules)
- Hide seams where the camera doesn't look, or put them on natural breaks (garment seams, hairline, under
  the jaw).
- Limbs and the neck are cylinders: one ring at each end plus **one straight cut on the inner or under side**
  (inside of the leg, underside of the arm, back of the neck). Neck rings go where the collar covers them.
- Torso: front and back split by a loop down each side, mirrored.
- Hands: one loop splits the back from the palm. **Every finger is its own island** (ring at the base, cut
  along the side). Feet: one loop splits the top from the sole.
- Head: a seam from the back of the neck, up the back of the head (under the hair) to the crown. Ears are
  separate islands (front and back). The **eye cavities and the mouth bag** are their own islands; cut the
  mouth bag down the middle.
- Clothes: seams on the real garment seams (sides, under the sleeves); leave the inner shell faces attached.
- Mirror seams with Select Mirror (Ctrl Shift M, Extend). If it fails, the mesh is asymmetric: Snap to Symmetry.

By script: mark them as vertex-group borders (`--seam-groups`), on the back centre line (`--back-seam`), or
on hard edges (`--sharp-angle 70` for hard-surface gear). `stylized-retopology` marks the body seams as it
builds the loops. An object with no seams, or whose seams collapse a closed tube, falls back to Smart UV
Project and is **flagged in the report**: fine for props and placeholders, not for a hero face.

## 2. Unwrap and stretch
- **Unwrap Minimum Stretch** (Blender 4.3+; Kenny prefers it to Angle Based for characters).
- Then **Average Islands Scale** so every island has the same texel density.
- Stretch check: Kenny uses Display Stretch (all blue) and a 4096 Color Grid checker. The script reports
  `area_stretch` per object (0 is perfect; under 0.35 is good; over 0.6 triggers the fallback) and
  `zero_area_uv_faces` (must be 0).
- Kenny's face fix: pin the borders, eyes and ears, then scale the lip region in Y; **scale the eyelid rows
  down in Y** so blinking doesn't stretch the texture. Straighten skewed strips by pinning both ends and S X 0.

## 3. Arrange (one atlas)
- **Texel priority**: the face (and ears to match) UP, unseen parts (legs inside boots, inner skirt, soles)
  DOWN: `--priority GEO-head:1.6,GEO-hand:1.2,GEO-boots-inner:0.5`.
- Pack everything into ONE atlas (rotation on, island gap 0.008 = 8 px at 1024; the bake bleed must stay at half the gap or one object paints into its neighbour).
- Kenny's layout habits for hand-arranged hero UVs: the character's right parts on the right, checker letters
  upright, fingers laid out in order, no overlaps. Mirrored overlapping UVs only for parts that never get
  asymmetric paint (not the face).
- Game textures: 2048 for the Godot hero, **1024 for Roblox**. At 1024, aim for at least 400 px/m on the body
  and 600+ on the face (the report gives `texel_px_per_m`).

```bash
python scripts/uv_unwrap.py -- --blend char_retopo.blend --objects GEO-body,GEO-head,GEO-shirt,GEO-pants \
   --back-seam GEO-head --priority GEO-head:1.6 --tex 1024 --out char_uv.blend --checker-out char_checker.blend
python ../stylized-4view-qa/scripts/render_4view.py -- --blend char_checker.blend --out qa_uv --no-diag
```

## 4. QA (mandatory)
On the checker 4-view sheet: squares are even across body parts (texel density), not stretched into
rectangles, with no seams across the front of the face or the chest, and smaller squares on the face (more
texels). In `<out>_uv_report.json`: `zero_area_uv_faces` = 0 for everything, and every `fallback` entry is
either accepted (prop) or fixed with real seams.

Tested on the box-model test character: head 646 px/m (stretch 0.30), body, pants and belt about 400 px/m
(stretch 0.07–0.29). The body and pants were flagged as fallbacks because they had no seams yet.

## Scripts
- `scripts/uv_unwrap.py`: seams, Minimum Stretch, Average Islands Scale, priority scaling, pack, report, checker copy.
