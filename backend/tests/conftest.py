"""Shared test setup.

Two jobs, and the order between them matters:

1. Populate the environment before anything imports `app.config`, which
   validates its settings at import time and raises on a missing one.

2. Replace the Telegram Bot object with a recording stub. `/api/wallet/connect`
   and `DELETE /api/wallet` now edit the chat's keyboard and send a
   confirmation, so without this the suite would make real HTTPS calls to
   api.telegram.org — slow, flaky, dependent on a live token, and it would post
   messages into a real chat every time anyone ran `pytest`.

The stub also makes those side effects assertable, which they were not before.
"""

from __future__ import annotations

import os
import secrets

import pytest

# Same token the fixtures sign initData with, so the app's HMAC check and the
# test's signing key are the same string by construction.
from tests.test_telegram_auth import BOT_TOKEN

os.environ.setdefault("BOT_TOKEN", BOT_TOKEN)
os.environ.setdefault("WEBHOOK_SECRET", secrets.token_urlsafe(32))
os.environ.setdefault("JWT_SECRET", secrets.token_urlsafe(32))
os.environ.setdefault("PUBLIC_API_URL", "https://api.test")
os.environ.setdefault("MINIAPP_URL", "https://play.test")
os.environ.setdefault("ALLOWED_ORIGINS", "https://play.test,https://game.test")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///./test_sga.db")


class FakeBot:
    """Records what would have been sent to Telegram."""

    def __init__(self) -> None:
        self.edits: list[dict] = []
        self.messages: list[tuple[int, str]] = []

    async def edit_message_reply_markup(self, **kwargs) -> None:
        self.edits.append(kwargs)

    async def send_message(self, chat_id: int, text: str, **kwargs) -> None:
        self.messages.append((chat_id, text))

    async def set_webhook(self, **kwargs) -> None:  # pragma: no cover
        pass

    async def set_chat_menu_button(self, **kwargs) -> None:  # pragma: no cover
        pass


@pytest.fixture(autouse=True)
def fresh_rate_limits():
    """Give every test its own quota.

    The limiters are module-level singletons, so without this they accumulate
    across the suite: tests pass or fail depending on how many logins the tests
    before them happened to perform, and adding an unrelated test can push a
    later one over the limit. That is the kind of failure that gets diagnosed as
    flakiness and worked around rather than read.

    Any test that wants to assert throttling can still exhaust its own quota.
    """
    from app.security.rate_limit import login_limiter, wallet_limiter

    for limiter in (login_limiter, wallet_limiter):
        limiter._hits.clear()
    yield
    for limiter in (login_limiter, wallet_limiter):
        limiter._hits.clear()


@pytest.fixture(autouse=True)
def telegram(monkeypatch) -> FakeBot:
    """Intercept every outbound Telegram call. Autouse — no test opts out.

    Patches `menu_sync._bot`, the single accessor the module funnels every call
    through. Patching that one function rather than the Bot instance means the
    stub cannot be bypassed by a future caller that reaches for the bot
    differently: there is nowhere else to reach.

    Imported inside the fixture because module import order in conftest runs
    before the environment above is guaranteed to be visible to a top-level
    `app.*` import.
    """
    from app.bot import menu_sync

    fake = FakeBot()
    monkeypatch.setattr(menu_sync, "_bot", lambda: fake)
    return fake
