extends Logger
## Collects the running game's errors, warnings and prints for CoDev's game_log.
## Loaded by playtest.gd only on Godot 4.5 and newer, where Logger exists. Godot can
## call it from any thread, so the list is guarded by a mutex.

const MAX_LINES := 500
const KINDS := ["error", "warning", "script error", "shader error"]

var _mutex := Mutex.new()
var _lines: Array = []
var _total := 0


func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, _script_backtraces: Array[ScriptBacktrace]) -> void:
	var kind: String = KINDS[error_type] if error_type >= 0 and error_type < KINDS.size() else "error"
	var text := rationale if rationale != "" else code
	_add(kind, "%s (at %s:%d in %s)" % [text, file, line, function])


func _log_message(message: String, error: bool) -> void:
	_add("stderr" if error else "print", message.strip_edges(false, true))


func _add(kind: String, text: String) -> void:
	_mutex.lock()
	_lines.append({"n": _total, "kind": kind, "text": text, "ms": Time.get_ticks_msec()})
	_total += 1
	if _lines.size() > MAX_LINES:
		_lines.pop_front()
	_mutex.unlock()


# Lines numbered since or later.
func lines_since(since: int) -> Array:
	_mutex.lock()
	var out := []
	for entry in _lines:
		if int(entry["n"]) >= since:
			out.append(entry.duplicate())
	_mutex.unlock()
	return out


func total() -> int:
	return _total
