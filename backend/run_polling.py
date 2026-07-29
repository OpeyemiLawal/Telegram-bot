"""Local development runner.

Webhook mode needs a public HTTPS URL, which you do not have on a laptop.
This polls instead. Run it alongside the API:

    # terminal 1 — the API the Mini App talks to
    uvicorn app.main:app --reload --port 8000

    # terminal 2 — the bot
    python run_polling.py

`app.main` registers a webhook on startup, and Telegram will not deliver to
a webhook and a long poll at the same time. So when you run both, start this
second — it deletes the webhook on the way in.

You still need MINIAPP_URL to be a real HTTPS origin, because Telegram
refuses to open a Mini App over plain HTTP. Point a tunnel at your Next.js
dev server and use that URL:

    npx localtunnel --port 3000
    cloudflared tunnel --url http://localhost:3000
"""

from __future__ import annotations

import asyncio
import logging

from app.bot.instance import bot, dispatcher
from app.bot.keyboards import persistent_menu_button
from app.config import get_settings
from app.db import create_schema

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("sga.polling")


async def main() -> None:
    settings = get_settings()
    await create_schema()

    await bot.delete_webhook(drop_pending_updates=True)
    await bot.set_chat_menu_button(menu_button=persistent_menu_button())

    me = await bot.get_me()
    logger.info("Polling as @%s — Mini App at %s", me.username, settings.miniapp_url)

    try:
        await dispatcher.start_polling(bot, allowed_updates=["message", "callback_query"])
    finally:
        await bot.session.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
