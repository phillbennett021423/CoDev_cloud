# Masterclass ch13 — Lighting, presentation and post (19:05:16–20:01:21)
## Goals of good lighting: mood, depth (3D form reads), and directing where the eye goes (usually the eyes/face). Lighting and composition work together. Use film/animation stills as lighting reference.

## Light types
HDRI = ambient + reflections only (fixed sun, so low strength under your own lights). Point = bulb. Sun = direction only (outdoor). Spot = cone (Spot Size default 45°, Blend 0 harsh → 1 soft). **Area = soft box, the main character light.** Bigger Radius/Size = softer shadows. Right-click drag on Power to adjust. Negative power is allowed.

## Scene setup
- Collection `render` > `lights`. Camera named `camera_wide_shot`, `camera_close_up`, `camera_turnaround`.
- Resolution: **1200×1500** (Instagram portrait), 1920×1080 for YouTube/ArtStation. **Resolution scale 150%** (so fewer samples are needed).
- Camera focal length **80–90 mm** for portraits (he goes longer). Numpad 0, lock camera to view, then unlock after framing.
- A split view with the render preview: overlays and gizmos off. Turn **Scene Lights + Scene World ON** in the viewport shading.
- Ctrl B render region = camera frame (Cycles). EEVEE: camera Passepartout alpha **1.0**.
- **Backdrop (cyclorama):** Mesh Circle → fill → scale big → select the back half edge verts → extrude up Z → Ctrl B bevel the corner (several segments) → shade smooth. A circle beats a plane because no edge is visible at angles. Material: dark colour (pick from the character palette), **Roughness 1, Specular 0**.

## 3-point lighting (all Area lights)
1. **Key** (`light_key`): the brightest, from one side and above. It defines the form and puts the shadow side on the far half of the face. Don't overexpose. Nudge it so some light still wraps onto the shadow cheek (not a hard half split).
2. **Fill** (`light_fill`): the opposite side, **much lower power**. It lifts the shadows without removing them. **Scale it up large** for shadowless softness.
3. **Rim** (`light_rim`): behind the character, **power much higher**, S X narrow so it hits one edge, R Z (Global orientation) to graze the silhouette, scaled in Z to reach the legs. **Coloured** (orange-red for this character). **Light Linking:** Object > Shading > Light Linking > new collection, drop the backdrop in, set it to **Exclude** so the rim doesn't hot-spot the backdrop.
- Extras: duplicate the key down for the legs (Ctrl L > **Link Object Data** so the pair shares power). Duplicate the fill low. **Backdrop point light** directly behind the character opposite the camera (a coloured glow halo for separation). A fill near the backdrop kills its shadows.
- HDRI (Poly Haven nature/forest) at **low strength** for ambience, rotated via the add-on sliders.
- Hair viewport amount 0.01–0.05 while lighting, then back to 1 for renders.

## Shots + turntable
- Wide shot + close-up minimum, plus detail shots (shoes, skirt).
- Turntable: duplicate the wide camera, add an Empty Sphere `camera_turnaround_ctrl` at the origin, and parent the camera to it (Shift-drag in the outliner). **Parent ALL lights AND the backdrop to the empty too**, so the lighting stays consistent from every angle.
- Camera binding in the timeline: frame 1 = close-up (Ctrl B over the timeline with that camera active), frame 2 = wide, frame 3 = turnaround. **24 fps × 8 s = 192 frames, so frames 3–195.** Keyframe the empty rotation: frame 3 Z = 0, frame 195 Z = 360° (keys **Linear** for a constant spin). Frame step 1.
- Output PNG sequence to `renders/`. Cycles GPU, **max samples 200–500** (not 4096). Test-render random frames first. Iterate. Render overnight.

## Post
- Video: DaVinci Resolve. Drop the image sequence from frame 3, then colour page.
- Stills: Photoshop → Smart Object → **Camera Raw**: temperature/tint, exposure, contrast, highlights. Color Mixer saturation per hue (magenta/blue up). **Grain** + **Vignette**. Also chromatic aberration, lens distortion, subtle glow.
- Blender-side equivalent (scriptable): the compositor with Glare (Fog Glow, small), Lens Distortion (dispersion 0.005), a Vignette mask (Ellipse Mask + Blur + Multiply), film grain (Noise texture overlay at 3–5%), and AgX view transform with a "Punchy"/"Medium High Contrast" look.

## Done-checklist translation
For the mandatory skill check, reuse this exact rig: Area key/fill/rim + cyclorama, and orbit the camera empty to 0/90/180/270 for the front/left/back/right review renders.
