"""CoDev's 3D asset pipeline, run inside Blender in the background:

    blender --background --factory-startup --python asset_pipeline.py -- <job.json>

job.json: {"op": ..., "input": path, "output": path, "result": path, ...}. The result
file gets a JSON report (triangle counts, maps written, bones matched...). Ops:

  inspect    triangles, vertices, materials, UV maps, armature, size
  cleanup    merge doubles, drop loose parts, fix normals, optional voxel remesh,
             decimate to a triangle budget, smooth shading; exports .glb
  uv         Smart UV Project and island packing; exports .glb
  bake       bakes PBR maps (albedo, normal, roughness, metallic, emission, ao,
             curvature) onto the low-poly, from a high-poly when given; rebuilds
             the material from the maps and exports .glb
  rig        puts a cosmetic mesh on a base character's skeleton: copies the skin
             weights from the base body (or Blender's automatic weights) and
             parents it to the armature; exports .glb with the skeleton
  retarget   copies the animations of one skeleton onto another by bone names
             (Mixamo, Rigify, UE and generic names are matched), baking them into
             actions the .glb carries
"""
import bpy
import bmesh
import json
import math
import os
import re
import sys

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
JOB = json.load(open(argv[0], encoding="utf-8"))
REPORT = {"ok": True, "op": JOB.get("op")}


def done():
    with open(JOB["result"], "w", encoding="utf-8") as f:
        json.dump(REPORT, f)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.armatures, bpy.data.actions):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def import_any(path):
    before = set(bpy.data.objects)
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        if hasattr(bpy.ops.wm, "obj_import"):
            bpy.ops.wm.obj_import(filepath=path)
        else:
            bpy.ops.import_scene.obj(filepath=path)
    elif ext == ".stl":
        if hasattr(bpy.ops.wm, "stl_import"):
            bpy.ops.wm.stl_import(filepath=path)
        else:
            bpy.ops.import_mesh.stl(filepath=path)
    elif ext == ".blend":
        with bpy.data.libraries.load(path) as (src, dst):
            dst.objects = src.objects
        for ob in dst.objects:
            if ob:
                bpy.context.scene.collection.objects.link(ob)
    else:
        raise ValueError(f"can't import {ext} files")
    return [o for o in bpy.data.objects if o not in before]


def meshes(objs):
    return [o for o in objs if o.type == "MESH"]


def tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def stats(objs):
    ms = meshes(objs)
    arm = [o for o in objs if o.type == "ARMATURE"]
    dims = [0, 0, 0]
    if ms:
        pts = [o.matrix_world @ v.co for o in ms for v in o.data.vertices]
        if pts:
            dims = [round(max(p[i] for p in pts) - min(p[i] for p in pts), 4) for i in range(3)]
    return {
        "meshes": [{"name": o.name, "tris": tris(o), "verts": len(o.data.vertices), "materials": len(o.data.materials),
                    "uv_maps": [uv.name for uv in o.data.uv_layers]} for o in ms],
        "triangles": sum(tris(o) for o in ms),
        "materials": len({m.name for o in ms for m in o.data.materials if m}),
        "armatures": [{"name": a.name, "bones": len(a.data.bones)} for a in arm],
        "animations": [a.name for a in bpy.data.actions],
        "size_m": dims,
    }


def activate(ob):
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob


def export(path, objs=None):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    ext = os.path.splitext(path)[1].lower()
    if objs is not None:
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.select_set(True)
    sel = objs is not None
    if ext in (".glb", ".gltf"):
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB" if ext == ".glb" else "GLTF_SEPARATE",
                                  use_selection=sel, export_apply=True, export_animations=True)
    elif ext == ".fbx":
        bpy.ops.export_scene.fbx(filepath=path, use_selection=sel, apply_scale_options="FBX_SCALE_ALL", bake_anim=True)
    elif ext == ".obj":
        bpy.ops.wm.obj_export(filepath=path, export_selected_objects=sel)
    elif ext == ".blend":
        bpy.ops.wm.save_as_mainfile(filepath=path)
    else:
        raise ValueError(f"can't export {ext}")
    REPORT["output"] = path


# ---------- cleanup / remesh ----------

