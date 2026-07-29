from __future__ import annotations

from aiogram.types import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    MenuButtonWebApp,
    WebAppInfo,
)

from app.config import get_settings

_settings = get_settings()


def _url(path: str = "") -> WebAppInfo:
    return WebAppInfo(url=f"{_settings.miniapp_url}{path}")


def main_menu(*, has_wallet: bool = False) -> InlineKeyboardMarkup:
    """The bot's whole surface area.

    web_app buttons only work in private chats — that is fine, and it is also
    a feature: it keeps wallet entry points out of groups.

    `has_wallet` changes the first button from an instruction into a
    destination. "Wallet" reads as unfinished setup to someone who has already
    linked one, and the label is the only signal the chat can carry — the bot
    cannot see inside the Mini App.
    """
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(
                    text="View wallet" if has_wallet else "Connect wallet",
                    web_app=_url("/wallet"),
                )
            ],
            [InlineKeyboardButton(text="Games", web_app=_url("/games"))],
            [
                InlineKeyboardButton(
                    text="How it works",
                    callback_data="help",
                )
            ],
        ]
    )


def open_app_button(label: str = "Open", path: str = "") -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text=label, web_app=_url(path))]]
    )


def persistent_menu_button() -> MenuButtonWebApp:
    """Replaces the chat's hamburger menu with a direct launch button."""
    return MenuButtonWebApp(text="Play", web_app=_url())
