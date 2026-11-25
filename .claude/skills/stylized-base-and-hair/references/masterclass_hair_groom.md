# Masterclass ch10 — Hair grooming (12:04:57–14:23:52)
These are Blender Hair Curves plus the Essentials hair node-group assets. This is for RENDER. For game targets the curves must be converted to cards or a mesh (see the hair-course notes and the game-export skill).

## Analysis before grooming (2 questions)
1. Can the hairstyle be split into **parts/volumes**? (Ponytail woman: left front, right front, back mass, ponytail. Bun: base plus bun. Curly: one volume.) Get references from all angles.
2. What is the **flow and direction** in each part? (Straight then twist, everything packed to the band, shorter underlayer with a different direction.)

## Concept
About 100k strands on a real head, so a few **guide (parent) curves** drive many **children** (same idea as Subsurf cage). Not too many guides (can't comb) and not too few (no control).

## 4-step groom workflow (every hairstyle)
1. Create guide hair
2. Interpolate the guides (children)
3. Clump (primary + secondary)
4. Noise / Frizz to break the perfection

## Scalp objects (required)
- Duplicate the face region from the body (select faces, Shift D, P separate). Remove Subsurf. Add Shrinkwrap (target body) and Mirror. Ctrl A > **Visual Geometry to Mesh**. Collection `hair_scalp` inside low_poly.
- **Scalp MUST have UVs.** Alt P to clear inherited pins, Ctrl E > Clear Seams, U > Angle Based (any method is fine, orientation doesn't matter).
- Hair scalp: draw the hairline with annotation (Surface), select the body faces inside it, dup/separate, then Grab and Relax brushes to the line. Extrude and fill, and Alt W > "Deselect faces from visible" style cleanup.
- **Parting:** rip the scalp into separate **mesh islands** along the parting with V. Interpolate Hair Curves has **"Part by Mesh Islands"**.
- Ponytail scalp: Plane, rotate and scale, Subdivide ×2, LoopTools Circle, placed at the hair band.
- Error "curves not attached": select the curve, then the scalp, Ctrl P > **Object (Attach Curves to Surface)**.

## Viewport setup
Layout workspace, 150 mm lens, **MatCap** lighting, outline off. Disable the high-poly collection in the viewport (restriction toggle "Disable in Viewports", not just hide). Curve viewport display colour **black**, shading colour = Object.

## Curves sculpt brushes (Shift A > Curve > Empty Hair, parented to the scalp)
- Add: Length (brows **0.007** after trying 0.01, lashes 0.01, short hair **0.04**), **Points 20–30** (more points = more control), Count 1. Turn on **Interpolate Length + Interpolate Shape + Interpolate Point Count** once some guides exist.
- Density brush: **Distance Min 0.013** for short hair guides (0.02 was too sparse in the other direction).
- Selection brush with a custom shortcut **W**, Curve mode (whole curve). Comb (Shift = smooth), Grow/Shrink (Ctrl = shrink; set **Scaling > Minimum Length = 0** to allow shrinking), Pinch, Puff, Snake Hook, Slide, Smooth, Delete. Alt A deselect, A select.
- Comb falloff: **Projected** for blocking the overall shape, **Sphere** for refining (only the front strands). Turn pressure off. X symmetry on. Keep space between strands and the head for volume. Add brushes to Quick Favorites (Q).
- Mirror guides: Edit mode, Shift D, cursor to world origin, pivot = 3D cursor, Ctrl M X.

## Density masks
Interpolate Hair Curves **Density Mask Texture**: paint a **2048²** black image (Texture Paint, Single Image mode) white where hair should grow, using the "Paint Soft" brush. Save it into `textures/` (**Alt S often**, because Blender doesn't autosave images). One mask per part: brow_density, main_hair_density (2048×1024), left_side_hair.

## Render properties
Curves **Shape = Strip** (lets you control thickness; Strand = constant width, used while grooming). **Set Hair Curves Profile**: radius **0.1 mm** (real hair), lashes **0.2 mm**, shape about 6 → 3 for brows.

## Node-group settings used (Essentials > Hair assets)
- **Interpolate Hair Curves:** Surface = scalp. Surface UV Map = **Named Attribute "UVMap"** (copy the name from Data props). Density **50,000 → 800,000** for brows (very high), lower lashes about 25. Viewport Amount **0.5** while combing.
- **Clump Hair Curves:** untick **Use Existing Guide Map** (otherwise the guides are the clump centres). Guide Distance: brows primary **0.04**, secondary **0.02**. Short hair primary **0.01→0.015**. Main hair Shape about **0.8**. Lashes: low distance + low **Tip Spread**. Lower lashes: use the existing guides as clumps (Use Existing Guide Map ON).
- **Secondary clumps in GN:** Delete Geometry (Domain **Spline**, Selection = Random Value probability **0.95**) → **Create Guide Index Map** (Curves = clumped hair, Guides = surviving 5%) → 2nd Clump Hair Curves with Guide Index plugged in (Use Existing Guide Map off).
- **Blend Hair Curves:** radius **0.01** to fill gaps. Factor = Named Attribute `pattern` (a vertex group on the scalp, inverted so the parting is excluded).
- **Frizz Hair Curves** (brows): untick Cumulative Offset, reduce Distance and Factor.
- **Hair Curves Noise:** untick Cumulative Offset (or leave it on, test both). Scale about **10–15**, Scale Along Curve up, Distance **0.02**, Shape **0.02–0.1**, Factor low.
- **Noise on a subset only:** Separate Geometry (Domain **Spline**, Selection Random Value p≈**0.1–0.25**) → Noise on Selection → **Join Geometry** with Inverted.
- **Flyaways:** a 2nd Separate Geometry (different seed, p≈0.01–0.05) → **Trim Hair Curves** (untick Replace Length; Length Factor = Random Value 0..**0.2** per Curve Info ID, or about 0.1–0.3) → heavy Noise (Distance 0.02, Shape 0) → Join.
- Set Hair Curves Profile goes above the Interpolate node (order doesn't matter).
- Lower lashes: separate them to their own curve object (P) and rip the scalp so top and bottom are separate islands.
