from __future__ import annotations

import re

from aiogram import F, Router
from aiogram.filters import Command, CommandStart
from aiogram.types import CallbackQuery, Message

from app.bot.keyboards import main_menu, open_app_button

router = Router(name="main")

WELCOME = (
    "<b>Solana Games</b>\n\n"
    "Connect a wallet once. It stays connected across every game here — "
    "no reconnecting, no extension, no seed phrase.\n\n"
    "Pick where to start."
)

HELP = (
    "<b>How it works</b>\n\n"
    "<b>Your wallet</b>\n"
    "Created for you the first time you open the app. The keys live in secure "
    "hardware at our wallet provider, not on our servers and not in this chat. "
    "You can export or move it whenever you want.\n\n"
    "<b>Your balance</b>\n"
    "Deposit SOL or USDC to play. $SGA you earn is tracked as you play and "
    "settles on-chain when you claim it.\n\n"
    "<b>What this chat is for</b>\n"
    "Launching the app and sending you alerts. Nothing else. "
    "Every action that touches your money happens inside the app, where the "
    "connection is encrypted end to end.\n\n"
    "<b>We will never ask for a seed phrase or private key.</b> "
    "Anyone who does — here or anywhere — is stealing from you."
)

# Rough shapes for a BIP-39 phrase and a base58 secret key. Deliberately loose:
# a false positive costs one warning message, a false negative costs a wallet.
_SEED_PHRASE = re.compile(r"^\s*(?:[a-z]{3,8}\s+){11,}[a-z]{3,8}\s*$", re.IGNORECASE)
_BASE58_KEY = re.compile(r"[1-9A-HJ-NP-Za-km-z]{80,}")


@router.message(CommandStart())
async def handle_start(message: Message) -> None:
    await message.answer(WELCOME, reply_markup=main_menu())


@router.message(Command("wallet"))
async def handle_wallet(message: Message) -> None:
    await message.answer(
        "Your wallet, balances, and deposit address.",
        reply_markup=open_app_button("Open wallet", "/wallet"),
    )


@router.message(Command("games"))
async def handle_games(message: Message) -> None:
    await message.answer(
        "Everything playable right now.",
        reply_markup=open_app_button("Open games", "/games"),
    )


@router.message(Command("help"))
async def handle_help(message: Message) -> None:
    await message.answer(HELP, reply_markup=main_menu())


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
        reply_markup=main_menu(),
    )
