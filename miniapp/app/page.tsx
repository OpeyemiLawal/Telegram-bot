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
                    ? "Balances, deposits, and withdrawals."
                    : "Set up the wallet you will use everywhere here."}
                </p>
              </span>
              <span className="tile__chevron" aria-hidden>
                →
              </span>
            </Link>

            <Link className="tile" href="/games" onClick={() => tap()}>
              <span className="tile__body">
                <span className="heading">Games</span>
                <p className="body">
                  Everything playable. Your wallet is already connected to all
                  of them.
                </p>
              </span>
              <span className="tile__chevron" aria-hidden>
                →
              </span>
            </Link>
          </nav>

          <div className="notice">
            <p className="body">
              Signing happens here, inside the app. The chat with the bot is
              not encrypted end to end — nothing that touches your keys will
              ever be asked for there.
            </p>
          </div>
        </>
      )}
    </Screen>
  );
}
