@tool
extends EditorPlugin
## CoDev Bridge: lets CoDev's agents control this editor with short JSON commands.
##
## Listens on 127.0.0.1 only (port 6510, or the next free one up to 6519) for
## HTTP POST /command with a JSON body {"action": ..., "args": {...}}. Each editor
## start makes a new random token and writes it with the port to
## res://.codev_bridge.json; a request without that token in X-CoDev-Token is refused.
## The game's own loop never goes through here: commands are one-off edits
## (add a node, set a property, import a .glb, play the scene).

const FIRST_PORT := 6510
const LAST_PORT := 6519
const INFO_FILE := "res://.codev_bridge.json"
const MAX_REQUEST_BYTES := 4000000
const REQUEST_TIMEOUT_MS := 10000
const MAX_TREE_NODES := 400

var _server := TCPServer.new()
var _clients: Array = []
var _token := ""
var _port := 0


func _enter_tree() -> void:
	_token = Crypto.new().generate_random_bytes(16).hex_encode()
	for port in range(FIRST_PORT, LAST_PORT + 1):
		if _server.listen(port, "127.0.0.1") == OK:
			_port = port
			break
	if _port == 0:
		push_warning("CoDev Bridge: no free port between %d and %d." % [FIRST_PORT, LAST_PORT])
		return
	var file := FileAccess.open(INFO_FILE, FileAccess.WRITE)
	if file:
		file.store_string(JSON.stringify({"port": _port, "token": _token, "pid": OS.get_process_id(), "godot": Engine.get_version_info().string}))
		file.close()
	print("CoDev Bridge is listening on 127.0.0.1:%d" % _port)


func _exit_tree() -> void:
	_server.stop()
	for client in _clients:
		client["peer"].disconnect_from_host()
	_clients.clear()
	if FileAccess.file_exists(INFO_FILE):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(INFO_FILE))


func _process(_delta: float) -> void:
	if _port == 0:
		return
	while _server.is_connection_available():
		_clients.append({"peer": _server.take_connection(), "buffer": PackedByteArray(), "since": Time.get_ticks_msec()})
	for client in _clients.duplicate():
		var peer: StreamPeerTCP = client["peer"]
		peer.poll()
		if peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			_clients.erase(client)
			continue
		var available := peer.get_available_bytes()
		if available > 0:
			var got: Array = peer.get_partial_data(available)
			if got[0] == OK:
				var buffer: PackedByteArray = client["buffer"]
				buffer.append_array(got[1])
				client["buffer"] = buffer
		var request := _parse_request(client["buffer"])
		if request.is_empty():
			if Time.get_ticks_msec() - int(client["since"]) > REQUEST_TIMEOUT_MS or client["buffer"].size() > MAX_REQUEST_BYTES:
				peer.disconnect_from_host()
				_clients.erase(client)
			continue
		_clients.erase(client)
		_answer(peer, request)


# ---------------------------------------------------------------- HTTP

func _header_end(buffer: PackedByteArray) -> int:
	for i in range(buffer.size() - 3):
		if buffer[i] == 13 and buffer[i + 1] == 10 and buffer[i + 2] == 13 and buffer[i + 3] == 10:
			return i
	return -1


# {} until the whole request has arrived.
func _parse_request(buffer: PackedByteArray) -> Dictionary:
	var end := _header_end(buffer)
	if end < 0:
		return {}
	var lines := buffer.slice(0, end).get_string_from_utf8().split("\r\n")
	var first := lines[0].split(" ")
	var headers := {}
	for i in range(1, lines.size()):
		var colon := lines[i].find(":")
		if colon > 0:
			headers[lines[i].substr(0, colon).strip_edges().to_lower()] = lines[i].substr(colon + 1).strip_edges()
	var length := str(headers.get("content-length", "0")).to_int()
	if buffer.size() < end + 4 + length:
		return {}
	return {
		"method": first[0] if first.size() > 0 else "",
		"path": first[1] if first.size() > 1 else "",
		"headers": headers,
		"body": buffer.slice(end + 4, end + 4 + length).get_string_from_utf8()
	}


