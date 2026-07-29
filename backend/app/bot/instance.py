from __future__ import annotations

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode

from app.bot.handlers import router as handlers_router
from app.config import get_settings

_settings = get_settings()

bot = Bot(
    token=_settings.bot_token,
    default=DefaultBotProperties(parse_mode=ParseMode.HTML),
)

dispatcher = Dispatcher()
dispatcher.include_router(handlers_router)
