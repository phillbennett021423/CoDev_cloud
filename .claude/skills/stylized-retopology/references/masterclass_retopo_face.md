# Masterclass ch6: Retopology intro + face/head  [06:02:34-07:21:25]
## Theory
- Game/realtime topo: low count, more density only where it matters (face/fists), less on hidden props. Animation/offline: quads, subdivided at render (Subsurf), higher count OK. Kenny's masterclass = animation topology; principles still apply to games.
- Sculpt was 2M+ tris. Quads: loop cuts pass, predictable subdivision, better deformation. N-gons/tris stop loops.
- Edge loop = chain; edge flow = direction loops follow (should follow forms). Poles: only 3-poles and 5-poles; avoid 6+ (pinching). Poles redirect loops / reduce 4 faces -> 2 (collapse pairs + merge by distance).
- FACE LOOPS REQUIRED for animation: around eyes (lids close), around nose, around mouth (most important), nasolabial (nose wing -> mouth corner -> chin), face contour (forehead -> side of face -> chin), around ear.
## Prep (scriptable)
- Collections: high_poly (clothes, hair subcollections) and low_poly.
- REAL-WORLD SCALE before retopo: 2 m reference cube sitting on floor, scale everything about the 3D cursor so character ~1.6-1.7 m, feet on Z=0, apply all transforms; then re-tune Solidify thickness (~0.003 m cloth), Skin radii, mirror origins (origin to centre for mirrored parts). Linked-duplicate objects can't apply scale: make single user first.
- Merge body parts: apply modifiers (Visual Geometry to Mesh), join head/ears/neck/torso/legs/arms, voxel remesh 0.008 (at 1.7 m scale), re-blend seams with Clay Strips + smooth, re-crease face details (lost in remesh). Hands + feet joined by BOOLEAN UNION (they're denser) then apply and smooth the wrist/ankle seams. Ankle bones: V + U clay shapes; inner ankle higher.
- Rename: body, brows, eyes, etc.
## Face retopo method (manual in his video -> our skill builds it procedurally)
- Plan loops with Annotate (placement: Surface).
- Snapping: Face Project + align rotation + scale. Overlays: Statistics; Mesh Edit overlay "Retopology" (blue faces), Shift N normals.
- EVERY MAJOR LOOP STARTS WITH 8 EDGES (subdivide 2->4->8). Eye ring 8 edges, extrude+scale outward rings (E S). Nasolabial from mouth corner to centre, 8 edges. Mouth 8 edges, rings outward. Face contour: 4 faces top + 4 bottom = 8 edges. Ear ring: 2 edges on rim.
- Mirror modifier: Clipping ON, On Cage ON (later Auto Mirror add-on); keep Mirror ABOVE Shrinkwrap.
- Fill between loops with F (F2 add-on), M merge at center, Shift R repeat; add loops where needed (stretched faces).
- Shrinkwrap modifier target = body sculpt; apply on a duplicate (copy+apply) when editing in edit mode.
- Relax: Sculpt mode + wireframe overlay + Relax Slide brush with Shift to even topology.
- Mouth interior: extrude inner ring E, S Z (flatten) and place on the lip line. Nose: extrude over bridge, ring around nose must be EVEN count (8), E S inward twice, Grid Fill (Ctrl F, span 2).
- Head: extrude contour following same vertex count to forehead/neck; fill back of head by extruding from behind-ear edges to centre, add 7 loops, fill with F, relax.
- Ear: ring around rim, back = E S twice + Grid Fill (even count); front = rim ring, concha extruded and grid filled; ear doesn't deform much so freeform quads following sculpt are fine.
- Neck: extrude down, make even count (14), flat bottom S Z 0, 5 loop cuts.
- Clip start default (0.01 m) after real-world scale.