def op_cleanup():
    objs = import_any(JOB["input"])
    ms = meshes(objs)
    before = sum(tris(o) for o in ms)
    target = int(JOB.get("target_tris") or 0)
    for ob in ms:
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=float(JOB.get("merge_distance", 0.0001)))
        loose = [v for v in bm.verts if not v.link_edges]
        bmesh.ops.delete(bm, geom=loose, context="VERTS")
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(ob.data)
        bm.free()
        if JOB.get("remesh"):
            # Voxel remesh rebuilds messy AI meshes into one watertight surface.
            activate(ob)
            mod = ob.modifiers.new("Remesh", "REMESH")
            mod.mode = "VOXEL"
            size = max(ob.dimensions) or 1
            mod.voxel_size = size / float(JOB.get("remesh_resolution", 256))
            mod.use_smooth_shade = True
            bpy.ops.object.modifier_apply(modifier=mod.name)
    total = sum(tris(o) for o in ms)
    if target and total > target:
        for ob in ms:
            share = tris(ob) / max(total, 1)
            want = max(12, int(target * share))
            ratio = min(1.0, want / max(tris(ob), 1))
            activate(ob)
            mod = ob.modifiers.new("Decimate", "DECIMATE")
            mod.decimate_type = "COLLAPSE"
            mod.ratio = ratio
            mod.use_collapse_triangulate = True
            bpy.ops.object.modifier_apply(modifier=mod.name)
    for ob in ms:
        activate(ob)
        try:
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(float(JOB.get("smooth_angle", 40))))
        except Exception:
            bpy.ops.object.shade_smooth()
            if hasattr(ob.data, "use_auto_smooth"):
                ob.data.use_auto_smooth = True
                ob.data.auto_smooth_angle = math.radians(float(JOB.get("smooth_angle", 40)))
    REPORT["before_triangles"] = before
    REPORT.update(stats(objs))
    export(JOB["output"], objs)


# ---------- UVs ----------

def unwrap(ob, margin=0.01):
    activate(ob)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(float(JOB.get("angle_limit", 66))), island_margin=margin)
    try:
        bpy.ops.uv.pack_islands(margin=margin, rotate=True)
    except TypeError:
        bpy.ops.uv.pack_islands(margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")


def op_uv():
    objs = import_any(JOB["input"])
    for ob in meshes(objs):
        if JOB.get("keep_existing") and ob.data.uv_layers:
            continue
        if not ob.data.uv_layers:
            ob.data.uv_layers.new(name="UVMap")
        unwrap(ob, float(JOB.get("margin", 0.01)))
    REPORT.update(stats(objs))
    export(JOB["output"], objs)


# ---------- PBR baking ----------

def bake_image(name, size, non_color):
    img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=False)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    return img


def set_target(mats, img):
    for mat in mats:
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        node = nodes.get("CoDevBake") or nodes.new("ShaderNodeTexImage")
        node.name = "CoDevBake"
        node.image = img
        nodes.active = node


def principled(mat):
    return next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)


def socket(bsdf, *names):
    for n in names:
        if n in bsdf.inputs:
            return bsdf.inputs[n]
    return None


def bake_value_as_emission(mats, input_names, run):
    """Metallic (and the like) have no bake pass: route it to emission and bake that."""
    saved = []
    for mat in mats:
        bsdf = principled(mat)
        out = next((n for n in mat.node_tree.nodes if n.type == "OUTPUT_MATERIAL"), None)
        if not bsdf or not out:
            continue
        src = socket(bsdf, *input_names)
        emit = mat.node_tree.nodes.new("ShaderNodeEmission")
        links = mat.node_tree.links
        if src and src.is_linked:
            links.new(src.links[0].from_socket, emit.inputs["Color"])
        else:
            v = src.default_value if src else 0.0
            emit.inputs["Color"].default_value = tuple(v) if hasattr(v, "__len__") else (v, v, v, 1)
        old = out.inputs["Surface"].links[0].from_socket if out.inputs["Surface"].is_linked else None
        links.new(emit.outputs["Emission"], out.inputs["Surface"])
        saved.append((mat, out, old, emit))
    run("EMIT")
    for mat, out, old, emit in saved:
        if old:
            mat.node_tree.links.new(old, out.inputs["Surface"])
        mat.node_tree.nodes.remove(emit)


