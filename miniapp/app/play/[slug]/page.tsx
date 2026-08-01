"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { Screen } from "@/components/Screen";
import { getGame, type Game } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { attachGameBridge } from "@/lib/game-bridge";
import { enterFullscreen, tap, webApp } from "@/lib/telegram";

/**
 * Hosts one game, full-bleed, and connects it to the shell.
 *
 * Still an iframe, and that is not a compromise on the fullscreen goal — it is
 * what makes the goal reachable. Navigating to the game's own URL would leave
 * the Mini App: no shell, no wallet, no bridge, and no way back into Telegram.
 * The frame is how a game can occupy the whole screen while the session and the
 * wallet stay on this side of it.
 *
 * So "fullscreen" here is a layout problem. The frame is taken out of the page
 * flow and pinned to the viewport, the shell's own chrome is not rendered on
 * this route, and Telegram is asked to drop its header where the client
 * supports it.
 */
export default function PlayPage() {
  const router = useRouter();
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;

  const [game, setGame] = useState<Game | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exit = useCallback(() => {
    tap();
    const app = webApp();
    if (app) {
      app.close();
      return;
    }
    router.push("/");
  }, [router]);

  useEffect(() => {
    if (!slug) return;
    let alive = true;

    getGame(slug)
      .then((found) => {
        if (!alive) return;
        if (found.status !== "live") {
          setError("This game is not playable yet.");
          return;
        }
        setGame(found);
      })
      .catch(() => alive && setError("Could not load this game."));

    return () => {
      alive = false;
    };
  }, [slug]);

  // Requested once for the whole visit rather than when the frame mounts, so
  // the transition happens during loading instead of jolting the layout the
  // moment the game appears.
  useEffect(() => enterFullscreen(), []);

  const { status } = useAuth();

  // Dropping `Screen` for the game also drops the gate it provides, so the gate
  // is re-applied explicitly. `Screen` renders the boot, outside-Telegram and
  // failed-sign-in states; deferring to it here keeps one implementation of each
  // rather than a second set that drifts.
  if (error || status !== "ready") {
    return (
      <Screen onBack={exit}>
        {() =>
          error ? (
            <div className="state">
              <h1 className="heading">{error}</h1>
              <button className="button" onClick={exit}>
                Back to bot
              </button>
            </div>
          ) : (
            <div className="skeleton" style={{ height: 320 }} />
          )
        }
      </Screen>
    );
  }

  // Deliberately outside `Screen`. Screen paints the masthead and page padding,
  // which is exactly the chrome a game should not be framed by.
  return <Stage game={game} onExit={exit} />;
}

function Stage({ game, onExit }: { game: Game | null; onExit: () => void }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--tg-theme-bg-color, #ffffff)",
        zIndex: 40,
        overflow: "hidden",
      }}
    >
      {game ? <GameFrame game={game} onExit={onExit} /> : <Loading />}

      {/*
        A floating control rather than a button in a bar below the game.
        Telegram's own back button is bound too, but on desktop clients it is not
        always visible, and a player who cannot find the way out of a fullscreen
        game will close the whole Mini App instead.
      */}
      <button
        onClick={onExit}
        aria-label="Leave game"
        style={{
          position: "absolute",
          top: "max(10px, env(safe-area-inset-top))",
          right: 10,
          zIndex: 2,
          width: 38,
          height: 38,
          borderRadius: 19,
          border: "1px solid var(--tg-theme-hint-color, rgba(0,0,0,0.18))",
          background: "var(--tg-theme-secondary-bg-color, rgba(255,255,255,0.86))",
          backdropFilter: "blur(6px)",
          color: "var(--tg-theme-text-color, #11181f)",
          fontSize: 18,
          lineHeight: 1,
          cursor: "pointer",
        }}
      >
        ✕
      </button>
    </div>
  );
}

function Loading() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "grid",
        placeItems: "center",
        color: "var(--tg-theme-hint-color, #707579)",
        fontSize: 14,
      }}
    >
      Loading…
    </div>
  );
}

function GameFrame({ game, onExit }: { game: Game; onExit: () => void }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(false);

  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  /**
   * Read into a ref rather than closed over by the bridge effect.
   *
   * The bridge must not be torn down and rebuilt when the player links a wallet
   * mid-game — that would drop any request in flight. The ref lets the handler
   * see current values while the listener stays attached for the game's life.
   */
  const { user } = useAuth();
  const playerRef = useRef(user);
  playerRef.current = user;

  /**
   * The game needs our origin to address its messages, and to know whose replies
   * to accept. Passed as a query parameter rather than left to
   * `document.referrer`, because this iframe sets `referrer-policy: no-referrer`.
   */
  const frameSrc = useMemo(() => {
    try {
      const url = new URL(game.embed_url);
      url.searchParams.set("sgaOrigin", window.location.origin);
      return url.toString();
    } catch {
      return game.embed_url;
    }
  }, [game.embed_url]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;

    return attachGameBridge(frame, {
      gameSlug: game.slug,
      embedUrl: game.embed_url,
      // Public facts only. There is no shape of this object that can carry a
      // token, which is the point.
      player: () => ({
        displayName: playerRef.current?.display_name ?? "player",
        walletAddress: playerRef.current?.wallet_address ?? null,
      }),
      onExit: () => exitRef.current(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.slug, game.embed_url]);

  return (
    <>
      {!loaded && <Loading />}
      <iframe
        ref={frameRef}
        src={frameSrc}
        title={game.title}
        onLoad={() => setLoaded(true)}
        /**
         * `allow-same-origin` grants the frame its *own* origin — which is what
         * gives Godot localStorage and IndexedDB — not access to ours.
         *
         * Absent deliberately: `allow-top-navigation` would let a game replace
         * the Mini App with any page, and `allow-popups` would let it open
         * windows outside Telegram. Neither has a legitimate use; a game asks the
         * shell to navigate with the `exit` message instead.
         */
        sandbox="allow-scripts allow-same-origin"
        allow=""
        referrerPolicy="no-referrer"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          border: 0,
          display: "block",
          background: "var(--tg-theme-bg-color, #ffffff)",
        }}
      />
    </>
  );
}

