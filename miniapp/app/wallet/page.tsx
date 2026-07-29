"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
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
import {
  ensureWalletKit,
  walletKitConfigured,
  walletKitDiagnostics,
} from "@/lib/wallet-kit";

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

/**
 * The four states the wallet screen can be in. Naming them is what stops the
 * UI drifting: every heading, sentence and button below is chosen by exactly
 * one of these, so no combination of booleans can render a screen that says
 * two things at once.
 */
type Stage = "choose" | "approving" | "declined" | "linked" | "mismatch";

/**
 * A two-step progress marker.
 *
 * Connecting a wallet takes the user out to another app and back. Without a
 * visible position in a sequence, the return trip reads as "something happened,
 * unclear what" — and the natural response is to tap the first button again,
 * which is exactly the confused double-connect this replaces.
 */
function Steps({ stage }: { stage: Stage }) {
  const reached = stage === "choose" ? 1 : 2;
  const done = stage === "linked";

  return (
    <ol
      aria-label="Wallet setup progress"
      style={{
        display: "flex",
        gap: 6,
        listStyle: "none",
        padding: 0,
        margin: "0 0 14px",
      }}
    >
      {[1, 2].map((step) => {
        const active = step <= reached;
        return (
          <li
            key={step}
            aria-current={step === reached && !done ? "step" : undefined}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              background: active ? "currentColor" : "currentColor",
              opacity: done ? 0.9 : active ? 0.55 : 0.15,
            }}
          />
        );
      })}
    </ol>
  );
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
    ["Return-to-Telegram", d.returnUrl],
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

  /**
   * Two different facts, previously conflated into one.
   *
   * `linked` is durable and lives on the server: this Telegram account proved
   * ownership of this address, and that stays true until the user unlinks it.
   *
   * `address` is a live WalletConnect session, and it is *transient* — the
   * session does not survive the Mini App relaunch that returning from the
   * wallet causes. Requiring it to consider a wallet linked meant a player who
   * had just finished linking came back to a screen offering "Connect wallet",
   * as though nothing had happened.
   *
   * Only the server fact decides what the screen says. A session is needed
   * again when something actually has to be signed, not to display state.
   */
  const linked = Boolean(user.wallet_address);

  // The one case worth distinguishing: a live session on a *different* wallet
  // than the linked one. Silently showing the linked address would misrepresent
  // which wallet is about to be asked for a signature.
  const mismatched = linked && Boolean(address) && address !== user.wallet_address;

  const verified = linked && !mismatched;

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


  // One derived value rather than three booleans read in four places. Each
  // stage has exactly one heading, one explanation and one set of actions, so
  // there is no combination of flags that can render a contradictory screen.
  const stage: Stage = mismatched
    ? "mismatch"
    : verified
      ? "linked"
      : isConnected
        ? working
          ? "approving"
          : "declined"
        : "choose";

  const COPY: Record<Stage, { eyebrow: string; body: string }> = {
    choose: {
      eyebrow: "Step 1 of 2 — choose",
      body: "Pick the wallet you already use. We never create one for you and never see your keys.",
    },
    mismatch: {
      eyebrow: "Different wallet connected",
      body: "This is not the wallet linked to your account. Link this one instead, or reconnect the original.",
    },
    approving: {
      eyebrow: "Step 2 of 2 — approve",
      body: "Approve the signature in your wallet, then come back. It costs no SOL and moves nothing.",
    },
    declined: {
      eyebrow: "Step 2 of 2 — approve",
      body: "The signature was not completed, so nothing was linked. Your wallet is untouched.",
    },
    linked: {
      eyebrow: "Wallet linked",
      body: "Every game here will use this wallet. You approve each transaction yourself.",
    },
  };

  return (
    <div className="wallet-panel">
      <Steps stage={stage} />

      <span className="eyebrow">{COPY[stage].eyebrow}</span>

      {/* The linked address wins over the session address. They differ only in
          the mismatch case, where showing the session's would imply we had
          switched accounts without being asked. */}
      <p className="wallet-panel__address">
        {user.wallet_address
          ? shortAddress(user.wallet_address)
          : address
            ? shortAddress(address)
            : "No wallet yet"}
      </p>

      <p className="body">{COPY[stage].body}</p>

      {error && <p className="wallet-panel__error">{error}</p>}

      <div className="wallet-panel__actions">
        {/* Gated on `linked`, not on `isConnected`. Offering "Connect wallet" to
            someone who has already linked one is the bug this replaces: their
            WalletConnect session is gone after the relaunch, but their wallet is
            still linked, and the screen should say so. */}
        {stage === "choose" && (
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
        {(stage === "approving" || stage === "declined") && (
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

        {/* A live session on a wallet other than the linked one. Switching is
            offered, never assumed — it costs a signature and changes which
            wallet every game will use. */}
        {stage === "mismatch" && (
          <>
            <button
              className="button"
              disabled={working}
              onClick={() => {
                attempted.current = null;
                void verifySelectedWallet();
              }}
            >
              {working ? "Check your wallet…" : "Link this wallet instead"}
            </button>
            <button
              className="button button--quiet"
              disabled={working}
              onClick={() => void disconnect({ namespace: "solana" })}
            >
              Keep the linked one
            </button>
          </>
        )}

        {/* Linking is a means, not an end — the player came here to play. The
            primary action leads onward; disconnecting is deliberately the quiet
            one, since it is rare and destructive of a step they just took. */}
        {stage === "linked" && (
          <>
            <Link className="button" href="/games" onClick={() => tap()}>
              Browse games
            </Link>
            <button
              className="button button--quiet"
              disabled={working}
              onClick={() => void forgetWallet()}
            >
              {working ? "Disconnecting…" : "Disconnect wallet"}
            </button>
          </>
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
  // AppKit is now built asynchronously, so its hooks cannot be called until it
  // exists. Mounting the connector only once initialisation settles is what
  // keeps that guarantee — a hook against a half-built modal throws during
  // render, which on a phone looks like a blank panel.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    void ensureWalletKit().then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

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

  if (!ready) {
    return <div className="skeleton" style={{ height: 210 }} />;
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
