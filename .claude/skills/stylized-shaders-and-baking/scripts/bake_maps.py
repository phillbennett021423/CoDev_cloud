"""Bake a stylized character's procedural/painted materials into ONE game texture set (Godot 4 / Roblox).

Kenny shades procedurally in Cycles (masterclass ch. 11). Engines can't run those node trees, so we bake them
into one atlas shared by every object passed in (they must share one non-overlapping UV layout: run
stylized-uv-unwrap first):
  color      DIFFUSE bake, colour pass only (= the Base Color input with every procedural node evaluated)
  roughness  ROUGHNESS bake                                    (Non-Color)
  normal     NORMAL bake, tangent space, OpenGL (+Y), includes Bump nodes (Non-Color). Godot = OpenGL.
             Roblox expects OpenGL too. Unreal would need the green channel flipped.
  ao         AO bake                                           (Non-Color)
  cavity     Kenny's pointiness bake: Pointiness -> ramp 0.45..0.55 -> Emission, EMIT bake (Non-Color)
  albedo     colour x lerp(1, cavity, 0.3) x lerp(1, ao, 0.5): Kenny multiplies pointiness at ~0.3
Then (--apply) every object gets ONE game material `MAT-<prefix>-baked` (albedo, roughness, normal), and the
result can go straight to the 4-view QA and to stylized-rig-and-export.

    python bake_maps.py -- --blend char_uv.blend --objects GEO-body,GEO-head,GEO-shirt --size 1024 \
        --out-dir textures --prefix hero --apply --out char_baked.blend
"""
import argparse
import os
import sys

import bpy
import numpy as np

NONCOLOR = {"roughness", "normal", "ao", "cavity"}


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--blend")
    p.add_argument("--objects", required=True)
    p.add_argument("--size", type=int, default=1024, help="1024 Roblox / Godot low, 2048 Godot hero")
    p.add_argument("--maps", default="color,roughness,normal,ao,cavity")
    p.add_argument("--samples", type=int, default=32)
    p.add_argument("--margin", type=int, default=None,
                   help="bleed in px; default = half the UV island gap (--uv-margin x size / 2). A bigger bleed "
                        "paints one object's colour into its neighbour's islands (QA caught exactly that)")
    p.add_argument("--uv-margin", type=float, default=0.008, help="the island margin uv_unwrap packed with")
    p.add_argument("--out-dir", default="textures")
    p.add_argument("--prefix", default="char")
    p.add_argument("--apply", action="store_true", help="replace the materials with the baked game material")
    p.add_argument("--out")
    return p.parse_args(argv)


def new_image(name, size, noncolor):
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=False)
    img.colorspace_settings.name = "Non-Color" if noncolor else "sRGB"
    return img


def target_node(mat, img):
    nt = mat.node_tree
    n = nt.nodes.get("BAKE_TARGET") or nt.nodes.new("ShaderNodeTexImage")
    n.name = "BAKE_TARGET"
    n.image = img
    n.location = (-1600, 600)
    for o in nt.nodes:
        o.select = False
    n.select = True
    nt.nodes.active = n


def materials_of(objs):
    mats = []
    for o in objs:
        if not o.data.materials:
            m = bpy.data.materials.new("MAT-" + o.name)
            m.use_nodes = True
            o.data.materials.append(m)
        for m in o.data.materials:
            if m and m not in mats:
                m.use_nodes = True
                mats.append(m)
    return mats


