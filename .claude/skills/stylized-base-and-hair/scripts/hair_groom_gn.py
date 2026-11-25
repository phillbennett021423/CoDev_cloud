"""Kenny Praise's procedural hair (zV4tnpVhadM, masterclass ch. 10) built by script: scalp + GN hair stack.

Kenny's order is always: guides -> interpolate -> clump -> noise. This script makes:
  1. a SCALP mesh: the head's faces above the hairline, duplicated and cleaned (no modifiers, shape keys,
     vertex groups or materials), with a UV map. The UV is mandatory: Generate/Interpolate need it.
  2. an Empty Hair curves object on that scalp, with a Geometry Nodes modifier that chains the Essentials hair
     node groups with Kenny's numbers (preset curly | straight | short | brows).
  3. a hair material: Principled Hair BSDF (Cycles), root-to-tip darkening by Intercept, per-strand Random.

    python hair_groom_gn.py -- --blend char.blend --head GEO-head --preset curly --out char_hair.blend
    blender -b char.blend -P hair_groom_gn.py -- --head GEO-head --preset straight --save

Hairline: by default the faces above --hairline-z (fraction of the head height, from the chin) and behind
--front-y (fraction of the head depth, from the face). For a real character, paint a vertex group "scalp" on
the head and pass --group scalp (Kenny selects or draws the hairline with an annotation).
Values are in metres for a 1.6 to 1.8 m character, like Kenny's scenes. Scale them with --scale for other sizes.
"""
import argparse
import os
import sys

import bpy
import bmesh
from mathutils import Vector

ASSETS = os.path.join(bpy.utils.system_resource("DATAFILES"), "assets", "nodes", "procedural_hair_node_assets.blend")
NEEDED = ["Generate Hair Curves", "Interpolate Hair Curves", "Set Hair Curve Profile", "Curl Hair Curves",
          "Clump Hair Curves", "Hair Curves Noise", "Trim Hair Curves", "Frizz Hair Curves"]

# Kenny's numbers. density = guides per m^2 of scalp in Generate; child = Interpolate density.
AMOUNT = [0.1]  # Interpolate viewport amount; --amount 1 for QA/final renders from the viewport depsgraph

PRESETS = {
    # zV4tnpVhadM: curly hair, no grooming at all
    "curly": dict(guides=800, length=0.06, points=12, radius=0.001, child=100000,
                  curl1=dict(radius=0.01, frequency=3.0, guide_distance=0.0),
                  curl2=dict(radius=0.01, frequency=3.0, guide_distance=0.015),
                  clump1=dict(guide_distance=0.015, factor=0.7), clump2=dict(guide_distance=0.05, factor=1.0),
                  noise=dict(scale_along=20, scale=5, offset_per_curve=0.2, distance=0.01, ramp_black=0.4)),
    # big rounded afro: the curly recipe with long strands standing out along the normal (volume ~1.6x head)
    "afro": dict(guides=1000, length=0.13, points=16, radius=0.0012, child=120000,
                 curl1=dict(radius=0.012, frequency=4.0, guide_distance=0.0),
                 curl2=dict(radius=0.008, frequency=6.0, guide_distance=0.02),
                 clump1=dict(guide_distance=0.02, factor=0.6), clump2=dict(guide_distance=0.06, factor=0.8),
                 noise=dict(scale_along=12, scale=4, offset_per_curve=0.3, distance=0.015, ramp_black=0.3)),
    # masterclass: straight shoulder-length; clump 0.04 / 0.02, noise only on a subset
    "straight": dict(guides=600, length=0.22, points=24, radius=0.0008, child=80000, curl1=None, curl2=None,
                     clump1=dict(guide_distance=0.04, factor=0.8), clump2=dict(guide_distance=0.02, factor=0.6),
                     noise=dict(scale_along=8, scale=3, offset_per_curve=0.2, distance=0.006, ramp_black=0.5)),
    "short": dict(guides=1500, length=0.035, points=8, radius=0.0008, child=60000, curl1=None, curl2=None,
                  clump1=dict(guide_distance=0.01, factor=0.6), clump2=None,
                  noise=dict(scale_along=30, scale=6, offset_per_curve=0.3, distance=0.004, ramp_black=0.4)),
    # C284k-WJDF8: brows. Brush length 0.01, interpolate 100k-1M masked, small clump
    "brows": dict(guides=3000, length=0.012, points=8, radius=0.0004, child=200000, curl1=None, curl2=None,
                  clump1=dict(guide_distance=0.002, factor=0.5), clump2=None, noise=None),
}


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--blend")
    p.add_argument("--head", required=True)
    p.add_argument("--preset", default="curly", choices=sorted(PRESETS))
    p.add_argument("--group", help="vertex group on the head that marks the scalp")
    p.add_argument("--hairline-z", type=float, default=0.72, help="forehead hairline, fraction of head height above the chin")
    p.add_argument("--front-y", type=float, default=0.12, help="fraction of head depth from the face that stays bald")
    p.add_argument("--offset", type=float, default=0.0005, help="push the scalp off the head (m)")
    p.add_argument("--scale", type=float, default=1.0)
    p.add_argument("--amount", type=float, default=0.1, help="viewport child amount (1.0 for QA and final renders)")
    p.add_argument("--color", default="0.05,0.03,0.02", help="EEVEE root colour, linear RGB")
    p.add_argument("--melanin", type=float, default=0.85, help="Cycles: 0.1 blond, 0.5 brown, 0.85 dark, 1 black")
    p.add_argument("--redness", type=float, default=0.3)
    p.add_argument("--out")
    p.add_argument("--save", action="store_true")
    return p.parse_args(argv)


