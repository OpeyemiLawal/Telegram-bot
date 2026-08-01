"use client";

import Link from "next/link";

import { PlayerCard } from "@/components/PlayerCard";
import { Screen } from "@/components/Screen";
import { tap } from "@/lib/telegram";

function WalletIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4.5 6.75A2.25 2.25 0 0 1 6.75 4.5h10.5a2.25 2.25 0 0 1 2.25 2.25v10.5a2.25 2.25 0 0 1-2.25 2.25H6.75a2.25 2.25 0 0 1-2.25-2.25V6.75Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M4.5 8.25h12.75A2.25 2.25 0 0 1 19.5 10.5v4.25h-4.25A2.25 2.25 0 0 1 13 12.5v0a2.25 2.25 0 0 1 2.25-2.25h4.25"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="15.75" cy="12.5" r=".8" fill="currentColor" />
    </svg>
  );
}

export default function Home() {
  return (
    <Screen>
      {(user) => (
        <>
          <header className="page-header page-header--home">
            <span className="eyebrow">Solana Games</span>
            <h1 className="display">Your gaming wallet</h1>
            <p className="body">
              One secure wallet connection for every game and reward.
            </p>
          </header>

          <PlayerCard user={user} />

          <p className="section-label">Account</p>
          <nav className="stack" style={{ marginTop: 0 }}>
            <Link className="tile" href="/wallet" onClick={() => tap()}>
              <span className="tile__icon">
                <WalletIcon />
              </span>
              <span className="tile__body">
                <span className="heading">Wallet and rewards</span>
                <p className="body">
                  {user.wallet_address
                    ? "View balances, rewards, and your linked wallet."
                    : "Connect the wallet shared by every game."}
                </p>
              </span>
              <span className="tile__chevron" aria-hidden>
                ›
              </span>
            </Link>
          </nav>

          <div className="notice">
            <span className="notice__icon" aria-hidden>
              ✓
            </span>
            <span className="notice__body">
              <strong className="heading">You stay in control</strong>
              <p className="body">
                We store only your public address. Every transaction is sent
                directly to your linked wallet.
              </p>
            </span>
          </div>
        </>
      )}
    </Screen>
  );
}
