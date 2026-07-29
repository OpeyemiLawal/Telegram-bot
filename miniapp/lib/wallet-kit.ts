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
 * Why this is captured rather than allowed to throw:
 *
 * `createAppKit` runs at module scope, so anything it raises happens during
 * import — before any component mounts and before any error boundary exists.
 * On a phone that surfaces as the wallet button doing precisely nothing, with
 * the only evidence in a console the user cannot open. Recording the failure
 * lets the Wallet screen state what went wrong on the device itself.
 */
let initError: string | null = null;

if (projectId) {
  try {
    createAppKit({
      adapters: [new SolanaAdapter()],
      networks: [solana],
      defaultNetwork: solana,
      projectId,
      metadata: {
        name: "Solana Games",
        description: "Connect one Solana wallet to every Solana Games title.",
        url: appUrl,
        // Wallets show this during the approval prompt. Some reject a pairing
        // whose metadata carries no icon at all, so point at the app's own.
        icons: [`${appUrl}/icon.png`],
      },
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
    initError,
  };
}
