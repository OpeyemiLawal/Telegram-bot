"use client";

import { useCallback, useEffect, useState } from "react";

import { getWalletBalance, type Me, type WalletBalance } from "@/lib/api";

function truncate(address: string): string {
  return address.slice(0, 4) + "…" + address.slice(-4);
}

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
      setFailed(true);
    }
  }, [connected]);

  useEffect(() => {
    void load();
  }, [load]);

  const solFailed = failed || balance?.sol_available === false;
  const tokenFailed = failed || balance?.token_available === false;
  const sol = !connected ? "—" : solFailed ? "—" : (balance?.sol_display ?? "…");
  const token = !connected ? "—" : tokenFailed ? "—" : (balance?.token_display ?? "…");
  const symbol = balance?.token_symbol ?? "$Gamer";
  const name = user.display_name || "Player";

  return (
    <section className="card" aria-label="Player wallet">
      <div className="card__face">
        <div className="card__identity">
          <span className="card__avatar" aria-hidden>
            {name.slice(0, 1).toUpperCase()}
          </span>
          <span>
            <strong className="card__name">{name}</strong>
            <span className="card__status">
              {connected ? "Wallet connected" : "Wallet not connected"}
            </span>
          </span>
        </div>

        <div className="card__address">
          {connected ? truncate(user.wallet_address!) : "Connect a wallet to view balances"}
        </div>

        <div className="card__balances">
          <div>
            <span className={connected && !solFailed ? "card__amount" : "card__amount card__amount--idle"}>
              {sol}
            </span>
            <span className="card__denom">SOL</span>
          </div>
          <div>
            <span className={connected && !tokenFailed ? "card__amount" : "card__amount card__amount--idle"}>
              {token}
            </span>
            <span className="card__denom">{symbol}</span>
          </div>
        </div>

        {tokenFailed && balance?.token_error && (
          <p className="body" style={{ marginTop: 10 }}>
            {balance.token_error}
          </p>
        )}

        {connected && (solFailed || tokenFailed) && (
          <button
            className="button button--quiet"
            style={{ marginTop: 12 }}
            onClick={() => void load()}
          >
            Retry balances
          </button>
        )}
      </div>
    </section>
  );
}
