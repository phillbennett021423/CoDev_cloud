# Masterclass ch12 — Rigging and posing (17:24:24–19:05:16)
## Concepts
Armature = a system of bones in parent→child hierarchy (offset children are still parented; dashed relationship lines). Edit mode builds, Pose mode poses. Weights = per-vertex influence 0–1 (blue→red heat map). Add-ons: **Rigify** (built in, used here), Auto-Rig Pro (paid).

## Collections
`CH-<name>` → `CH-<name>-model` (all GEO and the clothes/hair collections) + `CH-<name>-rig` (active when adding) + `CH-<name>-rig-helpers`.

## Rigify meta-rig placement (Shift A > Armature > Rigify > Human Meta-Rig)
- Transform ONLY in **Edit mode** (never object scale). Pivot = 3D cursor at the origin, then scale to the character's height. Viewport Display **In Front**. Isolate the body and the rig. **X-Axis Mirror** on.
- Spine: chest/ribcage bone at the ribcage. Fix the side profile. **Box-select joints** so connected bones don't detach (selecting a single bone and moving it disconnects it). Pelvis bones forward.
- Leg: thigh from the hip middle, shin head at the knee, foot bone at the ankle pivot, toe bone at the toes, **heel bone at the BOTTOM of the shoe** at the heel pivot (scale X to the shoe width). **Keep a slight forward bend at the knee** (IK bend direction). Centre it on the leg in front view.
- Neck: 2 "spine" bones (spine.004/.005) for the neck, spine.006 = head up to the skull top. The face bone size doesn't matter.
- Breast bones at the bottom of the breast, centred.
- Shoulder bone follows the clavicle. Upper arm → elbow → hand. Don't press F (it makes a new bone).
- **Fingers inside the volume:** body Edit mode, select the vert/edge loop at the joint, Shift S Cursor to Selected, then rig Edit mode, select the joint, Shift S Selection to Cursor. Do this for every knuckle. Palm bones go in the middle of the palm.
- **Face bones:** scale X to the face width. Snapping **Face Project + Align Rotation + Scale (backface ok)**. Ear: 3 bones on the rim + 2 on the side. Temple, jaw, jaw.L, chin.L, mouth corner, cheek.B (bottom), cheek.T (top), forehead (moved up to the brow height for this character), brow.T just above the eyebrows, brow.B under them, lid corners/middles on the lid edge. **Middle-line bones (nose, nose tip, lip, chin, jaw): snapping OFF, move only from the side view** so they don't disconnect. Nose chain follows the nose and stops at the top lip.
- **Eye bone:** cursor to the cornea centre. Bone head and tail to the cursor, then move the tail straight forward on Y.
- **Tongue: 3 bones** in the tongue. **teeth.B** in the lower teeth (don't forget the tongue and teeth).
- If you see "uses the old face rig", click **Upgrade Face Rig**. Then move the **jaw_master** bone down near the ear (the jaw opening pivot).
- **Generate Rig** (Object Data > Rigify). You can regenerate after fixing the meta-rig.

## Fixing the fingers (curl went the wrong way)
1. Bone roll: every finger bone's **X axis points the same way (the curl axis) and Z points DOWN** (show Axes). Ctrl R to roll.
2. Straighten the chain: transform orientation **Normal**, pivot **Active Element**, then **S X 0** and **S Z 0** per finger chain (and thumb) to flatten them into a line. Re-rotate (R Z / R X) back to the finger middle.
3. Add a **slight bend**: move the middle joints slightly up (G Z) so the curl goes toward the palm. Regenerate.
Test: scale the finger master controls (S) to curl. Alt R / Alt G / Alt S clear. Orientation **Local**, pivot **Individual Origins** when posing.

## Skinning
- Body: select the body, then the rig, Ctrl P > **With Automatic Weights**. The Armature modifier must be **FIRST** (above Subsurf).
- **Simplify** (Render > Simplify, Max Subdivision **0**), added to Quick Favorites for posing speed.
- Pose-mode **X-Axis Mirror** to test symmetric controls.
- Weight paint: Ctrl Tab pie. Search vertex groups. **Auto Normalize ON**. Paint spine.006 at 100% over the cranium to remove the brow bones' influence on the head top. Lids: Paint Mask with selected faces (upper lid only), add/subtract (Ctrl), Shift smooth.
- **Corrective shape key "eye_close"** (Blender 5: new keys default to value 1): record the lid.T.L.002 Y location when closed (**-0.024**). Sculpt the closed lid on the shape key (mask the lower lid with Shift A grow mask, Grab brush, a slight bulge).
- Driver on the key value: Type **Averaged Value**, Transform Channel object = rig, bone = `lid.T.L.002`, **Y Location, Local Space**. Driver editor F-curve: keyframe 2 at x = **-0.024**, y = 1. Both keys **Linear**. Update Dependencies.
- Split L/R: vertex groups `left_side` / `right_side` (weight 1 each side, **0.5 down the centre line** in both). Key Vertex Group = left_side. Duplicate the key, set Vertex Group = right_side, rename `_R`. Copy and paste the driver, then change the bone to `lid.T.R.002`.
- **Eyes:** Ctrl P **With Empty Groups**, then assign all cornea and eyeball verts weight 1 to `DEF-eye.L` / `.R` (automatic weights would let the temple bones distort the eyes).
- **Teeth/tongue:** Empty Groups. Upper teeth → `DEF-teeth.T` (1.0), lower → `DEF-teeth.B`. Tongue: show only the DEF bone collection, select the 3 tongue DEF bones, Weight Paint > **Weights > Assign Automatic from Bones** (only the selected bones).
- **Scalps:** Empty Groups. Hair scalp, ponytail scalp, and hairband fully to `DEF-spine.006` (head). Brow and lash scalps: **Data Transfer of weights from the body** (Weight Paint > Weights > Transfer Weights: **Nearest Face Interpolated**, layers **By Name**).
- **Shirt:** Empty Groups + Transfer Weights from the body (same options).
- **Multi-part shoes/skirt/necklace:** model a low-poly **rig-helper proxy** cage that envelopes the part (`GEO-<name>-shoe-rig-helper`, in the rig-helpers collection, Mirror modifier, **Display As Wire**, hidden in render). Parent the proxy with Automatic Weights. The real part gets Empty Groups + an Armature modifier and a **Surface Deform** modifier (target = proxy) placed **above Subsurf**. **Bind with Simplify on (subdiv 0)** or it errors. To sculpt fixes: unbind, sculpt, rebind.
- **Mask hidden body:** vertex group `mask` on body faces under the clothes (keep the shoulders), Mask modifier (Invert), above Subsurf. This stops poke-through and helps performance.

## Posing
- Posing matters more than the rig. **Always use reference** (e.g. how much does the shoulder tilt when you raise an arm?).
- Find the **line of action** and the **balance** (weight over the support foot).
- **Exaggerate** beyond the reference for stylized work. **Avoid symmetry** (hands and legs never mirrored).
- **Contrapposto:** weight on one leg makes the hips tilt one way and the shoulders tilt the opposite way. One side of the torso stretches, the other compresses. Never parallel hip/shoulder lines.
- Push further with **shape keys** when the rig limits you.
- Pose the bare body first (Mask modifier off). Save poses: Asset Browser > Current File > Pose mode > Assets > **Create Pose Asset**. Camera (Numpad 0, Lock Camera to View) gives pose previews. Make **at least 2 poses** for the final renders.

## Game translation (Godot/Roblox)
Rigify's generated rig has ORG/MCH/DEF bones. Export **DEF bones only** (`Deform` only option in glTF, or a game-rig conversion). Roblox needs R15-compatible names or a custom rig ≤ its bone limits. Corrective shape keys → glTF morph targets (Godot supports them; Roblox supports FACS heads only). Surface Deform proxies must be **baked into real weights** (Data Transfer from the proxy, or apply the pose-driven deform) before export, because the engines don't support Surface Deform. The Mask modifier → delete the hidden faces for real (saves tris).
