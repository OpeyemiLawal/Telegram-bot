"use client";

/**
 * Makes wallet deep links work inside Telegram's WebView.
 *
 * The problem this solves, precisely:
 *
 * WalletConnect launches a wallet by calling `window.open` with that wallet's
 * deep link — usually a native scheme such as `solflare://wc?uri=...`. Two
 * things then go wrong inside Telegram:
 *
 *   1. Telegram blocks `window.open` popups on mobile outright.
 *   2. Its in-app browser does not resolve non-http(s) schemes, so a native
 *      scheme either fails silently or degrades to the wallet's marketing site.
 *
 * The visible symptom is the one users report: tapping "Solflare" opens
 * solflare.com instead of the Solflare app, and the pending connection is
 * abandoned.
 *
 * The fix is to intercept `window.open`, rewrite native schemes to the wallet's
 * https universal link, and hand that to `Telegram.WebApp.openLink`, which is
 * Telegram's sanctioned escape hatch. iOS and Android both resolve a universal
 * link to the installed app, so the wallet opens and the WalletConnect session
 * completes.
 *
 * Crucially, `openLink` leaves the Mini App running. A plain navigation would
 * tear down the WebView, taking `window.Telegram.WebApp`, our in-memory access
 * token, and the half-finished WalletConnect pairing with it.
 *
 * Wallets absent from the table below fall through to `openLink` when they are
 * already https, and to the real `window.open` otherwise. No wallet is made
 * worse than it is today.
 */

import { webApp } from "./telegram";

/**
 * Native scheme → https universal-link prefix.
 *
 * Keep this list short and only add an entry after testing that wallet on a
 * real device. A wrong prefix is worse than no entry: instead of falling back
 * to something that half-works, it confidently opens a 404.
 */
const UNIVERSAL_LINK_PREFIX: Record<string, string> = {
  "phantom:": "https://phantom.app/ul/",
  "solflare:": "https://solflare.com/ul/",
  "backpack:": "https://backpack.app/ul/",
};

/**
 * Returns an https URL Telegram will accept, or null if we cannot produce one.
 * https URLs pass through untouched.
 */
export function toTelegramSafeUrl(raw: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*:)\/\/(.*)$/i.exec(raw);
  if (!match) return null;

  const [, scheme, rest] = match;
  const lower = scheme.toLowerCase();

  if (lower === "https:" || lower === "http:") return raw;

  const prefix = UNIVERSAL_LINK_PREFIX[lower];
  return prefix ? prefix + rest : null;
}

let installed = false;

/**
 * Idempotent, and a no-op outside Telegram so ordinary browser behaviour and
 * local development are untouched.
 */
export function routeWalletLinksThroughTelegram(): void {
  if (installed || typeof window === "undefined") return;

  const app = webApp();
  if (!app?.initData || typeof app.openLink !== "function") return;

  installed = true;
  const nativeOpen = window.open.bind(window);

  window.open = ((
    url?: string | URL,
    target?: string,
    features?: string,
  ): Window | null => {
    if (!url) return nativeOpen(url as string | undefined, target, features);

    const href = url.toString();

    // Telegram links must stay inside Telegram; openLink would bounce them out
    // to a browser that immediately tries to hand them back.
    if (href.startsWith("tg://") || href.startsWith("https://t.me/")) {
      app.openTelegramLink?.(href);
      return null;
    }

    const safe = toTelegramSafeUrl(href);
    if (safe) {
      // try_instant_view would render the wallet's link as an article preview
      // rather than following it to the app.
      app.openLink?.(safe, { try_instant_view: false });
      return null;
    }

    return nativeOpen(href, target, features);
  }) as typeof window.open;
}
