"""Kenny Praise posing rules as presets on the humanoid game skeleton (masterclass ch. 12, posing half).

Kenny: posing matters more than the rig. Find the LINE OF ACTION and the BALANCE (weight over the support
foot); exaggerate past the reference for stylized work; never mirror arms or legs; CONTRAPPOSTO = weight on one
leg, hips tilt one way, shoulders the opposite way, one side of the torso stretches, the other compresses. Make at
least 2 poses for the final renders. Poses are stored as actions (Kenny saves Pose Assets).

Angles are WORLD-axis degrees on the rest pose (character faces -Y, its left arm on +X):
  X = pitch (thigh forward is negative), Y = roll (left arm down is positive), Z = yaw / turn.
    python pose_presets.py -- --blend hero_rig.blend --pose contrapposto --out hero_pose_idle.blend
    python pose_presets.py -- --blend hero_rig.blend --pose all --out-dir poses/   (one file per pose)
"""
import argparse
import math
import os
import sys

import bpy
from mathutils import Matrix

POSES = {
    # weight on the RIGHT leg: hips drop to the left, shoulders tilt the opposite way, head counters again
    "contrapposto": {
        # pelvis drops on the FREE (left) side, chest counters (left shoulder up), head counters again
        "Hips": (0, 5, 8), "Spine": (0, -3, -3), "Chest": (0, -4, -4), "Neck": (0, 2, 2), "Head": (-4, 3, 10),
        "RightUpperLeg": (0, -5, 0),                                   # support leg stays vertical
        "LeftUpperLeg": (-12, -3, 8), "LeftLowerLeg": (24, 0, 0), "LeftFoot": (-8, 0, 12),  # free leg relaxed
        "LeftUpperArm": (6, 50, 0), "LeftLowerArm": (-30, 0, 0), "LeftHand": (-10, 0, 0),
        "RightUpperArm": (-4, -42, 6), "RightLowerArm": (-14, 0, 0), "RightHand": (0, 0, 8),
    },
    # wide, grounded, chest up, fists low: reads strong in silhouette
    "hero_stance": {
        "Hips": (0, 0, -5), "Spine": (6, 0, 3), "Chest": (8, 0, 4), "Head": (-6, 0, -8),
        "LeftUpperLeg": (0, -12, -10), "LeftLowerLeg": (6, 0, 0), "RightUpperLeg": (-4, 12, 8),
        "RightLowerLeg": (8, 0, 0), "LeftFoot": (0, 0, -12), "RightFoot": (0, 0, 12),
        "LeftUpperArm": (4, 50, -6), "LeftLowerArm": (-28, 0, 0), "RightUpperArm": (-6, -48, 10),
        "RightLowerArm": (-32, 0, 0),
    },
    # line of action in a forward C-curve, weight on the front (left) foot, arms in opposition to the legs
    "action_lunge": {
        "_hips_drop": 0.09,  # fraction of height: no IK here, so lower the pelvis until the support foot is planted
        "Hips": (-10, 0, 15), "Spine": (-12, 0, 5), "Chest": (-10, 0, 8), "Neck": (8, 0, 0), "Head": (12, 0, -10),
        "LeftUpperLeg": (-60, 0, 8), "LeftLowerLeg": (75, 0, 0), "LeftFoot": (-15, 0, 0),
        "RightUpperLeg": (30, 0, -5), "RightLowerLeg": (25, 0, 0),
        "LeftUpperArm": (35, 45, 0), "LeftLowerArm": (-50, 0, 0), "RightUpperArm": (-45, -40, 0),
        "RightLowerArm": (-40, 0, 0),
    },
    # NOTE: lower-arm bends are about X (forward) because the upper arms are already rotated DOWN first
    # neutral game bind check: arms down, nothing else (deformation baseline)
    "arms_down": {"LeftUpperArm": (0, 40, 0), "RightUpperArm": (0, -40, 0)},
}


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--blend")
    p.add_argument("--rig", default=None, help="armature object (default: the first armature)")
    p.add_argument("--pose", default="contrapposto", help="preset name or 'all'")
    p.add_argument("--scale", type=float, default=1.0, help="exaggeration multiplier (Kenny: push past the reference)")
    p.add_argument("--out")
    p.add_argument("--out-dir")
    return p.parse_args(argv)


def apply_pose(rig, name, table, scale):
    act = bpy.data.actions.new(f"POSE-{name}")
    rig.animation_data_create()
    rig.animation_data.action = act
    for b in rig.pose.bones:
        b.rotation_mode = "XYZ"
        b.rotation_euler = (0, 0, 0)
        b.location = (0, 0, 0)
    if table.get("_hips_drop") and "Hips" in rig.pose.bones:
        hb = rig.pose.bones["Hips"]
        h = max(v[2] for v in (b.tail_local for b in rig.data.bones))
        world = Matrix.Translation((0, 0, -table["_hips_drop"] * h))
        # world translation -> the Hips bone's local axes
        hb.location = hb.bone.matrix_local.to_3x3().inverted() @ world.translation
        hb.keyframe_insert("location", frame=1)
    # parents first, so children are posed in their parent's posed space (world-axis intent stays true)
    order = sorted(rig.pose.bones, key=lambda b: len(b.parent_recursive))
    for b in order:
        if b.name not in table or b.name.startswith("_"):
            continue
        x, y, z = (math.radians(a * scale) for a in table[b.name])
        m = Matrix.Rotation(z, 4, "Z") @ Matrix.Rotation(y, 4, "Y") @ Matrix.Rotation(x, 4, "X")
        bpy.context.view_layer.update()
        cur = (rig.matrix_world @ b.matrix).to_3x3().normalized()
        target = m.to_3x3() @ cur
        par = (rig.matrix_world @ b.parent.matrix).to_3x3().normalized() if b.parent else rig.matrix_world.to_3x3()
        rest_rel = (b.parent.bone.matrix_local.to_3x3().inverted() @ b.bone.matrix_local.to_3x3()) if b.parent \
            else b.bone.matrix_local.to_3x3()
        local = (par @ rest_rel).inverted() @ target
        b.rotation_euler = local.to_euler("XYZ")
        b.keyframe_insert("rotation_euler", frame=1)
    bpy.context.view_layer.update()
    return act


def main():
    args = parse()
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.blend))
    rig = bpy.data.objects.get(args.rig) if args.rig else next(o for o in bpy.data.objects if o.type == "ARMATURE")
    names = sorted(POSES) if args.pose == "all" else [args.pose]
    for n in names:
        apply_pose(rig, n, POSES[n], args.scale)
        path = args.out if (args.out and len(names) == 1) else os.path.join(args.out_dir or ".", f"pose_{n}.blend")
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(path), copy=True)
        print("posed", n, "->", path)


if __name__ == "__main__":
    main()
