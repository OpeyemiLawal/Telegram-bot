"""Games move from a Python list into the database

Revision ID: 0002_games
Revises: 0001_baseline
Create Date: 2026-07-30

Seeds the table with the four games that were hard-coded, so the catalogue is
identical the moment this lands. A migration that creates an empty table would
technically succeed and take every game off the platform until someone noticed.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002_games"
down_revision: Union[str, None] = "0001_baseline"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Mirrors app/api/games.py at the moment of the move. Copied rather than
# imported: a migration has to keep working when the application code it came
# from has changed underneath it, and importing live code makes the history
# depend on the present.
SEED = [
    ("tap-rush", "Tap Rush", "Tap the circle before it vanishes. Twenty seconds.",
     "https://sga-test-game.vercel.app", "#C89B3C", "live", 10),
    ("orbit-runner", "Orbit Runner", "Endless runner. Bank your streak or lose it.",
     "https://orbit-runner.vercel.app", "#C89B3C", "live", 20),
    ("slot-mine", "Slot Mine", "Three matching cores pays out.",
     "https://slot-mine.vercel.app", "#7FD4B0", "live", 30),
    ("tower-drop", "Tower Drop", "Stack blocks. Every level raises the multiplier.",
     "https://tower-drop.vercel.app", "#8FA8FF", "soon", 40),
]


def upgrade() -> None:
    games = op.create_table(
        "games",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("slug", sa.String(length=64), nullable=False),
        sa.Column("title", sa.String(length=120), nullable=False),
        sa.Column("tagline", sa.String(length=240), nullable=False),
        sa.Column("embed_url", sa.String(length=512), nullable=False),
        sa.Column("accent", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_games_slug", "games", ["slug"], unique=True)
    op.create_index("ix_games_status", "games", ["status"])

    now = datetime.now(timezone.utc)
    op.bulk_insert(
        games,
        [
            {
                "id": uuid.uuid4(),
                "slug": slug,
                "title": title,
                "tagline": tagline,
                "embed_url": embed_url,
                "accent": accent,
                "status": status,
                "sort_order": sort_order,
                "created_at": now,
                "updated_at": now,
            }
            for slug, title, tagline, embed_url, accent, status, sort_order in SEED
        ],
    )


def downgrade() -> None:
    op.drop_index("ix_games_status", table_name="games")
    op.drop_index("ix_games_slug", table_name="games")
    op.drop_table("games")
