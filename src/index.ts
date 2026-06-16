import cron from "node-cron";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import { Logger } from "./logger.js";
import { loadState, saveState, type State } from "./state.js";
import { GmailClient, makeOAuthClient, type ParsedMessage } from "./gmail/client.js";
import { parseMessage } from "./gmail/parser.js";
import { NotionClient, type OrderRow } from "./notion/client.js";
import { matchRow } from "./notion/matcher.js";
import { parseCharge } from "./subscriptions/parser.js";
import { classifyCharge } from "./subscriptions/tracker.js";
import { sendDigest } from "./digest.js";
import { createNotifier, type Notifier } from "./telegram/client.js";

/** Fetch messages newer than `sinceMs`, oldest first, for a given query. */
async function fetchNewMessages(
  gmail: GmailClient,
  query: string,
  sinceMs: number,
): Promise<ParsedMessage[]> {
  // Gmail's `after:` is second-resolution; subtract 1s to avoid an off-by-one
  // miss, then de-dup precisely against the stored millisecond timestamp.
  const afterSec = sinceMs > 0 ? Math.floor(sinceMs / 1000) - 1 : undefined;
  const ids = await gmail.listMessageIds(query, afterSec);
  if (ids.length === 0) return [];

  return (await Promise.all(ids.map((id) => gmail.getMessage(id))))
    .filter((m) => m.internalDateMs > sinceMs)
    .sort((a, b) => a.internalDateMs - b.internalDateMs);
}

/** Shipping job: match emails to Notion rows and push status updates. */
async function runShipping(
  cfg: RuntimeConfig,
  gmail: GmailClient,
  notion: NotionClient,
  notifier: Notifier,
  log: Logger,
  state: State,
): Promise<void> {
  const messages = await fetchNewMessages(gmail, cfg.GMAIL_QUERY, state.lastProcessedMs);
  if (messages.length === 0) {
    await log.info("No new shipping messages.");
    return;
  }

  await log.info(`Processing ${messages.length} shipping message(s).`);
  const rows = await notion.listRows();
  const rowsById = new Map(rows.map((r) => [r.pageId, r]));

  for (const msg of messages) {
    state.lastProcessedMs = Math.max(state.lastProcessedMs, msg.internalDateMs);

    const update = parseMessage(msg);
    if (!update) {
      await log.warn(`Skipped (no status): "${msg.subject}"`);
      continue;
    }

    // Primary: match by item name. On success, record this carrier's tracking
    // numbers so later carrier-only emails resolve to the same row.
    let row: OrderRow | undefined;
    if (update.itemName) {
      const match = matchRow(update.itemName, rows, cfg.MATCH_THRESHOLD);
      if (match) {
        row = match.row;
        for (const tn of update.trackingNumbers) {
          state.links[tn] = { pageId: row.pageId, book: row.book };
        }
      }
    }

    // Fallback: resolve a carrier update via a previously-recorded tracking link.
    if (!row) {
      for (const tn of update.trackingNumbers) {
        const link = state.links[tn];
        if (link) {
          row = rowsById.get(link.pageId);
          if (row) break;
        }
      }
    }

    if (!row) {
      const ident =
        update.itemName ||
        `${update.carrier} ${update.trackingNumbers.join(", ") || "(no tracking #)"}`;
      await log.warn(`No Notion match for ${ident} (subject: "${msg.subject}")`);
      continue;
    }

    try {
      await notion.applyUpdate(
        row,
        update.status,
        update.detail,
        new Date(msg.internalDateMs),
      );
      await log.change(row.book, update.status, update.detail);
      await notifier.notifyStatusChange(row.book, update.status, update.detail);
    } catch (err) {
      await log.error(`Failed updating "${row.book}": ${String(err)}`);
    }
  }
}

/** Subscription job: scan receipt mail and alert on recurring/new charges. */
async function runSubscriptions(
  cfg: RuntimeConfig,
  gmail: GmailClient,
  notifier: Notifier,
  log: Logger,
  state: State,
): Promise<void> {
  if (!cfg.SUBSCRIPTION_QUERY) return;

  const messages = await fetchNewMessages(
    gmail,
    cfg.SUBSCRIPTION_QUERY,
    state.subscriptionLastMs,
  );
  if (messages.length === 0) {
    await log.info("No new receipt messages.");
    return;
  }

  await log.info(`Scanning ${messages.length} receipt message(s).`);
  for (const msg of messages) {
    state.subscriptionLastMs = Math.max(state.subscriptionLastMs, msg.internalDateMs);

    const charge = parseCharge(msg);
    if (!charge) continue;

    const verdict = classifyCharge(
      charge,
      state.subscriptions[charge.merchant.toLowerCase()],
      msg.internalDateMs,
    );
    state.subscriptions[verdict.key] = verdict.record;

    if (verdict.alert) {
      await log.info(`Charge alert: ${charge.merchant} ${charge.amount}`);
      await notifier.notify(verdict.alert);
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadRuntimeConfig();
  const log = new Logger(cfg.LOG_FILE);

  const gmail = new GmailClient(
    makeOAuthClient({
      clientId: cfg.GMAIL_CLIENT_ID,
      clientSecret: cfg.GMAIL_CLIENT_SECRET,
      refreshToken: cfg.GMAIL_REFRESH_TOKEN,
    }),
  );
  const notion = new NotionClient(cfg.NOTION_API_KEY, cfg.NOTION_DATABASE_ID);
  const notifier = createNotifier(cfg, log);

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
      await runShipping(cfg, gmail, notion, notifier, log, state);
      await runSubscriptions(cfg, gmail, notifier, log, state);
      await saveState(cfg.STATE_FILE, state);
    } catch (err) {
      await log.error(`Poll failed: ${String(err)}`);
      await notifier.notify(`⚠️ Order tracker poll failed: ${String(err)}`);
    } finally {
      running = false;
    }
  };

  if (!cron.validate(cfg.POLL_CRON)) {
    throw new Error(`Invalid POLL_CRON expression: "${cfg.POLL_CRON}"`);
  }

  const tasks: { stop: () => void }[] = [];

  await log.info(
    `Order tracker started. Poll: "${cfg.POLL_CRON}"` +
      (cfg.SUBSCRIPTION_QUERY ? ", subscriptions: on" : "") +
      (cfg.DIGEST_CRON ? `, digest: "${cfg.DIGEST_CRON}"` : "") +
      ".",
  );
  await notifier.notify("🟢 Order tracker started.");

  await tick(); // run immediately on boot, then on schedule
  tasks.push(cron.schedule(cfg.POLL_CRON, tick));

  // Optional daily digest on its own schedule.
  if (cfg.DIGEST_CRON) {
    if (!cron.validate(cfg.DIGEST_CRON)) {
      throw new Error(`Invalid DIGEST_CRON expression: "${cfg.DIGEST_CRON}"`);
    }
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
