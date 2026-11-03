"""CoDev's free picture and sound tools, run on the user's own computer.

    python art_tools.py <command> <args.json>

prints one JSON line with the result. Needs Python 3 with numpy and Pillow
(pip install numpy pillow); cutouts also need rembg (pip install rembg).
Nothing here goes online. Commands:

  info          which libraries are installed
  size          width and height of a picture
  pbr           PBR maps from one texture picture (albedo, height, normal,
                roughness, metallic, ao, emissive, packed ORM for Godot)
  seamless      makes a texture tile without seams
  weather       fresh-to-ruined variations of a texture set (edge wear,
                scratches, rust, scorch, grime, dust)
  reframe_fill  extends a picture to another aspect ratio without stretching
                it (blurred, colour-matched fill), for when ComfyUI isn't running
  cutout        background removal (rembg), trimmed to the subject
  upscale       2x/4x Lanczos with sharpening (fallback when no AI upscaler)
  palette       the main colours of pictures
  contact       a labelled contact sheet of pictures
  compare       a reference picture next to a render, detail by detail: shape,
                colours and fine detail compared in a grid, the worst places
                boxed, close-ups of them, and scores
  box_mask      a white-on-black mask for a box in a picture
  region_mask   a try-on mask: a body region of a character, inside its silhouette
  thumb         a square icon from a picture
  sfx           procedural sound effects (whoosh, zap, power_up, impact, hum,
                servo, shield, coin, explosion, laser)
"""
import json
import math
import os
import sys
import wave

try:
    import numpy as np
    from PIL import Image, ImageFilter, ImageDraw, ImageFont
except ImportError as err:  # reported as JSON so CoDev can tell the user what to install
    print(json.dumps({"ok": False, "error": f"Python is missing {err.name}. Run: pip install numpy pillow"}))
    sys.exit(0)


def load(path, mode="RGB"):
    return Image.open(path).convert(mode)


def arr(img):
    return np.asarray(img, dtype=np.float32) / 255.0


def to_img(a, mode=None):
    a = np.clip(a, 0, 1)
    return Image.fromarray((a * 255 + 0.5).astype(np.uint8), mode)


def gray(a):
    return a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114


def blur(a, radius):
    if radius <= 0:
        return a
    img = to_img(a)
    return arr(img.filter(ImageFilter.GaussianBlur(radius)))


