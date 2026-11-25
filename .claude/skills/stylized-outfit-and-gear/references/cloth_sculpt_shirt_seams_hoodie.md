# Cloth sculpt (v_WMJLudpvg) and fully procedural hair (zV4tnpVhadM)

## Cloth: 3 steps
1. Block out: cube at the groin, S X / S Y, extrude legs, delete half + Mirror (clipping). Add loops, delete caps. Shrinkwrap to the body with a small offset, Subsurf, APPLY both. Fix the centre: select centre verts, S X 0, move back so they don't intersect; edge rings S Z 0 to flatten. Grab-brush to the reference. Object colour in Viewport Display + shading Object colour = Attribute.
   Shirt: cube, extrude sleeves, delete faces, collar: I inset with B (boundary), delete. Shrinkwrap with offset; move verts that snapped to the wrong body part. Subsurf, apply, centre fix, extra loops.
2. Sculpt folds: apply all, including Mirror. Multires subdivide x2. Draw brush folds, X symmetry OFF (folds are asymmetric).
3. Detail: Multires to ~5. Crease Polish with Stabilize Stroke and Falloff Sharp for seams; Pinch to refine; pockets the same way. Keep the Multires Viewport level = Sculpt level.
4. Thickness: Solidify plus Shell/Rim vertex groups (Solidify > Output Vertex Groups). Smooth modifier on "rim" with repeat 3 and a second Smooth on "shell" with repeat 4, then Shade Smooth. Spoken thickness 0.5 is scene-scale; the masterclass value is 0.007 m.
Game: bake Multires folds to a normal map on the retopo cloth; Solidify becomes real geometry only where seen (cuffs/hems), otherwise single-sided + backface.


## Easy shirt with fake seams
- Cube, edit mode, scale to the torso. Loops, X-ray, bevel the neck vertex (Ctrl B, V) to round the neckline, delete the face, knife K to kill ngons. Auto Mirror. Loop with S Z 0. Delete the faces where the sleeves go; LoopTools Circle the openings; extrude the sleeve and rotate; extrude the hem down, S Y / G to fit.
- Topology fix: loop near the side, merge pairs (M at centre) front and back so a loop runs all the way round; dissolve with Ctrl X; Smooth Vertices.
- Apply mirror, sculpt Grab with X mirror. Subsurf (Ctrl 1) + Solidify ~0.05 (scene-scale) ABOVE the subsurf. Support loops at the hems.
- **Seams**: add loops, Mark Sharp, Edge Split modifier (edge angle OFF) above Solidify and Subsurf; Solidify > Crease Inner 1, Rim 1; optional Subsurf above the Edge Split for softer seams. Check for intersections.


- Hoodie: mirror + I inset with B for the opening, rotate the sleeve ring, delete the bottom faces, grab/inflate to stop intersection, a separate hood merged, Lasso Mask + Snake Hook (K), Solidify + shade smooth, apply Mirror, Multires + Crease Polish seams.
