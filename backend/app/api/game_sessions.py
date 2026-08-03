"""Restricted authentication for games opened directly from Telegram."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import authenticate_telegram_user
from app.config import Settings, get_settings
from app.db import get_session
from app.models import GameRecord, User
from app.security.rate_limit import login_limiter, rate_limit
from app.security.tokens import (
    TokenError,
    issue_game_token,
    read_game_token,
)

router = APIRouter(prefix="/game", tags=["game"])
_bearer = HTTPBearer(auto_error=False)
GAME_ISSUER = "sga-game"


class GameLoginRequest(BaseModel):
    init_data: str = Field(min_length=1, max_length=8192)
    game_slug: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9-]+$")


class GamePlayerOut(BaseModel):
    display_name: str
    wallet_address: str | None


class GameSessionOut(BaseModel):
    game_slug: str
    player: GamePlayerOut


class GameLoginOut(GameSessionOut):
    access_token: str
    expires_in: int


@dataclass(frozen=True)
class GameSession:
    user: User
    game: GameRecord


def _player(user: User) -> GamePlayerOut:
    return GamePlayerOut(
        display_name=user.display_name,
        wallet_address=user.wallet_address,
    )


def _origin(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}".lower()


def _require_registered_origin(request: Request, game: GameRecord) -> None:
    request_origin = (request.headers.get("origin") or "").rstrip("/").lower()
    if not request_origin or request_origin != _origin(game.embed_url):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This game origin is not registered.",
        )


async def _live_game(slug: str, session: AsyncSession) -> GameRecord:
    game = await session.scalar(
        select(GameRecord).where(
            GameRecord.slug == slug,
            GameRecord.status == "live",
        )
    )
    if game is None:
        raise HTTPException(status_code=404, detail="No such live game.")
    return game


@router.post(
    "/auth",
    response_model=GameLoginOut,
    dependencies=[Depends(rate_limit(login_limiter))],
)
async def login_game(
    body: GameLoginRequest,
    request: Request,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> GameLoginOut:
    """Verify Telegram directly on the game's origin and issue one scoped token."""
    game = await _live_game(body.game_slug, session)
    _require_registered_origin(request, game)

    user = await authenticate_telegram_user(
        body.init_data,
        session=session,
        settings=settings,
    )
    token, expires_in = issue_game_token(
        user_id=user.id,
        game_slug=game.slug,
        secret=settings.jwt_secret,
        issuer=GAME_ISSUER,
    )
    return GameLoginOut(
        access_token=token,
        expires_in=expires_in,
        game_slug=game.slug,
        player=_player(user),
    )


async def current_game_session(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> GameSession:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Open one of the SGA games from Telegram.")

    try:
        claims = read_game_token(
            credentials.credentials,
            secret=settings.jwt_secret,
            issuer=GAME_ISSUER,
        )
    except TokenError as exc:
        raise HTTPException(status_code=401, detail="Open one of the SGA games from Telegram.") from exc

    game = await _live_game(claims.game_slug, session)
    _require_registered_origin(request, game)

    user = await session.get(User, claims.user_id)
    if user is None or user.is_blocked:
        raise HTTPException(status_code=401, detail="Open one of the SGA games from Telegram.")

    return GameSession(user=user, game=game)


@router.get("/session", response_model=GameSessionOut)
async def game_session(
    active: GameSession = Depends(current_game_session),
) -> GameSessionOut:
    return GameSessionOut(
        game_slug=active.game.slug,
        player=_player(active.user),
    )
