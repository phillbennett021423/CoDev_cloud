# Texturing workflow (2kI5IgarERc), brows/lashes GN (C284k-WJDF8), face proportions (UiuGcNmbY-A), SSS mask (MqVVIKiLcIE), eyes (JMStsdAis3g), detail transfer (VAAhoJAIm0E), add-ons (OSVe8JEVJuA)

## Hand-painted skin texture (Texture Paint workspace)
- Needs UVs. Skin colour palette prepared first. Image Texture > New "skin base color", 4K (1024*4 = 4096), colour = palette base skin (Ctrl C/Ctrl V the hex), plug into Base Color. Lens 150. Save often: Alt S over the image editor (the * means unsaved).
- Paint Soft brush. Order: 1) reds where blood pools (cheeks, nose, ears, under the jaw, knuckles), strength ~0.12, blend back with the base colour at low strength, then Blur (or Shift). Keep the brush small (big brushes lag/crash). 2) Face-select paint mask (edit-mode selection) for eyelid makeup in a dark colour, strength 1, Shift blur at the edges. 3) Painted AO with a dark colour, strength ~0.4, in the nose/eyelid crease/lip corners/ears; fade out, blur. Shift X samples a colour. The 2D image editor has no symmetry. 4) Lips: select lip faces, Fill brush with a flat lip colour (pressure off), darker lip line, a mouth-open shape key so you can paint the inner lip and blend it. 5) Slight yellow at low strength on bony areas; dark toenail colour.
- Roughness: duplicate the image node, "skin roughness", 4K, value 0.5 grey, **Non-Color**. Black = glossier (nose, lips), white = rougher. ColorRamp after it (black handle to ~0.2 to tame it). Noise Texture (UV coords, Ctrl T mapping) scale 200, its own ColorRamp, then Mix Color **Overlay** fac 1 (A = painted rough, B = noise), into Roughness.
- Freckles: brush Stroke Spacing 200, Jitter ~1.3, dark colour, X symmetry off, vary the size.
- Bump: the same noise into Bump Height, strength ~0.2 (keep it low; exclude the lips), into Normal.
- SSS: weight 1, Random Walk (Skin), scale 0.01 for this scale.

## SSS mask (MqVVIKiLcIE)
- Back Area light + front Area light to see SSS. Subsurface Weight 1, method Random Walk (Skin). Radius RGB default (1, 0.2, 0.1) for humans; change for aliens. Scale ~0.015 to 0.05 for a 1.6 m character (scale it with height). IOR 1.4. Anisotropy left at default.
- Vertex colour attribute "SSS" (black). Vertex paint white on the ears, nose, fingers, toes; less on the eyes and lips; Shift blurs. Shader: Color Attribute "SSS" > Map Range (from 0..1 to 0.2..0.9, or 0.7 max) > Subsurface Weight.