def curvature_material():
    mat = bpy.data.materials.new("CoDevCurvature")
    mat.use_nodes = True
    nt = mat.node_tree
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.45
    ramp.color_ramp.elements[1].position = 0.55
    emit = nt.nodes.new("ShaderNodeEmission")
    out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    nt.links.new(geo.outputs["Pointiness"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], emit.inputs["Color"])
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    return mat


def op_bake():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = int(JOB.get("samples", 16))
    try:
        scene.cycles.device = "GPU" if JOB.get("gpu", True) else "CPU"
    except Exception:
        pass
    low_objs = import_any(JOB["input"])
    low = meshes(low_objs)
    if not low:
        raise ValueError("no mesh in the input")
    high = meshes(import_any(JOB["high_poly"])) if JOB.get("high_poly") else []
    if len(low) > 1:
        activate(low[0])
        for o in low[1:]:
            o.select_set(True)
        bpy.ops.object.join()
        low = [bpy.context.view_layer.objects.active]
    target = low[0]
    if not target.data.uv_layers:
        target.data.uv_layers.new(name="UVMap")
        unwrap(target)
    if not target.data.materials:
        target.data.materials.append(bpy.data.materials.new("CoDevBase"))
    mats = [m for m in target.data.materials if m]
    for m in mats:
        m.use_nodes = True
    size = int(JOB.get("size", 1024))
    maps = JOB.get("maps") or ["albedo", "normal", "roughness", "metallic", "emission", "ao", "curvature"]
    out_dir, name = JOB["out_dir"], JOB.get("name", target.name)
    os.makedirs(out_dir, exist_ok=True)
    from_high = bool(high)
    extrusion = float(JOB.get("cage_extrusion", 0.02))
    if from_high:
        # Bake from the high-poly's own materials onto the low-poly.
        for h in high:
            for m in h.data.materials:
                if m:
                    m.use_nodes = True

    def run(kind, pass_filter=None):
        bpy.ops.object.select_all(action="DESELECT")
        for h in high:
            h.select_set(True)
        target.select_set(True)
        bpy.context.view_layer.objects.active = target
        kw = dict(type=kind, use_selected_to_active=from_high, margin=int(JOB.get("margin_px", 8)))
        if from_high:
            kw["cage_extrusion"] = extrusion
        if pass_filter:
            kw["pass_filter"] = pass_filter
        bpy.ops.object.bake(**kw)

    written = {}
    source_mats = [m for h in high for m in h.data.materials if m] if from_high else mats
    for kind in maps:
        non_color = kind not in ("albedo", "emission")
        img = bake_image(f"{name}_{kind}", size, non_color)
        set_target(mats, img)
        if kind == "albedo":
            # The diffuse pass darkens metals (it leaves out the metallic share), so
            # bake the base colour itself through emission.
            bake_value_as_emission(source_mats, ("Base Color",), lambda k: run(k))
        elif kind == "normal":
            run("NORMAL")
        elif kind == "roughness":
            run("ROUGHNESS")
        elif kind == "emission":
            run("EMIT")
        elif kind == "ao":
            run("AO")
        elif kind == "metallic":
            bake_value_as_emission(source_mats, ("Metallic",), lambda k: run(k))
        elif kind == "curvature":
            # Pointiness is per-vertex on the mesh being baked, so bake it from the low-poly itself.
            curv = curvature_material()
            keep = [(slot, slot.material) for slot in target.material_slots]
            for slot in target.material_slots:
                slot.material = curv
            set_target([curv], img)
            saved_high, saved_from = list(high), from_high
            high.clear()
            from_high = False
            run("EMIT")
            high.extend(saved_high)
            from_high = saved_from
            for slot, m in keep:
                slot.material = m
        else:
            continue
        path = os.path.join(out_dir, f"{name}_{kind}.png")
        img.filepath_raw = path
        img.file_format = "PNG"
        img.save()
        written[kind] = path
    # One clean material from the baked maps, ready for Godot.
    mat = bpy.data.materials.new(f"{name}_mat")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = principled(mat)

    def tex(kind, non_color):
        if kind not in written:
            return None
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = bpy.data.images.load(written[kind])
        if non_color:
            n.image.colorspace_settings.name = "Non-Color"
        return n
    t = tex("albedo", False)
    if t:
        nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    t = tex("roughness", True)
    if t:
        nt.links.new(t.outputs["Color"], bsdf.inputs["Roughness"])
    t = tex("metallic", True)
    if t:
        nt.links.new(t.outputs["Color"], bsdf.inputs["Metallic"])
    t = tex("normal", True)
    if t:
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    t = tex("emission", False)
    es = socket(bsdf, "Emission Color", "Emission")
    if t and es:
        nt.links.new(t.outputs["Color"], es)
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = 1.0
    target.data.materials.clear()
    target.data.materials.append(mat)
    for h in high:
        bpy.data.objects.remove(h, do_unlink=True)
    REPORT["maps"] = written
    REPORT.update(stats([target]))
    if JOB.get("output"):
        export(JOB["output"], [target])


