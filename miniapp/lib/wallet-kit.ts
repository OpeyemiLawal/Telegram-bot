"use client";

import { createAppKit } from "@reown/appkit/react";
import { SolanaAdapter } from "@reown/appkit-adapter-solana/react";
import { solana } from "@reown/appkit/networks";

import { routeWalletLinksThroughTelegram } from "./telegram-links";

// Must run before createAppKit. AppKit captures no reference to window.open at
// construction time, but installing the patch first removes any ordering
// question and guarantees the very first connection attempt is already routed.
routeWalletLinksThroughTelegram();

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID;
const configuredAppUrl =
  process.env.NEXT_PUBLIC_MINIAPP_URL ?? "https://solanagames.app";
const appUrl =
  typeof window === "undefined" ? configuredAppUrl : window.location.origin;

export const walletKitConfigured = Boolean(projectId);

/**
 * Where the wallet should send the user after they approve.
 *
 * This is the difference between a flow that completes and one that strands the
 * user staring at their wallet app. WalletConnect passes `metadata.redirect` to
 * the wallet as part of the session; wallets use it to bounce back once the
 * request is signed. With no redirect there is nothing to bounce to, so the
 * wallet simply stays open — the user has to find Telegram themselves, and by
 * then the signature looks like it failed.
 *
 * `universal` is the https form (t.me), which iOS and Android both resolve to
 * the Telegram app. `native` is the tg:// scheme, tried first by wallets that
 * support it.
 *
 * Set NEXT_PUBLIC_TELEGRAM_RETURN_URL to the Mini App's direct link — the one
 * BotFather gives you after /newapp, of the form:
 *
 *     https://t.me/<bot_username>/<app_short_name>
 *
 * A bare https://t.me/<bot_username> also works and lands the user in the chat
 * rather than the app: less seamless, still far better than not returning.
 */
const returnUrl = process.env.NEXT_PUBLIC_TELEGRAM_RETURN_URL?.trim();

/** Comma-separated WalletConnect explorer ids. Empty means "AppKit decides". */
const walletIds = (process.env.NEXT_PUBLIC_WALLET_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

function telegramRedirect() {
  if (!returnUrl) return undefined;

  // t.me/Bot/app → tg://resolve?domain=Bot&appname=app
  const path = returnUrl.replace(/^https?:\/\/t\.me\//i, "").replace(/\/+$/, "");
  const [domain, appname] = path.split("/");

  return {
    universal: returnUrl,
    native: domain
      ? `tg://resolve?domain=${domain}${appname ? `&appname=${appname}` : ""}`
      : undefined,
  };
}

/**
 * Why this is captured rather than allowed to throw:
 *
 * `createAppKit` runs at module scope, so anything it raises happens during
 * import — before any component mounts and before any error boundary exists.
 * On a phone that surfaces as the wallet button doing precisely nothing, with
 * the only evidence in a console the user cannot open. Recording the failure
 * lets the Wallet screen state what went wrong on the device itself.
 */
let initError: string | null = null;
let started: Promise<void> | null = null;

let pairingUri: string | null = null;
const uriListeners = new Set<(uri: string) => void>();

/**
 * Subscribe to the WalletConnect pairing URI. Fires immediately if one already
 * exists, so a component mounting mid-pairing is not left waiting for an event
 * that has already happened.
 */
export function onPairingUri(fn: (uri: string) => void): () => void {
  uriListeners.add(fn);
  if (pairingUri) fn(pairingUri);
  return () => uriListeners.delete(fn);
}

const METADATA = {
  name: "Solana Games",
  description: "Connect one Solana wallet to every Solana Games title.",
  url: appUrl,
  // Wallets show this during the approval prompt. Some reject a pairing
  // whose metadata carries no icon at all, so point at the app's own.
  icons: [`${appUrl}/icon.png`],
};

/**
 * Builds AppKit on top of a provider we initialise ourselves.
 *
 * The detour exists for one field. `createAppKit({ metadata })` looks like the
 * place to put `redirect`, and it type-errors if you try — AppKit's `Metadata`
 * is `{name, description, url, icons}` and nothing else. Worse, even casting
 * past the type achieves nothing: AppKit rebuilds the object from exactly those
 * four keys before handing it to UniversalProvider, so `redirect` is dropped on
 * the floor and the "fix" reads as correct while changing nothing.
 *
 * `createAppKit` does accept a pre-built `universalProvider`, though, and that
 * one is initialised with our metadata verbatim. So the redirect survives, and
 * the wallet learns where to send the user once they have signed.
 *
 * Async as a consequence, hence `ensureWalletKit()` rather than a bare module
 * side effect. The wallet screen awaits it before rendering anything that calls
 * an AppKit hook.
 */
export function ensureWalletKit(): Promise<void> {
  if (started) return started;

  started = (async () => {
    if (!projectId) return;

    try {
      const { UniversalProvider } = await import(
        "@walletconnect/universal-provider"
      );

      const universalProvider = await UniversalProvider.init({
        projectId,
        metadata: { ...METADATA, redirect: telegramRedirect() },
      });

      // The same string the QR encodes. Captured so the Wallet screen can offer
      // it as selectable text: Telegram frames the Mini App cross-origin and
      // does not grant `clipboard-write` to that frame, so a copy button can
      // fail with no feedback — which is what "the copy link button isn't
      // working" was. Text the user can select needs no permission.
      universalProvider.on("display_uri", (uri: string) => {
        pairingUri = uri;
        uriListeners.forEach((fn) => fn(uri));
      });

      createAppKit({
        adapters: [new SolanaAdapter()],
        networks: [solana],
        defaultNetwork: solana,
        projectId,
        metadata: METADATA,
        universalProvider,

        // Removes the "All wallets (600+)" browse button.
        //
        // That list is the right default for a general dapp and the wrong one
        // here: this is a Solana-only app, so most of what it offers cannot
        // connect at all, and a user who picks one gets a dead end rather than
        // an explanation. Hiding it costs nothing — every wallet worth showing
        // is in the list below.
        allWallets: "HIDE",

        // A strict allowlist when configured, otherwise AppKit's own defaults.
        //
        // Left unset the modal advertises its recommended wallets whether or
        // not they are installed, which on desktop means most of the list is
        // aspirational. Naming the wallets this app actually supports turns the
        // chooser into a short, honest menu.
        //
        // Values are WalletConnect explorer ids — see .env.example for how to
        // look them up. Deliberately configuration rather than a constant: a
        // wrong id fails silently by showing nothing, so it belongs somewhere
        // it can be corrected without a code change.
        ...(walletIds.length ? { includeWalletIds: walletIds } : {}),
        features: {
          analytics: false,
          email: false,
          socials: [],
          swaps: false,
          onramp: false,
        },
        enableNetworkSwitch: false,
        enableMobileFullScreen: true,
      });
    } catch (err) {
      initError = err instanceof Error ? err.message : String(err);
    }
  })();

  return started;
}

/** Everything the Wallet screen needs to explain a failed connection. */
export function walletKitDiagnostics() {
  return {
    projectIdSet: Boolean(projectId),
    // First and last few characters only — enough to spot a truncated or
    // stale value without printing the whole thing on screen.
    projectIdHint: projectId
      ? `${projectId.slice(0, 6)}…${projectId.slice(-4)}`
      : null,
    appUrl,
    apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "(unset)",
    // Its absence is the difference between returning to Telegram after signing
    // and being left in the wallet app, so it is worth showing.
    returnUrl: returnUrl ?? "MISSING — wallet cannot return you",
    initError,
  };
}
