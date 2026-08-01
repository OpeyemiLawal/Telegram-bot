# Tap Rush test game

The active deployment is the Godot export in godot-export.

## Deploy

1. Import this repository into Vercel.
2. Set Root Directory to test-game/godot-export.
3. Set the project name to sga-test-game.
4. Deploy to https://sga-test-game.vercel.app.
5. Open Telegram, then use Test -> Tap Rush from the main bot.

The game should show the Telegram player name and the public wallet address if the user already linked one in Wallet.

## Required backend settings

Render ALLOWED_ORIGINS must include both:

    https://sga-miniapp.vercel.app,https://sga-test-game.vercel.app

The live tap-rush GameRecord embed_url must be:

    https://sga-test-game.vercel.app

The backend rejects any other Origin, including Vercel preview URLs.

## Folders

- godot: source project and saved Web export settings.
- godot-export: the direct Telegram game deployed to Vercel.
- web: older browser bridge harness kept only for compatibility testing.

No separate Telegram bot and no iframe are needed.