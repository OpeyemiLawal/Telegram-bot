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


def main_menu() -> InlineKeyboardMarkup:
    """The two primary actions shown in the bot chat.

    Admin tools stay protected at their direct Mini App route, but are not
    advertised in the player-facing menu.
    """
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="🧪 Test", web_app=_url("/games"))],
            [InlineKeyboardButton(text="🏧 Wallet", web_app=_url("/wallet"))],
        ]
    )


def open_app_button(label: str = "Open", path: str = "") -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text=label, web_app=_url(path))]]
    )


def persistent_menu_button() -> MenuButtonWebApp:
    """Replaces the chat's hamburger menu with a direct launch button."""
    return MenuButtonWebApp(text="Play", web_app=_url())
