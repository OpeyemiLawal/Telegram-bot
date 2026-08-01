extends Control

## Tap Rush Ã¢â‚¬â€ a small, real game that drives the bridge.
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
##   haptic      on every hit, so ~50 calls a round Ã¢â‚¬â€ a rate a real game reaches
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
## player's viewport, and Telegram's is different on every device Ã¢â‚¬â€ a tall phone,
## a squat desktop window, a tablet in landscape. Sizes are expressed against a
## 720x1280 reference and scaled by how much of that reference actually fits, so
## the target is always thumb-sized relative to the screen rather than absolutely.
##
## The alternative Ã¢â‚¬â€ designing for one size and letting the engine letterbox Ã¢â‚¬â€
## looks correct in the editor and wrong on hardware.

const REFERENCE := Vector2(720.0, 1280.0)

const ROUND_TIME := 20.0

# Reference-space sizes, all multiplied by `_unit()` before use.
const START_RADIUS := 120.0
const MIN_RADIUS := 30.0
const SHRINK_PER_SECOND := 55.0
const PADDING := 24.0
const TOP_BAR := 285.0

const GOLD := Color("#c89b3c")
const BG := Color("#0b1620")
const TEXT := Color("#e8eef4")
const MUTED := Color("#93a8ba")

var _sdk: JavaScriptObject = null
var _cb_handshake: JavaScriptObject
var _cb_player: JavaScriptObject
var _cb_reward_start: JavaScriptObject
var _cb_reward_tap: JavaScriptObject
var _cb_reward_summary: JavaScriptObject
var _cb_reward_claim: JavaScriptObject
var _cb_reward_reset: JavaScriptObject

var _playing := false
var _score := 0
var _best := 0
var _time_left := 0.0

# Stored in reference space (0..1 of the play area) rather than pixels, so a
# resize mid-round moves the target with the screen instead of stranding it
# off-frame or under the HUD.
var _target_ratio := Vector2(0.5, 0.5)
var _radius := START_RADIUS

var _player_name := "Telegram player"
var _wallet_address := ""
var _player_loaded := false

var _reward_round_id := ""
var _reward_balance := 0
var _reward_progress := 0
var _reward_symbol := "$Gamer"
var _reward_state := "ready"
var _claims_enabled := false
var _minimum_claim := 100
var _claim_working := false
var _claim_state := "loading"
var _pending_reward := 0
var _can_reset_pending := false

## Why the bridge is or is not working, shown on screen.
##
## Printed rather than logged because there is no console to read. Telegram's
## mobile WebView has no devtools, and each attempt at diagnosing this from the
## outside costs a full 35 MB export and redeploy. A word in the corner turns
## that loop into a glance.
var _bridge_state := "starting"

## The banner's own text, kept apart from the bridge line appended to it, so the
## state can be refreshed without losing the message underneath.
var _subtitle_base := ""

