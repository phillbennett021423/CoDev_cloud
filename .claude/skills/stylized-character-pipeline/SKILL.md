---
name: stylized-character-pipeline
description: Start here for any stylized 3D game character in Blender (Kenny Praise's workflow adapted for Godot 4 and Roblox). Gives the stage order, budgets, file conventions, and which stylized-* skill to load at each stage.
---

# Stylized character pipeline (Kenny Praise workflow, game-ready)

This skill set comes from studying Kenny Praise's channel (@kennysarts): the 20-hour stylized character
masterclass, the 2.5-hour hair course, and the sculpting, retopology, UV, texturing, lighting and coaching
videos. It is adapted for our targets:

- **Godot 4**: hero 15k–20k tris in total. **Roblox**: every mesh piece under 20,000 tris, textures at most
  1024 px. Both must hold a steady 30 fps on 4 GB devices.
- Blender 5.2, driven by scripts. No hand-sculpting from a sphere: we build bodies with `box_model_body.py`
  and get heads from **image-to-3D**, then clean them up. Kenny's manual steps become bpy scripts or cleanup
  passes.
- It builds on `HOW TO BUILD AAA CHARACTERS (for every AI).md` (Ironbark method: game budgets, bakes, layered
  textures, rigging, animation) and does not repeat it. Where the two disagree on stylized looks, Kenny wins.
  On game delivery, the AAA guide wins.

## The mandatory rule

**After ANY build, cloth, hair, shader, rig or export script, run `stylized-4view-qa`.** Render front, left,
right and back headless, open the sheets, inspect them for clipping, bad normals and proportion drift, fix, and
re-run with `--baseline`. A stage is not done until its QA sheet passes.

## Stage order (Kenny's order, each stage feeds the next)

| # | Stage | Skill | Kenny source |
|---|---|---|---|
| 0 | Concept, references, plan line, budget | this skill + `stylized-concept-and-blockout` | masterclass ch. 0–2, ooylx5B-fv4 |
| 1 | Blockout (big forms only, separate parts) | `stylized-concept-and-blockout` | ch. 2, daCR9IGILkw, ZdybynVI_t0 |
| 2 | Body base: box-model body, hands, feet | `stylized-base-and-hair` | Hdkm7UZ6Oqs, 5RFhA0PG0XE, Z1kABJANH2o |
| 3 | Head and face (image-to-3D, then proportion fixes) | `stylized-face-proportions` | ch. 3, UiuGcNmbY-A, JMStsdAis3g, sHpxe0kJDk4 |
| 4 | Clothes and gear | `stylized-outfit-and-gear` | ch. 5 + 8, v_WMJLudpvg, j8LGGNylMOY |
| 5 | Retopology (face, body, hands, feet, clothes) | `stylized-retopology` | ch. 6–8, retopo series |
| 6 | UVs | `stylized-uv-unwrap` | ch. 9, k81DRUN1wsA |
| 7 | Hair (GN groom, then game cards) | `stylized-base-and-hair` | ch. 10, hair course, C284k-WJDF8 |
| 8 | Shading, texturing, baking | `stylized-shaders-and-baking` | ch. 11, 2kI5IgarERc, IEQ7IVPwwQk, MqVVIKiLcIE |
| 9 | Rig, weights, shape keys, export | `stylized-rig-and-export` | ch. 12 |
| 10 | Pose | `stylized-posing` | ch. 12 (posing half) |
| 11 | Lighting, turntable, presentation render | `stylized-lighting-and-turntable` | ch. 13, YA-MzLhHHb8, 7F0O4ARh43s |

Kenny's golden habits, which apply at every stage:
1. **Reference always** (front, side, back). Keep a second viewport or image editor with the reference open.
2. **Big forms, then medium, then small.** Don't add resolution until the current forms are right.
   Keep parts as separate objects as long as possible (head, nose, ears, fingers), because separate parts
   are easier to fix.
3. **Check from every angle**, often, with a MatCap or silhouette view. (Headless, that is the 4-view QA.)
4. **Lens 150 mm** for sculpting or judging heads, 115 mm for full-body blockouts, 80–90 mm for presentation.
   50 mm distorts.
5. **Systematise**: each stage has a fixed recipe (main loops first, then fill patches, then clean up).

## Conventions (Kenny's naming, kept in our files)

- Collections: `CH-<name>` (the character), `HIGH`, `LOW`, `RIG`, `QA_*` (made by scripts, never saved).
- Objects: `GEO-body`, `GEO-head`, `GEO-eye.L`, `GEO-shirt`, `HAIR-main`, `GEO-scalp`, `CUV-<name>` (hair
  curves), `RIG-<name>`, `REF-*` (hidden helper copies).
- The character faces **-Y**, Z up, feet on Z = 0, height 1.6–1.8 m, all transforms applied (Ctrl A).
- Left/right suffixes are `.L`/`.R` (Rigify and Godot humanoid retargeting rely on them).

## Budget plan (write it before modelling)

| Piece | Godot hero | Roblox |
|---|---|---|
| Body (with hands and feet; hidden parts deleted) | 5k–7k | same, under 20k per piece |
| Head + eyes + mouth bag | 3k–4k | same |
| Clothes and gear (all pieces) | 4k–6k | each piece under 20k |
| Hair cards (+ brows, lashes) | 3k–6k | same |
| **Total** | **15k–20k** | every piece under 20k, 1 texture set at 1024 |

Textures: 2048 for Godot High, 1024 for Godot Low and Roblox. One material and one texture set per character
where possible.

## Done means

- [ ] Every stage's QA sheet passes (`stylized-4view-qa`) and the last `metrics.json` is kept with the asset.
- [ ] The budget table holds. Every piece is under 20k tris.
- [ ] Hair, brows and lashes are cards, not curves. Procedural shaders are baked to textures.
- [ ] Rig: only DEF bones are exported, weights are limited to 4 per vertex, and the shape keys the engine
      supports are kept (Godot: morph targets; Roblox: FACS only).
- [ ] A turntable or presentation render goes to the owner (`stylized-lighting-and-turntable`).

## Kenny's quick tips (all stages)
`references/tips_and_workflow_overviews.md` has his 50 tips and the workflow overviews. Ones we always apply:
silhouette check in black, rim light to separate from the background, eye highlights, no oversaturated
colours, subtle yellow/red/blue zones across the face, finger bones pre-curved in the bend direction, a blockout
backup collection before detailing, and compositing the final render.
