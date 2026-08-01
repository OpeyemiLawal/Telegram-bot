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
os.environ.setdefault("ALLOWED_ORIGINS", "https://play.test,https://game.test")
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


def game_login(client, *, origin="https://game.test", **kwargs):
    return client.post(
        "/api/game/auth",
        headers={"Origin": origin},
        json={
            "game_slug": "test-game",
            "init_data": build_init_data(token=BOT_TOKEN, **kwargs),
        },
    )


def test_direct_game_gets_only_a_scoped_session(client):
    logged_in = game_login(
        client,
        user={"id": 555007, "first_name": "Katherine"},
    )
    assert logged_in.status_code == 200, logged_in.text

    body = logged_in.json()
    assert body["game_slug"] == "test-game"
    assert body["player"]["display_name"] == "Katherine"
    assert body["player"]["wallet_address"] is None
    assert body["access_token"]
    assert "refresh_token" not in body

    headers = {
        "Authorization": f"Bearer {body['access_token']}",
        "Origin": "https://game.test",
    }
    session = client.get("/api/game/session", headers=headers)
    assert session.status_code == 200, session.text
    assert session.json()["game_slug"] == "test-game"

    # A game token cannot call full-platform endpoints.
    assert client.get("/api/auth/me", headers=headers).status_code == 401

    # A full-platform token cannot be used as a game token either.
    platform = login(
        client,
        user={"id": 555007, "first_name": "Katherine"},
    ).json()
    wrong_scope = client.get(
        "/api/game/session",
        headers={
            "Authorization": f"Bearer {platform['access_token']}",
            "Origin": "https://game.test",
        },
    )
    assert wrong_scope.status_code == 401


def test_direct_game_rejects_an_unregistered_origin(client):
    rejected = game_login(
        client,
        origin="https://attacker.example",
        user={"id": 555008, "first_name": "Margaret"},
    )
    assert rejected.status_code == 403


def test_direct_game_receives_the_already_linked_wallet(client):
    import asyncio

    telegram_id = 555009
    game_login(
        client,
        user={"id": telegram_id, "first_name": "Dorothy"},
    )

    async def link_public_address():
        from sqlalchemy import select

        from app.models import User

        async with SessionMaker() as session:
            user = await session.scalar(
                select(User).where(User.telegram_id == telegram_id)
            )
            assert user is not None
            user.wallet_address = "11111111111111111111111111111111"
            await session.commit()

    asyncio.run(link_public_address())

    reopened = game_login(
        client,
        user={"id": telegram_id, "first_name": "Dorothy"},
    )
    assert reopened.status_code == 200, reopened.text
    assert (
        reopened.json()["player"]["wallet_address"]
        == "11111111111111111111111111111111"
    )



def test_bot_game_button_uses_the_registered_vercel_origin(client):
    import asyncio

    from app.bot.handlers import _games_keyboard

    markup = asyncio.run(_games_keyboard())
    first = markup.inline_keyboard[0][0]

    assert first.text == "🎮 Test Game"
    assert first.web_app is not None
    assert first.web_app.url == "https://game.test"
    assert "/play/" not in first.web_app.url

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


def _reward_headers(game_pair: dict) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {game_pair['access_token']}",
        "Origin": "https://game.test",
    }


def _earn_one_reward(client, telegram_id: int) -> tuple[dict, dict]:
    import time

    game_pair = game_login(
        client,
        user={"id": telegram_id, "first_name": "Reward Player"},
    ).json()
    game_headers = _reward_headers(game_pair)
    started = client.post("/api/game/rewards/rounds", headers=game_headers)
    assert started.status_code == 200, started.text
    round_id = started.json()["round_id"]

    last = None
    for sequence in range(1, 6):
        time.sleep(0.05)
        last = client.post(
            f"/api/game/rewards/rounds/{round_id}/taps",
            headers=game_headers,
            json={"sequence": sequence, "elapsed_ms": sequence * 100},
        )
        assert last.status_code == 200, last.text

    platform_pair = login(
        client,
        user={"id": telegram_id, "first_name": "Reward Player"},
    ).json()
    return last.json(), platform_pair


