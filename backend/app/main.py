from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from aiogram.types import Update
from fastapi import APIRouter, FastAPI, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware

from app.api import auth, games, wallet
from app.bot.instance import bot, dispatcher
from app.bot.keyboards import persistent_menu_button
from app.config import get_settings
from app.db import create_schema

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("sga")

settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await create_schema()

    await bot.set_webhook(
        url=settings.webhook_url,
        secret_token=settings.webhook_secret,
        drop_pending_updates=True,
        allowed_updates=["message", "callback_query"],
    )
    await bot.set_chat_menu_button(menu_button=persistent_menu_button())
    logger.info("Webhook registered at %s", settings.webhook_url)

    yield

    await bot.delete_webhook()
    await bot.session.close()


app = FastAPI(title="Solana Games Platform", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    # Explicit list, never "*". The Mini App sends credentials.
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    max_age=600,
)

api = APIRouter(prefix="/api")
api.include_router(auth.router)
api.include_router(games.router)
api.include_router(wallet.router)
app.include_router(api)


@app.post(settings.webhook_path, include_in_schema=False)
async def telegram_webhook(request: Request) -> Response:
    """Telegram's only way in.

    Anyone can POST here, so the shared secret is what makes an update
    trustworthy. Without this check a stranger can make the bot believe
    any user said anything.
    """
    if request.headers.get("X-Telegram-Bot-Api-Secret-Token") != settings.webhook_secret:
        logger.warning("Rejected webhook with bad secret token")
        return Response(status_code=status.HTTP_403_FORBIDDEN)

    update = Update.model_validate(await request.json(), context={"bot": bot})
    await dispatcher.feed_update(bot, update)
    return Response(status_code=status.HTTP_200_OK)


@app.get("/health", include_in_schema=False)
async def health() -> dict[str, str]:
    return {"status": "ok"}
