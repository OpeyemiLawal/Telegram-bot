# PlatformSDK

The game's half of the bridge. One file, no build step: copy `sga-sdk.js` next to
your Godot HTML export and load it before the engine.

```html
<script src="sga-sdk.js"></script>
<script src="index.js"></script>   <!-- Godot -->
```

---

## The shape of it, and why

The shell holds the wallet. Games run on their own origin inside an iframe and
can only ask for things through `postMessage`.

That is not decoration. A game cannot read the player's session token, cannot
read `initData`, and cannot sign anything — not because it is asked not to, but
because there is no message that returns those. When money arrives, a game will
*request* a transaction and the shell will present it to the player's wallet for
approval. The game will never hold the authority to move funds, only to ask.

**One origin per game.** Never point two games at the same host. The bridge
identifies a game by its origin, so two games sharing one cannot be told apart —
and a bug in either becomes a bug in both.

---

## From GDScript

```gdscript
extends Node

var _on_player: JavaScriptObject
var _on_handshake: JavaScriptObject
var sdk: JavaScriptObject

func _ready() -> void:
    if not OS.has_feature("web"):
        return                      # running in the editor

    sdk = JavaScriptBridge.get_interface("SGA")
    if sdk == null or not sdk.isAvailable():
        return                      # opened outside the shell

    # Keep callbacks on the node. A JavaScriptBridge callback that goes out of
    # scope is garbage collected and simply never fires — the request appears to
    # hang, with nothing in the console.
    _on_handshake = JavaScriptBridge.create_callback(_handshake_done)
    sdk.handshake(_on_handshake)

func _handshake_done(args) -> void:
    var info = args[0]
    print("surface: ", info.surface)      # mobile | desktop | web

    _on_player = JavaScriptBridge.create_callback(_player_done)
    sdk.getPlayer(_on_player)

func _player_done(args) -> void:
    var player = args[0]
    if player.get("error"):
        return
    print(player.displayName, " ", player.walletAddress)   # may be null
```

`sdk.haptic("light")` and `sdk.exit()` are fire-and-forget.

---

## API

| Call | Returns | Notes |
|---|---|---|
| `isAvailable()` | bool | False when opened outside the shell. Check before anything else. |
| `handshake(cb)` | `{version, gameSlug, surface}` | Call once on ready. |
| `getPlayer(cb)` | `{displayName, walletAddress}` | `walletAddress` is null if unlinked. |
| `haptic(style)` | — | `light`/`medium`/`heavy`/`success`/`error`/`warning` |
| `exit()` | — | Asks the shell to return to the catalogue. |

Every callback receives one object. On failure it carries `error` instead of the
expected fields, so check `player.get("error")` before reading.

Requests time out after 10 seconds rather than hanging, so a shell that has
navigated away cannot strand a Godot callback the game is still holding.

---

## Exporting from Godot

**Export single-threaded.** Project → Export → Web → uncheck **Thread Support**.

Threaded exports require `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` headers, and cross-origin isolation breaks the
wallet provider's iframes and third-party RPC calls. This is noted in
`miniapp/next.config.mjs` too, because it is the kind of header someone adds
later believing it to be a hardening improvement.

---

## Adding a game to the shell

1. Deploy the export to its **own origin**.
2. Add it to `CATALOGUE` in `backend/app/api/games.py`.
3. Add the origin to `NEXT_PUBLIC_GAME_ORIGINS` on Vercel, then **redeploy** —
   it is compiled into the CSP at build time. Miss this and the iframe is blocked
   before it loads, which the browser reports as a blank frame rather than as a
   CSP error.

The shell appends `?sgaOrigin=<shell origin>` to the embed URL. The SDK reads it
to know where to send messages and whose replies to accept. The iframe sets
`referrer-policy: no-referrer`, so the SDK's `document.referrer` fallback is
unavailable in production and this parameter is what makes the bridge work.

---

## Testing a game standalone

`isAvailable()` returns false and every request fails with
`"Not running inside the shell"` — deliberately, rather than hanging, so it is
obvious why nothing responds.

To exercise the bridge locally, open the game with the parameter set by hand:

```
http://localhost:8060/?sgaOrigin=http://localhost:3000
```

…and load it in an iframe from the shell running at that origin.
