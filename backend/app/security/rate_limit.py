"""Per-client throttling for the endpoints that cannot require a token.

`/api/auth/telegram` is unauthenticated by definition — proving who you are is
the whole point of it — and it does an HMAC-SHA256 and a database round trip on
every call. That combination is what makes it the one endpoint worth protecting
before anything else: an attacker needs no credentials to make it work, and each
request costs meaningfully more than it costs them to send.

Deliberately a fixed window rather than a token bucket. A window is two integers
and a timestamp; a bucket needs a refill rate reasoned about per endpoint, and
neither is more correct here. Bursts are what we care about, and both catch them.

Single-process, like `ReplayGuard`, and correct only because the service runs one
worker. Both want the same Redis when that changes:

    count = redis.incr(key)
    if count == 1:
        redis.expire(key, window_seconds)
    if count > limit:
        reject
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from fastapi import HTTPException, Request, status


@dataclass
class FixedWindowLimiter:
    """Allows `limit` requests per `window_seconds` per key."""

    limit: int
    window_seconds: int
    _hits: dict[str, tuple[int, float]] = field(default_factory=dict)

    def check(self, key: str) -> int | None:
        """Return None if allowed, else seconds until the window resets."""
        now = time.monotonic()
        count, started = self._hits.get(key, (0, now))

        if now - started >= self.window_seconds:
            self._hits[key] = (1, now)
            self._sweep(now)
            return None

        if count >= self.limit:
            return max(1, int(self.window_seconds - (now - started)))

        self._hits[key] = (count + 1, started)
        return None

    def _sweep(self, now: float) -> None:
        """Drop expired windows.

        Only on the cold path — a request that opened a new window — so the cost
        never lands on a request that was already being counted. Without this the
        dict grows once per distinct client forever, which is a slow memory leak
        that only shows up in production.
        """
        if len(self._hits) < 1024:
            return
        stale = [
            key
            for key, (_, started) in self._hits.items()
            if now - started >= self.window_seconds
        ]
        for key in stale:
            del self._hits[key]


def client_key(request: Request) -> str:
    """Best available identifier for the caller.

    Render terminates TLS at its proxy, so `request.client.host` is the proxy and
    identical for everyone. The real address is the first entry of
    X-Forwarded-For, which the proxy sets.

    Trusting that header is only safe *because* a trusted proxy sits in front and
    overwrites it. Exposed directly, a client could forge it and take a fresh
    quota per request, making this decorative. If this ever runs without a proxy,
    switch back to `request.client.host`.
    """
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit(limiter: FixedWindowLimiter):
    """FastAPI dependency enforcing `limiter` for the decorated route."""

    async def dependency(request: Request) -> None:
        retry_after = limiter.check(client_key(request))
        if retry_after is not None:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many attempts. Wait a moment and try again.",
                headers={"Retry-After": str(retry_after)},
            )

    return dependency


# Ten logins a minute per address.
#
# Sized against the legitimate worst case rather than a round number. Telegram
# relaunches the Mini App on every return from another app, and each relaunch can
# mean one login — so a user linking a wallet, being handed back, then reopening
# a game might genuinely spend three or four. Ten leaves room for that and still
# refuses anything trying to grind HMACs.
#
# Shared NAT is the case that argues for a higher number: a university or office
# can put many real users behind one address. Raise it if that shows up in the
# logs as 429s from a single busy IP.
login_limiter = FixedWindowLimiter(limit=10, window_seconds=60)

# Wallet challenges are cheap but create a database row each, and the endpoint
# sits behind a bearer token, so abuse means a compromised session rather than an
# anonymous flood.
wallet_limiter = FixedWindowLimiter(limit=20, window_seconds=60)
