"""Kenny Praise's procedural stylized skin (masterclass ch. 11, mkj1o0IvZtw, IEQ7IVPwwQk, MqVVIKiLcIE), built by script.

Node chain (Cycles), exactly in Kenny's order:
  base colour (RGB, or a painted image / colour attribute if present)
  x cavity: AO -> ramp  MULTIPLY  Pointiness -> ramp (0.45..0.55, black tinted RED so cavities read fleshy), fac 0.8
  -> variation 1: Noise (scale 250 in UV, ~60 in object space) -> crunched ramp -> Mix(colour, HSV(sat up, value down))
  -> variation 2: Voronoi Smooth F1 (scale 400 UV / ~150 object) -> clipped ramp -> Mix(…, same HSV)
  -> rim: Layer Weight Facing (blend 0.3) -> B-Spline ramp grey->red -> Mix SOFT LIGHT fac 0.5   (added LAST)
  roughness: variation-1 noise -> ramp lifted 0.35..0.6 (never fully glossy or matte); lips glossier by mask
  bump: same noise -> Bump strength 0.2 (Kenny) ; lips excluded by mask
  SSS: Random Walk (Skin), weight 0.5, scale 0.01 for a 1.7 m character (ears must go RED, not white)
Masks: colour attribute `lip_mask` (white = lips) and `color_variation_mask` (black = no variation) are used
when present (Kenny vertex-paints them with Paint Mask + Ctrl X fill).

    python skin_shader.py -- --blend char.blend --objects GEO-body,GEO-head --tone 0.62,0.38,0.28 --out skin.blend
"""
import argparse
import os
import sys

import bpy


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--blend")
    p.add_argument("--objects", default="GEO-body,GEO-head")
    p.add_argument("--name", default="MAT-skin")
    p.add_argument("--tone", default="0.62,0.38,0.28", help="base skin colour, linear RGB (0.62,0.38,0.28 = light warm; 0.25,0.12,0.07 = deep)")
    p.add_argument("--coords", choices=["UV", "Object"], default=None, help="default: UV if the mesh has UVs")
    p.add_argument("--noise-scale", type=float)
    p.add_argument("--voronoi-scale", type=float)
    p.add_argument("--sss-weight", type=float, default=0.5)
    p.add_argument("--sss-scale", type=float, default=0.01)
    p.add_argument("--rim", type=float, default=0.5)
    p.add_argument("--bump", type=float, default=0.2)
    p.add_argument("--out")
    return p.parse_args(argv)


def ramp(nt, x, y, stops, interp="LINEAR"):
    r = nt.nodes.new("ShaderNodeValToRGB")
    r.location = (x, y)
    cr = r.color_ramp
    cr.interpolation = interp
    cr.elements[0].position, cr.elements[0].color = stops[0]
    cr.elements[1].position, cr.elements[1].color = stops[-1]
    for pos, col in stops[1:-1]:
        e = cr.elements.new(pos)
        e.color = col
    return r


def mix(nt, x, y, blend, fac=1.0):
    m = nt.nodes.new("ShaderNodeMix")
    m.data_type = "RGBA"
    m.blend_type = blend
    m.location = (x, y)
    m.inputs["Factor"].default_value = fac
    return m


