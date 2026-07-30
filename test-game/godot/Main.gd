extends Control

## Tap Rush — a small, real game that drives the bridge.
##
## Deliberately a game rather than a diagnostic screen. A row of buttons proves
## the messages work in isolation; it does not prove they work while a frame is
## rendering, while input is being consumed, or fifty times in twenty seconds.
## Those are the conditions a real game creates, and they are where a bridge
## actually breaks.
##
## What it exercises:
##
##   handshake   once on ready, before anything is drawn
##   getPlayer   the name shown in the HUD comes from the shell, not from Godot
##   haptic      on every hit, so ~50 calls a round — a rate a real game reaches
##   exit        the shell navigates, the game does not
##
## Notice the callbacks are stored in member variables. A JavaScriptBridge
## callback held only in a local is garbage collected when the function returns;
## the reply then arrives with nowhere to go and the request appears to hang,
## silently. It is the most common way a working bridge looks broken from
## GDScript.
##
## ---------------------------------------------------------------------------
## Layout
## ---------------------------------------------------------------------------
##
## Nothing below is a fixed pixel value. The shell sizes its iframe from the
## player's viewport, and Telegram's is different on every device — a tall phone,
## a squat desktop window, a tablet in landscape. Sizes are expressed against a
## 720x1280 reference and scaled by how much of that reference actually fits, so
## the target is always thumb-sized relative to the screen rather than absolutely.
##
## The alternative — designing for one size and letting the engine letterbox —
## looks correct in the editor and wrong on hardware.

const REFERENCE := Vector2(720.0, 1280.0)

const ROUND_TIME := 20.0

# Reference-space sizes, all multiplied by `_unit()` before use.
const START_RADIUS := 120.0
const MIN_RADIUS := 30.0
const SHRINK_PER_SECOND := 55.0
const PADDING := 24.0
const TOP_BAR := 72.0

const GOLD := Color("#c89b3c")
const BG := Color("#0b1620")
const TEXT := Color("#e8eef4")
const MUTED := Color("#93a8ba")

var _sdk: JavaScriptObject = null
var _cb_handshake: JavaScriptObject
var _cb_player: JavaScriptObject

var _playing := false
var _score := 0
var _best := 0
var _time_left := 0.0

# Stored in reference space (0..1 of the play area) rather than pixels, so a
# resize mid-round moves the target with the screen instead of stranding it
# off-frame or under the HUD.
var _target_ratio := Vector2(0.5, 0.5)
var _radius := START_RADIUS

var _player_name := "player"

## Why the bridge is or is not working, shown on screen.
##
## Printed rather than logged because there is no console to read. Telegram's
## mobile WebView has no devtools, and each attempt at diagnosing this from the
## outside costs a full 35 MB export and redeploy. A word in the corner turns
## that loop into a glance.
var _bridge_state := "starting"

var _status: Label
var _top_bar: HBoxContainer
var _hud: Label
var _timer_label: Label
var _banner: VBoxContainer
var _title: Label
var _subtitle: Label
var _primary: Button
var _leave_button: Button


func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_STOP
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)

	_build_ui()
	resized.connect(_apply_scale)
	_apply_scale()

	_connect_bridge()
	_show_banner("Tap Rush", "Tap the circle before it disappears.", "Start")


# --- responsive sizing --------------------------------------------------------


## How much of the reference layout fits on this screen.
##
## The smaller of the two ratios, so the design fits in both directions — taking
## the larger would size the target off the bottom of a short window. Clamped
## because a very large screen should not produce a circle the size of a dinner
## plate, and a very small one should stay tappable.
func _unit() -> float:
	if size.x <= 0.0 or size.y <= 0.0:
		return 1.0
	return clampf(minf(size.x / REFERENCE.x, size.y / REFERENCE.y), 0.45, 2.2)


func _start_radius() -> float:
	return START_RADIUS * _unit()


func _min_radius() -> float:
	return MIN_RADIUS * _unit()


## The rectangle a target may spawn in: the screen, inset so the circle is fully
## visible and never lands under the HUD.
func _play_area() -> Rect2:
	var inset := _start_radius() + PADDING * _unit()
	var top := TOP_BAR * _unit() + inset
	var rect := Rect2(
		inset,
		top,
		maxf(1.0, size.x - inset * 2.0),
		maxf(1.0, size.y - top - inset),
	)
	return rect


