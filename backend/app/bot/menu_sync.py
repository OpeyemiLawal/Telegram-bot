"""Keeps the bot's inline keyboard honest about wallet state.

A Telegram inline keyboard belongs to the message it was sent with. There is no
call that says "update this user's buttons" — you edit one specific message in
one specific chat. So the bot records where it last drew the menu, and the
wallet endpoints ask for it to be redrawn once the state it describes changes.

Everything here is best-effort. A stale button is a cosmetic problem; a wallet
link that fails because Telegram was briefly unreachable is a real one. No
function in this module raises into its caller.
"""

from __future__ import annotations

import logging
import uuid

from aiogram.exceptions import TelegramAPIError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.bot.keyboards import main_menu
from app.models import BotMenuMessage

logger = logging.getLogger("sga.menu")


def _bot():
    """Resolve the Bot lazily, because importing it at module level cycles.

    `app.bot.instance` imports `handlers` in order to register the router, and
    `handlers` imports this module to record where it drew the menu. A top-level
    `from app.bot.instance import bot` therefore closes the loop and fails at
    import time — before anything has a chance to log why.

    Deferring the lookup to call time breaks the cycle without a shim module or
    a dependency-injection layer that would earn its keep nowhere else. By the
    time any of these functions runs, the import has long since completed.
    """
    from app.bot.instance import bot

    return bot


async def remember_menu(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    chat_id: int,
    message_id: int,
    shows_wallet_linked: bool,
) -> None:
    """Record the message whose keyboard should track wallet state."""
    existing = await session.get(BotMenuMessage, user_id)
    if existing is None:
        session.add(
            BotMenuMessage(
                user_id=user_id,
                chat_id=chat_id,
                message_id=message_id,
                shows_wallet_linked=shows_wallet_linked,
            )
        )
    else:
        existing.chat_id = chat_id
        existing.message_id = message_id
        existing.shows_wallet_linked = shows_wallet_linked


async def refresh_menu(
    session: AsyncSession, *, user_id: uuid.UUID, has_wallet: bool
) -> None:
    """Redraw the stored menu if it no longer matches reality.

    Skips the call when the keyboard already shows the right thing. Telegram
    rejects an edit that would produce an identical message, so checking first
    turns a routine no-op from an exception into nothing at all.
    """
    record = await session.scalar(
        select(BotMenuMessage).where(BotMenuMessage.user_id == user_id)
    )
    if record is None or record.shows_wallet_linked == has_wallet:
        return

    try:
        await _bot().edit_message_reply_markup(
            chat_id=record.chat_id,
            message_id=record.message_id,
            reply_markup=main_menu(has_wallet=has_wallet),
        )
    except TelegramAPIError as exc:
        # The user deleted the message, cleared the chat, or blocked the bot.
        # None of that should surface as a failed wallet link.
        logger.info("Could not refresh menu for %s: %s", user_id, exc)
        return

    record.shows_wallet_linked = has_wallet


async def announce(chat_id: int, text: str) -> None:
    """Send a short confirmation into the chat. Never raises."""
    try:
        await _bot().send_message(chat_id, text)
    except TelegramAPIError as exc:
        logger.info("Could not send confirmation to %s: %s", chat_id, exc)
