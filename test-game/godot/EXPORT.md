# Exporting Tap Rush

The project lives here. The export goes somewhere else — mixing built output into
a source folder is easy to do and tedious to undo.

```
test-game/godot/          the project (open this in Godot)
test-game/godot-export/   the export (generated, deployed)
```

---

## 1. Export

Open `test-game/godot` in Godot 4.3 or newer.

**Project → Export → Add… → Web**

Then, before exporting:

**Uncheck "Thread Support".**

Not a preference. A threaded export only runs when the page is served with
`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`, and cross-origin
isolation breaks the wallet provider's iframes and third-party RPC calls. Leave
it on and you fix the game while breaking the wallet — with no error connecting
the two.

If Godot says export templates are missing: **Editor → Manage Export
Templates… → Download and Install**.

**Export Project…** → into `test-game/godot-export/` → filename `index.html`.

---

## 2. Add the SDK

The export does not know about the bridge. Two things have to join it: the SDK
file, and a script tag loading it *before* the engine.

From the repository root, in PowerShell:

```powershell
$export = "test-game\godot-export"

Copy-Item platform-sdk\sga-sdk.js $export -Force

$html = Get-Content "$export\index.html" -Raw
if ($html -notmatch 'sga-sdk\.js') {
    $html = $html -replace '(<script src="index\.js")', '<script src="sga-sdk.js"></script>`n    $1'
    Set-Content "$export\index.html" $html -NoNewline
    "SDK tag added"
} else {
    "SDK tag already present"
}
```

Order matters: `JavaScriptBridge.get_interface("SGA")` runs during `_ready()`, so
`window.SGA` has to exist before the engine starts.

**Re-run this after every export.** Godot overwrites `index.html` each time, so
the tag disappears and the bridge silently stops working — the game still runs,
it just never learns the player's name.

---

## 3. Deploy

Reuse the Vercel project already pointing at this repo rather than creating a
second one. Same origin means no new catalogue entry and no CSP change.

Vercel → **sga-test-game** → Settings → **Root Directory** → change
`test-game/web` to `test-game/godot-export` → Save → **Redeploy**.

The HTML harness stays in the repo. Point the root directory back at
`test-game/web` any time you want it again.

---

## 4. Play it

Telegram → your bot → Play → Games → **Bridge Test**.

| What you should see | What it proves |
|---|---|
| Your Telegram name in the top-left | `handshake` and `getPlayer` completed |
| A buzz on every hit | `haptic` survives being called ~50 times a round |
| "Leave game" returns to the catalogue | `exit` — the shell navigates, not the game |

The name is the interesting one. Godot has no way to know it; it came through
the bridge, from the shell, over `postMessage`.

If the HUD says `player` rather than your name, the bridge did not connect —
almost always the missing script tag from step 2.

---

## Why a game and not a test screen

A row of buttons proves the messages work in isolation. It does not prove they
work while a frame is rendering, while input is being consumed, or fifty times in
twenty seconds. Those are the conditions a real game creates, and they are where
a bridge actually breaks.
