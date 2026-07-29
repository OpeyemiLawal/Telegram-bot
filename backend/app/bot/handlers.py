from __future__ import annotations

import re

from aiogram import F, Router
from aiogram.filters import Command, CommandStart
from aiogram.types import CallbackQuery, Message
from sqlalchemy import select

from app.bot.keyboards import main_menu, open_app_button
from app.db import SessionMaker
from app.models import User

router = Router(name="main")


async def _has_linked_wallet(message: Message) -> bool:
    """Whether this Telegram user has already proved ownership of a wallet.

    Read-only and deliberately forgiving: this only decides a button label, so
    a database hiccup should degrade to the pre-link wording rather than break
    the bot's reply. Nothing here grants access — the Mini App still verifies
    initData and the wallet signature independently.
    """
    if message.from_user is None:
        return False

    try:
        async with SessionMaker() as session:
            address = await session.scalar(
                select(User.wallet_address).where(
                    User.telegram_id == message.from_user.id
                )
            )
        return bool(address)
    except Exception:  # noqa: BLE001 — a label is never worth a failed reply
        return False


WELCOME = (
    "<b>Solana Games</b>\n\n"
    "Connect a wallet once. It stays connected across every game here — "
    "no reconnecting, no extension, no seed phrase.\n\n"
    "Pick where to start."
)

# Describes the wallet model as actually built: the player brings their own
# wallet and we never hold a key. An earlier draft of this text promised a
# custodial wallet "created for you", which is both untrue and the more
# dangerous direction to be wrong in — it teaches players to expect us to hold
# keys, which is exactly the expectation a phishing bot would exploit.
HELP = (
    "<b>How it works</b>\n\n"
    "<b>Your wallet</b>\n"
    "You connect a wallet you already own — Phantom, Solflare, Backpack, or "
    "another Solana wallet. We never create one for you, never see your seed "
    "phrase, and never hold your keys. All we store is your public address, "
    "and only after your wallet signs a message proving it is yours.\n\n"
    "<b>Approving things</b>\n"
    "Every transaction is approved in your own wallet. If something moves, you "
    "tapped approve. We cannot move funds on your behalf.\n\n"
    "<b>What this chat is for</b>\n"
    "Launching the app and sending you alerts. Nothing else. Everything that "
    "touches your wallet happens inside the app.\n\n"
    "<b>We will never ask for a seed phrase or private key.</b> "
    "Anyone who does — here or anywhere — is stealing from you."
)

# Rough shapes for a BIP-39 phrase and a base58 secret key. Deliberately loose:
# a false positive costs one warning message, a false negative costs a wallet.
_SEED_PHRASE = re.compile(r"^\s*(?:[a-z]{3,8}\s+){11,}[a-z]{3,8}\s*$", re.IGNORECASE)
_BASE58_KEY = re.compile(r"[1-9A-HJ-NP-Za-km-z]{80,}")


@router.message(CommandStart())
async def handle_start(message: Message) -> None:
    await message.answer(
        WELCOME, reply_markup=main_menu(has_wallet=await _has_linked_wallet(message))
    )


@router.message(Command("wallet"))
async def handle_wallet(message: Message) -> None:
    linked = await _has_linked_wallet(message)
    await message.answer(
        "Your linked wallet and balances."
        if linked
        else "Connect the wallet you will use across every game.",
        reply_markup=open_app_button(
            "View wallet" if linked else "Connect wallet", "/wallet"
        ),
    )


@router.message(Command("games"))
async def handle_games(message: Message) -> None:
    await message.answer(
        "Everything playable right now.",
        reply_markup=open_app_button("Open games", "/games"),
    )


@router.message(Command("help"))
async def handle_help(message: Message) -> None:
    await message.answer(
        HELP, reply_markup=main_menu(has_wallet=await _has_linked_wallet(message))
    )


@router.callback_query(F.data == "help")
async def handle_help_callback(query: CallbackQuery) -> None:
    if query.message is not None:
        await query.message.answer(HELP)
    await query.answer()


@router.message(F.text)
async def handle_loose_text(message: Message) -> None:
    """Catch-all. Its real job is the first branch."""
    text = message.text or ""

    if _SEED_PHRASE.match(text) or _BASE58_KEY.search(text):
        # Do not echo, quote, or store it. Just warn, loudly and immediately.
        await message.answer(
            "⚠️ <b>That looks like a seed phrase or private key.</b>\n\n"
            "Delete the message you just sent, right now.\n\n"
            "Telegram chats are not end-to-end encrypted — Telegram's servers "
            "can read them, and so can anyone who gets into your account. "
            "Treat any wallet you pasted here as compromised: move the funds "
            "to a new wallet and stop using the old one.\n\n"
            "We will never ask you for this."
        )
        return

    await message.answer(
        "I only handle launching the app. Use the buttons below.",
        reply_markup=main_menu(has_wallet=await _has_linked_wallet(message)),
    )
