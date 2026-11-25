# Batch 4: 50 tips, beginner heads, workflow overviews (12 videos; 6 are music-only timelapses)
(-iy9YzAkEs4 50 tips, 43Rt7bRPi3w heads beginner guide, Fd8YxX9OeVc sculpt workflow, _U8w0PxUeS4 characters + environments,
 iFxZ9U3fEwg sculpt/groom/cloth-sim process. Music/no speech, nothing to extract: AOhZ2rMWvUU, KJON23u433k, TEK_P-owQac,
 a5vODbsMhKQ (intro line only), dHjcq5LegZo, fUR4XBwYlJ8, qEj4KQ2sRnY.)

## 50 tips (-iy9YzAkEs4) — the ones not already in the masterclass notes
- Mood board BEFORE design. Blockout = the sketch: a bad blockout means a bad final. Practise proportion WITHOUT a background image.
- Zoom out often / split the viewport to judge all angles together. Ctrl A apply scale whenever a scale warning appears.
- Stabilize Stroke for clean shapes; Slide Relax brush evens topology. File > Clean Up > Recursive Unused Data-Blocks.
- Face Sets on retopo parts; Face snapping for anything placed on the body; Symmetrize if you forgot symmetry.
- **Always add eye highlights** (post or in Blender). **Avoid oversaturated colours.** Tri-lighting add-on as a starting rig. Turn OFF caustics when no glass. **Rim light separates character from background.**
- Silhouette check: MatCap, colour Single, value 0 (black).
- Rigging: volume snapping to place bones; align finger bones along the fingers and **pre-curve them in the bend direction**; vertex-group select to fix weights. Break the rig to extremes for appeal, fix with shape keys.
- Skin: **Voronoi at very high scale** for pores. Ctrl Shift T (Node Wrangler) loads texture sets. Alpha brushes + jitter brush (spacing and jitter maxed) for imperfections. Blend modes while painting.
- **Subtle yellow / red / blue tint zones across the face** (forehead yellow, cheeks-nose-ears red, jaw/beard blue-ish).
- AO node gives free cavity shading. Volumetrics in the background if empty. **Always composite** the final render.

## Stylized heads, beginner 3-step (43Rt7bRPi3w) — confirms the head method
- Setup: Extra Objects add-on, Extra Shading Pie (Z toggles X-ray/overlays), Round Cube in Quick Favourites (Quad sphere preset, few divisions), lens 150, viewport split in 3 (clean view, reference, working view), X symmetry.
- 1 Blockout: pull the jaw down (front, then side), Line Project the sides flat, Clay Strips/crease the cranium-jaw split, Scrape the back of the head, chin forward, flat under the jaw. Neck = round cube rotated BACK at the bottom (top forward), front pulled forward, back wider than the front, throat indicated. Ear = round cube scaled thin in Y, rotated, symmetrized. 2 Planes: remesh 0.04–0.05, crease a line from the ear to the face front (brow line), grab the eye line back to leave room for the nose. 3 Details (as masterclass ch3).
## Workflow overviews (Fd8YxX9OeVc, _U8w0PxUeS4, iFxZ9U3fEwg)
- Order: blockout (Grab + Line Project) -> face planes (Scrape for angular planes) -> nose as a separate mesh -> crease mouth/lids -> brows/lashes placeholders -> retopo (projection) -> UV -> Rigify -> texture -> hair -> pose -> clothes (Marvelous) -> render.
- **Symmetric UV trick**: lay out one half, in UV sculpt use the "relax/collapse" so both halves overlap, then select the other half, 2D cursor at the centre, scale X by -1 (mirrors the islands exactly).
- Skin node: painted base colour mixed with a less saturated HSV copy using **AO as the factor**; painted roughness through a ColorRamp; **Voronoi drives skin bump, a stretched Noise drives lip bump, mixed by a painted mask**.
- Blockout rule **STRAIGHTS vs CURVES** alternating along every limb; fewest parts that give the silhouette; parts flow into each other.
- Detail back after retopo: subdivide 1–2x + Shrinkwrap to the sculpt, or Multires + Shrinkwrap.
- Not-animated heads can skip retopo and be **parented straight to the head bone** (stills only; games always retopo).
- Hair: base layer covering the whole scalp (no gaps) + a second system for the big strands + a duplicate for hanging parts. Placeholder hair: Lasso mask extract + skin-modifier strands + Displace for randomness.
- Cloth sim that keeps the designed shape: model the exact garment, **pin edges/faces**, then simulate per pose and apply.
- Colour (environment piece): background elements share ONE hue family, the focal subject gets the warm/contrasting tone; use desaturated colours near white. Gobo light with light linking on the backdrop only. Grass cards need Light Paths > Transparent bounces 32+.
