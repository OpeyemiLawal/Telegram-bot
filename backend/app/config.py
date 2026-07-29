from __future__ import annotations

import re
from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    bot_token: str = Field(alias="BOT_TOKEN")
    webhook_secret: str = Field(alias="WEBHOOK_SECRET")
    jwt_secret: str = Field(alias="JWT_SECRET")

    public_api_url: str = Field(alias="PUBLIC_API_URL")
    miniapp_url: str = Field(alias="MINIAPP_URL")
    allowed_origins: str = Field(alias="ALLOWED_ORIGINS")

    database_url: str = Field(alias="DATABASE_URL")
    initdata_max_age: int = Field(default=300, alias="INITDATA_MAX_AGE")
    environment: str = Field(default="development", alias="ENVIRONMENT")

    # Writes failing initData payloads to last_initdata.txt for
    # diagnose_initdata.py. Development only.
    debug_auth: bool = Field(default=False, alias="DEBUG_AUTH")

    @field_validator("bot_token")
    @classmethod
    def _clean_token(cls, value: str) -> str:
        """Strip stray characters and reject a malformed token at startup.

        Worth being strict here. Telegram's HTTP API tolerates trailing
        whitespace in the token, so a token with a stray \\r or space will
        authenticate the bot perfectly — but those same bytes are the HMAC
        key for initData, where they silently break every signature check.
        The result is a bot that answers /start and rejects every login,
        which is a miserable thing to debug.
        """
        cleaned = value.strip().strip("\"'").strip()
        if not re.fullmatch(r"\d{5,}:[A-Za-z0-9_-]{30,}", cleaned):
            raise ValueError(
                "BOT_TOKEN is malformed. Expected <digits>:<letters/digits/-/_> "
                "exactly as BotFather sent it, with no quotes or spaces."
            )
        return cleaned

    @field_validator("jwt_secret", "webhook_secret")
    @classmethod
    def _long_enough(cls, value: str) -> str:
        if len(value) < 32:
            raise ValueError(
                "must be at least 32 characters — generate with "
                "python -c \"import secrets; print(secrets.token_urlsafe(32))\""
            )
        return value

    @field_validator("webhook_secret")
    @classmethod
    def _telegram_safe(cls, value: str) -> str:
        """Reject a secret Telegram will not accept.

        `setWebhook` limits `secret_token` to 1-256 characters drawn from
        A-Z, a-z, 0-9, `_` and `-`. Base64 output is a natural thing to reach
        for and is *not* valid here: `+`, `/` and `=` are all rejected. Render's
        `generateValue`, and most "generate a secret" buttons, produce exactly
        that.

        Without this check the failure surfaces as a TelegramBadRequest thrown
        from inside the lifespan handler on boot — a stack trace fifteen frames
        deep in aiogram that names neither this setting nor the offending
        character. `secrets.token_urlsafe()` already emits the correct alphabet.
        """
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", value):
            raise ValueError(
                "WEBHOOK_SECRET may contain only letters, digits, '_' and '-' "
                "(Telegram's rule for secret_token). Base64 values are rejected "
                "because of '+', '/' and '='. Generate a valid one with "
                "python -c \"import secrets; print(secrets.token_urlsafe(32))\""
            )
        return value

    @field_validator("database_url")
    @classmethod
    def _async_driver(cls, value: str) -> str:
        """Normalise a hosted Postgres URL to the asyncpg driver.

        Render, Railway, Heroku and friends hand out `postgres://` or
        `postgresql://`, which SQLAlchemy's async engine refuses — it wants an
        explicit async driver. Rewriting here means DATABASE_URL can be wired
        straight from the provider's connection string with no manual editing,
        and no one has to remember this at 2am.

        asyncpg also does not understand libpq's `sslmode` query parameter.
        Render's internal connection string does not carry one; the external
        one does, so strip it rather than let it raise.
        """
        url = value.strip()
        if url.startswith("postgres://"):
            url = "postgresql+asyncpg://" + url[len("postgres://") :]
        elif url.startswith("postgresql://"):
            url = "postgresql+asyncpg://" + url[len("postgresql://") :]

        if "asyncpg" in url and "sslmode=" in url:
            base, _, query = url.partition("?")
            kept = [p for p in query.split("&") if p and not p.startswith("sslmode=")]
            url = f"{base}?{'&'.join(kept)}" if kept else base

        return url

    @field_validator("miniapp_url")
    @classmethod
    def _https_only(cls, value: str) -> str:
        # Telegram refuses to open a Mini App over plain HTTP.
        if not value.startswith("https://"):
            raise ValueError("MINIAPP_URL must be https:// — use a tunnel in dev")
        return value.rstrip("/")

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip().rstrip("/") for o in self.allowed_origins.split(",") if o.strip()]

    @property
    def webhook_path(self) -> str:
        return "/webhook/telegram"

    @property
    def webhook_url(self) -> str:
        return f"{self.public_api_url.rstrip('/')}{self.webhook_path}"

    @property
    def is_production(self) -> bool:
        return self.environment.lower() in {"production", "prod"}


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
