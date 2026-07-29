"""Validation of Telegram Mini App `initData`.

This is the trust boundary of the whole platform. Everything downstream
assumes that if `validate_init_data` returned, the Telegram user id is real.

Telegram's spec:
    secret_key = HMAC_SHA256(key="WebAppData", msg=<bot_token>)
    expected   = HMAC_SHA256(key=secret_key,   msg=<data_check_string>)

`data_check_string` is every field except `hash`, formatted as `key=value`,
sorted by key, joined with newlines.

`signature` is Telegram's newer Ed25519 proof, meant for third parties that
do not hold the bot token. Telegram includes it in the bot-token HMAC input;
only the separate Ed25519 verification procedure excludes it.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl


class InitDataError(Exception):
    """initData was absent, malformed, forged, or expired."""


@dataclass(frozen=True)
class TelegramUser:
    id: int
    first_name: str
    last_name: str | None
    username: str | None
    language_code: str | None
    is_premium: bool
    photo_url: str | None


@dataclass(frozen=True)
class InitData:
    user: TelegramUser
    auth_date: int
    hash: str
    query_id: str | None
    start_param: str | None
    raw: dict[str, str]


def validate_init_data(
    init_data: str,
    bot_token: str,
    max_age_seconds: int = 300,
) -> InitData:
    """Return parsed initData, or raise InitDataError.

    `max_age_seconds` bounds the replay window. Keep it short. Pair it with
    `ReplayGuard` below to close the window entirely.
    """
    if not init_data:
        raise InitDataError("initData is empty")

    try:
        pairs = parse_qsl(init_data, strict_parsing=True, keep_blank_values=True)
    except ValueError as exc:
        raise InitDataError("initData is not a valid query string") from exc

    fields = dict(pairs)
    if len(fields) != len(pairs):
        raise InitDataError("initData contains duplicate keys")

    received_hash = fields.pop("hash", None)
    if not received_hash:
        raise InitDataError("initData has no hash")

    check_string = "\n".join(f"{key}={fields[key]}" for key in sorted(fields))

    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    expected_hash = hmac.new(
        secret_key, check_string.encode(), hashlib.sha256
    ).hexdigest()

    if not hmac.compare_digest(expected_hash, received_hash):
        raise InitDataError("initData signature does not match")

    # --- Signature is good. Now check the contents are sane. ---

    raw_auth_date = fields.get("auth_date")
    if not raw_auth_date:
        raise InitDataError("initData has no auth_date")
    try:
        auth_date = int(raw_auth_date)
    except ValueError as exc:
        raise InitDataError("auth_date is not an integer") from exc

    age = int(time.time()) - auth_date
    if age > max_age_seconds:
        raise InitDataError(f"initData expired ({age}s old)")
    if age < -60:
        # Clock skew allowance. Anything further ahead is suspect.
        raise InitDataError("auth_date is in the future")

    raw_user = fields.get("user")
    if not raw_user:
        # Happens when the Mini App is opened from an inline mode or a
        # channel context. We require a user, so reject.
        raise InitDataError("initData has no user (open the app from a private chat)")

    try:
        user_obj: dict[str, Any] = json.loads(raw_user)
    except json.JSONDecodeError as exc:
        raise InitDataError("user field is not valid JSON") from exc

    user_id = user_obj.get("id")
    if not isinstance(user_id, int):
        raise InitDataError("user.id is missing or not an integer")

    user = TelegramUser(
        id=user_id,
        first_name=str(user_obj.get("first_name") or ""),
        last_name=user_obj.get("last_name"),
        username=user_obj.get("username"),
        language_code=user_obj.get("language_code"),
        is_premium=bool(user_obj.get("is_premium", False)),
        photo_url=user_obj.get("photo_url"),
    )

    return InitData(
        user=user,
        auth_date=auth_date,
        hash=received_hash,
        query_id=fields.get("query_id"),
        start_param=fields.get("start_param"),
        raw=fields,
    )


class ReplayGuard:
    """Rejects an initData hash that has already been redeemed.

    A valid initData string stays valid for `max_age_seconds`. If it leaks in
    that window (shoulder-surfed URL, a log line, a proxy), it can be replayed.
    Burning the hash on first use closes that.

    The in-memory implementation below is correct for a single process only.
    Swap `seen()` for Redis `SET key 1 NX EX <ttl>` before you run more than
    one worker.
    """

    def __init__(self, ttl_seconds: int = 300) -> None:
        self._ttl = ttl_seconds
        self._seen: dict[str, float] = {}

    def seen(self, init_data_hash: str) -> bool:
        """Return True if this hash was already redeemed. Records it if not."""
        now = time.monotonic()
        self._evict(now)
        if init_data_hash in self._seen:
            return True
        self._seen[init_data_hash] = now + self._ttl
        return False

    def _evict(self, now: float) -> None:
        if len(self._seen) < 512:
            return
        expired = [key for key, exp in self._seen.items() if exp <= now]
        for key in expired:
            del self._seen[key]
