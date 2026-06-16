import type { Logger } from "./logger.js";
import type { NotionClient } from "./notion/client.js";
import type { Notifier } from "./telegram/client.js";
import { STATUS_EMOJI, escapeHtml } from "./telegram/client.js";
import { ORDER_STATUSES, type OrderStatus } from "./types.js";

// Statuses worth a daily heads-up (delivered items are done, so omit them).
const ACTIVE: OrderStatus[] = ["Arriving Soon", "In Transit"];

const isOrderStatus = (s: string): s is OrderStatus =>
  (ORDER_STATUSES as readonly string[]).includes(s);

/**
 * Build and send the daily digest: one Telegram message listing every row
 * currently Arriving Soon or In Transit. Sends a short "all quiet" note when
 * nothing is active so you know the job ran.
 */
export async function sendDigest(
  notion: NotionClient,
  notifier: Notifier,
  log: Logger,
): Promise<void> {
  const rows = await notion.listRows();
  const active = rows
    .filter((r) => isOrderStatus(r.status) && ACTIVE.includes(r.status))
    // Arriving Soon first, then In Transit.
    .sort((a, b) => ACTIVE.indexOf(a.status as OrderStatus) - ACTIVE.indexOf(b.status as OrderStatus));

  if (active.length === 0) {
    await log.info("Daily digest: nothing in transit.");
    await notifier.notify("📭 <b>Daily digest</b>\nNothing in transit right now.");
    return;
  }

  const lines = active.map((r) => {
    const status = r.status as OrderStatus;
    return `${STATUS_EMOJI[status]} <b>${escapeHtml(r.book)}</b> — ${status}`;
  });

  await log.info(`Daily digest: ${active.length} active order(s).`);
  await notifier.notify(
    `📬 <b>Daily digest</b> — ${active.length} on the way\n${lines.join("\n")}`,
  );
}
