# Masterclass ch5: Clothes, accessories, placeholder hair  [04:15:04-06:02:34]
## Theory
- Cloth behaves like water: takes the shape of the body under it. Every fold = tension (pulled from 1+ points -> straight/radiating folds) and/or compression (pushed into itself/body -> zigzag, spiral bunching). 7 fold types (zigzag, spiral, pipe, diaper/drape, half-lock, drop, inert) - don't memorize, locate tension & compression.
- ANIMATION CHARACTERS: minimal, subtle folds only at tension/compression points (Blender Studio rigs as example) so they still look right when deformed. Never parallel/identical folds: use curves and diagonals. Stylized = SHARP folds (Crease Polish with Ctrl, Pinch).
## Shirt (box-model -> sculpt), scriptable
1. Cube in edit mode around torso; extrude to hem; loop cuts; AUTO MIRROR add-on (adds Mirror, deletes half).
2. Inset top faces (I, B = boundary) and delete = neck hole; delete bottom faces = hem opening; extrude side faces for short slanted sleeves; G slide loops to hug arm; Alt S to push off body (no intersection).
3. Sculpt: Grab + Smooth + Inflate where it intersects + Relax Slide (Shift) to even topology. Viewport colour per object (Object colour mode) to see cloth vs body.
4. Subdivide once (smoothness 1) for more geometry -> refine. Apply Mirror, Symmetrize, merge stray centre verts (M at center).
5. MULTIRES subdivide x2-3 for folds (multires sculpts new verts, subsurf can't). Draw brush folds (symmetry OFF), smooth lightly, Crease Polish Ctrl to sharpen. Armpit compression folds. Shade smooth; subdivide multires again to refine.
6. SOLIDIFY modifier for thickness (hidden in sculpt mode while multires active - normal).
- Shirt tucked into trousers (trousers overlap top of shirt).
## Trousers
- Cube, auto mirror, extrude legs; LoopTools Circle on leg openings; extrude to knee then to ankle; 8 loop cuts; turn mirror clipping off briefly to fix verts stuck at centre; keep centre verts at X=0 (G X).
- Multires x2-3; tension folds at crotch (Draw), sharpen; SEAMS = Draw Sharp brush line then Pinch; front placket via Clay then Scrape flat + Crease edges; straight drop folds down shin; Z-shaped compression folds behind the knee; belt line Draw Sharp + Pinch.
## Pleated skirt (fully procedural - scriptable)
- Circle 33 verts; Select > Checker Deselect (selected 2) -> invert; scale in + rotate = zigzag star; subdivide long edges, scale new verts out; extrude Z up and scale = pleats; extrude top edge up, LoopTools Relax, extrude again + LoopTools Circle = waistband; Shift N normals; Subsurf L2; one support loop near hem to fix shading; scale to hips (S Y squash front-back); Solidify; lower back hem slightly; overlap shirt.
## Boots / shoes (high heel)
- First re-pose foot for heel: x-ray select forefoot verts and rotate, re-sculpt, remesh 0.0073; deflate (Ctrl Inflate) between toes before remesh so they don't fuse.
- Shoe = cube following leg, extrude down to foot, extrude forward along foot; S Z 0 to flatten sole; loop cuts, auto mirror, delete top faces, LoopTools Relax opening. Apply mirror, re-add Mirror with mirror object = head (world centre) so shoe sits on side; sole flat S Z 0; extrude heel down and scale.
- Multires; Draw Sharp line + Pinch for sole separation; Line Project slice sole flat; folds/diamonds at ankle; Stroke > Stabilize Stroke for clean lines.
## Placeholder sculpted hair (replaced later by groom)
- Lasso mask on scalp area -> Mask > Mask Extract (offset 0, thickness up); smooth edges; apply solidify; remesh 0.015; Scrape the sides; Clay Strips strokes for flow direction toward the gathering point.
- Break hair into simple masses (top volume, side locks, back mass). Hanging locks: single vertex -> extrude -> Skin + Subsurf L2 (Ctrl A radius; mark root if skin fails), Smooth Vertices, Mirror; back mass similar then Visual Geometry to Mesh, remesh, Clay Strips flow.
## End of sculpt
- Recheck proportions vs concept (thicker thighs, larger head).
