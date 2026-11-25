---
name: stylized-face-proportions
description: Get a stylized head and face right the Kenny Praise way without sculpting from a sphere. Covers image-to-3D head intake and cleanup, Kenny's numeric proportion rules as a headless overlay and check, and the fixes for eyes, lids, nose, lips and ears.
---

# Stylized face and proportions

Sources: masterclass ch. 3 (face), the face proportion guide (UiuGcNmbY-A), eyes (JMStsdAis3g), lips
(sHpxe0kJDk4), stylizing a portrait (euEUJzZDQV0), anime face, weird faces, the lazy face, and coaching
videos. The rules and the sculpt order are in `references/`.

## 1. Head intake (image-to-3D, then cleanup)
We don't sculpt heads from a sphere. Generate the head from the concept (front view, plus 3/4 and side if the
tool takes several images), then:
```bash
python scripts/head_intake.py -- --in head.glb --forward=+Y --up=+Z --head-height 0.25 --base-z 1.45 \
   --symmetrize --remesh 0.004 --tris 20000 --name GEO-head --into body.blend --out char_head.blend
```
- Write the axis values with `=` (`--forward=-Y`), or the shell parser reads them as flags.
- It joins the meshes, applies transforms, turns the face to -Y with Z up, **drops floaters before measuring**
  (one stray blob shifts the centre and the symmetry plane), scales to the planned head height, sits the
  chin on `--base-z`, merges doubles, fills small holes, recalculates normals, mirrors +X onto -X, voxel
  remeshes and decimates. The untouched scan stays hidden as `REF-GEO-head-raw` for baking its colour and
  detail onto the retopo head.
- Head height comes from `refs/proportions.json`: character height ÷ heads tall.
- Then retopologise (`stylized-retopology`, Kenny's face loops) and bake from `REF-…-raw`.

## 2. Kenny's proportion rules (checked by `face_guide.py`)
1. **Eye line = half** the head height (crown to chin), front and side.
2. Hairline to chin in **thirds**: brow line, nose bottom. **Ear between brow line and nose bottom**.
3. Profile: the middle vertical is the jaw/cranium split; the jaw comes forward of it, and the **ear sits behind it**.
   The back of the skull slants into the neck (no bulge); the neck leans forward.
4. **Mouth**: the bottom of the lower lip is halfway from the nose bottom to the chin. Corners never wider than
   the **iris centres**. The upper lip sits in front of the lower lip; the mouth wraps around the teeth.
5. **Eyes**: gap between them = 1 eye width; outer corner to the side of the head = 1 eye width (stylized may
   widen). The nose wing lines up with the inner eye corner. Eyes sit INSIDE sockets, with lids wrapping the
   eyeball (three lid edges: contact, fold, transition). The outer corner is a bit higher; the eye slopes back in
   profile.
6. Profile thirds: eye corner to front of eye = front of eye to front of face = front of face to nose tip. The
   nose projects the most; the nose-tip-to-jaw line slants back.
7. Stylization: list the features to exaggerate (big eyes, small chin...) and push them **the same way on both
   sides**. Never copy a reference 1:1.

```bash
python scripts/face_guide.py -- --blend char_head.blend --head GEO-head --out qa_face --hairline 0.82
```
It renders the head front and side and draws the lines (cyan eye line, orange hairline, yellow brow and nose
thirds, pink mouth line, green eye edges, dashed cyan iris centres, dashed red profile middle). It measures
the eye height against the half line (pass within 6% of the head height), the eye gap in eye widths (0.7–1.5),
eye width against head width (0.15–0.32), and eye levelness, and gives the heads-tall of the whole character.
It writes `face_report.md` and `face_report.json`.

## 3. Fixes (scripted equivalents of Kenny's brushes)
- **Eye line wrong**: move the eyeballs (and the lid ring) in Z, not the whole head. If the head itself is off,
  re-run the intake with a different `--head-height`, or scale the cranium part with proportional editing.
- **Eyes floating or poking out**: QA reports eye × head intersections. Eyes must sit in sockets: push them
  in along Y until only the front cap shows, then shrink the lid ring onto the eyeball (Shrinkwrap with an offset of
  0.001 m on the lid vertex group).
- **Flat face in profile**: move the face front (and nose) forward with proportional editing, or pull the
  sides back. Kenny's most common coaching fix.
- **Ears**: rotated so they don't face front, with front and back edges parallel in profile, and set behind the middle line.
  Big ears read childish; Kenny keeps them simple ("?" helix + "Y" antihelix).
- **Lips**: volume first, then the lip line. Corners pulled in. If the image-to-3D lips are flat, pull the upper lip
  forward 1–2 mm and the lower lip back.
- **Eye highlight**: a small emissive disc mesh on the cornea surface (Kenny's trick), part of the eye.
- Brows and lashes: hair cards (`stylized-base-and-hair`), or placeholder planes with Solidify and a 25% grey
  vertex colour (Kenny), never pure black.

## 4. QA (mandatory)
Run `face_guide.py` and `stylized-4view-qa` (use `--persp` with the 85 mm lens for appeal). Every check must
say yes or have a written stylization reason. Also check `stylized-4view-qa/references/inspection_checklist.md`
section D.

Tested: `face_guide.py` on the proxy head (all checks pass); `head_intake.py` on a deliberately messy fake
scan (wrong axis, floater, noise): it came out 0.259 m tall, centred, symmetric, with 12k tris, 0 non-manifold
edges and 0 inverted faces. QA caught one bug, floaters skewing the symmetry plane, which is now fixed.

## Scripts
- `scripts/head_intake.py`: image-to-3D import, orientation, scale, cleanup, symmetrize, remesh, decimate.
- `scripts/face_guide.py`: Kenny's proportion overlay plus numeric checks.