func _answer(peer: StreamPeerTCP, request: Dictionary) -> void:
	var status := 200
	var reply := {}
	if request["headers"].get("x-codev-token", "") != _token:
		status = 403
		reply = {"ok": false, "error": "Wrong or missing token."}
	elif request["method"] != "POST" or request["path"] != "/command":
		status = 404
		reply = {"ok": false, "error": "Only POST /command is served."}
	else:
		var data = JSON.parse_string(request["body"])
		if typeof(data) != TYPE_DICTIONARY:
			status = 400
			reply = {"ok": false, "error": "The body must be a JSON object."}
		else:
			var args = data.get("args", {})
			reply = _run(str(data.get("action", "")), args if typeof(args) == TYPE_DICTIONARY else {})
	var body := JSON.stringify(reply).to_utf8_buffer()
	var head := "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % [status, "OK" if status == 200 else "Error", body.size()]
	peer.put_data(head.to_utf8_buffer())
	peer.put_data(body)
	peer.disconnect_from_host()


# ---------------------------------------------------------------- commands

func _fail(message: String) -> Dictionary:
	return {"ok": false, "error": message}


func _root() -> Node:
	return get_editor_interface().get_edited_scene_root()


func _find(path: String) -> Node:
	var root := _root()
	if root == null:
		return null
	if path == "" or path == "." or path == str(root.name):
		return root
	return root.get_node_or_null(NodePath(path))


func _describe(node: Node) -> Dictionary:
	var info := {"name": str(node.name), "type": node.get_class(), "path": str(_root().get_path_to(node))}
	var script: Script = node.get_script()
	if script:
		info["script"] = script.resource_path
	if node.scene_file_path != "" and node != _root():
		info["scene"] = node.scene_file_path
	if node is Node3D or node is Node2D:
		info["position"] = var_to_str(node.get("position"))
	return info


# JSON values to the property's own type: [x, y, z] -> Vector3, "res://..." -> the resource.
func _convert(value, current):
	if value is String and value.begins_with("res://"):
		return load(value)
	if value is Array:
		match typeof(current):
			TYPE_VECTOR2:
				return Vector2(value[0], value[1])
			TYPE_VECTOR2I:
				return Vector2i(int(value[0]), int(value[1]))
			TYPE_VECTOR3:
				return Vector3(value[0], value[1], value[2])
			TYPE_VECTOR3I:
				return Vector3i(int(value[0]), int(value[1]), int(value[2]))
			TYPE_VECTOR4:
				return Vector4(value[0], value[1], value[2], value[3])
			TYPE_COLOR:
				return Color(value[0], value[1], value[2], value[3] if value.size() > 3 else 1.0)
			TYPE_QUATERNION:
				return Quaternion(value[0], value[1], value[2], value[3])
	if value is String and typeof(current) == TYPE_COLOR:
		return Color(value)
	if typeof(current) == TYPE_INT and (value is float or value is int):
		return int(value)
	if typeof(current) == TYPE_FLOAT and (value is float or value is int):
		return float(value)
	return value


func _apply(node: Node, properties) -> Array:
	var problems := []
	if typeof(properties) != TYPE_DICTIONARY:
		return problems
	for key in properties:
		if not (str(key) in node):
			problems.append("%s has no property %s" % [node.get_class(), key])
			continue
		node.set(str(key), _convert(properties[key], node.get(str(key))))
	return problems


func _adopt(node: Node, scene_root: Node) -> void:
	node.owner = scene_root
	# Children of an instanced scene belong to that scene, not to ours.
	if node.scene_file_path != "" and node != scene_root:
		return
	for child in node.get_children():
		_adopt(child, scene_root)


