"""Skin fitting core: everything that puts a cosmetic on a rigged character well.

Pure numpy, so the same code runs inside Blender (asset_pipeline.py feeds it what
Blender's BVH trees find) and in plain Python tests. Nothing here imports bpy.

  weld                 one id per position, so UV seams don't split the mesh graph
  slot_for / allowed   which bones a cosmetic slot may follow (a jacket never follows
                       the fingers, a left boot never follows the right leg)
  limit_to_allowed     moves a weight on a forbidden bone to its nearest allowed ancestor
  robust_transfer      skin weights from the body: copied where the cloth sits on the body
                       (close and facing the same way), smoothly filled in everywhere else
                       (Abdrashitov et al., "Robust Skin Weights Transfer via Weight
                       Inpainting", SIGGRAPH Asia 2023), so a jacket hem hanging next to
                       the hands never copies the hand's weights
  rigid_weights        everything on one bone, for hard pieces (armour plates, helmets)
  push_out             moves cloth that sits inside or too close to the body outward,
                       spreading the move so the cloth stays smooth
  covered_faces        body faces hidden under the cloth, so skin can't poke through
  skin                 linear blend skinning, for posed checks
  poke_report          how much body (or inner layer) shows through the cloth in a pose
"""
import re
import numpy as np

# ---------- mesh graph ----------


def weld(V, eps=None):
    """ids[i] = welded vertex of V[i]; vertices at the same spot share an id."""
    V = np.asarray(V, float)
    if eps is None:
        span = float(np.ptp(V, axis=0).max()) if len(V) else 1.0
        eps = max(span, 1e-6) * 1e-5
    key = np.round(V / eps).astype(np.int64)
    _, ids = np.unique(key, axis=0, return_inverse=True)
    return ids.reshape(-1)


def edges(F, ids=None):
    """Unique undirected edges of a triangle list (on welded ids when given)."""
    F = np.asarray(F, np.int64)
    if ids is not None:
        F = ids[F]
    E = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    E = np.sort(E, axis=1)
    E = E[E[:, 0] != E[:, 1]]
    return np.unique(E, axis=0)


def welded_positions(V, ids):
    n = int(ids.max()) + 1 if len(ids) else 0
    P = np.zeros((n, 3))
    c = np.zeros(n)
    np.add.at(P, ids, V)
    np.add.at(c, ids, 1)
    return P / np.maximum(c, 1)[:, None]


class Graph:
    """Edge-length weighted graph Laplacian on welded vertices, with fast mat-vecs."""

    def __init__(self, P, E):
        self.n = len(P)
        self.E = E
        ln = np.linalg.norm(P[E[:, 0]] - P[E[:, 1]], axis=1)
        self.w = 1.0 / np.maximum(ln, np.median(ln) * 1e-3 if len(ln) else 1e-6)
        self.deg = np.zeros(self.n)
        np.add.at(self.deg, E[:, 0], self.w)
        np.add.at(self.deg, E[:, 1], self.w)

    def adj(self, X):
        """sum_j w_ij X_j for every i (X: n or n x k)."""
        out = np.zeros_like(X, dtype=float)
        w = self.w if X.ndim == 1 else self.w[:, None]
        np.add.at(out, self.E[:, 0], w * X[self.E[:, 1]])
        np.add.at(out, self.E[:, 1], w * X[self.E[:, 0]])
        return out

    def average(self, X):
        d = np.maximum(self.deg, 1e-12)
        return self.adj(X) / (d if X.ndim == 1 else d[:, None])

    def components(self):
        lab = np.arange(self.n)
        for _ in range(self.n):
            a, b = lab[self.E[:, 0]], lab[self.E[:, 1]]
            m = np.minimum(a, b)
            new = lab.copy()
            np.minimum.at(new, self.E[:, 0], m)
            np.minimum.at(new, self.E[:, 1], m)
            new = new[new]
            if np.array_equal(new, lab):
                break
            lab = new
        return lab