def noise(h, w, scale, seed, octaves=4):
    """Fractal value noise in 0..1."""
    rng = np.random.default_rng(seed)
    out = np.zeros((h, w), np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        cells = max(2, int(scale * (2 ** o)))
        grid = rng.random((cells + 1, cells + 1)).astype(np.float32)
        layer = np.asarray(Image.fromarray((grid * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC), np.float32) / 255
        out += layer * amp
        total += amp
        amp *= 0.5
    return out / total


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / max(e1 - e0, 1e-6), 0, 1)
    return t * t * (3 - 2 * t)


def save(img, path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    img.save(path)
    return path


# ---------- PBR maps ----------

def height_from(albedo, detail=1.0):
    g = gray(albedo)
    # Large shapes from a wide blur, fine detail from the difference.
    low = gray(blur(albedo, 8))
    h = 0.6 * g + 0.4 * (0.5 + (g - low) * 2 * detail)
    h = (h - h.min()) / max(h.max() - h.min(), 1e-6)
    return h


def normal_from(height, strength=2.0, fmt="gl"):
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * strength
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * strength
    nx, ny, nz = -dx, dy if fmt == "gl" else -dy, np.ones_like(height) * 0.5
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    n = np.stack([nx / length, ny / length, nz / length], -1)
    return n * 0.5 + 0.5


def curvature_from(height):
    h = blur(np.repeat(height[..., None], 3, -1), 1.5)[..., 0]
    lap = 4 * h - np.roll(h, 1, 0) - np.roll(h, -1, 0) - np.roll(h, 1, 1) - np.roll(h, -1, 1)
    lap = lap / max(float(np.percentile(np.abs(lap), 99)), 1e-6)
    # Blur works on 0..1 pictures, so blur the shifted map and shift it back.
    c = (blur(np.repeat(np.clip(lap * 0.5 + 0.5, 0, 1)[..., None], 3, -1), 1.0)[..., 0] - 0.5) * 2
    return np.clip(0.5 + c * 0.5, 0, 1)  # >0.5 convex edges, <0.5 cavities


def cmd_pbr(a):
    src = load(a["input"])
    size = int(a.get("size") or 0)
    if size:
        src = src.resize((size, size), Image.LANCZOS)
    albedo = arr(src)
    if a.get("seamless"):
        albedo = arr(make_seamless(src))
    height = height_from(albedo, float(a.get("detail", 1.0)))
    if a.get("invert_height"):
        height = 1 - height
    normal = normal_from(height, float(a.get("normal_strength", 2.0)), a.get("normal_format", "gl"))
    curv = curvature_from(height)
    ao = np.clip(1 - (blur(np.repeat((1 - height)[..., None], 3, -1), 6)[..., 0] - (1 - height)) * 2.5, 0, 1)
    ao = np.clip(0.55 + 0.45 * smoothstep(0.2, 0.9, ao * height + 0.4), 0, 1)
    # De-lit albedo: take out the large light/dark shading the photo baked in.
    shade = gray(blur(albedo, 24))
    delit = np.clip(albedo / np.maximum(shade[..., None], 0.05) * shade.mean(), 0, 1)
    delit = albedo * (1 - float(a.get("delight", 0.5))) + delit * float(a.get("delight", 0.5))
    # Rough where the surface is busy and dark, smooth where it's bright and flat.
    detail = np.abs(gray(albedo) - gray(blur(albedo, 3)))
    rough = 0.55 + float(a.get("roughness_bias", 0.0)) - (gray(albedo) - 0.5) * 0.35 + detail * 2.0
    rough = np.clip(rough, 0.04, 1.0)
    metal_value = a.get("metallic", 0.0)
    if isinstance(metal_value, str) and os.path.exists(metal_value):
        metallic = gray(arr(load(metal_value).resize(src.size)))
    else:
        metallic = np.full(height.shape, float(metal_value or 0), np.float32)
        if a.get("metal_from_color"):
            sat = albedo.max(-1) - albedo.min(-1)
            metallic = np.clip(metallic + smoothstep(0.25, 0.08, sat) * smoothstep(0.35, 0.7, gray(albedo)), 0, 1)
    rough = np.clip(rough - metallic * 0.25, 0.04, 1)
    hsv = np.asarray(src.convert("HSV"), np.float32) / 255
    emissive = albedo * (smoothstep(0.85, 0.98, hsv[..., 2]) * smoothstep(0.45, 0.8, hsv[..., 1]))[..., None]
    if a.get("emissive") is False:
        emissive = np.zeros_like(albedo)

    out, name = a["out_dir"], a.get("name", "material")
    files = {}
    files["albedo"] = save(to_img(delit), os.path.join(out, f"{name}_albedo.png"))
    files["height"] = save(to_img(height, "L"), os.path.join(out, f"{name}_height.png"))
    files["normal"] = save(to_img(normal), os.path.join(out, f"{name}_normal.png"))
    files["roughness"] = save(to_img(rough, "L"), os.path.join(out, f"{name}_roughness.png"))
    files["metallic"] = save(to_img(metallic, "L"), os.path.join(out, f"{name}_metallic.png"))
    files["ao"] = save(to_img(ao, "L"), os.path.join(out, f"{name}_ao.png"))
    files["curvature"] = save(to_img(curv, "L"), os.path.join(out, f"{name}_curvature.png"))
    if emissive.max() > 0.02:
        files["emissive"] = save(to_img(emissive), os.path.join(out, f"{name}_emissive.png"))
    # Godot's ORM: R = ambient occlusion, G = roughness, B = metallic.
    files["orm"] = save(to_img(np.stack([ao, rough, metallic], -1)), os.path.join(out, f"{name}_orm.png"))
    return {"ok": True, "files": files, "size": list(src.size)}


def make_seamless(img, blend=0.25):
    a = arr(img)
    h, w = a.shape[:2]
    shifted = np.roll(np.roll(a, h // 2, 0), w // 2, 1)
    # The shifted copy has its seams in the middle; cover them with the original there.
    seam = np.maximum(smoothstep(blend, 0, np.abs(np.linspace(-1, 1, h)))[:, None], smoothstep(blend, 0, np.abs(np.linspace(-1, 1, w)))[None, :])
    out = shifted * (1 - seam[..., None]) + a * seam[..., None]
    return to_img(out)


def cmd_seamless(a):
    img = load(a["input"])
    out = make_seamless(img, float(a.get("blend", 0.25)))
    save(out, a["output"])
    return {"ok": True, "files": {"seamless": a["output"]}}


# ---------- weathering ----------

STAGES = {
    "factory": dict(edge=0.0, scratch=0.0, rust=0.0, scorch=0.0, grime=0.0, dust=0.0),
    "light": dict(edge=0.25, scratch=0.15, rust=0.0, scorch=0.0, grime=0.2, dust=0.15),
    "worn": dict(edge=0.55, scratch=0.4, rust=0.15, scorch=0.1, grime=0.45, dust=0.3),
    "battle": dict(edge=0.8, scratch=0.7, rust=0.35, scorch=0.55, grime=0.6, dust=0.35),
    "ruined": dict(edge=1.0, scratch=0.9, rust=0.8, scorch=0.8, grime=0.85, dust=0.5),
}


def scratches(h, w, amount, seed):
    img = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(img)
    rng = np.random.default_rng(seed)
    for _ in range(int(amount * 220)):
        x, y = rng.random() * w, rng.random() * h
        ang = rng.normal(0.4, 0.5)
        length = rng.random() * w * 0.12 + 4
        d.line([(x, y), (x + math.cos(ang) * length, y + math.sin(ang) * length)], fill=int(120 + rng.random() * 135), width=1)
    return np.asarray(img.filter(ImageFilter.GaussianBlur(0.6)), np.float32) / 255


def cmd_weather(a):
    albedo_img = load(a["albedo"])
    w, h = albedo_img.size
    albedo = arr(albedo_img)
    rough = gray(arr(load(a["roughness"]).resize((w, h)))) if a.get("roughness") else np.full((h, w), 0.5, np.float32)
    metal = gray(arr(load(a["metallic"]).resize((w, h)))) if a.get("metallic") else np.zeros((h, w), np.float32)
    if a.get("curvature"):
        curv = gray(arr(load(a["curvature"]).resize((w, h))))
    else:
        curv = curvature_from(height_from(albedo))
    ao = gray(arr(load(a["ao"]).resize((w, h)))) if a.get("ao") else np.ones((h, w), np.float32)
    seed = int(a.get("seed", 7))
    colors = {"rust": np.array([0.42, 0.18, 0.07]), "rust2": np.array([0.62, 0.32, 0.12]), "scorch": np.array([0.05, 0.04, 0.035]),
              "grime": np.array([0.16, 0.13, 0.09]), "dust": np.array([0.62, 0.56, 0.47]), "bare": np.array([0.72, 0.72, 0.74])}
    stages = a.get("stages") or list(STAGES.keys())
    out, name = a["out_dir"], a.get("name", "material")
    n1, n2, n3 = noise(h, w, 6, seed), noise(h, w, 14, seed + 1), noise(h, w, 3, seed + 2)
    results = {}
    for stage in stages:
        p = dict(STAGES.get(stage, STAGES["worn"]))
        p.update((a.get("overrides") or {}).get(stage, {}))
        col, r, m = albedo.copy(), rough.copy(), metal.copy()
        # Edge wear: paint chips off convex edges, showing bare metal.
        convex = np.clip((curv - 0.5) * 2, 0, 1)
        edge = smoothstep(0.5 - 0.4 * p["edge"], 0.7 - 0.4 * p["edge"], convex * (0.5 + 0.9 * n2))
        chips = smoothstep(0.86 - 0.14 * p["edge"], 0.9 - 0.1 * p["edge"], n2 * 0.7 + n1 * 0.3)
        edge = np.maximum(edge, chips) * (p["edge"] > 0)
        col = col * (1 - edge[..., None]) + colors["bare"] * edge[..., None]
        r = r * (1 - edge) + 0.3 * edge
        m = np.maximum(m, edge)
        sc = scratches(h, w, p["scratch"], seed + 3) * p["scratch"]
        col = col * (1 - sc[..., None] * 0.6) + colors["bare"] * sc[..., None] * 0.6
        r = np.clip(r - sc * 0.2, 0.04, 1)
        # Rust collects in cavities and under grime.
        cavity = np.clip((0.5 - curv) * 2, 0, 1)
        rust = smoothstep(1.05 - p["rust"] * 0.6, 1.25 - p["rust"] * 0.6, cavity * 0.6 + n1 * 0.7 + (1 - ao) * 0.4 + edge * 0.3) * (p["rust"] > 0)
        rust_col = colors["rust"] * (1 - n2[..., None]) + colors["rust2"] * n2[..., None]
        col = col * (1 - rust[..., None]) + rust_col * rust[..., None]
        r = r * (1 - rust) + 0.92 * rust
        m = m * (1 - rust)
        # Scorch: big soft burn patches.
        scorch = smoothstep(1 - p["scorch"] * 0.6, 1.05 - p["scorch"] * 0.4, n3 * 0.8 + n1 * 0.3) * (p["scorch"] > 0)
        col = col * (1 - scorch[..., None] * 0.85) + colors["scorch"] * scorch[..., None] * 0.85
        r = r * (1 - scorch) + 0.85 * scorch
        grime = p["grime"] * smoothstep(0.35, 0.8, (1 - ao) * 0.7 + (1 - curv) * 0.5 + n2 * 0.3)
        col = col * (1 - grime[..., None] * 0.6) + colors["grime"] * grime[..., None] * 0.6
        r = np.clip(r + grime * 0.15, 0, 1)
        dust = p["dust"] * smoothstep(0.55, 0.9, n1 * 0.7 + curv * 0.3)
        col = col * (1 - dust[..., None] * 0.35) + colors["dust"] * dust[..., None] * 0.35
        files = {
            "albedo": save(to_img(col), os.path.join(out, f"{name}_{stage}_albedo.png")),
            "roughness": save(to_img(r, "L"), os.path.join(out, f"{name}_{stage}_roughness.png")),
            "metallic": save(to_img(m, "L"), os.path.join(out, f"{name}_{stage}_metallic.png")),
            "orm": save(to_img(np.stack([ao, r, m], -1)), os.path.join(out, f"{name}_{stage}_orm.png")),
        }
        results[stage] = files
    return {"ok": True, "stages": results}


# ---------- framing, cutouts, upscaling ----------

def target_size(w, h, aspect):
    aw, ah = [float(x) for x in str(aspect).split(":")]
    ratio = aw / ah
    if w / h < ratio:
        return int(round(h * ratio)), h
    return w, int(round(w / ratio))


def cmd_reframe_fill(a):
    img = load(a["input"])
    w, h = img.size
    files = {}
    for aspect in a["aspects"]:
        tw, th = target_size(w, h, aspect)
        bg = img.resize((tw, th), Image.LANCZOS).filter(ImageFilter.GaussianBlur(max(tw, th) / 25))
        # Darken the fill a little so the original stays the focus.
        bg = Image.blend(bg, Image.new("RGB", bg.size, (0, 0, 0)), 0.18)
        x, y = (tw - w) // 2, (th - h) // 2
        mask = feathered((w, h), max(4, min(w, h) // 30))
        bg.paste(img, (x, y), mask)
        path = os.path.join(a["out_dir"], f"{a.get('name', 'art')}_{aspect.replace(':', 'x')}.png")
        files[aspect] = save(bg, path)
    return {"ok": True, "files": files}


def feathered(size, px):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rectangle([px, px, size[0] - px, size[1] - px], fill=255)
    return m.filter(ImageFilter.GaussianBlur(px / 2))


def cmd_pad_plan(a):
    """How much to pad on each side for each aspect (for ComfyUI outpainting)."""
    img = Image.open(a["input"])
    w, h = img.size
    plans = {}
    for aspect in a["aspects"]:
        tw, th = target_size(w, h, aspect)
        dx, dy = tw - w, th - h
        plans[aspect] = {"left": dx // 2, "right": dx - dx // 2, "top": dy // 2, "bottom": dy - dy // 2, "width": tw, "height": th}
    return {"ok": True, "size": [w, h], "plans": plans}


def cmd_cutout(a):
    try:
        from rembg import remove, new_session
    except ImportError:
        return {"ok": False, "error": "Background removal needs rembg: pip install rembg (free, runs on your computer)."}
    session = new_session(a.get("model", "isnet-general-use"))
    files = []
    for src in a["inputs"]:
        img = Image.open(src).convert("RGBA")
        cut = remove(img, session=session, alpha_matting=bool(a.get("fine_edges")))
        if a.get("trim", True):
            box = cut.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
            if box:
                pad = int(a.get("padding", 8))
                box = (max(0, box[0] - pad), max(0, box[1] - pad), min(cut.width, box[2] + pad), min(cut.height, box[3] + pad))
                cut = cut.crop(box)
        out = os.path.join(a["out_dir"], os.path.splitext(os.path.basename(src))[0] + "_cutout.png")
        files.append(save(cut, out))
    return {"ok": True, "files": files}


def cmd_upscale(a):
    files = []
    scale = int(a.get("scale", 4))
    for src in a["inputs"]:
        img = Image.open(src)
        mode = img.mode
        img = img.convert("RGBA" if "A" in mode else "RGB")
        big = img.resize((img.width * scale, img.height * scale), Image.LANCZOS)
        big = big.filter(ImageFilter.UnsharpMask(radius=2, percent=80, threshold=2))
        out = os.path.join(a["out_dir"], os.path.splitext(os.path.basename(src))[0] + f"_x{scale}.png")
        files.append(save(big, out))
    return {"ok": True, "files": files}


def cmd_palette(a):
    colors = []
    for src in a["inputs"]:
        img = load(src).resize((96, 96))
        colors.append(np.asarray(img).reshape(-1, 3))
    px = np.concatenate(colors)
    q = Image.fromarray(px.reshape(-1, 1, 3).astype(np.uint8)).quantize(colors=int(a.get("count", 6)), method=Image.Quantize.MEDIANCUT)
    pal = q.getpalette()[: int(a.get("count", 6)) * 3]
    counts = sorted(q.getcolors(), reverse=True)
    out = []
    for count, idx in counts:
        r, g, b = pal[idx * 3: idx * 3 + 3]
        out.append("#%02x%02x%02x" % (r, g, b))
    stats = arr(load(a["inputs"][0]).resize((96, 96)))
    return {"ok": True, "palette": out, "brightness": round(float(gray(stats).mean()), 3),
            "saturation": round(float((stats.max(-1) - stats.min(-1)).mean()), 3),
            "contrast": round(float(gray(stats).std()), 3)}


def cmd_contact(a):
    items = a["items"]  # [{path, label}]
    thumb = int(a.get("thumb", 320))
    cols = int(a.get("columns", min(4, max(1, len(items)))))
    rows = math.ceil(len(items) / cols)
    sheet = Image.new("RGB", (cols * thumb, rows * (thumb + 24)), (24, 24, 28))
    d = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.load_default(size=14)
    except TypeError:
        font = ImageFont.load_default()
    for i, it in enumerate(items):
        img = Image.open(it["path"]).convert("RGB")
        img.thumbnail((thumb, thumb))
        x, y = (i % cols) * thumb, (i // cols) * (thumb + 24)
        sheet.paste(img, (x + (thumb - img.width) // 2, y + (thumb - img.height) // 2))
        d.text((x + 6, y + thumb + 4), str(it.get("label", ""))[:44], fill=(230, 230, 230), font=font)
    save(sheet, a["output"])
    return {"ok": True, "files": {"contact": a["output"]}}


def cmd_box_mask(a):
    img = Image.open(a["input"])
    w, h = img.size
    m = Image.new("L", (w, h), 0)
    for box in a["boxes"]:
        x, y, bw, bh = box
        ImageDraw.Draw(m).rectangle([x * w, y * h, (x + bw) * w, (y + bh) * h], fill=255)
    m = m.filter(ImageFilter.GaussianBlur(float(a.get("feather", 6))))
    save(m.convert("RGB"), a["output"])
    return {"ok": True, "files": {"mask": a["output"]}}


REGIONS = {  # fractions of the character's bounding box: top, bottom
    "head": (0.0, 0.17), "helmet": (0.0, 0.2), "upper": (0.14, 0.55), "torso": (0.16, 0.5), "arms": (0.15, 0.6),
    "lower": (0.45, 0.92), "legs": (0.5, 1.0), "feet": (0.88, 1.0), "full": (0.12, 1.0), "outfit": (0.14, 1.0),
}


def silhouette(img):
    if img.mode == "RGBA" and img.getchannel("A").getextrema()[0] < 250:
        return np.asarray(img.getchannel("A"), np.float32) / 255
    try:
        from rembg import remove
        return np.asarray(remove(img.convert("RGB")).getchannel("A"), np.float32) / 255
    except Exception:
        # No cutout tool: assume a plain background, take what differs from the corners.
        a = arr(img.convert("RGB"))
        corners = np.stack([a[0, 0], a[0, -1], a[-1, 0], a[-1, -1]]).mean(0)
        diff = np.abs(a - corners).sum(-1)
        return (diff > 0.18).astype(np.float32)


def cmd_region_mask(a):
    img = Image.open(a["input"])
    sil = silhouette(img)
    ys, xs = np.nonzero(sil > 0.5)
    if not len(ys):
        return {"ok": False, "error": "Couldn't find the character in the picture."}
    top, bottom = ys.min(), ys.max()
    region = a.get("region", "full")
    t, b = REGIONS.get(region, REGIONS["full"])
    y0, y1 = int(top + (bottom - top) * t), int(top + (bottom - top) * b)
    m = np.zeros_like(sil)
    m[y0:y1] = 1
    if region == "arms":
        cx = (xs.min() + xs.max()) / 2
        width = (xs.max() - xs.min())
        cols = np.abs(np.arange(sil.shape[1]) - cx) > width * 0.18
        m = m * cols[None, :]
    grow = int(a.get("grow", 12))
    sil_grown = np.asarray(Image.fromarray((sil * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(grow * 2 + 1)), np.float32) / 255
    mask = Image.fromarray((m * sil_grown * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(float(a.get("feather", 4))))
    save(mask.convert("RGB"), a["output"])
    return {"ok": True, "files": {"mask": a["output"]}, "box": [int(xs.min()), y0, int(xs.max()), y1]}


def cmd_thumb(a):
    """A square icon: the picture fitted on a transparent (or given) background."""
    img = Image.open(a["input"]).convert("RGBA")
    size = int(a.get("size", 256))
    img.thumbnail((size, size), Image.LANCZOS)
    bg = Image.new("RGBA", (size, size), tuple(a.get("background", (0, 0, 0, 0))))
    bg.paste(img, ((size - img.width) // 2, (size - img.height) // 2), img)
    save(bg, a["output"])
    return {"ok": True, "files": {"icon": a["output"]}}


def cmd_size(a):
    img = Image.open(a["input"])
    return {"ok": True, "size": list(img.size), "mode": img.mode}


# ---------- sound effects ----------

def env_adsr(n, sr, a=0.01, d=0.1, s=0.6, r=0.2):
    t = np.arange(n) / sr
    dur = n / sr
    env = np.where(t < a, t / max(a, 1e-4), np.where(t < a + d, 1 - (1 - s) * (t - a) / max(d, 1e-4), s))
    rel = np.clip((dur - t) / max(r, 1e-4), 0, 1)
    return env * rel


def sfx(preset, dur, sr, rng):
    n = int(dur * sr)
    t = np.arange(n) / sr
    white = rng.standard_normal(n)

    def lowpass(x, cutoff):
        # One-pole low-pass, cutoff may vary over time.
        cutoff = np.broadcast_to(cutoff, x.shape)
        y = np.zeros_like(x)
        prev = 0.0
        k = 1 - np.exp(-2 * np.pi * cutoff / sr)
        for i in range(len(x)):
            prev += k[i] * (x[i] - prev)
            y[i] = prev
        return y

    if preset == "whoosh":
        sweep = 300 + 3000 * np.sin(np.pi * t / dur) ** 2
        return lowpass(white, sweep) * np.sin(np.pi * t / dur) ** 1.5 * 2.5
    if preset == "zap" or preset == "laser":
        f = 1800 * np.exp(-t * (6 if preset == "zap" else 3)) + 120
        ph = 2 * np.pi * np.cumsum(f) / sr
        return np.sign(np.sin(ph)) * 0.4 * env_adsr(n, sr, 0.002, 0.05, 0.5, dur * 0.6)
    if preset == "power_up":
        f = 200 * 2 ** (t / dur * 2.5)
        ph = 2 * np.pi * np.cumsum(f) / sr
        return (np.sin(ph) + 0.4 * np.sin(2 * ph) + 0.2 * np.sin(3.01 * ph)) * 0.4 * env_adsr(n, sr, 0.02, 0.2, 0.8, 0.25)
    if preset == "impact":
        thump = np.sin(2 * np.pi * (60 + 80 * np.exp(-t * 30)) * t) * np.exp(-t * 9)
        crack = lowpass(white, 2500) * np.exp(-t * 35) * 2
        return (thump + crack) * 0.8
    if preset == "explosion":
        rumble = lowpass(white, 200 + 1800 * np.exp(-t * 4)) * 3 * np.exp(-t * 2.2)
        return rumble + np.sin(2 * np.pi * 45 * t) * np.exp(-t * 3) * 0.6
    if preset == "hum":
        return (np.sin(2 * np.pi * 55 * t) + 0.5 * np.sin(2 * np.pi * 110.4 * t) + 0.2 * np.sin(2 * np.pi * 165 * t)) * 0.3 * (0.85 + 0.15 * np.sin(2 * np.pi * 3 * t))
    if preset == "servo":
        f = 420 + 160 * np.sin(np.pi * t / dur)
        ph = 2 * np.pi * np.cumsum(f) / sr
        return (np.sign(np.sin(ph)) * 0.15 + lowpass(white, 900) * 0.4) * env_adsr(n, sr, 0.03, 0.05, 0.9, 0.08)
    if preset == "shield":
        f = 600 + 400 * np.sin(2 * np.pi * 7 * t)
        ph = 2 * np.pi * np.cumsum(f) / sr
        return np.sin(ph) * 0.35 * env_adsr(n, sr, 0.05, 0.1, 0.7, 0.3) + lowpass(white, 4000) * 0.05
    if preset == "coin":
        f = np.where(t < 0.08, 988, 1319)
        ph = 2 * np.pi * np.cumsum(f) / sr
        return np.sign(np.sin(ph)) * 0.25 * env_adsr(n, sr, 0.001, 0.05, 0.6, dur * 0.7)
    raise ValueError(f"unknown preset {preset}")


def cmd_sfx(a):
    sr = 44100
    rng = np.random.default_rng(int(a.get("seed", 1)))
    preset = a["preset"]
    dur = float(a.get("duration", {"hum": 2.0, "explosion": 1.6, "whoosh": 0.7}.get(preset, 0.5)))
    y = sfx(preset, dur, sr, rng)
    pitch = float(a.get("pitch", 1.0))
    if pitch != 1.0:
        idx = np.arange(0, len(y), pitch)
        y = np.interp(idx, np.arange(len(y)), y)
    y = y / max(np.abs(y).max(), 1e-6) * 0.89
    fade = int(sr * 0.005)
    y[:fade] *= np.linspace(0, 1, fade)
    y[-fade:] *= np.linspace(1, 0, fade)
    os.makedirs(os.path.dirname(os.path.abspath(a["output"])), exist_ok=True)
    with wave.open(a["output"], "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes((y * 32767).astype("<i2").tobytes())
    return {"ok": True, "files": {"sfx": a["output"]}, "seconds": round(len(y) / sr, 2)}


# ---------- Reference vs render ----------

ROW_NAMES = {3: ["top", "middle", "bottom"], 4: ["top", "upper middle", "lower middle", "bottom"], 5: ["top", "upper", "middle", "lower", "bottom"]}
COL_NAMES = {3: ["left", "centre", "right"], 4: ["far left", "left", "right", "far right"], 5: ["far left", "left", "centre", "right", "far right"]}


def hexof(c):
    c = np.clip(np.asarray(c, np.float32), 0, 1)
    return "#%02x%02x%02x" % tuple(int(v * 255 + 0.5) for v in c[:3])


def subject(img, height, pad=0.04):
    """The subject cut out of its background, cropped to it and scaled to height."""
    img = img.convert("RGBA")
    sil = silhouette(img)
    ys, xs = np.nonzero(sil > 0.5)
    if not len(ys):
        sil = np.ones(sil.shape, np.float32)
        ys, xs = np.nonzero(sil)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    py, px = int((y1 - y0) * pad), int((x1 - x0) * pad)
    y0, y1, x0, x1 = max(0, y0 - py), min(sil.shape[0], y1 + py), max(0, x0 - px), min(sil.shape[1], x1 + px)
    rgb = arr(img.convert("RGB"))[y0:y1, x0:x1]
    m = sil[y0:y1, x0:x1]
    w = max(1, int(round((x1 - x0) * height / max(1, y1 - y0))))
    rgb = arr(to_img(rgb).resize((w, height), Image.LANCZOS))
    m = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize((w, height), Image.BILINEAR), np.float32) / 255
    # On one neutral grey, so the backgrounds (white paper, a render's sky) don't count.
    rgb = rgb * m[..., None] + 0.5 * (1 - m[..., None])
    return rgb, m


def centre(a, width, fill):
    h, w = a.shape[:2]
    out = np.full((h, width) + a.shape[2:], fill, np.float32)
    x = (width - w) // 2
    out[:, x:x + w] = a
    return out


def shift_scale(a, s, tx, ty, fill):
    """a scaled by s about its centre and moved by tx, ty pixels (same size out)."""
    h, w = a.shape[:2]
    cx, cy = w / 2, h / 2
    coeffs = (1 / s, 0, cx - (cx + tx) / s, 0, 1 / s, cy - (cy + ty) / s)
    if a.ndim == 2:
        img = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), "L")
        return np.asarray(img.transform((w, h), Image.AFFINE, coeffs, Image.BILINEAR, fillcolor=int(fill * 255)), np.float32) / 255
    return arr(to_img(a).transform((w, h), Image.AFFINE, coeffs, Image.BICUBIC, fillcolor=tuple([int(fill * 255)] * 3)))


def align(ref_m, ren_rgb, ren_m, bg):
    """Moves and scales the render so its outline sits best on the reference's (a part
    missing at the top shouldn't make the whole render look the wrong size)."""
    h, w = ref_m.shape
    f = 64 / h
    small = lambda m: np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize((max(8, int(w * f)), 64), Image.BILINEAR), np.float32) / 255 > 0.5
    rs, ns = small(ref_m), small(ren_m).astype(np.float32)
    best, pick = -1, (1.0, 0, 0)
    for s in np.arange(0.8, 1.21, 0.05):
        for dy in range(-6, 7, 1):
            for dx in range(-4, 5, 1):
                m = shift_scale(ns, s, dx, dy, 0) > 0.5
                iou = (m & rs).sum() / max(1, (m | rs).sum())
                if iou > best + 1e-6 or (abs(iou - best) < 1e-6 and abs(s - 1) + abs(dx) + abs(dy) < abs(pick[0] - 1) + abs(pick[1]) + abs(pick[2])):
                    best, pick = iou, (float(s), dx, dy)
    s, dx, dy = pick
    if (s, dx, dy) == (1.0, 0, 0):
        return ren_rgb, ren_m, pick
    return shift_scale(ren_rgb, s, dx / f, dy / f, bg), shift_scale(ren_m, s, dx / f, dy / f, 0), pick


def detail_map(rgb):
    g = gray(rgb)
    gx = np.abs(np.diff(g, axis=1, append=g[:, -1:]))
    gy = np.abs(np.diff(g, axis=0, append=g[-1:, :]))
    return gx + gy


def main_colours(rgb, mask, count=6):
    px = rgb[mask > 0.5]
    if len(px) < 10:
        return []
    if len(px) > 40000:
        px = px[:: len(px) // 40000 + 1]
    q = Image.fromarray((px.reshape(-1, 1, 3) * 255).astype(np.uint8)).quantize(colors=count, method=Image.Quantize.MEDIANCUT)
    pal = np.asarray(q.getpalette()[: count * 3], np.float32).reshape(-1, 3) / 255
    total = len(px)
    return [{"hex": hexof(pal[i]), "rgb": pal[i].tolist(), "share": round(n / total, 3)} for n, i in sorted(q.getcolors(), reverse=True) if i < len(pal)]


def cmd_compare(a):
    height = int(a.get("size", 512))
    grid = max(3, min(5, int(a.get("grid", 3))))
    mode = a.get("mode", "full")  # full: shape, colour and detail; shape: the outline only (clay renders)
    out_dir = a["output_dir"]
    os.makedirs(out_dir, exist_ok=True)
    try:
        font = ImageFont.load_default(size=16)
        small = ImageFont.load_default(size=13)
    except TypeError:
        font = small = ImageFont.load_default()
    results = []
    for n, pair in enumerate(a["pairs"]):
        label = str(pair.get("label") or f"pair {n + 1}")
        ref_rgb, ref_m = subject(Image.open(pair["reference"]), height)
        ren_rgb, ren_m = subject(Image.open(pair["render"]), height)
        width = max(ref_rgb.shape[1], ren_rgb.shape[1])
        bg = 0.5
        ref_rgb, ren_rgb = centre(ref_rgb, width, bg), centre(ren_rgb, width, bg)
        ref_m, ren_m = centre(ref_m, width, 0), centre(ren_m, width, 0)
        if a.get("align", True):
            ren_rgb, ren_m, moved = align(ref_m, ren_rgb, ren_m, bg)
        else:
            moved = (1.0, 0, 0)
        both, union = (ref_m > 0.5) & (ren_m > 0.5), (ref_m > 0.5) | (ren_m > 0.5)
        shape = float(both.sum() / max(1, union.sum()))
        ref_s, ren_s = blur(ref_rgb, 1.5), blur(ren_rgb, 1.5)
        cdiff = np.abs(ref_s - ren_s).mean(-1)
        colour = float(1 - min(1, cdiff[both].mean() / 0.35)) if both.any() else 0.0
        ref_d, ren_d = detail_map(ref_rgb), detail_map(ren_rgb)
        rd, nd = float(ref_d[ref_m > 0.5].mean()) if (ref_m > 0.5).any() else 0, float(ren_d[ren_m > 0.5].mean()) if (ren_m > 0.5).any() else 0
        detail = float(min(rd, nd) / max(rd, nd, 1e-6))
        overall = shape if mode == "shape" else 0.4 * shape + 0.35 * colour + 0.25 * detail

        # The grid: where the two differ most.
        cells = []
        rows, cols = ROW_NAMES[grid], COL_NAMES[grid]
        H, W = height, width
        for r in range(grid):
            for c in range(grid):
                y0, y1, x0, x1 = r * H // grid, (r + 1) * H // grid, c * W // grid, (c + 1) * W // grid
                u = union[y0:y1, x0:x1]
                if u.mean() < 0.02:
                    continue
                rm, nm = ref_m[y0:y1, x0:x1] > 0.5, ren_m[y0:y1, x0:x1] > 0.5
                missing = float((rm & ~nm).sum() / max(1, u.sum()))
                extra = float((nm & ~rm).sum() / max(1, u.sum()))
                b = rm & nm
                cd = float(cdiff[y0:y1, x0:x1][b].mean()) if b.any() else 0.0
                rdc = float(ref_d[y0:y1, x0:x1][rm].mean()) if rm.any() else 0.0
                ndc = float(ren_d[y0:y1, x0:x1][nm].mean()) if nm.any() else 0.0
                ratio = (ndc + 1e-4) / (rdc + 1e-4)
                dgap = min(1.0, abs(math.log2(ratio)) / 2)
                score = 0.45 * (missing + extra) + (0 if mode == "shape" else 0.35 * min(1, cd / 0.35) + 0.2 * dgap)
                notes = []
                if missing > 0.12:
                    notes.append(f"the reference has a part here the render is missing ({round(missing * 100)}% of this area)")
                if extra > 0.12:
                    notes.append(f"the render has shape here the reference doesn't ({round(extra * 100)}% of this area)")
                if mode != "shape" and b.any() and cd > 0.12:
                    notes.append(f"colours differ: the reference is {hexof(ref_rgb[y0:y1, x0:x1][b].mean(0))}, the render {hexof(ren_rgb[y0:y1, x0:x1][b].mean(0))}")
                if mode != "shape" and rm.any() and nm.any() and ratio < 0.6:
                    notes.append(f"the reference has {round(1 / ratio, 1)}x the fine detail here (trims, panel lines, engraving, pattern, texture); the render is flatter")
                if mode != "shape" and rm.any() and nm.any() and ratio > 1.7:
                    notes.append(f"the render is {round(ratio, 1)}x busier or noisier here than the reference")
                cells.append({"cell": f"{'ABCDE'[r]}{c + 1}", "where": f"{rows[r]} {cols[c]}" if rows[r] != "middle" or cols[c] != "centre" else "centre",
                              "box": [x0, y0, x1, y1], "score": round(score, 3), "missing": round(missing, 3), "extra": round(extra, 3),
                              "colour_diff": round(cd, 3), "detail_ratio": round(ratio, 2), "notes": notes})
        places = [c for c in sorted(cells, key=lambda c: -c["score"]) if c["score"] > 0.1 and c["notes"]][:8]
        worst = places[: int(a.get("closeups", 3))]

        # The sheet: reference | render | differences, the grid over each, the worst places boxed.
        heat = np.repeat(gray(ref_rgb)[..., None] * 0.55, 3, -1)
        heat[..., 0] = np.maximum(heat[..., 0], np.clip(cdiff / 0.35, 0, 1) * both if mode != "shape" else 0)
        mis, ext = (ref_m > 0.5) & (ren_m <= 0.5), (ren_m > 0.5) & (ref_m <= 0.5)
        heat[mis] = [1.0, 0.85, 0.1]   # yellow: in the reference, missing from the render
        heat[ext] = [0.2, 0.6, 1.0]    # blue: in the render, not in the reference
        top = 30
        sheet = Image.new("RGB", (max(W * 3 + 20, 760), H + top + 44), (24, 24, 28))
        d = ImageDraw.Draw(sheet)
        for i, (panel, name) in enumerate([(ref_rgb, "REFERENCE"), (ren_rgb, "RENDER"), (heat, "DIFFERENCES")]):
            x = i * (W + 10)
            sheet.paste(to_img(panel), (x, top))
            d.text((x + 6, 7), name, fill=(240, 240, 240), font=font)
            for g in range(1, grid):
                d.line([(x + g * W // grid, top), (x + g * W // grid, top + H)], fill=(90, 90, 100), width=1)
                d.line([(x, top + g * H // grid), (x + W, top + g * H // grid)], fill=(90, 90, 100), width=1)
            for c in cells:
                d.text((x + c["box"][0] + 3, top + c["box"][1] + 2), c["cell"], fill=(160, 160, 170), font=small)
            for k, c in enumerate(worst):
                bx = c["box"]
                d.rectangle([x + bx[0] + 1, top + bx[1] + 1, x + bx[2] - 2, top + bx[3] - 2], outline=(255, 60, 60), width=3)
                d.text((x + bx[2] - 16, top + bx[3] - 20), str(k + 1), fill=(255, 80, 80), font=font)
        d.text((6, top + H + 5), f"{label}: overall {round(overall * 100)}%  shape {round(shape * 100)}%" + ("" if mode == "shape" else f"  colour {round(colour * 100)}%  detail {round(detail * 100)}%"), fill=(230, 230, 230), font=small)
        d.text((6, top + H + 23), "Differences: yellow = in the reference, missing from the render; blue = extra in the render; red = colour off. Boxes 1-3: the worst places.", fill=(170, 170, 180), font=small)
        base = os.path.join(out_dir, f"compare_{n + 1}")
        sheet_path = save(sheet, base + "_sheet.jpg")

        # Close-ups of the worst places, reference beside render.
        close_path = ""
        if worst:
            ch = int(a.get("closeup_size", 320))
            tiles = []
            for k, c in enumerate(worst):
                x0, y0, x1, y1 = c["box"]
                mx, my = (x1 - x0) // 6, (y1 - y0) // 6
                box = (max(0, x0 - mx), max(0, y0 - my), min(W, x1 + mx), min(H, y1 + my))
                cw = max(1, int(round((box[2] - box[0]) * ch / max(1, box[3] - box[1]))))
                tile = Image.new("RGB", (cw * 2 + 10, ch + 24), (24, 24, 28))
                tile.paste(to_img(ref_rgb).crop(box).resize((cw, ch), Image.LANCZOS), (0, 24))
                tile.paste(to_img(ren_rgb).crop(box).resize((cw, ch), Image.LANCZOS), (cw + 10, 24))
                ImageDraw.Draw(tile).text((4, 4), f"{k + 1}: {c['cell']} {c['where']} - reference | render", fill=(255, 120, 120), font=small)
                tiles.append(tile)
            cw = max(t.width for t in tiles)
            closeups = Image.new("RGB", (cw, sum(t.height + 8 for t in tiles)), (24, 24, 28))
            y = 0
            for t in tiles:
                closeups.paste(t, (0, y))
                y += t.height + 8
            close_path = save(closeups, base + "_closeups.jpg")

        ref_pal, ren_pal = main_colours(ref_rgb, ref_m), main_colours(ren_rgb, ren_m)
        missing_colours, extra_colours = [], []
        if mode != "shape":
            dist = lambda p, q: float(np.sqrt(((np.asarray(p["rgb"]) - np.asarray(q["rgb"])) ** 2).sum() / 3))
            for p in ref_pal:
                if p["share"] >= 0.05 and (not ren_pal or min(dist(p, q) for q in ren_pal) > 0.12):
                    missing_colours.append(p)
            for q in ren_pal:
                if q["share"] >= 0.05 and (not ref_pal or min(dist(q, p) for p in ref_pal) > 0.12):
                    extra_colours.append(q)
        results.append({"label": label, "sheet": sheet_path, "closeups": close_path, "overall": round(overall, 3), "shape": round(shape, 3),
                        "colour": round(colour, 3), "detail": round(detail, 3), "aligned": {"scale": round(moved[0], 2), "dx": moved[1], "dy": moved[2]},
                        "worst": worst, "places": places, "cells": cells, "reference_palette": ref_pal, "render_palette": ren_pal,
                        "missing_colours": missing_colours, "extra_colours": extra_colours})
    return {"ok": True, "pairs": results}


def cmd_info(a):
    have = {"numpy": True, "pillow": True}
    try:
        import rembg  # noqa: F401
        have["rembg"] = True
    except Exception:
        have["rembg"] = False
    return {"ok": True, "have": have}


COMMANDS = {k[4:]: v for k, v in globals().items() if k.startswith("cmd_")}

if __name__ == "__main__":
    try:
        cmd = sys.argv[1]
        args = json.load(open(sys.argv[2], encoding="utf-8")) if len(sys.argv) > 2 else {}
        if cmd not in COMMANDS:
            raise ValueError(f"unknown command {cmd}; commands: {', '.join(sorted(COMMANDS))}")
        result = COMMANDS[cmd](args)
    except Exception as err:  # one JSON line either way
        result = {"ok": False, "error": f"{type(err).__name__}: {err}"}
    print(json.dumps(result))
