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
import {
  hasInjectedSolanaWallet,
  notify,
  tap,
  telegramSurface,
  webApp,
} from "@/lib/telegram";
import {
  ensureWalletKit,
  onPairingUri,
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
 * The connect buttons, which differ per surface because the three environments
 * genuinely connect a wallet in three different ways.
 *
 *   mobile   One button. The wallet is on this device; deep-link straight into
 *            it. A QR here would ask the user to scan their own screen.
 *
 *   web      Extension first *if one announced itself*, QR otherwise. Telegram
 *            frames the Mini App cross-origin, so injection is not guaranteed —
 *            hence a hint rather than a decision, with QR always reachable.
 *
 *   desktop  QR only. The Telegram Desktop webview has no extensions and no
 *            wallet app to hand off to; scanning with a phone is the one path
 *            that exists. Offering "Connect wallet" here would open a list of
 *            wallets it cannot reach.
 */
function ConnectActions({
  working,
  launch,
}: {
  working: boolean;
  launch: (view: "Connect" | "ConnectingWalletConnectBasic") => Promise<void>;
}) {
  const surface = telegramSurface();

  // Nothing to offer on the Telegram desktop client. Wallet pairing needs a
  // WalletConnect relay socket that its webview does not complete, so every
  // button here would lead to a spinner that never resolves. An action that
  // cannot succeed is worse than no action: it invites the user to keep
  // waiting, then to try again, then to conclude the app is broken.
  // `DesktopRoutes` below carries the two routes that do work.
  if (surface === "desktop") return null;

  return (
    <>
      <button
        className="button"
        disabled={working}
        onClick={() => void launch("Connect")}
      >
        Connect wallet
      </button>

      {/* Jumping straight to the QR view is available but not the default.
          AppKit's own Connect view already branches on desktop vs mobile and is
          the path its maintainers test; forcing an inner view means owning that
          decision ourselves and inheriting every edge case that comes with it.
          Kept as an explicit escape for when the default lands somewhere the
          user did not want. */}
      {surface === "web" && (
        <button
          className="button button--quiet"
          disabled={working}
          onClick={() => void launch("ConnectingWalletConnectBasic")}
        >
          Show QR code
        </button>
      )}
    </>
  );
}

/**
 * What the Telegram Desktop client gets instead of a QR code.
 *
 * The QR never renders there, and the reason is upstream of anything this app
 * controls: generating the code requires a WalletConnect relay socket, and the
 * Telegram Desktop webview does not complete that connection. The same build
 * pairs fine from Telegram on a phone and from Telegram in a browser, which is
 * what rules out our CSP, our project id and our provider setup.
 *
 * A spinner that will never resolve is the worst possible answer to that. It
 * reads as "still working, keep waiting", and the user has no way to learn
 * otherwise. Two routes that do work is a better answer than one that does not.
 *
 * The QR is still reachable below, deliberately: if a future Telegram Desktop
 * build fixes the socket, nothing here has to change for it to start working.
 */
function DesktopRoutes() {
  const link = process.env.NEXT_PUBLIC_TELEGRAM_RETURN_URL;

  return (
    <div className="notice" style={{ marginTop: 4 }}>
      <p className="heading" style={{ marginBottom: 8 }}>
        Connect from your phone or browser
      </p>
      <p className="body">
        The Telegram desktop app cannot reach the wallet network, so a wallet
        cannot be connected here. Both of these take under a minute:
      </p>

      <ol className="body" style={{ margin: "12px 0 0", paddingLeft: 20 }}>
        <li style={{ marginBottom: 10 }}>
          <strong>On your phone</strong> — open this bot in Telegram and tap
          Play. Two taps, nothing to scan.
          {link ? (
            <div
              style={{
                marginTop: 4,
                fontSize: 12,
                fontFamily: "ui-monospace, monospace",
                wordBreak: "break-all",
                opacity: 0.75,
              }}
            >
              {link}
            </div>
          ) : null}
        </li>
        <li>
          <strong>In a browser</strong> — open{" "}
          <span style={{ fontFamily: "ui-monospace, monospace" }}>
            web.telegram.org
          </span>
          , find this bot, and launch the app from there.
        </li>
      </ol>

      <p className="body" style={{ marginTop: 12, opacity: 0.75 }}>
        Once connected, your wallet stays linked to your account — you will not
        need to do this again, and the desktop app works normally afterwards.
      </p>
    </div>
  );
}

/**
 * The pairing link as selectable text, for when the clipboard is unavailable.
 *
 * Telegram frames the Mini App on a different origin and does not grant that
 * frame `clipboard-write`, so `navigator.clipboard.writeText` rejects — and a
 * copy button that rejects looks identical to one that did nothing. Text the
 * user can select and copy by hand needs no permission and cannot fail.
 *
 * Only offered on desktop. On a phone the wallet is on the same device, so
 * there is nothing to paste a link into.
 */
function PairingLink() {
  const [uri, setUri] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => onPairingUri(setUri), []);

  if (!uri) return null;

  async function copy() {
    if (!uri) return;
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Expected inside Telegram. The text below is the real answer; the
      // button is just the shortcut for environments that allow it.
    }
  }

  const mobile = telegramSurface() === "mobile";

  return (
    <details className="notice" style={{ marginTop: 12 }}>
      <summary className="body" style={{ cursor: "pointer" }}>
        {mobile ? "Wallet not listed?" : "Can’t scan the code?"}
      </summary>
      <p className="body" style={{ marginTop: 10 }}>
        {mobile
          ? "Copy this link, open your wallet, and use its WalletConnect or Scan option to paste it."
          : "Paste this into your wallet’s WalletConnect option."}
      </p>
      <textarea
        readOnly
        value={uri}
        onFocus={(e) => e.currentTarget.select()}
        aria-label="WalletConnect pairing link"
        style={{
          width: "100%",
          minHeight: 72,
          marginTop: 8,
          fontSize: 11,
          fontFamily: "ui-monospace, monospace",
          wordBreak: "break-all",
          background: "transparent",
          color: "inherit",
          border: "1px solid currentColor",
          borderRadius: 8,
          padding: 8,
          opacity: 0.85,
        }}
      />
      <button
        className="button button--quiet"
        style={{ marginTop: 8 }}
        onClick={() => void copy()}
      >
        {copied ? "Copied" : "Copy link"}
      </button>
    </details>
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
    ["Surface", telegramSurface()],
    ["Extension detected", hasInjectedSolanaWallet() ? "yes" : "no"],
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
      eyebrow:
        telegramSurface() === "desktop"
          ? "Not available here"
          : "Step 1 of 2 — choose",
      body:
        telegramSurface() === "mobile"
          ? "Pick the wallet you already use. We never create one for you and never see your keys."
          : telegramSurface() === "web"
            ? "Scan the code with the Solana wallet on your phone, or use a browser extension if you have one."
            : // The detail lives in DesktopRoutes below, which has room for two
              // numbered routes. Repeating it here would say the same thing
              // twice before the user reaches the part that helps.
              "",
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

  // No two-step sequence to show on the desktop client — there is no step one
  // to take there. A progress bar for a flow the user cannot start is just a
  // promise the screen does not keep.
  const desktop = telegramSurface() === "desktop";

  return (
    <div className="wallet-panel">
      {!(desktop && stage === "choose") && <Steps stage={stage} />}

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

      {COPY[stage].body && <p className="body">{COPY[stage].body}</p>}

      {error && <p className="wallet-panel__error">{error}</p>}

      <div className="wallet-panel__actions">
        {/* Gated on `linked`, not on `isConnected`. Offering "Connect wallet" to
            someone who has already linked one is the bug this replaces: their
            WalletConnect session is gone after the relaunch, but their wallet is
            still linked, and the screen should say so. */}
        {stage === "choose" && <ConnectActions working={working} launch={launch} />}

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

      {/* Only while pairing, and only where a link is useful — a phone has the
          wallet on the same device. */}
      {stage === "choose" && telegramSurface() === "desktop" && <DesktopRoutes />}

      {/* Shown on mobile as well as web, and it is not redundant there.
          The curated list is short by design, so a player whose wallet is not
          on it would otherwise have no route at all — they cannot scan a code
          on the screen they are holding. Copying the pairing link and pasting
          it into their own wallet is the one path that always exists.

          `PairingLink` renders nothing until a URI has actually been emitted,
          so this stays invisible until the user has started a connection and
          the escape hatch is genuinely available. */}
      {stage === "choose" && telegramSurface() !== "desktop" && <PairingLink />}

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
