"use client";

import Link from "next/link";

import { PlayerCard } from "@/components/PlayerCard";
import { Screen } from "@/components/Screen";
import { tap } from "@/lib/telegram";

export default function Home() {
  return (
    <Screen>
      {(user) => (
        <>
          <PlayerCard user={user} />

          <nav className="stack">
            <Link className="tile" href="/wallet" onClick={() => tap()}>
              <span className="tile__body">
                <span className="heading">Wallet</span>
                <p className="body">
                  {user.wallet_address
                    ? "View balances and manage your linked wallet."
                    : "Connect the wallet shared by every game."}
                </p>
              </span>
              <span className="tile__chevron" aria-hidden>
                ›
              </span>
            </Link>
          </nav>

          <div className="notice">
            <p className="body">
              Open games directly from the Telegram bot. Your linked wallet is
              available to every game, while every approval stays in your own
              wallet.
            </p>
          </div>
        </>
      )}
    </Screen>
  );
}
