# Architecture

A personal Gmail → Notion order and spend tracker. It polls one or more Gmail
inboxes on a schedule, parses shipping / order / receipt mail (deterministically
first, with a bounded LLM fallback), and writes normalized status and spend data
to a set of Notion databases. It runs as a long-lived Node process (under PM2)
and can send a Telegram digest.

This project is **spend-only by design**: it records what was bought and how far
along an order is, but does not track collectible value or portfolio worth — a
separate application owns that.

## Runtime shape

- TypeScript / Node ESM (`NodeNext`, `.js` import specifiers), strict `tsconfig`
  (`strict`, `noUncheckedIndexedAccess`).
- Validation with zod v3 throughout (env, `accounts.json`, `state.json`, and every
  Notion API response slice the code reads).
- Third-party clients: `googleapis` (Gmail, OAuth2 refresh tokens),
  `@notionhq/client` (Notion), `@anthropic-ai/sdk` (optional LLM fallback),
  `node-cron` (scheduling), `fuse.js` (fuzzy matching).
- Entry point `src/index.ts` compiles to `dist/index.js`; PM2 runs it via
  `ecosystem.config.cjs` (fork mode, autorestart, `kill_timeout` to let SIGTERM
  flush state).

## High-level data flow

```
Gmail (per account) ──▶ deterministic parser ──▶ (gap?) ──▶ bounded LLM fallback
                                     │                              │
                                     ▼                              ▼
                         status / item / tracking# / order# / amount / category
                                     │
                     ┌───────────────┼───────────────────────────┐
                     ▼               ▼                            ▼
              match to a       upsert into a               accumulate
              curated Notion   standalone Notion DB        cross-DB spend
              "book" row       (packages / games /         summary (USD)
              (shipping)       general / eBay)                    │
                     └───────────────┴───────────────────────────┘
                                     ▼
                        Notion writes + Telegram (event + daily digest)
```

## Modules

- `index.ts` — process wiring. Loads config, builds the redactor and logger,
  hardens secret files, constructs one `GmailClient` per account (reused every
  tick), verifies Notion access, conditionally constructs each optional feature
  client, builds the notifier and optional LLM parser, validates cron
  expressions, then schedules the poll loop and optional digest. Handles
  overlap-guarding, dry-run persistence, and graceful shutdown (SIGINT/SIGTERM).
- `pipeline.ts` — the poll (`runTick`) and all per-job passes. Owns the transition
  rules (`planUpdate`), row resolution, the LLM gate (`callLlm`), and the guardrail
  accounting (update cap, LLM cap).
- `config.ts` — env schema + `loadRuntimeConfig` (merges `.env` with
  `accounts.json`; falls back to a legacy single `GMAIL_REFRESH_TOKEN`). A blank
  env value is treated as unset so a freshly-copied `.env.example` validates.
- `state.ts` — persisted watermarks + link maps (see State below), with a zod
  schema that migrates a legacy single-account file into the `default` account.
- `auth.ts` — one-time interactive OAuth CLI (`npm run auth -- <label>`) using a
  loopback redirect; writes a refresh token per label into `accounts.json`. Scope
  is `gmail.readonly` only (no send/modify scope is ever requested).
