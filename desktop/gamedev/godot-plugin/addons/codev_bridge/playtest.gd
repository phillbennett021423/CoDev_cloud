extends Node
## CoDev playtest helper. The CoDev Bridge adds this as an autoload so CoDev's agents
## can playtest: press keys and actions, click, read values and the node tree of the
## running game, read its errors and prints, and see frames.
##
## It only wakes up when the game was started from the Godot editor with the debugger
## on; in an exported game it does nothing. Requests and answers go over Godot's own
## debugger connection to the editor (the "codev" message capture), never a new port.

const MAX_SHOT_WIDTH := 1280
const MAX_INPUT_SECONDS := 30.0
const MAX_STATE_NODES := 300
const LOGGER_PATH := "res://addons/codev_bridge/playtest_logger.gd"

var _logger = null
var _active := false


func _ready() -> void:
	if not EngineDebugger.is_active() or not OS.has_feature("editor"):
		set_process(false)
		return
	_active = true
	process_mode = Node.PROCESS_MODE_ALWAYS
	if not EngineDebugger.has_capture("codev"):
		EngineDebugger.register_message_capture("codev", _on_message)
	# Logger and OS.add_logger arrived in Godot 4.5; older versions fall back to the log file.
	if ClassDB.class_exists("Logger") and OS.has_method("add_logger"):
		var script = load(LOGGER_PATH)
		if script:
			_logger = script.new()
			OS.call("add_logger", _logger)
	EngineDebugger.send_message("codev:hello", [Engine.get_version_info().string])


func _exit_tree() -> void:
	if not _active:
		return
	if EngineDebugger.has_capture("codev"):
		EngineDebugger.unregister_message_capture("codev")
	if _logger and OS.has_method("remove_logger"):
		OS.call("remove_logger", _logger)


func _on_message(message: String, data: Array) -> bool:
	var kind := message.trim_prefix("codev:")
	if data.size() < 2:
		return false
	var id := int(data[0])
	var args: Dictionary = data[1] if typeof(data[1]) == TYPE_DICTIONARY else {}
	match kind:
		"shot":
			_shot(id, args)
		"input":
			_input_steps(id, args)
		"state":
			_reply(id, _state(args))
		"log":
			_reply(id, _log(args))
		_:
			_reply(id, {"ok": false, "error": "Unknown playtest request %s." % kind})
	return true


func _reply(id: int, reply: Dictionary) -> void:
	EngineDebugger.send_message("codev:reply", [id, reply])


func _fail(message: String) -> Dictionary:
	return {"ok": false, "error": message}


func _scene() -> Node:
	return get_tree().current_scene


# "/root/..." is absolute; anything else is relative to the current scene.
func _node(path: String) -> Node:
	if path == "" or path == ".":
		return _scene()
	if path.begins_with("/"):
		return get_tree().root.get_node_or_null(NodePath(path))
	var scene := _scene()
	return scene.get_node_or_null(NodePath(path)) if scene else get_tree().root.get_node_or_null(NodePath(path))


func _value(v) -> Variant:
	match typeof(v):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return v
		TYPE_VECTOR2, TYPE_VECTOR2I:
			return [v.x, v.y]
		TYPE_VECTOR3, TYPE_VECTOR3I:
			return [v.x, v.y, v.z]
		TYPE_OBJECT:
			if v == null:
				return null
			if v is Resource and v.resource_path != "":
				return v.resource_path
			return "<%s>" % v.get_class()
	return var_to_str(v)


# ---------------------------------------------------------------- frames

func _shot(id: int, args: Dictionary) -> void:
	await RenderingServer.frame_post_draw
	var texture := get_viewport().get_texture()
	var image: Image = texture.get_image() if texture else null
	if image == null or image.is_empty():
		_reply(id, _fail("The game has no picture to take (it may be running headless)."))
		return
	var width := clampi(int(args.get("max_width", 960)), 160, MAX_SHOT_WIDTH)
	var size := image.get_size()
	if size.x > width:
		image.resize(width, int(round(size.y * float(width) / size.x)), Image.INTERPOLATE_BILINEAR)
	var jpg := image.save_jpg_to_buffer(0.85)
	_reply(id, {"ok": true, "width": image.get_width(), "height": image.get_height(), "game_size": [size.x, size.y], "mime": "image/jpeg", "data": Marshalls.raw_to_base64(jpg), "frame": Engine.get_process_frames()})


# ---------------------------------------------------------------- input

func _event_for(step: Dictionary, pressed: bool) -> InputEvent:
	if step.has("key"):
		var code := OS.find_keycode_from_string(str(step["key"]))
		if code == KEY_NONE:
			return null
		var key := InputEventKey.new()
		key.keycode = code
		key.physical_keycode = code
		key.pressed = pressed
		return key
	if step.has("click"):
		var at: Array = step["click"] if step["click"] is Array else [0, 0]
		var mouse := InputEventMouseButton.new()
		mouse.button_index = MOUSE_BUTTON_RIGHT if str(step.get("button", "left")) == "right" else MOUSE_BUTTON_LEFT
		mouse.position = Vector2(float(at[0]), float(at[1]))
		mouse.global_position = mouse.position
		mouse.pressed = pressed
		return mouse
	return null


func _wait(seconds: float) -> void:
	if seconds > 0.0:
		await get_tree().create_timer(seconds, true, false, true).timeout


func _watch(paths: Array) -> Dictionary:
	var out := {}
	for p in paths:
		var node := _node(str(p))
		if node == null:
			out[str(p)] = "missing"
		elif node is Node3D or node is Node2D:
			out[str(p)] = _value(node.get("global_position"))
		else:
			out[str(p)] = "<%s>" % node.get_class()
	return out


