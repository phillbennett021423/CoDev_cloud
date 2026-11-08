// The Godot 4 side of the skin pipeline: puts a finished skin into the Godot project
// as an equippable item.
//
//   <skins_dir>/<character>/<id>/   the .glb, its textures, the icon, and one
//                                     ORMMaterial3D .tres per weathering stage
//   <manifest>                        the skin manifest JSON (id, name, character, slot,
//                                     tier, rarity, model, materials, icon, stats...),
//                                     updated in place by id
//   <registry>                        SkinRegistry, an autoload that reads the manifest
//                                     and equips a skin on a character by slot
//
// Paths come from the "godot" section of codev-studio.json. Everything here is pure
// (strings in, strings out) apart from the file writes in installSkin.
const fs = require('fs');
const path = require('path');

const MANIFEST_VERSION = 1;

function res(godotRoot, file) { return 'res://' + path.relative(godotRoot, file).split(path.sep).join('/'); }

// An ORMMaterial3D: albedo, ORM (R ambient occlusion, G roughness, B metallic),
// normal and emission textures, tiled like the .glb.
function materialTres({ albedo, orm, normal, emission, tile = 1 }) {
    const ext = [];
    const id = p => { ext.push(p); return `ExtResource("${ext.length}")`; };
    const props = [];
    if (albedo) props.push(`albedo_texture = ${id(albedo)}`);
    if (orm) props.push(`orm_texture = ${id(orm)}`, 'metallic = 1.0', 'roughness = 1.0');
    if (normal) props.push('normal_enabled = true', `normal_texture = ${id(normal)}`);
    if (emission) props.push('emission_enabled = true', 'emission = Color(1, 1, 1, 1)', `emission_texture = ${id(emission)}`);
    if (Number(tile) && Number(tile) !== 1) props.push(`uv1_scale = Vector3(${Number(tile)}, ${Number(tile)}, 1)`);
    const head = `[gd_resource type="ORMMaterial3D" load_steps=${ext.length + 1} format=3]\n\n`;
    const exts = ext.map((p, i) => `[ext_resource type="Texture2D" path="${p}" id="${i + 1}"]`).join('\n');
    return `${head}${exts}${exts ? '\n\n' : ''}[resource]\n${props.join('\n')}\n`;
}

// The skin manifest with one skin added or replaced (by id), sorted for stable diffs.
function upsertManifest(text, entry) {
    let data = { version: MANIFEST_VERSION, skins: [] };
    if (text && text.trim()) {
        try { data = JSON.parse(text); } catch (err) { throw new Error(`The skin manifest isn't valid JSON (${err.message}); fix it or move it aside.`); }
        if (!data || !Array.isArray(data.skins)) throw new Error('The skin manifest has no "skins" list; it may be another file. Set godot.manifest in codev-studio.json to a new path.');
    }
    data.version = data.version || MANIFEST_VERSION;
    const at = data.skins.findIndex(s => s.id === entry.id);
    if (at >= 0) data.skins[at] = { ...data.skins[at], ...entry, created: data.skins[at].created || entry.created };
    else data.skins.push(entry);
    data.skins.sort((a, b) => `${a.character}/${a.slot}/${a.id}`.localeCompare(`${b.character}/${b.slot}/${b.id}`));
    return JSON.stringify(data, null, 2) + '\n';
}

