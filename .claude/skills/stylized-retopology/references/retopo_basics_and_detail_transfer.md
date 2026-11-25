## Retopo basics
- Eye loop first, a different viewport colour (Object colour + In Front + Backface Culling). Mouth loop: start at the corner, the top and bottom have the SAME vertex count. Ear loop. A loop over the nose bridge down under the chin. Forehead-to-chin outer loop. Fill with F, Shift N normals; add loops so counts match, then M merge pairs, Shift R repeats.


## Detail transfer after retopo (VAAhoJAIm0E)
- Alt G both to the same place. Retopo gets Multires (subdivide x2) + Shrinkwrap (target = sculpt). Apply Shrinkwrap so details come back. Either keep Multires (bake normals) or Multires > **Apply Base** to transfer volumes into the cage, remove Multires and add Subsurf (simple stylized).

