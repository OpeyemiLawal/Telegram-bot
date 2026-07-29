# Solana Games — Telegram bot + Mini App

The Telegram bot, Mini App authentication, and external Solana wallet linking.

Players connect their existing Phantom, Solflare, Backpack, or compatible
wallet. The app never creates a wallet and never receives a seed phrase or
private key. The Godot bridge and on-chain program are not in here yet.

```
backend/    aiogram 3 bot + FastAPI API (Python 3.11+)
miniapp/    Next.js 15 Mini App shell (deploys to Vercel)
```

---

## The security model in one page

Everything rests on one thing: **`initData` is signed with your bot token.**

When Telegram opens the Mini App it injects `window.Telegram.WebApp.initData`,
a query string carrying the user's identity and an HMAC-SHA256 signature. Only
someone holding the bot token can produce a valid one. The server recomputes
it:

```
secret_key = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN)
expected   = HMAC_SHA256(key=secret_key,   msg=data_check_string)
```

For bot-token HMAC validation, `data_check_string` is every field except
`hash` (including Telegram's newer `signature` field), as `key=value`, sorted
by key, newline-joined. The separate third-party Ed25519 verification procedure
excludes both `hash` and `signature`.

Consequences you must not forget:

| | |
|---|---|
| `BOT_TOKEN` **is** the identity key | Anyone who has it can impersonate any user. Treat it like a private key. Rotate immediately if exposed. |
| `initDataUnsafe` is unsigned | Cosmetic only. `lib/telegram.ts` is the only file allowed to read it, and only to paint a name before the server answers. |
| Bot chat is not end-to-end encrypted | Telegram's servers can read it. Nothing sensitive goes in a chat message, ever. |

On top of that:

- **Freshness** — `auth_date` older than `INITDATA_MAX_AGE` (default 300s) is rejected, as is anything more than 60s in the future.
- **Replay** — each `initData` hash is redeemable once.
- **Token rotation** — refresh tokens rotate on use. Presenting an already-rotated token is treated as theft and revokes the whole token family.
- **Webhook spoofing** — Telegram echoes `WEBHOOK_SECRET` in `X-Telegram-Bot-Api-Secret-Token`. Requests without it are dropped. Without this check, a stranger can POST to your webhook and make the bot believe any user said anything.

### Where tokens live on the client

| Token | Where | Why |
|---|---|---|
| Access (15 min JWT) | Module variable, memory only | Dies with the page. Never persisted. |
| Refresh (30 days, opaque) | `sessionStorage` | Has to survive a page reload — see the reload edge below. Cleared when the WebView closes. |

Neither goes in `localStorage` or a cookie.

---

## Run it

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Fill in `.env`:

```bash
# secrets — generate both
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

- `BOT_TOKEN` — from [@BotFather](https://t.me/botfather)
- `MINIAPP_URL` — **must be HTTPS.** Telegram will not open a Mini App over
  plain HTTP, and there is no localhost exception. For local work, tunnel your
  Next.js dev server:
  ```bash
  cloudflared tunnel --url http://localhost:3000
  ```
- `ALLOWED_ORIGINS` — must contain `MINIAPP_URL` exactly, or CORS blocks login.

Then:

```bash
uvicorn app.main:app --reload --port 8000   # API (registers a webhook)
python run_polling.py                        # bot, local dev — start second
pytest -q                                    # 20 tests
```

`run_polling.py` deletes the webhook on startup, because Telegram will not
deliver to a webhook and a long poll simultaneously.

### Mini App

```bash
cd miniapp
npm install
cp .env.example .env.local
npm run dev
```

Set these Mini App variables locally and in Vercel:

- `NEXT_PUBLIC_API_URL` - your backend API origin.
- `NEXT_PUBLIC_MINIAPP_URL` - the deployed HTTPS Mini App URL.
- `NEXT_PUBLIC_REOWN_PROJECT_ID` - a project ID from Reown Cloud. This opens
  Phantom, Solflare, Backpack, and other compatible wallets.

Open it from the bot, not from a browser tab — outside Telegram there is no
`initData` to verify, and the app says so rather than pretending to work.

### BotFather setup

1. `/newbot` — pick a name and a username, copy the token into `BOT_TOKEN`.
2. That's it for now. The menu button is set programmatically by `main.py`
   (and `run_polling.py`) on startup, so you don't need `/setmenubutton`.

You do **not** need `/setdomain`. That command pairs a bot with a domain for
the Login Widget, which is a different feature. Mini Apps launched from
`web_app` buttons carry their URL in the button itself.


---

## What's here

**Backend**

```
app/security/telegram_auth.py   initData validation + replay guard   ← the trust boundary
app/security/tokens.py          JWT issue/verify, refresh hashing
app/api/auth.py                 login, refresh, logout, /me
app/api/wallet.py               one-time challenge + wallet proof verification
app/api/deps.py                 bearer → User dependency
app/api/games.py                catalogue (hard-coded for now)
app/bot/handlers.py             /start /wallet /games /help + secret-paste warning
app/bot/keyboards.py            web_app launch buttons
app/main.py                     FastAPI app, verified webhook, CORS
app/models.py                   User, RefreshToken, WalletChallenge
run_polling.py                  dev runner
tests/                          20 tests
```

**Mini App**

```
lib/telegram.ts       typed WebApp wrapper; the only reader of initDataUnsafe
lib/api.ts            token custody + auto-refresh on 401
lib/auth.tsx          session boot
lib/wallet-kit.ts     Reown AppKit + Solana wallet adapter
components/Screen.tsx route gate + boot/error/outside states
components/PlayerCard.tsx
app/page.tsx          home
app/wallet/page.tsx   Section 01
app/games/page.tsx    Section 02
```

`handlers.py` includes a regex that catches anything shaped like a seed phrase
or a base58 private key and fires a warning without echoing, quoting, or
storing it. Users paste these into bots. Plan for it.

---

## Known edges

**Replay guard is process-local.** `ReplayGuard` is an in-memory dict. Correct
for one worker, wrong for two. Before you scale, swap `seen()` for Redis:

```python
redis.set(f"initdata:{hash}", 1, nx=True, ex=300)  # False → already used
```

**Reload interacts with the replay guard.** Telegram hands back the *same*
`initData` on a page reload, so re-logging-in would be rejected as a replay.
The client tries the refresh token first, which handles it. But if
`sessionStorage` is unavailable (private mode, a locked-down WebView) the user
sees "Reopen the app." If that turns out to bite in testing, relax the guard to
return the existing session instead of rejecting, and lean on the short
`auth_date` window.

**`create_all` is not a migration.** `app/db.py` builds the schema on startup.
Move to Alembic before you have real users.

**Don't set COOP/COEP on the game host.** When you add the Godot builds, export
single-threaded rather than enabling cross-origin isolation. Isolation breaks
wallet connection iframes and third-party RPC calls. Noted in
`miniapp/vercel.json`.

---

## Next slice

`PlatformSDK` + Godot `JavaScriptBridge`: the shell holds the wallet, games run
in iframes on their own origins, and signing is brokered over `postMessage`
against a strict origin allowlist (`ALLOWED_GAME_ORIGINS` in `api/games.py` is
already the seed of it).

The linked public address is already stored on `User.wallet_address`. Each game
will request transactions through the shell; the player's wallet must approve
every transfer or swap.

---

## Before real money touches this

- Alembic migrations
- Redis-backed replay guard
- Rate limiting on `/api/auth/telegram`
- Structured logging with the bot token scrubbed
- **An audit of the on-chain program**, which is not written yet. Nothing in
  this repo custodies funds, and nothing here should until that is done.
