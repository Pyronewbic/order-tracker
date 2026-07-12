# Configuration reference

Every runtime option this tracker reads, plus the de-personalization knobs that
live in code. This is the single source of truth for configuration; the README
should link here rather than restate it.

Configuration comes from three places:

1. **`.env`** — the environment variables in the tables below. Copy
   `.env.example` to `.env` and edit. Loaded and validated by `src/config.ts`
   (zod). Blank values (`KEY=`) are treated as unset, so a freshly-copied
   `.env.example` boots with all optionals off.
2. **`accounts.json`** — the label → Gmail refresh-token map, written by
   `npm run auth -- <label>`. Not hand-edited. See [Gmail / accounts](#gmail--accounts).
3. **Code constants** — the "taste" knobs (which items count as books/games,
   franchise tags/abbreviations, FX fallback rates, the Notion title column
   name). These are author-specific and are edited in source, not `.env`. See
   [De-personalization knobs](#de-personalization-knobs).

Conventions used below:

- **Required** — startup throws without it.
- **Optional** — has a default (shown) or is simply off when unset.
- **Opt-in DB** — a `*_DATABASE_ID`; **unset = that feature is off entirely.**
- Boolean vars accept `1`/`true`/`yes`/`on` (case-insensitive) as true;
  anything else is false.
- All example values below are **placeholders**. Do not ship real IDs/tokens.

---

## Quick reference: required vs. optional

**Minimum to boot** (startup throws otherwise):

- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`
- `NOTION_API_KEY`, `NOTION_DATABASE_ID`
- **At least one authorized Gmail account** — via `accounts.json`
  (`npm run auth`) **or** the legacy `GMAIL_REFRESH_TOKEN`. With neither,
  startup throws `No Gmail accounts configured`.

**Conditionally required (all-or-nothing / dependency pairs):**

- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` — set **both** or **neither**;
  setting one alone fails validation.
- `DIGEST_CRON` — needs Telegram configured (the digest is a Telegram message).
- `LLM_FALLBACK=true` — needs `ANTHROPIC_API_KEY`; without the key the fallback
  silently stays disabled.

**Everything else is optional.** Each `*_DATABASE_ID` is opt-in: unset = off.

---

## Core

| Variable | Required? | Default | What it does | Example / placeholder |
|---|---|---|---|---|
| `POLL_CRON` | Optional | `*/30 * * * *` | Cron expression for the poll loop. Also runs once immediately on boot. | `*/30 * * * *` |
| `MATCH_THRESHOLD` | Optional | `0.4` | Fuse.js fuzzy-match threshold, `0` (exact) … `1` (loose), for matching parsed item names to curated book rows. Matches scoring above this are rejected. | `0.4` |
| `STATE_FILE` | Optional | `state.json` | Path for persisted per-account watermarks and email→row links. Written to the working directory; gitignored. | `state.json` |
| `LOG_FILE` | Optional | `tracker.log` | Path for the run log. Working directory; gitignored. | `tracker.log` |
| `OAUTH_REDIRECT_PORT` | Optional | `4567` | Loopback port used **only** during the one-time `npm run auth` flow. Must be free while authorizing. | `4567` |

---

## Gmail / accounts

One shared Google Cloud OAuth "Desktop app" client authorizes every inbox. Each
account is authorized separately (`npm run auth -- <label>`), and its refresh
token is stored in `accounts.json` (gitignored). The requested scope is
`https://www.googleapis.com/auth/gmail.readonly` (read-only, whole mailbox —
Gmail has no per-label scope).

| Variable | Required? | Default | What it does | Example / placeholder |
|---|---|---|---|---|
| `GMAIL_CLIENT_ID` | **Required** | — | OAuth 2.0 client ID from Google Cloud Console. | `your-client-id.apps.googleusercontent.com` |
| `GMAIL_CLIENT_SECRET` | **Required** | — | OAuth 2.0 client secret. | `your-client-secret` |
| `ACCOUNTS_FILE` | Optional | `accounts.json` | Path to the `{ "<label>": "<refresh_token>" }` file written by `npm run auth`. | `accounts.json` |
| `GMAIL_REFRESH_TOKEN` | Optional | — | Legacy single-account fallback. Used **only** if `accounts.json` is empty/absent; adopted as an account labelled `default`. Prefer `accounts.json`. | `1//0g...` (leave blank) |

**Gmail search queries** — one query per source; identical across all accounts.
Each query is only consulted when its feature is enabled. Parenthesize
`OR`-grouped senders so a trailing `label:inbox` binds to all of them.

| Variable | Required? | Default (senders covered) | What it does |
|---|---|---|---|
| `GMAIL_QUERY` | Optional | Amazon (`shipment-tracking@amazon.com`, `auto-confirm@amazon.in`) + UPS/FedEx/USPS/India Post, `label:inbox` | Shipping/tracking mail for the main book/shipment tracker. |
| `SUBSCRIPTION_QUERY` | Optional | — (unset → subscription detection off) | Receipt/billing mail scanned for recurring charges; alerts via Telegram. |
| `FORWARDER_QUERY` | Optional | `from:automated@forwardme.com` | ForwardMe package-notification mail. Only used when `FORWARDER_DATABASE_ID` is set. |
| `GAMES_QUERY` | Optional | Amazon JP digital (`digital-no-reply@`, `digitalorder-update@amazon.co.jp`) + Nintendo eShop purchase/preorder subjects | Digital game purchases. Only used when `GAMES_DATABASE_ID` is set. |
| `GENERAL_QUERY` | Optional | `auto-confirm@amazon.{com,in,co.jp}` | Amazon order-confirmation mail → general Purchases DB. Only used when `GENERAL_DATABASE_ID` is set. |
| `GENERAL_LIFECYCLE_QUERY` | Optional | Amazon `shipment-tracking@`/`order-update@`/`return@` across `.com`/`.in`/`.co.jp` | Post-order mail (ship/deliver/cancel/refund) that advances a general order's Status by its order number. Excludes `auto-confirm@` (handled by `GENERAL_QUERY`). Only used when `GENERAL_DATABASE_ID` is set. |
| `EBAY_QUERY` | Optional | `from:ebay.com subject:(confirmed OR carrier OR delivered OR delivery OR refund)` | eBay order events into the same general DB (as Collectibles). Subject-scoped so bids/offers/feedback/marketing are skipped. Only used when `GENERAL_DATABASE_ID` is set. |

---

## Notion databases (each opt-in)

The main book DB is required; every other DB is opt-in via its `*_DATABASE_ID`
(**unset = that feature off**). One integration serves all of them.

**Integration capabilities:** the main book DB needs only **Read** + **Update**.
The auto-creating DBs (forwarder, games, general, spend summary, tech
accessories) each additionally need **Insert content**. The integration must be
connected to **each** DB you use individually (••• → Connections).

| Variable | Required? | Default | What it does | Example / placeholder |
|---|---|---|---|---|
| `NOTION_API_KEY` | **Required** | — | Notion integration secret. | `secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `NOTION_DATABASE_ID` | **Required** | — | Main book/shipment tracker DB. 32-char ID from the DB URL. Startup verifies read access and exits if it can't read the DB. | `your-notion-database-id` |
| `FORWARDER_DATABASE_ID` | Opt-in | off | Standalone "Forwarder Packages" DB (packages held at ForwardMe, keyed by package code). Needs Insert content. | `your-forwarder-db-id` |
| `GAMES_DATABASE_ID` | Opt-in | off | Standalone "Digital Games" DB (Nintendo eShop US/JP, Amazon JP game codes). Wallet top-ups and NSO subscriptions excluded. Needs Insert content. | `your-games-db-id` |
| `GENERAL_DATABASE_ID` | Opt-in | off | General "Purchases" DB (non-book/game Amazon orders + eBay). One row per order; book/game orders are dropped so the summary never double-counts. Needs Insert content. Gates `GENERAL_LIFECYCLE_QUERY` and `EBAY_QUERY`. | `your-general-db-id` |
| `SPEND_SUMMARY_DATABASE_ID` | Opt-in | off | Cross-DB "Spend Summary" DB rolling per-month USD spend (books + games + general) into a Source × Month view. Needs Insert content. | `your-summary-db-id` |
| `TECH_ACCESSORIES_DATABASE_ID` | Opt-in | off | Tech Inventory "Accessories" DB. A tech-accessory purchase (charger/cable/hub/case/audio/storage/input… — **not** a whole device) is auto-added here, self-categorized, with a delivery ladder (`Ordered → Shipped → Arriving → Owned`), **instead of** the general Purchases DB. Keyed by a hidden `Order #`; manual rows are never touched. Needs Insert content. Priced creation uses the order-confirmation pass, so enable `GENERAL_DATABASE_ID` too. | `your-accessories-db-id` |

> The main DB's Status values pass through a translation layer
> (`src/notion/status-map.ts`) — not every internal status is written verbatim.
> That schema behavior is documented in the Notion-schema / setup docs, not here.

---

## Telegram (optional)

Set **both** or **neither**; one alone fails validation. Chat ID: message your
bot first, then run `npm run telegram:chat-id` **before** starting the tracker
(a running tracker's polling drains the updates the helper reads). Group chat IDs
are negative.

| Variable | Required? | Default | What it does | Example / placeholder |
|---|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Optional (pair) | — | Bot token from @BotFather. Enables all Telegram notifications. | `123456:ABC-DEF...` |
| `TELEGRAM_CHAT_ID` | Optional (pair) | — | Destination chat ID for notifications and the digest. | `123456789` (or `-100...` for a group) |

---

## Digest / schedule / timezone

| Variable | Required? | Default | What it does | Example / placeholder |
|---|---|---|---|---|
| `DIGEST_CRON` | Optional | — (unset → digest off) | Cron expression for the daily Telegram digest. **Requires Telegram.** Lists every order still on the way, **soonest ETA first**, with an "arriving soon" (next 3 days) section (statuses `Arriving Soon` / `In Transit` / `Ordered`; `Delivered` and terminal statuses omitted). | `0 8 * * *` (8am daily) |

**Timezone.** Both cron schedules (`POLL_CRON`, `DIGEST_CRON`) run in the **host
process timezone** — there is no timezone env var. To pin the schedule, set the
standard `TZ` environment variable for the process (e.g. `TZ=America/New_York`
in `.env`, PM2 env, or the shell) so, for example, `DIGEST_CRON=0 8 * * *` fires
at 8am in your zone rather than the host default/UTC.

---

## Anthropic / LLM fallback (opt-in)

Off by default. When on, it fills only the gaps deterministic parsing can't:
status the regex can't read, and category/tags the keyword lists can't type.
**Data egress:** when enabled, the subject + truncated body of such mail is sent
to Anthropic's API — content leaves the host.

| Variable | Required? | Default | What it does | Example / placeholder |
|---|---|---|---|---|
| `LLM_FALLBACK` | Optional (bool) | `false` | Master switch. `true` needs `ANTHROPIC_API_KEY`; without it, the fallback silently stays off. | `false` |
| `ANTHROPIC_API_KEY` | Conditionally required | — | Required when `LLM_FALLBACK=true`. | `sk-ant-...` (leave blank) |
| `LLM_MODEL` | Optional | `claude-opus-4-8` | Model ID for the fallback. Cost lever: set a smaller/cheaper model (classification works well on cheaper tiers). Blank → default. | `claude-opus-4-8` |
| `MAX_LLM_CALLS_PER_TICK` | Optional | `10` | **Budget kill-switch:** hard cap on LLM calls per tick, summed across **all** accounts. Bounds spend if a query floods inboxes with non-shipping mail. | `10` |

---

## Runtime guardrails

| Variable | Required? | Default | What it does | Example / placeholder |
|---|---|---|---|---|
| `DRY_RUN` | Optional (bool) | `false` | Preview mode: parse + match + log, but **no** Notion writes, **no** Telegram sends, **no** LLM calls, and state is **not** persisted. Safe for tuning queries/threshold across many inboxes before going live. | `false` |
| `MAX_UPDATES_PER_TICK` | Optional | `25` | Soft alarm (not a hard stop): if one tick applies more Notion updates than this, it warns and pings — usually a sign of a misconfigured query. | `25` |

---

## FX / currency

USD is the base currency the spend summary reports in. Daily rates come from the
Frankfurter (ECB) API; a hand-maintained monthly fallback table covers
currencies the API doesn't publish (e.g. ARS) or when the API is unreachable.

| Variable | Required? | Default | What it does | Example / placeholder |
|---|---|---|---|---|
| `FX_CACHE_FILE` | Optional | `fx-cache.json` | Path to the FX rate cache (`<currency>:<YYYY-MM-DD>` → USD per unit). Read directly via `process.env` in `src/money/fx.ts` (not part of the `.env.example` template). Working directory; gitignored. | `fx-cache.json` |

The rate tables themselves are **code constants** — see
[De-personalization knobs](#de-personalization-knobs).

---

## De-personalization knobs

These encode the author's specific collection, locale, and merchants. They are
**not all env vars** — several are code constants you edit in source, or example
queries you adapt. For each below: what it is, where it lives, and how to change
it.

### Taste filters — what counts as a book / game / accessory / etc.

- **Type:** code constants (keyword regexes).
- **Where:** `src/categorize.ts` — `BOOK`, `GAME`, `ACCESSORY`, `ELECTRONICS`,
  `DIGITAL_TEXT`/`DIGITAL_SENDER`. These drive which general Amazon orders get
  dropped as "domain-owned" (books/games belong to their own DBs) vs. kept in
  the general Purchases DB, and how items are categorized.
- **How to change:** extend the regex alternations with the series/terms you buy.
  The lists are intentionally easy to extend; arbitrary titles the keywords miss
  fall to the optional LLM categorizer (if enabled).

### Franchise tags

- **Type:** code constant (array of `[regex, tag]`).
- **Where:** `src/categorize.ts` — `FRANCHISES` (e.g. Zelda, Mario, Pokémon …),
  plus the attribute tags (`Preorder`, `Guide`, `Limited Edition`, etc.) in
  `tagsFor()`.
- **How to change:** add/remove `[/pattern/i, "Tag"]` rows for your franchises.

### Franchise abbreviations (row-name matching)

- **Type:** code constant.
- **Where:** `src/notion/matcher.ts` — `ABBREVIATIONS` (e.g.
  `botw → breath of the wild`, `totk → tears of the kingdom`). Lets a curated
  Notion row typed in shorthand match the spelled-out title in a Amazon email.
- **How to change:** add `abbrev: ["expanded", "token", "list"]` entries.

### Notion title column name ("Book")

- **Type:** code constant (hardcoded, not configurable).
- **Where:** `src/notion/client.ts` — the main DB's title property is read as
  `Book` (also surfaced in `OrderRow.book`, the matcher, and the digest).
- **How to change:** your main Notion DB's title column must currently be named
  exactly `Book`. To track non-book orders, either name your title column `Book`
  or edit these references to a neutral name (e.g. `Item`).

### FX fallback rates & unsupported-currency list

- **Type:** code constants.
- **Where:** `src/money/fx.ts` — `FALLBACK_RATES` (hand-maintained, monthly, in
  local units per 1 USD; an unknown month uses the nearest earlier one) and
  `API_UNSUPPORTED` (currencies to skip the API for, e.g. `ARS`).
- **How to change:** add currencies/months to `FALLBACK_RATES` and add any
  API-unsupported currency codes to `API_UNSUPPORTED`. The runtime cache file is
  the `FX_CACHE_FILE` env var above.

### Locale / currency / timezone

- **Currency:** base is USD (see [FX / currency](#fx--currency)); source→currency
  inference lives in `bookCurrency()` (`src/summary/notion.ts`) and the games
  currency map (`src/games/fx.ts`). Code constants.
- **Currency symbols parsed:** `$ £ € ₹ ¥` and `USD/GBP/EUR/INR` in the amount
  regexes (`src/subscriptions/parser.ts`, `src/general/*`). Code constants —
  extend to parse other symbols.
- **Timezone:** set the standard `TZ` env var (see
  [Digest / schedule / timezone](#digest--schedule--timezone)); cron has no
  timezone option.

### Merchant / region "Source" bucketing

- **Type:** code constant.
- **Where:** `src/summary/notion.ts` — `generalSource()` collapses the three
  Amazon regions into one `Amazon` bucket, keeps `eBay` separate, and defaults
  everything else to `General`.
- **How to change:** edit the mapping for your merchant set.

### Forwarder

- **Type:** env var (query) + opt-in DB.
- **Where:** `FORWARDER_QUERY` (default `from:automated@forwardme.com`) and
  `FORWARDER_DATABASE_ID`. The parser (`src/forwarder/parser.ts`) is written for
  ForwardMe's mail format specifically.
- **How to change:** if you use a different forwarder, change `FORWARDER_QUERY`
  to its sender and adapt the parser to that provider's email format. Leave
  `FORWARDER_DATABASE_ID` unset to disable forwarder tracking entirely.

### Digest active statuses

- **Type:** code constant.
- **Where:** `src/digest.ts` — `ACTIVE = ["Arriving Soon", "In Transit",
  "Ordered"]`. Governs which rows appear in the daily digest; rows are ordered
  **soonest ETA first** (this array is only the fallback order for rows with no
  ETA). `Delayed` is excluded — the book DB folds it into In Transit on write.
- **How to change:** edit the array to add/remove statuses.

### Tech-accessory buckets & device exclusion

- **Type:** code constants (keyword regexes).
- **Where:** `src/categorize.ts` — `TECH_BUCKETS` maps a purchase to one of the
  Accessories DB's category buckets (Power / Cable / Connectivity / Storage /
  Case·Carry / Audio / Input / Capture / Display), and `techAccessoryCategory()`
  decides whether a purchase is a tech accessory routed to
  `TECH_ACCESSORIES_DATABASE_ID` — deliberately excluding whole **devices** (a
  console/laptop classifies as Electronics, not an accessory).
- **How to change:** extend `TECH_BUCKETS` with the accessory keywords you buy; a
  tech item matching no specific bucket falls to `Other`.
