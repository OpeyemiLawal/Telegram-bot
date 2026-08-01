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
      let body: any = {
        access_token: "game-token-never-exposed",
        expires_in: 14400,
        game_slug: "tap-rush",
        player: {
          display_name: "Ada",
          wallet_address: "WalletPublicAddress",
        },
      };
      if (url.endsWith("/rewards/rounds")) {
        body = {
          round_id: "round-1",
          available_amount: 0,
          token_symbol: "$Gamer",
          rules: {
            taps_per_reward: 5,
            tokens_per_reward: 100,
            round_seconds: 20,
            daily_cap: 10000,
          },
        };
      } else if (url.endsWith("/taps")) {
        body = {
          accepted_taps: 5,
          tap_progress: 0,
          earned_now: 100,
          available_amount: 100,
          daily_remaining: 9900,
          token_symbol: "$Gamer",
        };
      } else if (url.endsWith("/rewards/claim")) {
        body = {
          claim_id: "claim-1",
          amount: 100,
          token_symbol: "$Gamer",
          wallet_address: "WalletPublicAddress",
          status: "confirmed",
          signature: "signature-1",
          explorer_url: "https://explorer.solana.com/tx/signature-1?cluster=devnet",
          message: "Gamer Tokens were sent to your linked wallet.",
        };
      } else if (url.endsWith("/rewards")) {
        body = {
          available_amount: 100,
          pending_amount: 0,
          lifetime_earned: 100,
          lifetime_claimed: 0,
          token_symbol: "$Gamer",
          wallet_address: "WalletPublicAddress",
          claims_enabled: true,
          minimum_claim: 100,
          can_claim: true,
        };
      }
      return {
        ok: true,
        text: async () => JSON.stringify(body),
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

  it("earns through authenticated reward calls without exposing the game token", async () => {
    const direct = loadDirectSdk();
    const rounds: any[] = [];
    const taps: any[] = [];

    direct.sdk.startRewardRound((value: any) => rounds.push(value));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    direct.sdk.recordTap("round-1", 5, 700, (value: any) => taps.push(value));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rounds[0]).toEqual({
      roundId: "round-1",
      availableAmount: 0,
      tokenSymbol: "$Gamer",
      rules: {
        tapsPerReward: 5,
        tokensPerReward: 100,
        roundSeconds: 20,
        dailyCap: 10000,
      },
    });
    expect(taps[0].earnedNow).toBe(100);
    expect(taps[0].availableAmount).toBe(100);

    const rewardCalls = direct.calls.slice(1);
    expect(rewardCalls[0].url).toBe(
      "https://api.test/api/game/rewards/rounds",
    );
    expect((rewardCalls[0].init.headers as any).Authorization).toBe(
      "Bearer game-token-never-exposed",
    );
    expect(JSON.stringify(rounds) + JSON.stringify(taps)).not.toContain(
      "game-token-never-exposed",
    );
  });
  it("loads claim state and claims only through the authenticated game API", async () => {
    const direct = loadDirectSdk();
    const summaries: any[] = [];
    const claims: any[] = [];

    direct.sdk.getRewardSummary((value: any) => summaries.push(value));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    direct.sdk.claimRewards((value: any) => claims.push(value));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(summaries[0].availableAmount).toBe(100);
    expect(summaries[0].canClaim).toBe(true);
    expect(claims[0]).toMatchObject({
      amount: 100,
      walletAddress: "WalletPublicAddress",
      status: "confirmed",
      signature: "signature-1",
    });

    const rewardCalls = direct.calls.slice(1);
    expect(rewardCalls.map((call) => call.url)).toEqual([
      "https://api.test/api/game/rewards",
      "https://api.test/api/game/rewards/claim",
    ]);
    expect(
      rewardCalls.every(
        (call) =>
          (call.init.headers as any).Authorization ===
          "Bearer game-token-never-exposed",
      ),
    ).toBe(true);
    expect(JSON.stringify(summaries) + JSON.stringify(claims)).not.toContain(
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
