# Deploy

Backend on **Render**, Mini App on **Vercel**. Both free tier. No local server.

Total time: ~30 minutes. Do the steps in order — step 4 needs a URL from step 3,
and step 5 needs a URL from step 4.

---

## The order matters, and here is why

The two halves reference each other:

- The backend needs `MINIAPP_URL` and `ALLOWED_ORIGINS` (the Vercel URL).
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
   | `NEXT_PUBLIC_API_URL` | `https://sga-api.onrender.com` |
   | `NEXT_PUBLIC_MINIAPP_URL` | `https://sga.vercel.app` |
   | `NEXT_PUBLIC_REOWN_PROJECT_ID` | *(see below)* |

   The first two are educated guesses at the URLs you are about to get. If
   Render or Vercel hands you a different name, step 5 fixes it.

   For the Reown ID: [dashboard.reown.com](https://dashboard.reown.com) → sign
   in → **Create Project** → name `Solana Games`, type **AppKit** → copy the
   Project ID. Without it the wallet button will not open anything.

5. **Deploy**. Wait for the build, then **copy the domain it gives you** — most
   likely `https://sga.vercel.app`. You need it in the next step, exactly as
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
   | `ALLOWED_ORIGINS` | the same Vercel URL, again |

   `ALLOWED_ORIGINS` must match `MINIAPP_URL` character for character. A
   trailing slash or `http` instead of `https` means CORS blocks every login,
   and the browser error will not tell you that clearly.

4. **Apply**. First build takes 3–5 minutes.
5. When it goes live, check the service URL at the top of the page. If it is
   **not** `https://sga-api.onrender.com`, go to **Environment** → edit
   `PUBLIC_API_URL` to the real one → save. The service redeploys.

   This one matters more than it looks: `PUBLIC_API_URL` is what gets registered
   with Telegram as the webhook address. Wrong value, and the bot goes silent
   with no error anywhere.

### Confirm it came up

Open `https://sga-api.onrender.com/health` in a browser. You want:

```json
{"status": "ok"}
```

Then in Render → **Logs**, look for:

```
Webhook registered at https://sga-api.onrender.com/webhook/telegram
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

Worse, it interacts with a rule you cannot change. `initData` is rejected once it
is older than `INITDATA_MAX_AGE` (300s). A cold start burns up to 60 of those
seconds. You are still well inside the window, but if you also raise the sleep
threshold or the user leaves the app open, the two can collide and login fails
with "Reopen the app."

Two ways out:

- **$7/mo** — Render → `sga-api` → **Settings** → **Instance Type** →
  **Starter**. No sleeping. This is the real fix.
- **Free** — [uptimerobot.com](https://uptimerobot.com), add an HTTPS monitor on
  `https://sga-api.onrender.com/health` every 5 minutes. Keeps it awake. Render
  permits this; it also means the service is never idle, so you burn instance
  hours faster.

**Also: the free Postgres expires 30 days after creation.** Render emails you.
When it does, either upgrade the database or export and recreate — otherwise you
lose every user row and every linked wallet.

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
| Login fails, browser console shows a CORS error | `ALLOWED_ORIGINS` does not exactly equal your Vercel URL. |
| Bot ignores `/start` | Webhook not registered. Check `PUBLIC_API_URL` matches the real Render URL, then read Render's logs. |
| Wallet button does nothing | `NEXT_PUBLIC_REOWN_PROJECT_ID` missing, or set but not redeployed. |
| Everything worked, now 500s on any DB call | Free Postgres expired. |

---

## Before real money touches this

Deploying does not change what is in the original README's final section. Still
open, in rough priority order:

1. **Alembic migrations.** `create_all` builds the schema on first boot and then
   never touches it again. Your next model change will not appear in Postgres,
   and nothing will tell you.
2. **Redis replay guard.** `ReplayGuard` is per-process, which is why this is
   pinned to one worker. It caps your throughput.
3. **Rate limiting on `/api/auth/telegram`.** It is unauthenticated by
   definition and does an HMAC per call.
4. **Structured logging with `BOT_TOKEN` scrubbed.** Render retains logs.
5. **An audit of the on-chain program**, which is not written yet.
