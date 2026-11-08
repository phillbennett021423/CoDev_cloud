"""Tests for skin_fit (plain numpy, no Blender): python -m unittest desktop/creative/bpy/test_skin_fit.py"""
import os
import sys
import unittest
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import skin_fit as sf  # noqa: E402


def tube(r, y0, y1, n=24, rings=20, cap=False):
    """A cylinder around the Y axis (open ends), as triangles."""
    V, F = [], []
    for i in range(rings + 1):
        y = y0 + (y1 - y0) * i / rings
        for j in range(n):
            a = 2 * np.pi * j / n
            V.append((r * np.cos(a), y, r * np.sin(a)))
    for i in range(rings):
        for j in range(n):
            a, b = i * n + j, i * n + (j + 1) % n
            c, d = a + n, b + n
            F += [(a, b, d), (a, d, c)]
    return np.array(V, float), np.array(F)


def nearest_on_vertices(P, V, VN):
    """Stand-in for Blender's BVH: nearest body vertex (exact enough on a dense tube)."""
    d = np.linalg.norm(P[:, None] - V[None], axis=2)
    k = d.argmin(1)
    return V[k], VN[k], k, d[np.arange(len(P)), k]


class SkinFitTest(unittest.TestCase):
    def setUp(self):
        # an "arm": two bones along +Y (upper arm, forearm) plus a hand bone at the end
        self.names = ["LeftArm", "LeftForeArm", "LeftHand", "LeftHandIndex1"]
        self.parents = [-1, 0, 1, 2]
        self.heads = np.array([[0, 0, 0], [0, 0.3, 0], [0, 0.6, 0], [0, 0.68, 0]], float)
        self.tails = np.array([[0, 0.3, 0], [0, 0.6, 0], [0, 0.68, 0], [0, 0.72, 0]], float)
        self.BV, self.BF = tube(0.05, 0.0, 0.72, rings=36)
        y = self.BV[:, 1]
        W = np.zeros((len(self.BV), 4))
        W[:, 0] = np.clip((0.35 - y) / 0.1, 0, 1)
        W[:, 2] = np.clip((y - 0.6) / 0.04, 0, 1) * (y < 0.68)
        W[:, 3] = (y >= 0.68).astype(float)
        W[:, 1] = np.clip(1 - W[:, 0] - W[:, 2] - W[:, 3], 0, 1)
        self.BW = W / W.sum(1, keepdims=True)
        c = self.BV.copy()
        c[:, 1] = 0
        self.BN = c / np.linalg.norm(c, axis=1, keepdims=True)

    def transfer(self, CV, CF):
        q, n, k, d = nearest_on_vertices(CV, self.BV, self.BN)
        # vertex k as a point on one of its triangles
        face = np.array([np.where((self.BF == i).any(1))[0][0] for i in k])
        bary = np.array([(self.BF[f] == i).astype(float) for f, i in zip(face, k)])
        CN = sf.vertex_normals(CV, CF)
        return sf.robust_transfer(CV, CF, CN, q, n, face, bary, self.BF, self.BW, max_dist=0.03)

    def test_weld_merges_seams(self):
        V = np.array([[0, 0, 0], [1, 0, 0], [0, 0, 0], [1, 0, 0]], float)
        ids = sf.weld(V)
        self.assertEqual(ids[0], ids[2])
        self.assertEqual(ids[1], ids[3])

    def test_bone_roles(self):
        self.assertEqual(sf.bone_role("mixamorig:LeftForeArm"), ("left", "forearm"))
        self.assertEqual(sf.bone_role("RightHandIndex2"), ("right", "finger"))
        self.assertEqual(sf.bone_role("LeftArmHelper"), ("left", "upperarm"))
        self.assertEqual(sf.bone_role("spine_02"), ("", "chest"))
        self.assertEqual(sf.bone_role("thigh_l"), ("left", "thigh"))

    def test_slot_guess(self):
        self.assertEqual(sf.slot_for("Prakan_work_jacket"), "torso")
        self.assertEqual(sf.slot_for("boot_L"), "feet")
        self.assertEqual(sf.slot_for("handwrap_R"), "hands")
        self.assertEqual(sf.slot_for("waist_sash"), "waist")
        self.assertEqual(sf.slot_for("cargo_pants"), "legs")
        self.assertEqual(sf.slot_for("thing", "head"), "head")

    def test_sleeve_follows_arm_never_fingers(self):
        # a loose sleeve over the arm whose cuff hangs past the wrist, beside the hand
        CV, CF = tube(0.065, 0.02, 0.66, rings=30)
        W, matched = self.transfer(CV, CF)
        ok = sf.allowed(self.names, "torso", "left")
        self.assertFalse(ok[3])  # fingers are not allowed for a jacket
        W, _ = sf.limit_to_allowed(W, self.parents, ok)
        W = sf.top_k(W, 4)
        np.testing.assert_allclose(W.sum(1), 1, atol=1e-6)
        self.assertEqual(W[:, 3].max(), 0)  # never the finger
        self.assertEqual(W[:, 2].max(), 0)  # hand isn't allowed for a jacket either: goes to the forearm
        cuff = CV[:, 1] > 0.6
        self.assertGreater(W[cuff, 1].mean(), 0.9)  # the cuff follows the forearm
        top = CV[:, 1] < 0.1
        self.assertGreater(W[top, 0].mean(), 0.9)

    def test_far_cloth_is_filled_smoothly(self):
        # a flared cuff far from the body gets no direct match but smooth weights
        CV, CF = tube(0.065, 0.02, 0.5, rings=24)
        flare = CV[:, 1] > 0.4
        CV[flare, 0] *= 2.5
        CV[flare, 2] *= 2.5
        W, matched = self.transfer(CV, CF)
        self.assertFalse(matched[flare].all())
        self.assertTrue(np.isfinite(W).all())
        np.testing.assert_allclose(W.sum(1), 1, atol=1e-6)
        # neighbours along the sleeve change smoothly
        ys = np.round(CV[:, 1], 3)
        rows = [W[ys == y].mean(0) for y in np.unique(ys)]
        jumps = np.abs(np.diff(np.array(rows), axis=0)).max()
        self.assertLess(jumps, 0.35)

    def test_push_out_moves_cloth_outside(self):
        CV, CF = tube(0.048, 0.1, 0.5, rings=16)  # inside the 5 cm arm
        q, n, _, _ = nearest_on_vertices(CV, self.BV, self.BN)
        sd = np.einsum("ij,ij->i", CV - q, n)
        self.assertTrue((sd < 0).all())
        V2, moved = sf.push_out(CV, CF, sd, n, margin=0.004)
        self.assertEqual(moved, len(np.unique(sf.weld(CV))))
        r = np.linalg.norm(V2[:, [0, 2]], axis=1)
        self.assertTrue((r >= 0.0535).all())

    def test_covered_faces_and_sync(self):
        cov = self.BV[:, 1] < 0.5
        hide = sf.covered_faces(self.BF, cov, erode=1)
        ys = self.BV[self.BF][:, :, 1].max(1)
        self.assertTrue(hide[ys < 0.4].all())
        self.assertFalse(hide[ys > 0.5].any())
        Wi = np.tile([1.0, 0, 0, 0], (len(self.BV), 1))
        Wo = np.tile([0, 1.0, 0, 0], (len(self.BV), 1))
        Ws = sf.sync_layer(self.BV, self.BF, Wi, cov, Wo)
        self.assertTrue((Ws[cov, 1] > 0.99).all())
        self.assertTrue((Ws[self.BV[:, 1] > 0.65, 0] > 0.99).all())

    def test_layer_order_uses_overlap(self):
        order = sf.layer_order(["jacket", "armband", "shirt"], [0.03, 0.005, 0.01],
                               {("armband", "jacket"): True, ("jacket", "armband"): False})
        self.assertLess(order.index("shirt"), order.index("jacket"))
        self.assertLess(order.index("jacket"), order.index("armband"))

    def test_pose_bends_and_skins(self):
        D = sf.pose_deltas(self.names, self.parents, self.heads, self.tails,
                           [("forearm", "*", "bend", 90)], up=(0, 1, 0), front=(0, 0, 1))
        np.testing.assert_allclose(D[0], np.eye(4), atol=1e-9)  # upper arm unchanged
        tip = (D[1] @ np.append(self.tails[1], 1))[:3]
        self.assertAlmostEqual(np.linalg.norm(tip - self.heads[1]), 0.3, places=6)  # length kept
        Vp = sf.skin(self.BV, self.BW, D)
        self.assertTrue(np.isfinite(Vp).all())
        self.assertLess(np.abs(Vp[self.BV[:, 1] < 0.2] - self.BV[self.BV[:, 1] < 0.2]).max(), 1e-9)

    def test_helper_turns_half(self):
        names = ["LeftShoulder", "LeftArm", "LeftArmHelper", "LeftForeArm"]
        parents = [-1, 0, 0, 1]
        heads = np.array([[0, 1.4, 0], [0.18, 1.4, 0], [0.18, 1.4, 0], [0.45, 1.2, 0]], float)
        tails = np.array([[0.18, 1.4, 0], [0.45, 1.2, 0], [0.45, 1.2, 0], [0.6, 1.0, 0]], float)
        D = sf.pose_deltas(names, parents, heads, tails, [("upperarm", "*", "raise", 80)], up=(0, 1, 0), front=(0, 0, 1))
        ang = lambda R: np.degrees(np.arccos(np.clip((np.trace(R[:3, :3]) - 1) / 2, -1, 1)))
        self.assertAlmostEqual(ang(D[1]), 80, places=3)
        self.assertAlmostEqual(ang(D[2]), 40, places=3)

    def test_poke_report(self):
        r = sf.poke_report([0.0, 0.01, -0.02, 0.005], [True, True, True, False], tol=0.003)
        self.assertEqual(r["checked"], 3)
        self.assertEqual(r["poking"], 1)
        self.assertEqual(r["worst_mm"], 10.0)


if __name__ == "__main__":
    unittest.main()
