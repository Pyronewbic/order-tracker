# Order Tracker

A personal Gmail → Notion order and spend tracker. It polls one or more Gmail
inboxes on a schedule, parses shipping, order, and receipt mail, and writes the
results to Notion — keeping shipment statuses current and rolling every purchase
into a single unified-currency spend total.

```
Gmail (shipping)  ──parse──▶ status + item + tracking#  ──match──▶  Notion row (Status / Category / Tags)
Gmail (orders)    ──parse──▶ merchant + amount + order#  ──────────▶  Notion (Purchases / Games / Forwarder)
Gmail (receipts)  ──parse──▶ merchant + amount  ──history──▶ recurring?  ──▶  Telegram alert
                                                                              │
                                                       Telegram  ◀── per-event + daily digest
```

## What it is

A single always-on Node process that turns your order and receipt email into a
structured Notion workspace: shipment tracking, categorized purchases, digital
game receipts, packages held at a forwarder, and a cross-database spend summary
in one currency. Parsing is deterministic first (regex + keyword rules) with an
optional, opt-in LLM fallback that only fills the gaps the rules can't. Every
Notion database beyond the core one is opt-in via an environment variable —
unset means that feature is off.

It is **spend-only by design.** Portfolio and value tracking are intentionally
out of scope (a separate app, Collectr, owns that).

## Features

- **Multi-carrier shipment tracking** — Amazon and UPS/FedEx/USPS/India Post
  emails resolve to a Notion row and advance its **Status**, filling
  **Category** + **Tags** by keyword.
- **Notion sync** — statuses only ever advance (a late email can't un-deliver a
  package); manual edits are never clobbered.
- **Telegram notifications** — a push on each status change, plus a scheduled
  **daily digest** of everything still in motion (Ordered, In Transit, Arriving
  Soon, and Delayed). Optional.
- **Subscription detection** — flags recurring/renewal charges parsed from
  receipt mail. Optional.
- **Forwarder tracking** — logs packages held at a forwarding service (arrival,
  contents, storage countdown) into a standalone Notion DB. Optional.
- **Digital game tracking** — logs eShop and Amazon JP digital purchases,
  region-aware, into a standalone DB. Optional.
- **General purchases** — parses Amazon (and eBay) order confirmations into a
  general Purchases DB for everything that isn't a tracked book/game. Optional.
- **Spend summary** — rolls per-month USD spend across every DB into one
  cross-source total (multi-currency, converted via daily FX). Optional.
- **Multiple inboxes** — polls any number of Gmail accounts into the one Notion
  workspace, each with its own watermark so a busy inbox can't starve a quiet one.

## How it works

A cron-scheduled poll loop reads each Gmail account since its last watermark,
parses every message deterministically (subject/body → status, item, tracking
number, merchant, amount), and routes it to the right Notion writer. Shipping
mail fuzzy-matches an existing row and updates it; order/receipt mail upserts
into the opt-in feature databases. Anything the deterministic parser can't
place is optionally handed to a bounded LLM fallback that fills only the gaps.
A separate pass converts every purchase to USD and recomputes the cross-DB
spend summary. State (per-account watermarks, tracking-number links, merchant
history) lives in a local `state.json`.

For the full pipeline, module layout, and the Notion status-mapping layer, see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quickstart

```bash
git clone https://github.com/Pyronewbic/order-tracker.git
cd order-tracker
npm install
cp .env.example .env         # fill in the required keys

npm run auth -- personal     # authorize a Gmail inbox (repeat per inbox)
npm run build                # compile TypeScript → dist/  (required before start)
npm start                    # run the compiled build
```

Requirements: **Node.js ≥ 20**, a Google Cloud OAuth client, and a Notion
integration + database. There is no automated test suite; `npm run typecheck`
runs the compiler in check mode.

The Quickstart above is deliberately terse — the OAuth consent-screen steps
(publish to **Production** so refresh tokens don't expire), the exact Notion
database schemas for each feature, the Telegram bot setup, and the PM2 deploy
are all detailed, in order, in **[docs/SETUP.md](docs/SETUP.md)**.

## Configuration

All config is via `.env`, validated with [zod](https://zod.dev/) at startup.
The minimum to boot is `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
`NOTION_API_KEY`, `NOTION_DATABASE_ID`, plus at least one authorized inbox.
Every optional feature is switched on by setting its `*_DATABASE_ID` (or query)
variable; leaving it unset keeps the feature off.

- **[.env.example](.env.example)** is the single source of truth for every
  variable, with defaults and inline notes.
- **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)** explains which variables
  are required, which are conditionally required (e.g. Telegram needs both the
  bot token and chat id; the LLM fallback needs an Anthropic key; the digest
  needs Telegram), and what each feature toggle does.

## Status / disclaimer

This is a **personal, best-effort project**, published as-is with no warranty.
A few things to know before you rely on it:

- **Spend-only by design.** It tracks what you spent, not what things are worth
  — portfolio/value tracking is intentionally out of scope.
- **Parsing is heuristic and inbox-specific.** The default Gmail queries and
  keyword rules are tuned to the author's mail; you will need to tune the
  `*_QUERY` variables and matching thresholds to your own inbox.
- **Enabling the LLM fallback sends email content off-host.** When on, the
  subject and truncated body of mail the rules can't classify are sent to
  Anthropic's API. It's opt-in and off by default.

## License

MIT — see [LICENSE](LICENSE).
