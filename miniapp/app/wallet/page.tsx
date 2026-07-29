"use client";

import { useEffect, useRef, useState } from "react";
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

  /**
   * Signs as soon as the wallet reports connected, rather than parking the user
   * on a second button.
   *
   * Connecting and proving ownership are one intention — "use this wallet" —
   * split into two taps only because AppKit resolves the connection before we
   * can ask for a signature. Worse, the wallet round trip relaunches the Mini
   * App, so the second tap lands on a freshly mounted screen and reads as
   * "nothing happened, try again".
   *
   * `attempted` guards against the effect re-firing: a failed signature must
   * not loop, and after a rejection the user gets an explicit retry button.
   */
  const attempted = useRef<string | null>(null);

  useEffect(() => {
    if (!isConnected || !address || !walletProvider) return;
    if (verified || working) return;
    if (attempted.current === address) return;

    attempted.current = address;
    void verifySelectedWallet();
    // verifySelectedWallet closes over exactly these; listing it would recreate
    // the identity every render and defeat the guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address, walletProvider, verified, working]);

  async function forgetWallet() {
    attempted.current = null;
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
            ? working
              ? "Approve the signature in your wallet. It costs no SOL."
              : "The signature was not completed. Nothing was sent."
            : user.wallet_address
              ? "Reconnect this wallet when a game needs a signature."
              : "Connect Phantom, Solflare, Backpack, or another Solana wallet."}
      </p>

      {error && <p className="wallet-panel__error">{error}</p>}

      <div className="wallet-panel__actions">
        {!isConnected && (
          <>
            {/* "Connect" lists installed wallets and deep-links into the chosen
                one, which is the whole interaction on a phone. The QR exists so
                a *desktop* user can scan with the wallet on their phone — on
                mobile it is noise, because the wallet is already on the device
                doing the scanning. So it is offered on desktop only. */}
            <button
              className="button"
              disabled={working}
              onClick={() => void launch("Connect")}
            >
              Connect wallet
            </button>

            {!isMobileTelegram() && (
              <button
                className="button button--quiet"
                disabled={working}
                onClick={() => void launch("ConnectingWalletConnectBasic")}
              >
                Scan QR instead
              </button>
            )}
          </>
        )}

        {/* Connected but unproven. The signature is requested automatically, so
            this branch is only reached while it is in flight, or after the user
            declined it in their wallet — hence "Try again" rather than a first
            instruction. */}
        {isConnected && !verified && (
          <>
            <button
              className="button"
              disabled={working}
              onClick={() => void verifySelectedWallet()}
            >
              {working ? "Check your wallet…" : "Try signing again"}
            </button>
            <button
              className="button button--quiet"
              disabled={working}
              onClick={() => void forgetWallet()}
            >
              Use a different wallet
            </button>
          </>
        )}

        {verified && (
          <button
            className="button button--quiet"
            disabled={working}
            onClick={() => void forgetWallet()}
          >
            {working ? "Disconnecting…" : "Disconnect wallet"}
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