def load_groups():
    have = [n for n in NEEDED if n in bpy.data.node_groups]
    with bpy.data.libraries.load(ASSETS, link=False) as (src, dst):
        dst.node_groups = [n for n in NEEDED if n not in have and n in src.node_groups]
    return {n: bpy.data.node_groups[n] for n in NEEDED}


def make_scalp(head, args):
    me = head.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    mw = head.matrix_world
    zs = [(mw @ v.co).z for v in bm.verts]
    ys = [(mw @ v.co).y for v in bm.verts]
    zmin, zmax, ymin, ymax = min(zs), max(zs), min(ys), max(ys)
    keep = set()
    if args.group and args.group in head.vertex_groups:
        gi = head.vertex_groups[args.group].index
        dl = bm.verts.layers.deform.active
        for v in bm.verts:
            if dl and v[dl].get(gi, 0) > 0.5:
                keep.add(v.index)
    else:
        # Kenny draws the hairline: high on the forehead, down past the temples to above the ears, low at the nape
        hh = zmax - zmin
        for v in bm.verts:
            w = mw @ v.co
            t = (w.y - ymin) / max(ymax - ymin, 1e-6)       # 0 = face, 1 = back of the head
            if t < args.front_y:
                continue                                  # the face itself stays bald
            hz = zmin + hh * (args.hairline_z - 0.40 * min(1.0, max(0.0, (t - 0.2) / 0.8)) ** 1.2)
            if w.z >= hz:
                keep.add(v.index)
    for f in list(bm.faces):
        if not all(v.index in keep for v in f.verts):
            bm.faces.remove(f)
    for v in list(bm.verts):
        if not v.link_faces:
            bm.verts.remove(v)
    for v in bm.verts:
        v.co += v.normal * args.offset
    smesh = bpy.data.meshes.new("GEO-scalp")
    bm.to_mesh(smesh)
    bm.free()
    scalp = bpy.data.objects.new("GEO-scalp", smesh)
    scalp.matrix_world = head.matrix_world.copy()
    for c in head.users_collection:
        c.objects.link(scalp)
    # UV map (Kenny: U > Unwrap, scale down, pin)
    bpy.ops.object.select_all(action="DESELECT")
    scalp.select_set(True)
    bpy.context.view_layer.objects.active = scalp
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.unwrap(method="ANGLE_BASED", margin=0.01)
    bpy.ops.object.mode_set(mode="OBJECT")
    scalp.hide_render = True  # the scalp only emits; the head shows underneath
    return scalp


