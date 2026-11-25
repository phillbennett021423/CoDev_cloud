---
name: stylized-4view-qa
description: Mandatory headless 4-view render check (front, left, right, back) with automatic clipping, normals, budget and proportion-drift checks. Run it after EVERY build, cloth, hair, rig or shader script on a stylized game character in Blender.
---

# Stylized 4-view QA (mandatory)

Every other `stylized-*` skill ends with this step. A script that builds or changes a character is not done
until its four views are rendered, opened and inspected. Kenny Praise checks every stage from the front, side
and back against the reference and with a MatCap or silhouette view. This skill is that habit, run headless.

## Run it

```bash
# Blender binary (laptop / CI)
blender -b char.blend -P .claude/skills/stylized-4view-qa/scripts/render_4view.py -- --out qa/01
# Blender as a Python module (cloud): pip install bpy==5.2.*  (Python 3.13)
python .claude/skills/stylized-4view-qa/scripts/render_4view.py -- --blend char.blend --out qa/01
# every later run: compare against the last good run
python .../render_4view.py -- --blend char.blend --out qa/02 --baseline qa/01/metrics.json
```

Useful flags:
- `--collection CH-hero` checks only that collection.
- `--inner GEO-body,GEO-head --outer GEO-shirt,GEO-pants` sets the clipping pairs. By default, names with
  body/skin/head/torso are inner and every other mesh is outer, except eyes, teeth, tongue, brows, lashes,
  hair and scalps.
- `--ignore hand:body,scalp:head` lists contacts that are meant to happen.
- `--persp` uses an 85 mm presentation camera instead of orthographic.
- `--engine BLENDER_EEVEE` is faster on a GPU laptop. Cycles on the CPU works everywhere.
- `--res 800`, `--samples 24`, `--drift 0.02`, `--tri-budget 20000`.

It never saves the `.blend`. A run takes about 30 s at 500 px on a cloud CPU.

## What you get (in `--out`)

| File | Use |
|---|---|
| `sheet.png` | 2x2 beauty sheet with the scene's materials: front, left / right, back |
| `diag_sheet.png` | clay pass: **red = back faces you can see (flipped normals or holes)**, **magenta = skin poking through cloth** |
| `report.md` / `report.json` | tris per piece, non-manifold edges, inverted closed pieces, unapplied scale, clipping counts, mesh intersections, proportion drift |
| `metrics.json` | height, width, depth, heads tall, per-object size and centre: the baseline for the next run |

## Inspect (do not skip)

Open BOTH sheets with the Read tool and go through `references/inspection_checklist.md`. In short:

1. **Report issues first.** Any over-budget piece, inverted normals, unapplied scale, feet not on Z = 0, or
   drift you did not intend must be fixed and the QA run again.
2. **diag_sheet**: no red anywhere you can see. Magenta = clipping, so fix the cloth offset or the
   Shrinkwrap, or delete the hidden body faces.
3. **Silhouette** (front + side): it reads clearly. Arms in an A-pose don't merge into the torso. The
   neck leans forward, it's never vertical. The back of the head slants into the neck. The heel is wider than
   the ankle.
4. **Proportions** against the reference and `stylized-face-proportions` (eye line halfway down the head,
   ears between the brow line and the nose bottom, mouth corners inside the iris centre, and so on).
5. **Symmetry**: left vs right views mirror each other unless asymmetry is intended (cloth folds, hair).
6. **Shading**: no faceting stripes, no black blotches (bad normals), no seams or stretched textures on the
   front view.

Write what you saw in one short paragraph. Name each fix, apply it, run QA again with `--baseline`. Repeat
until the report shows no unintended issues and the sheets pass the checklist. Then show the user `sheet.png`.

## Notes
- The convention matches Kenny and Rigify: the character faces **-Y**, Z is up, feet on Z = 0, transforms
  applied. "Left" means the character's own left (+X).
- The lights match Kenny's chapter 13 setup: soft key Area front-left, weaker cool fill front-right, strong
  rim behind, a low-strength world, and a cyclorama that turns with the camera (empty at 0/90/180/270).
- Hair curves render too. If the hair is very dense, set the Interpolate viewport/render amount down first.
- Clipping painted magenta needs the mesh without a modifier stack. With modifiers, the report still lists
  counts. Apply a copy, or trust the counts.
