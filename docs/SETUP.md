# Setup

A complete, ordered setup guide for running the tracker from scratch. It polls one
or more Gmail inboxes, parses order/shipping/receipt mail, and writes to Notion
databases. Every Notion feature beyond the main tracked database is opt-in via an
env var; unset means that feature is off.

This is a personal, best-effort project. Parsing is heuristic and inbox-specific,
so the Gmail queries usually need tuning for your mail. It is spend-only by design.

For the full env-var reference, see [`.env.example`](../.env.example) — it is the
single source of truth for every variable, its default, and what it does. This
guide covers the ordered setup flow; `.env.example` covers each knob.

## End-to-end order

Follow these phases top to bottom. Build must precede `npm start` and `pm2 start`.

1. Install prerequisites, clone, `npm install`, `cp .env.example .env`.
2. Create a Google Cloud OAuth client and publish the consent screen to production.
3. Put `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` in `.env`.
4. Authorize each inbox: `npm run auth -- <label>` (writes `accounts.json`).
5. Create your Notion database(s), share them with the integration, and set
   `NOTION_API_KEY` / `NOTION_DATABASE_ID` (plus any optional `*_DATABASE_ID`).
6. (Optional) Telegram bot + chat id; (optional) Anthropic API key for the LLM fallback.
7. `npm run build`.
8. `npm start` for a foreground run, or deploy under PM2 for an always-on process.

---

## 1. Prerequisites

- **Node.js >= 20** (the `engines` field requires it).
- **git** — to clone the repo.
- **PM2** (`npm install -g pm2`) — only needed for the always-on deploy in step 8.
- A **Notion** account (for the target database) and, optionally, a **Telegram**
  account and an **Anthropic** API key.

This is a TypeScript / ESM project. The run/deploy path is compiled JavaScript
(`npm run build` -> `node dist/index.js`), so a build step is required before
`npm start` or PM2. There is a `npm run typecheck` script; there is **no**
automated test suite, so do not look for `npm test`.

At runtime the app writes `accounts.json`, `state.json`, `tracker.log`, and
`fx-cache.json` into its working directory (all gitignored; the secret-bearing
ones are written at mode 0600). This is why the PM2 working directory matters and
what to back up.

### Clone and install

```sh
git clone https://github.com/Pyronewbic/order-tracker.git tracker
cd tracker
npm install
cp .env.example .env
```

Keep `.env` open — you will fill it in as you go.

---

## 2. Google Cloud: OAuth client + consent screen

The tracker reads Gmail via an OAuth2 client whose refresh tokens it stores per
account. One shared OAuth app authorizes every inbox.

### 2a. Create the OAuth client

1. Go to <https://console.cloud.google.com/> and create (or select) a project.
2. Enable the **Gmail API** (APIs & Services -> Library -> Gmail API -> Enable).
3. APIs & Services -> **Credentials** -> Create credentials -> **OAuth client ID**.
4. Application type: **Desktop app**. Name it anything.
5. Copy the **Client ID** and **Client secret**.

A Desktop-app client uses a loopback redirect (`http://localhost:PORT`), which
needs no redirect-URI pre-registration — the `npm run auth` flow spins up a local
server to catch the redirect.

### 2b. Configure the consent screen — publish to production

APIs & Services -> **OAuth consent screen**.

**Set the Publishing status to "In production" (Publishing status -> Publish app).**
This is required for an always-on tracker. In **Testing** mode Google expires
refresh tokens after roughly **7 days**, which silently breaks polling until you
re-authorize every inbox. No Google verification is needed for a personal app that
requests only the read-only Gmail scope, so publishing to production has no downside
here.

(Test-users mode is only viable for a quick throwaway/dev run you don't mind
re-authorizing every week.)

### 2c. The scope you are granting

The only scope requested is:

```
https://www.googleapis.com/auth/gmail.readonly
```

It is **read-only** — the app never requests send or modify access. Gmail has **no
per-label scope**, so this grant covers your whole mailbox (the tracker itself only
searches with the configured Gmail queries). If the consent screen shows an "app
isn't verified" warning for your personal app, click through it (Advanced -> Go to
`<your app>`).

### 2d. Put the credentials in `.env`

```
GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your-client-secret
```

---

