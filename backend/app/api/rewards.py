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
    pending_error: str | None
    can_reset_pending: bool


class ClaimOut(BaseModel):
    claim_id: uuid.UUID
    amount: int
    token_symbol: str
    wallet_address: str
    status: str
    signature: str | None
    explorer_url: str | None
    message: str


class ResetClaimOut(BaseModel):
    restored_amount: int
    token_symbol: str
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


async def _latest_pending(
    user_id: uuid.UUID,
    session: AsyncSession,
    *,
    lock: bool = False,
) -> RewardClaim | None:
    query = (
        select(RewardClaim)
        .where(
            RewardClaim.user_id == user_id,
            RewardClaim.status.in_(("pending", "submitted")),
        )
        .order_by(RewardClaim.created_at.desc())
    )
    if lock:
        query = query.with_for_update()
    return await session.scalar(query)


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
        message = "Your SGA rewards have been airdropped to your linked wallet."
    elif claim.status == "submitted":
        message = "Transfer submitted to Solana."
    elif claim.last_error:
        message = "Transfer failed before confirmation. Reset this failed claim, then try again."
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
    pending_claim = await _latest_pending(user.id, session)
    resettable = bool(
        pending_claim
        and pending_claim.status == "pending"
        and pending_claim.signature is None
        and pending_claim.last_error
    )

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
        pending_error=pending_claim.last_error if pending_claim else None,
        can_reset_pending=resettable,
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
            detail="SGA claims are not enabled yet.",
        )

    existing = await _latest_pending(user.id, session)
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


async def reset_failed_claim_for_user(
    user: User,
    session: AsyncSession,
    settings: Settings,
) -> ResetClaimOut:
    """Restore a failed unsigned claim only when no transaction was submitted."""
    claim = await _latest_pending(user.id, session, lock=True)
    if (
        claim is None
        or claim.status != "pending"
        or claim.signature is not None
        or not claim.last_error
    ):
        raise HTTPException(status_code=409, detail="No failed unsigned claim to reset.")

    account = await session.scalar(
        select(RewardAccount)
        .where(RewardAccount.user_id == user.id)
        .with_for_update()
    )
    if account is None:
        raise HTTPException(status_code=409, detail="Reward account was not found.")

    account.available_amount += claim.amount
    account.lifetime_claimed = max(0, account.lifetime_claimed - claim.amount)
    claim.status = "failed"
    claim.last_error = "Reset by player after a failed payout."
    await session.flush()
    return ResetClaimOut(
        restored_amount=claim.amount,
        token_symbol=settings.gamer_token_symbol,
        message="Failed claim reset. You can claim again.",
    )


@router.get("", response_model=RewardSummaryOut)
async def reward_summary(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> RewardSummaryOut:
    return await reward_summary_for_user(user, session, settings)


@router.post("/claim/reset", response_model=ResetClaimOut)
async def reset_claim(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> ResetClaimOut:
    return await reset_failed_claim_for_user(user, session, settings)


@router.post("/claim", response_model=ClaimOut)
async def claim_rewards(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> ClaimOut:
    return await claim_for_user(user, session, settings)