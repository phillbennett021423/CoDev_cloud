"""Game skeleton, skin weights, pose test and export for a stylized character (Godot 4 glTF / Roblox FBX).

Kenny rigs with Rigify for animation (masterclass ch. 12; see references/). Engines only want the DEFORM
bones, with humanoid names they can retarget, and at most 4 weights per vertex. This script builds that
game skeleton directly from the mesh, the way Kenny places the meta-rig by eye:
  - landmarks from cross-sections: hips, spine, chest, neck, head from torso slices; thigh, knee (kept
    slightly bent forward, Kenny: IK bend direction), ankle and toe from leg slices; shoulder, elbow (slight
    bend), wrist and hand from the A-posed arm; optional 3-bone fingers from GEO-hand.* finger tips
  - Godot SkeletonProfileHumanoid names (Hips, Spine, Chest, UpperChest, Neck, Head, LeftUpperLeg ...),
    which also map 1:1 to Roblox R15 parts; L/R colour-free, deform-only
Skinning, Kenny's split:
  - body, head, hands: Automatic Weights (bone heat)
  - rigid pieces (eyes, teeth, scalp, hair cards, brows, lashes, helmets): Empty Groups + 100% to Head
  - clothes and gear: weights TRANSFERRED from the body (Nearest Face Interpolated, by name)
  - every vertex limited to 4 influences, tiny weights (< 0.01) dropped, normalised
Then a pose test (arms down, elbow 90, knee 60, head turn) saved as action QA_pose_test for the 4-view QA,
and the export:
    python rig_and_export.py -- --blend char_baked.blend --body GEO-body --out char_rig.blend \
        --glb export/char.glb [--fbx export/char_roblox.fbx] [--fingers] [--pose-test char_posed.blend]
"""
import argparse
import math
import os
import sys

import bpy
from mathutils import Vector, Matrix

RIGID = ("eye", "teeth", "tongue", "scalp", "hair", "brow", "lash", "cornea", "helmet", "hat")


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--blend")
    p.add_argument("--body", default="GEO-body")
    p.add_argument("--head", help="head mesh if separate (default: a mesh named *head* that is not a proxy)")
    p.add_argument("--name", default="RIG-character")
    p.add_argument("--fingers", action="store_true", help="add 3-bone fingers from GEO-hand.L/R tips")
    p.add_argument("--rigid", default="", help="extra rigid props as keyword:Bone, e.g. katana:LeftHand,goggle:Head,holster:Hips")
    p.add_argument("--max-influences", type=int, default=4)
    p.add_argument("--out")
    p.add_argument("--pose-test", help="save a copy posed with the QA test pose here")
    p.add_argument("--glb", help="Godot: glTF binary path")
    p.add_argument("--fbx", help="Roblox: FBX path")
    return p.parse_args(argv)


def world_verts(objs):
    out = []
    for o in objs:
        mw = o.matrix_world
        out += [mw @ v.co for v in o.data.vertices]
    return out


def slice_centroid(pts, z, band, pred=lambda p: True):
    sel = [p for p in pts if abs(p.z - z) < band and pred(p)]
    if not sel:
        return None
    return sum(sel, Vector()) / len(sel)