def test_five_valid_taps_earn_one_hundred_gamer_tokens(client):
    last, platform = _earn_one_reward(client, 555010)

    assert last["accepted_taps"] == 5
    assert last["earned_now"] == 100
    assert last["available_amount"] == 100
    assert last["tap_progress"] == 0

    summary = client.get(
        "/api/rewards",
        headers={"Authorization": f"Bearer {platform['access_token']}"},
    )
    assert summary.status_code == 200, summary.text
    assert summary.json()["available_amount"] == 100
    assert summary.json()["lifetime_earned"] == 100

    # A restricted game token cannot call the wallet claim API.
    game = game_login(
        client,
        user={"id": 555010, "first_name": "Reward Player"},
    ).json()
    assert (
        client.get("/api/rewards", headers=_reward_headers(game)).status_code
        == 401
    )


def test_reward_round_rejects_duplicate_tap_numbers(client):
    import time

    game = game_login(
        client,
        user={"id": 555011, "first_name": "Sequence Player"},
    ).json()
    headers = _reward_headers(game)
    round_id = client.post("/api/game/rewards/rounds", headers=headers).json()["round_id"]

    time.sleep(0.05)
    first = client.post(
        f"/api/game/rewards/rounds/{round_id}/taps",
        headers=headers,
        json={"sequence": 1, "elapsed_ms": 100},
    )
    assert first.status_code == 200

    duplicate = client.post(
        f"/api/game/rewards/rounds/{round_id}/taps",
        headers=headers,
        json={"sequence": 1, "elapsed_ms": 200},
    )
    assert duplicate.status_code == 409


def test_claim_is_disabled_until_treasury_is_configured(client):
    _, platform = _earn_one_reward(client, 555012)
    response = client.post(
        "/api/rewards/claim",
        headers={"Authorization": f"Bearer {platform['access_token']}"},
    )
    # Wallet is checked before treasury configuration.
    assert response.status_code == 409
    assert response.json()["detail"] == "Connect a wallet before claiming."


def test_claim_debits_once_and_sends_to_linked_wallet(client, monkeypatch):
    import asyncio

    from sqlalchemy import select

    from app.config import get_settings
    from app.models import User

    telegram_id = 555013
    _, platform = _earn_one_reward(client, telegram_id)
    wallet = "11111111111111111111111111111111"

    async def link_wallet():
        async with SessionMaker() as session:
            user = await session.scalar(
                select(User).where(User.telegram_id == telegram_id)
            )
            assert user is not None
            user.wallet_address = wallet
            await session.commit()

    asyncio.run(link_wallet())

    sent: list[dict] = []

    async def fake_send(**kwargs):
        sent.append(kwargs)
        return "test-confirmed-signature"

    monkeypatch.setattr("app.api.rewards.send_gamer_tokens", fake_send)

    settings = get_settings()
    old = (
        settings.rewards_claims_enabled,
        settings.gamer_token_mint,
        settings.gamer_treasury_keypair,
    )
    settings.rewards_claims_enabled = True
    settings.gamer_token_mint = "11111111111111111111111111111111"
    settings.gamer_treasury_keypair = "test-only"
    try:
        headers = {"Authorization": f"Bearer {platform['access_token']}"}
        claimed = client.post("/api/rewards/claim", headers=headers)
        assert claimed.status_code == 200, claimed.text
        assert claimed.json()["amount"] == 100
        assert claimed.json()["status"] == "confirmed"
        assert claimed.json()["wallet_address"] == wallet
        assert len(sent) == 1
        assert sent[0]["whole_tokens"] == 100
        assert sent[0]["destination_wallet"] == wallet

        second = client.post("/api/rewards/claim", headers=headers)
        assert second.status_code == 409
        assert len(sent) == 1

        summary = client.get("/api/rewards", headers=headers).json()
        assert summary["available_amount"] == 0
        assert summary["lifetime_claimed"] == 100
    finally:
        (
            settings.rewards_claims_enabled,
            settings.gamer_token_mint,
            settings.gamer_treasury_keypair,
        ) = old