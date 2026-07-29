"""Redacts credentials from log records before they leave the process.

The threat is mundane and the consequence is not. Render retains logs, aiogram
logs request bodies at DEBUG, tracebacks quote the values that caused them, and
`BOT_TOKEN` is the HMAC key for every initData check — anyone holding it can
impersonate any user. A token that reaches a log has to be treated as rotated,
and the only reliable way to avoid that is for it never to be formatted into a
record in the first place.

Applied as a logging filter rather than trusted to call sites. Call sites are
where this gets forgotten: a `logger.exception` added in a hurry, a library
logging its own request, a field name that nobody thought was sensitive. A filter
on the root handler sees every record regardless of who emitted it.

Deliberately pattern-based as well as value-based. The exact bot token is known
and replaced literally, but a JWT or a refresh token is generated at runtime and
cannot be enumerated — those are matched by shape.
"""

from __future__ import annotations

import logging
import re

REDACTED = "[REDACTED]"

# Bot token shape: <digits>:<35-ish url-safe chars>. Matched by shape as well as
# by value, so a *different* bot's token — a second environment, a token pasted
# into a support ticket — is caught too.
#
# A lookbehind for a digit rather than a leading \b, because the case that matters
# most is the token embedded in a URL: aiogram logs
# `api.telegram.org/bot<token>/setWebhook`, and there is no word boundary between
# "bot" and the digits that follow it, so \b silently failed to match exactly
# where the token is most likely to appear.
_BOT_TOKEN = re.compile(r"(?<!\d)\d{6,}:[A-Za-z0-9_-]{30,}")

# Three dot-separated base64url segments.
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")

# `secrets.token_urlsafe(32)` produces 43 characters. Anchored to a preceding
# key name so it cannot swallow a Solana address, which is base58 of a similar
# length and is public information we actively want to see in logs.
_SECRET_FIELD = re.compile(
    r"((?:refresh_token|access_token|secret_token|token_hash|webhook_secret"
    r"|jwt_secret)[\"']?\s*[:=]\s*[\"']?)([A-Za-z0-9_.\-]{12,})",
    re.IGNORECASE,
)

# initData needs its own rule. It is a percent-encoded query string, so its value
# is full of `%`, `{`, `&` and `=` — characters the field pattern above excludes
# in order not to swallow surrounding text. Matching to the next delimiter instead
# covers the whole payload, which matters because initData contains a valid HMAC:
# logged in full it is a working credential until auth_date expires.
_INIT_DATA = re.compile(
    r"(init_?data[\"']?\s*[:=]\s*[\"']?)([^\s\"',}]{8,})",
    re.IGNORECASE,
)


def scrub(text: str) -> str:
    text = _BOT_TOKEN.sub(REDACTED, text)
    text = _JWT.sub(REDACTED, text)
    text = _INIT_DATA.sub(lambda m: f"{m.group(1)}{REDACTED}", text)
    text = _SECRET_FIELD.sub(lambda m: f"{m.group(1)}{REDACTED}", text)
    return text


class SecretScrubbingFilter(logging.Filter):
    """Rewrites a record's message, arguments and exception text in place."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = scrub(record.msg)

        # Arguments are scrubbed separately because they are substituted into the
        # message only at format time — scrubbing `msg` alone would leave
        # `logger.info("token=%s", token)` fully intact.
        if record.args:
            if isinstance(record.args, dict):
                record.args = {
                    key: scrub(value) if isinstance(value, str) else value
                    for key, value in record.args.items()
                }
            elif isinstance(record.args, tuple):
                record.args = tuple(
                    scrub(value) if isinstance(value, str) else value
                    for value in record.args
                )

        # A traceback frame quotes the arguments that raised. `exc_text` is the
        # cached rendering; clearing it forces a re-render that goes through
        # `format()` below.
        if record.exc_info:
            record.exc_text = None

        return True


class ScrubbingFormatter(logging.Formatter):
    """Final pass over the fully rendered line, tracebacks included."""

    def format(self, record: logging.LogRecord) -> str:
        return scrub(super().format(record))


def install(level: int = logging.INFO) -> None:
    """Attach scrubbing to the root logger. Idempotent.

    Applied to the *root* handler on purpose: every library logger propagates
    there, so uvicorn, aiogram and SQLAlchemy are covered without naming them.
    Naming them individually would mean missing the next dependency added.
    """
    root = logging.getLogger()
    root.setLevel(level)

    if not root.handlers:
        root.addHandler(logging.StreamHandler())

    for handler in root.handlers:
        handler.setFormatter(
            ScrubbingFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
        )
        if not any(isinstance(f, SecretScrubbingFilter) for f in handler.filters):
            handler.addFilter(SecretScrubbingFilter())
