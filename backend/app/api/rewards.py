"""Player reward balance and safe Gamer Token claim endpoints."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user
from app.config import Settings, get_settings
from app.db import get_session
from app.models import RewardAccount, RewardClaim, User
from app.token_payout import PayoutError, payout_is_configured, send_gamer_tokens

router = APIRouter(prefix="/rewards", tags=["rewards"])


class RewardSummaryOut(BaseModel):
    available_amount: int
    pending_amount: int
    lifetime_earned: int
    lifetime_claimed: int
    token_symbol: str
    wallet_address: str | None
    claims_enabled: bool
    minimum_claim: int
    can_claim: bool


class ClaimOut(BaseModel):
    claim_id: uuid.UUID
    amount: int
    token_symbol: str
    wallet_address: str
    status: str
    signature: str | None
    explorer_url: str | None
    message: str


def _configured(settings: Settings) -> bool:
    return payout_is_configured(
        mint=settings.gamer_token_mint,
        treasury_keypair=settings.gamer_treasury_keypair,
        enabled=settings.rewards_claims_enabled,
    )


def _explorer_url(signature: str | None, rpc_url: str) -> str | None:
    if not signature:
        return None
    suffix = "?cluster=devnet" if "devnet" in rpc_url.lower() else ""
    return f"https://explorer.solana.com/tx/{signature}{suffix}"


async def _pending_amount(user_id: uuid.UUID, session: AsyncSession) -> int:
    amount = await session.scalar(
        select(func.coalesce(func.sum(RewardClaim.amount), 0)).where(
            RewardClaim.user_id == user_id,
            RewardClaim.status.in_(("pending", "submitted")),
        )
    )
    return int(amount or 0)


def _claim_out(claim: RewardClaim, settings: Settings) -> ClaimOut:
    if claim.status == "confirmed":
        message = "Gamer Tokens were sent to your linked wallet."
    elif claim.status == "submitted":
        message = "Transfer submitted to Solana."
    else:
        message = "Claim is safely queued. No second claim will be created."

    return ClaimOut(
        claim_id=claim.id,
        amount=claim.amount,
        token_symbol=settings.gamer_token_symbol,
        wallet_address=claim.wallet_address,
        status=claim.status,
        signature=claim.signature,
        explorer_url=_explorer_url(claim.signature, settings.reward_rpc_url),
        message=message,
    )


async def reward_summary_for_user(
    user: User,
    session: AsyncSession,
    settings: Settings,
) -> RewardSummaryOut:
    account = await session.get(RewardAccount, user.id)
    available = account.available_amount if account else 0
    lifetime_earned = account.lifetime_earned if account else 0
    lifetime_claimed = account.lifetime_claimed if account else 0
    enabled = _configured(settings)

    return RewardSummaryOut(
        available_amount=available,
        pending_amount=await _pending_amount(user.id, session),
        lifetime_earned=lifetime_earned,
        lifetime_claimed=lifetime_claimed,
        token_symbol=settings.gamer_token_symbol,
        wallet_address=user.wallet_address,
        claims_enabled=enabled,
        minimum_claim=settings.reward_min_claim,
        can_claim=bool(
            enabled
            and user.wallet_address
            and available >= settings.reward_min_claim
        ),
    )


async def claim_for_user(
    user: User,
    session: AsyncSession,
    settings: Settings,
) -> ClaimOut:
    """Debit once, then send once from the dedicated reward treasury."""
    if not user.wallet_address:
        raise HTTPException(status_code=409, detail="Connect a wallet before claiming.")
    if not _configured(settings):
        raise HTTPException(
            status_code=503,
            detail="Gamer Token claims are not enabled yet.",
        )

    existing = await session.scalar(
        select(RewardClaim)
        .where(
            RewardClaim.user_id == user.id,
            RewardClaim.status.in_(("pending", "submitted")),
        )
        .order_by(RewardClaim.created_at.desc())
    )
    if existing is not None:
        return _claim_out(existing, settings)

    account = await session.scalar(
        select(RewardAccount)
        .where(RewardAccount.user_id == user.id)
        .with_for_update()
    )
    amount = account.available_amount if account else 0
    if amount < settings.reward_min_claim:
        raise HTTPException(
            status_code=409,
            detail=f"Earn at least {settings.reward_min_claim} {settings.gamer_token_symbol} before claiming.",
        )

    claim = RewardClaim(
        user_id=user.id,
        wallet_address=user.wallet_address,
        amount=amount,
        status="pending",
    )
    session.add(claim)
    account.available_amount = 0
    account.lifetime_claimed += amount
    await session.flush()

    # Commit the debit and claim id before any on-chain submission. If the
    # network response is lost after accepting a transaction, a retry returns
    # this same claim instead of paying twice.
    await session.commit()

    try:
        signature = await send_gamer_tokens(
            rpc_url=settings.reward_rpc_url,
            mint_address=settings.gamer_token_mint,
            treasury_keypair=settings.gamer_treasury_keypair,
            destination_wallet=claim.wallet_address,
            whole_tokens=claim.amount,
        )
    except PayoutError as exc:
        claim.last_error = str(exc)
        await session.commit()
        return _claim_out(claim, settings)

    now = datetime.now(timezone.utc)
    claim.signature = signature
    claim.status = "confirmed"
    claim.submitted_at = now
    claim.confirmed_at = now
    claim.last_error = None
    await session.commit()
    return _claim_out(claim, settings)


@router.get("", response_model=RewardSummaryOut)
async def reward_summary(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> RewardSummaryOut:
    return await reward_summary_for_user(user, session, settings)


@router.post("/claim", response_model=ClaimOut)
async def claim_rewards(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> ClaimOut:
    return await claim_for_user(user, session, settings)