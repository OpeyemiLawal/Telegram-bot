/**
 * The SDK and the shell must agree.
 *
 * They are separate files with separate validators — the game's copy is plain
 * JS with no imports, and cannot share code with the shell. That independence is
 * deliberate but it means the two can drift, and the symptom of drift is a game
 * whose every request is silently ignored. Loading the real SDK and checking
 * what it emits against the real parser is what catches that.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseRequest, ok, PROTOCOL_VERSION } from "./bridge-protocol";

// `fileURLToPath`, not `URL.pathname`.
//
// On Windows the pathname of a file URL is "/C:/Users/...", with a leading
// slash, so passing it to readFileSync produces "C:\C:\Users\..." and fails.
// On Linux the two are identical, which is exactly why this survived being
// written and only broke on the machine it had to run on.
const SDK = readFileSync(
  fileURLToPath(new URL("../../platform-sdk/sga-sdk.js", import.meta.url)),
  "utf8",
);

const SHELL = "https://sga-miniapp.vercel.app";

function loadSdk() {
  const posted: any[] = [];
  const listeners: ((e: any) => void)[] = [];

  const win: any = {
    location: { search: `?sgaOrigin=${encodeURIComponent(SHELL)}` },
    addEventListener: (_: string, fn: any) => listeners.push(fn),
    parent: { postMessage: (msg: any, origin: string) => posted.push({ msg, origin }) },
    URL,
    URLSearchParams,
    setTimeout: () => 0,
  };
  win.parent.window = win.parent;

  const ctx: any = { window: win, document: { referrer: "" }, URL, URLSearchParams, setTimeout: () => 0 };
  ctx.globalThis = ctx;

  // eslint-disable-next-line no-new-func
  new Function("window", "document", "URL", "URLSearchParams", "setTimeout", SDK)(
    win, ctx.document, URL, URLSearchParams, ctx.setTimeout,
  );

  return { sdk: win.SGA, posted, deliver: (data: any, origin = SHELL) =>
    listeners.forEach((fn) => fn({ origin, data })) };
}

describe("SDK <-> shell protocol agreement", () => {
  it("emits requests the shell's parser accepts", () => {
    const { sdk, posted } = loadSdk();
    sdk.handshake();
    sdk.getPlayer();
    sdk.haptic("light");
    sdk.exit();

    expect(posted).toHaveLength(4);
    for (const { msg, origin } of posted) {
      expect(origin).toBe(SHELL);           // never "*"
      expect(parseRequest(msg)).not.toBeNull();
    }
    expect(posted.map((p) => p.msg.type)).toEqual([
      "handshake", "getPlayer", "haptic", "exit",
    ]);
  });

  it("uses the same protocol version as the shell", () => {
    const { sdk, posted } = loadSdk();
    sdk.handshake();
    expect(posted[0].msg.sga).toBe(PROTOCOL_VERSION);
  });

  it("resolves a callback from a shell response", () => {
    const { sdk, posted, deliver } = loadSdk();
    const seen: any[] = [];
    sdk.getPlayer((r: any) => seen.push(r));

    deliver(ok(posted[0].msg.id, { displayName: "ope", walletAddress: null }));
    expect(seen).toEqual([{ displayName: "ope", walletAddress: null }]);
  });

  it("ignores a response from any other origin", () => {
    // Without this check another frame could answer a pending request with
    // fabricated data — a fake wallet address, for instance.
    const { sdk, posted, deliver } = loadSdk();
    const seen: any[] = [];
    sdk.getPlayer((r: any) => seen.push(r));

    deliver(ok(posted[0].msg.id, { displayName: "attacker" }), "https://evil.example");
    expect(seen).toHaveLength(0);
  });

  it("ignores a response with an unknown correlation id", () => {
    const { sdk, deliver } = loadSdk();
    const seen: any[] = [];
    sdk.getPlayer((r: any) => seen.push(r));

    deliver(ok("not-a-real-id", { displayName: "x" }));
    expect(seen).toHaveLength(0);
  });
});


function loadDirectSdk() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const haptics: string[] = [];
  const stored = new Map<string, string>();
  let closed = false;

  const win: any = {
    location: { search: "" },
    parent: { postMessage: () => { throw new Error("direct mode must not postMessage"); } },
    addEventListener: () => {},
    URL,
    URLSearchParams,
    SGA_CONFIG: {
      apiUrl: "https://api.test",
      gameSlug: "tap-rush",
    },
    Telegram: {
      WebApp: {
        initData: "signed-telegram-data",
        platform: "android",
        ready: () => {},
        expand: () => {},
        close: () => { closed = true; },
        HapticFeedback: {
          impactOccurred: (style: string) => haptics.push(style),
          notificationOccurred: (style: string) => haptics.push(style),
        },
      },
    },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    },
    fetch: async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return {
        ok: true,
        text: async () => JSON.stringify({
          access_token: "game-token-never-exposed",
          expires_in: 14400,
          game_slug: "tap-rush",
          player: {
            display_name: "Ada",
            wallet_address: "WalletPublicAddress",
          },
        }),
      };
    },
  };

  const ctx: any = {
    window: win,
    document: { referrer: "https://web.telegram.org/" },
    URL,
    URLSearchParams,
    setTimeout,
  };

  // eslint-disable-next-line no-new-func
  new Function("window", "document", "URL", "URLSearchParams", "setTimeout", SDK)(
    win,
    ctx.document,
    URL,
    URLSearchParams,
    setTimeout,
  );

  return {
    sdk: win.SGA,
    calls,
    haptics,
    stored,
    wasClosed: () => closed,
  };
}

describe("SDK direct Telegram mode", () => {
  it("authenticates with the game endpoint and exposes only public player data", async () => {
    const direct = loadDirectSdk();
    const handshake: any[] = [];
    const players: any[] = [];

    expect(direct.sdk.isAvailable()).toBe(true);
    direct.sdk.handshake((value: any) => handshake.push(value));
    direct.sdk.getPlayer((value: any) => players.push(value));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handshake).toEqual([
      { version: 1, gameSlug: "tap-rush", surface: "mobile" },
    ]);
    expect(direct.calls).toHaveLength(1);
    expect(direct.calls[0].url).toBe("https://api.test/api/game/auth");
    expect(JSON.parse(String(direct.calls[0].init.body))).toEqual({
      init_data: "signed-telegram-data",
      game_slug: "tap-rush",
    });
    expect(players).toEqual([
      { displayName: "Ada", walletAddress: "WalletPublicAddress" },
    ]);
    expect(JSON.stringify(players)).not.toContain("game-token-never-exposed");
    expect(direct.stored.get("sga.game.session.tap-rush")).toBe(
      "game-token-never-exposed",
    );
  });

  it("uses Telegram haptics and closes the direct game", () => {
    const direct = loadDirectSdk();

    direct.sdk.haptic("success");
    direct.sdk.exit();

    expect(direct.haptics).toEqual(["success"]);
    expect(direct.wasClosed()).toBe(true);
  });
});
