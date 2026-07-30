"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { PlayerCard } from "@/components/PlayerCard";
import { Screen } from "@/components/Screen";
import { adminListGames } from "@/lib/api";
import { tap } from "@/lib/telegram";
import { useAuth } from "@/lib/auth";

/**
 * Whether to offer the catalogue link, decided by asking the server.
 *
 * There is no admin flag on the client to read, and adding one would be a
 * claim the browser makes about itself. Calling the admin endpoint and seeing
 * whether it answers is the same check the endpoint performs anyway — the link
 * is a convenience, and every admin route re-checks server-side regardless.
 */
function useIsAdmin(): boolean {
  const { status } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (status !== "ready") return;
    let alive = true;
    adminListGames()
      .then(() => alive && setIsAdmin(true))
      .catch(() => alive && setIsAdmin(false));
    return () => {
      alive = false;
    };
  }, [status]);

  return isAdmin;
}

export default function Home() {
  const isAdmin = useIsAdmin();

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

            {isAdmin && (
              <Link className="tile" href="/admin" onClick={() => tap()}>
                <span className="tile__body">
                  <span className="heading">Catalogue</span>
                  <p className="body">
                    Add and edit games. Changes are live immediately.
                  </p>
                </span>
                <span className="tile__chevron" aria-hidden>
                  →
                </span>
              </Link>
            )}
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
