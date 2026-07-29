"""Alembic environment.

The URL comes from `app.config`, not from alembic.ini, so a migration is applied
to the same database the app talks to by construction. A duplicated URL is the
mistake this avoids: the two drift, and the symptom is a migration that reports
success against the wrong database.

Runs async because the app's engine is async — `create_async_engine` with the
asyncpg driver. Alembic's own machinery is synchronous, so the connection is
handed over via `run_sync`.
"""

from __future__ import annotations

import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from app.config import get_settings

# Imported for the side effect of registering every model on Base.metadata.
# Without it autogenerate sees an empty schema and cheerfully proposes dropping
# all your tables.
from app import models  # noqa: F401
from app.models import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _url() -> str:
    # Already normalised to an async driver by the Settings validator, so a
    # provider-supplied postgresql:// URL works here unchanged.
    return get_settings().database_url


def run_migrations_offline() -> None:
    """Emit SQL to stdout instead of executing it.

    Useful when a production database is behind a review process and the change
    has to be handed over as a script: `alembic upgrade head --sql`.
    """
    context.configure(
        url=_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def _run(connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        # Without this a changed column type is invisible to autogenerate, which
        # is a silent way to let the model and the schema disagree.
        compare_type=True,
        # SQLite cannot ALTER most things in place. Batch mode rebuilds the table
        # instead, which keeps local development on SQLite usable even though
        # production is Postgres.
        render_as_batch=_url().startswith("sqlite"),
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_migrations_online() -> None:
    engine = create_async_engine(_url(), poolclass=NullPool)
    async with engine.connect() as connection:
        await connection.run_sync(_run)
    await engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    asyncio.run(run_migrations_online())
