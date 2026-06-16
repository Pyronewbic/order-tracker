import cron from "node-cron";
import { loadRuntimeConfig } from "./config.js";
import { Logger } from "./logger.js";
import { makeRedactor } from "./redact.js";
import { hardenFile } from "./fsutil.js";
import { loadState, saveState } from "./state.js";
import { GmailClient, makeOAuthClient } from "./gmail/client.js";
import { LlmParser } from "./gmail/llm-parser.js";
import { NotionClient } from "./notion/client.js";
import { ForwarderNotionClient } from "./forwarder/notion.js";
import { sendDigest } from "./digest.js";
import { createNotifier } from "./telegram/client.js";
import { runTick, type Deps } from "./pipeline.js";

async function main(): Promise<void> {
  const cfg = await loadRuntimeConfig();

  // Mask every known secret in all log + Telegram output, so a stack trace or
  // upstream API error can't leak a token to tracker.log or a notification.
  const redact = makeRedactor([
    cfg.GMAIL_CLIENT_SECRET,
    cfg.GMAIL_REFRESH_TOKEN,
    cfg.NOTION_API_KEY,
    cfg.TELEGRAM_BOT_TOKEN,
    cfg.ANTHROPIC_API_KEY,
    ...cfg.accounts.map((a) => a.refreshToken),
  ]);
  const log = new Logger(cfg.LOG_FILE, redact);

  // Tighten permissions on the files that hold secrets/tokens (best-effort).
  await Promise.all([
    hardenFile(".env"),
    hardenFile(cfg.ACCOUNTS_FILE),
    hardenFile(cfg.STATE_FILE),
  ]);

  // One GmailClient per account, built once and reused every tick.
  const gmailByLabel = new Map<string, GmailClient>(
    cfg.accounts.map((acct) => [
      acct.label,
      new GmailClient(
        makeOAuthClient({
          clientId: cfg.GMAIL_CLIENT_ID,
          clientSecret: cfg.GMAIL_CLIENT_SECRET,
          refreshToken: acct.refreshToken,
        }),
      ),
    ]),
  );

  const notion = new NotionClient(cfg.NOTION_API_KEY, cfg.NOTION_DATABASE_ID);
  try {
    await notion.verifyAccess();
  } catch (err) {
    await log.error(`Notion access check failed: ${String(err)}`);
    process.exit(1);
  }

  // Optional forwarder (ForwardMe) tracking → standalone Notion DB. A misconfig
  // here disables just this feature rather than taking down the book tracker.
  let forwarder: ForwarderNotionClient | null = null;
  if (cfg.FORWARDER_DATABASE_ID) {
    const client = new ForwarderNotionClient(cfg.NOTION_API_KEY, cfg.FORWARDER_DATABASE_ID);
    try {
      await client.verifyAccess();
      forwarder = client;
    } catch (err) {
      await log.error(`Forwarder DB access check failed; forwarder tracking disabled: ${String(err)}`);
    }
  }

  const notifier = createNotifier(cfg, log, redact);

  // Optional LLM fallback: opt-in (LLM_FALLBACK) AND requires an API key.
  let llm: LlmParser | null = null;
  if (cfg.LLM_FALLBACK) {
    if (cfg.ANTHROPIC_API_KEY) {
      llm = new LlmParser(cfg.ANTHROPIC_API_KEY, cfg.LLM_MODEL);
    } else {
      await log.warn("LLM_FALLBACK is set but ANTHROPIC_API_KEY is missing; fallback disabled.");
    }
  }

  const deps: Deps = { cfg, notion, notifier, log, llm, forwarder };

  // Guard against overlapping runs if a poll outlives its interval.
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) {
      await log.warn("Previous poll still running; skipping this tick.");
      return;
    }
    running = true;
    try {
      const state = await loadState(cfg.STATE_FILE);
      await runTick(deps, gmailByLabel, state);
      // Dry-run is a non-destructive preview: never persist advanced watermarks,
      // so a later live run still processes the same mail.
      if (cfg.DRY_RUN) {
        await log.info("[dry-run] state not persisted.");
      } else {
        await saveState(cfg.STATE_FILE, state);
      }
    } catch (err) {
      await log.error(`Poll failed: ${String(err)}`);
      await notifier.notify(`⚠️ Order tracker poll failed: ${String(err)}`);
    } finally {
      running = false;
    }
  };

  // Validate all cron expressions up front, before the first tick or any
  // scheduling, so a typo fails fast instead of after a live poll.
  if (!cron.validate(cfg.POLL_CRON)) {
    throw new Error(`Invalid POLL_CRON expression: "${cfg.POLL_CRON}"`);
  }
  if (cfg.DIGEST_CRON && !cron.validate(cfg.DIGEST_CRON)) {
    throw new Error(`Invalid DIGEST_CRON expression: "${cfg.DIGEST_CRON}"`);
  }

  const tasks: { stop: () => void }[] = [];

  await log.info(
    `Order tracker started. Accounts: ${cfg.accounts.length} ` +
      `(${cfg.accounts.map((a) => a.label).join(", ")}). Poll: "${cfg.POLL_CRON}"` +
      (cfg.SUBSCRIPTION_QUERY ? ", subscriptions: on" : "") +
      (cfg.DIGEST_CRON ? `, digest: "${cfg.DIGEST_CRON}"` : "") +
      (forwarder ? ", forwarder: on" : "") +
      (llm ? ", LLM fallback: on" : "") +
      (cfg.DRY_RUN ? ", DRY-RUN" : "") +
      ".",
  );
  await notifier.notify(
    `🟢 Order tracker started (${cfg.accounts.length} account(s)).` +
      (cfg.DRY_RUN ? " [dry-run]" : ""),
  );

  await tick(); // run immediately on boot, then on schedule
  tasks.push(cron.schedule(cfg.POLL_CRON, tick));

  // Optional daily digest on its own schedule (validated above).
  if (cfg.DIGEST_CRON) {
    tasks.push(
      cron.schedule(cfg.DIGEST_CRON, () => {
        void sendDigest(notion, notifier, log).catch((err) =>
          log.error(`Digest failed: ${String(err)}`),
        );
      }),
    );
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void log.info(`Received ${signal}; shutting down.`).then(() => {
      for (const t of tasks) t.stop();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(`[fatal] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
