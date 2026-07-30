from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user
from app.db import get_session
from app.models import GameRecord, User

router = APIRouter(prefix="/games", tags=["games"])


class Game(BaseModel):
    slug: str
    title: str
    tagline: str
    # Origin the build is served from. The shell iframes this and accepts
    # postMessage only from this origin — so one game per origin, always, and
    # never two games pointed at the same one.
    embed_url: str
    accent: str
    status: str  # "live" | "soon"


def _to_out(record: GameRecord) -> Game:
    return Game(
        slug=record.slug,
        title=record.title,
        tagline=record.tagline,
        embed_url=record.embed_url,
        accent=record.accent,
        status=record.status,
    )


async def visible_games(session: AsyncSession) -> list[GameRecord]:
    """Everything a player may see, in display order.

    Excludes "hidden", which is what makes a broken game a thirty-second problem:
    flip the status and it leaves the catalogue immediately, with the row intact
    so it can be restored without re-entering anything.
    """
    result = await session.scalars(
        select(GameRecord)
        .where(GameRecord.status != "hidden")
        .order_by(GameRecord.sort_order, GameRecord.title)
    )
    return list(result)


@router.get("", response_model=list[Game])
async def list_games(
    _: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> list[Game]:
    return [_to_out(record) for record in await visible_games(session)]


@router.get("/{slug}", response_model=Game)
async def get_game(
    slug: str,
    _: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Game:
    record = await session.scalar(
        select(GameRecord).where(GameRecord.slug == slug)
    )

    # A hidden game is a 404 to a player, not a 403. Distinguishing the two would
    # confirm the slug exists, and the difference is of no use to anyone who is
    # allowed to play it.
    if record is None or record.status == "hidden":
        raise HTTPException(status_code=404, detail="No such game.")

    return _to_out(record)
