# Masterclass ch4: Body, hands, feet  [02:28:05-04:15:04]
## Principles
- Observation over anatomy charts: the chosen body reference IS the anatomy guide; copy what you see.
- Arm = interlocked chain: shoulder cap overlaps bicep, bicep ends in V into forearm, forearm into wrist/hand.
- Leg straight-vs-curve: upper leg front CURVED / back straight; lower leg back CURVED (calf) / front (shin) straight.
- Angry face on lower leg: outer calf bulge higher than inner; INNER ankle HIGHER than outer ankle (never level).
- Torso: rhythm & balance (S-curve even in T/A pose), check silhouette often.
- Hand: palm = rectangle + wedge for thumb base; palm is CURVED (not flat), knuckles on a curve (middle highest), finger joint lines on progressively steeper curves toward fingertips.
- Finger proportion: knuckle->tip = 1; first joint at 1/2; second joint at halfway between first joint and tip (3/4).
- Finger joint angles: base segment angles slightly back/up, middle up+forward, tip forward. Never straight.
- Foot: right-angle triangle from front (inner side vertical) and side; rectangle from bottom with sides pushed in; arch pushed up mid-sole; heel = teardrop from back; stepped toes (big toe highest, steps down).
## Construction recipes (directly scriptable)
- PALM: cube in edit mode, scaled flat; loop cut middle raised + 2 more loops raised = palm curvature; extrude 4 faces + 4 faces outward for thumb wedge; edge-slide loops to round; loop for finger gap; Mirror; Subdivision Surface; edges lowered on outer palm = fat pad opposite thumb.
- FINGER: cube -> merge all verts at center (keep origin at knuckle) -> extrude 1 vert along X -> SKIN modifier + SUBSURF level 1-2; Ctrl A (skin resize) for thickness; loop cuts in middle bent up, tip narrowed (skin radius smaller). Position in OBJECT mode (origin = knuckle pivot).
- Duplicate fingers with Alt D (linked data) so edits apply to all; lengths: pinky shortest, ring, middle longest, index; spread slightly; follow palm curvature (raise middle ones); rotate down slightly.
- THUMB: Shift D (unlinked) copy of finger, rotated, shortened, fattened (skin radius), placed in wedge.
- Convert linked: Ctrl A > Visual Geometry to Mesh (applies modifiers, keeps link). Then sculpt with Y (local) symmetry; crease joints by proportions; flatten nail area with Scrape (nails optional: crease outline, sharpen, flat).
- Remesh fingers 0.01, palm 0.025, join (palm active, Ctrl J) and remesh HIGH (0.01) so webs don't fuse; Clay Strips lines from palm into fingers then smooth; crease finger base; knuckle creases.
- FOOT: round cube; bottom = rectangle; lasso mask sole (front faces only OFF), grab top up into leg; right-angle triangle; inflate heel teardrop; line project toe line. TOES like fingers (vertex + skin + subsurf L2), stepped loops; Alt D duplicates scaled on LOCAL Y (S Y Y); flat on ground; keep extra space between toes until after retopo (then close the gap).
- Remesh foot then toes 0.006 after join; clay to blend toes; crease separations; arch.
- Body parts remesh: legs 0.05, torso 0.03, arms 0.03, merge legs at 0.04, torso parts 0.03. Viewport mask Alt B to isolate.
- Female torso: ribcage crease, side crease (pinch), belly centre line, navel, breasts via Clay Strips "number 6" stroke from shoulder, crease under-chest into armpit, back S-curve/arch, buttock overlap onto legs.
- Elbow: grab out the back of upper arm, crease + scrape a small plane.
- After body: re-check proportions (his head was too small -> scaled up; feet too small -> scaled up).