func _target_position() -> Vector2:
	var area := _play_area()
	return area.position + area.size * _target_ratio


func _apply_scale() -> void:
	var u := _unit()

	_top_bar.offset_left = PADDING * u
	_top_bar.offset_right = -PADDING * u
	_top_bar.offset_top = PADDING * u * 0.8

	_hud.add_theme_font_size_override("font_size", int(26.0 * u))
	_timer_label.add_theme_font_size_override("font_size", int(26.0 * u))
	_title.add_theme_font_size_override("font_size", int(46.0 * u))
	_subtitle.add_theme_font_size_override("font_size", int(22.0 * u))
	_primary.add_theme_font_size_override("font_size", int(26.0 * u))
	_leave_button.add_theme_font_size_override("font_size", int(22.0 * u))
	_status.add_theme_font_size_override("font_size", int(18.0 * u))
	_status.offset_bottom = -PADDING * u

	# Wide enough to read, never wider than the screen it sits on.
	_banner.custom_minimum_size = Vector2(clampf(size.x * 0.82, 240.0, 520.0), 0.0)
	_banner.add_theme_constant_override("separation", int(16.0 * u))
	_primary.custom_minimum_size = Vector2(0.0, 72.0 * u)
	_leave_button.custom_minimum_size = Vector2(0.0, 60.0 * u)

	# A resize can leave the current radius outside the new bounds — larger than
	# a shrunken screen allows, or already below the new miss threshold.
	_radius = clampf(_radius, _min_radius(), _start_radius())

	queue_redraw()


# --- bridge -------------------------------------------------------------------


func _connect_bridge() -> void:
	if not OS.has_feature("web"):
		_bridge_state = "editor"
		return  # editor run; the game is still fully playable

	_sdk = JavaScriptBridge.get_interface("SGA")

	if _sdk == null:
		# sga-sdk.js did not load, or loaded after the engine. Godot rewrites
		# index.html on every export, so the script tag is the first thing to
		# check when this appears.
		_bridge_state = "no SGA"
		return

	if not _sdk.isAvailable():
		# The SDK is present but has no shell to talk to: either the game is not
		# in an iframe, or ?sgaOrigin= is missing from the URL.
		_bridge_state = "no shell"
		_sdk = null
		return

	_bridge_state = "handshaking"
	_cb_handshake = JavaScriptBridge.create_callback(_on_handshake)
	_sdk.handshake(_cb_handshake)


func _on_handshake(args: Array) -> void:
	var info = args[0]

	# Read the property directly rather than through `Object.get()`.
	#
	# A JavaScriptObject resolves unknown properties to null via `_get`, so
	# `info.error` is the supported way to ask. `info.get("error")` routes through
	# Godot's own Object.get, which is not the same lookup and pushes an error for
	# a property Godot does not know about — enough to abort this handler before
	# it ever requests the player, leaving the HUD reading "player" with nothing
	# logged to say why.
	if info == null or info.error != null:
		_bridge_state = "handshake failed"
		_update_hud()
		return

	_bridge_state = "asking"
	_update_hud()

	_cb_player = JavaScriptBridge.create_callback(_on_player)
	_sdk.getPlayer(_cb_player)


func _on_player(args: Array) -> void:
	var player = args[0]

	if player == null or player.error != null:
		_bridge_state = "player failed"
		_update_hud()
		return

	_player_name = str(player.displayName)
	_bridge_state = "ok"
	_update_hud()


func _buzz(style: String) -> void:
	if _sdk != null:
		_sdk.haptic(style)


# --- game ---------------------------------------------------------------------


func _start_round() -> void:
	_score = 0
	_time_left = ROUND_TIME
	_playing = true
	_banner.visible = false
	_spawn()
	_update_hud()


func _spawn() -> void:
	_target_ratio = Vector2(randf(), randf())
	# Shrinks the starting size as the score climbs, so the difficulty comes from
	# the game rather than from the player getting bored. Scaled, so "harder"
	# means the same thing on every screen.
	var u := _unit()
	_radius = maxf(_min_radius() + 6.0 * u, _start_radius() - float(_score) * 2.5 * u)
	queue_redraw()


