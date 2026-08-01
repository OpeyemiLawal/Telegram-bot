# Platform SDK v1

This SDK lets every game use the same Godot calls while supporting the current direct Telegram flow and the older iframe bridge.

The source of truth is platform-sdk/sga-sdk.js. The Mini App build copies it to:

    https://sga-miniapp.vercel.app/sdk/v1/sga-sdk.js

## Current direct flow

1. The main bot opens the game Vercel URL as a Telegram Web App.
2. Telegram supplies signed initData to that page.
3. The SDK sends initData and the game slug to POST /api/game/auth.
4. The backend verifies Telegram and checks that the request Origin exactly matches the registered game URL.
5. The backend returns a short-lived, game-scoped session.
6. Godot receives only displayName and the already-linked public walletAddress.

The session is stored internally for the browser session. It is never returned to Godot. It cannot call the full account API. Reward calls use it internally so a different origin cannot report taps for this game.

## Add another game

1. Deploy the Godot Web export to its own HTTPS origin.
2. Add the Telegram script, SGA_CONFIG apiUrl/gameSlug, and the versioned SDK URL to the Web Head Include.
3. Add the origin to backend ALLOWED_ORIGINS.
4. Register that exact origin and slug as a live GameRecord.

The existing main bot will list the new live game automatically. Do not create another bot.

## Godot API

- isAvailable(): true inside the direct Telegram app or supported legacy shell.
- handshake(callback): returns version, gameSlug, and surface.
- getPlayer(callback): returns displayName and walletAddress.
- startRewardRound(callback): starts a 20-second server reward window.
- recordTap(roundId, sequence, elapsedMs, callback): records one successful ordered tap.
- haptic(style): triggers Telegram haptic feedback.
- exit(): closes the Telegram Web App.

Keep JavaScriptBridge callback objects as node members. A local callback can be garbage-collected before the reply arrives.

## Security boundary

Games can identify the player and read the linked public address. They cannot access private keys or silently sign transactions. Deposits, withdrawals, swaps, and other signing requests must be sent to the trusted Wallet Mini App, where the wallet shows the user what they are approving.

Legacy postMessage support remains in v1 only so older exports do not break. The active bot path does not use an iframe.