def harmonic_fill(G, X, known, iters=600, tol=1e-6):
    """Solve L X_u = 0 with X fixed where known (conjugate gradients, all columns at once).

    The filled values are the smoothest blend of the known ones across the surface."""
    X = np.array(X, float)
    u = ~known
    if not u.any() or not known.any():
        return X
    d = G.deg

    def Luu(Y):  # (D - A) restricted to unknowns, Y lives on unknowns
        full = np.zeros((G.n,) + Y.shape[1:])
        full[u] = Y
        return (d[u][:, None] * Y) - G.adj(full)[u]

    known_only = np.where(known[:, None], X, 0.0)
    b = G.adj(known_only)[u]
    Y = G.average(np.where(known[:, None], X, 0.0))[u]  # warm start
    r = b - Luu(Y)
    M = 1.0 / np.maximum(d[u], 1e-12)[:, None]
    z = M * r
    p = z.copy()
    rz = (r * z).sum(0)
    b_norm = np.maximum(np.linalg.norm(b, axis=0), 1e-12)
    for _ in range(iters):
        Ap = Luu(p)
        alpha = rz / np.maximum((p * Ap).sum(0), 1e-30)
        Y += alpha * p
        r -= alpha * Ap
        if (np.linalg.norm(r, axis=0) / b_norm).max() < tol:
            break
        z = M * r
        rz_new = (r * z).sum(0)
        p = z + (rz_new / np.maximum(rz, 1e-30)) * p
        rz = rz_new
    X[u] = Y
    return X


# ---------- bones and slots ----------

SIDE_PATTERNS = [(r"(^|[._ -])l($|[._ -])|left", "left"), (r"(^|[._ -])r($|[._ -])|right", "right")]
ROLE_NAMES = {
    "hips": ["hips", "pelvis", "rootpelvis", "root"], "spine": ["spine", "spine1", "spine01", "torso", "abdomen"],
    "chest": ["spine2", "spine3", "chest", "spine02", "spine03", "upperchest"], "neck": ["neck", "neck01", "neck1"],
    "head": ["head", "headtop", "headtopend", "jaw", "jawend", "eye"], "shoulder": ["shoulder", "clavicle", "collar"],
    "upperarm": ["arm", "upperarm"], "forearm": ["forearm", "lowerarm"], "hand": ["hand", "wrist"],
    "thigh": ["upleg", "thigh", "upperleg"], "shin": ["leg", "calf", "shin", "lowerleg", "knee"], "foot": ["foot", "ankle"],
    "toe": ["toebase", "toe", "ball", "toeend"],
}
FINGER = re.compile(r"^(?:hand)?(thumb|index|middle|ring|pinky|little)")

# Which body parts each kind of cosmetic may follow. Anything else is moved to the
# nearest allowed ancestor bone, so a jacket hem beside the hand follows the forearm.
SLOT_ROLES = {
    "torso": ["hips", "spine", "chest", "neck", "shoulder", "upperarm", "forearm", "thigh"],
    "vest": ["hips", "spine", "chest", "neck", "shoulder"],
    "legs": ["hips", "spine", "thigh", "shin", "foot"],
    "waist": ["hips", "spine", "thigh"],
    "feet": ["shin", "foot", "toe"],
    "hands": ["forearm", "hand", "finger"],
    "arm": ["upperarm", "forearm"],
    "head": ["head", "neck"],
    "neck": ["neck", "chest", "head"],
    "back": ["chest", "spine", "shoulder"],
    "full": None,
}
SLOT_WORDS = [
    ("hands", r"glove|gauntlet|hand|wrap(?!.*(wrist|arm))|mitt|knuckle"),
    ("feet", r"boot|shoe|sneaker|sandal|sock|greave|foot"),
    ("head", r"helmet|hat|cap|hood|mask|hair|crown|visor|goggle|head"),
    ("arm", r"armband|bracer|wrist|sleeve|vambrace|pauldron|arm"),
    ("waist", r"belt|sash|waist|holster|pouch|skirt|kilt|loincloth"),
    ("legs", r"pant|trouser|short|jean|legging|leg"),
    ("back", r"cape|cloak|backpack|wing|quiver"),
    ("neck", r"scarf|necklace|collar|neck|amulet"),
    ("torso", r"jacket|coat|shirt|henley|undershirt|vest|top|hoodie|armou?r|chest|torso|tunic|robe|blazer|parka"),
]


