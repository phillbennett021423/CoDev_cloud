# 4-view inspection checklist

Go through this after every QA run. Each line comes from what Kenny Praise checks on stream or in coaching,
or from our game rules.

## A. Report (report.md)
- [ ] Every mesh piece is under 20,000 tris (Roblox cap; Godot hero total is 15k–20k).
- [ ] `inverted` = 0 for every piece. Fix with Shift N. Duplicate-and-flip on purpose only for single-sided cloth.
- [ ] `non-manifold` = 0 on anything that will be baked or rigged. Boundary edges are fine on open cloth and scalps.
- [ ] `scale ok` = yes everywhere (Ctrl A). Rotation applied unless the piece is a rigid prop.
- [ ] Feet on Z = 0.
- [ ] Clipping count = 0, or explained (a hand overlapping the wrist before it's joined).
- [ ] Intersections only where pieces are meant to touch: eyes inside the sockets, scalp on the head,
      teeth in the mouth.
- [ ] Drift lines appear only for changes you meant to make.

## B. Diagnostic sheet (diag_sheet.png)
- [ ] No RED. Red = you are looking at a back face: flipped normals, a hole, or single-sided cloth seen from
      inside. Single-sided cloth needs Solidify or duplicate+flip if it can be seen from inside.
- [ ] No MAGENTA. Magenta = body vertices outside the cloth/gear surface. Fixes, in order: raise the
      Shrinkwrap offset, Smooth Corrective, thicker Solidify, or delete or mask the hidden body faces (Kenny
      masks the body under clothes; for games, DELETE them).
- [ ] Clay shading is smooth: no stripes (bad triangulation or ngons on curved areas), no pinches at poles.

## C. Silhouette and pose (sheet.png, front + side)
- [ ] It reads in pure black (Kenny: MatCap, viewport colour Custom black). The arms don't merge with the torso.
- [ ] A-pose about 45 degrees, elbows slightly bent, fingers relaxed (better deformation than a T-pose).
- [ ] The forearm is turned slightly forward from the top view, so twist bones deform cleanly.
- [ ] The neck leans forward, never vertical. The back of the skull slants into the neck (no bulge).
- [ ] Side view: the back has an S curve, the seat goes back, the chest goes forward. The heel is wider than
      the ankle; the inside ankle bone is higher than the outside.
- [ ] The character faces -Y (the front view shows the face).

## D. Head and face (front + side; see stylized-face-proportions)
- [ ] Eye line about halfway from the crown to the chin. Eyes sit INSIDE sockets, with lids wrapping the eyeball.
- [ ] The ear sits between the brow line and the nose bottom, behind the head's mid line in profile.
- [ ] Profile: the nose projects the most. The nose-tip-to-jaw line slants. The lower lip sits behind the
      upper lip. The mouth wraps around the teeth.
- [ ] Mouth corners no wider than the iris centres. Eye spacing about one eye width.
- [ ] Stylization is consistent: the features you chose to exaggerate are exaggerated the same way on both sides.

## E. Materials (beauty sheet)
- [ ] Skin reads warm, with reds at the ears, nose, cheeks and knuckles. The ears are red, not WHITE: white
      ears mean the SSS scale is too large.
- [ ] Eyes have a highlight. The cornea doesn't cast a shadow.
- [ ] Hair: the root is darker than the tip, there are no bald scalp patches from the front or back, and
      the strands don't look like spaghetti from the side.
- [ ] No texture seams on the front view. The checker texel density is even (UV stage).

## F. Hair and cloth extras
- [ ] Hair cards: alpha edges hide card ends; no visible card plane from the side.
- [ ] Cloth: folds asymmetric (symmetry off for folds); seams/hems have thickness (Solidify rim smoothed).

If anything fails, fix it, run QA again with `--baseline <last good metrics.json>`, and repeat.

Note: alpha hair/brow/lash CARDS are single-sided on purpose (the material is two-sided), so they show red in
diag_sheet. Judge cards on sheet.png instead: no flat card edges from the side, and no bald scalp between them.
