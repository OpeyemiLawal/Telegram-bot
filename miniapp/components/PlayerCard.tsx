"use client";

import { useCallback, useEffect, useState } from "react";

import { getWalletBalance, type Me, type WalletBalance } from "@/lib/api";

function truncate(address: string): string {
  return address.slice(0, 6) + "..." + address.slice(-6);
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
  const symbol = "SGA";
  const name = user.display_name || "Player";

  return (
    <section className="card" aria-label="Player wallet">
      <div className="card__face">
        <div className="card__topline">
          <div className="card__identity">
            <span className="card__avatar" aria-hidden={!user.photo_url}>
              {user.photo_url ? (
                <img src={user.photo_url} alt="" />
              ) : (
                name.slice(0, 1).toUpperCase()
              )}
            </span>
            <span style={{ minWidth: 0 }}>
              <strong className="card__name">{name}</strong>
              <span
                className={
                  connected
                    ? "card__status card__status--connected"
                    : "card__status"
                }
              >
                <span className="card__status-dot" aria-hidden />
                {connected ? "Wallet connected" : "Wallet not connected"}
              </span>
            </span>
          </div>
          <span className="card__network">SOLANA</span>
        </div>

        <div className="card__address">
          <span className="card__address-label">Address</span>
          <span className="card__address-value">
            {connected
              ? truncate(user.wallet_address!)
              : "Not connected"}
          </span>
        </div>

        <div className="card__balances">
          <div className="card__balance">
            <span className="card__balance-label">
              <span className="card__balance-dot" aria-hidden />
              Solana
            </span>
            <span
              className={
                connected && !solFailed
                  ? "card__amount"
                  : "card__amount card__amount--idle"
              }
            >
              {sol}
            </span>
            <span className="card__denom">SOL</span>
          </div>

          <div className="card__balance">
            <span className="card__balance-label">
              <span
                className="card__balance-dot card__balance-dot--reward"
                aria-hidden
              />
              SGA Token
            </span>
            <span
              className={
                connected && !tokenFailed
                  ? "card__amount"
                  : "card__amount card__amount--idle"
              }
            >
              {token}
            </span>
            <span className="card__denom">{symbol}</span>
          </div>
        </div>

        {tokenFailed && balance?.token_error && (
          <p className="wallet-panel__error">{balance.token_error}</p>
        )}

        {connected && (solFailed || tokenFailed) && (
          <button
            className="button button--quiet"
            style={{ width: "100%", marginTop: 12 }}
            onClick={() => void load()}
          >
            Retry balances
          </button>
        )}
      </div>
    </section>
  );
}
