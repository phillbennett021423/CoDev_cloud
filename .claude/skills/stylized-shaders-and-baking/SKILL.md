---
name: stylized-shaders-and-baking
description: Shade a stylized character the Kenny Praise way (procedural skin with cavity, colour variation, warm rim and SSS; hair, eye, cloth and metal recipes) and bake everything into one game texture set for Godot 4 and Roblox, by script.
---

# Stylized shaders and baking

Sources: masterclass ch. 11 (shading and texturing), procedural skin (mkj1o0IvZtw), vertex-paint skin
(IEQ7IVPwwQk), hand-painted texturing (2kI5IgarERc), SSS mask (MqVVIKiLcIE). Exact node values are in `references/`.

Kenny's 3 steps: **1 material blockout** (flat colour and roughness per part, picked from a palette made from
the concept), **2 textures** (painted colour, baked pointiness, baked normals, PBR fabric/leather), **3
procedural enhancement** (variation, rim, bump, SSS). "Good materials tell a story": never a flat Principled
with uniform roughness.

## 1. Skin (script)
```bash
python scripts/skin_shader.py -- --blend char_uv.blend --objects GEO-body,GEO-head --tone 0.62,0.38,0.28 --out skin.blend
```
Builds Kenny's chain in his order: base colour × cavity (AO × Pointiness ramp 0.45–0.55, black tinted red so
cavities read fleshy, fac 0.8) → variation 1 (Noise 250 UV / 60 object → crunched ramp → mix with HSV sat up,
value down) → variation 2 (Voronoi Smooth F1 400 / 150 → clipped ramp → same HSV) → **rim LAST** (Layer
Weight Facing → B-Spline ramp → Soft Light 0.5). Roughness from the same noise, lifted 0.35–0.6 (never fully
glossy or matte). Bump 0.2. **SSS Random Walk (Skin), weight 0.5, scale 0.01** for a 1.7 m character.
- Masks, used when present: colour attribute `lip_mask` (glossier lips, no bump) and `color_variation_mask`
  (black = no variation on the lips and mouth bag). Kenny vertex-paints these with Paint Mask + Ctrl X.
- The rim ramp's centre is neutral grey on purpose: a bake has no view direction, and a white centre washed
  the whole baked skin out (found by QA).
- Reds where blood pools (ears, nose, cheeks, knuckles, under the jaw) come from painting: a colour attribute
  or an image at strength about 0.12, blurred (2kI5IgarERc). Ears must render **red, not white**: white ears
  mean the SSS scale is too big.

## 2. Other materials (Kenny's values)
- **Hair**: Curve Info Intercept → ramp → Multiply with the base colour (root dark). Principled Hair BSDF on
  the Cycles output, Principled on the EEVEE output. Cards bake this to the strand atlas (`stylized-base-and-hair`).
- **Eyes**: three materials on the eyeball (pupil, iris, sclera). Iris: Spherical gradient → Ease ramp (dark
  outer ring), Radial gradient + Noise in Soft Light for fibres, Linear gradient Multiply for the top shadow,
  roughness 1, specular 0. **Cornea**: a sphere, roughness 0, transmission 1, shadow OFF. A small emissive
  **highlight mesh** reads better than relying on lights. Games: drop the cornea and paint the highlight in.
- **Teeth**: very low roughness, Coat 1.0, small SSS. **Gums and tongue**: Voronoi bump, SSS 0.5.
- **Cloth**: PBR fabric over the colour (Overlay 0.2–0.3), two normals added then normalized, roughness 0.7+.
  **Velvet**: Sheen. **Leather**: lower roughness, wear on edges via pointiness. **Metal**: Metallic 1, low
  roughness, edge wear from pointiness.
- Naming: materials `<char>-skin`, `-hair`, `-shirt`, `-eye-iris`, and so on. Collections `CH-<char>`.

## 3. Bake to one game texture set (script)
```bash
python scripts/bake_maps.py -- --blend skin.blend --objects GEO-body,GEO-head,GEO-shirt,GEO-pants \
   --size 1024 --out-dir textures --prefix hero --apply --out hero_baked.blend
```
- All objects share the one atlas from `stylized-uv-unwrap`. Bakes colour (DIFFUSE colour pass), roughness,
  tangent normal (OpenGL +Y, which Godot and Roblox both expect, including Bump nodes), AO, and Kenny's
  pointiness cavity (EMIT). Albedo = colour × cavity at 0.3 × AO at 0.5 (Kenny multiplies pointiness at ~0.3).
- The bleed margin defaults to half the UV island gap. A bigger bleed paints one part's colour into its
  neighbour's islands; QA caught blue pants colour on the skin at 8 px.
- `--apply` swaps every object to one material, `MAT-<prefix>-baked` (albedo, roughness, normal), ready for
  `stylized-rig-and-export`.
- Multires folds and sculpt detail: bake a NORMAL with Selected to Active from the high mesh to the low mesh
  (Kenny bakes the Multires: Apply Base first, disable Mirror in render).
- Sizes: **1024 for Roblox** (SurfaceAppearance: ColorMap, NormalMap, RoughnessMap), 2048 for the Godot
  hero (StandardMaterial3D: albedo, normal, roughness, AO in the ORM if you like). Godot SSS: `subsurf_scatter`
  on the skin only. Roblox has no SSS, so the warm cavity and rim tones live in the albedo.

## 4. QA (mandatory)
Render the 4-view on the procedural file AND on the baked file, and compare them side by side: the baked
version must match the procedural one (same tone, no seams, no colour from other parts). Then check:
- [ ] Skin is warm, with no washed-out or grey patches. Ears red with SSS, not white.
- [ ] No texture seams on the front view; cavity darkening in creases only.
- [ ] Hair root darker than the tip. Eyes have a highlight.
- [ ] Maps are 1024 (Roblox) or 2048 (Godot hero); normal and roughness are Non-Color.

Tested on the box-model test character: procedural and baked renders match, with no bleed at a 4 px margin.

## Scripts
- `scripts/skin_shader.py`: Kenny's procedural skin node tree (UV or object coordinates).
- `scripts/bake_maps.py`: colour, roughness, normal, AO and cavity bakes, then the albedo composite and one baked game material.
