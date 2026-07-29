"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  useAppKit,
  useAppKitAccount,
  useAppKitProvider,
  useDisconnect,
} from "@reown/appkit/react";
import type { Provider } from "@reown/appkit-adapter-solana/react";

import { PlayerCard } from "@/components/PlayerCard";
import { Screen } from "@/components/Screen";
import {
  createWalletChallenge,
  linkWallet,
  unlinkWallet,
  type Me,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { isMobileTelegram, notify, tap, webApp } from "@/lib/telegram";
import { walletKitConfigured, walletKitDiagnostics } from "@/lib/wallet-kit";

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

/**
 * Collapsed by default and never shown unless opened. It exists because the
 * usual way to diagnose a dead wallet button — the browser console — is not
 * reachable inside Telegram on a phone.
 */
function Diagnostics({ lastError }: { lastError: string | null }) {
  const d = walletKitDiagnostics();
  const app = typeof window !== "undefined" ? webApp() : null;

  const rows: [string, string][] = [
    ["Telegram platform", app?.platform ?? "not in Telegram"],
    ["Telegram version", app?.version ?? "—"],
    ["Can open wallet apps", typeof app?.openLink === "function" ? "yes" : "no"],
    ["Reown project ID", d.projectIdHint ?? "MISSING"],
    ["App URL", d.appUrl],
    ["API URL", d.apiUrl],
    ["AppKit startup", d.initError ?? "ok"],
    ["Last connect error", lastError ?? "none"],
  ];

  return (
    <details className="notice" style={{ marginTop: 16 }}>
      <summary className="body" style={{ cursor: "pointer" }}>
        Connection diagnostics
      </summary>
      <dl style={{ margin: "12px 0 0", fontSize: 13, lineHeight: 1.7 }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: "flex", gap: 8 }}>
            <dt style={{ opacity: 0.6, flex: "0 0 46%" }}>{label}</dt>
            <dd style={{ margin: 0, wordBreak: "break-all" }}>{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function signatureBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value && typeof value === "object" && "signature" in value) {
    return signatureBytes((value as { signature: unknown }).signature);
  }
  throw new Error("The wallet returned an unsupported signature.");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

function ConnectedWalletConnector({
  user,
  updateUser,
}: {
  user: Me;
  updateUser: (user: Me) => void;
}) {
  const { open } = useAppKit();
  const { address, isConnected } = useAppKitAccount({ namespace: "solana" });
  const { walletProvider } = useAppKitProvider<Provider>("solana");
  const { disconnect } = useDisconnect();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verified =
    Boolean(address) &&
    Boolean(user.wallet_address) &&
    address === user.wallet_address;

  async function verifySelectedWallet() {
    if (!address || !walletProvider) return;
    setWorking(true);
    setError(null);
    try {
      const challenge = await createWalletChallenge(address);
      const signed = await walletProvider.signMessage(
        new TextEncoder().encode(challenge.message),
      );
      const updated = await linkWallet({
        nonce: challenge.nonce,
        address,
        signature: toBase64(signatureBytes(signed)),
      });
      updateUser(updated);
      notify("success");
    } catch (err) {
      notify("error");
      setError(err instanceof Error ? err.message : "Wallet verification failed.");
    } finally {
      setWorking(false);
    }
  }

  /**
   * `open()` rejecting is the single most common cause of "the button does
   * nothing" — an uncaught rejection here is invisible on a phone. Recording it
   * puts the reason in the diagnostics panel below.
   */
  async function launch(view: "Connect" | "ConnectingWalletConnectBasic") {
    tap();
    setError(null);
    try {
      await open({ view, namespace: "solana" });
    } catch (err) {
      notify("error");
      setError(
        err instanceof Error
          ? `Could not open the wallet chooser: ${err.message}`
          : "Could not open the wallet chooser.",
      );
    }
  }

  async function forgetWallet() {
    setWorking(true);
    setError(null);
    try {
      await unlinkWallet();
      if (isConnected) await disconnect({ namespace: "solana" });
      updateUser({ ...user, wallet_address: null });
      notify("success");
    } catch (err) {
      notify("error");
      setError(err instanceof Error ? err.message : "Could not disconnect wallet.");
    } finally {
      setWorking(false);
    }
  }


  return (
    <div className="wallet-panel">
      <span className="eyebrow">
        {verified ? "Verified wallet" : isConnected ? "Wallet selected" : "External wallet"}
      </span>

      <p className="wallet-panel__address">
        {address
          ? shortAddress(address)
          : user.wallet_address
            ? shortAddress(user.wallet_address)
            : "Not connected"}
      </p>

      <p className="body">
        {verified
          ? "This wallet is linked to your Telegram account and will be used by every game."
          : isConnected
            ? "Sign one message to prove this wallet belongs to you. This costs no SOL."
            : user.wallet_address
              ? "Reconnect this wallet when a game needs a signature."
              : "Connect Phantom, Solflare, Backpack, or another Solana wallet."}
      </p>

      {error && <p className="wallet-panel__error">{error}</p>}

      <div className="wallet-panel__actions">
        {!isConnected && (
          <>
            {/* On a phone "Connect" lists installed wallets and deep-links out
                to the chosen one. On Telegram Desktop or Web there is nothing
                to deep-link into, so the QR is the primary path there. Whichever
                is not primary is offered as the secondary, so neither is a dead
                end. */}
            <button
              className="button"
              disabled={working}
              onClick={() =>
                void launch(
                  isMobileTelegram()
                    ? "Connect"
                    : "ConnectingWalletConnectBasic",
                )
              }
            >
              {isMobileTelegram() ? "Connect wallet" : "Connect wallet (QR)"}
            </button>

            <button
              className="button button--quiet"
              disabled={working}
              onClick={() =>
                void launch(
                  isMobileTelegram()
                    ? "ConnectingWalletConnectBasic"
                    : "Connect",
                )
              }
            >
              {isMobileTelegram() ? "Scan QR instead" : "Choose a wallet"}
            </button>
          </>
        )}

        {isConnected && !verified && (
          <>
            <button
              className="button"
              disabled={working}
              onClick={() => void verifySelectedWallet()}
            >
              {working ? "Waiting for wallet..." : "Verify and use wallet"}
            </button>
            <button
              className="button button--quiet"
              disabled={working}
              onClick={() => void open({ view: "Account" })}
            >
              Choose another
            </button>
          </>
        )}

        {verified && (
          <button
            className="button button--quiet"
            disabled={working}
            onClick={() => void forgetWallet()}
          >
            {working ? "Disconnecting..." : "Disconnect wallet"}
          </button>
        )}
      </div>

      <Diagnostics lastError={error} />
    </div>
  );
}

function WalletConnector({
  user,
  updateUser,
}: {
  user: Me;
  updateUser: (user: Me) => void;
}) {
  if (!walletKitConfigured) {
    return (
      <div className="notice">
        <p className="body">
          Wallet connection needs NEXT_PUBLIC_REOWN_PROJECT_ID in the Mini App
          environment.
        </p>
      </div>
    );
  }

  return <ConnectedWalletConnector user={user} updateUser={updateUser} />;
}

export default function WalletPage() {
  const router = useRouter();
  const { updateUser } = useAuth();

  return (
    <Screen onBack={() => router.push("/")}>
      {(user) => (
        <>
          <span className="eyebrow">Section 01</span>
          <h1 className="display" style={{ margin: "8px 0 24px" }}>
            Wallet
          </h1>

          <PlayerCard user={user} />
          <WalletConnector user={user} updateUser={updateUser} />

          <div className="stack">
            <button className="tile" disabled>
              <span className="tile__body">
                <span className="heading">Deposit</span>
                <p className="body">Address and QR are added in the next step.</p>
              </span>
              <span className="badge">Next</span>
            </button>

            <button className="tile" disabled>
              <span className="tile__body">
                <span className="heading">Withdraw</span>
                <p className="body">Every transfer will require wallet approval.</p>
              </span>
              <span className="badge">Next</span>
            </button>
          </div>

          <div className="notice">
            <p className="body">
              Solana Games stores only your public address. Never send a seed
              phrase or private key to this bot.
            </p>
          </div>
        </>
      )}
    </Screen>
  );
}
