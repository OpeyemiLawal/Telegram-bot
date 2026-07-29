"""Temporary capture hook for debugging initData failures.

Enable with DEBUG_AUTH=1 in .env. When a signature check fails, the raw
payload is written to `last_initdata.txt` in the backend folder so that
`diagnose_initdata.py` can analyse it offline.

Turn it off when you are done. The captured file contains the user's
Telegram profile, and should not be committed or shared.

Note the flag is read through Settings, not os.environ — values in .env
populate the Settings object and never reach the process environment.
"""

from __future__ import annotations

import logging
from pathlib import Path

from app.config import get_settings

logger = logging.getLogger("sga.auth")

CAPTURE_PATH = Path(__file__).resolve().parents[2] / "last_initdata.txt"


def capture(init_data: str) -> None:
    if not get_settings().debug_auth:
        return
    try:
        CAPTURE_PATH.write_text(init_data, encoding="utf-8")
        logger.warning("DEBUG_AUTH: payload written to %s", CAPTURE_PATH)
    except OSError as exc:
        logger.warning("DEBUG_AUTH: could not write capture file: %s", exc)
