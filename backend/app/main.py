from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from aiogram.types import Update
from fastapi import APIRouter, FastAPI, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware

from app.api import admin, auth, games, public, wallet
from app.bot.instance import bot, dispatcher
from app.bot.keyboards import persistent_menu_button
from app.config import get_settings
from app.db import create_schema
from app.security import log_scrub

# Before anything else logs. `install` replaces the root handler's formatter and
# adds the redaction filter, so uvicorn's startup lines and aiogram's request
# logging are covered too — they propagate to root like everything else.
log_scrub.install(logging.INFO)
logger = logging.getLogger("sga")

settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Production schema is Alembic's job, applied by the start command before
    # this process exists (see render.yaml). Doing it here as well would mean two
    # mechanisms owning the same schema, and `create_all` is the one that fails
    # silently — it never alters an existing table, so a model change would look
    # applied and not be.
    if not settings.is_production:
        await create_schema()

    await bot.set_webhook(
        url=settings.webhook_url,
        secret_token=settings.webhook_secret,
        # False, and it has to be, on any host that sleeps an idle instance.
        #
        # The sequence that makes True unusable: the instance is asleep, the
        # player sends /start, Telegram cannot deliver so it queues the update
        # and retries, the retry wakes the instance — and this line then throws
        # away the very message that woke it. The player sees silence, tries
        # again, and the second attempt works because the instance is now warm.
        # "Nothing happens the first time" is the exact signature.
        #
        # Keeping the queue means the update is delivered once the app is
        # listening. The cost is that a genuinely stale backlog gets replayed
        # after a long outage, which for a /start handler is harmless.
        drop_pending_updates=False,
        allowed_updates=["message", "callback_query"],
    )
    await bot.set_chat_menu_button(menu_button=persistent_menu_button())
    logger.info("Webhook registered at %s", settings.webhook_url)

    yield

    # Deliberately NOT calling delete_webhook() here.
    #
    # A host that sleeps an idle instance — Render's free tier, most
    # scale-to-zero platforms — runs this shutdown path routinely, not just on
    # a real deploy. Unregistering the webhook there deadlocks the bot: Telegram
    # has nowhere to deliver updates, and an inbound update is the only thing
    # that would have woken the instance. The bot goes silent ~15 minutes after
    # every deploy and the logs show a clean shutdown with no error.
    #
    # Leaving the registration in place is correct regardless of host. It points
    # at a fixed URL, `set_webhook` on the next boot is idempotent, and Telegram
    # retries a failed delivery, so updates arriving mid-restart survive.
    #
    # To genuinely unregister — switching to polling for local work — use
    # run_polling.py, which deletes it explicitly on startup.
    await bot.session.close()


app = FastAPI(title="Solana Games Platform", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    # Explicit list, never "*". The Mini App sends credentials.
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    # PUT is here for the admin catalogue editor. Omitting it fails only on the
    # preflight, which the browser reports as a generic network error with no
    # mention of the method — a slow thing to diagnose from the client side.
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    max_age=600,
)

api = APIRouter(prefix="/api")
api.include_router(auth.router)
api.include_router(games.router)
api.include_router(wallet.router)
api.include_router(admin.router)
api.include_router(public.router)
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
    """Liveness, plus which build is actually answering.

    The commit is here because "is my fix deployed?" is otherwise unanswerable
    from outside. A host that serves a stale build after a push looks exactly
    like a fix that did not work, and the debugging goes to the wrong place —
    the code — for as long as the ambiguity lasts. Render injects
    RENDER_GIT_COMMIT on every deploy; other hosts expose their own equivalent.
    """
    commit = os.environ.get("RENDER_GIT_COMMIT", "unknown")
    return {
        "status": "ok",
        "commit": commit[:7] if commit != "unknown" else commit,
        "environment": settings.environment,
        # The setting behind the two auth failures that are hardest to tell
        # apart from the client: a rejected relaunch and an expired payload.
        "initdata_max_age": str(settings.initdata_max_age),
    }
