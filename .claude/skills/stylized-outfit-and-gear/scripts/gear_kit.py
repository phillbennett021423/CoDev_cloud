"""Gear kit: the hard-surface and strap pieces Kenny adds after the clothes (outfit chapters), as functions that
measure the body instead of being placed by hand. Import it from a character build script:

    sys.path.insert(0, "<skills>/stylized-outfit-and-gear/scripts"); import gear_kit as gk
    gk.strap_on(target, [(x, y, z), ...], width=0.03, thick=0.006, name="GEO-strap", mat=gk.mat_metal(...))
    gk.limb_ring(ref, a, b, t0=0.6, t1=0.9, pad=0.012, name="GEO-bracer.L", mat=...)   # bracers, thigh straps
    gk.rounded_box(center, size, name, mat, normal=None, bevel=0.01)                      # pads, pockets, plates
    gk.limb_axis(ref, side, part="arm"|"leg")                                            # measured axis of a limb

Every strap point is SNAPPED to the target surface (nearest point + normal x offset), so straps follow the jacket
instead of floating or clipping (Kenny: straps are curves snapped to the surface with a rectangular bevel).
Run the 4-view QA after each gear pass; magenta at a strap means raise its offset.
"""
import math

import bpy
import bmesh
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree


# ---------- materials ----------
def _mat(name):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    return m, m.node_tree.nodes["Principled BSDF"]


def mat_basic(name, color, rough=0.5, metal=0.0, sheen=0.0):
    m, b = _mat(name)
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if sheen:
        b.inputs["Sheen Weight"].default_value = sheen
    return m


def mat_metal(name, color, rough=0.3):
    return mat_basic(name, color, rough, 1.0)


def mat_glow(name, color, strength=8.0):
    m, b = _mat(name)
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Emission Color"].default_value = (*color, 1)
    b.inputs["Emission Strength"].default_value = strength
    b.inputs["Roughness"].default_value = 0.3
    return m


def mat_glow_gradient(name, c0, c1, axis="Z", strength=8.0):
    """emissive gradient along an object axis (the katana blade: blue at the guard, purple at the tip)"""
    m, b = _mat(name)
    nt = m.node_tree
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (*c0, 1)
    ramp.color_ramp.elements[1].color = (*c1, 1)
    nt.links.new(sep.outputs[axis], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], b.inputs["Base Color"])
    nt.links.new(ramp.outputs[0], b.inputs["Emission Color"])
    b.inputs["Emission Strength"].default_value = strength
    b.inputs["Roughness"].default_value = 0.15
    b.inputs["Metallic"].default_value = 0.6
    return m


# ---------- helpers ----------
def _link(ob, like=None):
    coll = like.users_collection[0] if like else bpy.context.scene.collection
    coll.objects.link(ob)
    return ob


