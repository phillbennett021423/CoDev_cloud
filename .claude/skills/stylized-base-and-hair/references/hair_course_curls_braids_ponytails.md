# Hair full course (8eVlQZuQOj4, 2:34:18) — what's NEW beyond masterclass ch10
The same 4-step workflow (guides → interpolate → clump → noise), all built in a GN modifier. These are extra recipes.

## Procedural curly hair (no grooming): "hair guides" GN group
- Generate guides procedurally: Curves density on the scalp (Distribute / "Generate Hair Curves" asset): density **500→800**, length **0.05**.
- Set Hair Curves Profile radius: default habit **0.001**. For visibility while working: 0.03–0.06.
- **Curl Hair Curves** on the guides: untick Use Existing Guide Map, Guide Distance 0, Radius **0.01**. Start/End curl factor controls curl at the root vs the tip. Group the nodes as "hair guides".
- Interpolate: density **50k→100k** (final up to **1.2M** = about 100k+ splines; a human has 90k–150k).
- 2nd Curl after interpolation: Radius 0.02, Guide Distance **0.01–0.015** (more distance = bigger coils).
- Primary Clump: same guide distance, Factor **0.7**. Secondary clump guide distance **0.05**.
- Noise: Scale **20**, Offset per Curve **0.2**. **Random subset via Factor:** Curve Info > Random → ColorRamp (black stop **0.4**) → Noise Factor (no separate/join needed).
- Material in GN: put **Set Material** after the generator (the Hair BSDF material).

## Long groomed hair (ponytail woman)
- Add brush Points **30**. Strand display while grooming, Strip when noding. Interpolate Length/Shape on. Guides around the perimeter first, then fill the gaps between them. **Keep inner guides inside the outer ones** with a gap to the head (volume layering).
- Interpolate Hair Curves: **Interpolation Guides 4 → 10** (the number of guides used per child; 50 for smoothing). Density 20k→80k. Radius 0.003.
- Rip the scalp parting into islands (Part by Mesh Islands).
- **Primary clump guides:** Delete Geometry (spline) with Random probability **0.85–0.987** → Create Guide Index Map → Clump (Guide Index), Factor **0.7**. Secondary: probability **0.95**, Factor about **0.2–0.4**.
- **Newly grown hairs (flyaways):** Separate (p≈**0.06**) → Trim Hair Curves (untick Replace Length; length min **0.15**, max **0.23**) → Noise **Scale 200**, Offset per Curve 0.1, Factor 0.5–0.75.
- Main-hair noise on 40–50% (Separate p **0.4**): Scale along curve **50**, scale **10**, distance **0.025–0.035**. Join: flyaways + noisy + inverted.
- **Left/right clumping bleeding across the parting:** create a named attribute (Store Named Attribute "side" from a mask/position.x sign, or the scalp island index) and plug it into **Clump Hair Curves > Group ID** on both the primary and secondary clumps.

## Bun/ponytail hairstyle into a band
- A Circle mesh rotated 90° X marks the band where all strands converge. Invalid UV map error → every scalp object needs a UV map.
- Main guides: interpolate 100k–300k, **Interpolation Guides 8–12** to stop intersections. Clump via Guide Index (the groomed guides as clump centres), then a secondary clump p≈**0.97**, **Shape 0.2**. Noise on p≈0.05 (Scale 30, offset 2, distance 0.02, factor 0.5).
- **Curly finish:** Curl before interpolation (Radius 0.01, no existing guide map) + Curl after (Radius 0.01, guide distance 0.03, factor up to 1.2–1.5).
- **Ponytail volume:** "Duplicate Hair Curves" (Amount **200**, Radius **0.001–0.003**) to clone strands around each guide. **Clump with a Shape profile along the strand:** Spline Parameter > Factor → ColorRamp (root 0.1, middle 0.5, tip 0.1) → Clump Shape = tight at the root and tip, full in the middle (the classic ponytail).
- Side hair: Trim (random offset 0.2) + Noise (10, 0.25), radius 0.005.

## Eyebrows (dense grooming)
- Scalp = a face strip, Shrinkwrap + Mirror, **pinned**. Density brush Distance about **0.007**, length 0.003–0.025.
- Profile radius **0.00001** (very thin). Interpolate 100k + a density mask (black edges soft-painted to feather). Clumps: distance ~0.0x factor 0.7, plus a secondary 0.08.
- **Trim the edges by mask:** an Image Texture node (the same density mask, sampled on the scalp UVs) → ColorRamp → Trim Hair Curves length factor, so the hairs are shorter at the brow edges.

## Eyebrow/eyelash CARDS (game-friendly!)
- **Brow card:** Plane, rotate X 90°, scale to the brow, Smooth Vertices, Mirror. Paint or draw the brow strokes in Photoshop (brightness/contrast) and export a PNG. Material: Image (UV, Ctrl T) → ColorRamp flipped → **Alpha**. Base colour brown. Shrinkwrap the plane to the face (remove Subsurf, apply), then Mirror.
- This is the low-poly route for Godot/Roblox: **alpha-textured cards** instead of curves.

## Eyelashes (curves)
Guides with length 0.01, profile radius **0.001** (thicken a bit). Clump: distance **0.001→0.15**, Factor driven by Curve Info Random → ColorRamp so only some lashes clump.

## Hair colour shader (Kenny's standard)
Curve Info **Random** → ColorRamp (several close hair tones) = per-strand colour variation. Curve Info **Intercept** → ColorRamp → Mix Factor: A = dark root colour, B = the random colour. → Principled Hair BSDF (Cycles).

# Braids (ZGOWVDo-AAg, 14:58) — no add-ons
- Scalp: select the head faces, Shift D, P > Selection. Annotation (Surface) lines mark each braid path (4 braids).
- **Main braid guides:** Add brush, length 0.3, **Points 40**. ONE guide per braid, combed along the line **close to the head** (Projected falloff). Grow/Shrink (Ctrl) to trim.
- GN "braids": **Duplicate Hair Curves** (Radius **0.01**, Amount high, **Tip Roundness 1**, **Even Thickness ON**) → **Braid Hair Curves** (Radius **0.01**, **Shape 0.1**, **Frequency 2**, Shape > **Back Domain 0.5**, **Shape Thickness -0.5**, **Shape Asymmetry -0.11**). **Hair Tie:** enable it, pick a tie mesh object, scale **0.3**.
- **Braid extensions** (the strands pulled into the braid): a new curve object. Annotation lines mark the extent. Add brush **Points 10, Length 0.05**, evenly spaced along the line, combed toward the braid (not clipping). GN: Duplicate Hair Curves (Radius **0.005**) → Set Hair Curves Profile (Radius **0.002**, **Factor Min 1 / Factor Max 0** = thick root tapering to the tip, render Strip). → **Frizz** (untick Cumulative Offset, Distance **0.0015**, Factor = Curve Info Random → ColorRamp) → **Hair Curves Noise** (untick Cumulative, Distance **0.008**, Shape 0, Scale 5, Scale Along Curve 25, Offset per Curve 0.01, Factor = the same random ramp, new Seed).