def bake(objs, kind, img, args):
    for m in materials_of(objs):
        target_node(m, img)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    sc = bpy.context.scene
    b = sc.render.bake
    b.margin = args.margin
    b.use_clear = True
    b.use_selected_to_active = False
    if kind == "color":
        b.use_pass_direct = False
        b.use_pass_indirect = False
        b.use_pass_color = True
        bpy.ops.object.bake(type="DIFFUSE", pass_filter={"COLOR"})
    elif kind == "roughness":
        bpy.ops.object.bake(type="ROUGHNESS")
    elif kind == "normal":
        b.normal_space = "TANGENT"
        b.normal_r, b.normal_g, b.normal_b = "POS_X", "POS_Y", "POS_Z"
        bpy.ops.object.bake(type="NORMAL")
    elif kind == "ao":
        bpy.ops.object.bake(type="AO")
    elif kind == "cavity":
        # swap every material's output to Pointiness -> ramp -> Emission, bake EMIT, then restore
        saved = []
        for m in materials_of(objs):
            nt = m.node_tree
            outn = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output)
            old = outn.inputs["Surface"].links[0].from_socket if outn.inputs["Surface"].links else None
            g = nt.nodes.new("ShaderNodeNewGeometry")
            r = nt.nodes.new("ShaderNodeValToRGB")
            r.color_ramp.elements[0].position = 0.45
            r.color_ramp.elements[1].position = 0.53
            e = nt.nodes.new("ShaderNodeEmission")
            nt.links.new(g.outputs["Pointiness"], r.inputs[0])
            nt.links.new(r.outputs[0], e.inputs[0])
            nt.links.new(e.outputs[0], outn.inputs["Surface"])
            saved.append((nt, outn, old, (g, r, e)))
        bpy.ops.object.bake(type="EMIT")
        for nt, outn, old, tmp in saved:
            for n in tmp:
                nt.nodes.remove(n)
            if old:
                nt.links.new(old, outn.inputs["Surface"])
    img.filepath_raw = os.path.join(os.path.abspath(args.out_dir), f"{args.prefix}_{kind}.png")
    img.file_format = "PNG"
    img.save()
    print(f"baked {kind} -> {img.filepath_raw}")


def px(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


def main():
    args = parse()
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.blend))
    os.makedirs(args.out_dir, exist_ok=True)
    objs = [bpy.data.objects[n] for n in args.objects.split(",")]
    for o in objs:
        if not o.data.uv_layers:
            raise SystemExit(f"{o.name} has no UVs: run stylized-uv-unwrap first")
    if args.margin is None:
        args.margin = max(1, int(args.uv_margin * args.size / 2))
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = args.samples
    imgs = {}
    for kind in [k for k in args.maps.split(",") if k]:
        imgs[kind] = new_image(f"{args.prefix}_{kind}", args.size, kind in NONCOLOR)
        bake(objs, kind, imgs[kind], args)

    # albedo = colour x cavity (0.3) x AO (0.5), Kenny's multiply amounts
    if "color" in imgs:
        c = px(imgs["color"])
        alb = c.copy()
        if "cavity" in imgs:
            cv = px(imgs["cavity"])[..., :3]
            alb[..., :3] *= 1 - 0.3 * (1 - cv)
        if "ao" in imgs:
            ao = px(imgs["ao"])[..., :3]
            alb[..., :3] *= 1 - 0.5 * (1 - ao)
        a = new_image(f"{args.prefix}_albedo", args.size, False)
        a.pixels.foreach_set(alb.ravel())
        a.filepath_raw = os.path.join(os.path.abspath(args.out_dir), f"{args.prefix}_albedo.png")
        a.file_format = "PNG"
        a.save()
        imgs["albedo"] = a
        print(f"albedo -> {a.filepath_raw}")

    if args.apply:
        mat = bpy.data.materials.new(f"MAT-{args.prefix}-baked")
        mat.use_nodes = True
        nt = mat.node_tree
        bsdf = nt.nodes["Principled BSDF"]
        y = 300
        for kind, sock in (("albedo", "Base Color"), ("roughness", "Roughness"), ("normal", None)):
            if kind not in imgs:
                continue
            t = nt.nodes.new("ShaderNodeTexImage")
            t.image = imgs[kind]
            t.location = (-700, y)
            y -= 300
            if sock:
                nt.links.new(t.outputs["Color"], bsdf.inputs[sock])
            else:
                nm = nt.nodes.new("ShaderNodeNormalMap")
                nm.location = (-300, y + 300)
                nt.links.new(t.outputs["Color"], nm.inputs["Color"])
                nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
        for img in imgs.values():
            img.pack()
        for o in objs:
            o.data.materials.clear()
            o.data.materials.append(mat)
        print(f"applied {mat.name} to {len(objs)} objects")
    if args.out:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.out))


if __name__ == "__main__":
    main()
