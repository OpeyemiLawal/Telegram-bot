"""Server-tracked Gamer Token earning for direct Telegram games."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.game_sessions import GameSession, current_game_session
from app.api.rewards import (
    ClaimOut,
    RewardSummaryOut,
    claim_for_user,
    reward_summary_for_user,
)
from app.config import Settings, get_settings
from app.db import get_session
from app.models import GameRewardRound, RewardAccount, User

router = APIRouter(prefix="/game/rewards", tags=["game-rewards"])

ROUND_SECONDS = 20
TAPS_PER_REWARD = 5
TOKENS_PER_REWARD = 100
MIN_CLIENT_TAP_INTERVAL_MS = 80
MIN_SERVER_TAP_INTERVAL_MS = 40
MAX_TAPS_PER_ROUND = 100
CLIENT_CLOCK_LEEWAY_MS = 1_500


class RewardRulesOut(BaseModel):
    taps_per_reward: int = TAPS_PER_REWARD
    tokens_per_reward: int = TOKENS_PER_REWARD
    round_seconds: int = ROUND_SECONDS
    daily_cap: int


class RoundOut(BaseModel):
    round_id: uuid.UUID
    rules: RewardRulesOut
    available_amount: int
    token_symbol: str


class TapRequest(BaseModel):
    sequence: int = Field(ge=1, le=MAX_TAPS_PER_ROUND)
    elapsed_ms: int = Field(ge=0, le=(ROUND_SECONDS + 2) * 1000)


class TapOut(BaseModel):
    accepted_taps: int
    tap_progress: int
    earned_now: int
    available_amount: int
    daily_remaining: int
    token_symbol: str


@router.get("", response_model=RewardSummaryOut)
async def game_reward_summary(
    active: GameSession = Depends(current_game_session),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> RewardSummaryOut:
    """Expose only reward state needed by the registered game origin."""
    return await reward_summary_for_user(active.user, session, settings)


@router.post("/claim", response_model=ClaimOut)
async def claim_game_rewards(
    active: GameSession = Depends(current_game_session),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> ClaimOut:
    """Pay earned rewards only to the wallet already linked to this player."""
    return await claim_for_user(active.user, session, settings)


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _reset_daily_if_needed(account: RewardAccount, now: datetime) -> None:
    if _as_utc(account.daily_window_start).date() != now.date():
        account.daily_window_start = now
        account.daily_earned = 0


async def _locked_account(
    user_id: uuid.UUID,
    session: AsyncSession,
    now: datetime,
) -> RewardAccount:
    account = await session.scalar(
        select(RewardAccount)
        .where(RewardAccount.user_id == user_id)
        .with_for_update()
    )
    if account is None:
        # Serialize first-time account creation on the existing user row. Two
        # simultaneous game launches must not race into the same primary key.
        await session.scalar(
            select(User.id).where(User.id == user_id).with_for_update()
        )
        account = await session.get(RewardAccount, user_id)
        if account is None:
            account = RewardAccount(user_id=user_id, daily_window_start=now)
            session.add(account)
            await session.flush()
    _reset_daily_if_needed(account, now)
    return account


@router.post("/rounds", response_model=RoundOut)
async def start_reward_round(
    active: GameSession = Depends(current_game_session),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> RoundOut:
    """Start the only reward-eligible round for this player and game."""
    now = datetime.now(timezone.utc)
    await session.execute(
        update(GameRewardRound)
        .where(
            GameRewardRound.user_id == active.user.id,
            GameRewardRound.game_id == active.game.id,
            GameRewardRound.closed_at.is_(None),
        )
        .values(closed_at=now)
    )

    account = await _locked_account(active.user.id, session, now)
    reward_round = GameRewardRound(
        user_id=active.user.id,
        game_id=active.game.id,
        started_at=now,
        expires_at=now + timedelta(seconds=ROUND_SECONDS),
    )
    session.add(reward_round)
    await session.flush()

    return RoundOut(
        round_id=reward_round.id,
        rules=RewardRulesOut(daily_cap=settings.reward_daily_cap),
        available_amount=account.available_amount,
        token_symbol=settings.gamer_token_symbol,
    )


@router.post("/rounds/{round_id}/taps", response_model=TapOut)
async def record_rewarded_tap(
    round_id: uuid.UUID,
    body: TapRequest,
    active: GameSession = Depends(current_game_session),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> TapOut:
    """Accept one ordered, plausibly timed tap and award each fifth one."""
    now = datetime.now(timezone.utc)
    reward_round = await session.scalar(
        select(GameRewardRound)
        .where(
            GameRewardRound.id == round_id,
            GameRewardRound.user_id == active.user.id,
            GameRewardRound.game_id == active.game.id,
        )
        .with_for_update()
    )
    if reward_round is None:
        raise HTTPException(status_code=404, detail="Reward round not found.")

    if reward_round.closed_at is not None or _as_utc(reward_round.expires_at) < now:
        raise HTTPException(status_code=409, detail="Reward round has ended.")

    expected = reward_round.accepted_taps + 1
    if body.sequence != expected:
        raise HTTPException(
            status_code=409,
            detail=f"Expected tap {expected}.",
        )

    if (
        reward_round.accepted_taps > 0
        and body.elapsed_ms - reward_round.last_client_elapsed_ms
        < MIN_CLIENT_TAP_INTERVAL_MS
    ):
        raise HTTPException(status_code=409, detail="Tap arrived too quickly.")

    server_elapsed_ms = int(
        (now - _as_utc(reward_round.started_at)).total_seconds() * 1000
    )
    if body.elapsed_ms > server_elapsed_ms + CLIENT_CLOCK_LEEWAY_MS:
        raise HTTPException(status_code=409, detail="Tap timing is invalid.")

    if reward_round.last_tap_at is not None:
        server_gap_ms = int(
            (now - _as_utc(reward_round.last_tap_at)).total_seconds() * 1000
        )
        if server_gap_ms < MIN_SERVER_TAP_INTERVAL_MS:
            raise HTTPException(status_code=409, detail="Tap arrived too quickly.")

    reward_round.accepted_taps += 1
    reward_round.last_client_elapsed_ms = body.elapsed_ms
    reward_round.last_tap_at = now

    account = await _locked_account(active.user.id, session, now)
    earned_now = 0
    if reward_round.accepted_taps % TAPS_PER_REWARD == 0:
        remaining = max(0, settings.reward_daily_cap - account.daily_earned)
        if remaining >= TOKENS_PER_REWARD:
            earned_now = TOKENS_PER_REWARD
            account.available_amount += earned_now
            account.lifetime_earned += earned_now
            account.daily_earned += earned_now
            reward_round.awarded_amount += earned_now

    if reward_round.accepted_taps >= MAX_TAPS_PER_ROUND:
        reward_round.closed_at = now

    return TapOut(
        accepted_taps=reward_round.accepted_taps,
        tap_progress=reward_round.accepted_taps % TAPS_PER_REWARD,
        earned_now=earned_now,
        available_amount=account.available_amount,
        daily_remaining=max(0, settings.reward_daily_cap - account.daily_earned),
        token_symbol=settings.gamer_token_symbol,
    )