func _run(action: String, args: Dictionary) -> Dictionary:
	var editor := get_editor_interface()
	match action:
		"ping":
			var root := _root()
			return {"ok": true, "godot": Engine.get_version_info().string, "project": ProjectSettings.get_setting("application/config/name", ""), "scene": root.scene_file_path if root else ""}
		"scene_tree":
			var root := _root()
			if root == null:
				return _fail("No scene is open in the editor.")
			var nodes := []
			var queue := [root]
			while queue.size() > 0 and nodes.size() < MAX_TREE_NODES:
				var node: Node = queue.pop_front()
				nodes.append(_describe(node))
				if node == root or node.scene_file_path == "":
					queue.append_array(node.get_children())
			return {"ok": true, "scene": root.scene_file_path, "nodes": nodes, "cut": queue.size() > 0}
		"open_scene":
			var path := str(args.get("path", ""))
			if not ResourceLoader.exists(path):
				return _fail("No scene at %s." % path)
			editor.open_scene_from_path(path)
			return {"ok": true, "scene": path}
		"save_scene":
			if _root() == null:
				return _fail("No scene is open in the editor.")
			var err := editor.save_scene()
			return {"ok": err == OK, "error": error_string(err)} if err != OK else {"ok": true, "saved": _root().scene_file_path}
		"reload_scene":
			editor.reload_scene_from_path(str(args.get("path", _root().scene_file_path if _root() else "")))
			return {"ok": true}
		"rescan":
			editor.get_resource_filesystem().scan()
			return {"ok": true, "note": "Scanning the project for new and changed files; imports finish in a few seconds."}
		"play":
			var scene := str(args.get("scene", "main"))
			if scene == "main":
				editor.play_main_scene()
			elif scene == "current":
				editor.play_current_scene()
			else:
				editor.play_custom_scene(scene)
			return {"ok": true, "playing": scene}
		"stop":
			editor.stop_playing_scene()
			return {"ok": true}
		"is_playing":
			return {"ok": true, "playing": editor.is_playing_scene()}
		"add_node":
			var parent := _find(str(args.get("parent", ".")))
			if parent == null:
				return _fail("No parent node %s in the open scene." % args.get("parent", "."))
			var type := str(args.get("type", "Node3D"))
			if not ClassDB.class_exists(type) or not ClassDB.can_instantiate(type) or not ClassDB.is_parent_class(type, "Node"):
				return _fail("%s isn't a node type Godot can create." % type)
			var node: Node = ClassDB.instantiate(type)
			node.name = str(args.get("name", type))
			parent.add_child(node, true)
			node.owner = _root()
			var problems := _apply(node, args.get("properties", {}))
			return {"ok": true, "node": _describe(node), "problems": problems}
		"instantiate":
			var path := str(args.get("path", ""))
			var parent := _find(str(args.get("parent", ".")))
			if parent == null:
				return _fail("No parent node %s in the open scene." % args.get("parent", "."))
			if not ResourceLoader.exists(path):
				return _fail("%s isn't imported yet (or doesn't exist). Call rescan, wait a few seconds, then try again." % path)
			var packed = load(path)
			if not (packed is PackedScene):
				return _fail("%s isn't a scene or model." % path)
			var node: Node = packed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)
			if args.has("name"):
				node.name = str(args["name"])
			parent.add_child(node, true)
			_adopt(node, _root())
			var problems := _apply(node, args.get("properties", {}))
			return {"ok": true, "node": _describe(node), "problems": problems}
		"set_property":
			var node := _find(str(args.get("node", ".")))
			if node == null:
				return _fail("No node %s in the open scene." % args.get("node", "."))
			var problems := _apply(node, {str(args.get("property", "")): args.get("value")})
			if problems.size() > 0:
				return _fail(problems[0])
			return {"ok": true, "value": var_to_str(node.get(str(args.get("property", ""))))}
		"get_property":
			var node := _find(str(args.get("node", ".")))
			if node == null:
				return _fail("No node %s in the open scene." % args.get("node", "."))
			var property := str(args.get("property", ""))
			if not (property in node):
				return _fail("%s has no property %s." % [node.get_class(), property])
			return {"ok": true, "value": var_to_str(node.get(property))}
		"remove_node":
			var node := _find(str(args.get("node", "")))
			if node == null or node == _root():
				return _fail("No node %s to remove (the scene root can't be removed)." % args.get("node", ""))
			node.get_parent().remove_child(node)
			node.queue_free()
			return {"ok": true}
		"select":
			var node := _find(str(args.get("node", ".")))
			if node == null:
				return _fail("No node %s in the open scene." % args.get("node", "."))
			editor.get_selection().clear()
			editor.get_selection().add_node(node)
			editor.edit_node(node)
			return {"ok": true}
	return _fail("Unknown action %s." % action)
