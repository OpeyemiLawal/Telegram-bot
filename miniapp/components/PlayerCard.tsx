"use client";

import { useCallback, useEffect, useState } from "react";

import { getWalletBalance, type Me, type WalletBalance } from "@/lib/api";

function truncate(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * The one object a player carries between cabinets. It is deliberately the
 * only element on the page with any warmth or motion — everything else is
 * flat and quiet so this reads as the thing you own.
 *
 * The balances are read from the chain, not from a database. Both figures are
 * formatted server-side: nine decimal places is exactly the kind of thing two
 * clients round differently, and the card, a game and the bot must never
 * disagree about how much someone has.
 */
export function PlayerCard({ user }: { user: Me }) {
  const connected = Boolean(user.wallet_address);
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!connected) return;
    setFailed(false);
    try {
      setBalance(await getWalletBalance());
    } catch {
      // The RPC was unreachable. Shown as a dash rather than a zero — zero is a
      // real balance and a believable one, and telling a player their wallet is
      // empty when the truth is "we could not ask" is the worse failure by a
      // distance.
      setFailed(true);
    }
  }, [connected]);

  useEffect(() => {
    void load();
  }, [load]);

  // Three states per figure, and each has to look different: no wallet, could
  // not read, and a number. A single placeholder for the first two would make an
  // outage indistinguishable from an empty account.
  const sol = !connected ? "—" : failed ? "—" : (balance?.sol_display ?? "…");
  const token = !connected ? "—" : failed ? "—" : (balance?.token_display ?? "…");
  const symbol = balance?.token_symbol ?? "$Gamer";

  return (
    <div className="card">
      <div className="card__face">
        <div className="card__label">
          <span className="eyebrow">Player</span>
          <span className="eyebrow">#{String(user.telegram_id).slice(-6)}</span>
        </div>

        <div className="card__address">
          {connected ? truncate(user.wallet_address!) : "No wallet yet"}
        </div>

        <div className="card__balances">
          <div>
            <span
              className={
                connected && !failed
                  ? "card__amount"
                  : "card__amount card__amount--idle"
              }
              // Tabular figures so the numbers do not jitter sideways as they
              // refresh — a balance that shifts position reads as unstable.
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {sol}
            </span>
            <span className="card__denom">SOL</span>
          </div>
          <div>
            <span
              className={
                connected && !failed
                  ? "card__amount"
                  : "card__amount card__amount--idle"
              }
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {token}
            </span>
            <span className="card__denom">{symbol}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
