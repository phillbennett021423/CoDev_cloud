# Masterclass ch7: Body / hands / feet retopo, cavities, eyes/teeth assets, detail reprojection  [07:21:25-09:21:51]
## Required body loops (deformation)
- Shoulder loops around the deltoid going over to the back + loops around the armpit.
- Elbow: a small patch on the back of the elbow (bevel-in loop) keeps elbow shape when bent.
- Wrist: several close loops around the wrist.
- Knee: patch/extra loops like elbow (front of knee).
- Hips: loops around the hip/glute (butt) region preserving volume when leg lifts.
## Body construction (all edge-count driven -> scriptable)
- Start: Circle 10 verts under armpit (scaled Y), duplicate for arm ring; extrude torso down, side, back; Shrinkwrap target = body sculpt (apply via duplicate), Mirror (clip, on cage) ABOVE shrinkwrap.
- Bridge Edge Loops (Ctrl E) between equal-count loops; subdivide so armhole ring = 20 verts.
- Neck ring of body must match head's neck ring count (head had 14 verts) -> add/remove loops so counts match, then join head+body and bridge.
- Chest: extrude centre line, loop following breast/pec, female = E S rings inward x N then Grid Fill (add loops to make even); male = grid fill directly.
- Extra detail without extra loops: select edge run, Ctrl B bevel 2 segments, Auto Merge + GG slide to kill n-gons, Ctrl X dissolve triangles (used for ribcage, elbow patch, knee patch).
- Hip: extrude loops around buttock and crotch; leg opening = flat ring (S Z 0) -> legs are tubes: extrude to knee/ankle, loop at knee rotated to knee curve, 4/4/4/7 loop cuts, EVEN count down the leg. Arms: same, 9 + 8 loops, elbow loop.
## Hands (count matching)
- Each finger = cube (end face deleted) rotated along finger, loops at each joint; 2 faces across the top, 3 faces down each side; thumb has 2 joints. Shrinkwrap.
- Bridge sides of neighbouring fingers with F; extrude the whole ring back over the palm, LoopTools Relax, extra loops on knuckles.
- Reduce counts to match the 20-vert wrist: collapse pairs (auto-merge GG slide) + dissolve tris, route side loops back on themselves (34 -> 22 -> 20 verts).
- Finger joint topology: bevel the 2 top faces at the joint, slide to merge, dissolve tris = deformation diamond. Nail loop scaled up at nail. Tip: grid fill / inset. Join hand to arm and bridge; add 3 loops at wrist.
## Feet: same as hands (toes like fingers, 3 faces per side), sole filled by extruding loops back to the heel and E S inward + fill; reduce 26 -> 24 by extruding a strip up; ankle patch via bevel trick.
## Cavities
- Eye cavity: inner eyelid ring E S in to give lid thickness, then extrude back into the skull (pocket around eyeball). Eyeball must rotate without clipping through it.
- Mouth cavity: extrude lip inner ring back, shape a sack (sculpt grab, smooth vertices, inflate) big enough for teeth/tongue; never visible from front.
## Assets
- Blender Studio "Human Base Meshes" bundle (free, commercial OK): Preferences > File Paths > Asset Library (import = Append). Stylized category: JAW (teeth+gums+tongue) and EYES. Scale into place using the sculpt eyeball as reference; delete unused faces of the asset.
## Reproject sculpt details (NOT baking)
1. Apply Mirror. Vertex group "no_shrinkwrap" = eye + mouth cavities; Shrinkwrap (target body sculpt) with that group INVERTED.
2. Multires ABOVE the Shrinkwrap, Subdivide x2 -> details return. Apply Shrinkwrap.
3. Clean/sharpen details at multires level (Crease Polish, relax).
4. Multires > Apply Base (pushes detail into base cage) instead of applying multires; then remove Multires (or keep Subsurf) -> clean low mesh that keeps shape.
- Wireframe toggle shortcut: right-click overlay > assign Shift Q.