// project.godot with an autoload added (once), keeping every other section.
function addAutoload(projectText, name, resPath) {
    const line = `${name}="*${resPath}"`;
    const section = /^\[autoload\]\s*$/m;
    if (!section.test(projectText)) return `${projectText.replace(/\s*$/, '\n')}\n[autoload]\n\n${line}\n`;
    const [before, after] = projectText.split(section);
    const end = after.search(/^\[/m);
    let body = end >= 0 ? after.slice(0, end) : after;
    const rest = end >= 0 ? after.slice(end) : '';
    if (new RegExp(`^${name}\\s*=`, 'm').test(body)) return projectText;
    body = `${body.replace(/\s*$/, '')}\n${line}\n${rest ? '\n' : ''}`;
    return `${before}[autoload]${body.startsWith('\n') ? '' : '\n'}${body}${rest}`;
}

function registryScript(manifestRes, helpersRes = manifestRes.replace(/[^/]*$/, 'CoDevHelperBones.gd')) {
    return `extends Node
## SkinRegistry (made by CoDev): reads the skin manifest and equips skins.
##
##   SkinRegistry.for_character("relay", "helmet") -> Array of skin dictionaries
##   SkinRegistry.equip(character_node, "relay_helmet_aegis_epic", "battle") -> Node3D
##
## A skin goes on the child named after its slot (a Node3D or BoneAttachment3D called
## "helmet", "chest"...) or on the character itself. A rigged skin is bound to the
## character's Skeleton3D, so it moves with the character's animations. The variant
## picks a weathering stage (factory, light, worn, battle, ruined).

const MANIFEST := "${manifestRes}"
const SLOT_META := "codev_skin_slot"
const HIDDEN_META := "codev_hidden_by_skin"
const HELPERS := "${helpersRes}"

var skins: Dictionary = {}

func _ready() -> void:
	reload()

func reload() -> void:
	skins.clear()
	if not FileAccess.file_exists(MANIFEST):
		return
	var data = JSON.parse_string(FileAccess.get_file_as_string(MANIFEST))
	if typeof(data) != TYPE_DICTIONARY:
		push_warning("SkinRegistry: %s isn't valid JSON" % MANIFEST)
		return
	for skin in data.get("skins", []):
		skins[skin["id"]] = skin

func get_skin(skin_id: String) -> Dictionary:
	return skins.get(skin_id, {})

func for_character(character: String, slot: String = "") -> Array:
	var found: Array = []
	for skin in skins.values():
		if skin.get("character", "") == character and (slot == "" or skin.get("slot", "") == slot):
			found.append(skin)
	return found

func equip(character_node: Node3D, skin_id: String, variant: String = "") -> Node3D:
	var skin: Dictionary = get_skin(skin_id)
	if skin.is_empty():
		push_warning("SkinRegistry: no skin %s" % skin_id)
		return null
	var slot: String = skin.get("slot", "")
	var rigged: bool = skin.get("rigged", false)
	var parent: Node3D = character_node
	if not rigged:
		var slot_node := character_node.find_child(slot, true, false)
		if slot_node is Node3D:
			parent = slot_node as Node3D
	unequip(character_node, slot)
	var scene: PackedScene = load(skin["model"])
	if scene == null:
		push_warning("SkinRegistry: can't load %s" % skin["model"])
		return null
	var item := scene.instantiate() as Node3D
	if item == null:
		push_warning("SkinRegistry: %s isn't a 3D scene" % skin["model"])
		return null
	item.set_meta(SLOT_META, slot)
	parent.add_child(item)
	var meshes := item.find_children("*", "MeshInstance3D", true, false)
	var materials: Dictionary = skin.get("materials", {})
	var pick: String = variant if materials.has(variant) else skin.get("default_variant", "")
	if materials.has(pick):
		var material: Material = load(materials[pick])
		for mesh in meshes:
			(mesh as MeshInstance3D).material_override = material
	if rigged:
		var sk := character_skeleton(character_node, item)
		if sk != null:
			for mesh in meshes:
				var mi := mesh as MeshInstance3D
				if mi.skin != null:
					mi.skeleton = mi.get_path_to(sk)
			ensure_helpers(sk)
		# an outfit can bring its own body with the covered parts removed, so no skin
		# shows through the clothes; the character's own body is hidden while it's on
		var body_model: String = skin.get("body_model", "")
		if body_model != "" and sk != null:
			for mi in sk.get_parent().find_children("*", "MeshInstance3D", true, false):
				if not _in_skin(mi) and mi.visible:
					mi.visible = false
					mi.set_meta(HIDDEN_META, slot)
			var body_scene: PackedScene = load(body_model)
			if body_scene != null:
				var body := body_scene.instantiate() as Node3D
				body.set_meta(SLOT_META, slot)
				item.add_child(body)
				for mi in body.find_children("*", "MeshInstance3D", true, false):
					if (mi as MeshInstance3D).skin != null:
						(mi as MeshInstance3D).skeleton = (mi as MeshInstance3D).get_path_to(sk)
	return item

## The character's own Skeleton3D (not the copy that comes inside a rigged skin's file).
func character_skeleton(character_node: Node3D, item: Node = null) -> Skeleton3D:
	for s in character_node.find_children("*", "Skeleton3D", true, false):
		if item == null or not item.is_ancestor_of(s):
			if not _in_skin(s):
				return s as Skeleton3D
	return null

## Shoulder/hip helper bones (named <Bone>Helper) turn half as far as their bone.
func ensure_helpers(sk: Skeleton3D) -> void:
	var needed := false
	for b in sk.get_bone_count():
		if sk.get_bone_name(b).ends_with("Helper"):
			needed = true
			break
	if not needed or not ResourceLoader.exists(HELPERS):
		return
	for c in sk.get_children():
		if c.has_meta("codev_helpers"):
			return
	var mod = load(HELPERS).new()
	mod.set_meta("codev_helpers", true)
	sk.add_child(mod)

func _in_skin(n: Node) -> bool:
	var p := n
	while p != null:
		if p.has_meta(SLOT_META):
			return true
		p = p.get_parent()
	return false

func unequip(character_node: Node3D, slot: String) -> void:
	for node in character_node.find_children("*", "Node3D", true, false):
		if node.has_meta(SLOT_META) and node.get_meta(SLOT_META) == slot:
			node.queue_free()
		elif node.has_meta(HIDDEN_META) and node.get_meta(HIDDEN_META) == slot:
			node.visible = true
			node.remove_meta(HIDDEN_META)
`;
}

// Drives helper bones: each <Bone>Helper turns `amount` (half) as far as <Bone>, so
// shoulders and hips stretch instead of folding. Added under the character's Skeleton3D.
function helperScript() {
    return `@tool
extends SkeletonModifier3D
## CoDevHelperBones (made by CoDev): every bone named <Bone>Helper turns half as far as <Bone>.
@export_range(0.0, 1.0) var amount := 0.5
var _pairs: Array = []

func _find_pairs(sk: Skeleton3D) -> void:
	_pairs.clear()
	for b in sk.get_bone_count():
		var n := sk.get_bone_name(b)
		if n.ends_with("Helper"):
			var src := sk.find_bone(n.substr(0, n.length() - 6))
			if src >= 0:
				_pairs.append([src, b])

func _process_modification_with_delta(_delta: float) -> void:
	var sk := get_skeleton()
	if sk == null:
		return
	if _pairs.is_empty():
		_find_pairs(sk)
	for p in _pairs:
		var rest := sk.get_bone_rest(p[0]).basis.get_rotation_quaternion()
		sk.set_bone_pose_rotation(p[1], rest.slerp(sk.get_bone_pose_rotation(p[0]), amount))
`;
}

module.exports = { materialTres, upsertManifest, addAutoload, registryScript, helperScript, res, MANIFEST_VERSION };
