"""Session tokens.

Two-token scheme:

  access token   JWT, 15 minutes, held in memory by the Mini App, sent as
                 `Authorization: Bearer`. Stateless — no DB hit per request.

  refresh token  opaque 256-bit random string, 30 days, stored in the DB as a
                 SHA-256 hash. Rotated on every use. Reusing a rotated token
                 revokes the whole family, which is how you detect theft.

The refresh token is the only long-lived secret on the client, and it never
touches localStorage — see miniapp/lib/auth.tsx for where it does live.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import jwt

ACCESS_TOKEN_TTL = timedelta(minutes=15)
REFRESH_TOKEN_TTL = timedelta(days=30)
_ALGORITHM = "HS256"


class TokenError(Exception):
    """Access token was absent, malformed, expired, or not ours."""


def issue_access_token(*, user_id: uuid.UUID, secret: str, issuer: str) -> tuple[str, int]:
    """Return (jwt, expires_in_seconds)."""
    now = datetime.now(timezone.utc)
    expires_at = now + ACCESS_TOKEN_TTL
    payload = {
        "sub": str(user_id),
        "iss": issuer,
        "iat": int(now.timestamp()),
        "exp": int(expires_at.timestamp()),
        "jti": secrets.token_hex(8),
    }
    token = jwt.encode(payload, secret, algorithm=_ALGORITHM)
    return token, int(ACCESS_TOKEN_TTL.total_seconds())


def read_access_token(token: str, *, secret: str, issuer: str) -> uuid.UUID:
    """Return the user id carried by a valid token, else raise TokenError."""
    try:
        payload = jwt.decode(
            token,
            secret,
            algorithms=[_ALGORITHM],
            issuer=issuer,
            options={"require": ["exp", "iat", "sub", "iss"]},
        )
    except jwt.PyJWTError as exc:
        raise TokenError(str(exc)) from exc

    try:
        return uuid.UUID(payload["sub"])
    except (KeyError, ValueError) as exc:
        raise TokenError("token subject is not a user id") from exc


def generate_refresh_token() -> tuple[str, str]:
    """Return (plaintext_for_client, sha256_hash_for_db)."""
    plaintext = secrets.token_urlsafe(32)
    return plaintext, hash_refresh_token(plaintext)


def hash_refresh_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode()).hexdigest()


def refresh_expiry() -> datetime:
    return datetime.now(timezone.utc) + REFRESH_TOKEN_TTL
