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
##
## Every edit goes through the editor's undo history as "CoDev: ...", so the user can
## press Ctrl+Z on anything an agent did, the same as their own changes.
##
## Playtesting: the playtest.gd autoload runs inside the game when it is started from
## this editor (never in an exported game). The game_* actions reach it over Godot's
## own debugger connection, so an agent can press keys, read errors and prints, read
## values from the running game and look at frames.

const BRIDGE_VERSION := "2.0"
const FIRST_PORT := 6510
const LAST_PORT := 6519
const INFO_FILE := "res://.codev_bridge.json"
const MAX_REQUEST_BYTES := 4000000
const REQUEST_TIMEOUT_MS := 10000
const MAX_TREE_NODES := 400
const MAX_DOC_ITEMS := 200
const AUTOLOAD := "CoDevPlaytest"
const PLAYTEST_PATH := "res://addons/codev_bridge/playtest.gd"
const UNDO_PREFIX := "CoDev: "
# How long a game_* action waits for the running game to answer.
const GAME_TIMEOUT_MS := 8000
const GAME_INPUT_TIMEOUT_MS := 40000


## Carries game_* requests to the running game and their answers back.
class CoDevDebugger extends EditorDebuggerPlugin:
	var on_reply: Callable
	var hello := {}

	func _has_capture(capture: String) -> bool:
		return capture == "codev"

	func _capture(message: String, data: Array, session_id: int) -> bool:
		var kind := message.trim_prefix("codev:")
		if kind == "hello":
			hello[session_id] = true
			return true
		if kind == "reply" and data.size() >= 2:
			on_reply.call(int(data[0]), data[1])
			return true
		return false

	func _setup_session(session_id: int) -> void:
		var session := get_session(session_id)
		session.started.connect(func(): hello.erase(session_id))
		session.stopped.connect(func(): hello.erase(session_id))

	# The session of the game running now, or null.
	func active() -> EditorDebuggerSession:
		for session in get_sessions():
			if session.is_active():
				return session
		return null

	func is_ready() -> bool:
		var sessions := get_sessions()
		for i in sessions.size():
			if sessions[i].is_active() and hello.has(i):
				return true
		return false


var _server := TCPServer.new()
var _clients: Array = []
var _token := ""
var _port := 0
var _debugger := CoDevDebugger.new()
# id -> {"peer": StreamPeerTCP, "deadline": msec, "kind": String}
var _waiting := {}
var _next_id := 1


func _enter_tree() -> void:
	_debugger.on_reply = _on_game_reply
	add_debugger_plugin(_debugger)
	if not ProjectSettings.has_setting("autoload/" + AUTOLOAD) and FileAccess.file_exists(PLAYTEST_PATH):
		add_autoload_singleton(AUTOLOAD, PLAYTEST_PATH)
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
		file.store_string(JSON.stringify({"port": _port, "token": _token, "pid": OS.get_process_id(), "godot": Engine.get_version_info().string, "bridge": BRIDGE_VERSION}))
		file.close()
	print("CoDev Bridge %s is listening on 127.0.0.1:%d" % [BRIDGE_VERSION, _port])


func _exit_tree() -> void:
	remove_debugger_plugin(_debugger)
	_server.stop()
	for client in _clients:
		client["peer"].disconnect_from_host()
	_clients.clear()
	for id in _waiting:
		_waiting[id]["peer"].disconnect_from_host()
	_waiting.clear()
	if FileAccess.file_exists(INFO_FILE):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(INFO_FILE))


