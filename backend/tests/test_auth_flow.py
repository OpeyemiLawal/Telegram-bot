"""End-to-end pass through the real app: login, authenticated call, refresh
rotation, theft detection, logout.

Run with:  pytest -q
"""

from __future__ import annotations

import os
import secrets
import base64

from nacl.signing import SigningKey

import pytest

# Imported before the app so the env var and the signing key are the same
# string by construction. test_telegram_auth does not import app, so this
# ordering is safe.
from tests.test_telegram_auth import BOT_TOKEN, build_init_data  # noqa: E402

os.environ.setdefault("BOT_TOKEN", BOT_TOKEN)
os.environ.setdefault("WEBHOOK_SECRET", secrets.token_urlsafe(32))
os.environ.setdefault("JWT_SECRET", secrets.token_urlsafe(32))
os.environ.setdefault("PUBLIC_API_URL", "https://api.test")
os.environ.setdefault("MINIAPP_URL", "https://play.test")
os.environ.setdefault("ALLOWED_ORIGINS", "https://play.test")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./test_sga.db")

from fastapi.testclient import TestClient  # noqa: E402

from app.db import SessionMaker, create_schema, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Base, GameRecord  # noqa: E402


@pytest.fixture(scope="module")
def client():
    import asyncio

    async def reset():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await create_schema()
        async with SessionMaker() as session:
            session.add(
                GameRecord(
                    slug="test-game",
                    title="Test Game",
                    tagline="Deterministic catalogue fixture",
                    embed_url="https://game.test",
                    accent="#C89B3C",
                    status="live",
                    sort_order=1,
                )
            )
            await session.commit()

    asyncio.run(reset())
    # Constructed without a `with` block on purpose: that skips the lifespan,
    # so the test never calls Telegram's setWebhook.
    yield TestClient(app)


def login(client, **kwargs):
    return client.post(
        "/api/auth/telegram",
        json={"init_data": build_init_data(token=BOT_TOKEN, **kwargs)},
    )


def test_login_creates_a_session(client):
    res = login(client)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["user"]["telegram_id"] == 777000123
    assert body["access_token"] and body["refresh_token"]


def test_access_token_reaches_protected_route(client):
    tokens = login(client, user={"id": 555001, "first_name": "Grace"}).json()
    res = client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
    )
    assert res.status_code == 200
    assert res.json()["telegram_id"] == 555001


def test_protected_route_rejects_garbage_token(client):
    res = client.get("/api/auth/me", headers={"Authorization": "Bearer nope"})
    assert res.status_code == 401


def test_forged_init_data_is_rejected(client):
    forged = build_init_data(token="000:ATTACKER")
    res = client.post("/api/auth/telegram", json={"init_data": forged})
    assert res.status_code == 401


def test_replayed_init_data_returns_a_fresh_session_for_the_same_user(client):
    """A relaunch must not strand the user.

    Telegram reuses the same initData every time it relaunches a Mini App, and
    it relaunches whenever the user comes back from another app — the wallet
    approval round trip being the case that matters. So a second redemption is
    ordinary behaviour, not an attack, and has to succeed.

    What must still hold is that it resolves to the *same* account and issues
    genuinely new tokens rather than handing back the old ones.
    """
    raw = build_init_data(user={"id": 555002, "first_name": "Alan"})

    first = client.post("/api/auth/telegram", json={"init_data": raw})
    assert first.status_code == 200

    second = client.post("/api/auth/telegram", json={"init_data": raw})
    assert second.status_code == 200

    assert second.json()["user"]["telegram_id"] == first.json()["user"]["telegram_id"]
    assert second.json()["user"]["id"] == first.json()["user"]["id"]
    assert second.json()["refresh_token"] != first.json()["refresh_token"]
    assert second.json()["access_token"] != first.json()["access_token"]


def test_refresh_rotates_and_old_token_dies(client):
    first = login(client, user={"id": 555003, "first_name": "Edsger"}).json()

    rotated = client.post(
        "/api/auth/refresh", json={"refresh_token": first["refresh_token"]}
    )
    assert rotated.status_code == 200
    new_pair = rotated.json()
    assert new_pair["refresh_token"] != first["refresh_token"]

    # Reusing the rotated token is the theft signal: it must fail AND take
    # the whole family down with it.
    reused = client.post(
        "/api/auth/refresh", json={"refresh_token": first["refresh_token"]}
    )
    assert reused.status_code == 401

    orphaned = client.post(
        "/api/auth/refresh", json={"refresh_token": new_pair["refresh_token"]}
    )
    assert orphaned.status_code == 401, "family should have been revoked"


def test_logout_kills_the_refresh_token(client):
    tokens = login(client, user={"id": 555004, "first_name": "Barbara"}).json()
    assert (
        client.post(
            "/api/auth/logout", json={"refresh_token": tokens["refresh_token"]}
        ).status_code
        == 204
    )
    assert (
        client.post(
            "/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
        ).status_code
        == 401
    )


def test_games_requires_auth(client):
    assert client.get("/api/games").status_code in (401, 403)
    tokens = login(client, user={"id": 555005, "first_name": "Ken"}).json()
    res = client.get(
        "/api/games", headers={"Authorization": f"Bearer {tokens['access_token']}"}
    )
    assert res.status_code == 200
    assert len(res.json()) >= 1

_BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _base58_encode(value: bytes) -> str:
    number = int.from_bytes(value, "big")
    encoded = ""
    while number:
        number, remainder = divmod(number, 58)
        encoded = _BASE58_ALPHABET[remainder] + encoded
    leading_zeroes = len(value) - len(value.lstrip(b"\0"))
    return "1" * leading_zeroes + (encoded or "1")


def test_wallet_link_requires_signed_ownership(client):
    tokens = login(client, user={"id": 555006, "first_name": "Linus"}).json()
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}

    signing_key = SigningKey.generate()
    address = _base58_encode(bytes(signing_key.verify_key))
    challenge = client.post(
        "/api/wallet/challenge",
        headers=headers,
        json={"address": address},
    )
    assert challenge.status_code == 200, challenge.text
    challenge_body = challenge.json()

    forged = client.post(
        "/api/wallet/connect",
        headers=headers,
        json={
            "nonce": challenge_body["nonce"],
            "address": address,
            "signature": base64.b64encode(b"\0" * 64).decode(),
        },
    )
    assert forged.status_code == 401

    signature = signing_key.sign(challenge_body["message"].encode()).signature
    linked = client.post(
        "/api/wallet/connect",
        headers=headers,
        json={
            "nonce": challenge_body["nonce"],
            "address": address,
            "signature": base64.b64encode(signature).decode(),
        },
    )
    assert linked.status_code == 200, linked.text
    assert linked.json()["wallet_address"] == address

    replayed = client.post(
        "/api/wallet/connect",
        headers=headers,
        json={
            "nonce": challenge_body["nonce"],
            "address": address,
            "signature": base64.b64encode(signature).decode(),
        },
    )
    assert replayed.status_code == 401

    disconnected = client.delete("/api/wallet", headers=headers)
    assert disconnected.status_code == 204
    me = client.get("/api/auth/me", headers=headers)
    assert me.json()["wallet_address"] is None


def test_linking_and_unlinking_notify_the_chat(client, telegram):
    """The chat is the only place the user can see stale state.

    An inline keyboard is frozen into the message it shipped with, so a wallet
    linked inside the Mini App leaves a "Connect wallet" button behind that is
    now wrong. These notifications are what correct it — worth asserting,
    because the failure is silent: everything else keeps working and the button
    simply lies.
    """
    signing_key = SigningKey.generate()
    address = _base58_encode(bytes(signing_key.verify_key))

    tokens = login(client, user={"id": 555010, "first_name": "Grace"}).json()
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}

    challenge = client.post(
        "/api/wallet/challenge", headers=headers, json={"address": address}
    ).json()
    signature = signing_key.sign(challenge["message"].encode()).signature

    telegram.messages.clear()
    linked = client.post(
        "/api/wallet/connect",
        headers=headers,
        json={
            "nonce": challenge["nonce"],
            "address": address,
            "signature": base64.b64encode(signature).decode(),
        },
    )
    assert linked.status_code == 200, linked.text

    assert len(telegram.messages) == 1
    chat_id, text = telegram.messages[0]
    assert chat_id == 555010
    assert address in text

    telegram.messages.clear()
    assert client.delete("/api/wallet", headers=headers).status_code == 204

    assert len(telegram.messages) == 1
    assert "disconnected" in telegram.messages[0][1].lower()
    # Nothing left the wallet, and the message must not imply otherwise.
    assert "nothing was moved" in telegram.messages[0][1].lower()


def test_login_is_rate_limited(client):
    """The one endpoint an attacker can hit with no credentials at all.

    Verifying initData costs an HMAC-SHA256 plus a database round trip, and
    proving identity is the endpoint's entire purpose, so it cannot be put behind
    a token. Throttling is the only lever left.

    Asserts the 429 *and* Retry-After: without a hint at when to try again a
    client's only sensible move is to keep retrying, which is the behaviour the
    limit exists to stop.
    """
    from app.security.rate_limit import login_limiter

    last = None
    for index in range(login_limiter.limit + 2):
        last = login(client, user={"id": 555020 + index, "first_name": "Ada"})

    assert last is not None
    assert last.status_code == 429, last.text
    assert int(last.headers["Retry-After"]) >= 1
    assert "try again" in last.json()["detail"].lower()


def test_rate_limit_is_per_client(client):
    """A throttled address must not throttle everyone else.

    A limiter keyed on something shared — or on a proxy address rather than the
    forwarded one — degrades into a global cap the first time a single client
    misbehaves. That failure looks like an outage, not a limit.
    """
    from app.security.rate_limit import login_limiter

    noisy = {"X-Forwarded-For": "203.0.113.10"}
    for index in range(login_limiter.limit + 1):
        client.post(
            "/api/auth/telegram",
            headers=noisy,
            json={"init_data": build_init_data(user={"id": 555040 + index})},
        )

    blocked = client.post(
        "/api/auth/telegram",
        headers=noisy,
        json={"init_data": build_init_data(user={"id": 555060})},
    )
    assert blocked.status_code == 429

    quiet = client.post(
        "/api/auth/telegram",
        headers={"X-Forwarded-For": "198.51.100.7"},
        json={"init_data": build_init_data(user={"id": 555061})},
    )
    assert quiet.status_code == 200, quiet.text
