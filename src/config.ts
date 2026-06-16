import "dotenv/config";
import { z } from "zod";

/**
 * Environment schema. `GMAIL_REFRESH_TOKEN` is optional here because it does
 * not exist until the one-time `npm run auth` flow has been run; the main
 * process asserts its presence separately (see {@link loadRuntimeConfig}).
 */
const envSchema = z.object({
  GMAIL_CLIENT_ID: z.string().min(1, "GMAIL_CLIENT_ID is required"),
  GMAIL_CLIENT_SECRET: z.string().min(1, "GMAIL_CLIENT_SECRET is required"),
  GMAIL_REFRESH_TOKEN: z.string().min(1).optional(),
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
  OAUTH_REDIRECT_PORT: z.coerce.number().int().positive().default(4567),
  MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.4),
  STATE_FILE: z.string().default("state.json"),
  LOG_FILE: z.string().default("tracker.log"),
}).refine(
  (env) => Boolean(env.TELEGRAM_BOT_TOKEN) === Boolean(env.TELEGRAM_CHAT_ID),
  {
    message:
      "Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable Telegram, or neither to disable it.",
    path: ["TELEGRAM_CHAT_ID"],
  },
);

export type Config = z.infer<typeof envSchema>;

/** Parse and validate the environment. Throws a readable error on failure. */
export function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export type RuntimeConfig = Config & { GMAIL_REFRESH_TOKEN: string };

/** Like {@link loadConfig} but guarantees a refresh token is present. */
export function loadRuntimeConfig(): RuntimeConfig {
  const cfg = loadConfig();
  if (!cfg.GMAIL_REFRESH_TOKEN) {
    throw new Error(
      "GMAIL_REFRESH_TOKEN is not set. Run `npm run auth` once to generate it.",
    );
  }
  return cfg as RuntimeConfig;
}