func _disable_plugin() -> void:
	if ProjectSettings.has_setting("autoload/" + AUTOLOAD):
		remove_autoload_singleton(AUTOLOAD)


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
	var now := Time.get_ticks_msec()
	for id in _waiting.keys():
		if now > int(_waiting[id]["deadline"]):
			var waited: Dictionary = _waiting[id]
			_waiting.erase(id)
			_send(waited["peer"], 200, _fail("The game didn't answer %s in time. If it just started, wait a second and try again; if it froze, call stop and play." % waited["kind"]))


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
	if request["headers"].get("x-codev-token", "") != _token:
		_send(peer, 403, _fail("Wrong or missing token."))
		return
	if request["method"] != "POST" or request["path"] != "/command":
		_send(peer, 404, _fail("Only POST /command is served."))
		return
	var data = JSON.parse_string(request["body"])
	if typeof(data) != TYPE_DICTIONARY:
		_send(peer, 400, _fail("The body must be a JSON object."))
		return
	var args = data.get("args", {})
	var action := str(data.get("action", ""))
	if typeof(args) != TYPE_DICTIONARY:
		args = {}
	if action.begins_with("game_"):
		_ask_game(peer, action, args)
		return
	_send(peer, 200, _run(action, args))


func _send(peer: StreamPeerTCP, status: int, reply: Dictionary) -> void:
	var body := JSON.stringify(reply).to_utf8_buffer()
	var head := "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % [status, "OK" if status == 200 else "Error", body.size()]
	peer.put_data(head.to_utf8_buffer())
	peer.put_data(body)
	peer.disconnect_from_host()


# ---------------------------------------------------------------- playtesting

const GAME_ACTIONS := ["game_shot", "game_input", "game_state", "game_log"]


func _ask_game(peer: StreamPeerTCP, action: String, args: Dictionary) -> void:
	if not (action in GAME_ACTIONS):
		_send(peer, 200, _fail("Unknown action %s." % action))
		return
	var session := _debugger.active()
	if session == null:
		_send(peer, 200, _fail("The game isn't running from the editor. Call play, wait a second or two, then try again."))
		return
	if not _debugger.is_ready():
		_send(peer, 200, _fail("The game is running but CoDev's playtest helper hasn't answered. If the game just started, wait a second and try again. If it keeps saying this, the helper isn't in the project: call godot_install_bridge, then restart the editor."))
		return
	var id := _next_id
	_next_id += 1
	var timeout := GAME_INPUT_TIMEOUT_MS if action == "game_input" else GAME_TIMEOUT_MS
	_waiting[id] = {"peer": peer, "deadline": Time.get_ticks_msec() + timeout, "kind": action}
	session.send_message("codev:" + action.trim_prefix("game_"), [id, args])


func _on_game_reply(id: int, reply) -> void:
	if not _waiting.has(id):
		return
	var waited: Dictionary = _waiting[id]
	_waiting.erase(id)
	_send(waited["peer"], 200, reply if typeof(reply) == TYPE_DICTIONARY else _fail("The game sent back something unexpected."))


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
	# World-space transform, so CoDev's scene dressing can measure nested props.
	if node is Node3D and node.is_inside_tree():
		var g: Vector3 = node.global_position
		var r: Vector3 = node.global_rotation_degrees
		var s: Vector3 = node.scale
		info["global_position"] = [g.x, g.y, g.z]
		info["global_rotation_degrees"] = [r.x, r.y, r.z]
		info["scale"] = [s.x, s.y, s.z]
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


# Adds a new node under parent as one undoable step.
func _add_undoable(parent: Node, node: Node, label: String) -> void:
	var ur := get_undo_redo()
	ur.create_action(UNDO_PREFIX + label, UndoRedo.MERGE_DISABLE, _root())
	ur.add_do_method(parent, "add_child", node, true)
	ur.add_do_method(self, "_adopt", node, _root())
	ur.add_do_reference(node)
	ur.add_undo_method(parent, "remove_child", node)
	ur.commit_action()


# The node and every node under it that the scene root owns.
func _owned(node: Node) -> Array:
	var out := []
	if node.owner == _root():
		out.append(node)
	for child in node.get_children():
		out.append_array(_owned(child))
	return out


