# Order Tracker

Polls Gmail for shipping/delivery emails every 30 minutes and updates a Notion
database with the latest status. Designed to run as a persistent process on a
Mac mini via PM2.

```
Gmail (Amazon + carriers) ──parse──▶ status + item/tracking# ──match──▶ Notion row ──▶ Status + Notes
                                                                              │
                                                       Telegram ◀── per-event + daily digest
Gmail (receipts) ──parse──▶ merchant + amount ──history──▶ recurring? ──▶ Telegram alert
```

## Features

- **Multi-carrier shipment tracking** — Amazon, UPS, FedEx, USPS, India Post.
- **Notion sync** — sets **Status** and appends a timestamped line to **Notes**.
- **Telegram notifications** — a push on every status change ([optional](#telegram-notifications-optional)).
- **[Daily digest](#daily-digest)** — one scheduled summary of everything in transit.
- **[Subscription detection](#subscription-detection)** — flags recurring charges from receipt emails.

## How shipment tracking works

| Email signal | Notion `Status` |
| --- | --- |
| "has shipped" / "in transit" / "on its way" / "label created" | `In Transit` |
| "out for delivery" / "arriving today" / "will be delivered tomorrow" | `Arriving Soon` |
| "was delivered" / "has been delivered" | `Delivered` |

For each new email it parses the item/book name from the subject, fuzzy-matches
it (via [Fuse.js](https://fusejs.io/)) against the **Book** title column, sets
**Status**, and prepends a timestamped line to **Notes**. The newest processed
message timestamp is stored in `state.json` so nothing is reprocessed.

**Carrier-only emails** (UPS/FedEx/etc.) usually carry a tracking number but no
item name. When a retailer email (Amazon) matches a row *and* contains a
tracking number, the tracker records a `tracking# → row` link in `state.json`.
Later carrier updates for that number then resolve to the same row. A carrier
email whose tracking number was never linked is logged as "no match" and
skipped — so the link is established by the retailer email, not the carrier.

## Prerequisites

- Node.js ≥ 20
- A Notion database with these properties (exact names, case-sensitive):
  - **Book** — `Title`
  - **Status** — `Select` with options `Delivered`, `In Transit`, `Arriving Soon`
  - **Notes** — `Text`

## Setup

### 1. Install

```bash
npm install
cp .env.example .env
```

### 2. Google Cloud OAuth (Gmail, read-only)

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create
   (or select) a project.
2. **APIs & Services → Library →** enable **Gmail API**.
3. **APIs & Services → OAuth consent screen:** choose **External**, fill in the
   required fields, and add your Google account under **Test users**. (No
   verification is needed while the app stays in "Testing".)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Application type: _Desktop app_.** A Desktop client allows the loopback
   redirect (`http://localhost:PORT`) used by the auth flow with no extra setup.
5. Copy the **Client ID** and **Client secret** into `.env`:
   ```
   GMAIL_CLIENT_ID=...apps.googleusercontent.com
   GMAIL_CLIENT_SECRET=...
   ```

### 3. Generate a refresh token

```bash
npm run auth
```

This prints a Google consent URL and starts a local server. Open the URL,
approve access, and the resulting `GMAIL_REFRESH_TOKEN` is written back into
`.env` automatically.

> If Google doesn't return a refresh token (it only issues one on first
> consent), revoke the app at
> [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
> and run `npm run auth` again.

### 4. Notion integration

1. Create an internal integration at
   [notion.so/my-integrations](https://www.notion.so/my-integrations) and copy
   its **Internal Integration Secret** → `NOTION_API_KEY`.
2. Open your database in Notion → **•••** menu → **Connections** → add your
   integration so it can read and write the database.
3. `NOTION_DATABASE_ID` is pre-filled in `.env.example`
   (`e452d104-c168-4da9-8e76-953fb9057e30`). Change it if needed — it's the
   32-char ID in the database URL.

### 5. Telegram notifications (optional)

Skip this to run without notifications. To enable them:

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`,
   and follow the prompts. Copy the bot token it gives you → `TELEGRAM_BOT_TOKEN`.
2. Send your new bot any message (e.g. "hi") so it has an update to read.
3. Find your chat ID:
   ```bash
   npm run telegram:chat-id
   ```
   It calls Telegram's `getUpdates` and prints the chat ID(s) that have messaged
   the bot. Paste the one you want into `TELEGRAM_CHAT_ID`.

Both keys must be set together (the config validation rejects setting only one).
You'll then get a message on each status change, on startup, and if a poll
fails. Telegram delivery is best-effort: failures are logged but never
interrupt polling or Notion updates.

## Running

```bash
npm run dev      # run with live reload (tsx watch), polls immediately then on schedule
npm run build    # compile TypeScript → dist/
npm start        # run the compiled build
```

Logs go to the console and to `tracker.log`. Status changes are tagged
`[CHANGE]` for easy grepping:

```bash
grep '\[CHANGE\]' tracker.log
```

## Auto-start on the Mac mini (PM2)

```bash
npm install -g pm2
npm run build
pm2 start ecosystem.config.cjs
pm2 save                  # persist the process list
pm2 startup               # prints a command — run it to enable boot-time start
```

Update `cwd` in `ecosystem.config.cjs` if you cloned the repo elsewhere.

## Daily digest

Set `DIGEST_CRON` (and configure Telegram) to receive one summary message on a
schedule listing every row currently `Arriving Soon` or `In Transit`:

```
DIGEST_CRON=0 8 * * *      # 8:00am daily
```

If nothing is in transit it sends a short "nothing in transit" note so you know
the job ran. Leave `DIGEST_CRON` unset to disable. The digest is independent of
the poll loop and reads only from Notion.

## Subscription detection

Set `SUBSCRIPTION_QUERY` to also scan receipt/billing mail (on the same poll
loop) for recurring charges:

```
SUBSCRIPTION_QUERY=(subject:receipt OR subject:invoice OR subject:subscription) label:inbox
```

Each matching email is parsed for a merchant (from the sender) and an amount.
A per-merchant history is kept in `state.json`, and a Telegram alert fires when:

- the merchant has charged **before** (a recurring charge), or
- the email explicitly reads like a **new subscription** (e.g. "renewed",
  "membership", "auto-renew").

A first-time one-off purchase is recorded silently. This feature only notifies —
it does **not** write to the Notion book database. Tune the query to match the
receipt mail in your inbox; leave it unset to disable.

## Configuration

All config is via `.env` (validated with [zod](https://zod.dev/) at startup).
Required keys are `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
`GMAIL_REFRESH_TOKEN`, `NOTION_API_KEY`, `NOTION_DATABASE_ID`. Optional keys:

- **Telegram** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) — set both to enable
  notifications, see [above](#5-telegram-notifications-optional).
- **`DIGEST_CRON`** — enable the [daily digest](#daily-digest) (needs Telegram).
- **`SUBSCRIPTION_QUERY`** — enable [subscription detection](#subscription-detection).
- **Tuning** (`GMAIL_QUERY`, `POLL_CRON`, `OAUTH_REDIRECT_PORT`,
  `MATCH_THRESHOLD`, `STATE_FILE`, `LOG_FILE`) — documented in `.env.example`.

`MATCH_THRESHOLD` (default `0.4`, range 0–1) is worth knowing: lower is
stricter. Raise it if real books aren't matching; lower it if the wrong rows
get updated.

## Notes on the spec

A few small, deliberate deviations from the original brief:

- **OAuth uses a built-in loopback flow** (`google-auth-library`, bundled with
  `googleapis`) rather than `@google-cloud/local-auth`. `local-auth` reads
  credentials from a downloaded keyfile, which conflicts with this project's
  `.env`-based config; the loopback flow reads `GMAIL_CLIENT_ID/SECRET`
  directly and writes the token back to `.env`.
- **`ecosystem.config.cjs`** (not `.js`): the package is ESM, and PM2 loads its
  ecosystem file via CommonJS `require`.
- **`GMAIL_QUERY` is parenthesized** by default
  (`(from:A OR from:B OR …) label:inbox`) so `label:inbox` applies to every
  sender; Gmail binds bare `OR` loosely otherwise.

## Project layout

```
src/
  index.ts            entrypoint + jobs (shipping, subscriptions, digest), shutdown
  auth.ts             one-time OAuth flow (npm run auth)
  config.ts           env loading + zod validation
  logger.ts           console + tracker.log logger
  state.ts            timestamps, tracking links, subscription history
  carriers.ts         carrier senders + tracking-number patterns
  digest.ts           daily digest builder/sender
  types.ts            shared OrderStatus type
  gmail/
    client.ts         Gmail API wrapper (search + decode)
    parser.ts         subject/body → status + item name + tracking + carrier
  notion/
    client.ts         Notion query + page update
    matcher.ts        Fuse.js fuzzy match to the Book title
  subscriptions/
    parser.ts         receipt mail → merchant + amount
    tracker.ts        recurring-charge classification
  telegram/
    client.ts         Telegram notifier (sendMessage); no-op when unconfigured
    chat-id.ts        getUpdates helper (npm run telegram:chat-id)
ecosystem.config.cjs  PM2 process definition
.env.example
```
