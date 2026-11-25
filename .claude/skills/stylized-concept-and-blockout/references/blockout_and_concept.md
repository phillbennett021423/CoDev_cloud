# Blockout and concept: full notes (from Kenny Praise videos)

# Masterclass (qy-wwP-b9HY) ch0-2: intro, concept, blockout  [00:00:00-01:36:09]
Source: Kenny Praise "How to Create Stylized 3D Characters (Full Masterclass)", Blender 5.0. Concept by Jennifer Park (Asian girl, boots, skirt).

## Pipeline order (8 sessions)
concept+refs -> blockout -> face/head sculpt -> body sculpt -> clothes+accessories -> retopo (face, body incl mouth/teeth/tongue, clothes) -> UV -> geometry-nodes strand hair (replaces sculpted hair) -> shading/texturing (eye + hair shaders, painted textures, normal maps, extra maps) -> Rigify rig + poses -> lighting/presentation/turntable.

## Concept (ch1)
- A good concept = one you find appealing; avoid overly complex designs while learning.
- Gather references per part: face style + 2-3 real faces of matching ethnicity as PROPORTION guides; boots (exact model + 3 for folds); skirt mechanics; hair direction/parting; body (simple shapes); material refs for shading; jewelry. Tool: PureRef, pinned always-on-top.

## Blockout (ch2) rules
- Blockout = simple primitives, no detail; forms, proportions, structure only. Clothes removed.
- Measure proportions FROM THE CONCEPT (stylized breaks real proportions; e.g. head height = torso height = leg height on some designs).
- Shape language: keep the concept's dominant shape (round / angular / boxy / triangular) on EVERY part (face, legs...).
- Split into parts: head, neck, ears, upper torso (ribcage), mid torso (waist), pelvis, upper leg, lower leg, foot, upper arm, lower arm, shoulder (deltoid cap), hand paddle. Each its own object.
- Primitive = "Round Cube" (Extra Mesh Objects extension), low res. Add to Quick Favorites (Q) with mirror modifier and line-project brush.
- TRANSFORM ONLY IN EDIT MODE so origin stays at world centre (symmetry + mirror work). If moved in object mode: Ctrl A apply all transforms.
- Straight vs curve: each limb has one curved side and one straight side (leg: curve front, straight back; calf curve back). S-curve runs through whole side silhouette (neck tilts back/forward, ribcage tilts, pelvis tilts opposite).
- Pieces must FLOW into each other, not stack (overlap and pull edges into neighbour).
- Silhouette check: Viewport Shading > Lighting Flat/custom, object colour black (Blender 5: specular lighting off); keep a second viewport showing silhouette.
- Viewport: N > View > Focal Length 150 mm (no distortion). Clip start 0.1 until scaled to real world. Split viewport: main sculpt + overview (no gizmos/overlays) + PureRef.
- Keymap: Preferences > Keymap > "Extra shading pie menu items" (Z pie gets overlay / x-ray toggles).
- Brushes: Grab (G) main tool; Line Project (slice flat planes; F flips side); Crease Polish (Shift C) to mark separations (jaw/cranium); Scrape (Shift T) flatten sides; Inflate (I); Smooth (Shift); Lasso Mask + Alt M clear mask; X symmetry on. Symmetrize +X -> -X for parts sculpted on one side (ear).
- Head: egg; slice sides flat (front view) with Line Project; crease jaw/cranium separation running up to where the ear sits; back of head not fully round (pull back).
- Neck: round cube, extrude bottom half down (x-ray), tilt BACKWARD (top forward), add Ctrl R 6 loops so it can be sculpted; flare into chest front, back, shoulders; slice sides.
- Ear: on jaw/cranium separation line, rotated (not facing front), Line Project to outline shape.
- Torso = 3 round cubes (ribcage, waist, pelvis), rotate to make S-curve; pelvis sliced where legs exit. Back: crease spine separation.
- Legs: upper leg (mirror mod), knee formed between upper/lower; lower leg narrows at ankle. "Angry face" rule on lower legs: outer calf high, inner calf low; inner ankle (medial malleolus) HIGHER than outer ankle (lateral) - wait: he says inner ankle higher, outer lower.
- Foot: rectangle from bottom; front view = right-angle triangle (inner side vertical); side = triangle; mask sole before grabbing up.
- Arms: A-pose (neutral, not too close to body, for rigging); slight bend at elbow (rotate lower arm a bit on Z) so IK knows bend direction. Lower arm via loop cuts scaled for forearm taper; bicep ends in V into forearm.
- Shoulder: separate round cube overlapping the upper arm, flowing into chest/back; small for females.
- Hand: paddle (sliced top/bottom), inflate thumb pad, pull thumb stub.
- Final pass: compare with refs, scale groups in edit mode (one active object) to fix proportions; take 20-30 min break then re-check.

# Blockout coaching + practice (ZdybynVI_t0 16:08, 1SPWv8PzYGg 7:21)
- Focal length **115 mm** for blockout review. Neck narrow at the bottom, not too wide. Shoulders straightened, parts flowing into each other (Grab).
- **Balance check from the side:** a character leaning forward "looks like she'll fall over". Rotate the leg parts in edit mode so the weight sits over the feet. Give the legs a slight bend.
- **Front must face -Y:** Numpad 1 must show the face. If not, R Z 180 and **Ctrl A Apply All Transforms** (rotation 0, scale 1).
- Upper leg shorter, narrowing to the knee. Lower leg: one side curves, the other side is straight (the "straight vs curve" rule).
- **Foot:** from the bottom it is a rectangle tapering outward (wider at the toes). The **heel is wider than the ankle/leg coming into it** and rounded from the side. Pointed shoes ≠ pointed feet: model normal feet under the shoes.
- Head: **flat back of the head** flowing to the neck. Crease Polish the jaw/cranium separation. The forehead is squarer, not round. 3/4 view check.
- Arm: indicate the muscle. Forearm wider at the top. Line Project flattens the palm side. The shoulders blend into the arm and torso.
- **Neutral expression** on sculpts (eyes flat at the top / relaxed). Expressions come at the rig stage (shape keys).
- Practice = **speed sculpts** (1–2 h timer, simple concepts, note the mistakes, fix them next time). Quantity beats perfection.

- Weird/exaggerated faces, 3 steps: big forms (skull + jaw as separate shapes, no resolution added; sketch over refs in PureRef), medium forms (5 head planes; the side of the head is not flat; Round Cube nose/beard), small forms (eyes, nose, mouth, then a step back for cohesion; Pinch marks the beard edge).
- Likeness: compare chin protrusion and widths constantly against the photo.
- Sketch-3D (after Jackie Droujko): primitives + Grab only, materials and GP lines early, NO Mirror (too perfect), separate objects, a Lattice modifier to distort the head to match the 2D concept, hand-painted textures (Artist Essentials brushes).
- Hoodie: mirror + I inset with B for the opening, rotate the sleeve ring, delete the bottom faces, grab/inflate to stop intersection, a separate hood merged, Lasso Mask + Snake Hook (K), Solidify + shade smooth, apply Mirror, Multires + Crease Polish seams.
## Blockout with round cubes
- Every body part is a Round Cube (head, chest, pelvis = a 180-degree-rotated duplicate of the chest, thigh, calf, foot, upper arm, forearm, palm, neck). Apply transforms (Ctrl A) before sculpting each piece. Add 6 loop cuts on limbs before Grab. Mirror modifier with the mirror object = head (centre). Fingers: Alt D linked skin chains. Matcap silhouette check at the end.

## Hair sculpt brushes (GN hair curves)
