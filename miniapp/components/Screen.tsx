"use client";

import { useEffect, type ReactNode } from "react";

import { useAuth } from "@/lib/auth";
import { primeViewport, bindBackButton } from "@/lib/telegram";
import type { Me } from "@/lib/api";

export function Masthead() {
  return (
    <header className="masthead">
      <div className="masthead__brand">
        <span className="masthead__logo" aria-hidden>
          SG
        </span>
        <span className="masthead__copy">
          <strong className="masthead__mark">solanagames.app</strong>
          <span className="masthead__caption">SGA/SOL Wallet & Rewards</span>
        </span>
      </div>
      <span className="masthead__status">Secure</span>
    </header>
  );
}

function StateIcon({ children }: { children: ReactNode }) {
  return (
    <span className="state__icon" aria-hidden>
      {children}
    </span>
  );
}

export function Screen({
  onBack,
  children,
}: {
  onBack?: () => void;
  children: (user: Me) => ReactNode;
}) {
  const { status, user, error, retry } = useAuth();

  useEffect(() => {
    primeViewport();
  }, []);

  useEffect(() => {
    if (!onBack) return;
    return bindBackButton(onBack);
  }, [onBack]);

  if (status === "booting") {
    return (
      <main className="app-shell">
        <Masthead />
        <div className="skeleton" style={{ height: 194 }} />
        <div className="stack">
          <div className="skeleton" style={{ height: 76 }} />
          <div className="skeleton" style={{ height: 76 }} />
        </div>
      </main>
    );
  }

  if (status === "outside") {
    return (
      <main className="app-shell">
        <Masthead />
        <div className="state">
          <StateIcon>↗</StateIcon>
          <h1 className="heading">Open this from Telegram</h1>
          <p className="body">
            Launch the Mini App from the bot so Telegram can securely verify
            your account.
          </p>
          <a className="button" href="https://t.me">
            Open Telegram
          </a>
        </div>
      </main>
    );
  }

  if (status === "failed" || !user) {
    return (
      <main className="app-shell">
        <Masthead />
        <div className="state">
          <StateIcon>!</StateIcon>
          <h1 className="heading">Sign-in did not complete</h1>
          <p className="body">{error ?? "The server did not respond."}</p>
          <button className="button" onClick={retry}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <Masthead />
      {children(user)}
    </main>
  );
}
