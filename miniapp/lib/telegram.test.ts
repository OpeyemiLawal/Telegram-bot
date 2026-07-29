/**
 * Surface detection.
 *
 * This one value decides whether a user is offered a deep link, a QR code, or
 * told to switch devices. Getting it wrong does not throw — it shows a working
 * user the wrong flow, or shows a desktop user a QR that can never finish
 * loading, which is the bug this mapping was introduced to end.
 *
 * Every platform string Telegram is known to report is covered, plus an
 * unrecognised one, because a client we have never heard of must still land
 * somewhere sensible.
 */

import { afterEach, describe, expect, it } from "vitest";

import { hasInjectedSolanaWallet, isMobileTelegram, telegramSurface } from "./telegram";

function pretendTelegram(platform: string | null) {
  (globalThis as Record<string, unknown>).window = platform
    ? { Telegram: { WebApp: { platform, initData: "x" } } }
    : {};
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe("telegramSurface", () => {
  it.each([
    ["ios", "mobile"],
    ["android", "mobile"],
  ])("treats %s as %s", (platform, expected) => {
    pretendTelegram(platform);
    expect(telegramSurface()).toBe(expected);
    expect(isMobileTelegram()).toBe(true);
  });

  it.each(["web", "weba", "webk"])(
    "treats the %s client as a browser",
    (platform) => {
      // Telegram ships several web clients and has added more over time. Matching
      // the "web" prefix rather than an exact list means a future one is handled
      // without a code change.
      pretendTelegram(platform);
      expect(telegramSurface()).toBe("web");
    },
  );

  it.each(["tdesktop", "macos", "linux"])(
    "treats the %s client as the desktop app",
    (platform) => {
      pretendTelegram(platform);
      expect(telegramSurface()).toBe("desktop");
      expect(isMobileTelegram()).toBe(false);
    },
  );

  it("treats an unrecognised client as desktop", () => {
    // Deliberate: desktop is the branch that offers no QR and no deep link, only
    // instructions. An unknown client is more likely to fail at a deep link than
    // to be confused by advice, so this is the safe default.
    pretendTelegram("some-future-client");
    expect(telegramSurface()).toBe("desktop");
  });

  it("treats a missing WebApp as desktop rather than throwing", () => {
    pretendTelegram(null);
    expect(telegramSurface()).toBe("desktop");
  });
});

describe("hasInjectedSolanaWallet", () => {
  it("is false with no wallet globals present", () => {
    pretendTelegram("web");
    expect(hasInjectedSolanaWallet()).toBe(false);
  });

  it.each(["solana", "solflare", "backpack", "phantom"])(
    "detects window.%s",
    (key) => {
      pretendTelegram("web");
      (globalThis as Record<string, any>).window[key] = {};
      expect(hasInjectedSolanaWallet()).toBe(true);
    },
  );
});
