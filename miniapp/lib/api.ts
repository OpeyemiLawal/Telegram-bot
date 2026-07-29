/**
 * API client and token custody.
 *
 * Access token  — module-scoped variable. Never written to storage. Dies with
 *                 the page, which is what we want.
 * Refresh token — sessionStorage. It has to survive a reload (Telegram hands
 *                 back the same `initData` on reload, and the server burns
 *                 each initData hash once, so we cannot simply log in again).
 *                 sessionStorage is cleared when the WebView closes and never
 *                 hits disk long-term.
 *
 * Neither goes in localStorage or a cookie.
 */

import { getInitData } from "./telegram";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "";
const REFRESH_KEY = "sga.rt";

let accessToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface Me {
  id: string;
  telegram_id: number;
  display_name: string;
  username: string | null;
  photo_url: string | null;
  wallet_address: string | null;
}

interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: Me;
}

function storeRefresh(token: string | null) {
  try {
    if (token === null) sessionStorage.removeItem(REFRESH_KEY);
    else sessionStorage.setItem(REFRESH_KEY, token);
  } catch {
    // Private mode or a locked-down WebView. Session simply won't survive
    // a reload; the user reopens the app. Not fatal.
  }
}

function readRefresh(): string | null {
  try {
    return sessionStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

function adopt(pair: TokenPair): Me {
  accessToken = pair.access_token;
  storeRefresh(pair.refresh_token);
  return pair.user;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new ApiError(await readError(res), res.status);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return typeof data?.detail === "string" ? data.detail : "Something went wrong.";
  } catch {
    return "Something went wrong.";
  }
}

/** Exchange the signed Telegram launch payload for a session. */
export async function signIn(): Promise<Me> {
  const initData = getInitData();
  if (!initData) {
    throw new ApiError("Open this from the Telegram bot.", 400);
  }
  const pair = await post<TokenPair>("/auth/telegram", { init_data: initData });
  return adopt(pair);
}

/** Trade the refresh token for a new pair. Deduped across concurrent callers. */
async function refresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const token = readRefresh();
    if (!token) return false;
    try {
      const pair = await post<TokenPair>("/auth/refresh", { refresh_token: token });
      adopt(pair);
      return true;
    } catch {
      accessToken = null;
      storeRefresh(null);
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/** Restore a session after a page reload, without re-using initData. */
export async function resume(): Promise<Me | null> {
  if (!readRefresh()) return null;
  if (!(await refresh())) return null;
  return request<Me>("/auth/me");
}

export async function request<T>(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
  });

  if (res.status === 401 && retry) {
    if (await refresh()) return request<T>(path, init, false);
  }

  if (!res.ok) throw new ApiError(await readError(res), res.status);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export async function signOut(): Promise<void> {
  const token = readRefresh();
  accessToken = null;
  storeRefresh(null);
  if (token) {
    await post("/auth/logout", { refresh_token: token }).catch(() => {});
  }
}

export interface Game {
  slug: string;
  title: string;
  tagline: string;
  embed_url: string;
  accent: string;
  status: "live" | "soon";
}

export const getGames = () => request<Game[]>("/games");

/**
 * Fetched from the API rather than taken from the URL.
 *
 * The slug arrives from the address bar, so the embed URL must not. Trusting a
 * client-supplied URL to fill an iframe would let anyone frame any site inside
 * the shell and have the bridge treat its origin as trusted. The catalogue is
 * the only authority for which origins are games.
 */
export const getGame = (slug: string) =>
  request<Game>(`/games/${encodeURIComponent(slug)}`);

export interface WalletChallenge {
  nonce: string;
  message: string;
  expires_at: string;
}

export interface WalletLinkProof {
  nonce: string;
  address: string;
  signature: string;
}

export const createWalletChallenge = (address: string) =>
  request<WalletChallenge>("/wallet/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address }),
  });

export const linkWallet = (proof: WalletLinkProof) =>
  request<Me>("/wallet/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proof),
  });

export const unlinkWallet = () =>
  request<void>("/wallet", { method: "DELETE" });