def landmarks(body, hands, head):
    pts = world_verts([body])
    allp = pts + world_verts(hands) + (world_verts([head]) if head else [])
    z0 = min(p.z for p in pts)
    H = max(p.z for p in allp) - z0
    b = 0.012 * H
    tx = 0.10 * H  # torso |x| limit (keeps A-posed arms and hands out)

    def torso(f):
        c = slice_centroid(pts, z0 + f * H, b, lambda p: abs(p.x) < tx)
        return Vector((0, c.y, c.z)) if c else Vector((0, 0, z0 + f * H))

    L = {"H": H, "z0": z0}
    for name, f in (("hips", 0.50), ("spine", 0.57), ("chest", 0.64), ("upperchest", 0.71), ("neck", 0.81),
                    ("head", 0.855)):
        L[name] = torso(f)
    L["head_top"] = Vector((0, L["head"].y, z0 + H))
    for s, side in ((1, "L"), (-1, "R")):  # +X is the character's LEFT (it faces -Y)
        leg = lambda p, s=s: s * p.x > 0.005 * H and abs(p.x) < 0.16 * H
        hip = slice_centroid(pts, z0 + 0.47 * H, b, leg)
        knee = slice_centroid(pts, z0 + 0.27 * H, b, leg)
        ankle = slice_centroid(pts, z0 + 0.045 * H, b, leg)
        foot = [p for p in pts if leg(p) and p.z < z0 + 0.04 * H]
        tip = min(foot, key=lambda p: p.y)  # most forward (-Y)
        knee = knee + Vector((0, -0.006 * H, 0))  # slight forward bend = IK bend direction
        ball = ankle.lerp(tip, 0.62)
        ball.z = z0 + 0.02 * H
        L[f"hip.{side}"], L[f"knee.{side}"], L[f"ankle.{side}"] = Vector((hip.x * 0.85, hip.y, hip.z)), knee, ankle
        L[f"ball.{side}"], L[f"toe.{side}"] = ball, Vector((tip.x, tip.y, z0 + 0.02 * H))
        # arm: chest-height half width, then everything further out and above the hips
        chest = [p for p in pts if abs(p.z - (z0 + 0.72 * H)) < b and abs(p.x) < 0.2 * H]
        half = max(abs(p.x) for p in chest) if chest else 0.12 * H
        sx = 0.62 * half
        hand_objs = [h for h in hands if (h.matrix_world.translation.x if abs(h.matrix_world.translation.x) > 1e-4
                     else sum(p.x for p in world_verts([h]))) * s > 0]
        arm = [p for p in pts + world_verts(hand_objs) if s * p.x > sx and p.z > z0 + 0.33 * H]
        tipa = max(arm, key=lambda p: s * p.x)
        root = [p for p in arm if s * p.x < sx + 0.035 * H and p.z > z0 + 0.70 * H]
        sh = sum(root, Vector()) / len(root) if root else Vector((s * sx, 0, z0 + 0.8 * H))
        d = (tipa - sh).normalized()
        wrist = tipa - d * 0.105 * H
        elbow = sh.lerp(wrist, 0.5) + Vector((0, 0.008 * H, 0))  # elbow bends back
        L[f"clav.{side}"] = Vector((s * 0.02 * H, sh.y, sh.z + 0.005 * H))
        L[f"shoulder.{side}"], L[f"elbow.{side}"], L[f"wrist.{side}"] = sh, elbow, wrist
        L[f"handtip.{side}"] = tipa
        L[f"handobj.{side}"] = hand_objs[0] if hand_objs else None
    return L


def fingers(eb, hand, side, wrist, handbone):
    """5 x 3 bones: finger tips = the 5 most outward local maxima of the hand mesh along the hand direction"""
    pts = world_verts([hand])
    d = (sum(pts, Vector()) / len(pts) - wrist).normalized()
    far = sorted(pts, key=lambda p: -(p - wrist).dot(d))
    tips = []
    for p in far:
        if all((p - t).length > 0.012 for t in tips):
            tips.append(p)
        if len(tips) == 5:
            break
    names = ["Thumb", "Index", "Middle", "Ring", "Little"]
    # order by angle around the hand direction: thumb = the tip closest to the body front (-Y) and lowest reach
    tips.sort(key=lambda p: (p - wrist).dot(d))
    thumb = tips[0]
    rest = sorted(tips[1:], key=lambda p: p.y)  # index is most forward
    for nm, tip in zip(names, [thumb] + rest):
        base = wrist.lerp(tip, 0.42 if nm != "Thumb" else 0.2)
        prev = handbone
        for k, (a, b) in enumerate(((0.0, 0.45), (0.45, 0.75), (0.75, 1.0))):
            bone = eb.new(f"{'Left' if side == 'L' else 'Right'}{nm}{['Proximal', 'Intermediate', 'Distal'][k]}")
            bone.head = base.lerp(tip, a)
            bone.tail = base.lerp(tip, b)
            bone.parent = prev
            bone.use_connect = k > 0
            prev = bone


