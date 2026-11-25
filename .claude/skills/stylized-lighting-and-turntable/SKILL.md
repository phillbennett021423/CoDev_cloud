---
name: stylized-lighting-and-turntable
description: Light and present a stylized character the Kenny Praise way (cyclorama, 3-point Area lights with a light-linked coloured rim, backdrop halo, wide and close-up cameras, a turntable where camera, lights and backdrop rotate together), with stills, frames and an mp4, by script.
---

# Stylized lighting and turntable (Kenny Praise, masterclass ch. 13, YA-MzLhHHb8, 7F0O4ARh43s)

## Kenny's rules
- Lighting has three jobs: mood, **depth** (the 3D form reads), and directing the eye (to the face and eyes).
  Use film and animation stills as lighting reference.
- **Area lights** for characters; bigger = softer. An HDRI only at low strength for ambience and reflections.
- **Key**: brightest, from one side and above; the shadow side falls on the far half of the face, with some
  light wrapping round (no hard half split). **Fill**: opposite side, much weaker, scaled large. **Rim**:
  behind, much stronger, narrow and stretched over the body, **coloured**, and **light-linked to exclude the
  backdrop**. Extras: a linked-data copy of the key for the legs, a backdrop light behind the character for
  a halo, and a fill near the backdrop to kill its shadows.
- **Cyclorama** from a filled circle with the back half extruded up and the corner bevelled (no visible
  edge at any angle). Dark, from the character palette, Roughness 1, Specular 0.
- Cameras: **80–90 mm** for portraits, 1200×1500 (portrait) at **150%**, ~150 samples. Shots: wide + close-up
  minimum, plus details. Turntable: **24 fps × 8 s = frames 3–195** (1 = close-up, 2 = wide). Parent the
  camera **AND all lights AND the backdrop** to one empty, so the lighting is the same from every side.
- Cinematic variants (7F0O4ARh43s): oval pink spot at 2500 W, size 13–14°, on a white backdrop lit blue by
  two linked point lights; a sharp-edged circle spot halo (radius 0, blend 0.1); a transmissive backdrop
  with an emission plane behind it for a gradient. Few lights, each with a purpose. Post: exposure, contrast,
  HSL per hue, grain, vignette.
- Hair at viewport amount 0.01–0.05 while lighting, 1.0 for the final.

## Script
```bash
python scripts/turntable.py -- --blend hero_posed.blend --out render --stills                 # wide + close-up
python scripts/turntable.py -- --blend hero.blend --out render --turntable --step 1            # 193 frames + mp4
python scripts/turntable.py -- --blend hero.blend --save-scene hero_present.blend              # build only
# previews: --samples 32 --scale 40 ; colours: --backdrop 0.05,0.07,0.12 --rim-color 1,0.45,0.25
```
It builds all of the above in a `PRES-render` collection, scaled to the character's height (Kenny's powers
were for 1.7 m): key 450 W, fill 90 W (2.7× bigger), rim 1400 W (coloured, light-linked EXCLUDE on the
backdrop), legs key sharing the key's data, a 120 W blue backdrop halo, world 0.12, AgX Medium High
Contrast. The cameras are 85 mm, with the wide framed so the character fills about 83% of the height. The
pivot rotates 0→360° linearly over frames 3–195. With `ffmpeg` on the PATH, it also writes `turntable.mp4`.

## QA (mandatory)
Run `stylized-4view-qa` on the final posed file first; then check the renders:
- [ ] Wide shot: the whole character is in frame with the head and feet clear, the face is the brightest
      area, and the rim separates the silhouette from the backdrop.
- [ ] No rim hot-spot on the backdrop (light link working). The backdrop is darker than the character.
- [ ] Turntable: the lighting is the same at 0°, 90°, 180° and 270° (lights rotate with the camera). No flicker.
- [ ] Close-up: the eyes have a highlight; the skin is warm, not grey.

Tested on the posed test character: stills plus a 5-frame turntable with an mp4. QA caught two bugs, now
fixed: the wide camera cut off the head and feet (wrong portrait field of view), and the rim light link failed
on Blender 5.2's API.

## Scripts
- `scripts/turntable.py`: cyclorama, 3-point plus rim/halo lighting, cameras, turntable, stills, frames, mp4.
