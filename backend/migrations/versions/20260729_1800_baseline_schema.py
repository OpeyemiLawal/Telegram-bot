"""Baseline schema: users, refresh tokens, wallet challenges, bot menu messages

Revision ID: 0001_baseline
Revises:
Create Date: 2026-07-29

This reproduces what `create_all` had been building, so a fresh database reaches
the same shape through the migration chain instead of by import side effect.

Written to be safe against a database that already has these tables, because one
does: the deployed Postgres was built by `create_all` before Alembic existed
here. The alternative is a one-time `alembic stamp 0001_baseline` that has to be
run by hand, remembered by whoever deploys next, and produces a failed release
the first time it is not. Skipping tables that are already present costs one
inspector call and removes that entirely.

Every migration after this one can be written normally — this accommodation is
only needed at the boundary between "schema by side effect" and "schema by
migration", which is crossed exactly once.

Defaults are Python-side (`default=`, not `server_default=`), which is what the
models specify, so the columns carry none. The application is the only writer;
adding server defaults here would create a second source of truth that silently
disagrees the first time a model default changes.
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0001_baseline"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _existing_tables() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    return set(inspector.get_table_names())


def upgrade() -> None:
    present = _existing_tables()

    # Already the right shape, built by create_all. Recording the revision is all
    # that is left to do.
    if {"users", "refresh_tokens", "wallet_challenges"} <= present:
        if "bot_menu_messages" not in present:
            _create_bot_menu_messages()
        return

    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("telegram_id", sa.BigInteger(), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=True),
        sa.Column("first_name", sa.String(length=128), nullable=False),
        sa.Column("last_name", sa.String(length=128), nullable=True),
        sa.Column("language_code", sa.String(length=16), nullable=True),
        sa.Column("is_premium", sa.Boolean(), nullable=False),
        sa.Column("photo_url", sa.String(length=512), nullable=True),
        # Public address only. There is no column here for a key, and there never
        # should be one.
        sa.Column("wallet_address", sa.String(length=64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("is_blocked", sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_users_telegram_id", "users", ["telegram_id"], unique=True)
    op.create_index("ix_users_wallet_address", "users", ["wallet_address"])

    op.create_table(
        "refresh_tokens",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        # SHA-256 of the token. The plaintext exists only on the client.
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("family_id", sa.Uuid(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("rotated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_refresh_tokens_user_id", "refresh_tokens", ["user_id"])
    op.create_index(
        "ix_refresh_tokens_token_hash", "refresh_tokens", ["token_hash"], unique=True
    )
    op.create_index("ix_refresh_tokens_family_id", "refresh_tokens", ["family_id"])
    # Covers the family-revocation query, which runs on every detected token
    # reuse and has to be fast enough to be worth doing synchronously.
    op.create_index(
        "ix_refresh_family_active", "refresh_tokens", ["family_id", "revoked_at"]
    )

    op.create_table(
        "wallet_challenges",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("nonce", sa.String(length=64), nullable=False),
        sa.Column("address", sa.String(length=64), nullable=False),
        sa.Column("message", sa.String(length=1024), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_wallet_challenges_user_id", "wallet_challenges", ["user_id"])
    op.create_index(
        "ix_wallet_challenges_nonce", "wallet_challenges", ["nonce"], unique=True
    )
    op.create_index(
        "ix_wallet_challenges_expires_at", "wallet_challenges", ["expires_at"]
    )

    _create_bot_menu_messages()


def _create_bot_menu_messages() -> None:
    """Split out so the already-migrated path can reach it.

    This table is newer than the other three — a deployment built by `create_all`
    before it existed will have the rest and not this one.
    """
    op.create_table(
        "bot_menu_messages",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("chat_id", sa.BigInteger(), nullable=False),
        sa.Column("message_id", sa.BigInteger(), nullable=False),
        sa.Column("shows_wallet_linked", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )


def downgrade() -> None:
    op.drop_table("bot_menu_messages")
    op.drop_index("ix_wallet_challenges_expires_at", table_name="wallet_challenges")
    op.drop_index("ix_wallet_challenges_nonce", table_name="wallet_challenges")
    op.drop_index("ix_wallet_challenges_user_id", table_name="wallet_challenges")
    op.drop_table("wallet_challenges")
    op.drop_index("ix_refresh_family_active", table_name="refresh_tokens")
    op.drop_index("ix_refresh_tokens_family_id", table_name="refresh_tokens")
    op.drop_index("ix_refresh_tokens_token_hash", table_name="refresh_tokens")
    op.drop_index("ix_refresh_tokens_user_id", table_name="refresh_tokens")
    op.drop_table("refresh_tokens")
    op.drop_index("ix_users_wallet_address", table_name="users")
    op.drop_index("ix_users_telegram_id", table_name="users")
    op.drop_table("users")
