from __future__ import annotations

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import get_session
from app.models import User
from app.security.tokens import TokenError, read_access_token

_bearer = HTTPBearer(auto_error=False)

_UNAUTHORIZED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Sign in again.",
    headers={"WWW-Authenticate": "Bearer"},
)


async def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> User:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _UNAUTHORIZED

    try:
        user_id = read_access_token(
            credentials.credentials, secret=settings.jwt_secret, issuer="sga-platform"
        )
    except TokenError as exc:
        raise _UNAUTHORIZED from exc

    user = await session.get(User, user_id)
    if user is None or user.is_blocked:
        raise _UNAUTHORIZED

    return user