func _process(delta: float) -> void:
	if not _playing:
		return

	_time_left -= delta
	if _time_left <= 0.0:
		_end_round("Time")
		return

	_radius -= SHRINK_PER_SECOND * _unit() * delta
	if _radius <= _min_radius():
		_end_round("Missed")
		return

	_update_hud()
	queue_redraw()


func _end_round(reason: String) -> void:
	_playing = false
	_best = maxi(_best, _score)
	_buzz("error")
	queue_redraw()
	_show_banner(
		"%s — %d" % [reason, _score],
		"Best %d · %s" % [_best, _player_name],
		"Play again",
	)


func _gui_input(event: InputEvent) -> void:
	if not _playing:
		return

	var point := Vector2.ZERO
	if event is InputEventMouseButton and event.pressed:
		point = event.position
	elif event is InputEventScreenTouch and event.pressed:
		point = event.position
	else:
		return

	# A generous hit area on top of the drawn circle. The visible radius is the
	# timer; making the player hit it exactly would turn a reaction test into a
	# precision test, and on a phone the finger is wider than the target anyway.
	var forgiveness := 12.0 * _unit()
	if point.distance_to(_target_position()) <= _radius + forgiveness:
		_score += 1
		_buzz("light")
		_spawn()
		_update_hud()


func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), BG)

	if not _playing:
		return

	var centre := _target_position()
	# A faint ring at full size makes the shrink readable — without it the target
	# just looks small rather than running out of time.
	draw_arc(centre, _start_radius(), 0.0, TAU, 48, Color(GOLD, 0.15), 2.0 * _unit())
	draw_circle(centre, _radius, GOLD)


# --- ui -----------------------------------------------------------------------


func _build_ui() -> void:
	# Anchored, not positioned. The previous version placed the timer by
	# subtracting from `size.x`, which is correct exactly once and wrong after
	# every resize.
	_top_bar = HBoxContainer.new()
	_top_bar.anchor_right = 1.0
	_top_bar.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_top_bar)

	_hud = Label.new()
	_hud.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_hud.add_theme_color_override("font_color", TEXT)
	_hud.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_top_bar.add_child(_hud)

	_timer_label = Label.new()
	_timer_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	_timer_label.add_theme_color_override("font_color", MUTED)
	_timer_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_top_bar.add_child(_timer_label)

	_status = Label.new()
	_status.set_anchors_preset(Control.PRESET_BOTTOM_WIDE)
	_status.grow_vertical = Control.GROW_DIRECTION_BEGIN
	_status.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_status.add_theme_color_override("font_color", MUTED)
	_status.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_status)

	_banner = VBoxContainer.new()
	_banner.set_anchors_and_offsets_preset(
		Control.PRESET_CENTER, Control.PRESET_MODE_KEEP_SIZE
	)
	_banner.grow_horizontal = Control.GROW_DIRECTION_BOTH
	_banner.grow_vertical = Control.GROW_DIRECTION_BOTH
	add_child(_banner)

	_title = Label.new()
	_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_title.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_title.add_theme_color_override("font_color", TEXT)
	_banner.add_child(_title)

	_subtitle = Label.new()
	_subtitle.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_subtitle.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_subtitle.add_theme_color_override("font_color", MUTED)
	_banner.add_child(_subtitle)

	_primary = Button.new()
	_primary.pressed.connect(_start_round)
	_banner.add_child(_primary)

	_leave_button = Button.new()
	_leave_button.text = "Leave game"
	_leave_button.pressed.connect(_leave)
	_banner.add_child(_leave_button)


func _show_banner(title: String, subtitle: String, action: String) -> void:
	_title.text = title
	_subtitle.text = subtitle
	_primary.text = action
	_banner.visible = true
	_update_hud()


func _update_hud() -> void:
	_hud.text = "%s   %d" % [_player_name, _score]
	_timer_label.text = "%0.1fs" % maxf(_time_left, 0.0) if _playing else ""
	if _status:
		_status.text = "bridge: %s" % _bridge_state


func _leave() -> void:
	if _sdk != null:
		_sdk.exit()
	else:
		# Outside the shell there is nowhere to go, so say so rather than doing
		# nothing — a dead button in a test build wastes an export cycle.
		_show_banner("Not in the shell", "Exit only works inside Telegram.", "Start")
