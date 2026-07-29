"""Find out why an initData signature check is failing.

Usage:
    1. Add  DEBUG_AUTH=1  to .env
    2. Restart uvicorn (fully — Ctrl+C then start it again)
    3. Open the Mini App from Telegram so it fails once
    4. python diagnose_initdata.py

It reads the captured payload and your bot token, then tries every plausible
variant of the check-string construction. Exactly one should match. Whichever
one does tells you precisely what is wrong.

Nothing here is sent anywhere. The output masks the token and truncates user
data, so it is safe to share.
"""

from __future__ import annotations

import hashlib
import hmac
import sys
from pathlib import Path
from urllib.parse import parse_qsl, unquote, unquote_plus

sys.path.insert(0, str(Path(__file__).parent))

CAPTURE = Path(__file__).parent / "last_initdata.txt"


def secret_key(token: str) -> bytes:
    return hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()


def sign(check_string: str, token: str) -> str:
    return hmac.new(
        secret_key(token), check_string.encode("utf-8"), hashlib.sha256
    ).hexdigest()


def raw_pairs(init_data: str) -> list[tuple[str, str]]:
    """Split without decoding, so we can test undecoded variants."""
    out = []
    for chunk in init_data.split("&"):
        if "=" in chunk:
            key, _, value = chunk.partition("=")
            out.append((key, value))
    return out


def variants(init_data: str) -> dict[str, str]:
    """Every check-string construction worth testing."""
    decoded = dict(parse_qsl(init_data, keep_blank_values=True))
    raw = dict(raw_pairs(init_data))

    def build(source: dict[str, str], drop: set[str]) -> str:
        fields = {k: v for k, v in source.items() if k not in drop}
        return "\n".join(f"{k}={fields[k]}" for k in sorted(fields))

    return {
        "old implementation (decoded, drop hash+signature)": build(
            decoded, {"hash", "signature"}
        ),
        "current implementation (decoded, drop hash only)": build(decoded, {"hash"}),
        "raw undecoded values, drop hash+signature": build(
            raw, {"hash", "signature"}
        ),
        "unquote instead of unquote_plus (+ preserved)": build(
            {k: unquote(v) for k, v in raw.items()}, {"hash", "signature"}
        ),
        "unquote_plus explicitly (+ becomes space)": build(
            {k: unquote_plus(v) for k, v in raw.items()}, {"hash", "signature"}
        ),
    }


def main() -> int:
    if not CAPTURE.exists():
        print(f"No capture file at {CAPTURE}")
        print("Set DEBUG_AUTH=1 in .env, restart uvicorn, open the Mini App.")
        return 1

    init_data = CAPTURE.read_text(encoding="utf-8").strip()
    if not init_data:
        print("Capture file is empty.")
        return 1

    from app.config import get_settings

    token = get_settings().bot_token

    print(f"token   : {token.split(':')[0]}:…{token[-4:]}  (len {len(token)})")
    print(f"payload : {len(init_data)} chars")

    fields = dict(parse_qsl(init_data, keep_blank_values=True))
    received = fields.get("hash", "")
    print(f"fields  : {sorted(fields)}")
    print(f"hash    : {received[:12]}…")
    print()

    matches: list[str] = []
    for label, check_string in variants(init_data).items():
        computed = sign(check_string, token)
        ok = hmac.compare_digest(computed, received)
        print(f"[{'MATCH' if ok else '  no '}] {label}")
        if ok:
            matches.append(label)

    print()
    # Several variants coincide when the payload has no `+` and no signature
    # field to tell them apart. If the current one is among them, it is right.
    winner = next((m for m in matches if m.startswith("current")), None)
    if winner is None and matches:
        winner = matches[0]

    if winner:
        print(f"=> The correct construction is: {winner}")
        if winner.startswith("current"):
            print("   The algorithm is fine, and this token verifies this payload.")
            print("   So the token the server held at request time was different —")
            print("   restart uvicorn fully. It does NOT watch .env for changes,")
            print("   so an edit made while it was running never took effect.")
    else:
        print("=> No variant matched. That means the token is not the one this")
        print("   payload was signed with. Check for a second BOT_TOKEN line in")
        print("   .env, or a BOT_TOKEN set in your shell environment, which")
        print("   overrides the file.")
        import os

        shell_token = os.environ.get("BOT_TOKEN")
        if shell_token and shell_token.strip() != token:
            print()
            print("   !! BOT_TOKEN is set in your shell and differs from .env.")
            print("      That shell value wins. Clear it and retry.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
