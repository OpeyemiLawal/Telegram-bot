"use client";

import type { Me } from "@/lib/api";

function truncate(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * The one object a player carries between cabinets. It is deliberately the
 * only element on the page with any warmth or motion — everything else is
 * flat and quiet so this reads as the thing you own.
 */
export function PlayerCard({ user }: { user: Me }) {
  const connected = Boolean(user.wallet_address);

  return (
    <div className="card">
      <div className="card__face">
        <div className="card__label">
          <span className="eyebrow">Player</span>
          <span className="eyebrow">
            #{String(user.telegram_id).slice(-6)}
          </span>
        </div>

        <div className="card__address">
          {connected ? truncate(user.wallet_address!) : "No wallet yet"}
        </div>

        <div className="card__balances">
          <div>
            <span
              className={connected ? "card__amount" : "card__amount card__amount--idle"}
            >
              {connected ? "0.000" : "—"}
            </span>
            <span className="card__denom">SOL</span>
          </div>
          <div>
            <span
              className={connected ? "card__amount" : "card__amount card__amount--idle"}
            >
              {connected ? "0" : "—"}
            </span>
            <span className="card__denom">SGA</span>
          </div>
        </div>
      </div>
    </div>
  );
}
