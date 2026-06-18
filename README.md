# Order Tracker

Polls Gmail for shipping/delivery emails every 30 minutes and updates a Notion
database with the latest status. Designed to run as a persistent process on a
Mac mini via PM2.

```
Gmail (Amazon + carriers) ──parse──▶ status + item/tracking# ──match──▶ Notion row ──▶ Status + Category + Tags
                                                                              │
                                                       Telegram ◀── per-event + daily digest
Gmail (receipts) ──parse──▶ merchant + amount ──history──▶ recurring? ──▶ Telegram alert
```

## Features

- **Multi-carrier shipment tracking** — Amazon, UPS, FedEx, USPS, India Post.
- **Notion sync** — sets **Status** and fills **Category** + **Tags**.
- **Telegram notifications** — a push on every status change ([optional](#telegram-notifications-optional)).
- **[Daily digest](#daily-digest)** — one scheduled summary of everything in transit.
- **[Subscription detection](#subscription-detection)** — flags recurring charges from receipt emails.
- **[Forwarder tracking](#forwarder-package-tracking)** — logs packages held at ForwardMe (arrival, contents, storage countdown) into a standalone Notion DB.
- **[Digital game tracking](#digital-game-tracking)** — logs eShop (US/JP) and Amazon JP digital game purchases into a standalone Notion DB.

## How shipment tracking works

| Email signal | Notion `Status` |
| --- | --- |
| "order confirmed" / "order placed" / "Ordered:" | `Ordered` |
| "has shipped" / "in transit" / "on its way" / "label created" | `In Transit` |
| "delivery delayed" / "attempted delivery" / "unable to deliver" | `Delayed` |
| "out for delivery" / "arriving today" / "will be delivered tomorrow" | `Arriving Soon` |
| "was delivered" / "has been delivered" | `Delivered` |
| "order cancelled" | `Cancelled` |
| "your return received" / "refund issued" | `Returned` |

Statuses advance along the ladder **Ordered → In Transit → Arriving Soon →
Delivered** and never regress (a late, out-of-order email can't un-deliver a
package). `Delayed` can be set while a package is in motion and is superseded
once it moves again; `Cancelled` and `Returned` are terminal.

Each row also gets a **Category** (`Game`/`Book`/`Accessory`/`Electronics`/
`Digital`/`Other`) and **Tags** (franchise like `Zelda`/`Mario`, plus attributes
like `Preorder`/`Guide`/`Limited Edition`/`Switch 2`), inferred by keyword from
the item name. Category is filled only when blank (a manual value is never
overwritten) and Tags are *merged* in (tags you add by hand are kept). Keyword
inference reliably catches accessories, books, digital codes, and known game
franchises; titles it can't place are left for you to set — or, if the optional
LLM is enabled (see [LLM fallback](#llm-fallback)), it fills the **gaps**:
classifying status for mail the regex can't read and supplying a category + tags
for items the keyword lists miss. Digital orders (codes/downloads) have no
shipment and are logged but not tracked as packages.

For each new email it parses the item/book name from the subject, fuzzy-matches
it (via [Fuse.js](https://fusejs.io/)) against the **Book** title column, sets
**Status**, and fills **Category** + **Tags** when they're blank. (Notion's
built-in *Last edited time* shows when a row last changed, so no Notes column is
needed.) A per-account "newest processed" watermark is stored in `state.json` so
nothing is reprocessed and one busy inbox can't suppress another (see
[Multiple Gmail accounts](#multiple-gmail-accounts)).

**Carrier-only emails** (UPS/FedEx/etc.) usually carry a tracking number but no
item name. When a retailer email (Amazon) matches a row *and* contains a
tracking number, the tracker records a `tracking# → row` link in `state.json`.
Later carrier updates for that number then resolve to the same row — and because
these links are shared across accounts, a retailer email in one inbox can resolve
a carrier email that lands in another. A carrier email whose tracking number was
never linked is logged as "no match" and skipped, so the link is established by
the retailer email, not the carrier.

## Prerequisites

- Node.js ≥ 20
- A Notion database with these properties (exact names, case-sensitive):
  - **Book** — `Title`
  - **Status** — `Select` with options `Ordered`, `In Transit`, `Delayed`,
    `Arriving Soon`, `Delivered`, `Cancelled`, `Returned`
  - **Category** — `Select` with options `Game`, `Book`, `Accessory`,
    `Electronics`, `Digital`, `Other` (the tracker fills this when blank)
  - **Tags** — `Multi-select` (franchise + attributes; the tracker merges in
    tags it detects and never removes ones you add)

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

### 3. Authorize one or more inboxes

Authorize each Gmail account you want to poll, giving each a short label:

```bash
npm run auth -- personal
npm run auth -- work
npm run accounts          # list the labels you've configured
```

Each run prints a Google consent URL and starts a local server. Open the URL,
**pick the intended account in Google's chooser**, and approve access. The
refresh token is written under that label into `accounts.json` (gitignored,
`0600`). Re-running with the same label re-authorizes it. See
[Multiple Gmail accounts](#multiple-gmail-accounts) for how this works.

> If Google doesn't return a refresh token (it only issues one on first
> consent), revoke the app at
> [myaccount.google.com/permissions](https://myaccount.google.com/permissions)
> and run the command again.

> **Testing-mode caveat:** while the Google Cloud app stays in "Testing", refresh
> tokens expire after 7 days. For an always-on tracker, publish the OAuth consent
> screen to **Production** (no Google verification is required for a personal app
> using only the `gmail.readonly` scope) so tokens don't expire.

### 4. Notion integration

1. Create an internal integration at
   [notion.so/my-integrations](https://www.notion.so/my-integrations) and copy
   its **Internal Integration Secret** → `NOTION_API_KEY`. The tracker only
   queries and updates pages, so the integration needs just **Read content** and
   **Update content** capabilities — leave **Insert content** and user
   information off. (Exception: the optional [forwarder feature](#forwarder-package-tracking)
   auto-creates rows, so it additionally needs **Insert content**.) Startup
   verifies access and exits with a remediation message if the integration can't
   read the database.
2. Open your database in Notion → **•••** menu → **Connections** → add your
   integration so it can read and update the database.
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

## Forwarder package tracking

Set `FORWARDER_DATABASE_ID` to track packages held at [ForwardMe](https://www.forwardme.com/)
in a **separate** Notion database (not the book DB). ForwardMe identifies packages
only by an opaque code (e.g. "L") with no item title, so this can't be linked to
your book rows — it's a standalone view of *what's at the forwarder, unshipped, and
how close to disposal*.

On the same poll loop it parses three ForwardMe email types (`FORWARDER_QUERY`,
default `from:automated@forwardme.com`) and upserts one row per package code:

| Email | Effect on the package row |
| --- | --- |
| "🎉 Your package arrived…" | create/update: `Arrived`, `From`, `Contents`, `Declared Value`, `Weight`, Status `At Forwarder` |
| "Last N Day for package X" / "approaching storage limit" | update `Days left` + a concrete `Disposal by` date |
| "[SHIP] …" / "…flying to you" | logged only (outbound emails can't be tied to a package code) |

The DB needs: **Package** (title), **Status** (select `At Forwarder`/`Shipped`),
**Arrived**/**Disposal by** (date), **From**/**Contents**/**Declared Value**/**Weight**
(text), **Days left** (number). The "unshipped" view is simply `Status = At Forwarder`.
**Shipped** is yours to set manually and the tracker never reverts it (there's no
reliable email signal for it). Unlike the book DB, this one auto-creates rows, so the
integration needs **Insert content** on it (see step 4). A misconfiguration disables
just this feature — the book tracker keeps running.

## Digital game tracking

Set `GAMES_DATABASE_ID` to track digital game purchases in a **separate** Notion DB.
On the same poll loop it parses (`GAMES_QUERY`):

| Source | Sender | Captures |
| --- | --- | --- |
| Nintendo eShop (US) | `accounts.nintendo.com` | "Confirmation of Digital Purchase" → title, total, device |
| Nintendo eShop (JP) | `accounts.nintendo.com` | `[ご利用明細] 商品のご購入` + `【予約確認】` (preorder) |
| Amazon JP codes | `digital-no-reply@` / `digitalorder-update@amazon.co.jp` | order, code-delivery, preorder |

Each is upserted to one row keyed by **Platform + title**, so an order and its later
code-delivery (or a preorder and its purchase) collapse together. `Purchased` is never
reverted to `Preordered`. The eShop clause is scoped to purchase/preorder subjects so
sign-in / verification / NSO-renewal mail from the same sender is ignored.

**Intentionally excluded** (not games): wallet funding — "Funds Added" receipts and
prepaid-credit codes (`ニンテンドープリペイド番号`) — and recurring services (Switch
Online membership, Game Catalog tickets). Widen/remove `EXCLUDE_TITLE` in
`src/games/parser.ts` to include them. DB schema: **Game** (title), **Status**
(`Preordered`/`Purchased`), **Platform**, **Date**, **Price**, **Device**. Needs
**Insert content**. A misconfig disables only this feature.

> **Platform carries the account's region.** eShop platforms are labelled with the
> account country code read off each receipt — `eShop US`, `eShop AR`, `eShop JP`, etc. —
> so a US account and a cheap-region (e.g. Argentina) account aren't conflated. This
> matters for spend: prices stay in their own currency per platform and must not be summed
> across regions (USD vs ARS vs JPY).

A **`Spend (USD)`** number column unifies them: each purchase is converted to USD at its
purchase-month rate (`src/games/fx.ts`, an editable monthly ARS/JPY table, **official**
basis — card taxes excluded), so Notion can sum/filter/chart total spend in one currency.
Extend the rate table with new months as needed; an unknown month falls back to the nearest
earlier one.

> US eShop prices/titles come from English receipts; JP from Japanese. US receipts in a
> non-US region (e.g. an Argentine eShop account) still parse — the price string is stored
> verbatim as shown.

## Multiple Gmail accounts

The tracker polls any number of Gmail accounts into the **one** Notion database,
on the one schedule. All accounts share a single Google Cloud OAuth app
(`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`); each account authorizes that app
separately and yields its own refresh token.

- `npm run auth -- <label>` authorizes one inbox and stores its token under
  `<label>` in **`accounts.json`** (gitignored, `0600`). Run it once per inbox.
- `npm run accounts` lists the configured labels.
- Every account uses the same `GMAIL_QUERY` / `SUBSCRIPTION_QUERY`.
- The source label appears in logs and Telegram messages (e.g. `[work]`); the
  Notion row itself stays clean (no per-account clutter).

Each account keeps its **own** watermark in `state.json`, so a busy inbox can't
advance past — and suppress — mail in a quieter one. Accounts are polled
sequentially; one account failing (e.g. an expired token) is logged and the rest
continue. Tracking-number → row **links** are shared across accounts, so a
retailer email in one inbox resolves a carrier email that arrives in another.

Single-account setups still work: if `accounts.json` is absent and a legacy
`GMAIL_REFRESH_TOKEN` is set, it's adopted as the account `default`, and an old
single-account `state.json` migrates automatically on first run.

## Permissions & guardrails

The process has read access to N mailboxes and write access to a Notion DB, so it
runs least-privilege and defends against runaway behavior:

- **Gmail scope** is `gmail.readonly` only — the minimum that still exposes
  message bodies (needed for status/tracking/amount). No send/modify scope is
  ever requested.
- **Notion** uses only `databases.query` + `pages.update` (Read + Update content)
  for the book DB; it never inserts or deletes there. (The optional forwarder DB
  additionally uses `pages.create`.) Startup runs an access check and exits with a
  clear message if the integration isn't connected or lacks permission.
- **Secret redaction** — every log line and Telegram message is passed through a
  redactor built from the known secrets (client secret, all refresh tokens,
  Notion key, bot token, Anthropic key), so a stack trace can't leak a token.
- **File permissions** — `accounts.json`, `state.json`, and `.env` are kept at
  `0600`.
- **Dry run** (`DRY_RUN=true`) — parses, matches, and logs what it *would* do,
  but performs no Notion writes, no Telegram sends, and no LLM calls, and does
  not persist state. Use it to tune `GMAIL_QUERY` / `MATCH_THRESHOLD` safely.
- **Status-regression guard** — statuses may only advance
  (In Transit → Arriving Soon → Delivered); a late/out-of-order email can't
  un-deliver a package. `Delivered` is terminal. Skips are logged.
- **No-op skip** — an update equal to the row's current status is skipped (no
  redundant write, no duplicate notification).
- **Notion backoff** — queries/updates retry on HTTP 429/5xx with exponential
  backoff (honoring `Retry-After`), so a burst across inboxes won't trip Notion's
  rate limit.
- **Update-cap alarm** — if one tick applies more than `MAX_UPDATES_PER_TICK`
  updates (default 25), it logs a warning and sends one Telegram alert. It's a
  soft alarm: a legitimate first-run backlog still completes.

## LLM fallback

Optionally, Claude fills the **gaps** the deterministic parser leaves. It's
**opt-in and off by default**, and only ever runs on gaps — never the whole feed.

- **Enable:** set `LLM_FALLBACK=true` **and** `ANTHROPIC_API_KEY`. If the key is
  missing the fallback stays disabled (with a warning).
- **When it runs (gaps only):** (1) status — for a message `parseMessage` returns
  `null` for (foreign-language/ambiguous); and (2) classification — when a status
  was found but the keyword lists can't type the item, to supply a **category +
  tags**. If the deterministic category is known, the LLM is not called. The LLM
  supplies status, item name, category, and tags; tracking numbers are always
  extracted deterministically, never invented by the model.
- **Cost controls:** a per-tick cap (`MAX_LLM_CALLS_PER_TICK`, default 10) counted
  across **all** accounts bounds spend if a misconfigured query floods inboxes —
  once hit, the rest of the tick skips the fallback (one warning + one alert). The
  watermark advances before any skip, so a message is classified **at most once
  ever** (negative verdicts are never retried). The email body is truncated before
  sending. `DRY_RUN` makes no LLM calls.
- **`LLM_MODEL`** is the main cost lever — leave it blank for the capable default,
  or set a smaller/cheaper model id to cut cost (this classification is easy and
  works well on cheaper tiers).
- **⚠️ Data egress / privacy:** when enabled, the **subject and (truncated) body**
  of unclassifiable shipping-query mail are sent to Anthropic's API — that content
  leaves this host. Only mail matching your shipping query is ever eligible, it's
  opt-in, and the Anthropic key is redacted from logs. Leave the fallback off if
  you don't want any email content leaving the machine.

## Configuration

All config is via `.env` (validated with [zod](https://zod.dev/) at startup).
Required keys are `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `NOTION_API_KEY`,
`NOTION_DATABASE_ID`. Gmail accounts come from `accounts.json` (via
`npm run auth -- <label>`); `GMAIL_REFRESH_TOKEN` is an optional legacy
single-account fallback. Optional keys:

- **Telegram** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) — set both to enable
  notifications, see [above](#5-telegram-notifications-optional).
- **`DIGEST_CRON`** — enable the [daily digest](#daily-digest) (needs Telegram).
- **`SUBSCRIPTION_QUERY`** — enable [subscription detection](#subscription-detection).
- **`FORWARDER_DATABASE_ID`** / **`FORWARDER_QUERY`** — enable [forwarder tracking](#forwarder-package-tracking) (needs Insert content).
- **`GAMES_DATABASE_ID`** / **`GAMES_QUERY`** — enable [digital game tracking](#digital-game-tracking) (needs Insert content).
- **Guardrails** (`DRY_RUN`, `MAX_UPDATES_PER_TICK`) — see
  [Permissions & guardrails](#permissions--guardrails).
- **LLM fallback** (`LLM_FALLBACK`, `ANTHROPIC_API_KEY`, `LLM_MODEL`,
  `MAX_LLM_CALLS_PER_TICK`) — see [LLM fallback](#llm-fallback).
- **Tuning** (`ACCOUNTS_FILE`, `GMAIL_QUERY`, `POLL_CRON`, `OAUTH_REDIRECT_PORT`,
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
  directly and writes the refresh token to `accounts.json` under the chosen label.
- **`ecosystem.config.cjs`** (not `.js`): the package is ESM, and PM2 loads its
  ecosystem file via CommonJS `require`.
- **`GMAIL_QUERY` is parenthesized** by default
  (`(from:A OR from:B OR …) label:inbox`) so `label:inbox` applies to every
  sender; Gmail binds bare `OR` loosely otherwise.

## Project layout

```
src/
  index.ts            entrypoint: wiring, account clients, schedule, shutdown
  pipeline.ts         per-account poll + guardrails (regression, caps, LLM gate)
  auth.ts             per-account OAuth flow (npm run auth -- <label>)
  config.ts           env loading + zod validation + accounts.json loader
  logger.ts           console + tracker.log logger (with secret redaction)
  redact.ts           secret redactor for logs + notifications
  retry.ts            exponential-backoff retry (Notion 429/5xx)
  fsutil.ts           atomic 0600 file writes + chmod helper
  state.ts            per-account watermarks, tracking links, subscription history
  carriers.ts         carrier senders + tracking-number patterns
  categorize.ts       item-type classifier (Game/Book/Accessory/Digital/…)
  digest.ts           daily digest builder/sender
  types.ts            shared status + category types, status ranking
  gmail/
    client.ts         Gmail API wrapper (search + decode)
    parser.ts         subject/body → status + item name + tracking + carrier
    llm-parser.ts     optional Claude fallback classifier (opt-in)
  notion/
    client.ts         Notion query + page update + access check
    matcher.ts        Fuse.js fuzzy match to the Book title
  subscriptions/
    parser.ts         receipt mail → merchant + amount
    tracker.ts        recurring-charge classification
  forwarder/
    parser.ts         ForwardMe mail → arrival / reminder / outbound event
    notion.ts         standalone "Forwarder Packages" DB client (upsert by code)
  games/
    parser.ts         eShop / Amazon JP digital mail → game purchase/preorder
    notion.ts         standalone "Digital Games" DB client (upsert by platform+title)
  telegram/
    client.ts         Telegram notifier (sendMessage); no-op / dry-run variants
    chat-id.ts        getUpdates helper (npm run telegram:chat-id)
accounts.json         label → refresh token (gitignored; npm run auth)
ecosystem.config.cjs  PM2 process definition
.env.example
```
