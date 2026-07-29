"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { Screen } from "@/components/Screen";
import { getGames, type Game } from "@/lib/api";
import { tap } from "@/lib/telegram";
import { useAuth } from "@/lib/auth";

export default function GamesPage() {
  const router = useRouter();
  const { status } = useAuth();
  const [games, setGames] = useState<Game[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== "ready") return;
    getGames()
      .then(setGames)
      .catch(() => setError("Could not load the catalogue."));
  }, [status]);

  return (
    <Screen onBack={() => router.push("/")}>
      {() => (
        <>
          <span className="eyebrow">Section 02</span>
          <h1 className="display" style={{ margin: "8px 0 10px" }}>
            Games
          </h1>
          <p className="body" style={{ marginBottom: 24 }}>
            Your wallet is connected to every one of these. You will not be
            asked to connect again.
          </p>

          {error && <p className="body">{error}</p>}

          {!games && !error && (
            <div className="stack">
              <div className="skeleton" style={{ height: 86 }} />
              <div className="skeleton" style={{ height: 86 }} />
              <div className="skeleton" style={{ height: 86 }} />
            </div>
          )}

          {games && (
            <div className="stack">
              {games.map((game) => (
                <button
                  key={game.slug}
                  className="tile"
                  disabled={game.status !== "live"}
                  onClick={() => {
                    tap("medium");
                    // Launch target for the next slice: this pushes to an
                    // iframe host that holds the wallet and brokers signing.
                    router.push(`/play/${game.slug}`);
                  }}
                >
                  <span
                    className="tile__pip"
                    style={{ background: game.accent }}
                    aria-hidden
                  />
                  <span className="tile__body">
                    <span className="heading">{game.title}</span>
                    <p className="body">{game.tagline}</p>
                  </span>
                  {game.status === "live" ? (
                    <span className="tile__chevron" aria-hidden>
                      →
                    </span>
                  ) : (
                    <span className="badge">Soon</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Screen>
  );
}
