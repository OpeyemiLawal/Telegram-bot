# Exporting a game

The project lives here. The export goes somewhere else — mixing built output into
a source folder is easy to do and tedious to undo.

```
test-game/godot/          the project (open this in Godot)
test-game/godot-export/   the export (generated, deployed)
```

---

## One-time setup per project

Two settings. Do these once and every future export is bridge-ready with no
editing afterwards.

**Project → Export → Web**

**1. Uncheck "Thread Support".**

Not a preference. A threaded export only runs when the page is served with
`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`, and cross-origin
isolation breaks the wallet provider's iframes and third-party RPC calls. Leave
it on and you fix the game while breaking the wallet, with no error connecting
the two.

**2. Set "Head Include" to this single line:**

```html
<script src="https://sga-miniapp.vercel.app/sdk/v1/sga-sdk.js"></script>
```

Find it under the **HTML** section of the Web preset.

Godot injects that into `<head>` of every export it generates. The engine script
sits at the end of `<body>`, so the SDK is always loaded first — which is the
ordering `JavaScriptBridge.get_interface("SGA")` depends on during `_ready()`.

This replaces the old routine of copying `sga-sdk.js` into the export folder and
hand-editing `index.html` after every single export. That step was forgotten
constantly, and it fails silently: the game runs perfectly and simply never
learns the player's name.

Both settings are stored in `export_presets.cfg`, so they survive reopening the
project — but that file is per-project. A new game needs both set again.

---

## Why the SDK loads from a URL

The shell serves it at a fixed, versioned path rather than each game shipping its
own copy.

- **No copying.** Nothing to forget, nothing to get out of date.
- **One place to fix a bug.** A bridge fix reaches two hundred games on the next
  page load, instead of two hundred re-exports that nobody will do.
- **`/v1/` is a promise.** Games exported today keep loading `v1` forever. A
  breaking protocol change ships as `/v2/` alongside it, and old games go on
  working untouched.

The cost: a game cannot connect to the bridge if the shell is unreachable. That
is not a real loss — a game with no shell has no player, no wallet and no way
back to Telegram anyway.

---

## Every export after that

1. **Export Project…** → into your export folder → filename `index.html`
2. Deploy that folder to its **own origin** (drag it onto Vercel)
3. Paste the URL into the Mini App's **Catalogue** screen

No file copying. No `index.html` editing. No commits, no redeploys.

---

## Checking it worked

Open the game from the bot. The player's name should appear where the game shows
it — Godot has no way to know that, so its presence *is* the proof the bridge
connected.

If Tap Rush shows `bridge: no SGA`, the Head Include is missing or misspelled.
That is the only thing that produces it once the game is being framed.

---

## One origin per game

Never point two games at the same host. The bridge identifies a game by its
origin, so two games sharing one cannot be told apart, and a bug in either
becomes a bug in both.

The Catalogue screen rejects a duplicate origin, and rejects a URL with a path
for the same reason — `host/game-a` and `host/game-b` are the same origin.
