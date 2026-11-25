---
name: stylized-posing
description: Pose a rigged stylized character the Kenny Praise way (line of action, balance, contrapposto, no mirrored limbs, exaggeration) for presentation renders and to test deformation, by script with presets on the humanoid game skeleton.
---

# Stylized posing (Kenny Praise, masterclass ch. 12, posing half)

## Kenny's rules
- **Posing matters more than the rig.** Always pose from reference (how far does the shoulder rise when the
  arm goes up?).
- Find the **line of action** (one clear curve through the body) and the **balance** (the weight sits over
  the support foot; in the front view, a vertical from the neck pit lands on the support foot).
- **Contrapposto**: weight on one leg. The pelvis drops on the free side, the shoulders tilt the opposite way,
  one side of the torso stretches and the other compresses. **Hip and shoulder lines are never parallel.**
- **Never mirror** arms or legs. **Exaggerate** past the reference for stylized work. Where the rig limits you,
  push with shape keys.
- Pose the bare body first (clothes masked or hidden), then turn the clothes back on and fix the folds for the
  pose (Kenny re-sculpts folds and re-grooms hair after posing for stills).
- Make **at least 2 poses** for the final renders, and store them (Kenny: Pose Assets; we use actions `POSE-<name>`).

## Script
```bash
python scripts/pose_presets.py -- --blend hero_rig.blend --pose contrapposto --out hero_idle.blend
python scripts/pose_presets.py -- --blend hero_rig.blend --pose all --out-dir poses --scale 1.15   # 15% more exaggeration
```
Presets for the humanoid skeleton from `stylized-rig-and-export`: `contrapposto` (weight on the right leg,
pelvis dropped left, chest countering), `hero_stance` (wide and grounded, chest up), `action_lunge` (forward C
line of action, arms in opposition, pelvis dropped 9% of the height to plant the front foot), and `arms_down`
(the deformation baseline). Angles are world-axis degrees applied parent first, so a preset means the same
thing on any character built by these skills. Add a preset by copying a row and changing the numbers.
- There is no IK in the game skeleton: check foot contact on the side view and adjust `_hips_drop` or the knee bend.
- Lower-arm bends are about X (forward) because the upper arm has already been rotated down. Rotating them about
  Z swung a forearm through the crotch in the first test; the 4-view caught it.

## QA (mandatory)
Run `stylized-4view-qa` on each posed file (`--persp` for appeal):
- [ ] The line of action reads in the side view. Hip and shoulder lines aren't parallel in the front view.
- [ ] Feet are planted (support foot on Z = 0), and nothing sinks into the floor.
- [ ] No limb passes through the body or the clothes (no new magenta in diag). Elbows and knees keep their volume.
- [ ] The silhouette reads in black: arms separated from the torso on at least one side.

Tested: all four presets on the test character (box-model body, pants, belt, curls).

## Scripts
- `scripts/pose_presets.py`: Kenny-rule pose presets as actions, with an exaggeration multiplier.