func _set_undoable(node: Node, property: String, value) -> void:
	var ur := get_undo_redo()
	ur.create_action(UNDO_PREFIX + "set %s.%s" % [node.name, property], UndoRedo.MERGE_DISABLE, _root())
	ur.add_do_property(node, property, value)
	ur.add_undo_property(node, property, node.get(property))
	ur.commit_action()


func _undo_history() -> UndoRedo:
	var ur := get_undo_redo()
	return ur.get_history_undo_redo(ur.get_object_history_id(_root()))


func _run(action: String, args: Dictionary) -> Dictionary:
	var editor := get_editor_interface()
	match action:
		"ping":
			var root := _root()
			return {"ok": true, "godot": Engine.get_version_info().string, "bridge": BRIDGE_VERSION, "project": ProjectSettings.get_setting("application/config/name", ""), "scene": root.scene_file_path if root else "", "playing": editor.is_playing_scene(), "playtest_ready": _debugger.is_ready()}
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
			return {"ok": true, "playing": scene, "note": "The game takes a second or two to start; then the game_* actions work."}
		"stop":
			editor.stop_playing_scene()
			return {"ok": true}
		"is_playing":
			return {"ok": true, "playing": editor.is_playing_scene(), "playtest_ready": _debugger.is_ready()}
		"add_node":
			var parent := _find(str(args.get("parent", ".")))
			if parent == null:
				return _fail("No parent node %s in the open scene." % args.get("parent", "."))
			var type := str(args.get("type", "Node3D"))
			if not ClassDB.class_exists(type) or not ClassDB.can_instantiate(type) or not ClassDB.is_parent_class(type, "Node"):
				return _fail("%s isn't a node type Godot can create." % type)
			var node: Node = ClassDB.instantiate(type)
			node.name = str(args.get("name", type))
			_add_undoable(parent, node, "add %s" % node.name)
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
			_add_undoable(parent, node, "place %s" % node.name)
			var problems := _apply(node, args.get("properties", {}))
			return {"ok": true, "node": _describe(node), "problems": problems}
		"set_property":
			var node := _find(str(args.get("node", ".")))
			if node == null:
				return _fail("No node %s in the open scene." % args.get("node", "."))
			var property := str(args.get("property", ""))
			if not (property in node):
				return _fail("%s has no property %s" % [node.get_class(), property])
			_set_undoable(node, property, _convert(args.get("value"), node.get(property)))
			return {"ok": true, "value": var_to_str(node.get(property))}
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
			var parent := node.get_parent()
			var ur := get_undo_redo()
			ur.create_action(UNDO_PREFIX + "remove %s" % node.name, UndoRedo.MERGE_DISABLE, _root())
			ur.add_do_method(parent, "remove_child", node)
			ur.add_undo_method(parent, "add_child", node, true)
			ur.add_undo_method(parent, "move_child", node, node.get_index())
			# Removing a branch clears its owners; the editor's own delete puts them back the same way.
			for n in _owned(node):
				ur.add_undo_method(n, "set_owner", _root())
			ur.add_undo_reference(node)
			ur.commit_action()
			return {"ok": true}
		"select":
			var node := _find(str(args.get("node", ".")))
			if node == null:
				return _fail("No node %s in the open scene." % args.get("node", "."))
			editor.get_selection().clear()
			editor.get_selection().add_node(node)
			editor.edit_node(node)
			return {"ok": true}
		"attach_script":
			var node := _find(str(args.get("node", ".")))
			if node == null:
				return _fail("No node %s in the open scene." % args.get("node", "."))
			var path := str(args.get("path", ""))
			if not ResourceLoader.exists(path):
				return _fail("No script at %s. Write the file first, then call rescan." % path)
			var script = load(path)
			if not (script is Script):
				return _fail("%s isn't a script." % path)
			if not script.can_instantiate():
				return _fail("%s has errors, so Godot can't attach it. Fix it (godot_validate shows the errors) and try again." % path)
			var base: String = script.get_instance_base_type()
			if base != "" and not ClassDB.is_parent_class(node.get_class(), base):
				return _fail("%s extends %s, but %s is a %s." % [path, base, node.name, node.get_class()])
			_set_undoable(node, "script", script)
			return {"ok": true, "node": _describe(node)}
		"connect_signal":
			var from := _find(str(args.get("from", ".")))
			var to := _find(str(args.get("to", ".")))
			var sig := str(args.get("signal", ""))
			var method := str(args.get("method", ""))
			if from == null or to == null:
				return _fail("No node %s in the open scene." % (args.get("from", ".") if from == null else args.get("to", ".")))
			if not from.has_signal(sig):
				return _fail("%s (%s) has no signal %s. class_docs lists its signals." % [from.name, from.get_class(), sig])
			if not to.has_method(method):
				return _fail("%s has no method %s. Add the function to its script first (and rescan), then connect." % [to.name, method])
			var callable := Callable(to, method)
			if from.is_connected(sig, callable):
				return {"ok": true, "note": "Already connected."}
			var ur := get_undo_redo()
			ur.create_action(UNDO_PREFIX + "connect %s.%s" % [from.name, sig], UndoRedo.MERGE_DISABLE, _root())
			ur.add_do_method(from, "connect", sig, callable, CONNECT_PERSIST)
			ur.add_undo_method(from, "disconnect", sig, callable)
			ur.commit_action()
			return {"ok": true, "connected": "%s.%s -> %s.%s()" % [_root().get_path_to(from), sig, _root().get_path_to(to), method]}
		"undo", "redo":
			if _root() == null:
				return _fail("No scene is open in the editor.")
			var history := _undo_history()
			var label := history.get_current_action_name()
			if action == "undo" and not label.begins_with(UNDO_PREFIX) and not args.get("force", false):
				return _fail("The last change in this scene (\"%s\") is the user's, not CoDev's, so it wasn't undone. Pass force: true only if the user asked." % label)
			var done := history.undo() if action == "undo" else history.redo()
			if not done:
				return _fail("Nothing to %s." % action)
			if action == "undo":
				return {"ok": true, "undone": label}
			return {"ok": true, "redone": history.get_current_action_name()}
		"class_docs":
			return _class_docs(args)
		"find_class":
			return {"ok": true, "godot": Engine.get_version_info().string, "classes": _find_classes(str(args.get("query", "")), 40)}
	return _fail("Unknown action %s." % action)


