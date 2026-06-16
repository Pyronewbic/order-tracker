import type { SubscriptionRecord } from "../state.js";
import { escapeHtml } from "../telegram/client.js";
import type { ChargeInfo } from "./parser.js";

export interface ChargeVerdict {
  /** Telegram alert text, or null if this charge isn't worth notifying about. */
  alert: string | null;
  /** The merchant key to store the updated record under. */
  key: string;
  /** Updated history record for this merchant. */
  record: SubscriptionRecord;
}

/**
 * Decide whether a charge warrants an alert, given the merchant's prior
 * history. We alert when:
 *   - the merchant has charged before (a recurring charge), or
 *   - the email explicitly reads like a new subscription.
 * A first-time, non-subscription one-off purchase is recorded silently.
 */
export function classifyCharge(
  charge: ChargeInfo,
  prev: SubscriptionRecord | undefined,
  atMs: number,
): ChargeVerdict {
  const key = charge.merchant.toLowerCase();
  const count = (prev?.count ?? 0) + 1;
  const merchant = escapeHtml(charge.merchant);
  const amount = escapeHtml(charge.amount);

  let alert: string | null = null;
  if (prev) {
    alert =
      `🔁 <b>Recurring charge</b>\n${merchant}: ${amount}\n` +
      `(charge #${count}; last on ${new Date(prev.lastSeenMs).toISOString().slice(0, 10)})`;
  } else if (charge.isSubscription) {
    alert = `🆕 <b>New subscription</b>\n${merchant}: ${amount}`;
  }

  return {
    alert,
    key,
    record: { lastSeenMs: atMs, count, lastAmount: charge.amount },
  };
}
