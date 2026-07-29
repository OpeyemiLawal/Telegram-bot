"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { Screen } from "@/components/Screen";
import { getGame, type Game, type Me } from "@/lib/api";
import { attachGameBridge } from "@/lib/game-bridge";
import { tap } from "@/lib/telegram";

/**
 * Hosts one game in an iframe and connects it to the shell.
 *
 * The shape of this page is the security model. The game occupies a frame on its
 * own origin; the wallet, the session and the API client stay out here. Anything
 * the game needs, it asks for over `postMessage`, and the bridge answers only
 * from a fixed list.
 */
export default function PlayPage() {
  const router = useRouter();
  const params = useParams<{ slug: string }>();
  const slug = params?.slug;

  const [game, setGame] = useState<Game | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const exit = useCallback(() => {
    tap();
    router.push("/games");
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

  return (
    <Screen onBack={exit}>
      {(user) => {
        if (error) {
          return (
            <div className="state">
              <h1 className="heading">{error}</h1>
              <button className="button" onClick={exit}>
                Back to games
              </button>
            </div>
          );
        }

        if (!game) {
          return <div className="skeleton" style={{ height: 420 }} />;
        }

        return (
          <GameFrame
            game={game}
            user={user}
            frameRef={frameRef}
            loaded={loaded}
            onLoaded={() => setLoaded(true)}
            onExit={exit}
          />
        );
      }}
    </Screen>
  );
}

function GameFrame({
  game,
  user,
  frameRef,
  loaded,
  onLoaded,
  onExit,
}: {
  game: Game;
  user: Me;
  frameRef: React.MutableRefObject<HTMLIFrameElement | null>;
  loaded: boolean;
  onLoaded: () => void;
  onExit: () => void;
}) {
  /**
   * Held in a ref so the bridge reads current values without being torn down and
   * rebuilt. Re-attaching the listener whenever the player's wallet changes
   * would drop any request in flight at that moment.
   */
  const playerRef = useRef({ user, onExit });
  playerRef.current = { user, onExit };

  /**
   * The game needs our origin to address its messages, and to know which origin
   * to accept answers from. Passed as a query parameter rather than left to
   * `document.referrer`, because this iframe sets `referrer-policy: no-referrer`
   * — the referrer fallback in the SDK exists for local development and is
   * deliberately unavailable here.
   *
   * A query parameter is safe to hand over: the game's own origin is already
   * public, and so is ours.
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
      player: () => ({
        displayName: playerRef.current.user.display_name,
        walletAddress: playerRef.current.user.wallet_address,
      }),
      onExit: () => playerRef.current.onExit(),
    });
  }, [game.slug, game.embed_url, frameRef]);

  return (
    <div style={{ position: "relative" }}>
      {!loaded && (
        <div
          className="skeleton"
          style={{ position: "absolute", inset: 0, borderRadius: 12 }}
          aria-hidden
        />
      )}

      <iframe
        ref={frameRef}
        src={frameSrc}
        title={game.title}
        onLoad={onLoaded}
        /**
         * Scripts and same-origin only.
         *
         * `allow-same-origin` sounds alarming and is not: it grants the frame its
         * *own* origin, which is what gives the game localStorage and IndexedDB —
         * Godot's HTML export needs both. It does not grant access to ours.
         *
         * Absent, and deliberately: `allow-top-navigation` would let a game
         * replace the Mini App with any page it liked, and `allow-popups` would
         * let it open windows outside Telegram. A game has no legitimate need for
         * either; it asks the shell to navigate via the `exit` message instead.
         */
        sandbox="allow-scripts allow-same-origin"
        /**
         * No camera, microphone, geolocation or payment APIs. Permissions
         * delegate to a frame by default, so an empty allow list is what actually
         * withholds them.
         */
        allow=""
        referrerPolicy="no-referrer"
        style={{
          width: "100%",
          aspectRatio: "9 / 16",
          maxHeight: "72vh",
          border: 0,
          borderRadius: 12,
          display: "block",
          background: "#0b1620",
        }}
      />

      <div className="wallet-panel__actions" style={{ marginTop: 12 }}>
        <button className="button button--quiet" onClick={onExit}>
          Leave game
        </button>
      </div>

      <div className="notice" style={{ marginTop: 12 }}>
        <p className="body">
          {user.wallet_address
            ? "This game can see your public wallet address. It cannot move funds — every transaction is approved by you, in your wallet."
            : "You have not linked a wallet yet. This game runs without one."}
        </p>
      </div>
    </div>
  );
}
