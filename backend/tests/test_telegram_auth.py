"""Run with:  pytest -q

These tests are the reason you can trust every other endpoint. If you change
telegram_auth.py, these must still pass.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from urllib.parse import urlencode

import pytest

from app.security.telegram_auth import (
    InitDataError,
    ReplayGuard,
    validate_init_data,
)

# Shaped like a real BotFather token so it survives config validation.
# Not a real token — the digits and suffix are invented.
BOT_TOKEN = "8854688163:AAHtestTOKENnotrealDoNotUseAnywhere00"


def build_init_data(
    *,
    token: str = BOT_TOKEN,
    auth_date: int | None = None,
    user: dict | None = None,
    extra: dict | None = None,
    signature: str | None = None,
    tamper_hash: bool = False,
) -> str:
    """Produce a signed initData string exactly the way Telegram does.

    `signature`, when present, is part of the bot-token HMAC check string.
    It is excluded only by Telegram's separate third-party Ed25519 procedure.
    """
    fields = {
        "auth_date": str(auth_date if auth_date is not None else int(time.time())),
        "query_id": "AAF_test",
        "user": json.dumps(
            user
            or {
                "id": 777000123,
                "first_name": "Ada",
                "username": "ada",
                "language_code": "en",
            },
            separators=(",", ":"),
        ),
    }
    if extra:
        fields.update(extra)

    if signature is not None:
        fields["signature"] = signature

    check_string = "\n".join(f"{k}={fields[k]}" for k in sorted(fields))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    digest = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()

    if tamper_hash:
        digest = "0" * len(digest)

    return urlencode({**fields, "hash": digest})


def test_accepts_genuine_init_data():
    data = validate_init_data(build_init_data(), bot_token=BOT_TOKEN)
    assert data.user.id == 777000123
    assert data.user.username == "ada"
    assert data.query_id == "AAF_test"


def test_rejects_wrong_bot_token():
    forged = build_init_data(token="999:ATTACKER-TOKEN")
    with pytest.raises(InitDataError, match="signature"):
        validate_init_data(forged, bot_token=BOT_TOKEN)


def test_rejects_tampered_hash():
    with pytest.raises(InitDataError, match="signature"):
        validate_init_data(build_init_data(tamper_hash=True), bot_token=BOT_TOKEN)


def test_rejects_modified_user_id():
    """The whole point: you cannot swap in someone else's account."""
    genuine = build_init_data()
    attacked = genuine.replace("777000123", "777000999")
    with pytest.raises(InitDataError):
        validate_init_data(attacked, bot_token=BOT_TOKEN)


def test_rejects_expired_payload():
    stale = build_init_data(auth_date=int(time.time()) - 3600)
    with pytest.raises(InitDataError, match="expired"):
        validate_init_data(stale, bot_token=BOT_TOKEN, max_age_seconds=300)


def test_rejects_future_auth_date():
    ahead = build_init_data(auth_date=int(time.time()) + 600)
    with pytest.raises(InitDataError, match="future"):
        validate_init_data(ahead, bot_token=BOT_TOKEN)


def test_signature_field_is_included_in_hmac_check_string():
    """Modern Telegram payloads include `signature` in bot-token HMAC input."""
    raw = build_init_data(signature="abc123_ed25519_proof")
    data = validate_init_data(raw, bot_token=BOT_TOKEN)
    assert data.user.id == 777000123


def test_rejects_missing_hash():
    with pytest.raises(InitDataError, match="no hash"):
        validate_init_data("auth_date=1&user=%7B%7D", bot_token=BOT_TOKEN)


def test_rejects_empty():
    with pytest.raises(InitDataError, match="empty"):
        validate_init_data("", bot_token=BOT_TOKEN)


def test_rejects_payload_without_user():
    fields = {"auth_date": str(int(time.time())), "query_id": "x"}
    check_string = "\n".join(f"{k}={fields[k]}" for k in sorted(fields))
    secret = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    digest = hmac.new(secret, check_string.encode(), hashlib.sha256).hexdigest()
    raw = urlencode({**fields, "hash": digest})
    with pytest.raises(InitDataError, match="no user"):
        validate_init_data(raw, bot_token=BOT_TOKEN)


def test_replay_guard_burns_a_hash_once():
    guard = ReplayGuard(ttl_seconds=60)
    assert guard.seen("hash-a") is False
    assert guard.seen("hash-a") is True
    assert guard.seen("hash-b") is False
