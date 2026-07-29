"use client";

import { useEffect, type ReactNode } from "react";

import { useAuth } from "@/lib/auth";
import { primeViewport, bindBackButton } from "@/lib/telegram";
import type { Me } from "@/lib/api";

export function Masthead() {
  return (
    <header className="masthead">
      <div className="masthead__mark">
        SOLANA<span>·</span>GAMES
      </div>
      <span className="eyebrow">Telegram</span>
    </header>
  );
}

/**
 * Gates every route behind a verified session and paints the three states
 * that are not "it worked". Each one says what happened and what to do —
 * no spinners without explanation, no apologies.
 */
export function Screen({
  onBack,
  children,
}: {
  onBack?: () => void;
  children: (user: Me) => ReactNode;
}) {
  const { status, user, error, retry } = useAuth();

  useEffect(() => {
    primeViewport("#0b1620", "#0b1620");
  }, []);

  useEffect(() => {
    if (!onBack) return;
    return bindBackButton(onBack);
  }, [onBack]);

  if (status === "booting") {
    return (
      <>
        <Masthead />
        <div className="skeleton" style={{ height: 168 }} />
        <div className="stack">
          <div className="skeleton" style={{ height: 74 }} />
          <div className="skeleton" style={{ height: 74 }} />
        </div>
      </>
    );
  }

  if (status === "outside") {
    return (
      <>
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
      </>
    );
  }

  if (status === "failed" || !user) {
    return (
      <>
        <Masthead />
        <div className="state">
          <h1 className="heading">Sign-in did not complete</h1>
          <p className="body">{error ?? "The server did not respond."}</p>
          <button className="button" onClick={retry}>
            Try again
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <Masthead />
      {children(user)}
    </>
  );
}
