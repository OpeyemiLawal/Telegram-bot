/**
 * Solana Games PlatformSDK — the game's side of the bridge.
 *
 * Copy this file next to your Godot HTML export and load it *before* the engine:
 *
 *     <script src="sga-sdk.js"></script>
 *     <script src="index.js"></script>   <!-- Godot -->
 *
 * Plain ES5-compatible JavaScript with no build step and no imports, on purpose.
 * Godot's HTML export is a fixed set of files that you drop onto a static host;
 * anything needing bundling would mean a toolchain in front of every game.
 *
 * ---------------------------------------------------------------------------
 * Calling it from GDScript
 * ---------------------------------------------------------------------------
 *
 *     if OS.has_feature("web"):
 *         var sdk := JavaScriptBridge.get_interface("SGA")
 *
 *         # Establish the channel. Do this once, on ready.
 *         sdk.handshake()
 *
 *         # Callbacks have to be kept alive — a JavaScriptBridge callback that
 *         # goes out of scope is garbage collected and never fires. Store it on
 *         # the node, not in a local.
 *         _on_player = JavaScriptBridge.create_callback(_player_received)
 *         sdk.getPlayer(_on_player)
 *
 *         sdk.haptic("light")
 *         sdk.exit()
 *
 *     func _player_received(args):
 *         var player = args[0]
 *         print(player.displayName, " ", player.walletAddress)
 *
 * ---------------------------------------------------------------------------
 * What a game can and cannot do
 * ---------------------------------------------------------------------------
 *
 * Available: handshake, getPlayer, haptic, exit.
 *
 * Not available, and not an omission: the player's session token, their refresh
 * token, the Telegram initData, and any ability to sign or send a transaction.
 * The shell holds the wallet. When money arrives, a game will *request* a
 * transaction and the shell will present it to the player's wallet for approval
 * — the game will never hold the authority to move funds, only to ask.
 */

(function () {
  "use strict";

  var VERSION = 1;

  // The shell's origin, captured from the URL the shell embedded us with:
  //   https://your-game.example/?sgaOrigin=https%3A%2F%2Fsga-miniapp.vercel.app
  //
  // Read from the query string rather than hardcoded so the same build runs
  // against a preview deployment, and so a game is never shipped with a stale
  // origin baked in. Falls back to document.referrer's origin, which browsers
  // set to the embedding page.
  var shellOrigin = (function () {
    try {
      var fromQuery = new URLSearchParams(window.location.search).get("sgaOrigin");
      if (fromQuery) return new URL(fromQuery).origin;
      if (document.referrer) return new URL(document.referrer).origin;
    } catch (e) {
      /* fall through */
    }
    return null;
  })();

  var pending = {};
  var counter = 0;

  function send(type, payload, onResult) {
    if (!window.parent || window.parent === window) {
      // Opened directly rather than embedded. Report it instead of hanging: a
      // developer loading the game standalone should see why nothing responds.
      if (onResult) onResult({ ok: false, error: "Not running inside the shell" });
      return;
    }

    if (!shellOrigin) {
      if (onResult) onResult({ ok: false, error: "Shell origin unknown" });
      return;
    }

    counter += 1;
    var id = "g" + counter + "-" + Date.now().toString(36);

    if (onResult) {
      pending[id] = onResult;
      // Never leave a caller waiting forever. A shell that has navigated away,
      // or a message dropped mid-reload, would otherwise strand a Godot callback
      // that the game is holding a reference to.
      setTimeout(function () {
        if (pending[id]) {
          delete pending[id];
          onResult({ ok: false, error: "Timed out" });
        }
      }, 10000);
    }

    // Addressed to the shell's exact origin, never "*". A wildcard would post
    // the message — and anything in it — to whatever document happens to be in
    // the parent frame.
    window.parent.postMessage(
      { sga: VERSION, id: id, type: type, payload: payload },
      shellOrigin,
    );
  }

  window.addEventListener("message", function (event) {
    // The shell is the only party we accept answers from. Without this check any
    // frame or extension could resolve a pending request with fabricated data.
    if (event.origin !== shellOrigin) return;

    var data = event.data;
    if (!data || data.sga !== VERSION || typeof data.id !== "string") return;

    var handler = pending[data.id];
    if (!handler) return;
    delete pending[data.id];

    handler({ ok: data.ok === true, data: data.data, error: data.error });
  });

  /**
   * Godot's `create_callback` produces a function expecting positional
   * arguments, so results are passed as a single object rather than as
   * (err, value) — a GDScript callback receives `args[0]` and reading a field
   * off it is more legible than remembering an argument order.
   */
  function wrap(callback) {
    if (!callback) return null;
    return function (result) {
      callback(result.ok ? result.data || {} : { error: result.error });
    };
  }

  window.SGA = {
    version: VERSION,

    /** True when embedded by a shell we can talk to. */
    isAvailable: function () {
      return Boolean(shellOrigin && window.parent && window.parent !== window);
    },

    /** Call once on ready. Returns { version, gameSlug, surface }. */
    handshake: function (callback) {
      send("handshake", undefined, wrap(callback));
    },

    /** Public identity: { displayName, walletAddress }. Never a token. */
    getPlayer: function (callback) {
      send("getPlayer", undefined, wrap(callback));
    },

    /** "light" | "medium" | "heavy" | "success" | "error" | "warning" */
    haptic: function (style) {
      send("haptic", { style: style || "light" }, null);
    },

    /** Ask the shell to leave the game and return to the catalogue. */
    exit: function () {
      send("exit", undefined, null);
    },
  };
})();
