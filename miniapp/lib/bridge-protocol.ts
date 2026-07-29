/**
 * The contract between the shell and a game running in an iframe.
 *
 * Kept in its own module, with no DOM access and no imports, for one reason:
 * everything here is a decision about whether to trust a message, and that is
 * the kind of logic that has to be unit-testable without a browser. The shell
 * imports it; so does the SDK the games load.
 *
 * Design rules, and why each one is a rule rather than a preference:
 *
 *   Versioned. A game deployed today keeps running when the shell changes. The
 *   shell holds the wallet, so it will be updated more often than the games —
 *   an unversioned protocol makes every shell release a coordinated deploy.
 *
 *   Request/response with ids. Godot calls into JS and needs to know which
 *   answer belongs to which question. Without correlation the SDK has to assume
 *   messages arrive in order, which postMessage does not promise.
 *
 *   Explicit allowlist of request types. Not a generic RPC. A game can ask for
 *   the handful of things below and nothing else, so adding capability is a
 *   deliberate act rather than a side effect of the shell gaining a function.
 *
 *   No secrets in any response. The player's access token, refresh token and
 *   initData never cross this boundary. A game receives the public address and
 *   a display name — facts already visible on-chain and on screen.
 */

export const PROTOCOL_VERSION = 1;

/** Everything a game is permitted to ask for. */
export type RequestType =
  /** First message. Establishes the channel and returns platform info. */
  | "handshake"
  /** Public identity: display name and linked wallet address. */
  | "getPlayer"
  /** Fire Telegram's haptic feedback. Cosmetic. */
  | "haptic"
  /** Ask the shell to navigate back out of the game. */
  | "exit";

const REQUEST_TYPES: readonly RequestType[] = [
  "handshake",
  "getPlayer",
  "haptic",
  "exit",
];

export interface BridgeRequest {
  sga: typeof PROTOCOL_VERSION;
  id: string;
  type: RequestType;
  payload?: unknown;
}

export interface BridgeResponse {
  sga: typeof PROTOCOL_VERSION;
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** Public identity. Deliberately the whole of what a game learns about a player. */
export interface PlayerInfo {
  displayName: string;
  walletAddress: string | null;
}

export interface HandshakeInfo {
  version: number;
  gameSlug: string;
  /** So a game can adapt its controls without sniffing the user agent. */
  surface: "mobile" | "desktop" | "web";
}

/**
 * Narrow an untrusted `MessageEvent.data` to a request, or return null.
 *
 * Returns null rather than throwing. This runs on every message the window
 * receives, including ones from browser extensions, React devtools and any
 * other frame on the page — none of which are errors, and all of which would
 * fill the console with noise if treated as one.
 */
export function parseRequest(data: unknown): BridgeRequest | null {
  if (typeof data !== "object" || data === null) return null;

  const candidate = data as Record<string, unknown>;

  if (candidate.sga !== PROTOCOL_VERSION) return null;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return null;
  if (candidate.id.length > 64) return null;
  if (typeof candidate.type !== "string") return null;
  if (!REQUEST_TYPES.includes(candidate.type as RequestType)) return null;

  return {
    sga: PROTOCOL_VERSION,
    id: candidate.id,
    type: candidate.type as RequestType,
    payload: candidate.payload,
  };
}

/** Narrow an untrusted message to a response. Used by the SDK inside a game. */
export function parseResponse(data: unknown): BridgeResponse | null {
  if (typeof data !== "object" || data === null) return null;

  const candidate = data as Record<string, unknown>;

  if (candidate.sga !== PROTOCOL_VERSION) return null;
  if (typeof candidate.id !== "string" || candidate.id.length === 0) return null;
  if (typeof candidate.ok !== "boolean") return null;

  return {
    sga: PROTOCOL_VERSION,
    id: candidate.id,
    ok: candidate.ok,
    data: candidate.data,
    error: typeof candidate.error === "string" ? candidate.error : undefined,
  };
}

export function ok(id: string, data?: unknown): BridgeResponse {
  return { sga: PROTOCOL_VERSION, id, ok: true, data };
}

export function fail(id: string, error: string): BridgeResponse {
  return { sga: PROTOCOL_VERSION, id, ok: false, error };
}

/**
 * The origin a game's messages must come from, derived from its embed URL.
 *
 * An origin is scheme + host + port and nothing else. Comparing full URLs would
 * be both too strict — a game navigating to `/level2` changes the URL but not
 * the origin — and misleading, since the browser only guarantees the origin.
 *
 * Returns null for an unparseable URL so a malformed catalogue entry fails
 * closed: no origin means no message is ever accepted from that game.
 */
export function originOf(embedUrl: string): string | null {
  try {
    return new URL(embedUrl).origin;
  } catch {
    return null;
  }
}
