// Roblox art and asset uploads: models made for Godot or Blender are re-exported to fit
// Roblox's rules, checked, and uploaded to Roblox through Open Cloud (Roblox's free
// public API), and each upload's id lands in an Assets module the game's scripts read.
//
//   createRobloxAssets({ getProjectDir, env, log, runBlender, runLuau, fetchImpl })
//     -> { tools, names, callTool(name, args) }
//
// Roblox's rules (create.roblox.com/docs/art/modeling/specifications): a mesh can't have
// more than 20,000 triangles, a vertex can't be weighted to more than 4 bones, and bones
// rest at scale 1. Textures above 1024x1024 are downscaled by Roblox anyway, so CoDev
// shrinks them first to keep uploads small.
//
// Uploads need the user's own Open Cloud API key (CODEV_ROBLOX_API_KEY, made free on the
// Creator Dashboard with the Assets API's read and write permissions) and who owns the
// assets (CODEV_ROBLOX_CREATOR: "user:<id>" or "group:<id>"). The key goes to
// apis.roblox.com only, never to Blender or a tool's output. The page asks the user
// before every upload (_meta codev/alwaysAsk), since an upload publishes to Roblox.
//
// Open Cloud takes animations only as Roblox's own .rbxm/.rbxmx files (saved from Studio's
// Animation Editor or an animation plugin); a .fbx animation goes into Studio through the
// 3D Importer, which makes the clip there.
const fs = require('fs');
const path = require('path');

const API = 'https://apis.roblox.com/assets/v1';
const MAX_TRIANGLES = 20000;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const REGISTRY = path.join('assets', 'roblox', 'assets.json');

// Extension -> [Open Cloud assetType, content type].
const TYPES = {
    fbx: ['Model', 'model/fbx'], glb: ['Model', 'model/gltf-binary'], gltf: ['Model', 'model/gltf+json'],
    rbxm: ['Model', 'model/x-rbxm'], rbxmx: ['Model', 'model/x-rbxm'],
    png: ['Decal', 'image/png'], jpg: ['Decal', 'image/jpeg'], jpeg: ['Decal', 'image/jpeg'], bmp: ['Decal', 'image/bmp'], tga: ['Decal', 'image/tga'],
    mp3: ['Audio', 'audio/mpeg'], ogg: ['Audio', 'audio/ogg'], wav: ['Audio', 'audio/wav'], flac: ['Audio', 'audio/flac'],
    mp4: ['Video', 'video/mp4'], mov: ['Video', 'video/mov']
};
const KINDS = { model: 'Model', image: 'Decal', decal: 'Decal', audio: 'Audio', animation: 'Animation', video: 'Video' };

function text(value, isError = false) {
    return { content: [{ type: 'text', text: String(value) }], ...(isError ? { isError: true } : {}) };
}

// A path inside the project folder (no "..", no hidden parts), or "".
function inside(root, rel) {
    const raw = String(rel || '').replace(/\\/g, '/');
    if (!raw || path.isAbsolute(raw) || raw.split('/').some(p => p === '..' || p.startsWith('.'))) return '';
    const full = path.resolve(root, raw);
    return full.startsWith(path.resolve(root) + path.sep) ? full : '';
}