var _status: Label
var _top_bar: HBoxContainer
var _hud: Label
var _timer_label: Label
var _player_card: PanelContainer
var _player_label: Label
var _wallet_status_label: Label
var _wallet_address_label: Label
var _reward_label: Label
var _claim_button: Button
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
## The smaller of the two ratios, so the design fits in both directions Ã¢â‚¬â€ taking
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

	_player_card.offset_left = PADDING * u
	_player_card.offset_right = -PADDING * u
	_player_card.offset_top = 72.0 * u
	_player_card.offset_bottom = 282.0 * u

	_hud.add_theme_font_size_override("font_size", int(26.0 * u))
	_timer_label.add_theme_font_size_override("font_size", int(26.0 * u))
	_player_label.add_theme_font_size_override("font_size", int(22.0 * u))
	_wallet_status_label.add_theme_font_size_override("font_size", int(20.0 * u))
	_wallet_address_label.add_theme_font_size_override("font_size", int(17.0 * u))
	_reward_label.add_theme_font_size_override("font_size", int(18.0 * u))
	_claim_button.add_theme_font_size_override("font_size", int(18.0 * u))
	_title.add_theme_font_size_override("font_size", int(46.0 * u))
	_subtitle.add_theme_font_size_override("font_size", int(22.0 * u))
	_primary.add_theme_font_size_override("font_size", int(26.0 * u))
	_leave_button.add_theme_font_size_override("font_size", int(22.0 * u))
	_status.add_theme_font_size_override("font_size", int(18.0 * u))
	# Both offsets, not just the bottom one. A bottom-wide preset anchors top and
	# bottom to the same edge, so moving only `offset_bottom` upward gives the
	# label a negative height and it silently never draws.
	_status.offset_top = -46.0 * u
	_status.offset_bottom = -PADDING * u

	# Wide enough to read, never wider than the screen it sits on.
	_banner.custom_minimum_size = Vector2(clampf(size.x * 0.82, 240.0, 520.0), 0.0)
	_banner.add_theme_constant_override("separation", int(16.0 * u))
	_primary.custom_minimum_size = Vector2(0.0, 72.0 * u)
	_leave_button.custom_minimum_size = Vector2(0.0, 60.0 * u)

	# A resize can leave the current radius outside the new bounds Ã¢â‚¬â€ larger than
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
	# a property Godot does not know about Ã¢â‚¬â€ enough to abort this handler before
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

	_player_name = str(player.displayName).strip_edges()
	if _player_name.is_empty():
		_player_name = "Telegram player"
	_wallet_address = "" if player.walletAddress == null else str(player.walletAddress)
	_player_loaded = true
	_bridge_state = "ok"
	_refresh_rewards()
	_update_hud()


func _buzz(style: String) -> void:
	if _sdk != null:
		_sdk.haptic(style)


func _refresh_rewards() -> void:
	if (
		_sdk == null
		or not _player_loaded
		or _sdk.getRewardSummary == null
	):
		_claim_state = "unavailable"
		_update_hud()
		return

	_claim_state = "loading"
	_cb_reward_summary = JavaScriptBridge.create_callback(_on_reward_summary)
	_sdk.getRewardSummary(_cb_reward_summary)
	_update_hud()


func _on_reward_summary(args: Array) -> void:
	var result = args[0]
	if result == null or result.error != null:
		_claim_state = "unavailable"
		_update_hud()
		return

	_reward_balance = int(result.availableAmount)
	_reward_symbol = str(result.tokenSymbol)
	_claims_enabled = bool(result.claimsEnabled)
	_minimum_claim = int(result.minimumClaim)
	_pending_reward = int(result.pendingAmount)
	_can_reset_pending = bool(result.canResetPending)
	_claim_state = "ready"
	_update_hud()


func _on_claim_button() -> void:
	if _claim_state == "unavailable":
		_refresh_rewards()
		return
	if _can_reset_pending:
		_reset_failed_claim()
		return
	_claim_rewards()


func _reset_failed_claim() -> void:
	if _sdk == null or _claim_working or _sdk.resetFailedRewardClaim == null:
		return
	_claim_working = true
	_claim_state = "resetting"
	_cb_reward_reset = JavaScriptBridge.create_callback(_on_reward_reset)
	_sdk.resetFailedRewardClaim(_cb_reward_reset)
	_update_hud()


func _on_reward_reset(args: Array) -> void:
	_claim_working = false
	var result = args[0]
	if result == null or result.error != null:
		_claim_state = "failed"
		_buzz("error")
		_update_hud()
		return
	_can_reset_pending = false
	_pending_reward = 0
	_buzz("success")
	_refresh_rewards()


func _claim_rewards() -> void:
	if (
		_sdk == null
		or _claim_working
		or not _claims_enabled
		or _reward_balance < _minimum_claim
		or _wallet_address.is_empty()
	):
		return

	_claim_working = true
	_claim_state = "sending"
	_cb_reward_claim = JavaScriptBridge.create_callback(_on_reward_claim)
	_sdk.claimRewards(_cb_reward_claim)
	_update_hud()


func _on_reward_claim(args: Array) -> void:
	_claim_working = false
	var result = args[0]
	if result == null or result.error != null:
		_claim_state = "failed"
		_buzz("error")
		_update_hud()
		return

	if str(result.status) != "confirmed":
		_claim_state = "failed"
		_refresh_rewards()
		return

	_reward_balance = 0
	_reward_progress = 0
	_pending_reward = 0
	_can_reset_pending = false
	_claim_state = "claimed"
	_buzz("success")
	_update_hud()