def build_rig(args, L, hands):
    arm_data = bpy.data.armatures.new(args.name)
    rig = bpy.data.objects.new(args.name, arm_data)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.show_in_front = True
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm_data.edit_bones
    H = L["H"]

    def bone(name, head, tail, parent=None, connect=False, roll_up=False):
        b = eb.new(name)
        b.head, b.tail = head, tail
        if parent:
            b.parent = eb[parent]
            b.use_connect = connect
        return b

    bone("Hips", L["hips"], L["spine"])
    bone("Spine", L["spine"], L["chest"], "Hips", True)
    bone("Chest", L["chest"], L["upperchest"], "Spine", True)
    bone("UpperChest", L["upperchest"], L["neck"], "Chest", True)
    bone("Neck", L["neck"], L["head"], "UpperChest", True)
    bone("Head", L["head"], L["head_top"], "Neck", True)
    for side, pre in (("L", "Left"), ("R", "Right")):
        bone(f"{pre}UpperLeg", L[f"hip.{side}"], L[f"knee.{side}"], "Hips")
        bone(f"{pre}LowerLeg", L[f"knee.{side}"], L[f"ankle.{side}"], f"{pre}UpperLeg", True)
        bone(f"{pre}Foot", L[f"ankle.{side}"], L[f"ball.{side}"], f"{pre}LowerLeg", True)
        bone(f"{pre}Toes", L[f"ball.{side}"], L[f"toe.{side}"], f"{pre}Foot", True)
        bone(f"{pre}Shoulder", L[f"clav.{side}"], L[f"shoulder.{side}"], "UpperChest")
        bone(f"{pre}UpperArm", L[f"shoulder.{side}"], L[f"elbow.{side}"], f"{pre}Shoulder", True)
        bone(f"{pre}LowerArm", L[f"elbow.{side}"], L[f"wrist.{side}"], f"{pre}UpperArm", True)
        hb = bone(f"{pre}Hand", L[f"wrist.{side}"], L[f"wrist.{side}"].lerp(L[f"handtip.{side}"], 0.45),
                  f"{pre}LowerArm", True)
        if args.fingers and L[f"handobj.{side}"] is not None:
            fingers(eb, L[f"handobj.{side}"], side, L[f"wrist.{side}"], hb)
    # rolls: Z axis of limb bones points forward (-Y) so every engine bends them the same way
    for b in eb:
        b.align_roll(Vector((0, -1, 0)) if abs(b.vector.normalized().y) < 0.9 else Vector((0, 0, 1)))
        b.use_deform = True
    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


def classify(args):
    body = bpy.data.objects[args.body]
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH" and not o.hide_render
              and not o.name.startswith(("REF-", "QA_"))]
    head = bpy.data.objects.get(args.head) if args.head else next(
        (o for o in meshes if "head" in o.name.lower() and "proxy" not in o.name.lower()), None)
    if head is None:
        head = next((o for o in meshes if "head" in o.name.lower()), None)
    extra = dict(kv.split(":") for kv in (args.rigid or "").split(",") if kv)
    # a prop named like a body part (GEO-katana-handle) is still a prop
    hands = [o for o in meshes if "hand" in o.name.lower() and not any(k in o.name.lower() for k in extra)]
    rigid = [o for o in meshes if any(t in o.name.lower() for t in list(RIGID) + list(extra)) and o not in (body, head)]
    auto = [body] + ([head] if head else []) + hands
    cloth = [o for o in meshes if o not in auto and o not in rigid]
    return body, head, hands, auto, rigid, cloth