// A Luau identifier for an asset name: "coin pickup.fbx" -> "CoinPickup".
function luauName(name) {
    const words = String(name).replace(/\.[a-z0-9]+$/i, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
    let id = words.map(w => w[0].toUpperCase() + w.slice(1)).join('');
    if (!id) id = 'Asset';
    if (/^\d/.test(id)) id = `Asset${id}`;
    return id.slice(0, 60);
}

function parseCreator(raw) {
    const m = String(raw || '').trim().match(/^(user|group):(\d+)$/i);
    if (!m) return null;
    return m[1].toLowerCase() === 'user' ? { userId: m[2] } : { groupId: m[2] };
}

// Counts from a .glb without Blender: triangles per mesh, joints per skin, image sizes.
function inspectGlb(buffer) {
    if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('Not a .glb file (wrong magic number).');
    const jsonLength = buffer.readUInt32LE(12);
    const gltf = JSON.parse(buffer.slice(20, 20 + jsonLength).toString('utf8'));
    const binStart = 20 + jsonLength + 8;
    const accessors = gltf.accessors || [];
    const meshes = (gltf.meshes || []).map((mesh, i) => {
        let triangles = 0;
        for (const p of mesh.primitives || []) {
            const mode = p.mode === undefined ? 4 : p.mode;
            const count = p.indices !== undefined ? (accessors[p.indices] || {}).count : (accessors[(p.attributes || {}).POSITION] || {}).count;
            if (mode === 4) triangles += Math.floor((count || 0) / 3);
            else if (mode === 5 || mode === 6) triangles += Math.max(0, (count || 0) - 2);
        }
        const weights = (mesh.primitives || []).some(p => (p.attributes || {}).WEIGHTS_1 !== undefined) ? 8 : (mesh.primitives || []).some(p => (p.attributes || {}).WEIGHTS_0 !== undefined) ? 4 : 0;
        return { name: mesh.name || `mesh${i}`, triangles, maxInfluences: weights };
    });
    const images = (gltf.images || []).map((img, i) => {
        let width = 0; let height = 0;
        const view = img.bufferView !== undefined ? (gltf.bufferViews || [])[img.bufferView] : null;
        if (view && (img.mimeType === 'image/png' || !img.mimeType)) {
            const at = binStart + (view.byteOffset || 0);
            if (buffer.readUInt32BE(at) === 0x89504e47) { width = buffer.readUInt32BE(at + 16); height = buffer.readUInt32BE(at + 20); }
        }
        return { name: img.name || `image${i}`, width, height };
    });
    const joints = Math.max(0, ...(gltf.skins || []).map(s => (s.joints || []).length));
    return { meshes, images, joints, animations: (gltf.animations || []).length };
}

function pngSize(buffer) {
    if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// Fits a model to Roblox in Blender: transforms applied, each mesh decimated under the
// triangle limit and triangulated, at most 4 bone weights per vertex, textures shrunk.
const EXPORT_SCRIPT = `
import bpy, os, json
src = os.environ["CODEV_INPUT"]
out = os.environ["CODEV_OUTPUT"]
max_tris = int(os.environ["CODEV_MAX_TRIS"])
tex_max = int(os.environ["CODEV_TEX"])
keep_anim = os.environ.get("CODEV_ANIM") == "1"
report = {"meshes": [], "textures": [], "warnings": [], "armatures": 0, "animations": 0}
ext = src.lower().rsplit(".", 1)[-1]
if ext == "blend":
    bpy.ops.wm.open_mainfile(filepath=src)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if ext in ("glb", "gltf"): bpy.ops.import_scene.gltf(filepath=src)
    elif ext == "fbx": bpy.ops.import_scene.fbx(filepath=src)
    elif ext == "obj": bpy.ops.wm.obj_import(filepath=src)
    else: raise SystemExit("Unsupported input: " + ext)

# The glTF importer adds display shapes for bones; they aren't part of the model.
shapes = {b.custom_shape for o in bpy.context.scene.objects if o.type == "ARMATURE" for b in o.pose.bones if b.custom_shape}
for sh in shapes: bpy.data.objects.remove(sh, do_unlink=True)

def tris(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = ob.evaluated_get(dg)
    m = ev.to_mesh()
    m.calc_loop_triangles()
    n = len(m.loop_triangles)
    ev.to_mesh_clear()
    return n

def apply_mod(ob, kind, **props):
    mod = ob.modifiers.new("CoDev" + kind, kind)
    for k, v in props.items(): setattr(mod, k, v)
    with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob]):
        bpy.ops.object.modifier_apply(modifier=mod.name)

for ob in list(bpy.context.scene.objects):
    if ob.type == "ARMATURE":
        report["armatures"] += 1
        for b in ob.pose.bones:
            if any(abs(s - 1) > 1e-4 for s in b.scale): report["warnings"].append("bone %s is posed at scale %s; Roblox wants bones at scale 1" % (b.name, tuple(round(s, 3) for s in b.scale)))
    if ob.type != "MESH": continue
    if ob.data.users > 1: ob.data = ob.data.copy()
    try:
        with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]):
            bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    except Exception as e:
        report["warnings"].append("%s: transforms not applied (%s)" % (ob.name, e))
    before = tris(ob)
    after = before
    try:
        tries = 0
        while after > max_tris and tries < 4:
            apply_mod(ob, "DECIMATE", ratio=max(0.01, (max_tris / after) * 0.97))
            after = tris(ob)
            tries += 1
        apply_mod(ob, "TRIANGULATE")
        after = tris(ob)
    except Exception as e:
        report["warnings"].append("%s: couldn't decimate (%s); shape keys block it, remove them or reduce in Blender" % (ob.name, e))
    limited = False
    if ob.vertex_groups:
        with bpy.context.temp_override(object=ob, active_object=ob, selected_objects=[ob]):
            bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
            bpy.ops.object.vertex_group_normalize_all(lock_active=False)
        limited = True
    report["meshes"].append({"name": ob.name, "before": before, "after": after, "weights_limited": limited})

for img in bpy.data.images:
    w, h = img.size[0], img.size[1]
    if w and h and max(w, h) > tex_max:
        f = tex_max / max(w, h)
        img.scale(max(1, int(w * f)), max(1, int(h * f)))
        img.pack()
        report["textures"].append({"name": img.name, "from": [w, h], "to": [img.size[0], img.size[1]]})

report["animations"] = len(bpy.data.actions)
os.makedirs(os.path.dirname(out), exist_ok=True)
if out.lower().endswith(".fbx"):
    bpy.ops.export_scene.fbx(filepath=out, path_mode="COPY", embed_textures=True, apply_scale_options="FBX_SCALE_ALL",
        add_leaf_bones=False, bake_anim=keep_anim, axis_forward="-Z", axis_up="Y")
else:
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_apply=True, export_animations=keep_anim)
print("CODEV_REPORT " + json.dumps(report))
`;

function createRobloxAssets({ getProjectDir = () => '', env = process.env, log = () => {}, runBlender = null, runLuau = null, sharedDir = () => 'src/shared', fetchImpl = globalThis.fetch } = {}) {
    function registryFile(root) { return path.join(root, REGISTRY); }

    function readRegistry(root) {
        try { return JSON.parse(fs.readFileSync(registryFile(root), 'utf8')); } catch { return {}; }
    }

    // The registry, and the Luau module the game's scripts require.
    function writeRegistry(root, registry) {
        fs.mkdirSync(path.dirname(registryFile(root)), { recursive: true });
        fs.writeFileSync(registryFile(root), JSON.stringify(registry, null, 2) + '\n');
        const names = Object.keys(registry).sort();
        const content = names.map(n => `\t${n} = "rbxassetid://${registry[n].imageId || registry[n].id}",`);
        const ids = names.map(n => `\t\t${n} = ${Number(registry[n].id)},`);
        const lua = [
            '--!strict',
            '-- Made by CoDev from assets/roblox/assets.json. roblox_upload keeps it up to date; don\'t edit it by hand.',
            '-- Assets.Name is the content id for properties like Texture, SoundId and AnimationId;',
            '-- Assets.Ids.Name is the asset number (for InsertService:LoadAsset with a model).',
            'local Assets = {',
            ...content,
            '\tIds = {',
            ...ids,
            '\t},',
            '}',
            '',
            'return Assets',
            ''
        ].join('\n');
        const target = inside(root, path.posix.join(sharedDir() || 'src/shared', 'Assets.luau'));
        if (target) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, lua); }
        return target ? path.relative(root, target).split(path.sep).join('/') : '';
    }

    function verdict(info) {
        const lines = [];
        let bad = 0;
        for (const m of info.meshes) {
            const over = m.triangles > MAX_TRIANGLES;
            if (over) bad++;
            lines.push(`${over ? '✗' : '✓'} mesh ${m.name}: ${m.triangles.toLocaleString('en-US')} triangles${over ? ` (Roblox allows ${MAX_TRIANGLES.toLocaleString('en-US')} per mesh)` : ''}`);
            if (m.maxInfluences > 4) { bad++; lines.push(`✗ mesh ${m.name}: more than 4 bone weights per vertex (Roblox allows 4)`); }
        }
        for (const img of info.images) {
            if (img.width > 1024 || img.height > 1024) lines.push(`! texture ${img.name}: ${img.width}x${img.height}; Roblox shows at most 1024x1024, so it would be downscaled`);
        }
        if (info.joints) lines.push(`  ${info.joints} bones`);
        if (info.animations) lines.push(`  ${info.animations} animation(s): Studio's 3D Importer brings these in; Open Cloud uploads don't keep them`);
        return { lines, bad };
    }

    async function check({ file } = {}) {
        const root = getProjectDir();
        const full = root && inside(root, file);
        if (!full || !fs.existsSync(full)) return text(`No file "${file}" in the project folder.`, true);
        const ext = path.extname(full).slice(1).toLowerCase();
        const size = fs.statSync(full).size;
        const out = [`${file}: ${(size / 1024 / 1024).toFixed(2)} MB${size > MAX_UPLOAD_BYTES ? ' (over Open Cloud\'s 20 MB upload limit)' : ''}`];
        let bad = size > MAX_UPLOAD_BYTES ? 1 : 0;
        if (ext === 'glb') {
            const v = verdict(inspectGlb(fs.readFileSync(full)));
            out.push(...v.lines);
            bad += v.bad;
        } else if (ext === 'png') {
            const s = pngSize(fs.readFileSync(full));
            if (s && (s.width > 1024 || s.height > 1024)) out.push(`! ${s.width}x${s.height}: Roblox shows textures at most 1024x1024 (and uploads must be under 8000x8000)`);
            else if (s) out.push(`✓ ${s.width}x${s.height}`);
        } else if (['fbx', 'obj', 'gltf', 'blend'].includes(ext)) {
            out.push('Triangle counts for this format need Blender: roblox_export_model checks and fixes it, writing a Roblox-ready file.');
        }
        out.unshift(bad ? `${bad} problem(s): run roblox_export_model to fix them before uploading.` : 'Ready for Roblox.');
        return text(out.join('\n'), bad > 0);
    }

    async function exportModel({ input, output = '', max_triangles: maxTriangles = MAX_TRIANGLES, texture_size: textureSize = 1024, animation = true } = {}) {
        const root = getProjectDir();
        if (!root || !fs.existsSync(root)) return text('No project folder is set.', true);
        const src = inside(root, input);
        if (!src || !fs.existsSync(src)) return text(`No file "${input}" in the project folder. Give a .glb, .gltf, .fbx, .obj or .blend path inside it.`, true);
        if (!/\.(glb|gltf|fbx|obj|blend)$/i.test(src)) return text('input must be a .glb, .gltf, .fbx, .obj or .blend file.', true);
        const outRel = output || path.posix.join('assets', 'roblox', `${path.basename(src).replace(/\.[^.]+$/, '')}.fbx`);
        const out = inside(root, outRel);
        if (!out || !/\.(fbx|glb)$/i.test(out)) return text(`output must be a .fbx or .glb path inside the project folder (got "${outRel}").`, true);
        if (!runBlender) return text('Blender isn\'t available here.', true);
        const tris = Math.min(Math.max(Number(maxTriangles) || MAX_TRIANGLES, 100), MAX_TRIANGLES);
        const tex = [256, 512, 1024].includes(Number(textureSize)) ? Number(textureSize) : 1024;
        const result = await runBlender(EXPORT_SCRIPT, { CODEV_INPUT: src, CODEV_OUTPUT: out, CODEV_MAX_TRIS: String(tris), CODEV_TEX: String(tex), CODEV_ANIM: animation === false ? '0' : '1' }, 600000);
        if (!result) return text('Blender isn\'t installed where CoDev can find it. The user can install it free from blender.org, or set CODEV_BLENDER_PATH to blender.exe.', true);
        const m = String(result.output).match(/CODEV_REPORT (\{.*\})/);
        if (result.code !== 0 || !m || !fs.existsSync(out)) return text(`Blender couldn't export the model (exit ${result.code}).\n${String(result.output).trim().slice(-3000)}`, true);
        const report = JSON.parse(m[1]);
        const lines = [`Saved ${path.relative(root, out).split(path.sep).join('/')} (${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB) for Roblox:`];
        for (const mesh of report.meshes) lines.push(`  ${mesh.name}: ${mesh.before.toLocaleString('en-US')} -> ${mesh.after.toLocaleString('en-US')} triangles${mesh.weights_limited ? ', bone weights limited to 4 per vertex' : ''}`);
        for (const t of report.textures) lines.push(`  texture ${t.name}: ${t.from.join('x')} -> ${t.to.join('x')}`);
        if (report.armatures) lines.push(`  ${report.armatures} armature(s), ${report.animations} animation(s)${animation === false ? ' (animations left out)' : ''}`);
        for (const w of report.warnings) lines.push(`  ! ${w}`);
        const over = report.meshes.filter(x => x.after > MAX_TRIANGLES);
        if (over.length) lines.push(`Still over ${MAX_TRIANGLES} triangles: ${over.map(x => x.name).join(', ')}. Split those meshes in Blender.`);
        lines.push('Next: roblox_upload this file (or import it with Studio\'s 3D Importer to keep its animations).');
        return text(lines.join('\n'), over.length > 0);
    }

    async function api(pathname, options = {}) {
        const key = env.CODEV_ROBLOX_API_KEY;
        const response = await fetchImpl(`${API}/${pathname}`, { ...options, headers: { 'x-api-key': key, ...(options.headers || {}) } });
        const body = await response.text();
        let json = null;
        try { json = JSON.parse(body); } catch { /* not JSON */ }
        if (!response.ok) {
            const why = (json && (json.message || (json.errors && json.errors[0] && json.errors[0].message))) || body.slice(0, 300) || response.statusText;
            const hint = response.status === 401 || response.status === 403
                ? ' Check that the key has the Assets API with read and write, that its IP list allows this computer (0.0.0.0/0 is fine for a key only you hold), and that it belongs to the creator in CODEV_ROBLOX_CREATOR.'
                : '';
            throw new Error(`Roblox Open Cloud answered ${response.status}: ${why}.${hint}`);
        }
        return json || {};
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function upload({ file, name = '', type = '', description = '', insert = false, height_studs: heightStuds = 0 } = {}) {
        const root = getProjectDir();
        const full = root && inside(root, file);
        if (!full || !fs.existsSync(full)) return text(`No file "${file}" in the project folder.`, true);
        if (!env.CODEV_ROBLOX_API_KEY) return text('Uploading needs the user\'s Roblox Open Cloud API key. Ask them to make one (free): Creator Dashboard > Open Cloud > API Keys > Create API Key, add the "Assets" API with Read and Write, allow their IP (or 0.0.0.0/0), then put it in CoDev\'s .env as CODEV_ROBLOX_API_KEY, with CODEV_ROBLOX_CREATOR=user:<their user id> (or group:<group id> for a group game).', true);
        const creator = parseCreator(env.CODEV_ROBLOX_CREATOR);
        if (!creator) return text('CODEV_ROBLOX_CREATOR must say who owns the uploads: user:<user id> (the number in their profile link) or group:<group id>.', true);
        const ext = path.extname(full).slice(1).toLowerCase();
        const known = TYPES[ext];
        if (!known) return text(`Roblox can't take .${ext} files. Models: .fbx .glb .gltf .rbxm; images: .png .jpg .bmp .tga; audio: .mp3 .ogg .wav .flac; video: .mp4 .mov; animations: .rbxm .rbxmx.`, true);
        let assetType = type ? KINDS[String(type).toLowerCase()] : known[0];
        if (!assetType) return text(`type must be one of ${Object.keys(KINDS).join(', ')}.`, true);
        if (assetType === 'Animation' && !/^rbxmx?$/.test(ext)) return text('Roblox takes animations only as .rbxm or .rbxmx files (save one from Studio\'s Animation Editor). For an animation in a .fbx, import the .fbx with Studio\'s 3D Importer, which makes the animation clip there.', true);
        const size = fs.statSync(full).size;
        if (size > MAX_UPLOAD_BYTES && assetType !== 'Video') return text(`${file} is ${(size / 1024 / 1024).toFixed(1)} MB; Open Cloud takes up to 20 MB. roblox_export_model makes it smaller.`, true);
        if (ext === 'glb' && assetType === 'Model') {
            const v = verdict(inspectGlb(fs.readFileSync(full)));
            if (v.bad) return text(`Not uploaded: the model breaks Roblox's limits.\n${v.lines.join('\n')}\nRun roblox_export_model on it first.`, true);
        }
        const key = luauName(name || path.basename(full));
        const displayName = String(name || key).slice(0, 50);
        const form = new FormData();
        form.append('request', JSON.stringify({ assetType, displayName, description: String(description || `Made with CoDev: ${displayName}`).slice(0, 1000), creationContext: { creator } }));
        form.append('fileContent', new Blob([fs.readFileSync(full)], { type: known[1] }), path.basename(full));
        let op = await api('assets', { method: 'POST', body: form });
        const opPath = op.path || (op.operationId ? `operations/${op.operationId}` : '');
        const started = Date.now();
        while (!op.done && opPath && Date.now() - started < 180000) {
            await sleep(op.done === false ? 2000 : 0);
            op = await api(opPath.replace(/^.*?(operations\/)/, '$1'));
        }
        if (!op.done) return text(`Roblox is still processing the upload (${opPath}). Try roblox_upload's result later in the Creator Dashboard under Development Items.`, true);
        if (op.error) return text(`Roblox refused the upload: ${op.error.message || JSON.stringify(op.error)}`, true);
        const res = op.response || {};
        const assetId = String(res.assetId || '');
        if (!assetId) return text(`The upload finished without an asset id: ${JSON.stringify(op).slice(0, 500)}`, true);
        const moderation = (res.moderationResult && res.moderationResult.moderationState) || '';
        const entry = { id: Number(assetId), type: assetType, file: path.relative(root, full).split(path.sep).join('/'), uploadedAt: new Date().toISOString(), ...(moderation ? { moderation } : {}) };

        const notes = [];
        // A decal's id isn't the image's; scripts need the image (Texture, Image properties).
        if (assetType === 'Decal' && runLuau) {
            try {
                const r = await runLuau(`local m = game:GetService("InsertService"):LoadAsset(${Number(assetId)})\nlocal d = m:FindFirstChildWhichIsA("Decal", true)\nprint("CODEV_IMAGE " .. (d and d.Texture or ""))\nm:Destroy()`);
                const img = (r.output.match(/CODEV_IMAGE\s+\S*?(\d+)\s*$/m) || [])[1];
                if (img) entry.imageId = Number(img);
            } catch (err) { notes.push(`Couldn't look up the decal's image id in Studio (${err.message}); Assets.${key} uses the decal id, which works in Studio's Properties but not always in scripts.`); }
        }
        const registry = readRegistry(root);
        registry[key] = entry;
        const module = writeRegistry(root, registry);

        if (insert && assetType === 'Model' && runLuau) {
            const scale = Number(heightStuds) > 0 ? Number(heightStuds) : 0;
            try {
                const r = await runLuau([
                    'local CHS = game:GetService("ChangeHistoryService")',
                    `local rec = CHS:TryBeginRecording("CoDev insert ${key}")`,
                    `local m = game:GetService("InsertService"):LoadAsset(${Number(assetId)})`,
                    'local model = m:GetChildren()[1]',
                    `model.Name = ${JSON.stringify(key)}`,
                    'model.Parent = workspace',
                    'm:Destroy()',
                    'local size = if model:IsA("Model") then model:GetExtentsSize() else model.Size',
                    scale ? `if model:IsA("Model") and size.Y > 0 then model:ScaleTo(model:GetScale() * ${scale} / size.Y) size = model:GetExtentsSize() end` : '',
                    'if rec then CHS:FinishRecording(rec, Enum.FinishRecordingOperation.Commit) end',
                    'print(("CODEV_SIZE %.2f %.2f %.2f"):format(size.X, size.Y, size.Z))'
                ].filter(Boolean).join('\n'));
                const s = r.output.match(/CODEV_SIZE ([\d.]+) ([\d.]+) ([\d.]+)/);
                notes.push(s ? `Inserted into the Workspace as ${key}: ${s[1]} x ${s[2]} x ${s[3]} studs (a Roblox character is about 5 studs tall)${scale ? '' : '; pass height_studs to resize it'}.` : `Insert into Studio didn't report back: ${r.output.slice(0, 300)}`);
            } catch (err) { notes.push(`Uploaded, but inserting into Studio failed: ${err.message}`); }
        }
        log(`Uploaded ${entry.file} to Roblox as ${assetType} ${assetId}`);
        return text([
            `Uploaded ${entry.file} to Roblox as ${assetType} ${assetId}${moderation ? ` (moderation: ${moderation.replace('MODERATION_STATE_', '').toLowerCase()})` : ''}.`,
            module ? `Scripts use it as require(ReplicatedStorage.Shared.Assets).${key} (${module}, kept with the ids in ${REGISTRY.split(path.sep).join('/')}); roblox_sync puts the module into the place.` : '',
            ...notes
        ].filter(Boolean).join('\n'));
    }

    const tools = [
        {
            name: 'roblox_asset_check',
            description: 'Check an art file against Roblox\'s rules before uploading: triangles per mesh (Roblox allows 20,000), bone weights per vertex (4), texture size (shown at most 1024x1024), bones and animations, and the 20 MB upload limit. Reads .glb and .png directly; other model formats need roblox_export_model. Use it on a model from the art tools or Tripo/Meshy before roblox_upload; it changes nothing, so don\'t use it to fix a file (roblox_export_model does that).',
            inputSchema: { type: 'object', properties: {
                file: { type: 'string', description: 'The file\'s path inside the project folder, like assets/models/coin.glb.' }
            }, required: ['file'] },
            annotations: { readOnlyHint: true }
        },
        {
            name: 'roblox_export_model',
            description: 'Make a Roblox-ready copy of a model with Blender: applies transforms, decimates every mesh under the triangle limit and triangulates it, limits bone weights to 4 per vertex, shrinks textures to 1024 (or smaller), and exports .fbx (default, keeps the rig and animations) or .glb. Returns triangle counts before and after. Use it on any .glb/.gltf/.fbx/.obj/.blend before roblox_upload or Studio\'s 3D Importer; don\'t use it for 2D images or sounds.',
            inputSchema: { type: 'object', properties: {
                input: { type: 'string', description: 'The model inside the project folder: .glb, .gltf, .fbx, .obj or .blend.' },
                output: { type: 'string', description: 'Optional: where to save, .fbx or .glb inside the project folder (default assets/roblox/<name>.fbx).' },
                max_triangles: { type: 'number', description: 'Optional: triangle budget per mesh, up to Roblox\'s 20000 (default 20000; 5000 to 10000 keeps phones fast).' },
                texture_size: { type: 'number', enum: [256, 512, 1024], description: 'Optional: largest texture side in pixels (default 1024).' },
                animation: { type: 'boolean', description: 'Optional: keep animations in the export (default true).' }
            }, required: ['input'] }
        },
        {
            name: 'roblox_upload',
            description: 'Upload a file to Roblox with the user\'s Open Cloud API key and record its id: models (.fbx/.glb/.gltf/.rbxm, which Roblox turns into a Model of MeshParts), images (.png/.jpg/.bmp/.tga as a Decal, with its image id looked up in Studio), audio (.mp3/.ogg/.wav/.flac), video (.mp4/.mov) and animations (.rbxm/.rbxmx from Studio\'s Animation Editor). Writes the id into the Assets module (src/shared/Assets.luau) so scripts use Assets.Name, and can insert a model into the open place, sized in studs. The user is asked before every upload, since it publishes to their Roblox account. Use it once a file passes roblox_asset_check; don\'t upload the same file again to change it (it makes a new asset).',
            inputSchema: { type: 'object', properties: {
                file: { type: 'string', description: 'The file\'s path inside the project folder, like assets/roblox/coin.fbx.' },
                name: { type: 'string', description: 'Optional: the asset\'s name on Roblox and in the Assets module (default from the file name, like CoinPickup).' },
                type: { type: 'string', enum: Object.keys(KINDS), description: 'Optional: what it is, when the file type isn\'t enough (animation for an .rbxm animation).' },
                description: { type: 'string', description: 'Optional: the asset\'s description on Roblox.' },
                insert: { type: 'boolean', description: 'Optional: for a model, also put it into the Workspace of the place open in Studio (default false).' },
                height_studs: { type: 'number', description: 'Optional: with insert, scale the model to this height in studs (a character is about 5).' }
            }, required: ['file'] },
            _meta: { 'codev/alwaysAsk': true }
        }
    ];
    const names = tools.map(t => t.name);

    async function callTool(name, args = {}) {
        try {
            if (name === 'roblox_asset_check') return await check(args);
            if (name === 'roblox_export_model') return await exportModel(args);
            if (name === 'roblox_upload') return await upload(args);
            return text(`Unknown tool: ${name}`, true);
        } catch (err) {
            return text(err.message || String(err), true);
        }
    }

    return { tools, names, callTool };
}

module.exports = { createRobloxAssets, inspectGlb, luauName, parseCreator, EXPORT_SCRIPT, MAX_TRIANGLES };