# --- game ---------------------------------------------------------------------


func _start_round() -> void:
	if (
		_sdk != null
		and _player_loaded
		and _sdk.startRewardRound != null
	):
		_primary.disabled = true
		_reward_state = "starting"
		_cb_reward_start = JavaScriptBridge.create_callback(_on_reward_round)
		_sdk.startRewardRound(_cb_reward_start)
		_update_hud()
		return

	_reward_state = "practice"
	_begin_round()


func _on_reward_round(args: Array) -> void:
	_primary.disabled = false
	var result = args[0]
	if result == null or result.error != null:
		_reward_round_id = ""
		_reward_state = "unavailable"
		_begin_round()
		return

	_reward_round_id = str(result.roundId)
	_reward_balance = int(result.availableAmount)
	_reward_symbol = str(result.tokenSymbol)
	_reward_progress = 0
	_reward_state = "earning"
	_cb_reward_tap = JavaScriptBridge.create_callback(_on_reward_tap)
	_begin_round()


func _begin_round() -> void:
	_score = 0
	_time_left = ROUND_TIME
	_playing = true
	_banner.visible = false
	_spawn()
	_update_hud()


func _on_reward_tap(args: Array) -> void:
	var result = args[0]
	if result == null or result.error != null:
		_reward_state = "sync failed"
		_reward_round_id = ""
		_update_hud()
		return

	_reward_balance = int(result.availableAmount)
	_reward_progress = int(result.tapProgress)
	_reward_symbol = str(result.tokenSymbol)
	_reward_state = "+%d earned" % int(result.earnedNow) if int(result.earnedNow) > 0 else "earning"
	if int(result.earnedNow) > 0:
		_buzz("success")
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
		"%s Ã¢â‚¬â€ %d" % [reason, _score],
		"Best %d Ã‚Â· %s" % [_best, _player_name],
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
		if _reward_round_id != "" and _cb_reward_tap != null:
			var elapsed_ms := int((ROUND_TIME - _time_left) * 1000.0)
			_sdk.recordTap(_reward_round_id, _score, elapsed_ms, _cb_reward_tap)
		_spawn()
		_update_hud()


func _draw() -> void:
	draw_rect(Rect2(Vector2.ZERO, size), BG)

	if not _playing:
		return

	var centre := _target_position()
	# A faint ring at full size makes the shrink readable Ã¢â‚¬â€ without it the target
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

	_player_card = PanelContainer.new()
	_player_card.anchor_right = 1.0
	_player_card.mouse_filter = Control.MOUSE_FILTER_PASS
	var card_style := StyleBoxFlat.new()
	card_style.bg_color = Color("#132431")
	card_style.border_color = Color("#294252")
	card_style.set_border_width_all(1)
	card_style.set_corner_radius_all(14)
	card_style.content_margin_left = 18.0
	card_style.content_margin_right = 18.0
	card_style.content_margin_top = 12.0
	card_style.content_margin_bottom = 12.0
	_player_card.add_theme_stylebox_override("panel", card_style)
	add_child(_player_card)

	var identity := VBoxContainer.new()
	identity.add_theme_constant_override("separation", 4)
	_player_card.add_child(identity)

	_player_label = Label.new()
	_player_label.add_theme_color_override("font_color", TEXT)
	identity.add_child(_player_label)

	_wallet_status_label = Label.new()
	identity.add_child(_wallet_status_label)

	_wallet_address_label = Label.new()
	_wallet_address_label.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	_wallet_address_label.add_theme_color_override("font_color", MUTED)
	identity.add_child(_wallet_address_label)

	_reward_label = Label.new()
	_reward_label.add_theme_color_override("font_color", GOLD)
	identity.add_child(_reward_label)

	_claim_button = Button.new()
	_claim_button.text = "Loading rewards..."
	_claim_button.pressed.connect(_on_claim_button)
	identity.add_child(_claim_button)

	_status = Label.new()
	_status.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_WIDE)
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
	_subtitle_base = subtitle
	_primary.text = action
	_banner.visible = true
	_update_hud()


