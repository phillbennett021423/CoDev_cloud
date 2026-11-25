# Masterclass ch11 — Shading and texturing (14:23:52–17:24:24)
## 3-step texturing workflow
1. **Material blockout:** flat base colour + rough/spec values per part.
2. **Create textures:** hand-painted colour maps (Texture Paint), baked pointiness, baked normals (Multires→low), PBR (Poly Haven), and vertex-colour masks.
3. **Enhance with procedural shading:** noise/Voronoi variation, layer-weight rim, bump, SSS.
"Good materials tell a story" (worn, new, clean, rough). Never leave a flat Principled BSDF with uniform roughness.
Add-ons: **Node Wrangler** (built in, Ctrl Shift click to preview, Ctrl T for mapping), **Poly Haven** add-on (asset browser textures 1K/2K/4K/8K), BlenderKit, Ucupaint (layers, not shown).

## File organisation before shading (Blender Studio convention)
- Save As a backup, then delete the hierarchy of the high-poly collection.
- Collections: `CH-<name>` / `CH-<name>-clothes` / `CH-<name>-hair` (underscores, no spaces).
- Objects: `GEO-<name>-<part>` (Ctrl F2 batch rename: Find/Replace `_`→``, then Set Name Prefix `GEO-jenny-`). Curves: `CUV-<name>-<part>`. GN modifier group name = object name.
- Object DATA name = object name (he uses a small script; it doesn't handle curves, so do those by hand). Delete unused vertex groups (shrinkwrap/shell/rim) but keep and **lock** `pattern`.
- Materials: `<name>-skin`, `<name>-brows-lashes`, `<name>-shirt`, `-skirt`, `-boots`, `-boots-metal`, `-necklace`, `-hair`, `-hairband`, `-gums`, `-teeth`, `-tongue`, `-eye-sclera`, `-eye-iris`, `-eye-pupil`, `-eye-cornea`.
- Turn off the scalp objects' viewport AND render visibility (the hair stays visible).
- **Viewport perf:** expose Interpolate Hair Curves "Viewport Amount" as a group input on every hair GN tree. Copy As New Driver from main_hair, then Paste Driver on the others, so one slider at 0.1 controls them all.

## Blockout values
- Colour-pick from a flat palette image made from the concept.
- Boots metal: Metallic 1, low roughness. Necklace: metallic, low roughness.
- Teeth: very low roughness, **Coat Weight 1.0**, small Subsurface. Gums: low roughness + subsurface. Tongue: **Subsurface 0.5**.
- Eye: 3 materials on the eyeball (pupil faces → loops out to the iris edge → the rest is sclera). Sclera: white, roughness lowered.
- Render in **Cycles GPU**. Look-dev: rendered viewport with scene lights and scene world OFF (built-in HDRI).

## Hair shader
- Root→tip darkening: **Curve Info > Intercept** → ColorRamp → Mix Color (**Multiply**, Fac 1) with an RGB node (base colour) → shader.
- **Principled Hair BSDF** for Cycles, with the colour plugged in. Two Material Outputs: Target **Cycles** = Hair BSDF, Target **EEVEE** = Principled BSDF (Hair BSDF looks bad in EEVEE). Same for the brows and lashes.

## Iris (procedural)
- UV: unwrap the iris faces separately (Minimum Stretch) and centre them. Mapping Location X = Y = **-0.5**. Gradient **Spherical** → ColorRamp (black outer ring stop, iris colour, lighter iris colour; interpolation **Ease**).
- Variation: duplicate it as Gradient **Radial** → Noise (high scale) → Mix Color **Soft Light** over the ring.
- Top shadow: Gradient **Linear** (rotate the iris UVs so the top is dark) → ColorRamp Ease → Mix **Multiply** Fac 1.
- Iris: **Roughness 1, Specular 0**. Pupil: Emission black (or no shader).
- **Cornea:** UV Sphere at the eye centre (cursor to selected), shade smooth, scaled to the eyeball. Eyeball parented to the cornea. Material Roughness **0**, Transmission **1**. Object > Visibility: **Shadow OFF**. EEVEE: Raytracing ON + material "Raytraced Transmission" ON, **Thickness 0**. Name with _L, apply transforms, mirror (cursor at origin, Ctrl M X), Shift N, rename to _R.

## Texture painting
- Image Texture New `<name>-skin-color-map`, **4096²**, filled with the base colour. Save into textures/. Solid viewport Color = Texture.
- Texture Paint mode = Material, pick the image. Paint in the 3D view + clean up in the Image Editor (Paint mode).
- Palettes per material (skin: base, highlight, shadow, cheek red). **Fake User** on.
- Fill tool. **Paint Mask (face selection)** limits painting to faces selected in edit mode.
- Big brushes are slow. Blur: low-strength paint over the edges plus Shift blur.
- Tattoos/decals: a separate image with **alpha 0**, painted, then Mix Color Factor = image Alpha.

## Bakes (Cycles)
- **Pointiness (cavity/curvature):** Geometry > Pointiness → ColorRamp (black ≈ **0.45**, white ≈ **0.5–0.55**) → Material Output. New image **4096², Non-Color**. Bake Type **Emission**, with the object and image node selected. Bake extra objects (straps) into the same image with **Clear Image OFF**. Re-bake if the result is garbage. Use it with Mix **Multiply** about **0.3** on the colour map.
- **Normal from Multires:** disable the Multires in the viewport, **Conform Base** (Shape > Apply Base), and **disable Mirror in the render too**. Bake Type Normal (Multires bake), image Non-Color 4096². Clear Image ON for the final bake. Then Normal Map node (Color → Normal). Delete the Multires and add Subsurf. Join objects with matching modifiers (Ctrl J).
- **PBR mix:** Poly Haven texture (fabric for the shirt/skirt, brown leather for the boots, 2K), tested on a sphere first. Copy and paste the nodes (don't drag onto the mesh). Delete Displacement. Base colour: Mix **Overlay** Fac about **0.2–0.3** over the painted colour + pointiness. Increase the mapping scale. **Two normals:** Vector Math **Add** (normal A + normal B) → Vector Math **Normalize** → Principled Normal.

## Tongue and gums (procedural)
Voronoi (UV, very high scale) → ColorRamp crunched → Bump (invert so the bumps come out) → Normal. Also Mix Factor between colour and HSV-darker colour. Roughness = Voronoi × Noise (detail up, roughness 0.6) **Multiply** → ColorRamp. Copy to the gums with a bigger scale. Teeth stay plain white.

## Skin shader
1. Colour map × pointiness (Multiply, small).
2. **Layer Weight Facing**, Blend lowered → ColorRamp (**B-Spline**, flipped white/black) → Mix **Soft Light** = vibrant rim falloff. Frame as "color map".
3. Colour variation 1: Noise (UV, very high scale) → ColorRamp crunched → Mix Factor, A = colour, B = **Hue/Sat/Val** (sat up, value down).
4. Colour variation 2: **Voronoi** (scale about **190**) → ColorRamp flipped → same Mix with HSV.
5. **Mask** both from the vertex colour attribute `color_variation_mask` (Vertex Paint, Paint Mask, Ctrl X fill, lips and mouth bag black) via a Color Attribute node and Mix nodes. Alt P removes a node from a frame.
6. Roughness: Noise Fac → ColorRamp → roughness. Lips glossier via the same mask.
7. Bump: Ctrl Shift D duplicate keeping links → Bump (low strength) → Normal.
8. SSS: **Random Walk (Skin)**, Weight about **0.5**, **Scale 0.01** (higher = washed-out white), radius default.

## Game-target translation (Godot/Roblox)
Procedural nodes and pointiness must be BAKED to texture: BaseColor (Emission bake of the final colour tree), Roughness, Normal (combined), and AO/cavity multiplied in. Hair BSDF → bake to hair-card albedo/alpha. Cornea → drop it, or use an alpha-blended shell in Godot only. SSS → Godot `subsurf_scatter`, Roblox none (bake a warm rim into the albedo instead).