def bone_role(name):
    """(side, role) for a bone name from any common naming (Mixamo, UE, Rigify, generic)."""
    n = name.lower()
    n = re.sub(r"^(mixamorig\d*:|def[-_]|org[-_]|mch[-_]|bip\d*[ _]|b_|bone_|cc_base_|j_bip_c_|j_bip_l_|j_bip_r_)", "", n)
    side = ""
    for pat, s in SIDE_PATTERNS:
        if re.search(pat, n):
            side = s
            n = re.sub(pat, "_", n)
            break
    n = re.sub(r"[^a-z0-9]", "", n)
    n = re.sub(r"(helper|twist\d*|roll\d*|corrective|end)$", "", n) or n
    if FINGER.match(n):
        return side, "finger"
    n2 = re.sub(r"\d+$", "", n)
    for key in (n, n2):  # the exact name first ("spine02" is the chest), then without its number
        for role, alts in ROLE_NAMES.items():
            if key in alts:
                return side, role
    return side, "other"


def slot_for(name, slot=None):
    """The slot for a cosmetic: given, or guessed from its file/object name."""
    if slot:
        return slot
    low = (name or "").lower()
    for s, pat in SLOT_WORDS:
        if re.search(pat, low):
            return s
    return "full"


def allowed(bone_names, slot, side=""):
    """Which bones the slot may follow (bool per bone)."""
    roles = SLOT_ROLES.get(slot, None)
    out = np.ones(len(bone_names), bool)
    for i, nm in enumerate(bone_names):
        s, r = bone_role(nm)
        if roles is not None and r not in roles:
            out[i] = False
        if side and s and s != side:
            out[i] = False
    return out


def limit_to_allowed(W, parents, ok, fallback=None):
    """Move each forbidden bone's weight to its nearest allowed ancestor.

    parents[i] = parent bone index or -1. When a bone has no allowed ancestor its
    weight goes to fallback[i] (e.g. the nearest allowed bone by position) if given,
    otherwise it is dropped. Rows are renormalised."""
    W = np.array(W, float)
    nb = W.shape[1]
    target = np.full(nb, -1)
    for b in range(nb):
        a = b
        while a >= 0 and not ok[a]:
            a = parents[a]
        if a < 0 and fallback is not None:
            a = fallback[b]
        target[b] = a
    out = np.zeros_like(W)
    for b in range(nb):
        if target[b] >= 0:
            out[:, target[b]] += W[:, b]
    s = out.sum(1, keepdims=True)
    lost = s[:, 0] <= 1e-9
    out = out / np.maximum(s, 1e-12)
    return out, lost


def top_k(W, k=4, eps=1e-3):
    W = np.array(W, float)
    if W.shape[1] > k:
        cut = -np.sort(-W, axis=1)[:, k - 1:k]
        W[W < cut] = 0
    W[W < eps] = 0
    s = W.sum(1, keepdims=True)
    return W / np.maximum(s, 1e-12)


# ---------- weight transfer ----------


def barycentric(P, A, B, C):
    """Barycentric coordinates of points P on triangles ABC (clamped to the triangle)."""
    v0, v1, v2 = B - A, C - A, P - A
    d00 = np.einsum("ij,ij->i", v0, v0)
    d01 = np.einsum("ij,ij->i", v0, v1)
    d11 = np.einsum("ij,ij->i", v1, v1)
    d20 = np.einsum("ij,ij->i", v2, v0)
    d21 = np.einsum("ij,ij->i", v2, v1)
    den = d00 * d11 - d01 * d01
    den = np.where(np.abs(den) < 1e-20, 1e-20, den)
    v = (d11 * d20 - d01 * d21) / den
    w = (d00 * d21 - d01 * d20) / den
    b = np.clip(np.stack([1 - v - w, v, w], 1), 0, 1)
    return b / np.maximum(b.sum(1, keepdims=True), 1e-12)