- `gmail/` — `client.ts` (list + fetch + MIME decode to a flat `ParsedMessage`),
  `parser.ts` (subject/body → status + item name + tracking# + order#),
  `llm-parser.ts` (optional Claude classifier).
- `notion/` — `client.ts` (curated book DB: query + update + access check),
  `matcher.ts` (fuzzy + containment matching), `status-map.ts` (vocabulary
  translation at the Notion boundary).
- `money/fx.ts` — currency parsing and USD conversion (cache → API → fallback).
- Plugins (each with its own parser and, where it writes, its own Notion client):
  `forwarder/` (ForwardMe packages), `games/` (digital games),
  `general/` + `general/ebay/` (general purchases and eBay collectibles-as-spend),
  `subscriptions/` (recurring-charge detection), `summary/` (cross-DB spend
  rollup), `digest.ts` (daily Telegram summary), `telegram/` (notifier).
- Support: `redact.ts`, `logger.ts`, `retry.ts`, `fsutil.ts`, `carriers.ts`,
  `categorize.ts`, `types.ts`.

## The poll loop and scheduling

`node-cron` drives two independent schedules, both validated up front so a typo
fails fast rather than after a live poll:

- `POLL_CRON` (default every 30 min) runs the tick. The tick also runs once
  immediately on boot.
- `DIGEST_CRON` (optional) runs the daily digest.

An in-process `running` flag guards against overlap: if a poll outlives its
interval, the next tick is skipped rather than run concurrently. The tick loads
state, calls `runTick`, and — unless `DRY_RUN` is set — persists state once at the
end. A failed tick is logged and pinged to Telegram but never crashes the
process. Each successful tick writes `state.json` exactly once (the caller, not
`runTick`, owns load/save).

## Per-account processing

`runTick` fetches the curated Notion "book" rows **once** (shared across all
accounts and passes for the tick), then iterates each account's `GmailClient` and
runs its jobs sequentially: shipping, subscriptions, forwarder, games, general.
Each job is wrapped in its own try/catch so one job failing for one account
(shipping, say) does not stop that account's other jobs or any other account —
**failure isolation is per (account × job)**. The cross-DB spend summary runs once
per tick after all accounts, also isolated.

## State and watermarks

`state.json` (owner-only permissions, written atomically via temp-file + rename)
holds:

- `accounts[label]` — a per-account watermark record with a separate "newest
  processed" epoch-ms timestamp **per job**: `lastProcessedMs` (shipping),
  `subscriptionLastMs`, `forwarderLastMs`, `gamesLastMs`, `generalLastMs`,
  `generalLifecycleLastMs`, `ebayLastMs`. Independent watermarks mean an idle
  Amazon inbox never blocks the eBay or lifecycle passes, and one busy account
  can't suppress another.
- `links` — tracking number → linked row (global; enables cross-account dedup).
- `orderLinks` — Amazon order number → linked row (lets a later title-less update
  resolve to the row a prior titled email established).
- `subscriptions` — per-merchant charge history for recurring detection.

Each job fetches only mail newer than its watermark (`fetchNewMessages` translates
the ms watermark into Gmail's second-resolution `after:` clause, minus one second
to avoid an off-by-one miss, then de-dups precisely against the stored ms). It
processes messages **oldest-first**, and advances the watermark **before** any
branch, skip, LLM call, or failure — so a message is processed at most once ever.
This is deliberate for cost control: a negative LLM verdict must never trigger a
second paid call on a later tick. The trade-off is that a message which errors
mid-processing is not retried once the watermark has passed it. Message fetches
within a job use `Promise.allSettled`, so a single un-fetchable message is skipped
(and retried next tick until the watermark advances past it) rather than wedging
the whole inbox.

## Deterministic-first, bounded LLM fallback

The core design is **deterministic parsing first, LLM only for the gaps**:

- **Status** comes from ordered regex rules (`gmail/parser.ts`, most-specific
  first, subject preferred over body) covering multiple carriers and locales.
- **Category** and **tags** come from keyword lists (`categorize.ts`).
- **Tracking numbers** are always extracted deterministically from carrier-specific
  patterns (`carriers.ts`) — the LLM is never allowed to invent a tracking number
  (its prompt says so explicitly, and `buildUpdate` derives tracking/carrier/detail
  from the email regardless of the LLM verdict).

The optional LLM fallback (`LLM_FALLBACK` + `ANTHROPIC_API_KEY`; model
`LLM_MODEL`, default `claude-opus-4-8`) fills only two kinds of gap:

1. **Status gap** — the regex couldn't classify the email at all: ask the LLM
   whether it's a shipment and, if so, which status (plus category/tags).
2. **Classification gap** — a status was found but the item couldn't be
   categorized: ask the LLM for a category + tags only.

The LLM returns a zod-validated structured verdict using the Anthropic
structured-outputs API (`output_config.format` with a hand-written JSON Schema,
because the zod v4 SDK helper doesn't fit this zod-v3 project). Every call is
bounded:

- Skipped entirely in `DRY_RUN`.
- Counted against `MAX_LLM_CALLS_PER_TICK`, a hard cap summed across **all**
  accounts (a one-shot warning + Telegram ping fires when the cap is hit). The
  attempt is counted before the call, so an error still consumes budget.
- The watermark has already advanced, so a skipped-or-capped message is never
  retried.

A second LLM entry point, `categorizeGeneral`, does the same gap-only categorization
for the general-purchases pass, drawing on the same per-tick budget.

## Row resolution: tracking- and order-number linkage + fuzzy matching

For the shipping job, `resolveRow` maps a parsed update to a curated Notion row in
priority order:

1. **Fuzzy match on item name** (`notion/matcher.ts`). Two passes, most-precise
   first: (a) *containment* — a curated shorthand row name appearing verbatim as a
   contiguous token run inside a longer email title (normalized: lowercased,
   diacritics stripped, `&`→`and`, plus a small abbreviation expansion like
   BotW → "breath of the wild"); the longest such match wins, ties defer to Fuse;
   (b) *Fuse.js* fuzzy match (bounded by `MATCH_THRESHOLD`, default 0.4) on both the
   full name and its pre-colon prefix, to absorb typos and word-order differences.
   On a successful match, the update's tracking numbers **and** order number are
   recorded in `state.links` / `state.orderLinks` for later title-less mail.
2. **Tracking-number link** — a prior email already tied one of this email's
   tracking numbers to a row.
3. **Order-number link** — last resort for a title-less update (e.g. an
   "Delivered … Order # …" mail) via the order-number link a titled email
   established.

The general-purchases and eBay passes key rows on the **order number** directly
(Amazon `NNN-NNNNNNN-NNNNNNN`, eBay `NN-NNNNN-NNNNN`), so a confirmation and its
later shipment/delivery/refund mail collapse onto one row. Shopify storefront
confirmations (a fourth general pass, `runShopify`) are captured the same way but
keyed by a **store-namespaced** order number (`<store> #<n>`) — Shopify numbers
are only unique per store — and are confirmation-only (seeded "from now", no
backfill). Games are keyed on
`platform + title`; forwarder packages on ForwardMe's opaque package code.

## Status transitions

The tracker reasons in a shipment-oriented vocabulary (`types.ts`): a monotonic
progress ladder `Ordered < In Transit < Arriving Soon < Delivered`, plus a
transient `Delayed` and terminal `Cancelled`/`Returned`. `planUpdate` decides
`noop` / `regress` / `apply`:

- Terminal states can't be superseded, but can be set from any live state
  (including `Delivered → Returned`).
- `Delayed` can be set from any active state but not after `Delivered`; any
  progress supersedes a `Delayed`.
- User-managed statuses (`To Reorder`, `To Sell`) are protected — a shipment email
  never overwrites them.

This keeps a late, out-of-order email from un-delivering a package. The general
DB uses a parallel, simpler ladder (`Ordered → Shipped → Delivered`, terminal
`Cancelled`/`Returned`) in `general/lifecycle.ts`.

## The Notion write path

Every DB is **opt-in** via its own env var; if the var is unset, that feature is
off, and if the DB access check fails at startup the feature is disabled with a
logged warning rather than crashing the process (only the primary book DB is
required). There are six write targets, each with its own client and schema:

- **Curated book DB** (`notion/client.ts`, `NOTION_DATABASE_ID`, required) —
  update-only (never creates rows). Sets `Status`, backfills `Category` only when
  blank (never overwrites a manual value), merges `Tags`, writes a parsed
  delivery `ETA` (only when the row has none, so a manual ETA is authoritative),
  and stamps `Delivered on` when an order arrives. Statuses are
  translated at the boundary by `status-map.ts`: a `READ_MAP` normalizes on read
  (e.g. `Preorder → Ordered`) and a `WRITE_MAP` translates on write, where `null`
  means "this DB has no equivalent — leave Status untouched" so a shipment-only
  status can't create a junk option on a curated DB. Rows are reflected in memory
  after a write so later messages in the same tick see the new status.
- **Forwarder packages DB** (`FORWARDER_DATABASE_ID`) — upsert by package code;
  `Shipped`/`Received` are terminal and never reverted.
- **Digital games DB** (`GAMES_DATABASE_ID`) — upsert by platform+title;
  `Purchased` never reverts to `Preordered`; stores a USD spend column.
- **General purchases DB** (`GENERAL_DATABASE_ID`) — four independent passes over
  one shared order map loaded once per tick (in `runTick`): Amazon order
  confirmations (create `Ordered` rows; skip book/game orders, which the domain
  DBs own), Amazon post-order lifecycle (advance status by order number), eBay
  confirmations + lifecycle (create `Collectibles` rows; refund → `Returned`), and
  Shopify storefront confirmations (create `Ordered` rows keyed by a store-
  namespaced order number; confirmation-only, seeded from now).
  The **shipping** job also routes an unmatched non-book item into this DB (keyed
  by order #, category from the classifier, spend left blank until a confirmation
  supplies it) rather than dropping it — deduping against the same shared map, so
  the confirmation and lifecycle passes collapse onto that row. Book/game and
  fuzzy-matched-to-the-book-DB orders are excluded.
- **Tech Accessories DB** (`TECH_ACCESSORIES_DATABASE_ID`) — when set, a purchase
  that classifies as a *tech accessory* (charger/cable/hub/case/audio/storage/
  input… — but not a whole device) is auto-added here instead of the general DB:
  keyed by order # (a hidden column), self-categorized into the inventory's
  buckets, and advanced along a delivery ladder (`Ordered → Shipped → Arriving →
  Owned`, plus `Cancelled`) by the confirmation / shipping / lifecycle passes.
  Manual rows (no order #) and a manual `Wishlist` are never touched; spend is
  left blank until a confirmation supplies it (spend-only). "From now" is
  inherent — the passes only see mail past their watermarks.
- **Spend summary DB** (`SPEND_SUMMARY_DATABASE_ID`) — see below.

All Notion reads/writes go through `withRetry` (see below). Notion responses are
zod-validated for the fields the code reads, and non-page/invalid results are
skipped defensively rather than throwing.

## FX conversion

`money/fx.ts` converts localized amounts to USD for the spend columns and the
summary. `parseAmount` handles both `1,234.56` and `1.234,56` conventions.
`toUSD` resolves a per-currency, per-date rate **cache-first** (`fx-cache.json`,
written atomically), then a daily rate from the Frankfurter/ECB API (5s timeout,
failures swallowed to null), then a hand-maintained monthly fallback table
(nearest-earlier month) for currencies the API doesn't cover (e.g. ARS). Every
resolved rate — including fallbacks — is cached so a given currency+date is
resolved at most once. USD passes through untouched.

## Cross-DB spend summary

Notion can't sum across separate databases, so `summary/notion.ts` recomputes a
`Source × Month` USD rollup each tick: it reads the spend-bearing DBs (books from
their free-text Price, games and general from their `Spend (USD)` columns),
converts to USD, and upserts one summary row per source+month. Book rows'
per-row `Spend (USD)` is also refreshed so a manual Price edit is reflected.
Amazon regions collapse into one "Amazon" bucket; eBay is its own bucket.
Terminal (Cancelled/Returned) general orders are excluded so a refund net-zeros,
and buckets that lose all qualifying spend are archived (the summary is fully
derived each run). The forwarder DB is excluded (logistics, no price).

## Telegram notifications and daily digest

`telegram/client.ts` provides a `Notifier` abstraction with three
implementations, chosen so callers never branch on it: a no-op notifier when
Telegram is unconfigured, a `DryRunNotifier` that logs instead of sending when
`DRY_RUN` is set, and the live `TelegramNotifier` otherwise. Notifications are
best-effort — a Telegram failure is logged and swallowed, never breaking the
poll. Every message is HTML-escaped and run through the redactor before sending,
and requests carry a timeout.

Events fire on each applied status change, on startup / poll failure / cap
alerts, and once per account when a Gmail token fails auth (deduped, cleared on
the next successful poll). The optional daily digest (`digest.ts`) lists orders
still on the way, **soonest ETA first**, with an "arriving soon" (next 3 days)
section, and sends an "all quiet" note when nothing is active so you know the
job ran. Subscription detection
(`subscriptions/`) scans receipt mail for a merchant + amount, and alerts on a
recurring charge (merchant seen before) or an explicit new-subscription phrasing;
first-time one-off purchases are recorded silently.

## Redaction and privacy posture

- **Least privilege at the source**: Gmail OAuth uses `gmail.readonly` only; a
  send/modify scope is never requested. The Notion integration needs only Read +
  Update (+ Insert for the DBs that create rows).
- **Secret redaction**: a `Redactor` built from every known secret (client
  secret, all refresh tokens, Notion key, Telegram token, Anthropic key) masks
  those values in every log line and every Telegram message, so a stack trace or
  upstream API error can't leak a live credential. Matching is literal
  (split/join, not regex) to avoid ReDoS on attacker-influenced content, and
  secrets are masked longest-first. Secrets shorter than 8 chars are ignored as
  too generic to mask safely.
- **File hardening**: `.env`, `accounts.json`, and `state.json` are chmod-ed to
  owner-only at startup and written atomically at `0600`. `.gitignore` excludes
  all of these plus `fx-cache.json` and the logs.
- **LLM data minimization**: only the subject, sender, and a truncated body
  (`MAX_BODY_CHARS`) are sent to the model, with a small `max_tokens` cap; the
  model is instructed never to output tracking numbers.
- **No personal data in the repo** — everything identifying lives in
  gitignored config, state, and log files.

## Reliability guardrails

- `withRetry` (`retry.ts`) wraps Notion (and other) calls with exponential
  backoff, honoring a server `Retry-After` header and retrying 429 / 5xx **plus
  transient network/timeout errors** (DNS `ENOTFOUND`, socket resets, connect
  timeouts, the Notion SDK request-timeout) — so a rate-limit burst or an
  intermittent network blip is ridden out rather than dropping a status write.
- `MAX_UPDATES_PER_TICK` is a **soft** alarm (warn + ping, not a hard stop): an
  unusually large tick likely signals a misconfigured query, but a legitimate
  first-run backlog still completes.
- `DRY_RUN` parses, matches, and logs but performs no Notion writes, Telegram
  sends, or LLM calls, and does not persist watermarks — so queries can be tuned
  across many inboxes safely before going live.
