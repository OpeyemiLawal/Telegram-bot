from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    """Re-attach UTC to a datetime that came back naive.

    SQLite has no timezone type, so DateTime(timezone=True) round-trips as
    naive there while Postgres round-trips as aware. Comparing the two raises.
    Everything written here is UTC, so assuming UTC on read is correct.
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)

    # The only identity we trust, and only because initData was verified.
    telegram_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)

    username: Mapped[str | None] = mapped_column(String(64))
    first_name: Mapped[str] = mapped_column(String(128), default="")
    last_name: Mapped[str | None] = mapped_column(String(128))
    language_code: Mapped[str | None] = mapped_column(String(16))
    is_premium: Mapped[bool] = mapped_column(Boolean, default=False)
    photo_url: Mapped[str | None] = mapped_column(String(512))

    # Filled only after a signed ownership proof. Never holds a private key.
    # This stores only the public wallet address.
    wallet_address: Mapped[str | None] = mapped_column(String(64), index=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    is_blocked: Mapped[bool] = mapped_column(Boolean, default=False)

    refresh_tokens: Mapped[list["RefreshToken"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )

    @property
    def display_name(self) -> str:
        return self.username or self.first_name or f"player-{self.telegram_id}"


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )

    # SHA-256 of the token. The plaintext exists only on the client.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)

    # Tokens issued from the same original login share a family id. If a
    # rotated token is presented again, we revoke the family — that pattern
    # only occurs when a token was stolen and used by two parties.
    family_id: Mapped[uuid.UUID] = mapped_column(default=uuid.uuid4, index=True)

    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    rotated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="refresh_tokens")

    __table_args__ = (Index("ix_refresh_family_active", "family_id", "revoked_at"),)

    @property
    def is_usable(self) -> bool:
        if self.revoked_at is not None or self.rotated_at is not None:
            return False
        return _as_utc(self.expires_at) > _utcnow()


class GameRecord(Base):
    """A game in the catalogue.

    Moved out of a Python list because that list was the bottleneck: adding a
    game meant a code change, a review, a backend deploy, and a frontend rebuild
    for the CSP. At a couple of games that is tolerable. At two hundred it is the
    whole job.

    `embed_url` is the field that matters most for the future. It means the
    platform does not care where a game is hosted — moving every game from
    per-project Vercel deployments to wildcard subdomains on object storage is
    two hundred rows updated, not a rewrite.
    """

    __tablename__ = "games"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)

    # URL-safe identity, and the routing key for /play/<slug>. Immutable in
    # practice: changing it breaks any link a player has already shared.
    slug: Mapped[str] = mapped_column(String(64), unique=True, index=True)

    title: Mapped[str] = mapped_column(String(120))
    tagline: Mapped[str] = mapped_column(String(240), default="")

    # Origin the build is served from. One game per origin, always — the bridge
    # identifies a game by its origin, so two games sharing one cannot be told
    # apart, and a bug in either becomes a bug in both.
    embed_url: Mapped[str] = mapped_column(String(512))

    accent: Mapped[str] = mapped_column(String(16), default="#C89B3C")

    # "live" | "soon" | "hidden". Hidden is the useful one: it takes a game out
    # of the catalogue without deleting the row, so a broken game can be pulled
    # in seconds and restored without re-entering anything.
    status: Mapped[str] = mapped_column(String(16), default="soon", index=True)

    # Display order, low first. Explicit rather than by creation date, because
    # the newest game is rarely the one you want at the top.
    sort_order: Mapped[int] = mapped_column(Integer, default=100)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )


class BotMenuMessage(Base):
    """Where the bot last drew this user's menu, so it can be redrawn.

    A Telegram inline keyboard is part of the message it was sent with. There is
    no "update the user's buttons" call — you edit a specific message in a
    specific chat, which means remembering which one.

    Deliberately a separate table rather than two columns on `users`. Schema
    here is built by `create_all`, which creates missing tables but never alters
    existing ones, so adding a column to `users` would appear to work locally
    against a fresh database and silently do nothing to production. A new table
    is the one shape of change `create_all` handles correctly. Fold this into
    `users` when Alembic lands.

    One row per user: only the most recent menu is worth keeping current, and
    older ones scroll out of view anyway.
    """

    __tablename__ = "bot_menu_messages"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    chat_id: Mapped[int] = mapped_column(BigInteger)
    message_id: Mapped[int] = mapped_column(BigInteger)

    # What the keyboard currently shows. Telegram rejects an edit that would
    # not change anything, so we check before calling rather than catching.
    shows_wallet_linked: Mapped[bool] = mapped_column(Boolean, default=False)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )


class WalletChallenge(Base):
    __tablename__ = "wallet_challenges"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    nonce: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    address: Mapped[str] = mapped_column(String(64))
    message: Mapped[str] = mapped_column(String(1024))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
