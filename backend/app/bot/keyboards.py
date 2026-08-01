from __future__ import annotations

from collections.abc import Iterable

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
    """The two primary actions shown in the bot chat."""
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="🧪 Test", callback_data="show_games")],
            [InlineKeyboardButton(text="🏧 Wallet", web_app=_url("/wallet"))],
        ]
    )


def games_menu(games: Iterable[tuple[str, str]]) -> InlineKeyboardMarkup:
    """Build direct Telegram Web App buttons from registered game origins."""
    rows = [
        [
            InlineKeyboardButton(
                text=f"🎮 {title}",
                web_app=WebAppInfo(url=url.rstrip("/")),
            )
        ]
        for title, url in games
    ]
    rows.append([InlineKeyboardButton(text="← Back", callback_data="main_menu")])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def open_app_button(label: str = "Open", path: str = "") -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text=label, web_app=_url(path))]]
    )


def persistent_menu_button() -> MenuButtonWebApp:
    """The native chat menu opens the central wallet Mini App."""
    return MenuButtonWebApp(text="Wallet", web_app=_url("/wallet"))
