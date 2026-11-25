# Masterclass ch9 — UV unwrapping (10:43:51–12:04:57)
## Checklist (3 steps): 1 Cut seams → 2 Fix stretching → 3 Arrange UVs
Before you start: name every object. Use the UV Editing workspace and set the viewport focal length to 150 mm.

## Settings
- Turn on **Live Unwrap** in BOTH places: the 3D viewport (UV menu) and the UV editor (UVs > Live Unwrap). Turn on **UV Sync Selection**. Mark seams with Ctrl E > Mark Seam. Mirror the selection with **Ctrl Shift M** and tick **Extend**. If the mirror fails, the mesh is asymmetric: run Select All > Mesh > **Snap to Symmetry**.
- Unwrap method: **U > Unwrap Minimum Stretch** (Blender 4.3+/5.x; it is better for characters than Angle Based, and Conformal is only for simple objects). Live Unwrap reuses the last method you picked.
- After each unwrap: Select All > UV > **Average Islands Scale**. Then Pack Islands as a temporary step, and arrange by hand.
- Stretch check: Overlay > **Display Stretch**. Set the UV face display to Black and untick Faces. You want everything blue; yellow or red means stretching. Checker material `UV checker`: Image Texture > New `UV grid`, **4096×4096** (type 1024*4), Generated Type = **Color Grid**. In the Solid viewport, set Color = **Texture**. Turn on modifier "on cage"/edit-mode Subsurf to preview.
- Pins: **P** to pin, **Alt P** to unpin. With Live Unwrap, moving a pinned vert re-solves everything else. Straighten a skewed strip: pin both ends, then **S X 0** or **S Y 0**. Grab UVs brush (F for size) to even out the squares.
- Centre an island: N panel, UV Vertex X = Y = 0.5. 2D cursor at 0.5,0.5 with pivot = 2D cursor, then S X 0. Rotate with Ctrl to snap. Use Individual Origins pivot to scale islands in place. Move islands in **face select mode** (in vertex mode, sync-selection drags the connected verts too).

## Seam placement (body)
- Hide seams where the camera doesn't see them, or put them on natural breaks.
- Legs, arms and neck are cylinders: one ring at each end, plus one straight seam along the length on the **inner/under side** (inside of the leg, underside of the arm, back of the neck). Neck rings go where the shirt covers them.
- Feet: one loop splitting top from sole. Hands: one loop splitting the back of the hand from the palm (hide the arm faces to stop the loop running on). Each **finger is its own island** (a ring at the base).
- Torso: split front from back with a side loop (mirrored) plus the bottom edges.
- Head: ear front and back as separate islands. Back-of-head seam down the middle, under the hair. Separate the **eye cavities** and the **mouth bag** (cut the mouth bag down the middle). Re-mark one seam after unhiding to refresh the live unwrap.
- Face fix: centre it, rotate 180° if needed, pin the borders, eyes and ears, then S Y on the lip region to un-stretch. **Scale the eyelid UV rows down in Y** so closing the eyes doesn't stretch the texture.

## Texel density / layout rules
- Face (and ears to match) scaled UP for more texels. Legs, feet (inside shoes), inner skirt and unseen parts scaled DOWN.
- Put the character's right parts on the UV right side and left on the left. Make all checker letters **upright**. No overlaps. Lay out fingers in order, each finger's top and bottom paired. Empty space is OK for an animation character.
- Clothes: seams on the real garment seams. Shirt seams down the side and under the sleeves, with the inside shell faces left attached. Skirt seams on the sculpt seams, plus extra cuts where the checker skews. Shoes: **all shoe sub-objects share one UV map** (multi-object edit). Treat long straps as elongated cubes (2 seams); **Shift R** repeats the last action. Pin and straighten skewed strips.
- Assets like the Human Base Meshes eyes and teeth already have UVs. The teeth/tongue sit outside 0–1 (UDIM), so scale and move them into 0–1 (no UDIMs in this course).
- In Blender 5.0+ you can see UVs in Object mode.

## Scriptable translation
- `bpy.ops.uv.unwrap(method='MINIMUM_STRETCH')` (5.x enum), `uv.average_islands_scale()`, `uv.pack_islands(margin=0.005, rotate=True)`.
- Seams from rules: rings at loops with the smallest perimeter near joints (wrist/ankle/neck/finger bases), and lengthwise seams on the edge path whose normals face the body's inner/back side (dot(normal, -X side or +Y back) max). Compute stretch per face (area ratio 3D/UV, and angle distortion) to verify (< 10% deviation target).
- Texel-density scaling per island by name group: face 1.5×, hands 1.0, torso 1.0, legs/feet 0.6, hidden 0.3.
