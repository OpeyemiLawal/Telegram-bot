"use client";

import { useEffect, type ReactNode } from "react";

import { useAuth } from "@/lib/auth";
import { primeViewport, bindBackButton } from "@/lib/telegram";
import type { Me } from "@/lib/api";

export function Masthead() {
  return (
    <header className="masthead">
      <div className="masthead__mark">
        Solana<span>·</span>Games
      </div>
      <span className="masthead__caption">Mini App</span>
    </header>
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
        <div className="skeleton" style={{ height: 168 }} />
        <div className="stack">
          <div className="skeleton" style={{ height: 74 }} />
          <div className="skeleton" style={{ height: 74 }} />
        </div>
      </main>
    );
  }

  if (status === "outside") {
    return (
      <main className="app-shell">
        <Masthead />
        <div className="state">
          <h1 className="heading">Open this from Telegram</h1>
          <p className="body">
            This app verifies who you are using the launch signature Telegram
            provides. In a plain browser tab there is nothing to verify.
          </p>
          <a className="button" href="https://t.me">
            Go to the bot
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
