from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user
from app.config import Settings, get_settings
from app.db import get_session
from app.models import RefreshToken, User
from app.security import debug_capture
from app.security.rate_limit import login_limiter, rate_limit
from app.security.telegram_auth import (
    InitDataError,
    ReplayGuard,
    validate_init_data,
)
from app.security.tokens import (
    generate_refresh_token,
    hash_refresh_token,
    issue_access_token,
    refresh_expiry,
)

router = APIRouter(prefix="/auth", tags=["auth"])

logger = logging.getLogger("sga.auth")

# Process-local. Replace with Redis before scaling past one worker.
_replay_guard = ReplayGuard()

ISSUER = "sga-platform"


class LoginRequest(BaseModel):
    init_data: str = Field(min_length=1, max_length=8192)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=1, max_length=512)


class UserOut(BaseModel):
    id: uuid.UUID
    telegram_id: int
    display_name: str
    username: str | None
    photo_url: str | None
    wallet_address: str | None


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int
    user: UserOut


def _to_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        telegram_id=user.telegram_id,
        display_name=user.display_name,
        username=user.username,
        photo_url=user.photo_url,
        wallet_address=user.wallet_address,
    )


async def _issue_pair(
    session: AsyncSession,
    user: User,
    settings: Settings,
    *,
    family_id: uuid.UUID | None = None,
) -> TokenPair:
    access_token, expires_in = issue_access_token(
        user_id=user.id, secret=settings.jwt_secret, issuer=ISSUER
    )
    plaintext, token_hash = generate_refresh_token()
    session.add(
        RefreshToken(
            user_id=user.id,
            token_hash=token_hash,
            family_id=family_id or uuid.uuid4(),
            expires_at=refresh_expiry(),
        )
    )
    await session.flush()
    return TokenPair(
        access_token=access_token,
        refresh_token=plaintext,
        expires_in=expires_in,
        user=_to_out(user),
    )


async def authenticate_telegram_user(
    init_data: str,
    *,
    session: AsyncSession,
    settings: Settings,
) -> User:
    """Validate Telegram identity and return the corresponding platform user."""
    try:
        data = validate_init_data(
            init_data,
            bot_token=settings.bot_token,
            max_age_seconds=settings.initdata_max_age,
        )
    except InitDataError as exc:
        logger.warning("initData rejected: %s", exc)
        debug_capture.capture(init_data)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not verify your Telegram session. Reopen the app.",
        ) from exc

    if _replay_guard.seen(data.hash):
        logger.info(
            "initData replayed for telegram_id=%s - issuing a new session",
            data.user.id,
        )

    tg = data.user
    user = await session.scalar(select(User).where(User.telegram_id == tg.id))
    if user is None:
        user = User(telegram_id=tg.id)
        session.add(user)

    user.username = tg.username
    user.first_name = tg.first_name
    user.last_name = tg.last_name
    user.language_code = tg.language_code
    user.is_premium = tg.is_premium
    user.photo_url = tg.photo_url
    user.last_seen_at = datetime.now(timezone.utc)
    await session.flush()

    if user.is_blocked:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account is suspended.",
        )

    return user


@router.post(
    "/telegram",
    response_model=TokenPair,
    dependencies=[Depends(rate_limit(login_limiter))],
)
async def login_with_telegram(
    body: LoginRequest,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> TokenPair:
    """Exchange verified Telegram initData for a full platform session."""
    user = await authenticate_telegram_user(
        body.init_data,
        session=session,
        settings=settings,
    )
    return await _issue_pair(session, user, settings)

@router.post(
    "/refresh",
    response_model=TokenPair,
    dependencies=[Depends(rate_limit(login_limiter))],
)
async def rotate_refresh_token(
    body: RefreshRequest,
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> TokenPair:
    token_hash = hash_refresh_token(body.refresh_token)
    stored = await session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == token_hash)
    )

    if stored is None:
        raise HTTPException(status_code=401, detail="Session expired. Reopen the app.")

    if not stored.is_usable:
        # A rotated or revoked token being presented means someone is holding
        # a copy they should not have. Kill every token in the family.
        await session.execute(
            update(RefreshToken)
            .where(
                RefreshToken.family_id == stored.family_id,
                RefreshToken.revoked_at.is_(None),
            )
            .values(revoked_at=datetime.now(timezone.utc))
        )
        # Commit explicitly. HTTPException is still an Exception, so the
        # session dependency would roll this revocation back on the way out —
        # which would leave the stolen token working.
        await session.commit()
        raise HTTPException(status_code=401, detail="Session expired. Reopen the app.")

    stored.rotated_at = datetime.now(timezone.utc)

    user = await session.get(User, stored.user_id)
    if user is None or user.is_blocked:
        raise HTTPException(status_code=403, detail="This account is unavailable.")

    user.last_seen_at = datetime.now(timezone.utc)
    return await _issue_pair(session, user, settings, family_id=stored.family_id)


@router.post(
    "/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def logout(
    body: RefreshRequest,
    session: AsyncSession = Depends(get_session),
) -> Response:
    token_hash = hash_refresh_token(body.refresh_token)
    stored = await session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == token_hash)
    )
    if stored is not None:
        await session.execute(
            update(RefreshToken)
            .where(
                RefreshToken.family_id == stored.family_id,
                RefreshToken.revoked_at.is_(None),
            )
            .values(revoked_at=datetime.now(timezone.utc))
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(current_user)) -> UserOut:
    return _to_out(user)
