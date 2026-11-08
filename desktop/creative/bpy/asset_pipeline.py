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
  rig        puts a cosmetic mesh on a base character's skeleton: robust weight
             transfer from the body (copied where the cloth sits on the body, filled in
             smoothly elsewhere), limited to the bones its slot may follow, or one bone
             for a rigid piece; pushes it out of the body; exports .glb with the skeleton
  dress      a whole outfit at once: orders the layers, fits each over the ones under
             it, copies weights layer to layer, hides body and inner-layer faces the
             outfit covers, checks it in test poses for anything poking through, and
             exports every piece, the masked body and an outfit preview
  texture    puts a tileable PBR set (albedo, normal, roughness, metallic, ao,
             emission) on the mesh as one material, tiled by tile_scale; exports
             .glb (the tiling travels as KHR_texture_transform)
  retarget   copies the animations of one skeleton onto another by bone names
             (Mixamo, Rigify, UE and generic names are matched), baking them into
             actions the .glb carries
  review     the visible-first check: renders the model from the front, back, both
             sides, top and below, a face close-up and the in-game camera, then
             checks what a player can see (holes, flipped faces, stretched UVs,
             missing textures, empty views) and counts the faces nobody can see
"""
import bpy
import bmesh
import numpy as np
import json
import math
import os
import re
import sys
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import skin_fit as sf  # noqa: E402

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
    if JOB.get("drop_hidden"):
        # Faces no camera angle can see (inside armour, under plates) spend the triangle
        # budget where nobody looks, so they go before decimating.
        parts = world_parts(ms)
        vis = visibility(parts)
        dropped = 0
        for (ob, bm, _), seen in zip(parts, vis["per_object"]):
            local = bmesh.new()
            local.from_mesh(ob.data)
            local.faces.ensure_lookup_table()
            gone = [local.faces[i] for i, s in enumerate(seen) if not s and i < len(local.faces)]
            dropped += sum(len(f.verts) - 2 for f in gone)
            bmesh.ops.delete(local, geom=gone, context="FACES")
            local.to_mesh(ob.data)
            local.free()
            bm.free()
        REPORT["hidden_tris_dropped"] = dropped
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


# ---------- texturing ----------

def op_texture():
    objs = import_any(JOB["input"])
    ms = meshes(objs)
    if not ms:
        raise ValueError("no mesh in the input")
    maps = JOB.get("maps") or {}
    if not maps.get("albedo"):
        raise ValueError("texture needs maps.albedo")
    name = JOB.get("name", "skin")
    mat = bpy.data.materials.new(f"{name}_mat")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = principled(mat)
    coord = nt.nodes.new("ShaderNodeTexCoord")
    mapping = nt.nodes.new("ShaderNodeMapping")
    scale = float(JOB.get("tile_scale", 1.0))
    mapping.inputs["Scale"].default_value = (scale, scale, 1.0)
    nt.links.new(coord.outputs["UV"], mapping.inputs["Vector"])

    def tex(kind, non_color):
        path = maps.get(kind)
        if not path or not os.path.exists(path):
            return None
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = bpy.data.images.load(path)
        if non_color:
            n.image.colorspace_settings.name = "Non-Color"
        nt.links.new(mapping.outputs["Vector"], n.inputs["Vector"])
        return n
    t = tex("albedo", False)
    nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    for kind, sock in (("roughness", "Roughness"), ("metallic", "Metallic")):
        t = tex(kind, True)
        if t:
            nt.links.new(t.outputs["Color"], bsdf.inputs[sock])
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
    for ob in ms:
        if not ob.data.uv_layers:
            ob.data.uv_layers.new(name="UVMap")
            unwrap(ob)
        ob.data.materials.clear()
        ob.data.materials.append(mat)
    REPORT["material"] = mat.name
    REPORT.update(stats(objs))
    export(JOB["output"], objs)


# ---------- rigging ----------

# ---------- rigging and dressing ----------
# Blender is Z-up and glTF characters face +Z, which is Blender's -Y.
UP, FRONT = (0.0, 0.0, 1.0), (0.0, -1.0, 0.0)


def find_rig(objs):
    arm = next((o for o in objs if o.type == "ARMATURE"), None)
    if not arm:
        raise ValueError("the base character has no skeleton (armature)")
    body = [o for o in meshes(objs) if any(m.type == "ARMATURE" for m in o.modifiers) or o.parent == arm]
    if not body:
        raise ValueError("the base character has no skinned body mesh")
    return arm, max(body, key=lambda o: len(o.data.vertices)), body


def triangulate(ob):
    """Triangulate in place so every face is a triangle (glTF exports triangles anyway)."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def mesh_arrays(ob):
    """World positions and triangles (a triangle per polygon after triangulate)."""
    me = ob.data
    V = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("co", V)
    V = V.reshape(-1, 3)
    M = np.array(ob.matrix_world)
    V = V @ M[:3, :3].T + M[:3, 3]
    me.calc_loop_triangles()  # triangulate() ran first, so triangle i is polygon i
    F = np.zeros(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get("vertices", F)
    return V, F.reshape(-1, 3).astype(np.int64)


def set_world_positions(ob, V):
    M = np.array(ob.matrix_world.inverted())
    local = V @ M[:3, :3].T + M[:3, 3]
    ob.data.vertices.foreach_set("co", local.astype(np.float32).ravel())
    ob.data.update()


def bone_table(arm):
    bones = list(arm.data.bones)
    names = [b.name for b in bones]
    idx = {n: i for i, n in enumerate(names)}
    parents = [idx[b.parent.name] if b.parent else -1 for b in bones]
    M = np.array(arm.matrix_world)
    heads = np.array([list(b.head_local) for b in bones]) @ M[:3, :3].T + M[:3, 3]
    tails = np.array([list(b.tail_local) for b in bones]) @ M[:3, :3].T + M[:3, 3]
    deform = np.array([b.use_deform for b in bones])
    return names, parents, heads, tails, deform


def read_weights(ob, names):
    col = {n: i for i, n in enumerate(names)}
    gmap = {g.index: col.get(g.name, -1) for g in ob.vertex_groups}
    W = np.zeros((len(ob.data.vertices), len(names)))
    for v in ob.data.vertices:
        for g in v.groups:
            c = gmap.get(g.group, -1)
            if c >= 0:
                W[v.index, c] += g.weight
    s = W.sum(1, keepdims=True)
    return W / np.maximum(s, 1e-12)


def write_weights(ob, W, names, arm):
    for vg in list(ob.vertex_groups):
        ob.vertex_groups.remove(vg)
    for b in np.where(W.sum(0) > 0)[0]:
        vg = ob.vertex_groups.new(name=names[b])
        rows = np.where(W[:, b] > 0)[0]
        for r in rows:
            vg.add([int(r)], float(W[r, b]), "REPLACE")
    for m in [m for m in ob.modifiers if m.type == "ARMATURE"]:
        ob.modifiers.remove(m)
    mw = ob.matrix_world.copy()
    ob.parent = arm
    ob.matrix_world = mw
    am = ob.modifiers.new("Armature", "ARMATURE")
    am.object = arm


class Source:
    """Blender BVH over stacked surfaces (body + layers already dressed), for nearest-point lookups."""

    def __init__(self, V, F, W=None):
        self.V, self.F, self.W = V, F, W
        self.VN = sf.vertex_normals(V, F)
        self.tree = BVHTree.FromPolygons([Vector(p) for p in V], [tuple(int(i) for i in f) for f in F], all_triangles=True)

    def nearest(self, P, far=10.0):
        n = len(P)
        Q = np.zeros((n, 3))
        face = np.zeros(n, np.int64)
        dist = np.full(n, far)
        for i, p in enumerate(P):
            co, _, idx, d = self.tree.find_nearest(Vector(p), far)
            if co is not None:
                Q[i], face[i], dist[i] = tuple(co), idx, d
        tri = self.F[face]
        bary = sf.barycentric(Q, self.V[tri[:, 0]], self.V[tri[:, 1]], self.V[tri[:, 2]])
        return Q, sf.interp_normals(self.VN, self.F, face, bary), face, bary, dist


def piece_side(V, heads, names):
    """'left', 'right' or '' from where the piece sits relative to the skeleton's middle."""
    mid = heads[:, 0].mean()
    cx = V[:, 0].mean() - mid
    if abs(cx) < 0.03 * max(np.ptp(heads[:, 2]), 1e-6):
        return ""
    sided = [(h[0] - mid, sf.bone_role(n)[0]) for h, n in zip(heads, names) if sf.bone_role(n)[0]]
    left_x = np.mean([x for x, sd in sided if sd == "left"]) if any(sd == "left" for _, sd in sided) else 1.0
    return "left" if np.sign(cx) == np.sign(left_x) else "right"


def fit_piece(name, ob, slot, arm, table, under, body_src, opts):
    """Push the piece out of what's under it, then weight it. Returns (V, F, W, report)."""
    names, parents, heads, tails, deform = table
    triangulate(ob)
    V, F = mesh_arrays(ob)
    ids = sf.weld(V)
    slot = sf.slot_for(name, slot)
    side = opts.get("side") or piece_side(V, heads, names)
    rep = {"slot": slot, "side": side}
    # 1) fit: at least `margin` outside the body and the layers under it
    moved_total = 0
    if opts.get("push", True):
        for _ in range(2):
            q, n, _, _, d = body_src.nearest(V)
            sd = np.einsum("ij,ij->i", V - q, n)
            out_dir = n
            if under is not None:
                q2, n2, _, _, d2 = under.nearest(V)
                n2 = n2 * np.sign(np.einsum("ij,ij->i", n2, n) + 1e-9)[:, None]
                sd2 = np.einsum("ij,ij->i", V - q2, n2)
                use = (d2 < 0.03) & (sd2 < sd)
                sd = np.where(use, sd2, sd)
                out_dir = np.where(use[:, None], n2, out_dir)
            near = np.abs(sd) < 0.03
            V, moved = sf.push_out(V, F, np.where(near, sd, 1.0), out_dir, margin=float(opts.get("margin", 0.004)), ids=ids)
            moved_total += moved
            if not moved:
                break
        set_world_positions(ob, V)
    rep["pushed_verts"] = moved_total
    # 2) weights
    if opts.get("rigid_bone") or slot in opts.get("rigid_slots", []):
        bone = opts.get("rigid_bone")
        if bone not in names:
            ok = sf.allowed(names, slot, side) & deform
            c = V.mean(0)
            cand = np.where(ok)[0] if ok.any() else np.where(deform)[0]
            mids = (heads[cand] + tails[cand]) / 2
            bone = names[int(cand[np.argmin(np.linalg.norm(mids - c, axis=1))])]
        W = sf.rigid_weights(len(V), len(names), names.index(bone))
        rep["rigid_bone"] = bone
    else:
        src = under if under is not None else body_src
        N = sf.vertex_normals(V, F, ids)
        q, n, f, b, d = src.nearest(V)
        W, matched = sf.robust_transfer(V, F, N, q, n, f, b, src.F, src.W, max_dist=float(opts.get("max_dist", 0.05)),
                                        max_angle=float(opts.get("max_angle", 35)), ids=ids)
        ok = sf.allowed(names, slot, side) & deform
        okidx = np.where(ok)[0]
        fb = [int(okidx[np.argmin(np.linalg.norm(heads[okidx] - heads[i], axis=1))]) if len(okidx) else -1 for i in range(len(names))]
        W, _ = sf.limit_to_allowed(W, parents, ok, fallback=fb)
        W = sf.top_k(W, 4)
        rep["matched_share"] = round(float(matched.mean()), 3)
    o = np.argsort(-W.sum(0))
    rep["main_bones"] = [names[k] for k in o[:6] if W[:, k].sum() > 1e-6]
    return V, F, W, rep


def add_helper_constraints(arm, amount=0.5):
    """Bones named <X>Helper turn half as far as <X> (shoulder/hip helpers), so posed
    checks and renders in Blender match the game (Godot gets CoDevHelperBones.gd)."""
    made = []
    for pb in arm.pose.bones:
        if pb.name.lower().endswith("helper") and pb.name[:-6] in arm.pose.bones:
            c = pb.constraints.new("COPY_ROTATION")
            c.target, c.subtarget = arm, pb.name[:-6]
            c.target_space = c.owner_space = "LOCAL"
            c.influence = amount
            made.append(pb.name)
    return made


def apply_test_pose(arm, pose_name):
    """Pose the armature in one of skin_fit.TEST_POSES (works on any skeleton bone_role knows)."""
    names, parents, heads, tails, _ = bone_table(arm)
    D = sf.pose_deltas(names, parents, heads, tails, sf.TEST_POSES[pose_name], UP, FRONT)
    Mw = np.array(arm.matrix_world)
    Mi = np.linalg.inv(Mw)
    from mathutils import Matrix
    order = sorted(range(len(names)), key=lambda b: sf._depth(b, parents))
    for b in order:
        if names[b].lower().endswith("helper"):
            continue  # the constraint drives it
        pb = arm.pose.bones[names[b]]
        rest = np.array(arm.data.bones[names[b]].matrix_local)
        pb.matrix = Matrix((Mi @ D[b] @ Mw @ rest).tolist())
        bpy.context.view_layer.update()
    return D


def op_rig():
    base = import_any(JOB["base"])
    arm, body, bodies = find_rig(base)
    for o in bodies:
        triangulate(o)
    table = bone_table(arm)
    BV, BF = mesh_arrays(body)
    body_src = Source(BV, BF, read_weights(body, table[0]))
    cosmetic = meshes(import_any(JOB["input"]))
    if not cosmetic:
        raise ValueError("no mesh in the cosmetic file")
    method = JOB.get("method") or "robust"
    REPORT["method"] = method
    REPORT["pieces"] = {}
    for ob in cosmetic:
        if method == "auto":
            bpy.ops.object.select_all(action="DESELECT")
            ob.select_set(True)
            arm.select_set(True)
            bpy.context.view_layer.objects.active = arm
            bpy.ops.object.parent_set(type="ARMATURE_AUTO")
            continue
        if method == "transfer":  # Blender's plain nearest-face copy, kept for comparison
            body_src = Source(BV, BF, read_weights(body, table[0]))
            opts = {"push": False, "max_dist": 1e9, "max_angle": 180}
        else:
            opts = {k: JOB[k] for k in ("rigid_bone", "margin", "max_dist", "max_angle", "push", "side") if JOB.get(k) is not None}
        label = f"{os.path.splitext(os.path.basename(JOB['input']))[0]} {ob.name}"
        V, F, W, rep = fit_piece(label, ob, JOB.get("slot"), arm, table, None, body_src, opts)
        write_weights(ob, W, table[0], arm)
        REPORT["pieces"][ob.name] = rep
    REPORT["helpers"] = add_helper_constraints(arm)
    keep = [arm] + cosmetic + (bodies if JOB.get("keep_body") else [])
    if not JOB.get("keep_body"):
        for o in bodies:
            bpy.data.objects.remove(o, do_unlink=True)
    REPORT["weighted_groups"] = {o.name: len(o.vertex_groups) for o in cosmetic}
    REPORT.update(stats(keep))
    export(JOB["output"], keep)


def delete_faces(ob, hide):
    if not np.any(hide):
        return 0
    ob.data.calc_loop_triangles()
    polys = np.zeros(len(ob.data.loop_triangles), np.int32)
    ob.data.loop_triangles.foreach_get("polygon_index", polys)
    hide = np.zeros(len(ob.data.polygons), bool) | np.isin(np.arange(len(ob.data.polygons)), polys[np.asarray(hide)[:len(polys)]])
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.faces.ensure_lookup_table()
    gone = [bm.faces[i] for i in np.where(hide)[0] if i < len(bm.faces)]
    bmesh.ops.delete(bm, geom=gone, context="FACES_ONLY")
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    return len(gone)


def op_dress():
    """A whole outfit on the base character: see the module docstring."""
    base = import_any(JOB["base"])
    arm, body, bodies = find_rig(base)
    for o in bodies:
        triangulate(o)
    table = bone_table(arm)
    names, parents, heads, tails, deform = table
    BV, BF = mesh_arrays(body)
    BW = read_weights(body, names)
    body_src = Source(BV, BF, BW)
    slots = JOB.get("slots") or {}
    rigid = JOB.get("rigid") or {}
    pieces = {}
    for path in JOB["inputs"]:
        objs = meshes(import_any(path))
        if not objs:
            raise ValueError(f"no mesh in {os.path.basename(path)}")
        stem = os.path.splitext(os.path.basename(path))[0]
        if len(objs) > 1:  # one object per piece
            bpy.ops.object.select_all(action="DESELECT")
            for o in objs:
                o.select_set(True)
            bpy.context.view_layer.objects.active = objs[0]
            bpy.ops.object.join()
        ob = objs[0]
        ob.name = stem
        triangulate(ob)
        pieces[stem] = ob
    # layer order from where pieces overlap (the one farther from the body there is outside)
    raw = {k: mesh_arrays(o) for k, o in pieces.items()}
    gaps = {k: float(np.median(body_src.nearest(V)[4])) for k, (V, F) in raw.items()}
    outer = {}
    srcs = {k: Source(V, F) for k, (V, F) in raw.items()}
    for a in raw:
        Va = raw[a][0][:: max(1, len(raw[a][0]) // 3000)]
        for b in raw:
            if a == b:
                continue
            q, _, _, _, d = srcs[b].nearest(Va, far=0.03)
            near = d < 0.015
            if near.sum() >= 20:
                outer[(a, b)] = bool(np.median(body_src.nearest(Va[near])[4] - body_src.nearest(q[near])[4]) > 0)
    order = JOB.get("order") or sf.layer_order(list(raw), [gaps[k] for k in raw], outer)
    REPORT["layer_order"] = order
    # fit and weight inner to outer; each piece copies weights from what is right under it
    done = {}
    REPORT["pieces"] = {}
    covered_body = np.zeros(len(BV), bool)
    BN = sf.vertex_normals(BV, BF)
    for k in order:
        ob = pieces[k]
        stack = sf.stack([(BV, BF, BW)] + [(v[0], v[1], v[2]) for v in done.values()])
        under = Source(*stack) if done else None
        if under is None:
            under = body_src
        opts = {"rigid_bone": rigid.get(k), "margin": JOB.get("margin", 0.004)}
        V, F, W, rep = fit_piece(k, ob, slots.get(k), arm, table, under if done else None, body_src, opts)
        done[k] = (V, F, W)
        REPORT["pieces"][k] = rep
        cq, _, _, _, cd = Source(V, F).nearest(BV, far=0.05)
        covered_body |= (cd < 0.03) & (np.einsum("ij,ij->i", cq - BV, BN) > -0.002)
    # inner layers: faces fully under an outer layer go, and where layers overlap the
    # inner one takes the outer one's weights so the two move together
    cover_pairs = []
    gap_rest = {k: body_src.nearest(v[0])[4] for k, v in done.items()}
    hide_piece = {}
    for i, a in enumerate(order):
        Va, Fa, Wa = done[a]
        cov = np.zeros(len(Va), bool)
        for b in order[i + 1:]:
            sb = Source(done[b][0], done[b][1])
            q, _, f, bb, d = sb.nearest(Va, far=0.05)
            c = sf.covered_by(d, gap_rest[a], body_src.nearest(q)[4], max_dist=0.04)
            if c.sum() > 30:
                cover_pairs.append((a, b, c, f, bb, d < 0.05))
            cov |= c
        hide_piece[a] = sf.covered_faces(Fa, cov, body_ids=sf.weld(Va), erode=2) if JOB.get("hide_inner", True) else np.zeros(len(Fa), bool)
    for a, b, c, f, bb, found in sorted(cover_pairs, key=lambda t: -order.index(t[1])):
        Va, Fa, Wa = done[a]
        Wo = np.where(found[:, None], sf.interp_rows(done[b][2], done[b][1], f, bb), Wa)
        done[a] = (Va, Fa, sf.sync_layer(Va, Fa, Wa, c, Wo))
    hide_body = sf.covered_faces(BF, covered_body, body_ids=sf.weld(BV), erode=2) if JOB.get("hide_body", True) else np.zeros(len(BF), bool)
    REPORT["body_faces_hidden"] = int(hide_body.sum())
    # posed checks: inner layers must stay under outer ones; hidden body must stay covered
    pairs = [(a, b, c & ~np.isin(np.arange(len(done[a][0])), np.unique(done[a][1][hide_piece[a]]))) for a, b, c, _, _, _ in cover_pairs]
    hidden_v = np.zeros(len(BV), bool)
    hidden_v[np.unique(BF[hide_body])] = True
    checks = {}
    for pname in JOB.get("poses") or list(sf.TEST_POSES):
        if pname not in sf.TEST_POSES:
            continue
        D = sf.pose_deltas(names, parents, heads, tails, sf.TEST_POSES[pname], UP, FRONT)
        posed = {k: sf.skin(v[0], v[2], D) for k, v in done.items()}
        bsrc = Source(sf.skin(BV, BW, D), BF)
        r = {}
        for a, b, under_mask in pairs:
            if not under_mask.any():
                continue
            q, _, _, _, d = Source(posed[b], done[b][1]).nearest(posed[a][under_mask], far=0.1)
            sd = sf.poke_through(bsrc.nearest(posed[a][under_mask])[4], bsrc.nearest(q)[4])
            rep = sf.poke_report(sd, np.ones(len(sd), bool))
            if rep["poking"]:
                r[f"{a} through {b}"] = rep
        if hidden_v.any():
            allV, allF, _ = sf.stack([(posed[k], done[k][1], np.zeros((len(posed[k]), 1))) for k in order])
            _, _, _, _, dg = Source(allV, allF).nearest(bsrc.V[hidden_v], far=0.2)
            if (dg > 0.03).sum():
                r["body showing"] = {"open": int((dg > 0.03).sum()), "worst_mm": round(float(dg.max() * 1000), 1)}
        checks[pname] = r
    REPORT["pose_checks"] = checks
    REPORT["passed"] = all(not r for r in checks.values())
    # write everything
    out_dir = JOB["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    REPORT["helpers"] = add_helper_constraints(arm)
    files = {}
    for k in order:
        ob = pieces[k]
        V, F, W = done[k]
        write_weights(ob, W, names, arm)
        REPORT["pieces"][k]["faces_hidden"] = delete_faces(ob, hide_piece[k])
    delete_faces(body, hide_body)
    for k in order:
        p = os.path.join(out_dir, f"{k}_rigged.glb")
        export(p, [arm, pieces[k]])
        files[k] = p
    p = os.path.join(out_dir, f"{JOB.get('name', 'outfit')}_body.glb")
    export(p, [arm] + bodies)
    files["body"] = p
    p = os.path.join(out_dir, f"{JOB.get('name', 'outfit')}_outfit.glb")
    export(p, [arm] + bodies + [pieces[k] for k in order])
    files["outfit"] = p
    REPORT["files"] = files
    REPORT.update(stats([arm] + bodies + list(pieces.values())))
    REPORT["output"] = files["outfit"]


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


# ---------- visible-first review ----------

# The directions a camera can look from: the six sides plus the eight corners, so a
# face inside a crease still counts as seen from some angle.
VIEW_DIRS = [Vector(d).normalized() for d in [
    (0, 1, 0), (0, -1, 0), (1, 0, 0), (-1, 0, 0), (0, 0, -1), (0, 0, 1),
    (1, 1, 1), (1, 1, -1), (1, -1, 1), (1, -1, -1), (-1, 1, 1), (-1, 1, -1), (-1, -1, 1), (-1, -1, -1)]]

# Camera direction for each named view (the way the camera looks). glTF characters face
# +Z, which is Blender's -Y, so "front" looks from -Y towards +Y.
VIEWS = {"front": (0, 1, 0), "back": (0, -1, 0), "left": (-1, 0, 0), "right": (1, 0, 0), "top": (0, 0, -1), "below": (0, 0, 1)}


def world_parts(ms):
    """Each mesh as it's posed, in world space: [(object, bmesh, face_count)]."""
    dg = bpy.context.evaluated_depsgraph_get()
    parts = []
    for ob in ms:
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        bm = bmesh.new()
        bm.from_mesh(me)
        ev.to_mesh_clear()
        bm.transform(ob.matrix_world)
        # glTF splits vertices along UV seams and hard edges; weld them back by position
        # so a seam doesn't count as a hole (faces stay the same, in the same order).
        if bm.verts:
            span = max((max(v.co[i] for v in bm.verts) - min(v.co[i] for v in bm.verts)) for i in range(3))
            bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=max(span, 1e-6) * 1e-5)
        bm.normal_update()
        bm.verts.index_update()
        bm.faces.index_update()
        parts.append((ob, bm, len(bm.faces)))
    return parts


def bounds(parts):
    pts = [v.co for _, bm, _ in parts for v in bm.verts]
    if not pts:
        return Vector((0, 0, 0)), Vector((0, 0, 0))
    lo = Vector((min(p[i] for p in pts) for i in range(3)))
    hi = Vector((max(p[i] for p in pts) for i in range(3)))
    return lo, hi


def visibility(parts, max_faces=80000):
    """Which faces a camera can see from outside, and which show their back (flipped)."""
    verts, polys = [], []
    for _, bm, _ in parts:
        base = len(verts)
        verts.extend(v.co.copy() for v in bm.verts)
        polys.extend([base + v.index for v in f.verts] for f in bm.faces)
    out = {"per_object": [], "flipped": [], "total": len(polys)}
    if not polys:
        return out
    tree = BVHTree.FromPolygons(verts, polys, all_triangles=False)
    lo, hi = bounds(parts)
    reach = max((hi - lo).length, 1e-6) * 2.0
    eps = reach * 1e-4
    step = max(1, len(polys) // max_faces)
    gi = 0
    for _, bm, _ in parts:
        seen = []
        flipped = []
        for f in bm.faces:
            if (gi % step) and step > 1:
                seen.append(True)
                flipped.append(False)
                gi += 1
                continue
            c = f.calc_center_median()
            n = f.normal
            front = back = 0
            for d in VIEW_DIRS:
                hit, _, idx, _ = tree.ray_cast(c - d * reach, d, reach * 2)
                if hit is not None and (idx == gi or (hit - c).length < eps):
                    if n.dot(-d) >= 0:
                        front += 1
                    else:
                        back += 1
            seen.append(front + back > 0)
            flipped.append(front == 0 and back > 0)
            gi += 1
        out["per_object"].append(seen)
        out["flipped"].append(flipped)
    return out


def mesh_checks(parts, vis):
    """What a player could notice on the faces they can see."""
    seen_area = hidden_tris = flipped_area = stretched_area = 0.0
    open_edges = nonmanifold = 0
    no_uv = []
    for (ob, bm, _), seen, flipped in zip(parts, vis["per_object"], vis["flipped"]):
        uv = bm.loops.layers.uv.active
        if uv is None:
            no_uv.append(ob.name)
        areas = [f.calc_area() for f in bm.faces]
        uv_areas = []
        if uv is not None:
            for f in bm.faces:
                pts = [l[uv].uv for l in f.loops]
                uv_areas.append(abs(sum(pts[i].x * pts[i - 1].y - pts[i - 1].x * pts[i].y for i in range(len(pts)))) / 2)
        total_a = sum(a for a, s in zip(areas, seen) if s) or 1e-9
        total_uv = sum(u for u, s in zip(uv_areas, seen) if s) or 1e-9
        for i, f in enumerate(bm.faces):
            if not seen[i]:
                hidden_tris += len(f.verts) - 2
                continue
            seen_area += areas[i]
            if flipped[i]:
                flipped_area += areas[i]
            if uv_areas and areas[i] > 0:
                density = (uv_areas[i] / total_uv) / (areas[i] / total_a)
                if density < 0.2 or density > 5:
                    stretched_area += areas[i]
        for e in bm.edges:
            k = len(e.link_faces)
            if k > 2:
                nonmanifold += 1
            elif k == 1 and seen[e.link_faces[0].index]:
                open_edges += 1
    total = seen_area or 1e-9
    return {
        "visible_open_edges": open_edges, "nonmanifold_edges": nonmanifold,
        "flipped_visible": round(flipped_area / total, 4), "uv_stretched_visible": round(stretched_area / total, 4),
        "meshes_without_uvs": no_uv, "hidden_tris": int(hidden_tris), "visible_tris": int(sum(len(f.verts) - 2 for _, bm, _ in parts for f in bm.faces) - hidden_tris),
    }


def head_point(objs, lo, hi):
    """Where the face is: a head bone when the skeleton has one, else the top front."""
    for arm in (o for o in objs if o.type == "ARMATURE"):
        for b in arm.data.bones:
            if re.search(r"head", b.name, re.I) and not re.search(r"end|top|_end", b.name, re.I):
                return arm.matrix_world @ ((b.head_local + b.tail_local) / 2), True
    h = hi.z - lo.z
    return Vector(((lo.x + hi.x) / 2, lo.y, hi.z - 0.07 * h)), False


def setup_render(engine, size):
    scene = bpy.context.scene
    want = (engine or "eevee").lower()
    names = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    if want == "cycles" or not any(n.startswith("BLENDER_EEVEE") for n in names):
        scene.render.engine = "CYCLES"
        scene.cycles.samples = int(JOB.get("samples", 16))
        scene.cycles.device = "CPU"
        try:
            scene.cycles.use_denoising = False
        except Exception:
            pass
    else:
        scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in names else "BLENDER_EEVEE"
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    world = bpy.data.worlds.new("review") if not scene.world else scene.world
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.55, 0.57, 0.6, 1)
        bg.inputs[1].default_value = 0.9
    # A key light from the front-top and a weaker one from below, so the underside reads too.
    for name, rot, energy in (("key", (math.radians(50), 0, math.radians(-30)), 3.0), ("rim", (math.radians(-60), 0, math.radians(160)), 2.0), ("under", (math.radians(180), 0, 0), 0.8)):
        lamp = bpy.data.lights.new(name, "SUN")
        lamp.energy = energy
        ob = bpy.data.objects.new(name, lamp)
        ob.rotation_euler = rot
        scene.collection.objects.link(ob)
    return scene.render.engine


def camera(name, ortho=True):
    cam = bpy.data.cameras.new(name)
    cam.type = "ORTHO" if ortho else "PERSP"
    ob = bpy.data.objects.new(name, cam)
    bpy.context.scene.collection.objects.link(ob)
    bpy.context.scene.camera = ob
    return ob


def aim(ob, direction):
    d = Vector(direction).normalized()
    if abs(d.z) > 0.99:
        ob.rotation_euler = (0, 0, 0) if d.z < 0 else (math.pi, 0, 0)
    else:
        ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def frame(ob, corners, center, d, reach, margin=1.12):
    aim(ob, d)
    bpy.context.view_layer.update()
    rot = ob.matrix_world.to_3x3()
    right, up = rot.col[0], rot.col[1]
    xs = [(p - center).dot(right) for p in corners]
    ys = [(p - center).dot(up) for p in corners]
    mid = center + right * (max(xs) + min(xs)) / 2 + up * (max(ys) + min(ys)) / 2
    ob.location = mid - Vector(d).normalized() * reach
    ob.data.ortho_scale = max(max(xs) - min(xs), max(ys) - min(ys), 1e-4) * margin
    ob.data.clip_end = reach * 4


def image_checks(path):
    import numpy as np
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(img)
    alpha = px[..., 3] > 0.5
    cover = float(alpha.mean())
    rgb = px[..., :3]
    magenta = alpha & (rgb[..., 0] > 0.75) & (rgb[..., 1] < 0.25) & (rgb[..., 2] > 0.75)
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    lap = 4 * lum[1:-1, 1:-1] - lum[:-2, 1:-1] - lum[2:, 1:-1] - lum[1:-1, :-2] - lum[1:-1, 2:]
    inner = alpha[1:-1, 1:-1] & alpha[:-2, 1:-1] & alpha[2:, 1:-1] & alpha[1:-1, :-2] & alpha[1:-1, 2:]
    detail = float(lap[inner].var()) if inner.any() else 0.0
    return {"coverage": round(cover, 4), "missing_texture": round(float(magenta.sum()) / max(int(alpha.sum()), 1), 4), "detail": round(detail, 6)}


def op_review():
    objs = import_any(JOB["input"])
    if JOB.get("pose"):
        arm = next((o for o in objs if o.type == "ARMATURE"), None)
        if not arm:
            raise ValueError("pose needs a model with a skeleton")
        REPORT["helpers"] = add_helper_constraints(arm)
        apply_test_pose(arm, JOB["pose"])
        REPORT["pose"] = JOB["pose"]
    ms = meshes(objs)
    if not ms:
        raise ValueError("no mesh in the input")
    parts = world_parts(ms)
    lo, hi = bounds(parts)
    center = (lo + hi) / 2
    height = max(hi.z - lo.z, 1e-4)
    reach = max((hi - lo).length, 1e-4) * 2
    corners = [Vector((x, y, z)) for x in (lo.x, hi.x) for y in (lo.y, hi.y) for z in (lo.z, hi.z)]
    vis = visibility(parts)
    checks = mesh_checks(parts, vis)
    for _, bm, _ in parts:
        bm.free()
    REPORT["mesh_checks"] = checks
    REPORT.update(stats(objs))
    out_dir = JOB["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    if JOB.get("clay"):
        clay = bpy.data.materials.new("review_clay")
        clay.use_nodes = True
        b = principled(clay)
        b.inputs["Base Color"].default_value = (0.62, 0.6, 0.58, 1)
        b.inputs["Roughness"].default_value = 0.55
        bpy.context.view_layer.material_override = clay
    size = int(JOB.get("size", 512))
    REPORT["engine"] = setup_render(JOB.get("engine"), size)
    name = JOB.get("name", "review")
    views = JOB.get("views") or list(VIEWS) + ["face", "game"]
    rendered, images = {}, {}
    for view in views:
        if view in VIEWS:
            cam = camera(f"cam_{view}")
            frame(cam, corners, center, VIEWS[view], reach)
        elif view == "face":
            cam = camera("cam_face")
            point, from_bone = head_point(objs, lo, hi)
            aim(cam, (0, 1, 0))
            cam.location = Vector((point.x, lo.y - reach, point.z))
            cam.data.ortho_scale = max(0.2 * height, 1e-3) if from_bone else max(0.24 * min(height, max(hi.x - lo.x, hi.y - lo.y) * 2.5), 1e-3)
            cam.data.clip_end = reach * 4
            REPORT["face_from_bone"] = from_bone
        elif view == "game":
            g = JOB.get("game_camera") or {}
            cam = camera("cam_game", ortho=False)
            yaw = math.radians(float(g.get("yaw", 200)))
            dist = float(g.get("distance", 2.2)) * height
            # yaw 0 is in front of the character (-Y), 180 behind it.
            cam.location = Vector((center.x + math.sin(yaw) * dist, center.y - math.cos(yaw) * dist, lo.z + float(g.get("height", 1.05)) * height))
            cam.data.angle = math.radians(float(g.get("fov", 55)))
            aim(cam, center - cam.location)
            cam.data.clip_end = reach * 10
            bpy.context.scene.render.resolution_x, bpy.context.scene.render.resolution_y = int(size * 1.25), int(size * 0.7)
        else:
            continue
        path = os.path.join(out_dir, f"{name}_{view}.png")
        bpy.context.scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        bpy.context.scene.render.resolution_x = bpy.context.scene.render.resolution_y = size
        rendered[view] = path
        images[view] = image_checks(path)
    REPORT["views"] = rendered
    REPORT["image_checks"] = images


def op_inspect():
    objs = import_any(JOB["input"])
    REPORT.update(stats(objs))


try:
    clear_scene()
    {"inspect": op_inspect, "cleanup": op_cleanup, "uv": op_uv, "bake": op_bake, "texture": op_texture, "rig": op_rig, "dress": op_dress, "retarget": op_retarget, "review": op_review}[JOB["op"]]()
except Exception as err:
    import traceback
    REPORT["ok"] = False
    REPORT["error"] = f"{type(err).__name__}: {err}"
    REPORT["trace"] = traceback.format_exc()[-2000:]
done()