def parent_auto(rig, objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")


def armature_mod(o, rig):
    o.parent = rig
    o.matrix_parent_inverse = rig.matrix_world.inverted()
    m = o.modifiers.get("Armature") or o.modifiers.new("Armature", "ARMATURE")
    m.object = rig
    # Kenny: Armature FIRST in the stack
    if o.modifiers.find(m.name) > 0:
        o.modifiers.move(o.modifiers.find(m.name), 0)


def rigid_to_head(rig, o, bone="Head"):
    for g in list(o.vertex_groups):
        o.vertex_groups.remove(g)
    g = o.vertex_groups.new(name=bone)
    g.add(range(len(o.data.vertices)), 1.0, "REPLACE")
    armature_mod(o, rig)


def transfer_from(body, rig, o):
    for g in list(o.vertex_groups):
        o.vertex_groups.remove(g)
    for g in body.vertex_groups:
        o.vertex_groups.new(name=g.name)
    dt = o.modifiers.new("WeightTransfer", "DATA_TRANSFER")
    dt.object = body
    dt.use_vert_data = True
    dt.data_types_verts = {"VGROUP_WEIGHTS"}
    dt.vert_mapping = "POLYINTERP_NEAREST"
    dt.layers_vgroup_select_src = "ALL"
    dt.layers_vgroup_select_dst = "NAME"
    bpy.context.view_layer.objects.active = o
    o.modifiers.move(o.modifiers.find(dt.name), 0)
    bpy.ops.object.modifier_apply(modifier=dt.name)
    armature_mod(o, rig)


def limit_weights(o, rig, n):
    names = {b.name for b in rig.data.bones}
    gname = {g.index: g.name for g in o.vertex_groups}
    stats = {"max_before": 0, "unweighted": 0}
    for v in o.data.vertices:
        ws = [(g.group, g.weight) for g in v.groups if gname.get(g.group) in names and g.weight > 0]
        stats["max_before"] = max(stats["max_before"], len(ws))
        ws.sort(key=lambda t: -t[1])
        keep = [(gi, w) for gi, w in ws[:n] if w >= 0.01]
        tot = sum(w for _, w in keep)
        if tot <= 0:
            stats["unweighted"] += 1
            continue
        for gi, _ in ws:
            o.vertex_groups[gi].remove([v.index])
        for gi, w in keep:
            o.vertex_groups[gi].add([v.index], w / tot, "REPLACE")
    for g in list(o.vertex_groups):  # drop groups that are not bones (shell/rim/pattern) from the export
        if g.name not in names:
            o.vertex_groups.remove(g)
    return stats


def pose_test(rig):
    act = bpy.data.actions.new("QA_pose_test")
    rig.animation_data_create()
    rig.animation_data.action = act
    pb = rig.pose.bones
    # world-axis degrees (character faces -Y, left arm on +X): arms down about Y, elbows bend forward about Z,
    # left thigh up/forward and knee back about X, head TURN about Z, slight forward lean
    rot = {"LeftUpperArm": (0, 35, 0), "RightUpperArm": (0, -35, 0), "LeftLowerArm": (0, 0, -80),
           "RightLowerArm": (0, 0, 80), "LeftUpperLeg": (-35, 0, 0), "LeftLowerLeg": (60, 0, 0),
           "RightUpperLeg": (10, 0, 0), "Head": (0, 0, 25), "Spine": (-8, 0, 0), "Neck": (-5, 0, 0)}
    for n, (x, y, z) in rot.items():
        if n in pb:
            b = pb[n]
            b.rotation_mode = "XYZ"
            # rotate in ARMATURE space axes so the test is the same whatever the bone roll
            m = Matrix.Rotation(math.radians(x), 4, "X") @ Matrix.Rotation(math.radians(y), 4, "Y") @ \
                Matrix.Rotation(math.radians(z), 4, "Z")
            rest = b.bone.matrix_local.to_3x3().to_4x4()
            b.rotation_euler = (rest.inverted() @ m @ rest).to_euler("XYZ")
            b.keyframe_insert("rotation_euler", frame=1)


def main():
    args = parse()
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.blend))
    body, head, hands, auto, rigid, cloth = classify(args)
    # a body cut under the clothes (--cut-body) has no legs or torso left to measure or to copy weights from:
    # use a temporary, weighted copy of the uncut REF-<body> for both
    ref = bpy.data.objects.get("REF-" + body.name)
    src = body
    if ref is not None:
        src = bpy.data.objects.new("QA_weight_src", ref.data.copy())
        src.matrix_world = ref.matrix_world.copy()
        bpy.context.scene.collection.objects.link(src)
    L = landmarks(src, hands, head)
    rig = build_rig(args, L, hands)
    parent_auto(rig, auto + ([src] if src is not body else []))
    extra = dict(kv.split(":") for kv in (args.rigid or "").split(",") if kv)
    for o in rigid:
        # props (a sword in the hand, goggles, a holster on the hip) move as one piece with their bone
        bone = next((b for k, b in extra.items() if k in o.name.lower()), "Head")
        rigid_to_head(rig, o, bone)
    # groom curves (and their hidden scalps) can't be skinned: bone-parent them to Head so they follow it
    for o in bpy.context.scene.objects:
        if (o.type == "CURVES" or (o.type == "MESH" and "scalp" in o.name.lower())) and o.parent is None:
            mw = o.matrix_world.copy()
            o.parent = rig
            o.parent_type = "BONE"
            o.parent_bone = "Head"
            o.matrix_world = mw
    for o in cloth:
        transfer_from(src, rig, o)
    if src is not body:
        bpy.data.objects.remove(src, do_unlink=True)
    rep = {}
    for o in auto + rigid + cloth:
        rep[o.name] = limit_weights(o, rig, args.max_influences)
    print(f"{rig.name}: {len(rig.data.bones)} deform bones")
    print("auto:", [o.name for o in auto], "rigid:", [o.name for o in rigid], "transfer:", [o.name for o in cloth])
    for n, s in rep.items():
        flag = "  <-- UNWEIGHTED VERTS" if s["unweighted"] else ""
        print(f"  {n}: max influences before limit {s['max_before']}, unweighted {s['unweighted']}{flag}")
    if args.out:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.out))
    if args.glb:
        os.makedirs(os.path.dirname(os.path.abspath(args.glb)), exist_ok=True)
        bpy.ops.object.select_all(action="DESELECT")
        for o in [rig] + auto + rigid + cloth:
            o.select_set(True)
        bpy.ops.export_scene.gltf(filepath=os.path.abspath(args.glb), export_format="GLB", use_selection=True,
                                  export_apply=True, export_skins=True, export_def_bones=False,
                                  export_animations=False, export_yup=True, export_morph=True)
        print("exported", args.glb)
    if args.fbx:
        os.makedirs(os.path.dirname(os.path.abspath(args.fbx)), exist_ok=True)
        bpy.ops.object.select_all(action="DESELECT")
        for o in [rig] + auto + rigid + cloth:
            o.select_set(True)
        bpy.ops.export_scene.fbx(filepath=os.path.abspath(args.fbx), use_selection=True, object_types={"ARMATURE", "MESH"},
                                 add_leaf_bones=False, use_armature_deform_only=True, bake_anim=False,
                                 apply_scale_options="FBX_SCALE_ALL", mesh_smooth_type="FACE", path_mode="COPY",
                                 embed_textures=True)
        print("exported", args.fbx)
    if args.pose_test:
        pose_test(rig)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.pose_test), copy=True)
        print("pose test saved:", args.pose_test)


if __name__ == "__main__":
    main()
