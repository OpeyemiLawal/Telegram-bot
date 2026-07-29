# Bridge test

Two ways to test the same bridge. Do them in this order — the first finds
problems the second would only hide behind a WebGL canvas.

```
web/      static page, no build step, deploy in two minutes
godot/    Godot 4 project, proves the GDScript path
```

---

## 1. The web harness

Real `sga-sdk.js`, real protocol, no Godot install and no export wait. When
something is wrong it also tells you *what* — a game canvas cannot show you which
message went unanswered, and this prints every one.

**Deploy it:**

1. `vercel.com/new` → import this repo
2. **Root Directory** → `test-game/web`
3. **Project Name** → `sga-test-game`
4. Deploy → note the URL, likely `https://sga-test-game.vercel.app`

**Point the shell at it** — two places, both required:

`backend/app/api/games.py`, in `CATALOGUE`:

```python
Game(
    slug="bridge-test",
    title="Bridge Test",
    tagline="Checks the game bridge end to end.",
    embed_url="https://sga-test-game.vercel.app",
    accent="#C89B3C",
    status="live",
),
```

Vercel → `sga-miniapp` → Environment Variables → append the origin to
`NEXT_PUBLIC_GAME_ORIGINS`, then **redeploy**. Miss this and the iframe is
blocked by CSP before it loads — which the browser reports as a blank frame, not
as a CSP error.

**Then, in Telegram:** Play → Games → Bridge Test.

| Button | Pass looks like |
|---|---|
| handshake | `game=bridge-test surface=mobile` |
| getPlayer | your display name, and your address if linked |
| haptic | the phone buzzes |
| exit | back to the games list |
| **try a forbidden message** | **no reply at all** |

That last row is the one worth understanding. It posts `type: "signTransaction"`
directly, bypassing the SDK. The shell's allowlist should drop it in silence — so
**"nothing happened" is the pass**, and the harness says so after a moment.

If `getPlayer` ever returns a field named `accessToken`, `refreshToken` or
`initData`, both harnesses print `LEAK` in red. Nothing should ever print that.

---

## 2. The Godot project

Open `godot/` in Godot 4.3 or newer and press play. In the editor it says the
bridge only exists in a web export — expected.

**Export it:**

1. Project → Export → Add → **Web**
2. **Uncheck Thread Support.**

   Not optional. A threaded export requires `Cross-Origin-Opener-Policy` and
   `Cross-Origin-Embedder-Policy`, and cross-origin isolation breaks the wallet
   provider's iframes and third-party RPC calls. You would fix the game and break
   the wallet.

3. Export to an empty folder as `index.html`
4. **Copy `platform-sdk/sga-sdk.js` into that folder**
5. Open the exported `index.html` and add the SDK **before** the engine script:

   ```html
   <script src="sga-sdk.js"></script>
   <script src="index.js"></script>
   ```

   Order matters — `JavaScriptBridge.get_interface("SGA")` runs during
   `_ready()`, so `window.SGA` has to exist by then.

6. Deploy that folder to its own origin, and register it exactly as above.

---

## What the Godot project is really demonstrating

Callback lifetime. From `Main.gd`:

```gdscript
var _cb_player: JavaScriptObject          # member, not local

func _request_player() -> void:
    _cb_player = JavaScriptBridge.create_callback(_on_player)
    _sdk.getPlayer(_cb_player)
```

A callback created into a local is garbage collected when the function returns.
The reply then arrives with nowhere to go, the request appears to hang, and
nothing is logged. It is the most common way a working bridge looks broken from
GDScript, and the only defence is holding the reference.

---

## One origin per game

Never point two games at the same host. The bridge identifies a game by its
origin, so two games sharing one cannot be told apart — and a bug in either
becomes a bug in both.

This includes the test harness: give it its own origin, and remove it from the
catalogue before you ship.
