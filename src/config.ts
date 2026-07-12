import "dotenv/config";
import { readFile } from "node:fs/promises";
import { z } from "zod";

/**
 * Account labels become JSON keys in `accounts.json`, per-account keys in
 * `state.json`, and log prefixes; keep them to a safe character set. Shared with
 * the `npm run auth` CLI so both enforce the same rule.
 */
export const LABEL_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * Parse a boolean-ish env var. Absent → `defaultValue`; otherwise truthy for
 * "1"/"true"/"yes"/"on" (case-insensitive), falsy for anything else.
 */
const boolEnv = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined
        ? defaultValue
        : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase()),
    );

/**
 * Environment schema. `GMAIL_REFRESH_TOKEN` is optional: with multiple
 * accounts the refresh tokens live in `accounts.json` (see {@link loadAccounts})
 * and this var is only a back-compat fallback for a single legacy account.
 */
const envSchema = z
  .object({
    GMAIL_CLIENT_ID: z.string().min(1, "GMAIL_CLIENT_ID is required"),
    GMAIL_CLIENT_SECRET: z.string().min(1, "GMAIL_CLIENT_SECRET is required"),
    // Legacy single-account fallback; prefer `accounts.json` via `npm run auth`.
    GMAIL_REFRESH_TOKEN: z.string().min(1).optional(),
    // File mapping account label → refresh token (written by `npm run auth`).
    ACCOUNTS_FILE: z.string().default("accounts.json"),
    NOTION_API_KEY: z.string().min(1, "NOTION_API_KEY is required"),
    NOTION_DATABASE_ID: z.string().min(1, "NOTION_DATABASE_ID is required"),

    // Telegram notifications are optional; set both keys to enable them.
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    TELEGRAM_CHAT_ID: z.string().min(1).optional(),

    GMAIL_QUERY: z
      .string()
      .default(
        "(from:shipment-tracking@amazon.com OR from:auto-confirm@amazon.in OR from:ups.com OR from:fedex.com OR from:usps.com OR from:indiapost.gov.in) label:inbox",
      ),
    POLL_CRON: z.string().default("*/30 * * * *"),
    // Daily digest cron (e.g. "0 8 * * *"). Unset → digest disabled.
    DIGEST_CRON: z.string().min(1).optional(),
    // Gmail query for receipt/billing mail. Unset → subscription detection off.
    SUBSCRIPTION_QUERY: z.string().min(1).optional(),
    // Standalone "Forwarder Packages" Notion DB. Unset → forwarder tracking off.
    FORWARDER_DATABASE_ID: z.string().min(1).optional(),
    // Gmail query for ForwardMe notifications (same query for every account).
    FORWARDER_QUERY: z.string().default("from:automated@forwardme.com"),
    // Standalone "Digital Games" Notion DB. Unset → digital-game tracking off.
    GAMES_DATABASE_ID: z.string().min(1).optional(),
    // Cross-DB "Spend Summary" Notion DB (Source × Month, USD). Unset → off.
    SPEND_SUMMARY_DATABASE_ID: z.string().min(1).optional(),
    // General "Purchases" Notion DB (non-book/game Amazon orders). Unset → off.
    GENERAL_DATABASE_ID: z.string().min(1).optional(),
    // Gmail query for Amazon order confirmations (same query for every account).
    GENERAL_QUERY: z
      .string()
      .default(
        "(from:auto-confirm@amazon.com OR from:auto-confirm@amazon.in OR from:auto-confirm@amazon.co.jp)",
      ),
    // Gmail query for post-order lifecycle mail (shipment/delivery/cancel/refund)
    // that advances a general order's Status by its order number. Excludes
    // auto-confirm@ (order creation — handled by GENERAL_QUERY). Same query for
    // every account; only used when GENERAL_DATABASE_ID is set.
    GENERAL_LIFECYCLE_QUERY: z
      .string()
      .default(
        "(from:shipment-tracking@amazon.com OR from:order-update@amazon.com OR from:return@amazon.com OR " +
          "from:shipment-tracking@amazon.in OR from:order-update@amazon.in OR from:return@amazon.in OR " +
          "from:shipment-tracking@amazon.co.jp OR from:order-update@amazon.co.jp OR from:return@amazon.co.jp)",
      ),
    // Gmail query for eBay order mail (confirmations + shipment/delivery/refund),
    // feeding the same general DB as Collectibles. Subject-scoped to order events
    // so bids/offers/feedback/marketing are excluded. Only used when
    // GENERAL_DATABASE_ID is set.
    EBAY_QUERY: z
      .string()
      .default(
        "from:ebay.com subject:(confirmed OR carrier OR delivered OR delivery OR refund)",
      ),
    // Gmail query for digital game purchases: Amazon JP digital (order + code
    // delivery) and Nintendo eShop receipts/preorders. The eShop clause is
    // scoped to purchase/preorder subjects so sign-in/verification/NSO-renewal
    // mail from the same sender is excluded.
    GAMES_QUERY: z
      .string()
      .default(
        "(from:digital-no-reply@amazon.co.jp OR from:digitalorder-update@amazon.co.jp OR " +
          "(from:accounts.nintendo.com (subject:ご利用明細 OR subject:予約確認 OR subject:receipt OR subject:purchase)))",
      ),
    OAUTH_REDIRECT_PORT: z.coerce.number().int().positive().default(4567),
    MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),
    STATE_FILE: z.string().default("state.json"),
    LOG_FILE: z.string().default("tracker.log"),

    // ── Runtime guardrails ──
    // Parse + match + log, but perform no Notion writes / Telegram sends / LLM
    // calls. Lets you safely tune queries across many inboxes before going live.
    DRY_RUN: boolEnv(false),
    // Soft alarm: if one tick applies more Notion updates than this, warn + ping.
    MAX_UPDATES_PER_TICK: z.coerce.number().int().positive().default(25),

    // ── Optional LLM fallback (opt-in; classifies mail the regex can't) ──
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    LLM_FALLBACK: boolEnv(false),
    LLM_MODEL: z.string().min(1).default("claude-opus-4-8"),
    // Hard cap on LLM calls per tick, summed across all accounts (cost bound).
    MAX_LLM_CALLS_PER_TICK: z.coerce.number().int().positive().default(10),
  })
  .refine((env) => Boolean(env.TELEGRAM_BOT_TOKEN) === Boolean(env.TELEGRAM_CHAT_ID), {
    message:
      "Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable Telegram, or neither to disable it.",
    path: ["TELEGRAM_CHAT_ID"],
  });

