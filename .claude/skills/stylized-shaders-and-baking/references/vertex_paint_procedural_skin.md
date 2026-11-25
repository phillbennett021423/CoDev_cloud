## Procedural skin over vertex paint (no UVs needed; bake later)
- Vertex paint: palette, Ctrl X fills the base skin colour. Darker skin around the eyes (lower lid low strength), red on the upper lid, ears, cheeks, nose (tone the nose down with base colour), under the chin. Lips: skin-dark then red on the lower lip; isolate with edit-mode select (L linked) + Paint Mask. Shift smooths.
- Rename the colour attribute "skin color map". Shader:
  1. AO node -> ColorRamp (black pulled in) ; Geometry Pointiness -> ColorRamp (black/white crunched to ~0.45..0.55) ; Mix Color MULTIPLY fac 0.8 (A = AO, B = pointiness) -> then Multiply over the skin colour map, fac 1. Change the ramp's black to a RED so cavities read fleshy.
  2. Noise Texture (Object coords, Ctrl T mapping) scale ~100 then 10, distortion 0.1 -> ColorRamp (black handle ~0.6) -> Multiply factor over the colour map (colour variation).
  3. Ctrl Shift D duplicate that ramp -> Bump (strength 0.08, noise scale ~130) -> Normal.
  4. Another ramp duplicate -> Specular IOR Level, crunched down to ~0.1.
  5. Voronoi (Object, Smooth F1) scale 100 then ~1.5–3, ramp flipped -> Multiply fac 0.6–0.7 with the colour map = blotchy variation.
  6. Freckles: new vertex colour "skin freckles" (white), paint black where freckles go, Color Attribute -> Multiply with a Voronoi (scale ~3, inverted) -> Multiply into the colour chain (A = colour map).
  7. SSS Random Walk (Skin), weight ~0.3–0.7, scale 0.01 then 0.08 (ears must go red, not white).

