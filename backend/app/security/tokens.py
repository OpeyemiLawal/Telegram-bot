"""Session tokens for the platform Mini App and direct games."""

from __future__ import annotations

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import jwt

ACCESS_TOKEN_TTL = timedelta(minutes=15)
GAME_TOKEN_TTL = timedelta(hours=4)
REFRESH_TOKEN_TTL = timedelta(days=30)
_ALGORITHM = "HS256"


class TokenError(Exception):
    """A token was absent, malformed, expired, or issued for another scope."""


@dataclass(frozen=True)
class GameTokenClaims:
    user_id: uuid.UUID
    game_slug: str


def issue_access_token(*, user_id: uuid.UUID, secret: str, issuer: str) -> tuple[str, int]:
    """Return a full-platform access token and its lifetime in seconds."""
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


def issue_game_token(
    *,
    user_id: uuid.UUID,
    game_slug: str,
    secret: str,
    issuer: str,
) -> tuple[str, int]:
    """Return a token that is valid only for one direct-hosted game."""
    now = datetime.now(timezone.utc)
    expires_at = now + GAME_TOKEN_TTL
    payload = {
        "sub": str(user_id),
        "iss": issuer,
        "scope": "game",
        "game": game_slug,
        "iat": int(now.timestamp()),
        "exp": int(expires_at.timestamp()),
        "jti": secrets.token_hex(8),
    }
    token = jwt.encode(payload, secret, algorithm=_ALGORITHM)
    return token, int(GAME_TOKEN_TTL.total_seconds())


def read_access_token(token: str, *, secret: str, issuer: str) -> uuid.UUID:
    """Return the user id carried by a full-platform access token."""
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


def read_game_token(
    token: str,
    *,
    secret: str,
    issuer: str,
) -> GameTokenClaims:
    """Return the user and game carried by a restricted game token."""
    try:
        payload = jwt.decode(
            token,
            secret,
            algorithms=[_ALGORITHM],
            issuer=issuer,
            options={"require": ["exp", "iat", "sub", "iss", "scope", "game"]},
        )
    except jwt.PyJWTError as exc:
        raise TokenError(str(exc)) from exc

    if payload.get("scope") != "game":
        raise TokenError("token is not game-scoped")

    game_slug = payload.get("game")
    if not isinstance(game_slug, str) or not game_slug:
        raise TokenError("token has no game slug")

    try:
        user_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError) as exc:
        raise TokenError("token subject is not a user id") from exc

    return GameTokenClaims(user_id=user_id, game_slug=game_slug)


def generate_refresh_token() -> tuple[str, str]:
    """Return (plaintext_for_client, sha256_hash_for_db)."""
    plaintext = secrets.token_urlsafe(32)
    return plaintext, hash_refresh_token(plaintext)


def hash_refresh_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode()).hexdigest()


def refresh_expiry() -> datetime:
    return datetime.now(timezone.utc) + REFRESH_TOKEN_TTL