# ---------------------------------------------------------------- engine docs
# The API of the user's own Godot build, straight from ClassDB, so agents use names
# that exist in this version instead of ones remembered from another.

func _type_name(info: Dictionary) -> String:
	var t := int(info.get("type", TYPE_NIL))
	var cls := str(info.get("class_name", ""))
	if t == TYPE_OBJECT and cls != "":
		return cls
	if t == TYPE_NIL:
		return "Variant" if int(info.get("usage", 0)) & PROPERTY_USAGE_NIL_IS_VARIANT else "void"
	return type_string(t)


func _signature(m: Dictionary) -> String:
	var parts := []
	for a in m.get("args", []):
		parts.append("%s: %s" % [a.get("name", ""), _type_name(a)])
	var ret: Dictionary = m.get("return", {})
	return "%s(%s) -> %s" % [m.get("name", ""), ", ".join(parts), _type_name(ret)]


func _matches(name: String, filter: String) -> bool:
	return filter == "" or name.to_lower().contains(filter)


func _properties(list: Array, filter: String) -> Array:
	var out := []
	for p in list:
		var usage := int(p.get("usage", 0))
		if usage & (PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP | PROPERTY_USAGE_CATEGORY):
			continue
		if not (usage & (PROPERTY_USAGE_EDITOR | PROPERTY_USAGE_SCRIPT_VARIABLE)):
			continue
		var name := str(p.get("name", ""))
		if not _matches(name, filter):
			continue
		var line := "%s: %s" % [name, _type_name(p)]
		if int(p.get("hint", 0)) == PROPERTY_HINT_ENUM and str(p.get("hint_string", "")) != "":
			line += " (one of %s)" % p["hint_string"]
		out.append(line)
		if out.size() >= MAX_DOC_ITEMS:
			break
	return out


