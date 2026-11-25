# Project breakdown videos — workflow tips not in the masterclass
## Game loading-screen character (CdrKqrln4ig, 18:09) — 16 h over 5 days
- Start from a **Round Cube** (you can see the quads). Block out the head, torso, ears and neck. Sculpt the **planes of the head first** (proportions), then the nose as its own piece merged in. Eyeball + Draw-brush eyelids. Crease Polish for the lip line, Draw for the lips.
- **Vertex-paint the regions during sculpt.** "Color has weight": even greyscale reads better than a matcap. Merge the neck and ears, then Clay Strips to blend.
- Placeholder hair: Lasso Mask → Mask Extract → remesh → sculpt. **Skin-modifier verts for stray-hair placeholders.** Scarf from a round cube.
- Clothes: plane extruded along the body + Solidify. Cloth sim was too fiddly, so he sculpts instead. Cube box-model the robe + sleeves → Multires → **Draw to indicate a fold, Crease to sharpen it.**
- **Embroidery band:** duplicate the top loop of the dress, extrude it into a strip plane, and UV-align an embroidery image onto it.
- Jewellery: Extra Objects > **Diamond** primitive edited. Necklace = **Array + Curve modifier** on a Bezier.
- Hair: scalp fitted to the hairline (annotation line for the parting). Only groom guides that are SEEN (no under-layer). **Duplicate Hair Curves instead of Interpolate** (no density map needed; it duplicates in a radius around each guide). Separate curve objects for stray hairs (Duplicate + Noise). The back hair relies on modifiers. Lower lashes groomed; **upper lashes are the sculpted placeholder mesh** (refined).
- Eyes: procedural iris + an **eye highlight mesh** (a small emissive/white shape in the eye instead of relying on lights).
- Skin: a **3D Scan Store free face scan**. Align the character's UVs onto the scan maps in the UV editor, **bake** to the proper UV layout, then fix the mismatched areas (ears) with the **Clone brush**. Vertex-colour masks separate the face from the body for normals.
- Robe fuzz = short curves + noise. Scarf = **Sheen BSDF** (velvet). Poly Haven textures. Dress gets Multires detail.
- Rigify + weight fixes. Auto weights for the robe and dress. After posing, **re-groom the hair and re-sculpt folds for the pose.** One key light only. DaVinci Resolve for the loading-screen titles.

## 2D drawing → 3D illustration (F93u9iBaIlA, 11:39) — 11 h over 3 days
- Camera: **Ctrl Alt Numpad 0** to align. Camera > Background Image = concept, Depth **Front**, opacity tuned. Focal length **150 mm**.
- Block out with primitives through the camera. **The 2D concept cheats perspective**: the head, neck and torso each get their own orientation. Stay symmetric until the blockout is done.
- **Illustration vs game/animation asset:** for animation, match the pose in blockout, then return to a **T-pose/A-pose** for retopo/UV/rig. For an illustration, keep the pose, skip the hidden body under the clothes, and break symmetry freely.
- Hands: Blender **Human Base Meshes** hand asset → Edit-mode adjust → sculpt. Pose the fingers with the **Pose brush + Face Sets** as joints.
- **Stroke > Stabilize Stroke** with Crease Polish for clean, sharp forms. Check every angle while matching the camera.
- Head rig: 3 extruded bones parented to the head, weight-tuned, then pose the head to match.
- **Asymmetry via shape keys** (clothing, accessories, face) = non-destructive.
- Black-and-white concept: flat painted colours. **Grain goes in post**, not the textures. **Grease Pencil lines drawn over the model** for 2D accents (no full outline).
- GN hair: a quick node preview early to judge the silhouette, then more guides.

## "Any hairstyle explained" (LCwR0_Qrjz0) — a short version of the hair-course intro (volumes + flow + guides/children + 4 steps). Nothing new.