def vertex_normals(V, F, ids=None):
    """Smooth vertex normals (computed on welded vertices so seams don't crease them)."""
    V = np.asarray(V, float)
    ids = weld(V) if ids is None else ids
    P = welded_positions(V, ids)
    Fw = ids[np.asarray(F, np.int64)]
    n = np.cross(P[Fw[:, 1]] - P[Fw[:, 0]], P[Fw[:, 2]] - P[Fw[:, 0]])
    vn = np.zeros_like(P)
    np.add.at(vn, Fw.ravel(), np.repeat(n, 3, 0))
    return _unit(vn)[ids]


def interp_normals(VN, F, face, bary):
    tri = np.asarray(F)[face]
    n = VN[tri[:, 0]] * bary[:, :1] + VN[tri[:, 1]] * bary[:, 1:2] + VN[tri[:, 2]] * bary[:, 2:3]
    return _unit(n)


def interp_rows(Wb, body_F, face, bary):
    """Body weights at points on body triangles (face index + barycentrics)."""
    tri = np.asarray(body_F)[face]
    return (Wb[tri[:, 0]] * bary[:, :1] + Wb[tri[:, 1]] * bary[:, 1:2] + Wb[tri[:, 2]] * bary[:, 2:3])


def robust_transfer(cloth_V, cloth_F, cloth_N, hit_point, hit_normal, hit_face, hit_bary, body_F, body_W,
                    max_dist=0.05, max_angle=35.0, smooth=6, ids=None):
    """Skin weights for the cloth from the body.

    hit_*: for every cloth vertex, the nearest point on the body surface, its normal,
    triangle and barycentric coordinates (Blender's BVHTree.find_nearest gives these).
    Returns (weights per cloth vertex, matched mask)."""
    cloth_V = np.asarray(cloth_V, float)
    ids = weld(cloth_V) if ids is None else ids
    P = welded_positions(cloth_V, ids)
    G = Graph(P, edges(cloth_F, ids))
    nW = len(P)
    Wv = interp_rows(np.asarray(body_W, float), body_F, np.asarray(hit_face), np.asarray(hit_bary, float))
    dist = np.linalg.norm(np.asarray(hit_point) - cloth_V, axis=1)
    cosang = np.abs(np.einsum("ij,ij->i", _unit(cloth_N), _unit(hit_normal)))
    good = (dist <= max_dist) & (cosang >= np.cos(np.radians(max_angle)))
    # per welded vertex: matched if any of its split copies matched; weights averaged
    Ww = np.zeros((nW, Wv.shape[1]))
    cnt = np.zeros(nW)
    np.add.at(Ww, ids, Wv)
    np.add.at(cnt, ids, 1)
    Ww /= np.maximum(cnt, 1)[:, None]
    known = np.zeros(nW, bool)
    np.logical_or.at(known, ids, good)
    # Erode the matched set by a ring: matches right at the edge of a gap are the least reliable.
    if known.sum() > 50:
        ring = G.adj((~known).astype(float)) > 0
        eroded = known & ~ring
        if eroded.sum() > 0.5 * known.sum():
            known = eroded
    # Pieces of the cloth with nothing matched (a floating buckle) take the nearest weights.
    lab = G.components()
    has = np.zeros(nW, bool)
    np.logical_or.at(has, lab, known)
    lonely = ~has[lab]
    known = known | lonely
    Wf = harmonic_fill(G, Ww, known)
    # light smoothing on the filled part and the ring around it, then tidy up
    soft = ~known | (G.adj((~known).astype(float)) > 0)
    for _ in range(smooth):
        Wf[soft] = 0.5 * Wf[soft] + 0.5 * G.average(Wf)[soft]
    Wf = np.clip(Wf, 0, None)
    Wf /= np.maximum(Wf.sum(1, keepdims=True), 1e-12)
    return Wf[ids], known[ids]


