from __future__ import annotations

import base64
import binascii
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Response, status
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import UserOut, _to_out
from app.api.deps import current_user
from app.bot.menu_sync import announce, refresh_menu
from app.config import Settings, get_settings
from app.db import get_session
from app import solana
from app.models import User, WalletChallenge
from app.security.rate_limit import rate_limit, wallet_limiter

router = APIRouter(prefix="/wallet", tags=["wallet"])

CHALLENGE_TTL = timedelta(minutes=5)
_BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_BASE58_VALUES = {char: index for index, char in enumerate(_BASE58_ALPHABET)}


class ChallengeRequest(BaseModel):
    address: str = Field(min_length=32, max_length=64)


class ChallengeOut(BaseModel):
    nonce: str
    message: str
    expires_at: datetime


class ConnectRequest(BaseModel):
    nonce: str = Field(min_length=16, max_length=64)
    address: str = Field(min_length=32, max_length=64)
    signature: str = Field(min_length=1, max_length=256)


def _base58_decode(value: str) -> bytes:
    number = 0
    try:
        for char in value:
            number = number * 58 + _BASE58_VALUES[char]
    except KeyError as exc:
        raise ValueError("invalid base58") from exc

    decoded = number.to_bytes((number.bit_length() + 7) // 8, "big") if number else b""
    leading_zeroes = len(value) - len(value.lstrip("1"))
    return b"\0" * leading_zeroes + decoded


def _validate_address(address: str) -> bytes:
    public_key = _base58_decode(address)
    if len(public_key) != 32:
        raise ValueError("Solana public keys must contain 32 bytes")
    return public_key


def _as_utc(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


@router.post(
    "/challenge",
    response_model=ChallengeOut,
    dependencies=[Depends(rate_limit(wallet_limiter))],
)
async def create_wallet_challenge(
    body: ChallengeRequest,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(get_settings),
) -> ChallengeOut:
    try:
        _validate_address(body.address)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid Solana wallet address.") from exc

    now = datetime.now(timezone.utc)
    expires_at = now + CHALLENGE_TTL
    nonce = secrets.token_urlsafe(24)
    domain = urlsplit(settings.miniapp_url).netloc
    message = (
        f"{domain} wants you to sign in with your Solana account:\n"
        f"{body.address}\n\n"
        "Link this wallet to your verified Solana Games Telegram account.\n\n"
        f"URI: {settings.miniapp_url}\n"
        "Version: 1\n"
        "Chain ID: mainnet\n"
        f"Nonce: {nonce}\n"
        f"Issued At: {now.isoformat()}\n"
        f"Expiration Time: {expires_at.isoformat()}"
    )

    session.add(
        WalletChallenge(
            user_id=user.id,
            nonce=nonce,
            address=body.address,
            message=message,
            expires_at=expires_at,
        )
    )
    await session.flush()
    return ChallengeOut(nonce=nonce, message=message, expires_at=expires_at)


@router.post("/connect", response_model=UserOut)
async def connect_wallet(
    body: ConnectRequest,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> UserOut:
    challenge = await session.scalar(
        select(WalletChallenge).where(
            WalletChallenge.nonce == body.nonce,
            WalletChallenge.user_id == user.id,
        )
    )
    now = datetime.now(timezone.utc)
    if challenge is None or challenge.used_at is not None:
        raise HTTPException(status_code=401, detail="Wallet link request is invalid.")
    if _as_utc(challenge.expires_at) <= now:
        raise HTTPException(status_code=401, detail="Wallet link request expired. Try again.")
    if challenge.address != body.address:
        raise HTTPException(status_code=401, detail="Wallet address does not match.")

    try:
        public_key = _validate_address(body.address)
        signature = base64.b64decode(body.signature, validate=True)
        if len(signature) != 64:
            raise ValueError("invalid signature length")
        VerifyKey(public_key).verify(challenge.message.encode("utf-8"), signature)
    except (ValueError, binascii.Error, BadSignatureError) as exc:
        raise HTTPException(
            status_code=401, detail="Wallet signature could not be verified."
        ) from exc

    challenge.used_at = now
    user.wallet_address = body.address
    await session.flush()

    # The chat is showing a "Connect wallet" button that is now wrong. Fix it
    # before returning, so the Mini App and the chat agree by the time the user
    # switches back. Failures here are logged and swallowed — see menu_sync.
    await refresh_menu(session, user_id=user.id, has_wallet=True)
    await announce(
        user.telegram_id,
        "✅ Wallet linked.\n\n"
        f"<code>{body.address}</code>\n\n"
        "Every game here will use this wallet. You approve each transaction "
        "yourself — we cannot move funds for you.",
    )

    return _to_out(user)


class BalanceOut(BaseModel):
    address: str | None
    lamports: int
    # Both the exact value and the display value.
    #
    # `sol` is every decimal the chain reports; `sol_display` is what the player
    # card shows. Formatted here rather than in the client so the wallet screen,
    # a game and the bot cannot disagree — nine decimal places is exactly the
    # kind of thing two clients round differently.
    sol: str
    sol_display: str
    sol_available: bool

    token_symbol: str
    token_amount: str
    token_display: str
    # False when no mint is configured yet. The balance is a truthful zero in
    # that case, and the client can say why rather than implying the player holds
    # nothing.
    token_configured: bool
    token_available: bool
    token_error: str | None


@router.get("/balance", response_model=BalanceOut)
async def wallet_balance(
    user: User = Depends(current_user),
    settings: Settings = Depends(get_settings),
) -> BalanceOut:
    """What the player's linked wallet holds, read from the chain.

    Read-only in the strongest sense: this service holds no key for that address
    and there is no code path here that could produce a transaction. Showing a
    balance is the whole feature.

    An unreachable RPC is a 503, never a zero. Zero is a real balance and a
    believable one, so reporting it on failure would tell a player their wallet
    is empty when the truth is that we could not ask.
    """
    symbol = settings.gamer_token_symbol
    mint = settings.gamer_token_mint.strip()

    if not user.wallet_address:
        return BalanceOut(
            address=None,
            lamports=0,
            sol="0",
            sol_display="0.000",
            sol_available=True,
            token_symbol=symbol,
            token_amount="0",
            token_display="0",
            token_configured=bool(mint),
            token_available=True,
            token_error=None,
        )

    lamports = 0
    sol_available = True
    try:
        lamports = await solana.get_lamports(
            user.wallet_address, rpc_url=settings.solana_rpc_url
        )
    except solana.SolanaError:
        sol_available = False

    token_raw, token_decimals = (0, 0)
    token_available = True
    token_error = None
    if mint:
        try:
            token_raw, token_decimals = await solana.get_token_amount(
                user.wallet_address, mint, rpc_url=settings.solana_rpc_url
            )
        except solana.SolanaError as exc:
            token_available = False
            token_error = str(exc)

    return BalanceOut(
        address=user.wallet_address,
        lamports=lamports,
        sol=solana.to_sol(lamports),
        sol_display=solana.to_sol(lamports, places=3),
        sol_available=sol_available,
        token_symbol=symbol,
        token_amount=solana.format_units(token_raw, token_decimals),
        token_display=solana.format_units(token_raw, token_decimals, places=0),
        token_configured=bool(mint),
        token_available=token_available,
        token_error=token_error,
    )


@router.delete("", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
async def disconnect_wallet(
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
) -> Response:
    user.wallet_address = None
    await session.flush()

    await refresh_menu(session, user_id=user.id, has_wallet=False)
    await announce(
        user.telegram_id,
        "Wallet disconnected. Nothing was moved — we only forgot the address.",
    )

    return Response(status_code=status.HTTP_204_NO_CONTENT)
