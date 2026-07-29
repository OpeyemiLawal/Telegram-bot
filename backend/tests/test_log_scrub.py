"""Redaction rules.

Two-sided on purpose. Every credential must vanish, and every operationally
useful identifier must survive — a scrubber that eats Solana addresses and
Telegram ids produces logs nobody can debug with, which is how scrubbing ends up
being switched off.
"""

from __future__ import annotations

import logging

import pytest

from app.security.log_scrub import (
    REDACTED,
    ScrubbingFormatter,
    SecretScrubbingFilter,
    scrub,
)

BOT_TOKEN = "8412345678:AAH3kd9Lm2QpXyZaBcDeFgHiJkLmNoPqRsT"
JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMiLCJleHAiOjE3MDB9.QmxhaEJsYWg"
REFRESH = "qmWaFcuz7OcU4komwdRhz1bR49KCM6DZRfg-rYNPXHE"
SOLANA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"


@pytest.mark.parametrize(
    "text",
    [
        f"https://api.telegram.org/bot{BOT_TOKEN}/setWebhook",
        f"BOT_TOKEN={BOT_TOKEN}",
        f"Authorization: Bearer {JWT}",
        f'{{"refresh_token": "{REFRESH}"}}',
        "init_data=user%3D%7B%22id%22%3A1%7D&hash=abc123def456789012345",
        '{"initData":"query_id=AAH&user=%7B%22id%22%3A1%7D&hash=deadbeefcafe"}',
    ],
)
def test_credentials_are_removed(text: str) -> None:
    cleaned = scrub(text)
    assert REDACTED in cleaned
    for secret in (BOT_TOKEN, JWT, REFRESH):
        assert secret not in cleaned


@pytest.mark.parametrize(
    "text",
    [
        f"linked wallet {SOLANA} for telegram_id=777000123",
        "Webhook registered at https://sga-api-v924.onrender.com/webhook/telegram",
        "initData replayed for telegram_id=777000123 - issuing a new session",
    ],
)
def test_useful_identifiers_survive(text: str) -> None:
    assert scrub(text) == text


def test_bot_token_in_a_url_is_caught() -> None:
    """The case a leading \\b silently missed.

    aiogram logs `api.telegram.org/bot<token>/...`, and there is no word boundary
    between "bot" and the digits — so the obvious pattern failed at exactly the
    place the token is most likely to appear.
    """
    assert BOT_TOKEN not in scrub(f"POST /bot{BOT_TOKEN}/sendMessage")


def test_lazy_log_arguments_are_scrubbed() -> None:
    """`logger.info("token=%s", token)` leaves the message template clean.

    Arguments are only substituted at format time, so scrubbing the template
    alone would let the secret straight through.
    """
    record = logging.LogRecord(
        name="t",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="calling with %s",
        args=(BOT_TOKEN,),
        exc_info=None,
    )
    SecretScrubbingFilter().filter(record)
    rendered = ScrubbingFormatter("%(message)s").format(record)
    assert BOT_TOKEN not in rendered
    assert REDACTED in rendered


def test_tracebacks_are_scrubbed() -> None:
    """A frame quotes the value that raised, so the traceback leaks it too."""
    try:
        raise ValueError(f"bad token {BOT_TOKEN}")
    except ValueError:
        import sys

        record = logging.LogRecord(
            name="t",
            level=logging.ERROR,
            pathname=__file__,
            lineno=1,
            msg="failed",
            args=(),
            exc_info=sys.exc_info(),
        )

    SecretScrubbingFilter().filter(record)
    rendered = ScrubbingFormatter("%(message)s").format(record)
    assert BOT_TOKEN not in rendered
