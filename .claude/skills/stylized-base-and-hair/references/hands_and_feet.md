# Hands (5RFhA0PG0XE) and Feet (Z1kABJANH2o)

## Hands
Forms: palm = rectangle, wrist = rectangle, thumb pad = rectangle, fingers = cubes/cylinders.
- Knuckle line is an arc across the palm, steeper toward the fingertips.
- Finger bend: NOT parallel creases. The knuckle segment goes straight up, the middle goes outward and the tip goes inward. The top knuckle sits farther back than the palm-side crease.
- The palm has curvature from the top view.
Steps:
1. Palm block: cube scaled flat. Loop cuts raised to arc the palm. Side view: the finger end is narrower (S Z on the front faces). A loop with Alt S along normals for padding. Thumb pad: loop, extrude the bottom faces down, scale in, extrude out. Subsurf Ctrl 1, grab-brush shaping, narrow S X. Wrist: extrude, LoopTools Circle, rotate on Y, add a support loop.
2. Fingers: plane at origin, M merge at centre to 1 vertex, extrude along Y. Add a Skin modifier + Subsurf (viewport 2). Ctrl A (skin resize) for thickness. Move ONLY in object mode so the origin stays at the finger base. Alt D linked duplicates x3 (edit one = edit all). Place them along the palm arc and spread with rotation. Lengths: middle longest, pinky shortest; S Y Y = local-axis scale. Add 2 loops; slide one close (G G) to sharpen the knuckle; drop the loops for a relaxed curl. Thumb = Shift D (unlinked), thicker (Ctrl A), on the pad. Rotate the knuckle segment back from the side view.
3. Sculpt: apply palm subsurf. Grab/Inflate the thumb pad; sharp edge at the thumb. Fingers: Ctrl A > Visual Geometry to Mesh (works on linked data; sculpting still propagates to all linked copies). X symmetry. Narrow the tips (female hand). Crease Polish for the creases; Scrape to flatten the nail beds; no bulge at the nail tip.
4. Detail: remesh 0.02 (thumb 0.02–0.01), Mesh Filter Smooth (carefully), then Crease Polish for the bends, nails and tip creases; Ctrl inverts. MatCap + outline.
5. Merge: Ctrl J fingers+thumb+palm, remesh 0.01, Clay brush volume to blend the joins, smooth, re-crease the knuckles, lasso mask + grab per finger, Alt M clears the mask.
Game/bpy: skin-modifier finger chains are scriptable (vertex chain + skin radii + subsurf). Fingers along the palm arc with relaxed curl; 3 segments per finger match the Rigify finger bones.

## Feet
Forms: lower leg = cylinder, foot = triangle/wedge, toes = cube.
1. Round Cube (Extra Objects add-on). Scale on Z and X into a wedge. Grab from the top view with X symmetry, then turn symmetry OFF (the foot is asymmetric). Big toe side forward; inner arch pulled in. Line Project brush (F flips) flattens the sole and slices the top. Lasso-mask the sole, then grab up into the leg.
2. Crease Polish marks the toe line; the back of the toe area is curved; Relax Slide brush.
3. Toes: cube merged to 1 vertex, extrude Y, Skin + Subsurf 2; loop cuts give the stepped profile (raise mid, drop the front). Ctrl A scales skin vertices. Object-mode moves only (origin at the base). Alt D for 4 linked copies. S Shift Y scales all axes except Y. Knuckles follow an arc (draw an annotation curve). Big toe biggest; smaller toes rotated/scaled.
4. Backup: duplicate to a disabled "blockout" collection.
5. Foot: remesh 0.02, smooth. Mask + Ctrl I invert + grab = lower leg (flares outward). Clay Strips for ankle mass; Ctrl removes. Ankle bones: the INSIDE malleolus sits HIGHER than the outside. Crease Polish defines them.
6. Toes: crease the knuckles and nails; keep the stepped side profile.
7. Merge: Ctrl J, Face Sets from Visible. Remesh 0.008 fused the toes, so use 0.004 (spoken "0.04"; finer than 0.008 is the logical reading). Clay toward the top of the foot from each toe, Crease Polish between toes, smooth, grab-blend into the top.
Games: for shoe-wearing characters, skip toes (mask/delete hidden faces). Bare feet: keep a toe count low enough for the 20k budget (joined toes or 2-loop toes).
