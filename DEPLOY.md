# Deploy

Backend on **Render**, Mini App on **Vercel**. Both free tier. No local server.

Total time: ~30 minutes. Do the steps in order — step 4 needs a URL from step 3,
and step 5 needs a URL from step 4.

---

## The order matters, and here is why

The two halves reference each other:

- The backend needs MINIAPP_URL plus ALLOWED_ORIGINS for the wallet app and every direct game.
- The Mini App needs `NEXT_PUBLIC_API_URL` (the Render URL).

You cannot know either URL before deploying. So: deploy the Mini App first with
a placeholder, deploy the backend with the now-real Mini App URL, then come back
and fix the placeholder. Step 5 exists solely to close that loop.

---

## 0. Before you start

Have these three tabs open and be logged in:

| | |
|---|---|
| [github.com](https://github.com) | account, free |
| [render.com](https://render.com) | sign up with GitHub |
| [vercel.com](https://vercel.com) | sign up with GitHub |

And have your `BOT_TOKEN` from [@BotFather](https://t.me/botfather) in your
clipboard — it is in `backend/.env` right now.

---

## 1. Push to GitHub

Your `.gitignore` already excludes `.env`, `*.db`, `.venv/`, and
`last_initdata.txt`. Verify that before the first push — a bot token in a public
repo is scraped within minutes.

Open a terminal in `C:\Users\lopey\Downloads\sga`:

```bash
git init
git add .
git status
```

**Read the `git status` output.** If you see `backend/.env`, `sga.db`, or
`.venv/` listed, stop and fix `.gitignore` before continuing. You should see
roughly 25 files, all source.

```bash
git commit -m "Telegram bot, Mini App auth, wallet linking"
git branch -M main
```

Now create the repo. On github.com → **New repository** → name it `sga` →
**Private** → do *not* add a README or .gitignore → **Create**.

Copy the URL it shows you, then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/sga.git
git push -u origin main
```

> **If you ever pushed the token by accident:** rotating it in BotFather
> (`/revoke`) is the only fix. Deleting the commit is not enough — GitHub keeps
> orphaned objects, and scrapers are faster than you.

---

## 2. Deploy the Mini App to Vercel (placeholder API URL)

1. [vercel.com/new](https://vercel.com/new) → **Import** your `sga` repo.
2. **Root Directory** → click *Edit* → select `miniapp`. This is the step people
   miss; without it Vercel looks for `package.json` at the repo root and fails.
3. Framework preset should auto-detect **Next.js**. Leave build settings alone.
4. Expand **Environment Variables** and add three:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_API_URL` | `https://sga-api-v924.onrender.com` |
   | `NEXT_PUBLIC_MINIAPP_URL` | `https://sga-miniapp.vercel.app` |
   | `NEXT_PUBLIC_REOWN_PROJECT_ID` | *(see below)* |

   The first two are educated guesses at the URLs you are about to get. If
   Render or Vercel hands you a different name, step 5 fixes it.

   For the Reown ID: [dashboard.reown.com](https://dashboard.reown.com) → sign
   in → **Create Project** → name `Solana Games`, type **AppKit** → copy the
   Project ID. Without it the wallet button will not open anything.

5. **Deploy**. Wait for the build, then **copy the domain it gives you** — most
   likely `https://sga-miniapp.vercel.app`. You need it in the next step, exactly as
   shown, with no trailing slash.

---

## 3. Deploy the backend to Render

Render reads `render.yaml` from the repo root and creates both the API service
and its Postgres database in one action.

1. [dashboard.render.com](https://dashboard.render.com) → **New +** →
   **Blueprint**.
2. Connect your `sga` repo. Render finds `render.yaml` and shows you two
   resources: `sga-api` and `sga-db`.
3. It prompts for the three secrets that are not in the file:

   | Key | Value |
   |---|---|
   | `BOT_TOKEN` | paste from BotFather — no quotes, no trailing space |
   | `MINIAPP_URL` | the Vercel URL from step 2 |
   | ALLOWED_ORIGINS | https://sga-miniapp.vercel.app,https://sga-test-game.vercel.app |

   ALLOWED_ORIGINS is comma-separated. Include the wallet Mini App and every direct game origin exactly. A trailing slash, wrong protocol, or missing origin blocks authentication.

4. **Apply**. First build takes 3–5 minutes.
5. When it goes live, check the service URL at the top of the page. If it is
   **not** `https://sga-api-v924.onrender.com`, go to **Environment** → edit
   `PUBLIC_API_URL` to the real one → save. The service redeploys.

   This one matters more than it looks: `PUBLIC_API_URL` is what gets registered
   with Telegram as the webhook address. Wrong value, and the bot goes silent
   with no error anywhere.

### Confirm it came up

Open `https://sga-api-v924.onrender.com/health` in a browser. You want:

```json
{"status": "ok"}
```

Then in Render → **Logs**, look for:

```
Webhook registered at https://sga-api-v924.onrender.com/webhook/telegram
```

That line means Telegram accepted the registration. If it is missing, the token
is wrong — the log above it will say so.

---

## 4. Close the loop on Vercel

Back in Vercel → your project → **Settings** → **Environment Variables**.

Correct `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_MINIAPP_URL` if either guess in
step 2 turned out wrong.

Then — and this part is not optional — **Deployments** → the top one → **⋯** →
**Redeploy**. `NEXT_PUBLIC_*` variables are baked in at build time, not read at
runtime. Changing them without rebuilding changes nothing.

---

## 5. Open it

In Telegram, message your bot → `/start` → tap **Play**.

You do not need `/setmenubutton`. `app/main.py` calls `set_chat_menu_button` on
startup, so the button appears on its own.

You should land on the home screen with your Telegram name on it. Tap **Wallet**
→ **Connect** → Phantom or Solflare → sign the message. The address appears on
your player card and is now on `User.wallet_address` in Postgres.

---

## The free tier catch, stated plainly

**The API sleeps after 15 minutes of no traffic.** The next request wakes it,
which takes 30–60 seconds. What that looks like in practice: you open the Mini
App after a quiet hour and it sits on the loading skeleton, then works.

A cold start also eats into the `INITDATA_MAX_AGE` window. That window is now 24
hours rather than 300 seconds, so the two no longer collide — but a minute of
apparent silence still reads as a broken app.

**Also: the free Postgres expires 30 days after creation.** Render emails you.
When it does, either upgrade the database or export and recreate — otherwise you
lose every user row and every linked wallet.

---

## Uptime monitoring

Two reasons to do this, and the second is the one that matters more.

The obvious one: the free instance sleeps, so the first request after an idle
period waits 30–60 seconds. A monitor hitting `/health` every five minutes keeps
it warm and that pause disappears.

The one people skip: **without a monitor, you learn the API is down from a user.**
`/health` reports the running commit, so an alert also tells you whether a deploy
landed.

**Set it up** — [uptimerobot.com](https://uptimerobot.com), free tier:

1. **Add New Monitor** → type **HTTPS**
2. URL: `https://sga-api-v924.onrender.com/health`
3. Interval: **5 minutes**
4. Add your email under **Alert Contacts**
5. Save

Optional but worth it: under **Advanced**, set **Keyword** to `"status":"ok"`.
Without it a monitor only checks that *something* answered — a 500 page with a
200 status would pass. With it, the check fails when the response stops being the
one you expect.

**What you give up:** the instance is never idle, so free instance-hours burn
faster. Render permits this; if you outgrow the free tier, **Settings** →
**Instance Type** → **Starter** at $7/mo removes sleeping entirely and is the
real fix.

**Verify by hand any time:**

```bash
curl https://sga-api-v924.onrender.com/health
# {"status":"ok","commit":"d55a209","environment":"production","initdata_max_age":"86400"}
```

Compare `commit` against `git rev-parse --short HEAD`. If they differ, Render is
serving a stale build — which looks exactly like a fix that did not work.

---

## Dependency advisories

Run both before any release that touches dependencies:

```bash
cd miniapp && npm audit
cd ../backend && .venv/Scripts/python.exe -m pip list --outdated
```

`npm audit` on a Next + WalletConnect tree will report findings. Triage rather
than reflexively running `npm audit fix`:

- **Is it reachable from our code?** A transitive advisory in a build-time tool
  cannot be exploited by a Mini App user. One in a runtime dependency can.
- **Does `--force` upgrade a major version?** `npm audit fix --force` will happily
  break your build to clear a low-severity finding in a package you never call.
- **Are the AppKit versions pinned?** They are exact, not `^`, so
  `@walletconnect/universal-provider` stays on the version AppKit expects. Two
  copies of that library fight over one session. Re-pin deliberately, not via a
  fix command.

Record what you decided and why. An advisory you assessed and accepted is a
different thing from one you never saw, and six months later only a note tells
them apart.

---

## Redeploying after a change

```bash
git add .
git commit -m "what changed"
git push
```

Both Render and Vercel watch `main` and rebuild on push. Nothing else to do.

---

## When something is wrong

| Symptom | Cause |
|---|---|
| Mini App shows "Open this from Telegram" | You opened the Vercel URL in a browser tab. There is no `initData` outside Telegram. Open it from the bot. |
| "Could not verify your Telegram session" | `BOT_TOKEN` on Render does not match the bot that opened the app. Check for a quote or trailing space — `config.py` catches most of these at startup, so also read the deploy log. |
| Login fails, browser console shows a CORS error | The current wallet/game origin is missing from ALLOWED_ORIGINS or does not match exactly. |
| Bot ignores `/start` | Webhook not registered. Check `PUBLIC_API_URL` matches the real Render URL, then read Render's logs. |
| Wallet button does nothing | `NEXT_PUBLIC_REOWN_PROJECT_ID` missing, or set but not redeployed. |
| Everything worked, now 500s on any DB call | Free Postgres expired. |

---

## Schema changes

Production schema is Alembic's, applied by the start command
(`alembic upgrade head && uvicorn ...`) before the app process exists. A failed
migration stops the release rather than starting an app against a schema it does
not match.

`create_all` still exists and is still correct — for tests and local work, which
want a schema built and dropped per run. It now **raises** if
`ENVIRONMENT=production`, because the two mechanisms disagreeing is the failure
worth preventing: `create_all` never alters an existing table, so a model change
would appear to succeed against a fresh database and do nothing at all to the
deployed one, silently either way.

**After changing a model:**

```bash
cd backend
.venv/Scripts/python.exe -m alembic revision --autogenerate -m "what changed"
```

**Read the generated file before committing it.** Autogenerate is good at columns
and indexes and blind to intent — it cannot see that a rename is a rename, so it
proposes a drop and an add, which is data loss that passes review if nobody looks.

```bash
.venv/Scripts/python.exe -m alembic upgrade head   # apply locally
.venv/Scripts/python.exe -m pytest -q              # confirm nothing broke
```

Push, and Render applies it on the next deploy.

---

## Before real money touches this

Done since the first draft of this document:

- ~~Alembic migrations~~ — `migrations/`, applied at start
- ~~Rate limiting on `/api/auth/telegram`~~ — `app/security/rate_limit.py`
- ~~Structured logging with `BOT_TOKEN` scrubbed~~ — `app/security/log_scrub.py`

Still open, in rough priority order:

1. **Redis replay guard and rate limiter.** Both are per-process dicts, which is
   why this is pinned to one worker — and that pin is now the throughput ceiling.
   `ReplayGuard.seen()` and `FixedWindowLimiter.check()` each carry the Redis
   equivalent in a comment.
2. **An audit of the on-chain program**, which is not written yet. Nothing in
   this repo custodies funds, and nothing here should until that is done.
3. **Fold `bot_menu_messages` into `users`.** It is a separate table only because
   `create_all` could not have added a column. Alembic can, so the reason is gone.
