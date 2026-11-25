# Procedural skin shader (mkj1o0IvZtw, 13:24) — refines masterclass ch11
Cycles. Material `skin`. Base RGB node (copied colour), or the painted base-colour image via a reroute.
1. **Layer Weight > Facing** → ColorRamp (**B-Spline**, flipped, red value pulled in) → Mix Color **Soft Light**, Fac **0.5** (A = colour, B = ramp). Add this LAST over the variation chain.
2. **Variation 1:** Noise (UV, Ctrl T), Scale **≈250** (plus mapping scale up) → ColorRamp (black and white stops pulled in) → Mix Factor. A = colour, B = **Hue/Sat/Val** (saturation up, value down; lower the HSV-mix white so it's subtle).
3. **Variation 2:** Voronoi **Smooth F1**, Scale **≈400** → ColorRamp clipped (white dots) → Mix (A = previous mix, Fac = voronoi, B = the same HSV colour). Frame as "base color".
4. **Roughness:** the variation-1 Noise Fac → ColorRamp, black lifted slightly (never fully glossy) and white lowered (never fully matte) → Roughness.
5. **Bump:** the same Noise Fac → ColorRamp → Bump Height, Strength **0.2** → Normal.
6. **Lip mask** (painted B/W image): Mix Color (Fac = mask) on roughness with B black → glossy lips (about **0.4**). Duplicate on bump with B white → no bump on the lips.

# 3 cinematic lighting setups (7F0O4ARh43s, 11:09) — beyond 3-point
- **Setup 1 (pink spot / blue backdrop):** white Principled backdrop. **Spot** scaled non-uniformly (S X/Z) into an oval, pink, **Power 2500 W**, **Spot Size ≈13–14°**, small **Radius** (soft shadow), high Blend (soft falloff). It casts the character's shadow on the backdrop. Backdrop colour comes from **2 blue Point lights** (Link Object Data) aimed at the backdrop, so the backdrop stays white and the pink spot survives. 2 **rim lights** of different colours left and right. A subtle orange Area "key" on the face.
- **Setup 2:** orange-tinted backdrop. Red Area fill lights on the backdrop. Blue Area key. Spot **Power 2000**, **Radius 0** (sharp circle edge), **Blend 0.1**, to make a circle halo on the backdrop.
- **Setup 3 (gradient backdrop):** backdrop Principled **Transmission 1.0**, with an **Emission plane behind it** showing through as a soft glow gradient. Plus a top rim light and one side light. Few lights, each with a purpose.
- Post: Photoshop Camera Raw (exposure, contrast, vibrance, **Color Mixer HSL per hue**, grain, vignette). "The magic of the lighting is in post."
- In the viewport, hide the scalp, use a low hair viewport amount, then 1.0 for the final.
