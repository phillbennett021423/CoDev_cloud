# Stylize 3D portraits (euEUJzZDQV0, 36:25) — from a photo reference to a stylized head
## Before sculpting: list the **distinctive features** to push (this ref: defined cheekbones, defined angular jaw, large eyes → exaggerate bigger, rounded nose-wing corners, thin lips). Push the features, don't copy them 1:1.
## Head = **cranium (box-ish round cube) + jaw wedge**
1. Round Cube (Extra Objects add-on) = cranium. Grab brush to pull the jaw down from the front (an egg shape), then forward from the side. Flatten and angle the jaw to the ref. **Line Project** slices the planes.
2. Crease Polish marks the **jaw/cranium separation** from the side. Grab pushes the cranium up. **Flatten the back of the skull into the neck** (no undercut curve; the back of the head flows into the neck). The cranium is boxy, not a ball. Scrape the temporal plane so the side of the head reaches toward the front.
3. Neck = a round cube, half extruded down, **tilted forward (not vertical)**, 4 loop cuts. Sculpt: the front pulled forward into the chest, the back pushed back into the shoulders, the bottom widened for the trapezius.
4. Ears = a round cube, Line-Project sliced both sides, Symmetrize, scaled thin in Y, **rotated so they don't face front**, sunk into the head.
5. **Backup:** duplicate the blockout into a `blockouts` collection (hidden) before detailing.
## Planes and features (remesh **0.05**, then up; final merged **0.008**)
- Scrape the temporal region. Make the jaw angular and broaden it. **Eye line at half the head height** (Crease Polish), then push the sockets back with Grab and smooth = the brow line. Scrape the cheek planes. Crease the eyebrow line (Ctrl inverts), and the chin (not too high). Line-Project the neck bottom flat.
- Nose: a separate round cube, half extruded, **triangular from below**, kept SEPARATE until its shape is final (edit-mode S X to narrow it easily). Then Ctrl J, remesh, and blend with Crease (Shift smooth).
- **Lips wrap around the teeth:** build the muzzle curvature volume first. Dig the nostrils. **Mouth corners no wider than the iris centre.** Lower lip: Draw, then Grab shape, then Crease Polish edges. Upper lip: Draw volume + Crease transitions. Add the nasolabial volume from the nose to the mouth side.
- Eyes: UV sphere rotated X 90°, Mirror modifier, scaled **up for stylization**, pushed in. Vertex-paint the iris (Paint Mask), viewport colour = Attribute. Lids = Draw strokes + Grab, a crease above the upper lid, the lower lid drawn, **lids wrap the eyeball**. Rotate the eyeballs slightly up/out.
- Brows/lashes = box-modelled plane + Solidify + Mirror, vertex-painted, flip the normals if needed.
- **Ear = "?" + "Y"** shapes (Crease brush). From the side the **front and back edges of the ear should be parallel** (the common mistake is a crooked ear). Keep it simple for stylized work.
- **Low resolution first, like sketching.** High voxel density makes big-form edits hard.
- **Eye highlight mesh:** duplicate the cornea ring, separate it, add a loop, LoopTools Circle, and scale it into a small highlight disc (white/emissive), Alt S to sit on the surface.
- Check from all angles (an animation character is seen from everywhere).