def _bvh(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.transform(obj.matrix_world)
    bm.normal_update()
    tree = BVHTree.FromBMesh(bm)
    ev.to_mesh_clear()
    return tree, bm


def _finish(bm, name, mat, like=None, smooth=True):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if mat:
        me.materials.append(mat)
    for p in me.polygons:
        p.use_smooth = smooth
    return _link(bpy.data.objects.new(name, me), like)


def densify(pts, step):
    out = []
    for a, b in zip(pts, pts[1:]):
        a, b = Vector(a), Vector(b)
        n = max(1, int((b - a).length / step))
        out += [a.lerp(b, i / n) for i in range(n)]
    out.append(Vector(pts[-1]))
    return out


def snap(tree, p, off):
    loc, nrm, _, _ = tree.find_nearest(Vector(p))
    if loc is None:
        return Vector(p), Vector((0, 0, 1))
    return loc + nrm * off, nrm


# ---------- pieces ----------
def strap_on(target, pts, width=0.03, thick=0.006, off=0.006, name="GEO-strap", mat=None, step=0.012, relax=3,
             closed=False):
    """a flat strap that follows the target surface through the given points (world space)"""
    tree, bmt = _bvh(target)
    path = densify(list(pts) + ([pts[0]] if closed else []), step)
    snapped = [snap(tree, p, off) for p in path]
    P = [s[0] for s in snapped]
    N = [s[1] for s in snapped]
    for _ in range(relax):  # smooth the snapped path, then re-snap (no zig-zag over the cloth folds)
        P = [P[0]] + [(P[i - 1] + P[i] * 2 + P[i + 1]) / 4 for i in range(1, len(P) - 1)] + [P[-1]]
        snapped = [snap(tree, p - n * off, off) for p, n in zip(P, N)]
        P = [s[0] for s in snapped]
        N = [s[1] for s in snapped]
    bmt.free()
    bm = bmesh.new()
    rows = []
    for i, (p, n) in enumerate(zip(P, N)):
        t = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized()
        side = t.cross(n).normalized() * width / 2
        rows.append([bm.verts.new(p + side), bm.verts.new(p - side),
                     bm.verts.new(p - side + n * thick), bm.verts.new(p + side + n * thick)])
    for a, b in zip(rows, rows[1:]):
        for k in range(4):
            bm.faces.new((a[k], a[(k + 1) % 4], b[(k + 1) % 4], b[k]))
    if not closed:
        bm.faces.new(rows[0][::-1])
        bm.faces.new(rows[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return _finish(bm, name, mat, target, smooth=False)


def limb_axis(ref, side=1, part="arm"):
    """principal axis of one limb of the (uncut) reference body: returns (start, end) world points.
    arm = verts beyond the shoulder in |x|; leg = verts below the crotch on one side."""
    mw = ref.matrix_world
    vs = [mw @ v.co for v in ref.data.vertices]
    zmax = max(v.z for v in vs)
    if part == "arm":
        sel = [v for v in vs if v.x * side > 0.105 * zmax and v.z > 0.45 * zmax]
    else:
        sel = [v for v in vs if v.x * side > 0.01 and v.z < 0.45 * zmax and v.z > 0.06 * zmax]
    c = sum(sel, Vector()) / len(sel)
    # power iteration on the covariance for the main direction
    d = Vector((side, 0, -1)).normalized() if part == "arm" else Vector((0, 0, -1))
    for _ in range(20):
        acc = Vector()
        for v in sel:
            q = v - c
            acc += q * q.dot(d)
        d = acc.normalized()
    proj = [(v - c).dot(d) for v in sel]
    a, b = c + d * min(proj), c + d * max(proj)
    if part == "arm" and a.z < b.z:  # start at the shoulder
        a, b = b, a
    if part == "leg" and a.z < b.z:  # start at the hip
        a, b = b, a
    return a, b


def limb_ring(ref, a, b, t0, t1, pad=0.01, name="GEO-ring", mat=None, seg=24, rows=4, flare=0.0, like=None):
    """a band around a limb between fractions t0..t1 of the axis a->b, radius measured by ray casts from the axis
    (bracers, thigh straps, cuffs). flare widens the far end (bracer cuffs)."""
    tree, bmt = _bvh(ref)
    d = (b - a).normalized()
    up = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((0, 1, 0))
    u = d.cross(up).normalized()
    w = d.cross(u).normalized()
    bm = bmesh.new()
    grid = []
    for r in range(rows + 1):
        t = t0 + (t1 - t0) * r / rows
        c = a.lerp(b, t)
        ring = []
        for k in range(seg):
            ang = 2 * math.pi * k / seg
            dirv = u * math.cos(ang) + w * math.sin(ang)
            # from the axis OUTWARD: the first hit is this limb's own surface, never the other leg or the torso
            hit = tree.ray_cast(c + dirv * 0.001, dirv, 0.3)
            rad = (hit[0] - c).length if hit[0] is not None else 0.05
            ring.append(rad)
        # smooth the radius around the ring (no dents from the body's facets)
        ring = [(ring[k - 1] + 2 * ring[k] + ring[(k + 1) % seg]) / 4 for k in range(seg)]
        grow = pad + flare * (r / rows)
        grid.append([bm.verts.new(c + (u * math.cos(2 * math.pi * k / seg) + w * math.sin(2 * math.pi * k / seg))
                                  * (ring[k] + grow)) for k in range(seg)])
    bmt.free()
    for g0, g1 in zip(grid, grid[1:]):
        for k in range(seg):
            bm.faces.new((g0[k], g0[(k + 1) % seg], g1[(k + 1) % seg], g1[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ob = _finish(bm, name, mat, like or ref)
    so = ob.modifiers.new("Solidify", "SOLIDIFY")
    so.thickness = 0.008
    so.offset = 1
    bv = ob.modifiers.new("Bevel", "BEVEL")
    bv.width = 0.002
    bv.segments = 2
    bv.limit_method = "ANGLE"
    return ob


def rounded_box(center, size, name, mat=None, normal=None, up=(0, 0, 1), bevel=0.008, like=None, segs=3):
    """a bevelled box; with normal, its local Z faces along normal (pads, pockets, plates, buckles)"""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    ob = _finish(bm, name, mat, like)
    if normal is not None:
        n = Vector(normal).normalized()
        upv = Vector(up)
        x = upv.cross(n).normalized() if abs(upv.dot(n)) < 0.99 else Vector((1, 0, 0))
        y = n.cross(x).normalized()
        ob.matrix_world = Matrix((x, y, n)).transposed().to_4x4()
    ob.location = Vector(center)
    if bevel:
        bv = ob.modifiers.new("Bevel", "BEVEL")
        bv.width = bevel
        bv.segments = segs
    return ob


def pad_on(target, point, size, name, mat=None, off=0.004, bevel=0.01, like=None, bulge=0.4):
    """a pad (knee pad, pocket, plate) snapped onto the target surface at point, facing out along its normal,
    curved to follow the surface (Kenny: plates are bent with Simple Deform / shrinkwrapped, not flat)"""
    tree, bmt = _bvh(target)
    loc, nrm = snap(tree, point, off + size[2] / 2)
    bmt.free()
    ob = rounded_box(loc, size, name, mat, normal=nrm, bevel=bevel, like=like or target)
    inner = ob.vertex_groups.new(name="inner")  # the half facing the body hugs it; the outer face keeps its shape
    inner.add([v.index for v in ob.data.vertices if v.co.z < 0], 1.0, "REPLACE")
    shr = ob.modifiers.new("Shrinkwrap", "SHRINKWRAP")
    shr.target = target
    shr.wrap_method = "PROJECT"
    shr.use_project_z = True
    shr.use_negative_direction = True
    shr.use_positive_direction = True
    shr.wrap_mode = "OUTSIDE_SURFACE"
    shr.offset = off
    shr.vertex_group = inner.name
    ob.modifiers.move(len(ob.modifiers) - 1, 0)  # before the bevel
    return ob


def apply_all(ob):
    bpy.context.view_layer.objects.active = ob
    for m in list(ob.modifiers):
        try:
            bpy.ops.object.modifier_apply(modifier=m.name)
        except RuntimeError:
            ob.modifiers.remove(m)
