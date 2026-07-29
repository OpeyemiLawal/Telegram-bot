extends Control

## Bridge smoke test.
##
## Exercises every message the shell accepts and prints what comes back, so a
## failure names itself instead of showing a blank canvas.
##
## The one thing this file is really demonstrating is callback lifetime. A
## JavaScriptBridge callback that is not held by something still in the tree gets
## garbage collected, and the reply then arrives with nowhere to go — the request
## looks like it hung, with nothing in the console to say why. It is the single
## most common way a working bridge appears broken from GDScript. Note that every
## callback below is stored in a member variable, never a local.

const REQUEST_TIMEOUT := 10.0

var _sdk: JavaScriptObject = null

# Held for the lifetime of the node. See the note above — locals would be
# collected before the reply arrives.
var _cb_handshake: JavaScriptObject
var _cb_player: JavaScriptObject

var _log: RichTextLabel
var _status: Label


func _ready() -> void:
	_build_ui()

	if not OS.has_feature("web"):
		# Running from the editor. Say so rather than failing silently, since
		# "nothing happens" in the editor is expected and easy to misread.
		_set_status("Editor run — the bridge only exists in a web export.")
		_write("Export to Web and open it inside the shell to test.", "gray")
		return

	_sdk = JavaScriptBridge.get_interface("SGA")

	if _sdk == null:
		_set_status("SGA not found.")
		_write("sga-sdk.js is not loaded. Add it to index.html BEFORE the engine script.", "tomato")
		return

	if not _sdk.isAvailable():
		_set_status("SDK present, but no shell.")
		_write("Not embedded, or ?sgaOrigin= is missing. Requests will fail fast rather than hang.", "goldenrod")
		return

	_set_status("Connected. Running handshake…")
	_cb_handshake = JavaScriptBridge.create_callback(_on_handshake)
	_sdk.handshake(_cb_handshake)


# --- bridge calls -------------------------------------------------------------


func _on_handshake(args: Array) -> void:
	var info = args[0]

	if info.get("error"):
		_write("handshake failed: %s" % info.error, "tomato")
		return

	_write("handshake ok — game=%s surface=%s v=%s" % [
		info.gameSlug, info.surface, info.version,
	], "palegreen")
	_set_status("Bridge live (%s)" % info.surface)


func _request_player() -> void:
	if _sdk == null:
		return
	_write("getPlayer…", "gray")
	_cb_player = JavaScriptBridge.create_callback(_on_player)
	_sdk.getPlayer(_cb_player)


func _on_player(args: Array) -> void:
	var player = args[0]

	if player.get("error"):
		_write("getPlayer failed: %s" % player.error, "tomato")
		return

	_write("player: %s" % player.displayName, "palegreen")

	# null when no wallet is linked yet, which is a normal state and not an
	# error — a game has to handle it rather than assume an address exists.
	var address = player.walletAddress
	if address == null:
		_write("no wallet linked yet", "goldenrod")
	else:
		_write("wallet: %s" % address, "palegreen")

	# The security claim, checked rather than trusted. If any of these ever
	# appear, the bridge is leaking a credential into game code.
	for forbidden in ["accessToken", "access_token", "refreshToken", "initData"]:
		if player.get(forbidden) != null:
			_write("LEAK: response contained %s" % forbidden, "tomato")


func _fire_haptic() -> void:
	if _sdk == null:
		return
	_sdk.haptic("medium")
	_write("haptic(medium) sent — fire and forget", "gray")


func _leave() -> void:
	if _sdk == null:
		return
	_write("exit sent — the shell should navigate away", "gray")
	_sdk.exit()


# --- ui -----------------------------------------------------------------------


func _build_ui() -> void:
	var root := VBoxContainer.new()
	root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root.add_theme_constant_override("separation", 12)
	root.offset_left = 24
	root.offset_top = 24
	root.offset_right = -24
	root.offset_bottom = -24
	add_child(root)

	var title := Label.new()
	title.text = "SGA Bridge Test"
	title.add_theme_font_size_override("font_size", 34)
	root.add_child(title)

	_status = Label.new()
	_status.text = "starting…"
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_status.add_theme_font_size_override("font_size", 20)
	root.add_child(_status)

	root.add_child(_button("getPlayer", _request_player))
	root.add_child(_button("haptic", _fire_haptic))
	root.add_child(_button("exit", _leave))

	_log = RichTextLabel.new()
	_log.bbcode_enabled = true
	_log.scroll_following = true
	_log.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_log.add_theme_font_size_override("normal_font_size", 18)
	root.add_child(_log)


func _button(text: String, handler: Callable) -> Button:
	var button := Button.new()
	button.text = text
	button.custom_minimum_size = Vector2(0, 64)
	button.pressed.connect(handler)
	return button


func _set_status(text: String) -> void:
	if _status:
		_status.text = text


func _write(line: String, colour: String = "white") -> void:
	if _log:
		_log.append_text("[color=%s]%s[/color]\n" % [colour, line])
	print(line)
