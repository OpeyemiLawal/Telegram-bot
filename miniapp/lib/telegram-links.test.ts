/**
 * Deep-link rewriting.
 *
 * These rules are the reason tapping "Solflare" opens Solflare rather than
 * solflare.com, and the failure they prevent is entirely silent — a wrong prefix
 * produces a plausible URL that lands on a marketing page, and the pending
 * WalletConnect session is abandoned with no error anywhere. Worth pinning.
 */

import { describe, expect, it } from "vitest";

import { toTelegramSafeUrl } from "./telegram-links";

describe("toTelegramSafeUrl", () => {
  it("rewrites known native schemes to their https universal link", () => {
    expect(toTelegramSafeUrl("solflare://wc?uri=abc")).toBe(
      "https://solflare.com/ul/wc?uri=abc",
    );
    expect(toTelegramSafeUrl("phantom://wc?uri=abc")).toBe(
      "https://phantom.app/ul/wc?uri=abc",
    );
    expect(toTelegramSafeUrl("backpack://wc?uri=abc")).toBe(
      "https://backpack.app/ul/wc?uri=abc",
    );
  });

  it("preserves the query string exactly", () => {
    // The WalletConnect URI lives in here. Any mangling — a dropped parameter, a
    // re-encoded character — breaks the pairing rather than the navigation, which
    // surfaces much later and looks unrelated.
    const uri =
      "solflare://wc?uri=wc%3Aa1b2%402%3Frelay-protocol%3Dirn%26symKey%3Ddead";
    expect(toTelegramSafeUrl(uri)).toBe(
      "https://solflare.com/ul/wc?uri=wc%3Aa1b2%402%3Frelay-protocol%3Dirn%26symKey%3Ddead",
    );
  });

  it("passes http(s) through untouched", () => {
    expect(toTelegramSafeUrl("https://example.com/x?y=1")).toBe(
      "https://example.com/x?y=1",
    );
    expect(toTelegramSafeUrl("http://example.com")).toBe("http://example.com");
  });

  it("is case-insensitive about the scheme", () => {
    expect(toTelegramSafeUrl("Solflare://wc?uri=abc")).toBe(
      "https://solflare.com/ul/wc?uri=abc",
    );
  });

  it("returns null for schemes it has no verified mapping for", () => {
    // Falling through to the real window.open is correct here. Inventing a
    // prefix would turn "this wallet is unsupported" into "this wallet opens a
    // 404", which is strictly worse and harder to diagnose.
    expect(toTelegramSafeUrl("trust://wc?uri=abc")).toBeNull();
    expect(toTelegramSafeUrl("metamask://wc?uri=abc")).toBeNull();
  });

  it("returns null for anything that is not scheme://rest", () => {
    expect(toTelegramSafeUrl("not a url")).toBeNull();
    expect(toTelegramSafeUrl("")).toBeNull();
    expect(toTelegramSafeUrl("mailto:someone@example.com")).toBeNull();
  });
});
