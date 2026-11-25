## Procedural curly hair (no grooming), all in GN
- Scalp: draw the hairline with an annotation; Plane + Mirror (clipping), snapping Face Project, In Front. Extrude verts along the hairline to the back, fill with F/F2, even loop counts, Shift N normals. Smooth topology in sculpt (Shift). Shrinkwrap to the head, smooth, apply Shrinkwrap + Mirror. Name it "scalp". **UV is mandatory**: U > Unwrap, scale down, P pin.
- Add > Curve > Empty Hair (parented to the scalp, keeps the auto Surface Deform). New GN modifier "hair". Steps: guides, then interpolate, then clump, then noise.
- Guides: Generate Hair Curves (surface = scalp, Surface UV = Named Attribute "UVMap"), density 500 to 800, length 0.05 to 0.06. Render > Curves: Strip (not Strand) so Set Hair Curves Profile radius works, radius 0.001 (0.03 to 0.05 only for visibility). Roll Hair Curves at default. Change the seed for different placement. Curl Hair Curves: guide distance 0 (each curls alone), radius 0.01, raise frequency, factor start/end. Ctrl G group "hair guides".
- Interpolate Hair Curves (surface + UV) density 10k, then 50k, finally 100k. Second Curl: radius 0.01, guide distance 0.015 (0.03 too much), existing guide map OFF. Profile 0.02.
- Clump: primary with guide distance 0.015, existing guide map off, factor 0.7. Secondary: guide distance 0.05 placed before it, factor 1.
- Noise: Cumulative Offset OFF, scale along curve 20, overall scale 5, offset per curve 0.2. Factor = Curve Info (hair) Random to ColorRamp black 0.4, so only some curves get noise.
- Fill sparse scalp: duplicate Generate+Profile+Roll (Alt P ungroup), density 5000, length 0.02 to 0.03, interpolate, noise with cumulative off, scale along curve 50 then 30, offset 2, distance 0.03. Join Geometry with the main hair.
- Interpolate viewport amount 0.1 when heavy. Set Material node after the generate/join.
Game: this becomes the high-poly source for hair-card bakes, or (Godot) Curve-to-Mesh strips at low density. Never ship 100k curves.

## Brows and lashes (GN hair)
- Brow scalp: select the brow-area faces on the head, Shift D, P separate, rename "brow scalp", clear modifiers/shape keys/vertex groups/materials, Mirror (Ctrl A apply transforms if mirror fails), apply, U > Angle Based unwrap. Empty Hair on it.
- Annotation (placement Surface) marks the brow. Add brush, curve length 0.01. Comb (Projected). Add brush > Interpolate Length + Shape ON so new guides follow combed ones. Taper the tail hairs together. Grow/Shrink with Ctrl to shorten (set the scaling minimum length to 0). Mirror guides: Shift D, cursor at world origin, pivot 3D cursor, Ctrl M X. Then X symmetry.
- Asset browser > Hair. Curves render Strip. Set Hair Curves Profile radius 0.01 (scene-scale). Interpolate Hair Curves surface = brow scalp, density 100k up to 1M, **Density Mask texture**: Texture Paint > Texture Slots mode Single Image, new "hair mask" 2K black, paint white where the brows grow, blur the edges. Clump: existing guide map OFF, small guide distance (Shift-drag), shape tweak.
- Lashes: select the eyelid loop, Shift D, P, clean as above. Split the upper and lower lid at the corners with V rip and P separate. Mirror, apply, unwrap. Guides combed from the side and front, shortened. Profile radius copied (0.03 visible), Interpolate density ~7k (scene-scale), Clump with a tiny guide distance + Tip Spread. Lower lashes: fewer, radius 0.00001 (tiny), and some guides paired for visual interest. Copy modifiers with Copy to Selected and swap the surface.
Game: Godot/Roblox get brow and lash alpha cards baked from this GN result (see the masterclass hair notes).


## Hair sculpt brushes (GN hair curves)
- Add (Interpolate: Length, Shape, Point Count; 30 points per guide for easy combing), Comb (Projected), Density (min distance 0.02), Grow/Shrink (Ctrl shrinks), Smooth, Delete, Pinch (clumps), Puff (straightens up), Pull Tips, Slide, Select (shortcut W; curve mode; Shift grows the selection). A selects all, Alt A deselects.
- Guides: annotate the parting, start at the parting, then go around the hairline perimeter, then fill the middle/back along annotated lines (~50 min of guides for a full style). Ponytail: separate filled Circle scalp at the tie with UVs, Ctrl A apply transforms if the length is wrong.
- Modifier order example: Curl (radius 0.01, guide distance 0 with existing map OFF) -> Set Profile 0.001 (strip) -> Interpolate (density 100k+) -> Curl #2 (guide distance 0.0015, freq 3, radius 0.01).
