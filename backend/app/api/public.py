"""Endpoints served without a session.

There is one, and it exists because of a bootstrapping problem: the Mini App's
Content-Security-Policy has to name every origin allowed to be framed, and that
header is written before any user has signed in. It cannot be behind auth.

Nothing sensitive is exposed. These origins are already visible in the iframe
`src` of every game a player opens, and they are public web addresses serving
public builds. What the list reveals is which games exist, which the catalogue
tells you anyway.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.games import visible_games
from app.db import get_session

router = APIRouter(prefix="/public", tags=["public"])


class GameOrigins(BaseModel):
    origins: list[str]


@router.get("/game-origins", response_model=GameOrigins)
async def game_origins(
    response: Response,
    session: AsyncSession = Depends(get_session),
) -> GameOrigins:
    """Origins the Mini App may frame.

    Cached for a minute at the edge, and served stale for an hour while a fresh
    copy is fetched. That trade is deliberate: this is on the critical path of
    every page load, and a request that waits on a sleeping database to compute a
    security header is a page that does not render.

    A minute is also the honest cost of adding a game — new games appear in the
    catalogue immediately but cannot be framed until this expires. Better than
    the alternative it replaces, which was a frontend rebuild.
    """
    response.headers["Cache-Control"] = (
        "public, max-age=60, stale-while-revalidate=3600"
    )

    origins: list[str] = []
    for record in await visible_games(session):
        origin = record.embed_url.rstrip("/")
        if origin not in origins:
            origins.append(origin)

    return GameOrigins(origins=origins)