def rigid_weights(n, n_bones, bone):
    W = np.zeros((n, n_bones))
    W[:, bone] = 1
    return W


def _unit(X):
    X = np.asarray(X, float)
    return X / np.maximum(np.linalg.norm(X, axis=1, keepdims=True), 1e-12)


def stack(sources):
    """One surface from several (V, F, W) sources: the body plus layers already dressed.

    Each new layer copies its weights from whatever lies right under it, so a coat moves
    exactly like the shirt beneath it and the two never cross."""
    Vs, Fs, Ws, off = [], [], [], 0
    for V, F, W in sources:
        Vs.append(np.asarray(V, float))
        Fs.append(np.asarray(F, np.int64) + off)
        Ws.append(np.asarray(W, float))
        off += len(V)
    return np.concatenate(Vs), np.concatenate(Fs), np.concatenate(Ws)


def layer_order(names, median_gap, outer=None):
    """Dress inner layers first.

    outer: {(a, b): True when a sits over b} from where the two actually overlap (the one
    farther from the body there is outside). Pieces that never overlap fall back to their
    median gap to the body. A loose jacket over a tight armband is then still ordered by
    where they touch, not by how far each is from the body overall."""
    gap = dict(zip(names, median_gap))
    outer = outer or {}
    left = list(names)
    order = []
    while left:
        # pieces nothing remaining sits under
        free = [n for n in left if not any(outer.get((n, m)) for m in left if m != n)]
        pick = min(free or left, key=lambda n: gap[n])
        order.append(pick)
        left.remove(pick)
    return order


# ---------- fitting ----------


def push_out(cloth_V, cloth_F, signed_dist, out_dir, margin=0.006, spread=8, ids=None):
    """Move cloth outward so it sits at least `margin` outside the surface under it.

    signed_dist: distance of each cloth vertex in front of the surface below it (negative
    = inside); out_dir: that surface's outward normal. The move spreads to neighbours so
    no spikes form. Returns the new positions and how many vertices moved."""
    V = np.array(cloth_V, float)
    ids = weld(V) if ids is None else ids
    P = welded_positions(V, ids)
    G = Graph(P, edges(cloth_F, ids))
    need = np.maximum(margin - np.asarray(signed_dist, float), 0.0)
    D = np.zeros((len(P), 3))
    amt = np.zeros(len(P))
    np.maximum.at(amt, ids, need)
    np.add.at(D, ids, _unit(out_dir) * need[:, None])
    c = np.zeros(len(P))
    np.add.at(c, ids, (need > 0).astype(float))
    D = _unit(D) * amt[:, None]
    moved = amt > 0
    # spread: each pass, neighbours take a share of the move (never less than they need)
    for _ in range(spread):
        avg = G.average(D)
        D = np.where(moved[:, None], D, 0.6 * avg)
        D = np.where((np.linalg.norm(avg, axis=1) * 0.6 > np.linalg.norm(D, axis=1))[:, None] & ~moved[:, None], 0.6 * avg, D)
    return V + D[ids], int(moved.sum())


def covered_faces(body_F, covered, body_ids=None, erode=1, keep=None):
    """Body faces fully under the cloth (all three corners covered after eroding the edge).

    covered: per body vertex, True when the cloth (or armour) lies right over it."""
    F = np.asarray(body_F, np.int64)
    cov = np.array(covered, bool)
    ids = body_ids if body_ids is not None else np.arange(len(cov))
    n = int(ids.max()) + 1
    cw = np.zeros(n, bool)
    np.logical_or.at(cw, ids, cov)
    allw = np.ones(n, bool)
    np.logical_and.at(allw, ids, cov)
    cw &= allw
    E = edges(F, ids)
    for _ in range(erode):
        bad = np.zeros(n, bool)
        np.logical_or.at(bad, E[:, 0], ~cw[E[:, 1]])
        np.logical_or.at(bad, E[:, 1], ~cw[E[:, 0]])
        cw &= ~bad
    if keep is not None:
        kw = np.zeros(n, bool)
        np.logical_or.at(kw, ids, keep)
        cw &= ~kw
    Fw = ids[F]
    return cw[Fw].all(1)


