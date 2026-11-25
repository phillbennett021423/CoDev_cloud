---
name: stylized-rig-and-export
description: Rig, skin and export a stylized game character (Kenny Praise's Rigify and weight rules, translated for engines). Covers a deform-only humanoid skeleton fitted from the mesh, automatic/rigid/transferred weights limited to 4, a pose test, and glTF for Godot 4 and FBX for Roblox, by script.
---

# Stylized rig and export (Kenny Praise, masterclass ch. 12, plus the AAA guide's game rules)

## Kenny's rules we keep
- Bones are placed IN the volume at the joints: the thigh from the hip middle, the knee **slightly bent
  forward** (IK bend direction), the ankle at the pivot, the heel at the bottom of the shoe, and the elbow
  slightly bent. Transform in Edit mode only, never object scale.
- Fingers: every finger bone's X axis is the curl axis, chains are straight, and middle joints are raised slightly so the curl goes to the palm.
- Weights: body, head and hands get **Automatic Weights**. Eyes, teeth, scalps and hairbands get **Empty Groups +
  100% to one bone** (auto weights let temple bones warp the eyes). Shirts and brow/lash scalps get **Transfer
  Weights from the body (Nearest Face Interpolated, By Name)**. Multi-part shoes, skirts and necklaces get a low-poly
  rig-helper proxy + Surface Deform. The Armature modifier goes **FIRST** in the stack.
- Corrective shape keys driven by bones (Kenny's `eye_close` driven by the lid bone Y, split L/R with
  `left_side`/`right_side` groups at 0.5 on the centre line).

## Game translation (our rules)
- Export **deform bones only**, with humanoid names the engines retarget: Godot `SkeletonProfileHumanoid`
  (Hips, Spine, Chest, UpperChest, Neck, Head, LeftUpperLeg, LeftLowerLeg, LeftFoot, LeftToes, LeftShoulder,
  LeftUpperArm, LeftLowerArm, LeftHand, fingers LeftIndexProximal/Intermediate/Distal …), which map to Roblox
  R15 parts.
- **At most 4 influences per vertex**, weights under 0.01 dropped, normalised. Helper groups (rim, shell,
  pattern, mask) are removed from export meshes.
- Surface Deform and Mask modifiers don't exist in engines: transfer the proxy's weights into the part, and
  delete the masked body faces (`cloth_from_body.py --cut-body`).
- Shape keys: Godot takes them as morph targets. Roblox takes only FACS heads.
- Hair: cards are rigid to Head. Groom curves (renders only) are bone-parented to Head.

## Script
```bash
python scripts/rig_and_export.py -- --blend hero_baked.blend --body GEO-body --fingers \
   --out hero_rig.blend --glb export/hero.glb --fbx export/hero_roblox.fbx --pose-test hero_posed.blend
```
1. **Landmarks from the mesh**: torso slices give hips, spine, chest, upper chest, neck and head; leg slices give
   hip, knee (pushed forward slightly), ankle, ball and toe tip; the A-posed arm gives shoulder, elbow (bent back
   slightly), wrist and hand; with `--fingers`, 3-bone fingers go to the five finger tips of `GEO-hand.*`. A body
   cut under its clothes is measured and weighted from its uncut `REF-` copy.
2. Bone rolls point Z forward on limbs. Every bone is deform; there are 52 bones with fingers.
3. **Weights**: automatic on body, head and hands. Rigid to Head for names with eye, teeth, tongue, scalp, hair, brow,
   lash, cornea, helmet or hat. Transferred from the (uncut) body for everything else. Then limited to 4.
   The log lists the influences before the limit and any **unweighted vertices** (must be 0).
4. **Pose test** (`--pose-test`): arms down 35°, elbows bent forward 80°, one thigh up 35° with the knee bent
   60°, head turned 25°, saved as action `QA_pose_test` in a copy.
5. Export: **glTF binary** for Godot (+Y up, modifiers applied, skins, morph targets, no animation) and **FBX**
   for Roblox (deform only, no leaf bones, FBX scale all, textures embedded). Import into Roblox with the
   rig-import settings from the Roblox thread; check that no piece is over 20k tris and textures are 1024.

For animation in Blender, rig with Rigify the Kenny way (`references/masterclass_rig_weights_shapekeys.md`),
then export its DEF bones renamed to the humanoid names. The game skeleton here is the quick, engine-first route.

## QA (mandatory)
Run `stylized-4view-qa` on the pose-test file, not only the rest pose:
- [ ] Elbows and knees keep their volume (no candy-wrapper twist, no collapse). Shoulders don't cave in.
- [ ] Clothes follow the body with no new magenta (body through cloth) compared to rest pose; belts stay on.
- [ ] Hair, eyes and brows follow the head turn. Nothing stays behind at the origin.
- [ ] Unweighted vertices = 0. Max influences ≤ 4.
- [ ] The exported .glb opens in Godot with a Skeleton3D, and the humanoid BoneMap auto-fills.

Tested on the test character: 52 bones; body, head, hands, eyes, pants and belt all weighted with 0 unweighted
vertices; the .glb (2.6 MB) and .fbx exported. The pose-test QA caught two bugs, now fixed: arms rotated on the
wrong axis, and groom hair left behind on a head turn.

## Scripts
- `scripts/rig_and_export.py`: skeleton fitting, weights, 4-influence limit, pose test, glTF and FBX export.
