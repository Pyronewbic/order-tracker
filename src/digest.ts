import type { Logger } from "./logger.js";
import type { NotionClient, OrderRow } from "./notion/client.js";
import type { Notifier } from "./telegram/client.js";
import { STATUS_EMOJI, escapeHtml } from "./telegram/client.js";
import { ORDER_STATUSES, type OrderStatus } from "./types.js";

// Statuses worth a daily heads-up — still in motion. Delivered/Cancelled/
// Returned are done, so they're omitted. `Delayed` is excluded too: the
// Collection DB folds it into In Transit on write (status-map), so a book row
// never actually carries it. Order here is the fallback display order for rows
// without an ETA.
const ACTIVE: OrderStatus[] = ["Arriving Soon", "In Transit", "Ordered"];

const DAY_MS = 86_400_000;
const MON = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const isOrderStatus = (s: string): s is OrderStatus =>
  (ORDER_STATUSES as readonly string[]).includes(s);

/** Epoch ms (UTC midnight) of a row's ETA date, or undefined if unset. */
function etaMs(row: OrderRow): number | undefined {
  if (!row.eta) return undefined;
  const ms = Date.parse(`${row.eta.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

/** "2026-07-17" → "Jul 17". */
function prettyEta(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * Build and send the daily digest: one Telegram message listing every order
 * still in motion, soonest ETA first, with an "arriving soon" (next 3 days)
 * section up top when anything is due. Sends a short "all quiet" note when
 * nothing is active so you know the job ran.
 */
export async function sendDigest(
  notion: NotionClient,
  notifier: Notifier,
  log: Logger,
): Promise<void> {
  const rows = await notion.listRows();
  const active = rows.filter((r) => isOrderStatus(r.status) && ACTIVE.includes(r.status));

  if (active.length === 0) {
    await log.info("Daily digest: nothing in transit.");
    await notifier.notify("📭 <b>Daily digest</b>\nNothing in transit right now.");
    return;
  }

  // Soonest ETA first; rows without an ETA sink below, ordered by status.
  const sorted = [...active].sort((a, b) => {
    const ea = etaMs(a);
    const eb = etaMs(b);
    if (ea !== undefined && eb !== undefined) return ea - eb;
    if (ea !== undefined) return -1;
    if (eb !== undefined) return 1;
    return (
      ACTIVE.indexOf(a.status as OrderStatus) - ACTIVE.indexOf(b.status as OrderStatus)
    );
  });

  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const soon = new Set(
    sorted.filter((r) => {
      const e = etaMs(r);
      return e !== undefined && e >= todayMs && e <= todayMs + 3 * DAY_MS;
    }),
  );

  const fmt = (r: OrderRow): string => {
    const status = r.status as OrderStatus;
    const eta = r.eta ? ` — 🗓️ ${prettyEta(r.eta)}` : "";
    return `${STATUS_EMOJI[status]} <b>${escapeHtml(r.book)}</b> — ${status}${eta}`;
  };

  const lines: string[] = [];
  if (soon.size > 0) {
    lines.push("🔔 <b>Arriving soon</b> (next 3 days)");
    lines.push(...[...soon].map(fmt));
    const rest = sorted.filter((r) => !soon.has(r));
    if (rest.length > 0) {
      lines.push("");
      lines.push(...rest.map(fmt));
    }
  } else {
    lines.push(...sorted.map(fmt));
  }

  await log.info(
    `Daily digest: ${active.length} active order(s), ${soon.size} arriving soon.`,
  );
  await notifier.notify(
    `📬 <b>Daily digest</b> — ${active.length} on the way\n${lines.join("\n")}`,
  );
}
