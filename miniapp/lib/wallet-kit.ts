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

if (projectId) {
  createAppKit({
    adapters: [new SolanaAdapter()],
    networks: [solana],
    defaultNetwork: solana,
    projectId,
    metadata: {
      name: "Solana Games",
      description: "Connect one Solana wallet to every Solana Games title.",
      url: appUrl,
      icons: [],
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
}
