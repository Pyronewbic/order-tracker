import type { GmailClient } from "../gmail/client.js";
import { parseOrderEmail } from "./parser.js";

/** An order's charged total, recovered from its mail. */
export interface RecoveredPrice {
  total: number;
  currency: string;
}

/** Cache of order # → recovered price (or null when the search came up empty),
 * so one tick / one backfill run never searches the same order twice. */
export type PriceCache = Map<string, RecoveredPrice | null>;

// Amazon threads a handful of mails per order (ordered / shipped / delivered /
// invoice); the confirmation-shaped ones carry the total. Cap the scan so a
// noisy thread can't turn one lookup into a long crawl.
const MAX_MESSAGES = 6;

/**
 * Recover an order's charged total from its mail, keyed by order # and
 * **independent of any watermark**.
 *
 * The shipping and lifecycle passes carry no price (a shipment email is parsed
 * for status, not amount), so an accessory they create or reclaim would
 * otherwise stay unpriced forever once that order's confirmation is older than
 * the general watermark — the gap that left a hand-typed amount on the Razer
 * mouse. Searching by order # sidesteps the watermark entirely.
 *
 * Best-effort by design: returns null when no mail for `orderId` carries a
 * parseable total, and the caller simply leaves the row unpriced (spend-only —
 * an amount is never invented).
 */
export async function recoverOrderPrice(
  gmail: GmailClient,
  orderId: string,
  cache?: PriceCache,
): Promise<RecoveredPrice | null> {
  const cached = cache?.get(orderId);
  if (cached !== undefined) return cached;

  let found: RecoveredPrice | null = null;
  try {
    const ids = await gmail.listMessageIds(`"${orderId}"`);
    for (const id of ids.slice(0, MAX_MESSAGES)) {
      const msg = await gmail.getMessage(id);
      const match = parseOrderEmail(msg).find(
        (o) => o.orderId === orderId && o.total > 0,
      );
      if (match) {
        found = { total: match.total, currency: match.currency };
        break;
      }
    }
  } catch {
    found = null; // a failed lookup must never break the calling pass
  }

  cache?.set(orderId, found);
  return found;
}
