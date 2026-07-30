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


def main_menu(
    *, has_wallet: bool = False, is_admin: bool = False
) -> InlineKeyboardMarkup:
    """The bot's whole surface area.

    web_app buttons only work in private chats — that is fine, and it is also
    a feature: it keeps wallet entry points out of groups.

    `has_wallet` changes the first button from an instruction into a
    destination. "Wallet" reads as unfinished setup to someone who has already
    linked one, and the label is the only signal the chat can carry — the bot
    cannot see inside the Mini App.

    `is_admin` adds the catalogue button. It is the only way in: a Mini App has
    no address bar, so a route nobody links to is a route nobody can reach. The
    button is a convenience and not a control — every admin endpoint checks the
    caller's Telegram id server-side, so showing it to the wrong person would
    cost them a "Not found" and nothing else.
    """
    rows = [
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

    if is_admin:
        rows.append(
            [InlineKeyboardButton(text="⚙︎ Catalogue", web_app=_url("/admin"))]
        )

    return InlineKeyboardMarkup(inline_keyboard=rows)


def open_app_button(label: str = "Open", path: str = "") -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text=label, web_app=_url(path))]]
    )


def persistent_menu_button() -> MenuButtonWebApp:
    """Replaces the chat's hamburger menu with a direct launch button."""
    return MenuButtonWebApp(text="Play", web_app=_url())
