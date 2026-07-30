from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.api.deps import current_user
from app.models import User

router = APIRouter(prefix="/games", tags=["games"])


class Game(BaseModel):
    slug: str
    title: str
    tagline: str
    # Origin the Godot build is served from. The shell iframes this and will
    # only accept postMessage from an origin in this list — so keep one game
    # per origin and never point two games at the same one.
    embed_url: str
    accent: str
    status: str  # "live" | "soon"


# Hard-coded until there is a reason for a games table. Move to the DB when
# you need per-game config (payout rates, min stake, feature flags).
CATALOGUE: list[Game] = [
    # Not a game. A harness that exercises every bridge message and prints what
    # comes back, so the plumbing can be verified before any real game exists.
    #
    # Remove it before launch. It is listed here rather than hidden behind a flag
    # because a flag would be one more thing to get wrong, and an entry in a list
    # is hard to forget about — it is visible to every player who opens Games.
    Game(
        slug="bridge-test",
        title="Bridge Test",
        tagline="Internal: checks the game bridge end to end.",
        embed_url="https://sga-test-game.vercel.app",
        accent="#C89B3C",
        status="live",
    ),
    Game(
        slug="orbit-runner",
        title="Orbit Runner",
        tagline="Endless runner. Bank your streak or lose it.",
        embed_url="https://orbit-runner.vercel.app",
        accent="#C89B3C",
        status="live",
    ),
    Game(
        slug="slot-mine",
        title="Slot Mine",
        tagline="Three matching cores pays out.",
        embed_url="https://slot-mine.vercel.app",
        accent="#7FD4B0",
        status="live",
    ),
    Game(
        slug="tower-drop",
        title="Tower Drop",
        tagline="Stack blocks. Every level raises the multiplier.",
        embed_url="https://tower-drop.vercel.app",
        accent="#8FA8FF",
        status="soon",
    ),
]

_BY_SLUG = {game.slug: game for game in CATALOGUE}

ALLOWED_GAME_ORIGINS = frozenset(game.embed_url.rstrip("/") for game in CATALOGUE)


@router.get("", response_model=list[Game])
async def list_games(_: User = Depends(current_user)) -> list[Game]:
    return CATALOGUE


@router.get("/{slug}", response_model=Game)
async def get_game(slug: str, _: User = Depends(current_user)) -> Game:
    game = _BY_SLUG.get(slug)
    if game is None:
        raise HTTPException(status_code=404, detail="No such game.")
    return game
