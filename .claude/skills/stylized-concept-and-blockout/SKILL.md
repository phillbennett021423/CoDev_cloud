---
name: stylized-concept-and-blockout
description: Plan and block out a stylized character the way Kenny Praise does. Covers concept and reference gathering, shape language, proportions measured from the concept, a round-cube part blockout, and image-to-3D intake. Use it before any body, head or clothes work.
---

# Concept and blockout (Kenny Praise, masterclass ch. 1–2, daCR9IGILkw, ZdybynVI_t0, znN3h5YtWa8)

The blockout decides 80% of the result. Kenny: "these big shapes are the most important steps for your
character". Don't add resolution or detail here.

## 1. Concept and references (write them down, in a file next to the .blend)

- One concept you find appealing. While learning, avoid designs that are too complex.
- Collect references **per part**: face style, plus 2–3 real faces of matching ethnicity as proportion
  guides, footwear (the exact model plus 3 more for folds), cloth mechanics (how a skirt or hood hangs), hair
  direction and parting, body, materials, jewellery. Kenny keeps PureRef pinned on top. We keep
  `refs/<part>_*.png` and load them as reference images.
- **List the features to exaggerate** (euEUJzZDQV0): big eyes, small chin, long legs, and so on. Every later
  check compares against this list.
- **Shape language**: name the concept's dominant shape (round, angular, boxy or triangular) and repeat it on
  EVERY part: face, legs, hands, clothes.
- Write the plan line and budget (see `stylized-character-pipeline`).

## 2. Proportions come FROM THE CONCEPT

Stylized designs break real proportions. Measure in head units directly on the concept: head height vs
torso vs legs (some designs use head = torso = legs). Record them in `refs/proportions.json`:

```json
{"heads_tall": 6.0, "shoulder_w_H": 1.85, "hip_w_H": 1.45, "crotch_H": 2.8, "eye_line": 0.5, "notes": "long legs, small hands"}
```

`box_model_body.py` takes the closest preset. Adjust the PRESETS row to match these numbers.

## 3. Blockout rules (Kenny)

- Simple primitives only: **Round Cube** (Extra Mesh Objects extension), low resolution. One object per part:
  head, neck, ears, ribcage, waist, pelvis (a duplicate of the ribcage rotated 180°), upper leg, lower leg, foot,
  deltoid cap, upper arm, forearm, hand paddle.
- Transform in EDIT mode so the origin stays at the world centre and Mirror works. If you moved it in object
  mode, Ctrl A (apply all transforms) before sculpting.
- Each limb has one curved side and one straight side: thigh curved at the front and straight at the back;
  calf curved at the back. An **S-curve** runs through the side silhouette: the neck tilts, the ribcage tilts,
  the pelvis tilts the opposite way.
- Parts **flow into each other** (overlap and pull edges into the neighbour). They never stack like blocks.
- Head = egg. Slice the sides flat (Line Project). Crease the jaw/cranium split up to where the ear sits. The
  back of the head is not fully round. The neck tilts backward at the bottom with its top forward, and flares
  into the chest, back and shoulders.
- Legs: the "angry face" rule on the lower legs: the outer calf sits high, the inner calf low. The **inner
  ankle bone is higher than the outer one**. The foot is a right triangle from the front (inner side vertical).
  The heel is wider than the leg.
- Arms in an **A-pose**, not too close to the body. Bend the elbow slightly so the IK knows which way it
  bends. The bicep ends in a V into the forearm. The deltoid is a separate cap flowing into the chest and back
  (small for females).
- Character faces -Y with transforms applied (ZdybynVI_t0: a student's model faced +Y with Z rotation 180, so
  everything was mirrored).
- Final pass: compare with the references, fix proportions by scaling groups in edit mode, take a break,
  check again.

## 4. Scripted route (what we actually run)

1. Body: `stylized-base-and-hair/scripts/box_model_body.py --preset <closest> --height <m> [--female 0..1]
   --hands --head-proxy`. It gives a mirrored all-quad base mesh with joint rings, in an A-pose, facing -Y.
2. Head: **image-to-3D** from the concept's face (front + 3/4 views if the tool takes several images). Import
   it, then clean it up (see `stylized-face-proportions`). Don't sculpt a head from a sphere by script.
3. Whole-character image-to-3D (optional, for silhouette only): import it as `REF-concept3d`, scale it to the
   planned height, and use it as a fit target for the body (Shrinkwrap preview) and for proportions. Never ship it.
4. Run `stylized-4view-qa` with `--persp`, compare `sheet.png` side by side with the concept, and fix the
   proportions table, then rebuild. Iterate until the silhouette matches.

## 5. Blockout QA (on the 4-view sheet)

- [ ] The silhouette matches the concept in black (MatCap black / flat check).
- [ ] The dominant shape language shows on every part.
- [ ] The S-curve is visible in the side view. The neck is not vertical. The back of the head slants into the neck.
- [ ] Inner ankle higher than outer. Heel wider than the leg. A-pose with slightly bent elbows.
- [ ] Head units match `refs/proportions.json` within 3%.

See `references/blockout_and_concept.md` for Kenny's coaching corrections and the weird-face method.