def covered_by(dist_to_outer, gap_inner, gap_outer, max_dist=0.04, tol=0.002):
    """Which inner points an outer layer covers.

    dist_to_outer: distance to the nearest point of the outer layer; gap_*: distance
    from the body of the inner point and of that nearest outer point. Comparing
    distances from the body works even when an AI mesh's normals point every which way."""
    return (np.asarray(dist_to_outer) < max_dist) & (np.asarray(gap_outer) >= np.asarray(gap_inner) - tol)


def sync_layer(V, F, W_inner, covered, W_outer_here, feather=3, ids=None):
    """Give the covered part of an inner layer the outer layer's weights.

    Two layers with the same weights at the same spot move together in every pose, so
    they can't cross; the edge of the synced area is feathered over a few rings."""
    ids = weld(V) if ids is None else ids
    P = welded_positions(V, ids)
    G = Graph(P, edges(F, ids))
    n = len(P)
    t = np.zeros(n)
    np.maximum.at(t, ids, np.asarray(covered, float))
    for _ in range(feather):  # spread the blend a few rings outward, fading
        t = np.maximum(t, 0.6 * G.average(t))
    Wi = np.zeros((n, W_inner.shape[1]))
    Wo = np.zeros_like(Wi)
    c = np.zeros(n)
    np.add.at(Wi, ids, W_inner)
    np.add.at(Wo, ids, W_outer_here)
    np.add.at(c, ids, 1)
    Wi /= np.maximum(c, 1)[:, None]
    Wo /= np.maximum(c, 1)[:, None]
    Wn = (1 - t)[:, None] * Wi + t[:, None] * Wo
    return top_k(Wn, 4)[ids]


def poke_through(gap_inner, gap_outer, tol=0.003):
    """Positive where an inner point ends up farther from the body than the outer layer."""
    return np.asarray(gap_inner, float) - np.asarray(gap_outer, float) - tol


# ---------- posing and checks ----------


def skin(V, W, D):
    """Linear blend skinning with per-bone 4x4 deltas (posed = D @ rest), W: n x bones."""
    V = np.asarray(V, float)
    Vh = np.concatenate([V, np.ones((len(V), 1))], 1)
    out = np.zeros_like(V)
    W = np.asarray(W, float)
    for b in np.where(W.sum(0) > 0)[0]:
        m = W[:, b] > 0
        out[m] += W[m, b, None] * (Vh[m] @ D[b].T)[:, :3]
    return out


def _rot(axis, deg):
    a = np.asarray(axis, float)
    a = a / max(np.linalg.norm(a), 1e-12)
    t = np.radians(deg)
    K = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + np.sin(t) * K + (1 - np.cos(t)) * (K @ K)


def _about(R, c):
    M = np.eye(4)
    M[:3, :3] = R
    M[:3, 3] = c - R @ c
    return M