export type Config = z.infer<typeof envSchema>;

/** One Gmail inbox the tracker polls: a human label and its refresh token. */
export interface GmailAccount {
  label: string;
  refreshToken: string;
}

/**
 * Snapshot of process.env with blank/whitespace values dropped. dotenv loads a
 * blank `KEY=` line as "" (not undefined), and zod's `.min(1)` rejects "" even
 * on `.optional()`/`.default()` fields — so without this a freshly-copied
 * .env.example (with blank optional keys) would crash validation. Treating blank
 * as unset lets defaults/optionals apply.
 */
function sanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && value.trim() !== "") env[key] = value;
  }
  return env;
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
}

/** Parse and validate the environment. Throws a readable error on failure. */
export function loadConfig(): Config {
  const parsed = envSchema.safeParse(sanitizedEnv());
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

// Minimal schema for the one-time OAuth CLI (`npm run auth`), which needs only
// the Gmail OAuth client — not Notion/Telegram/runtime config. This lets you
// authorize inboxes before the rest of the setup is in place.
const authEnvSchema = z.object({
  GMAIL_CLIENT_ID: z.string().min(1, "GMAIL_CLIENT_ID is required"),
  GMAIL_CLIENT_SECRET: z.string().min(1, "GMAIL_CLIENT_SECRET is required"),
  ACCOUNTS_FILE: z.string().default("accounts.json"),
  OAUTH_REDIRECT_PORT: z.coerce.number().int().positive().default(4567),
});

export type AuthConfig = z.infer<typeof authEnvSchema>;

/** Validate just the Gmail OAuth fields needed by the auth CLI. */
export function loadAuthConfig(): AuthConfig {
  const parsed = authEnvSchema.safeParse(sanitizedEnv());
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

// `accounts.json` shape: { "<label>": "<refresh_token>", ... }
const accountsSchema = z.record(z.string(), z.string().min(1));

/**
 * Load the account list from `accounts.json`. A missing file yields `[]` (the
 * caller falls back to the legacy single account). Any other read/parse error
 * is surfaced so a corrupt file isn't silently treated as "no accounts".
 */
export async function loadAccounts(file: string): Promise<GmailAccount[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Failed to read accounts file "${file}": ${String(err)}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid accounts file "${file}": not valid JSON.`);
  }

  const parsed = accountsSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `Invalid accounts file "${file}": expected { "<label>": "<refresh_token>" }.`,
    );
  }
  const accounts = Object.entries(parsed.data).map(([label, refreshToken]) => ({
    label,
    refreshToken,
  }));
  // JSON keys are already unique; validate the label format so a stray/whitespace
  // label can't silently become a state key and log prefix.
  for (const { label } of accounts) {
    if (!LABEL_RE.test(label)) {
      throw new Error(
        `Invalid account label "${label}" in "${file}". ` +
          `Use letters, digits, "_", "-", "." only.`,
      );
    }
  }
  return accounts;
}

export type RuntimeConfig = Config & { accounts: GmailAccount[] };

/**
 * Like {@link loadConfig} but resolves the Gmail accounts to poll. Accounts come
 * from `accounts.json`; if that's empty/absent, a legacy `GMAIL_REFRESH_TOKEN`
 * is adopted as the account labelled `"default"`. Throws a clear setup error if
 * neither yields an account.
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const cfg = loadConfig();
  const accounts = await loadAccounts(cfg.ACCOUNTS_FILE);

  if (accounts.length === 0 && cfg.GMAIL_REFRESH_TOKEN) {
    accounts.push({ label: "default", refreshToken: cfg.GMAIL_REFRESH_TOKEN });
  }

  if (accounts.length === 0) {
    throw new Error(
      `No Gmail accounts configured. Run \`npm run auth -- <label>\` to authorize ` +
        `an inbox (writes ${cfg.ACCOUNTS_FILE}), or set GMAIL_REFRESH_TOKEN for a ` +
        `single legacy account.`,
    );
  }

  return { ...cfg, accounts };
}