# ---------- rigging ----------

def op_rig():
    base = import_any(JOB["base"])
    arm = next((o for o in base if o.type == "ARMATURE"), None)
    if not arm:
        raise ValueError("the base character has no skeleton (armature)")
    body = [o for o in meshes(base) if any(m.type == "ARMATURE" for m in o.modifiers) or o.parent == arm]
    cosmetic = meshes(import_any(JOB["input"]))
    if not cosmetic:
        raise ValueError("no mesh in the cosmetic file")
    method = JOB.get("method") or ("transfer" if body else "auto")
    for ob in cosmetic:
        for vg in list(ob.vertex_groups):
            ob.vertex_groups.remove(vg)
        if method == "transfer" and body:
            src = max(body, key=lambda o: len(o.data.vertices))
            activate(ob)
            mod = ob.modifiers.new("WeightCopy", "DATA_TRANSFER")
            mod.object = src
            mod.use_vert_data = True
            mod.data_types_verts = {"VGROUP_WEIGHTS"}
            mod.vert_mapping = "POLYINTERP_NEAREST"
            mod.layers_vgroup_select_src = "ALL"
            mod.layers_vgroup_select_dst = "NAME"
            bpy.ops.object.datalayout_transfer(modifier=mod.name)
            bpy.ops.object.modifier_apply(modifier=mod.name)
            ob.parent = arm
            ob.matrix_parent_inverse = arm.matrix_world.inverted()
            am = ob.modifiers.new("Armature", "ARMATURE")
            am.object = arm
        else:
            bpy.ops.object.select_all(action="DESELECT")
            ob.select_set(True)
            arm.select_set(True)
            bpy.context.view_layer.objects.active = arm
            bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    keep = [arm] + cosmetic + (body if JOB.get("keep_body") else [])
    if not JOB.get("keep_body"):
        for o in body:
            bpy.data.objects.remove(o, do_unlink=True)
    REPORT["method"] = method
    REPORT["weighted_groups"] = {o.name: len(o.vertex_groups) for o in cosmetic}
    REPORT.update(stats(keep))
    export(JOB["output"], keep)


# ---------- retargeting ----------

SIDES = [(r"(^|[._ -])l($|[._ -])|left", "left"), (r"(^|[._ -])r($|[._ -])|right", "right")]
SYNONYMS = {
    "hips": ["hips", "pelvis", "root_pelvis"], "spine": ["spine", "spine1", "spine_01", "torso"], "chest": ["spine2", "chest", "spine_02", "spine_03", "upperchest"],
    "neck": ["neck", "neck_01"], "head": ["head"], "shoulder": ["shoulder", "clavicle"], "upperarm": ["arm", "upperarm", "upper_arm"],
    "forearm": ["forearm", "lowerarm", "lower_arm"], "hand": ["hand"], "thigh": ["upleg", "thigh", "upperleg", "upper_leg"],
    "shin": ["leg", "calf", "shin", "lowerleg", "lower_leg"], "foot": ["foot", "ankle"], "toe": ["toebase", "toe", "ball"],
}


def canonical(name):
    n = name.lower()
    n = re.sub(r"^(mixamorig\d*:|def[-_]|org[-_]|mch[-_]|bip\d*[ _]|b_|bone_|cc_base_|j_bip_c_|j_bip_l_|j_bip_r_)", "", n)
    side = ""
    for pat, s in SIDES:
        if re.search(pat, n):
            side = s
            n = re.sub(pat, "_", n)
            break
    n = re.sub(r"[^a-z0-9]", "", n)
    for key, alts in SYNONYMS.items():
        if n in alts:
            n = key
            break
    finger = re.match(r"^(thumb|index|middle|ring|pinky|little)(\d)", n)
    if finger:
        n = f"{finger.group(1).replace('little', 'pinky')}{finger.group(2)}"
    return f"{side}{n}"