def hair_material(args):
    """Cycles Principled Hair, melanin model (Kenny: Hair BSDF on the Cycles output, root darker than tip).
    For EEVEE/game previews a Principled BSDF with an Intercept gradient is added on the EEVEE output."""
    m = bpy.data.materials.new("MAT-hair")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out_c = nt.nodes.new("ShaderNodeOutputMaterial")
    out_c.target = "CYCLES"
    out_e = nt.nodes.new("ShaderNodeOutputMaterial")
    out_e.target = "EEVEE"
    hb = nt.nodes.new("ShaderNodeBsdfHairPrincipled")
    hb.parametrization = "MELANIN"
    hb.inputs["Melanin"].default_value = args.melanin
    hb.inputs["Melanin Redness"].default_value = args.redness
    hb.inputs["Roughness"].default_value = 0.35
    hb.inputs["Radial Roughness"].default_value = 0.5
    if "Random Color" in hb.inputs:
        hb.inputs["Random Color"].default_value = 0.1
    nt.links.new(hb.outputs[0], out_c.inputs["Surface"])
    # EEVEE output: Principled BSDF, Intercept ramp (root dark -> tip lighter) multiplied by per-strand Random
    pb = nt.nodes.new("ShaderNodeBsdfPrincipled")
    info = nt.nodes.new("ShaderNodeHairInfo")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    r = [float(x) for x in args.color.split(",")]
    ramp.color_ramp.elements[0].color = (*r, 1)
    ramp.color_ramp.elements[1].color = (min(1, r[0] * 2.5), min(1, r[1] * 2.5), min(1, r[2] * 2.5), 1)
    nt.links.new(info.outputs["Intercept"], ramp.inputs["Fac"])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 0.25
    nt.links.new(ramp.outputs["Color"], mix.inputs["A"])
    nt.links.new(info.outputs["Random"], mix.inputs["B"])
    nt.links.new(mix.outputs["Result"], pb.inputs["Base Color"])
    pb.inputs["Roughness"].default_value = 0.45
    nt.links.new(pb.outputs[0], out_e.inputs["Surface"])
    return m