## 3. Authorize each inbox

For each Gmail account you want to poll, pick a short label (letters, digits,
`_`, `-`, `.`) and run:

```sh
npm run auth -- personal
```

This opens Google's consent screen (pick the intended account in the chooser),
captures the redirect on `http://localhost:4567` (change with `OAUTH_REDIRECT_PORT`),
exchanges the code for a refresh token, and stores it under that label in
`accounts.json`. Repeat per inbox:

```sh
npm run auth -- work
npm run auth -- india
```

List configured labels at any time:

```sh
npm run accounts
```

`accounts.json` is a gitignored `{ "<label>": "<refresh_token>", ... }` file. At
least one authorized account is required — startup throws "No Gmail accounts
configured" if `accounts.json` is empty/absent and no legacy `GMAIL_REFRESH_TOKEN`
is set.

> If Google returns no refresh token on a re-auth, revoke prior access at
> <https://myaccount.google.com/permissions> and run the command again.

---

## 4. Notion: integration + databases

### 4a. Create the integration

1. Go to <https://www.notion.so/my-integrations> -> **New integration**.
2. Copy the **Internal Integration Secret** — this is your `NOTION_API_KEY`.
3. Capabilities:
   - The **main tracked database** needs only **Read content** + **Update content**.
   - If you enable **any** of the forwarder, games, general, or spend-summary
     features, the integration additionally needs **Insert content** (those DBs
     create rows). It is simplest to enable Read + Update + Insert content up front.

### 4b. Create the main tracked database

Create a Notion database and add these properties. Property names are **exact and
case-sensitive**.