# steps: [{action | key | click: [x, y], button?, hold?: seconds, wait?: seconds after}]
func _input_steps(id: int, args: Dictionary) -> void:
	var steps: Array = args.get("steps", []) if args.get("steps", []) is Array else []
	var watch: Array = args.get("watch", []) if args.get("watch", []) is Array else []
	if steps.is_empty():
		_reply(id, _fail("game_input needs steps, like [{\"action\": \"jump\"}] or [{\"key\": \"D\", \"hold\": 1}]."))
		return
	var total := 0.0
	for step in steps:
		if typeof(step) != TYPE_DICTIONARY:
			_reply(id, _fail("Each step must be an object."))
			return
		if step.has("action") and not InputMap.has_action(str(step["action"])):
			var known := []
			for a in InputMap.get_actions():
				if not str(a).begins_with("ui_"):
					known.append(str(a))
			_reply(id, _fail("The game has no input action %s. Its actions: %s (plus Godot's ui_* ones)." % [step["action"], ", ".join(known) if known.size() else "none"]))
			return
		if not step.has("action") and _event_for(step, true) == null:
			_reply(id, _fail("A step needs action, key (like \"Space\", \"W\", \"Left\") or click [x, y]: %s" % JSON.stringify(step)))
			return
		total += float(step.get("hold", 0.1)) + float(step.get("wait", 0.1))
	if total > MAX_INPUT_SECONDS:
		_reply(id, _fail("The steps take %.1f seconds; keep one game_input under %d seconds." % [total, MAX_INPUT_SECONDS]))
		return
	var before := _watch(watch)
	var done := []
	for step in steps:
		var hold := clampf(float(step.get("hold", 0.1)), 0.0, MAX_INPUT_SECONDS)
		if step.has("action"):
			Input.action_press(str(step["action"]), clampf(float(step.get("strength", 1.0)), 0.0, 1.0))
			await _wait(hold)
			Input.action_release(str(step["action"]))
		else:
			Input.parse_input_event(_event_for(step, true))
			await _wait(hold)
			Input.parse_input_event(_event_for(step, false))
		await _wait(clampf(float(step.get("wait", 0.1)), 0.0, MAX_INPUT_SECONDS))
		done.append(step)
	var reply := {"ok": true, "steps_done": done.size()}
	if watch.size():
		reply["before"] = before
		reply["after"] = _watch(watch)
	if _logger:
		var errors := []
		for entry in _logger.lines_since(0):
			if str(entry["kind"]).contains("error"):
				errors.append(entry["text"])
		if errors.size():
			reply["errors_so_far"] = errors.slice(max(0, errors.size() - 10))
	_reply(id, reply)


# ---------------------------------------------------------------- state

func _describe(node: Node, root: Node) -> Dictionary:
	var info := {"name": str(node.name), "type": node.get_class(), "path": str(root.get_path_to(node)) if root and (node == root or root.is_ancestor_of(node)) else str(node.get_path())}
	if node is Node3D or node is Node2D:
		info["global_position"] = _value(node.get("global_position"))
	if node is CanvasItem or node is Node3D:
		info["visible"] = node.get("visible")
	if "velocity" in node:
		info["velocity"] = _value(node.get("velocity"))
	return info


func _state(args: Dictionary) -> Dictionary:
	var scene := _scene()
	var out := {"ok": true, "scene": scene.scene_file_path if scene else "", "fps": Engine.get_frames_per_second(), "paused": get_tree().paused, "time_scale": Engine.time_scale}
	var path := str(args.get("node", ""))
	if path == "":
		var nodes := []
		var queue := [scene if scene else get_tree().root]
		while queue.size() and nodes.size() < MAX_STATE_NODES:
			var node: Node = queue.pop_front()
			nodes.append(_describe(node, scene))
			queue.append_array(node.get_children())
		out["nodes"] = nodes
		out["cut"] = queue.size() > 0
		return out
	var node := _node(path)
	if node == null:
		return _fail("No node %s in the running game. Call game_state without node to see the tree (paths are relative to the current scene, or /root/... for autoloads)." % path)
	out["node"] = _describe(node, scene)
	var props := {}
	var wanted = args.get("properties", [])
	if wanted is Array and wanted.size():
		for p in wanted:
			props[str(p)] = _value(node.get(str(p))) if str(p) in node else "<no such property>"
	elif node.get_script():
		for p in node.get_script().get_script_property_list():
			if int(p.get("usage", 0)) & PROPERTY_USAGE_SCRIPT_VARIABLE:
				props[str(p["name"])] = _value(node.get(str(p["name"])))
	out["properties"] = props
	return out


# ---------------------------------------------------------------- log

func _log(args: Dictionary) -> Dictionary:
	var since := int(args.get("since", 0))
	if _logger:
		var lines: Array = _logger.lines_since(since)
		if bool(args.get("errors_only", false)):
			lines = lines.filter(func(e): return str(e["kind"]) != "print")
		return {"ok": true, "lines": lines.slice(max(0, lines.size() - 200)), "next": _logger.total()}
	# Before Godot 4.5: the file log the engine writes for this run, when it is on.
	var path := str(ProjectSettings.get_setting("debug/file_logging/log_path", "user://logs/godot.log"))
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return _fail("Reading the game's errors needs Godot 4.5 or newer, or file logging on (Project Settings > Debug > File Logging).")
	var all := file.get_as_text().split("\n")
	var text := []
	for i in range(since, all.size()):
		text.append({"n": i, "kind": "log", "text": all[i]})
	return {"ok": true, "lines": text.slice(max(0, text.size() - 200)), "next": all.size(), "note": "From the game's log file (Godot before 4.5 can't tell errors from prints)."}