def build(args, uv):
    mat = bpy.data.materials.get(args.name) or bpy.data.materials.new(args.name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    L = nt.links.new
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (1600, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (1300, 0)
    L(bsdf.outputs[0], out.inputs["Surface"])

    tone = [float(t) for t in args.tone.split(",")]
    base = nt.nodes.new("ShaderNodeRGB")
    base.location = (-900, 300)
    base.outputs[0].default_value = (*tone, 1)
    base_sock = base.outputs[0]

    coord = nt.nodes.new("ShaderNodeTexCoord")
    coord.location = (-1300, -200)
    vec = coord.outputs["UV" if uv else "Object"]
    ns = args.noise_scale or (250 if uv else 60)
    vs = args.voronoi_scale or (400 if uv else 150)

    # cavity: AO x pointiness, black tinted red (IEQ7IVPwwQk)
    ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
    ao.location = (-900, 0)
    ao_r = ramp(nt, -700, 0, [(0.0, (0.35, 0.08, 0.06, 1)), (0.6, (1, 1, 1, 1))])
    L(ao.outputs["AO"], ao_r.inputs[0])
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    geo.location = (-900, -250)
    pt_r = ramp(nt, -700, -250, [(0.45, (0.45, 0.12, 0.1, 1)), (0.53, (1, 1, 1, 1))])
    L(geo.outputs["Pointiness"], pt_r.inputs[0])
    cav = mix(nt, -450, -100, "MULTIPLY", 0.8)
    L(ao_r.outputs[0], cav.inputs["A"])
    L(pt_r.outputs[0], cav.inputs["B"])
    col = mix(nt, -250, 200, "MULTIPLY", 0.6)
    L(base_sock, col.inputs["A"])
    L(cav.outputs["Result"], col.inputs["B"])

    hsv = nt.nodes.new("ShaderNodeHueSaturation")
    hsv.location = (-250, 450)
    hsv.inputs["Saturation"].default_value = 1.25
    hsv.inputs["Value"].default_value = 0.82
    L(base_sock, hsv.inputs["Color"])

    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.location = (-700, -500)
    noise.inputs["Scale"].default_value = ns
    noise.inputs["Detail"].default_value = 4
    L(vec, noise.inputs["Vector"])
    n_r = ramp(nt, -450, -500, [(0.4, (0, 0, 0, 1)), (0.62, (1, 1, 1, 1))])
    L(noise.outputs["Fac"], n_r.inputs[0])
    var1 = mix(nt, 0, 250, "MIX", 1.0)
    var1.clamp_factor = True
    L(col.outputs["Result"], var1.inputs["A"])
    L(hsv.outputs[0], var1.inputs["B"])
    fac1 = nt.nodes.new("ShaderNodeMath")
    fac1.operation = "MULTIPLY"
    fac1.location = (-200, -450)
    fac1.inputs[1].default_value = 0.35
    L(n_r.outputs[0], fac1.inputs[0])

    vor = nt.nodes.new("ShaderNodeTexVoronoi")
    vor.location = (-700, -800)
    vor.feature = "SMOOTH_F1"
    vor.inputs["Scale"].default_value = vs
    L(vec, vor.inputs["Vector"])
    v_r = ramp(nt, -450, -800, [(0.0, (1, 1, 1, 1)), (0.25, (0, 0, 0, 1))])
    L(vor.outputs["Distance"], v_r.inputs[0])
    var2 = mix(nt, 250, 250, "MIX", 1.0)
    L(var1.outputs["Result"], var2.inputs["A"])
    L(hsv.outputs[0], var2.inputs["B"])
    fac2 = nt.nodes.new("ShaderNodeMath")
    fac2.operation = "MULTIPLY"
    fac2.location = (-200, -750)
    fac2.inputs[1].default_value = 0.3
    L(v_r.outputs[0], fac2.inputs[0])

    # colour_variation_mask (black = none) scales both variation factors
    cvm = nt.nodes.new("ShaderNodeVertexColor")
    cvm.location = (-450, -1050)
    cvm.layer_name = "color_variation_mask"
    has_mask = any(o.data.color_attributes.get("color_variation_mask") for o in TARGETS)
    for f, m in ((fac1, var1), (fac2, var2)):
        if has_mask:
            mm = nt.nodes.new("ShaderNodeMath")
            mm.operation = "MULTIPLY"
            mm.location = (f.location.x + 150, f.location.y)
            L(f.outputs[0], mm.inputs[0])
            L(cvm.outputs["Color"], mm.inputs[1])
            L(mm.outputs[0], m.inputs["Factor"])
        else:
            L(f.outputs[0], m.inputs["Factor"])

    # rim LAST: Layer Weight Facing -> B-Spline ramp flipped -> Soft Light
    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.location = (250, 600)
    lw.inputs["Blend"].default_value = 0.3
    # centre stays NEUTRAL grey (Soft Light with 0.5 grey changes nothing, so the bake, which has no view
    # direction, is not washed out); grazing angles go warm red = Kenny's "vibrant falloff"
    lw_r = ramp(nt, 450, 600, [(0.0, (0.5, 0.5, 0.5, 1)), (1.0, (0.85, 0.22, 0.16, 1))], "B_SPLINE")
    L(lw.outputs["Facing"], lw_r.inputs[0])
    rim = mix(nt, 700, 300, "SOFT_LIGHT", args.rim)
    L(var2.outputs["Result"], rim.inputs["A"])
    L(lw_r.outputs[0], rim.inputs["B"])
    L(rim.outputs["Result"], bsdf.inputs["Base Color"])
    rim.label = "FINAL COLOUR"

    # roughness from the same noise, never fully glossy or matte; lips glossier
    r_r = ramp(nt, 300, -400, [(0.0, (0.35, 0.35, 0.35, 1)), (1.0, (0.6, 0.6, 0.6, 1))])
    L(noise.outputs["Fac"], r_r.inputs[0])
    rough_sock = r_r.outputs[0]
    has_lip = any(o.data.color_attributes.get("lip_mask") for o in TARGETS)
    lip = nt.nodes.new("ShaderNodeVertexColor")
    lip.layer_name = "lip_mask"
    lip.location = (300, -650)
    if has_lip:
        lm = mix(nt, 550, -400, "MIX")
        L(lip.outputs["Color"], lm.inputs["Factor"])
        L(rough_sock, lm.inputs["A"])
        lm.inputs["B"].default_value = (0.25, 0.25, 0.25, 1)
        rough_sock = lm.outputs["Result"]
    L(rough_sock, bsdf.inputs["Roughness"])

    bump = nt.nodes.new("ShaderNodeBump")
    bump.location = (900, -500)
    bump.inputs["Strength"].default_value = args.bump
    bump.inputs["Distance"].default_value = 0.002
    L(n_r.outputs[0], bump.inputs["Height"])
    L(bump.outputs["Normal"], bsdf.inputs["Normal"])

    bsdf.subsurface_method = "RANDOM_WALK_SKIN"
    bsdf.inputs["Subsurface Weight"].default_value = args.sss_weight
    bsdf.inputs["Subsurface Scale"].default_value = args.sss_scale
    bsdf.inputs["Subsurface Radius"].default_value = (1.0, 0.2, 0.1)
    bsdf.inputs["Specular IOR Level"].default_value = 0.35
    return mat


TARGETS = []


def main():
    args = parse()
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.blend))
    TARGETS[:] = [bpy.data.objects[n] for n in args.objects.split(",") if n in bpy.data.objects]
    uv = args.coords == "UV" if args.coords else all(o.data.uv_layers for o in TARGETS)
    mat = build(args, uv)
    for o in TARGETS:
        o.data.materials.clear()
        o.data.materials.append(mat)
    print(f"{mat.name} on {[o.name for o in TARGETS]} ({'UV' if uv else 'Object'} coords)")
    if args.out:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.out))


if __name__ == "__main__":
    main()