| Property | Notion type | Notes |
| --- | --- | --- |
| `Book`   | Title  | The item title. (This is the author's column name; see the status/schema note below.) |
| `Status` | Select | Shipment status. See the status mapping below. |
| `Category` | Select | Item type, e.g. Game / Book / Accessory / Electronics / Digital / Other. |
| `Tags`   | Multi-select | Optional; the tracker merges tags, never clears them. |
| `ETA` | Date | Delivery ETA parsed from shipment mail; drives the Arrivals calendar (and doubles as the FX date for the spend summary). The tracker writes it only when the row has none, so a manual ETA is authoritative. |
| `Delivered on` | Date | Actual delivered-on date, stamped when an order is marked Delivered. |

**How Status is actually written (the mapping layer).** The tracker reasons in a
shipment vocabulary but only writes a subset back to Notion:

- **Written verbatim:** `In Transit`, `Arriving Soon`, `Delivered`.
- **`Delayed` folds into `In Transit`** (no separate Delayed option is written).
- **`Ordered`, `Cancelled`, `Returned` are never written** — the tracker leaves
  Status untouched rather than downgrading or overwriting a curated row.
- **Reading:** an existing `Preorder` option is read as `Ordered` (so a preordered
  item can still advance once it ships).
- **Protected:** `To Reorder` and `To Sell` are user-managed and are **never**
  overwritten by an incoming email.

So the minimum useful Status options are `In Transit`, `Arriving Soon`, and
`Delivered`; add `Preorder`, `To Reorder`, `To Sell` if you use those workflows.
Any status name not in the mapping is written through **verbatim**, so a database
that uses the internal names (`Ordered`, `In Transit`, `Delayed`, `Arriving Soon`,
`Delivered`, `Cancelled`, `Returned`) works as-is.

> The main title property is hardcoded as `Book`. The app is themed around the
> author's book/game collection; if you track other things, either name your title
> column `Book` or rename the concept in code.

### 4c. Books DB extra columns — only if you enable the spend summary

If (and only if) you set `SPEND_SUMMARY_DATABASE_ID` (step 4e), the main "books"
database also needs these columns, which the spend summary reads and writes:

| Property | Notion type | Notes |
| --- | --- | --- |
| `Price` | Text (rich text) | Free-text price like `₹499` / `¥1980` / `$12`. The **currency symbol drives the currency**; with no symbol the row is treated as USD. Rows with no `Price` are skipped. |
| `Source` | Select | `Amazon US` / `Amazon IN` / `Amazon JP` — a currency fallback when `Price` has no symbol. |
| `Spend (USD)` | Number | **Written by the tracker** — the per-row USD amount, refreshed each run. |

(`ETA` is already in the base schema above; the spend summary reuses it as the FX
conversion date, falling back to the row's created time if unset.)

### 4d. Share each database with the integration

For **every** database you use (main + any optional ones), open the database
page -> **•••** -> **Connections** -> add your integration. Sharing the workspace
is not enough; the integration must be connected to each individual database. On
startup the tracker verifies it can read the main DB and exits with a clear error
if it cannot.

Get each database's ID from its URL: the 32-character hex string (with or without
dashes) before the `?v=` query. Put the main one in `.env`:

```
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_DATABASE_ID=your-notion-database-id
```

### 4e. Optional databases and their schemas

Each optional feature is enabled only by setting its `*_DATABASE_ID`. Create the
database, add the properties below (exact, case-sensitive), and connect the
integration (needs **Insert content** for all four of these). All select options
are auto-created by Notion on first write, so you only need to create the property,
not pre-fill its options.

**General "Purchases" DB** — `GENERAL_DATABASE_ID` (non-book/game Amazon + eBay orders):

| Property | Notion type |
| --- | --- |
| `Item` | Title |
| `Order #` | Text (rich text) |
| `Merchant` | Select |
| `Category` | Select |
| `Amount` | Number |
| `Currency` | Text (rich text) |
| `Spend (USD)` | Number |
| `Items` | Number |
| `Date` | Date |
| `Status` | Select |
| `ETA` | Date (delivery ETA for routed shipment items; drives the Arrivals calendar) |
| `Delivered on` | Date (actual delivered-on date) |

**Tech Accessories DB** — `TECH_ACCESSORIES_DATABASE_ID` (auto-adds tech-accessory
purchases; whole devices are not routed here). Enable `GENERAL_DATABASE_ID` too so
the order-confirmation pass can supply the price:

| Property | Notion type |
| --- | --- |
| `Name` | Title |
| `Order #` | Text (rich text) — dedup key; manual rows leave it blank and are never touched |
| `Status` | Select — delivery ladder `Ordered` / `Shipped` / `Arriving` / `Owned` (+ your own `Wishlist`, which the tracker never sets) |
| `Amount` | Number |
| `Currency` | Select (e.g. USD / INR) |
| `Category` | Select — accessory buckets (Power / Cable / Connectivity / Storage / Case/Carry / Audio / Input / Capture / Display / Other) |
| `Order link` | URL |
| `Notes` | Text (rich text) |

**Digital Games DB** — `GAMES_DATABASE_ID`:

| Property | Notion type |
| --- | --- |
| `Game` | Title |
| `Platform` | Select |
| `Status` | Select |
| `Date` | Date |
| `Price` | Text (rich text) |
| `Device` | Text (rich text) |
| `Spend (USD)` | Number |

**Forwarder Packages DB** — `FORWARDER_DATABASE_ID`:

| Property | Notion type |
| --- | --- |
| `Package` | Title |
| `Status` | Select |
| `Arrived` | Date |
| `Disposal by` | Date |
| `From` | Text (rich text) |
| `Contents` | Text (rich text) |
| `Declared Value` | Text (rich text) |
| `Weight` | Text (rich text) |
| `Days left` | Number |

**Spend Summary DB** — `SPEND_SUMMARY_DATABASE_ID` (cross-DB USD totals, one row per Source × Month):

| Property | Notion type |
| --- | --- |
| `Bucket` | Title |
| `Source` | Select |
| `Month` | Text (rich text) |
| `Spend (USD)` | Number |
| `Items` | Number |

Set the ones you want in `.env` (leave the rest blank):

```
FORWARDER_DATABASE_ID=
GAMES_DATABASE_ID=
GENERAL_DATABASE_ID=
SPEND_SUMMARY_DATABASE_ID=
```

---

## 5. Telegram (optional)

Telegram powers ad-hoc notifications and the daily digest. Set **both**
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, or **neither** — setting exactly one
fails validation. The daily digest (`DIGEST_CRON`) also requires Telegram.

1. Message **@BotFather** in Telegram, create a bot, copy the token into
   `TELEGRAM_BOT_TOKEN`.
2. **Send your bot a message** (any text) from the chat you want notifications in.
3. Find the chat id — **before starting the tracker**:

   ```sh
   npm run telegram:chat-id
   ```

   Copy the printed id into `TELEGRAM_CHAT_ID`.

Gotchas: the helper uses `getUpdates`, which only returns **recent** updates and
returns nothing if a **running tracker is already polling the bot** (its polling
drains the updates). Message the bot first, and run this before starting the
tracker. Group chat ids are negative.

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DIGEST_CRON=0 8 * * *
```

The daily digest lists everything still in motion — `Ordered`, `In Transit`,
`Arriving Soon`, and `Delayed` (all non-terminal statuses). Leave `DIGEST_CRON`
unset to disable it.

---

## 6. Anthropic LLM fallback (optional)

The tracker parses deterministically first; the LLM only fills gaps the
regex/keyword logic can't (a status it can't read, or category/tags it can't
type). It is **off by default**. To enable it you must set **both**
`LLM_FALLBACK=true` and `ANTHROPIC_API_KEY` — if the key is absent the fallback
silently self-disables.

> Data egress: when enabled, the subject and truncated body of such mail is sent
> to Anthropic's API. Leave it off if you don't want any mail content leaving the
> host.

```
LLM_FALLBACK=false
ANTHROPIC_API_KEY=
LLM_MODEL=
MAX_LLM_CALLS_PER_TICK=10
```

---

## 7. Fill in `.env` and understand required vs optional

See [`.env.example`](../.env.example) for every variable. The essentials:

**Required to boot:**

- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`
- `NOTION_API_KEY`, `NOTION_DATABASE_ID`
- **At least one authorized account** — via `accounts.json` (`npm run auth`) or the
  legacy single-account `GMAIL_REFRESH_TOKEN`.

**Conditionally required (set together or the feature is off/invalid):**

- Telegram: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — both or neither.
- LLM: `LLM_FALLBACK=true` requires `ANTHROPIC_API_KEY`.
- Daily digest: `DIGEST_CRON` requires Telegram.

**Optional (unset = feature off):** every `*_DATABASE_ID` (forwarder, games,
general, spend summary), `SUBSCRIPTION_QUERY`, and the tuning knobs (`GMAIL_QUERY`,
`POLL_CRON`, `MATCH_THRESHOLD`, `DRY_RUN`, `MAX_UPDATES_PER_TICK`, etc.).

**Tip — tune before going live.** Set `DRY_RUN=true` for the first runs: it
parses, matches, and logs but performs no Notion writes, Telegram sends, or LLM
calls, and does not persist state. Use it to tune the Gmail queries against your
inboxes, then set it back to `false`.

---

## 8. Build and run

Build first (required — `npm start` and PM2 run compiled output):

```sh
npm run build
```

Foreground run (Ctrl-C to stop):

```sh
npm start
```

### Deploy under PM2 (always-on)

For an always-on process on any host (home server, VPS, or a spare machine):

1. `npm install -g pm2` (if not already installed).
2. Ensure a `logs/` directory exists in the repo (PM2 writes `logs/pm2-out.log`
   and `logs/pm2-error.log`):

   ```sh
   mkdir -p logs
   ```

3. Build, then start, then persist:

   ```sh
   npm run build
   pm2 start ecosystem.config.cjs
   pm2 save
   pm2 startup   # prints a command to run so PM2 restarts on boot
   ```

`ecosystem.config.cjs` is a `.cjs` file on purpose: this package is ESM, but PM2
loads its ecosystem file via CommonJS `require`.

---

## Troubleshooting

- **"No Gmail accounts configured"** — run `npm run auth -- <label>` (or set the
  legacy `GMAIL_REFRESH_TOKEN`).
- **"Cannot access Notion database ..."** — connect the integration to that
  database (••• -> Connections) and grant it the needed capabilities (Read +
  Update for the main DB; add Insert content for the optional DBs).
- **Polling silently stopped after about a week** — your OAuth consent screen is in
  Testing mode; publish it to production (step 2b) and re-run `npm run auth` per
  inbox.
- **`Cannot find module dist/index.js`** — run `npm run build` before `npm start`
  or `pm2 start`.
- **`npm run telegram:chat-id` prints "No chats found"** — message the bot first,
  and run it while the tracker is **not** polling.