def pose_deltas(names, parents, heads, tails, pose, up, front, amount_helpers=0.5):
    """Per-bone world deltas for a test pose (see TEST_POSES), for any skeleton.

    heads/tails: rest positions; up/front: the character's up and facing directions.
    Bones named <X>Helper turn half as far as <X> (the shoulder/hip helpers)."""
    up = np.asarray(up, float) / np.linalg.norm(up)
    front = np.asarray(front, float) / np.linalg.norm(front)
    lateral = np.cross(up, front)  # character's left-to-right axis (sign doesn't matter)
    nb = len(names)
    roles = [bone_role(n) for n in names]
    mid = np.asarray(heads, float).mean(0)
    local = {}  # bone -> rest-space rotation about its head
    for role, side, motion, deg in pose:
        for b in range(nb):
            s, r = roles[b]
            if r != role or (side not in ("*", s) and not (side == "" and s == "")) or names[b].lower().endswith("helper"):
                continue
            h, t = np.asarray(heads[b], float), np.asarray(tails[b], float)
            d = t - h
            if np.linalg.norm(d) < 1e-9:
                continue
            if motion == "twist":
                axis, want = up, None
            elif motion == "raise":
                axis = np.cross(d, up) if np.linalg.norm(np.cross(d, up)) > 1e-6 else front
                want = up
            elif motion in ("forward", "bend"):
                axis = lateral
                want = front if (motion == "forward" or r in ("forearm", "upperarm")) else -front
                if r == "shin":
                    want = -front
            else:  # curl: toward the palm (inward to the midline and down)
                inward = mid - h
                inward -= up * (inward @ up)
                axis = np.cross(d, inward) if np.linalg.norm(np.cross(d, inward)) > 1e-6 else lateral
                want = _unit(inward[None])[0] - up * 0.5
            R = _rot(axis, deg)
            if want is not None and ((R @ d) - d) @ want < 0:
                R = _rot(axis, -deg)
            local[b] = R
    order = sorted(range(nb), key=lambda b: _depth(b, parents))
    D = np.tile(np.eye(4), (nb, 1, 1))
    for b in order:
        p = parents[b]
        Dp = D[p] if p >= 0 else np.eye(4)
        R = local.get(b)
        nm = names[b]
        if nm.lower().endswith("helper"):
            src = names.index(nm[: -len("helper")]) if nm[: -len("helper")] in names else -1
            if src >= 0 and src in local:
                ang = np.degrees(np.arccos(np.clip((np.trace(local[src]) - 1) / 2, -1, 1)))
                if ang > 1e-6:
                    w, v = np.linalg.eig(local[src])
                    ax = np.real(v[:, np.argmin(np.abs(w - 1))])
                    R = _rot(ax, ang * amount_helpers)
                    if np.linalg.norm(R - local[src]) > np.linalg.norm(_rot(ax, -ang * amount_helpers) - local[src]):
                        R = _rot(ax, -ang * amount_helpers)
        if R is None:
            D[b] = Dp
            continue
        Rp = Dp[:3, :3]
        hp = (Dp @ np.append(heads[b], 1))[:3]
        D[b] = _about(Rp @ R @ Rp.T, hp) @ Dp
    return D


def _depth(b, parents):
    d = 0
    while parents[b] >= 0:
        b = parents[b]
        d += 1
    return d


def poke_report(signed_dist, under, tol=0.002):
    """How much of what should be under the cloth shows through it.

    signed_dist: for each inner vertex (body or inner layer) that the cloth covers at
    rest, its distance in front of the cloth in the pose (positive = poking out)."""
    sd = np.asarray(signed_dist, float)[np.asarray(under, bool)]
    if not len(sd):
        return {"checked": 0, "poking": 0, "share": 0.0, "worst_mm": 0.0}
    poke = sd > tol
    return {"checked": int(len(sd)), "poking": int(poke.sum()), "share": round(float(poke.mean()), 4),
            "worst_mm": round(float(max(sd.max(), 0) * 1000), 1)}


# Test poses by body part, so any skeleton whose bones bone_role understands can be posed.
# (role, side, axis in the bone's own space, degrees). Positive and negative depend on the
# rig, so each pose is tried and checked against how far the hand/foot travelled.
TEST_POSES = {
    "arms_up": [("shoulder", "*", "raise", 20), ("upperarm", "*", "raise", 80)],
    "arms_out": [("upperarm", "*", "raise", 45)],
    "arms_forward": [("upperarm", "*", "forward", 80), ("forearm", "*", "bend", 60)],
    "fists": [("finger", "*", "curl", 75)],
    "crouch": [("thigh", "*", "forward", 70), ("shin", "*", "bend", 100), ("spine", "", "forward", 15)],
    "run": [("thigh", "left", "forward", 70), ("shin", "left", "bend", 90), ("thigh", "right", "forward", -25),
            ("shin", "right", "bend", 40), ("upperarm", "left", "forward", -35), ("upperarm", "right", "forward", 45),
            ("forearm", "*", "bend", 70)],
    "twist": [("spine", "", "twist", 25), ("chest", "", "twist", 20), ("neck", "", "twist", 30)],
}