def op_retarget():
    tgt_objs = import_any(JOB["input"])
    tgt = next((o for o in tgt_objs if o.type == "ARMATURE"), None)
    src_objs = import_any(JOB["animations"])
    src = next((o for o in src_objs if o.type == "ARMATURE"), None)
    if not tgt or not src:
        raise ValueError("both files need a skeleton (armature)")
    actions = [a for a in bpy.data.actions if any(fc.data_path.startswith("pose.bones") for fc in a.fcurves)]
    src_names = {canonical(b.name): b.name for b in src.data.bones}
    mapping = dict(JOB.get("bone_map") or {})
    for b in tgt.data.bones:
        if b.name not in mapping and canonical(b.name) in src_names:
            mapping[b.name] = src_names[canonical(b.name)]
    if not mapping:
        raise ValueError("no bone names matched; pass bone_map {target_bone: source_bone}")
    # World-space constraints follow the source pose; baking turns them into keys.
    scale = (max(tgt.dimensions) or 1) / (max(src.dimensions) or 1)
    tgt.animation_data_create()
    for tb, sb in mapping.items():
        pb = tgt.pose.bones[tb]
        c = pb.constraints.new("COPY_ROTATION")
        c.target, c.subtarget = src, sb
        c.target_space = c.owner_space = "WORLD"
        if canonical(tb) == "hips":
            c2 = pb.constraints.new("COPY_LOCATION")
            c2.target, c2.subtarget = src, sb
            c2.target_space = c2.owner_space = "WORLD"
    src_actions = [a for a in actions if a not in (tgt.animation_data.action,)]
    if JOB.get("actions"):
        src_actions = [a for a in src_actions if a.name in JOB["actions"]]
    made = []
    src.animation_data_create()
    for act in src_actions:
        src.animation_data.action = act
        start, end = [int(x) for x in act.frame_range]
        activate(tgt)
        bpy.ops.object.mode_set(mode="POSE")
        bpy.ops.pose.select_all(action="SELECT")
        bpy.ops.nla.bake(frame_start=start, frame_end=end, only_selected=True, visual_keying=True,
                         clear_constraints=False, use_current_action=False, bake_types={"POSE"})
        bpy.ops.object.mode_set(mode="OBJECT")
        baked = tgt.animation_data.action
        clean = re.sub(r"\.\d{3}$", "", act.name.split("|")[-1])
        act.name = clean + "_source"
        baked.name = clean
        baked.use_fake_user = True
        track = tgt.animation_data.nla_tracks.new()
        track.name = baked.name
        track.strips.new(baked.name, start, baked)
        tgt.animation_data.action = None
        made.append({"name": baked.name, "frames": [start, end]})
    for tb in mapping:
        for c in list(tgt.pose.bones[tb].constraints):
            tgt.pose.bones[tb].constraints.remove(c)
    for o in src_objs:
        bpy.data.objects.remove(o, do_unlink=True)
    # The source clips would otherwise be exported onto the target skeleton too.
    for act in src_actions:
        bpy.data.actions.remove(act)
    REPORT["bones_matched"] = len(mapping)
    REPORT["bones_unmatched"] = [b.name for b in tgt.data.bones if b.name not in mapping][:40]
    REPORT["animations_made"] = made
    REPORT["scale_ratio"] = round(scale, 3)
    keep = [o for o in tgt_objs if o.name in bpy.data.objects]
    REPORT.update(stats(keep))
    export(JOB["output"], keep)


def op_inspect():
    objs = import_any(JOB["input"])
    REPORT.update(stats(objs))


try:
    clear_scene()
    {"inspect": op_inspect, "cleanup": op_cleanup, "uv": op_uv, "bake": op_bake, "rig": op_rig, "retarget": op_retarget}[JOB["op"]]()
except Exception as err:
    import traceback
    REPORT["ok"] = False
    REPORT["error"] = f"{type(err).__name__}: {err}"
    REPORT["trace"] = traceback.format_exc()[-2000:]
done()
