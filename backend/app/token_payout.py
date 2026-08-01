"""Send earned Gamer Tokens from a dedicated Solana reward treasury."""

from __future__ import annotations

import logging

from solana.rpc.async_api import AsyncClient
from solana.rpc.models import TxOpts
from solana.rpc.commitment import Confirmed
from solders.keypair import Keypair
from solders.message import MessageV0
from solders.pubkey import Pubkey
from solders.transaction import VersionedTransaction
from spl.token.constants import TOKEN_PROGRAM_ID
from spl.token.instructions import (
    create_idempotent_associated_token_account,
    get_associated_token_address,
    transfer_checked,
)
from spl.token.models import TransferCheckedParams

logger = logging.getLogger("sga.rewards.payout")


class PayoutError(Exception):
    """A reward transfer could not be safely confirmed."""


def payout_is_configured(*, mint: str, treasury_keypair: str, enabled: bool) -> bool:
    return bool(enabled and mint.strip() and treasury_keypair.strip())


async def send_gamer_tokens(
    *,
    rpc_url: str,
    mint_address: str,
    treasury_keypair: str,
    destination_wallet: str,
    whole_tokens: int,
) -> str:
    """Transfer whole SPL token units and return the confirmed signature.

    The dedicated treasury is both token owner and fee payer. The recipient never
    signs because receiving an airdrop does not grant this service authority over
    their wallet.
    """
    if whole_tokens <= 0:
        raise PayoutError("Claim amount must be positive.")

    try:
        treasury = Keypair.from_base58_string(treasury_keypair.strip())
        mint = Pubkey.from_string(mint_address.strip())
        destination_owner = Pubkey.from_string(destination_wallet.strip())
    except (ValueError, TypeError) as exc:
        raise PayoutError("Reward payout configuration is invalid.") from exc

    source = get_associated_token_address(
        owner=treasury.pubkey(),
        mint=mint,
        token_program_id=TOKEN_PROGRAM_ID,
    )
    destination = get_associated_token_address(
        owner=destination_owner,
        mint=mint,
        token_program_id=TOKEN_PROGRAM_ID,
    )

    try:
        async with AsyncClient(rpc_url) as rpc:
            supply = await rpc.get_token_supply(mint, commitment=Confirmed)
            decimals = int(supply.value.decimals)
            raw_amount = whole_tokens * (10**decimals)

            create_destination = create_idempotent_associated_token_account(
                payer=treasury.pubkey(),
                owner=destination_owner,
                mint=mint,
                token_program_id=TOKEN_PROGRAM_ID,
            )
            transfer = transfer_checked(
                TransferCheckedParams(
                    program_id=TOKEN_PROGRAM_ID,
                    source=source,
                    mint=mint,
                    dest=destination,
                    owner=treasury.pubkey(),
                    amount=raw_amount,
                    decimals=decimals,
                )
            )

            latest = await rpc.get_latest_blockhash(commitment=Confirmed)
            message = MessageV0.try_compile(
                payer=treasury.pubkey(),
                instructions=[create_destination, transfer],
                address_lookup_table_accounts=[],
                recent_blockhash=latest.value.blockhash,
            )
            transaction = VersionedTransaction(message, [treasury])
            submitted = await rpc.send_transaction(
                transaction,
                opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed),
            )
            signature = submitted.value
            confirmation = await rpc.confirm_transaction(
                signature,
                commitment=Confirmed,
                last_valid_block_height=latest.value.last_valid_block_height,
            )
            status_value = confirmation.value[0]
            if status_value is None or status_value.err is not None:
                raise PayoutError("The Solana transfer failed on-chain.")
            return str(signature)
    except PayoutError:
        raise
    except Exception as exc:
        # Never log the keypair or raw transaction. The exception type is enough
        # for operations; the user gets a stable, non-sensitive message.
        logger.warning("Gamer Token payout failed: %s", type(exc).__name__)
        raise PayoutError("The Solana transfer could not be confirmed.") from exc