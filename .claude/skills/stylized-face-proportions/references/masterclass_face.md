# Masterclass ch3: Face & head  [01:36:09-02:28:05]

## Proportion rules (use as numeric checks)
- Eye line = halfway between top of head and bottom of jaw.
- Hairline->jaw split in thirds: line 1 = brow line, line 2 = bottom of nose.
- Ear sits between brow line and nose-bottom line (top of ear at brow, bottom at nose base). At the back, the brow-line level is where the skull turns down into the neck.
- Side profile (avoid flat face): eye corner->front edge of eye = 1 unit; eye front edge->nose bridge = 1 unit; nose bridge->nose tip = 1 unit.
- Mouth: midway between nose bottom and jaw bottom = BOTTOM of lower lip.
- Eye spacing: gap between eyes = 1 eye width; outer corner to side of head = 1 eye width (stylized may vary, his concept wider).
- Mouth width: corners never past the vertical through the iris centre (mid-eye).
## Forms
- Head = cranium + jaw wedge. Planes he keeps (simplified): forehead, temples (both sides flat), eye line (recess for eyes, leave room for nose), brow line, side of face (flat), chin. Nose added on, not a plane.
- Eyes sit IN sockets; lids wrap the eyeball. Three lid edges: contact edge with eyeball, lid fold, edge transitioning into face. Lid points radiate from eyeball centre (side view).
- Nose = rounded triangular block (triangle from bottom), then detail; female: smooth curve from nose bridge into forehead.
- Mouth wraps the teeth: bulk up muzzle before lips. Upper lip sits IN FRONT of lower lip; corners pulled back.
- Ear = triangular wedge from front and top; detail = "question mark" (helix) + "Y" (antihelix branches).
## Blender process (sculpt; for us = targets/validation)
- Remesh voxel progression on head: 0.04-0.05 -> 0.03 (after joining nose) -> 0.02 (eyelids) -> 0.012 (refine) -> ears 0.02 -> 0.008. (Scene is not real-world scaled yet, head ~ 1-2 BU.)
- Nose = round cube joined (Ctrl J) then remeshed together, Clay Strips to blend volume toward brow.
- Eyeballs: UV sphere rotated X 90 deg (pole forward), shade smooth, Mirror modifier with mirror object = head. Iris: select pole vert, Ctrl+Numpad+ grow, vertex paint with face mask; viewport shading colour = Attribute.
- Eyelids: Draw brush over lid, Grab to shape, Crease Polish for lid edge + fold, Scrape to flatten lid underside, Grab back so lids wrap eyeball. Asian monolid = smooth away upper fold. Outer corner higher than inner for this character.
- Mouth: Clay Strips volume, Crease Polish corners and straight mouth line corner->centre, Grab upper lip forward, Inflate lower lip area then smooth corners.
- Eyebrows/eyelashes placeholders: plane, snapping Face Project + align rotation + scale, extrude along brow line, Mirror (object = head) + Solidify; Shift N recalc normals; vertex colour value 25% grey not black (forms stay readable). Lashes: extrude verts along lid edge, back row, F fill. Later replaced by hair geometry.
- Ears: Lasso mask (front faces only) of ear outline, invert Ctrl I, big Grab push in, Alt M clear, remesh, Crease Polish helix/antihelix, Clay for Y.
