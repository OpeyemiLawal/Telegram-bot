from __future__ import annotations

import logging
import re

from aiogram import F, Router
from aiogram.filters import Command, CommandStart
from aiogram.types import CallbackQuery, Message
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from app.bot.keyboards import main_menu, open_app_button
from app.bot.menu_sync import remember_menu
from app.config import get_settings
from app.db import SessionMaker
from app.models import User

router = Router(name="main")
logger = logging.getLogger("sga.bot")


async def _reply_with_menu(message: Message, text: str) -> None:
    """Answer with the main menu, labelled for this user, and remember it.

    Remembering matters: the keyboard has to flip to "View wallet" the moment a
    wallet is linked inside the Mini App, and Telegram can only do that by
    editing this exact message. See `app/bot/menu_sync.py`.

    The whole thing is wrapped: a database that is briefly unavailable should
    cost the user a correct button label, never a reply. The fallback keyboard
    says "Connect wallet", which is the safe way to be wrong — it points at the
    screen that works whether or not a wallet is already linked.
    """
    if message.from_user is None:
        await message.answer(text, reply_markup=main_menu())
        return

    try:
        async with SessionMaker() as session:
            user = await session.scalar(
                select(User).where(User.telegram_id == message.from_user.id)
            )

            if user is None:
                # Created here as well as at login, which is a deliberate
                # loosening of "only /auth/telegram creates users".
                #
                # It is safe: this code path is only reachable from a webhook
                # that already matched WEBHOOK_SECRET, so the telegram_id is as
                # trustworthy as a verified initData. And it is necessary — a
                # row is what the menu record points at, so without one the
                # first menu a new player ever sees could never update itself.
                # The row carries no privilege; it holds a Telegram id and
                # nothing else until they sign in.
                user = User(
                    telegram_id=message.from_user.id,
                    first_name=message.from_user.first_name or "",
                    username=message.from_user.username,
                )
                session.add(user)
                await session.flush()

            has_wallet = bool(user.wallet_address)
            is_admin = message.from_user.id in get_settings().admin_ids
            sent = await message.answer(
                text,
                reply_markup=main_menu(has_wallet=has_wallet, is_admin=is_admin),
            )

            await remember_menu(
                session,
                user_id=user.id,
                chat_id=sent.chat.id,
                message_id=sent.message_id,
                shows_wallet_linked=has_wallet,
            )
            await session.commit()
    except SQLAlchemyError:
        logger.exception("Menu bookkeeping failed; replying without it")
        await message.answer(text, reply_markup=main_menu())


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
    await _reply_with_menu(message, WELCOME)


@router.message(Command("wallet"))
async def handle_wallet(message: Message) -> None:
    await _reply_with_menu(
        message, "Your wallet, and the games it is connected to."
    )


@router.message(Command("games"))
async def handle_games(message: Message) -> None:
    await message.answer(
        "Everything playable right now.",
        reply_markup=open_app_button("Open games", "/games"),
    )


@router.message(Command("help"))
async def handle_help(message: Message) -> None:
    await _reply_with_menu(message, HELP)


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

    await _reply_with_menu(
        message, "I only handle launching the app. Use the buttons below."
    )
