# Export Tap Rush for Telegram

Current flow:

    Main bot -> Test -> Tap Rush Vercel app

The game opens directly as a Telegram Mini App. There is no iframe and no separate bot.

## One-time Godot Web settings

1. Open Project -> Export -> Web.
2. Disable Thread Support.
3. Set Head Include to:

    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script>
    window.SGA_CONFIG = {
      apiUrl: "https://sga-api-v924.onrender.com",
      gameSlug: "tap-rush"
    };
    </script>
    <script src="https://sga-miniapp.vercel.app/sdk/v1/sga-sdk.js"></script>

These settings are already saved in export_presets.cfg for Tap Rush.

## Export and deploy

1. Install Godot 4.3 or newer, then export as test-game/godot-export/index.html. Re-export is required after Main.gd changes because the script is packed into index.pck.
2. In the Tap Rush Vercel project, set Root Directory to test-game/godot-export.
3. Deploy.
4. In Render, set ALLOWED_ORIGINS to:

    https://sga-miniapp.vercel.app,https://sga-test-game.vercel.app

5. In the game catalogue, keep tap-rush live with this exact URL:

    https://sga-test-game.vercel.app

A different URL, protocol, port, or Vercel preview domain is rejected by the backend.

## What the game receives

The SDK verifies Telegram through the SGA backend. Godot receives only:

- displayName
- walletAddress, or null when no wallet is linked

The game never receives Telegram initData, the platform login token, a wallet private key, or signing power. Wallet connection and transaction approval stay in the Wallet Mini App.