def build_tree(groups, scalp, preset, s, mat):
    nt = bpy.data.node_groups.new("GN-hair", "GeometryNodeTree")
    nt.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    nt.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    gi = nt.nodes.new("NodeGroupInput")
    go = nt.nodes.new("NodeGroupOutput")
    x = [0]

    def grp(name, **vals):
        n = nt.nodes.new("GeometryNodeGroup")
        n.node_tree = groups[name]
        n.location = (x[0], 0)
        x[0] += 260
        for k, v in vals.items():
            if k in n.inputs:
                n.inputs[k].default_value = v
        return n

    uv = nt.nodes.new("GeometryNodeInputNamedAttribute")
    uv.data_type = "FLOAT_VECTOR"
    uv.inputs["Name"].default_value = scalp.data.uv_layers.active.name

    gen = grp("Generate Hair Curves", **{"Hair Length": preset["length"] * s, "Control Points": preset["points"],
                                         "Density": preset["guides"], "Seed": 3})
    gen.inputs["Surface"].default_value = scalp
    nt.links.new(uv.outputs["Attribute"], gen.inputs["Surface UV Map"])
    nt.links.new(gi.outputs[0], gen.inputs["Hair Surface"]) if "Hair Surface" in gen.inputs else None
    last = gen.outputs["Curves"] if "Curves" in gen.outputs else gen.outputs[0]

    prof = grp("Set Hair Curve Profile", **{"Radius": preset["radius"] * s})
    nt.links.new(last, prof.inputs["Geometry"])
    last = prof.outputs["Geometry"]
    if preset.get("curl1"):
        c = preset["curl1"]
        n = grp("Curl Hair Curves", **{"Radius": c["radius"] * s, "Frequency": c["frequency"],
                                       "Guide Distance": c["guide_distance"] * s, "Existing Guide Map": False})
        nt.links.new(last, n.inputs["Geometry"])
        last = n.outputs["Geometry"]
    interp = grp("Interpolate Hair Curves", **{"Density": preset["child"], "Viewport Amount": AMOUNT[0],
                                               "Interpolation Guides": 4})
    nt.links.new(last, interp.inputs["Geometry"])
    last = interp.outputs["Geometry"]
    if preset.get("curl2"):
        c = preset["curl2"]
        n = grp("Curl Hair Curves", **{"Radius": c["radius"] * s, "Frequency": c["frequency"],
                                       "Guide Distance": c["guide_distance"] * s, "Existing Guide Map": False})
        nt.links.new(last, n.inputs["Geometry"])
        last = n.outputs["Geometry"]
    for key in ("clump2", "clump1"):  # Kenny drops the wider secondary clump in front of the primary
        c = preset.get(key)
        if not c:
            continue
        n = grp("Clump Hair Curves", **{"Guide Distance": c["guide_distance"] * s, "Factor": c["factor"],
                                        "Existing Guide Map": False})
        nt.links.new(last, n.inputs["Geometry"])
        last = n.outputs["Geometry"]
    if preset.get("noise"):
        c = preset["noise"]
        n = grp("Hair Curves Noise", **{"Cumulative Offset": False, "Scale along Curve": c["scale_along"],
                                        "Scale": c["scale"], "Offset per Curve": c["offset_per_curve"],
                                        "Distance": c["distance"] * s})
        # noise only on a random subset of curves: Random (per curve) -> ColorRamp black 0.4 -> Factor
        rnd = nt.nodes.new("FunctionNodeRandomValue")
        dom = nt.nodes.new("GeometryNodeFieldOnDomain")
        dom.domain = "CURVE"
        dom.data_type = "FLOAT"
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        ramp.color_ramp.elements[0].position = c["ramp_black"]
        nt.links.new(rnd.outputs["Value"], dom.inputs[0])
        nt.links.new(dom.outputs[0], ramp.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], n.inputs["Factor"])
        nt.links.new(last, n.inputs["Geometry"])
        last = n.outputs["Geometry"]
    sm = nt.nodes.new("GeometryNodeSetMaterial")
    sm.inputs["Material"].default_value = mat
    nt.links.new(last, sm.inputs["Geometry"])
    nt.links.new(sm.outputs[0], go.inputs[0])
    go.location = (x[0] + 200, 0)
    return nt


def main():
    args = parse()
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.blend))
    head = bpy.data.objects[args.head]
    preset = PRESETS[args.preset]
    AMOUNT[0] = args.amount
    groups = load_groups()
    scalp = make_scalp(head, args)
    cd = bpy.data.hair_curves.new("HAIR-" + args.preset)
    cd.surface = scalp
    cd.surface_uv_map = scalp.data.uv_layers.active.name
    hair = bpy.data.objects.new("HAIR-" + args.preset, cd)
    hair.parent = scalp
    for c in scalp.users_collection:
        c.objects.link(hair)
    mat = hair_material(args)
    cd.materials.append(mat)
    mod = hair.modifiers.new("hair", "NODES")
    mod.node_group = build_tree(groups, scalp, preset, args.scale, mat)
    # Kenny: Strip, not Strand, so the profile radius renders
    sc = bpy.context.scene
    if hasattr(sc.render, "hair_type"):
        sc.render.hair_type = "STRIP"
    dg = bpy.context.evaluated_depsgraph_get()
    ev = hair.evaluated_get(dg).data
    print(f"hair {args.preset}: {len(ev.curves)} curves (viewport amount {args.amount}), {len(ev.points)} points")
    if args.out:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.out))
    elif args.save:
        bpy.ops.wm.save_mainfile()


if __name__ == "__main__":
    main()