func _methods(list: Array, filter: String) -> Array:
	var out := []
	for m in list:
		var name := str(m.get("name", ""))
		var is_virtual := (int(m.get("flags", 0)) & METHOD_FLAG_VIRTUAL) != 0
		if (name.begins_with("_") and not is_virtual) or not _matches(name, filter):
			continue
		out.append(("virtual " if is_virtual else "") + _signature(m))
		if out.size() >= MAX_DOC_ITEMS:
			break
	return out


func _signals(list: Array, filter: String) -> Array:
	var out := []
	for s in list:
		if not _matches(str(s.get("name", "")), filter):
			continue
		var parts := []
		for a in s.get("args", []):
			parts.append("%s: %s" % [a.get("name", ""), _type_name(a)])
		out.append("%s(%s)" % [s["name"], ", ".join(parts)])
	return out


func _find_classes(query: String, limit: int) -> Array:
	var q := query.to_lower()
	var found := []
	for g in ProjectSettings.get_global_class_list():
		if str(g["class"]).to_lower().contains(q):
			found.append("%s (your script %s, extends %s)" % [g["class"], g["path"], g["base"]])
	var names := Array(ClassDB.get_class_list())
	names.sort()
	for c in names:
		if found.size() >= limit:
			break
		if str(c).to_lower().contains(q):
			found.append(str(c))
	return found.slice(0, limit)


func _class_docs(args: Dictionary) -> Dictionary:
	var type := str(args.get("type", ""))
	var filter := str(args.get("filter", "")).to_lower()
	var inherited := bool(args.get("inherited", false))
	var script: Script = null
	if str(args.get("node", "")) != "":
		var node := _find(str(args["node"]))
		if node == null:
			return _fail("No node %s in the open scene." % args["node"])
		type = node.get_class()
		script = node.get_script()
	elif not ClassDB.class_exists(type):
		for g in ProjectSettings.get_global_class_list():
			if str(g["class"]) == type:
				script = load(str(g["path"]))
				break
		if script == null:
			var close := _find_classes(type, 10)
			return _fail("Godot %s has no class %s.%s" % [Engine.get_version_info().string, type, (" Close names: " + ", ".join(close)) if close.size() else ""])
		type = script.get_instance_base_type()
	var chain := []
	var parent := ClassDB.get_parent_class(type)
	while parent != "":
		chain.append(parent)
		parent = ClassDB.get_parent_class(parent)
	var out := {
		"ok": true,
		"godot": Engine.get_version_info().string,
		"class": type,
		"inherits": chain,
		"properties": _properties(ClassDB.class_get_property_list(type, not inherited), filter),
		"methods": _methods(ClassDB.class_get_method_list(type, not inherited), filter),
		"signals": _signals(ClassDB.class_get_signal_list(type, not inherited), filter)
	}
	var enums := {}
	for e in ClassDB.class_get_enum_list(type, not inherited):
		if _matches(str(e), filter):
			enums[str(e)] = Array(ClassDB.class_get_enum_constants(type, e, not inherited))
	if enums.size():
		out["enums"] = enums
	if script:
		out["script"] = {
			"path": script.resource_path,
			"properties": _properties(script.get_script_property_list(), filter),
			"methods": _methods(script.get_script_method_list(), filter),
			"signals": _signals(script.get_script_signal_list(), filter)
		}
	if not inherited and chain.size():
		out["note"] = "Only %s's own members are listed. Pass inherited: true, or ask for %s, for the rest." % [type, chain[0]]
	return out
