"""Server-tracked game rewards and Solana claims

Revision ID: 0003_rewards
Revises: 0002_games
Create Date: 2026-08-01
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003_rewards"
down_revision: Union[str, None] = "0002_games"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "reward_accounts",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("available_amount", sa.BigInteger(), nullable=False),
        sa.Column("lifetime_earned", sa.BigInteger(), nullable=False),
        sa.Column("lifetime_claimed", sa.BigInteger(), nullable=False),
        sa.Column("daily_earned", sa.BigInteger(), nullable=False),
        sa.Column("daily_window_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )

    op.create_table(
        "game_reward_rounds",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("game_id", sa.Uuid(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accepted_taps", sa.Integer(), nullable=False),
        sa.Column("last_client_elapsed_ms", sa.Integer(), nullable=False),
        sa.Column("last_tap_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("awarded_amount", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(["game_id"], ["games.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_game_reward_rounds_user_id", "game_reward_rounds", ["user_id"])
    op.create_index("ix_game_reward_rounds_game_id", "game_reward_rounds", ["game_id"])
    op.create_index("ix_game_reward_rounds_expires_at", "game_reward_rounds", ["expires_at"])

    op.create_table(
        "reward_claims",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("wallet_address", sa.String(length=64), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("signature", sa.String(length=128), nullable=True),
        sa.Column("last_error", sa.String(length=240), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_reward_claims_user_id", "reward_claims", ["user_id"])
    op.create_index("ix_reward_claims_status", "reward_claims", ["status"])
    op.create_index("ix_reward_claims_signature", "reward_claims", ["signature"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_reward_claims_signature", table_name="reward_claims")
    op.drop_index("ix_reward_claims_status", table_name="reward_claims")
    op.drop_index("ix_reward_claims_user_id", table_name="reward_claims")
    op.drop_table("reward_claims")
    op.drop_index("ix_game_reward_rounds_expires_at", table_name="game_reward_rounds")
    op.drop_index("ix_game_reward_rounds_game_id", table_name="game_reward_rounds")
    op.drop_index("ix_game_reward_rounds_user_id", table_name="game_reward_rounds")
    op.drop_table("game_reward_rounds")
    op.drop_table("reward_accounts")