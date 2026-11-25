# Box-model body without sculpting (Hdkm7UZ6Oqs) + 50 tricks (dxMDJsFJEec)

## Box-model body recipe (bpy-translatable)
- Refs: drag front image, Alt R/G/S, rotate X 90, opacity on, feet above grid, push back on Y. Shift D for side ref, R Z 90, offset on Y/X. Uncheck "Perspective" on both refs so they only show in ortho front/side (numpad 1/3).
- Start: cube, scale down, X-ray (Alt Z). Chest first: rotate/shape from side to follow ref; loop cut mid + scale up; middle loop; S X to narrow front/back edges; loop + S X to widen.
- Top edges G Z up = neck/shoulder meet; move out for shoulders.
- Auto Mirror add-on (N panel > Edit): deletes half, adds Mirror with right settings (clipping on). Toggle clipping OFF while scaling loops that clip at centre, then back ON.
- Torso: extrude bottom faces down (side view), loop cut, pull in. Extrude back faces for butt/back; round with vertex moves (GG slide).
- Legs: loop cut, select 4 bottom faces, E extrude from side view, rotate/scale to knee. LoopTools > Circle on every limb ring (Shift R repeats). Spread legs a little wider than ref (A-pose friendly).
- Continue down to ankle; add 4 loops (Ctrl R + wheel). Foot: extrude bottom faces down to shoe, loop mid, extrude forward faces for foot; bottom view (Ctrl numpad 7) grab-brush toe shape (big toe/pinky).
- Shape passes: Sculpt Grab brush large radius + Shift smooth, MatCap lighting to spot dents.
- Arms: move shoulder edges back/forward, extrude 4 side faces = shoulder, S Y, extra loop; extrude again = arm, A-pose (not T), LoopTools circle, extrude to wrist, loops for upper-arm mass. Rotate forearm from top view, pull forward on Y (deformation-ready rotation). Shorten forearm if long.
- Neck: select 4 top faces, I inset (B = boundary so mirror unaffected), extrude up, S Z 0 flatten, delete top cap, extrude ring.
- Subsurf Ctrl 1; delete cap faces; Inflate brush (Ctrl deflate) on legs/arms/neck. If centre verts separate: select, G X 0 back.
- Back crease: loop cut, push back edges in.
- Joint patches: select 4 faces at knee / elbow, I inset, slide edges -> proper knee/elbow loops for deformation.
- Hands: separate video (5RFhA0PG0XE).
=> bpy: build from cube via bmesh extrudes on a ref-driven profile table (ring centres + radii per landmark), circularize rings, mirror, subsurf 1-2, inset joint patches.

## 50 tricks (relevant)
- Silhouette check: MatCap, viewport colour Custom black.
- GP lines on sculpt: stroke placement Surface.
- Paint mask from edit-mode selection (texture/vertex paint).
- Remesh: R shows grid, Ctrl R remesh. Paint brush in sculpt mode (colour attribute).
- Undo steps >= 100. Bone snapping when placing bones.
- Texture brush: stroke spacing+jitter high. Alt S to view texture while painting.
- Second viewport for overall progress. Block out with simple shapes first.
- Transform pivot Individual Origins to rotate many objects.
- Lasso mask + Extract for head/cloth bases. Numpad . / Alt MMB to orbit around sculpt.
- Ctrl J join -> random face sets: Face Sets > From Visible to clear.
- Slide Relax brush for topology; Stabilize Stroke.
- Weird shading/scaling => Ctrl A apply all transforms.
- Brows: face snapping. Forgot symmetry: Symmetrize.
- Always eye highlights; rim light separates from background; Ctrl T aims light at cursor.
- Retopology overlay option; F2 add-on; LoopTools Relax/Circle/Space; Node Wrangler Ctrl Shift T for PBR, Ctrl T mapping.
- Mix two materials via Mix Shader with B/W texture factor. Clay brush to smooth transitions. Trackball orbit. Alt Q switch sculpt objects.
