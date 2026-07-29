from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import get_settings
from app.models import Base

_settings = get_settings()

engine = create_async_engine(
    _settings.database_url,
    echo=False,
    pool_pre_ping=True,
)

SessionMaker = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def create_schema() -> None:
    """Build the schema directly from the models. Tests and local work only.

    Superseded by Alembic for anything deployed — see `migrations/`. Kept because
    it is genuinely the right tool for a test suite, which wants a schema built
    and dropped per run and has no interest in the history that produced it.

    Refuses to run in production rather than being merely discouraged there. The
    two mechanisms disagreeing is the failure worth preventing: `create_all` never
    alters an existing table, so a model change would appear to succeed on a fresh
    database and do nothing at all to the deployed one, with no error either time.
    """
    if _settings.is_production:
        raise RuntimeError(
            "create_schema() is not for production — run `alembic upgrade head`."
        )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionMaker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
