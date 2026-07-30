"""Reading balances from Solana.

Read-only, and structurally so: the only method here is `getBalance`, this
service holds no private key, and there is no code path from a request to a
transaction. A player's funds cannot be moved by anything in this file, which is
the property that makes it safe to expose the balance at all.

Done server-side rather than from the browser for three reasons: the RPC endpoint
usually carries an API key that should not ship to clients, one cache serves
every player instead of each browser hitting the RPC separately, and the Mini
App's CSP does not need widening to reach a third-party host.
"""

from __future__ import annotations

import logging
import time

import httpx

logger = logging.getLogger("sga.solana")

LAMPORTS_PER_SOL = 1_000_000_000

# Balances are read on a screen a player may open repeatedly, and an unchanged
# balance is the overwhelmingly common case. Ten seconds keeps it feeling live
# while collapsing a burst of reopenings into one upstream call — which matters
# most on the free public RPC, where the rate limit is the real constraint.
CACHE_TTL_SECONDS = 10.0

_TIMEOUT = httpx.Timeout(6.0, connect=3.0)


class SolanaError(Exception):
    """The RPC could not be reached, or answered with something unusable."""


_cache: dict[str, tuple[int, float]] = {}


def _cached(address: str) -> int | None:
    entry = _cache.get(address)
    if entry is None:
        return None

    lamports, fetched_at = entry
    if time.monotonic() - fetched_at > CACHE_TTL_SECONDS:
        return None

    return lamports


def _store(address: str, lamports: int) -> None:
    # Bounded so a long-running process cannot accumulate an entry per address
    # forever. Clearing wholesale rather than evicting the oldest keeps this to
    # one line; the cost is one cold read for everyone, once, rarely.
    if len(_cache) > 5_000:
        _cache.clear()

    _cache[address] = (lamports, time.monotonic())


async def get_lamports(address: str, *, rpc_url: str) -> int:
    """Balance of `address` in lamports.

    Raises `SolanaError` rather than returning zero when the RPC is unreachable.
    Zero is a real balance and a plausible one, so returning it on failure would
    tell a player their wallet is empty when the truth is that we could not ask.
    """
    cached = _cached(address)
    if cached is not None:
        return cached

    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getBalance",
        "params": [address],
    }

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.post(rpc_url, json=payload)
            response.raise_for_status()
            body = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("Solana RPC failed: %s", exc)
        raise SolanaError("Could not reach the Solana network.") from exc

    # JSON-RPC reports application errors in a 200 response, so a successful
    # status code is not a successful call.
    if "error" in body:
        message = body["error"].get("message", "unknown error")
        logger.warning("Solana RPC error: %s", message)
        raise SolanaError("The Solana network rejected the request.")

    try:
        lamports = int(body["result"]["value"])
    except (KeyError, TypeError, ValueError) as exc:
        raise SolanaError("Unexpected response from the Solana network.") from exc

    _store(address, lamports)
    return lamports


def to_sol(lamports: int) -> str:
    """Lamports as a decimal SOL string, without floating point.

    Formatted from integer arithmetic on purpose. A float cannot hold nine
    decimal places exactly, so `lamports / 1e9` quietly produces values like
    0.30000000000000004 — which is a strange thing to show someone about their
    own money, and worse if it is ever parsed back.
    """
    whole, remainder = divmod(abs(lamports), LAMPORTS_PER_SOL)
    sign = "-" if lamports < 0 else ""
    fraction = f"{remainder:09d}".rstrip("0")
    return f"{sign}{whole}.{fraction}" if fraction else f"{sign}{whole}"