func _refresh_subtitle() -> void:
	_subtitle.text = "%s\n\nbridge: %s" % [_subtitle_base, _bridge_state]


func _update_hud() -> void:
	_hud.text = "%s   %d" % [_player_name, _score]
	if _player_label:
		if _bridge_state == "player failed":
			_player_label.text = "Player: Could not load"
		else:
			_player_label.text = "Player: %s" % _player_name if _player_loaded else "Player: Loading..."
	if _wallet_status_label:
		if _bridge_state == "player failed":
			_wallet_status_label.text = "Wallet: Unavailable"
			_wallet_status_label.add_theme_color_override("font_color", Color("#ff7d7d"))
			_wallet_address_label.text = "Close and reopen the game from the bot."
		elif not _player_loaded:
			_wallet_status_label.text = "Wallet: Checking..."
			_wallet_status_label.add_theme_color_override("font_color", MUTED)
			_wallet_address_label.text = ""
		elif _wallet_address.is_empty():
			_wallet_status_label.text = "Wallet: Not connected"
			_wallet_status_label.add_theme_color_override("font_color", MUTED)
			_wallet_address_label.text = "Connect it from the bot Wallet button."
		else:
			_wallet_status_label.text = "Wallet: Connected"
			_wallet_status_label.add_theme_color_override("font_color", Color("#5ee6a8"))
			_wallet_address_label.text = _short_wallet(_wallet_address)
	if _reward_label:
		if _reward_state == "practice":
			_reward_label.text = "Rewards: open from Telegram to earn"
		elif _reward_state == "unavailable" or _reward_state == "sync failed":
			_reward_label.text = "Rewards: unavailable this round"
		elif _reward_state == "starting":
			_reward_label.text = "Rewards: starting..."
		else:
			_reward_label.text = "Rewards: %d %s  Ã¢â‚¬Â¢  %d/5 taps" % [
				_reward_balance,
				_reward_symbol,
				_reward_progress,
			]
	_timer_label.text = "%0.1fs" % maxf(_time_left, 0.0) if _playing else ""
	_update_claim_button()
	if _status:
		_status.text = "bridge: %s" % _bridge_state
	if _subtitle:
		_refresh_subtitle()


func _update_claim_button() -> void:
	if _claim_button == null:
		return

	_claim_button.disabled = true
	if not _player_loaded:
		_claim_button.text = "Loading rewards..."
	elif _wallet_address.is_empty():
		_claim_button.text = "Connect wallet to claim"
	elif _claim_state == "loading":
		_claim_button.text = "Loading rewards..."
	elif _claim_state == "resetting":
		_claim_button.text = "Resetting failed claim..."
	elif _can_reset_pending:
		_claim_button.text = "Reset failed devnet claim"
		_claim_button.disabled = _playing
	elif _claim_state == "unavailable":
		_claim_button.text = "Retry reward balance"
		_claim_button.disabled = false
	elif _claim_state == "sending":
		_claim_button.text = "Sending to wallet..."
	elif _claim_state == "failed":
		_claim_button.text = "Claim failed - tap to retry"
		_claim_button.disabled = false
	elif not _claims_enabled:
		_claim_button.text = "Claims not enabled"
	elif _reward_balance < _minimum_claim:
		_claim_button.text = "Earn %d more to claim" % (_minimum_claim - _reward_balance)
	else:
		_claim_button.text = "Claim %d %s to wallet" % [_reward_balance, _reward_symbol]
		_claim_button.disabled = _playing

func _short_wallet(address: String) -> String:
	if address.length() <= 16:
		return address
	return "%s...%s" % [address.left(8), address.right(6)]


func _leave() -> void:
	if _sdk != null:
		_sdk.exit()
	else:
		# Outside the shell there is nowhere to go, so say so rather than doing
		# nothing Ã¢â‚¬â€ a dead button in a test build wastes an export cycle.
		_show_banner("Not in the shell", "Exit only works inside Telegram.", "Start")
