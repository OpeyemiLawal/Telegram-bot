import { NextResponse, type NextRequest } from "next/server";

/**
 * Builds the Content-Security-Policy per request.
 *
 * It used to live in next.config.mjs, assembled at build time from
 * NEXT_PUBLIC_GAME_ORIGINS. That worked and did not scale: `frame-src` has to
 * name every origin allowed to be framed, so adding one game meant editing an
 * environment variable and rebuilding the frontend. At two hundred games that is
 * two hundred rebuilds, and each one is a chance to ship the wrong thing while
 * doing something that ought to be a form submission.
 *
 * Here the origins are fetched from the API, which reads them from the database
 * the admin screen writes to. Adding a game becomes a row.
 *
 * Everything else in the policy stays static, because everything else is a
 * property of this application rather than of its catalogue.
 */

const ORIGINS_TTL_MS = 60_000;

/**
 * Module-scope cache, deliberately.
 *
 * Middleware runs on every request, and a fetch on every request would put a
 * network round trip — to a service that sleeps when idle — in front of the
 * first byte of every page. The instance is reused between invocations, so this
 * costs one request a minute rather than one per page.
 *
 * The consequence, stated plainly: a newly added game is playable up to a minute
 * later. That is the price of not rebuilding, and it is the right trade.
 */
let cached: { origins: string[]; at: number } | null = null;
let inflight: Promise<string[]> | null = null;

async function gameOrigins(apiUrl: string): Promise<string[]> {
  const now = Date.now();

  if (cached && now - cached.at < ORIGINS_TTL_MS) return cached.origins;

  // Deduplicated: a burst of requests on a cold instance would otherwise each
  // start their own fetch.
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const response = await fetch(`${apiUrl}/api/public/game-origins`, {
        // Next's own fetch cache is bypassed on purpose. The TTL above is the
        // one we reason about; two caching layers with different lifetimes make
        // "why is this game not appearing" unanswerable.
        cache: "no-store",
        signal: AbortSignal.timeout(2500),
      });

      if (!response.ok) throw new Error(String(response.status));

      const body = (await response.json()) as { origins?: unknown };
      const origins = Array.isArray(body.origins)
        ? body.origins.filter((o): o is string => typeof o === "string")
        : [];

      cached = { origins, at: Date.now() };
      return origins;
    } catch {
      /**
       * Serve the last known good list, however old, and only fall back to an
       * empty one if we have never had a list at all.
       *
       * The failure being avoided: the API is briefly unreachable, the policy is
       * rebuilt without any game origins, and every game in the platform stops
       * loading — for a reason the browser reports as a blank frame. A stale
       * allowlist is a far smaller problem than an empty one.
       */
      return cached?.origins ?? [];
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

function policy(apiUrl: string, frameOrigins: string[]): string {
  const isDev = process.env.NODE_ENV === "development";

  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${isDev ? "'unsafe-eval' " : ""}https://telegram.org`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    // Without an explicit worker-src this falls back to default-src ('self'),
    // which blocks the blob: worker WalletConnect uses for its relay socket —
    // quietly and totally, producing no pairing URI and therefore no QR.
    "worker-src 'self' blob:",
    [
      "connect-src 'self'",
      isDev ? "ws: wss:" : "",
      apiUrl,
      "https://api.web3modal.org",
      "https://walletconnect.com https://*.walletconnect.com wss://*.walletconnect.com",
      "https://walletconnect.org https://*.walletconnect.org wss://*.walletconnect.org",
      "https://reown.com https://*.reown.com wss://*.reown.com",
    ]
      .filter(Boolean)
      .join(" "),
    ["frame-src 'self'", "https://*.walletconnect.com https://*.reown.com", ...frameOrigins]
      .filter(Boolean)
      .join(" "),
    "frame-ancestors https://web.telegram.org https://telegram.org",
  ].join("; ");
}

export async function middleware(request: NextRequest) {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";
  const origins = apiUrl ? await gameOrigins(apiUrl) : [];

  const response = NextResponse.next();
  response.headers.set("Content-Security-Policy", policy(apiUrl, origins));
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export const config = {
  /**
   * Static assets are excluded: they carry no markup, cannot frame anything, and
   * running middleware on each would mean an origins lookup per file a page
   * loads.
   *
   * `/sdk/` especially. That path serves the bridge SDK to every game on the
   * platform, cross-origin, on every page load of every game — the single most
   * requested file here. A security policy on a JavaScript response restricts
   * nothing, so the only thing middleware would add is latency, multiplied by
   * two hundred games.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|sdk/).*)"],
};
