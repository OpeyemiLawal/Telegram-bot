"""Catalogue management.

The point of this module is that adding a game stops being a deployment. A game
becomes a row: created from a form, edited in place, hidden in seconds when it
misbehaves. At two hundred games that difference is the difference between a
platform and a repository.

Authorisation is an allowlist of Telegram ids from configuration. Every endpoint
here goes through `admin_user`, which builds on the same verified session as the
rest of the API — an admin is a signed-in player whose id happens to appear in
the list, not a separate credential to be leaked.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user
from app.config import Settings, get_settings
from app.db import get_session
from app.models import GameRecord, User

router = APIRouter(prefix="/admin", tags=["admin"])

STATUSES = {"live", "soon", "hidden"}
_SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$")
_HEX_COLOUR = re.compile(r"^#[0-9A-Fa-f]{6}$")


async def admin_user(
    user: User = Depends(current_user),
    settings: Settings = Depends(get_settings),
) -> User:
    """A verified player whose Telegram id is on the allowlist.

    404, not 403. A 403 confirms the admin API exists and that this account is
    simply not on the list, which is a fact worth nothing to the owner and
    something to an attacker enumerating endpoints.
    """
    if user.telegram_id not in settings.admin_ids:
        raise HTTPException(status_code=404, detail="Not found.")
    return user


class GameIn(BaseModel):
    slug: str = Field(min_length=3, max_length=64)
    title: str = Field(min_length=1, max_length=120)
    tagline: str = Field(default="", max_length=240)
    embed_url: str = Field(min_length=8, max_length=512)
    accent: str = Field(default="#C89B3C")
    status: str = Field(default="soon")
    sort_order: int = Field(default=100, ge=0, le=100_000)

    @field_validator("slug")
    @classmethod
    def _clean_slug(cls, value: str) -> str:
        value = value.strip().lower()
        if not _SLUG.match(value):
            raise ValueError(
                "slug must be lowercase letters, digits and hyphens, and may not "
                "start or end with a hyphen"
            )
        return value

    @field_validator("embed_url")
    @classmethod
    def _https_origin(cls, value: str) -> str:
        """https, and an origin rather than a page.

        A path here would be quietly wrong rather than broken: the iframe would
        load, and the bridge — which compares origins — would still work. The
        damage shows up later, when a second game is added under the same host
        and the two become indistinguishable to the bridge. Rejecting the path
        now is what keeps "one game, one origin" true by construction.
        """
        value = value.strip().rstrip("/")

        if not value.startswith("https://"):
            raise ValueError("embed_url must start with https://")

        remainder = value[len("https://") :]
        if "/" in remainder:
            raise ValueError(
                "embed_url must be an origin with no path, e.g. https://my-game.vercel.app"
            )
        if not remainder:
            raise ValueError("embed_url is missing a host")

        return value

    @field_validator("accent")
    @classmethod
    def _colour(cls, value: str) -> str:
        value = value.strip()
        if not _HEX_COLOUR.match(value):
            raise ValueError("accent must be a hex colour such as #C89B3C")
        return value

    @field_validator("status")
    @classmethod
    def _status(cls, value: str) -> str:
        value = value.strip().lower()
        if value not in STATUSES:
            raise ValueError(f"status must be one of {sorted(STATUSES)}")
        return value


class GameOut(GameIn):
    pass


def _to_out(record: GameRecord) -> GameOut:
    return GameOut(
        slug=record.slug,
        title=record.title,
        tagline=record.tagline,
        embed_url=record.embed_url,
        accent=record.accent,
        status=record.status,
        sort_order=record.sort_order,
    )


@router.get("/games", response_model=list[GameOut])
async def list_all_games(
    _: User = Depends(admin_user),
    session: AsyncSession = Depends(get_session),
) -> list[GameOut]:
    """Every game, hidden ones included — the point of the admin view."""
    result = await session.scalars(
        select(GameRecord).order_by(GameRecord.sort_order, GameRecord.title)
    )
    return [_to_out(record) for record in result]


@router.post("/games", response_model=GameOut, status_code=status.HTTP_201_CREATED)
async def create_game(
    body: GameIn,
    _: User = Depends(admin_user),
    session: AsyncSession = Depends(get_session),
) -> GameOut:
    existing = await session.scalar(
        select(GameRecord).where(GameRecord.slug == body.slug)
    )
    if existing is not None:
        raise HTTPException(status_code=409, detail="That slug is already taken.")

    # One origin per game, enforced rather than documented. Two games sharing an
    # origin cannot be told apart by the bridge, so a bug in either becomes a bug
    # in both — and at two hundred games this is exactly the kind of collision
    # that happens by accident.
    clash = await session.scalar(
        select(GameRecord).where(GameRecord.embed_url == body.embed_url)
    )
    if clash is not None:
        raise HTTPException(
            status_code=409,
            detail=f"That origin already belongs to '{clash.slug}'. Give each game its own.",
        )

    record = GameRecord(**body.model_dump())
    session.add(record)
    await session.flush()
    return _to_out(record)


@router.put("/games/{slug}", response_model=GameOut)
async def update_game(
    slug: str,
    body: GameIn,
    _: User = Depends(admin_user),
    session: AsyncSession = Depends(get_session),
) -> GameOut:
    record = await session.scalar(select(GameRecord).where(GameRecord.slug == slug))
    if record is None:
        raise HTTPException(status_code=404, detail="No such game.")

    if body.slug != slug:
        taken = await session.scalar(
            select(GameRecord).where(GameRecord.slug == body.slug)
        )
        if taken is not None:
            raise HTTPException(status_code=409, detail="That slug is already taken.")

    clash = await session.scalar(
        select(GameRecord).where(
            GameRecord.embed_url == body.embed_url,
            GameRecord.id != record.id,
        )
    )
    if clash is not None:
        raise HTTPException(
            status_code=409,
            detail=f"That origin already belongs to '{clash.slug}'. Give each game its own.",
        )

    for field, value in body.model_dump().items():
        setattr(record, field, value)

    await session.flush()
    return _to_out(record)


@router.delete(
    "/games/{slug}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_game(
    slug: str,
    _: User = Depends(admin_user),
    session: AsyncSession = Depends(get_session),
) -> Response:
    """Deletes for real.

    Hiding is what you almost always want — `status: "hidden"` takes a game out
    of the catalogue instantly and keeps the row. This exists for the case where
    a game was entered wrongly and should never have had a row at all.
    """
    record = await session.scalar(select(GameRecord).where(GameRecord.slug == slug))
    if record is None:
        raise HTTPException(status_code=404, detail="No such game.")

    await session.delete(record)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
