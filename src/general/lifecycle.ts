import type { ParsedMessage } from "../gmail/client.js";

/**
 * Lifecycle states for a general order. `Ordered → Shipped → Delivered` is a
 * monotonic ladder; `Cancelled`/`Returned` are terminal and net-zero the spend
 * (the summary excludes terminal rows). `Ordered` is set when the order is first
 * created (from the confirmation email); the others come from post-order mail.
 */
export type GeneralStatus =
  "Ordered" | "Shipped" | "Delivered" | "Cancelled" | "Returned";

/** A lifecycle event parsed from a post-order (shipment/delivery/cancel/refund) email. */
export interface LifecycleEvent {
  /** Amazon order number, e.g. "112-5330094-0667440". */
  orderId: string;
  /** The status this email reports. */
  status: GeneralStatus;
}

/** Statuses that net-zero the spend and can't be superseded once set. */
export const TERMINAL_GENERAL_STATUSES: readonly GeneralStatus[] = [
  "Cancelled",
  "Returned",
];

export function isTerminalGeneralStatus(status: string): boolean {
  return (TERMINAL_GENERAL_STATUSES as readonly string[]).includes(status);
}

// Progress ladder (terminal states sit outside it). Unknown/"" → 0.
const RANK: Record<string, number> = { Ordered: 1, Shipped: 2, Delivered: 3 };

/**
 * Decide what to do with a general-order transition (current → new):
 *  - "noop": same status.
 *  - "regress": the new status can't supersede the current one.
 *  - "apply": write the new status.
 *
 * Cancelled/Returned are terminal (nothing supersedes them) but can be set from
 * any non-terminal state. The rest form a monotonic ladder that only advances.
 */
export function planGeneralUpdate(
  cur: string,
  next: GeneralStatus,
): "noop" | "regress" | "apply" {
  if (next === cur) return "noop";
  if (isTerminalGeneralStatus(cur)) return "regress"; // terminal — nothing supersedes
  if (isTerminalGeneralStatus(next)) return "apply"; // cancel/return from any live state
  return (RANK[next] ?? 0) > (RANK[cur] ?? 0) ? "apply" : "regress";
}

const ORDER_RE = /\b\d{3}-\d{7}-\d{7}\b/;

// Subject/snippet keyword → status, checked most-terminal first so a refund email
// that also mentions the earlier delivery resolves to Returned, not Delivered.
// Each entry: [status, matcher]. JP keywords included for amazon.co.jp mail.
const RULES: [GeneralStatus, RegExp][] = [
  ["Cancelled", /cancel|キャンセル|ご注文の取り消し/i],
  ["Returned", /refund|returned|return (?:received|complete)|返金|返品/i],
  ["Delivered", /delivered|配達(?:完了|済み)|お届け済み/i],
  // Out-for-delivery / arriving today implies it shipped — fold into Shipped.
  ["Shipped", /shipped|dispatched|on its way|out for delivery|arriving|発送|お届け予定/i],
];

/**
 * Parse a post-order Amazon email into a {@link LifecycleEvent}, or null when it
 * carries no order number or no recognizable lifecycle status (e.g. "Problem
 * during shipping" delay notices, which are intentionally ignored — out of
 * scope for the Ordered→Shipped→Delivered ladder). The order number is taken
 * from the subject when present, else the body's first match.
 */
export function parseLifecycleEmail(msg: ParsedMessage): LifecycleEvent | null {
  const orderId = msg.subject.match(ORDER_RE)?.[0] ?? msg.body.match(ORDER_RE)?.[0];
  if (!orderId) return null;

  // Prefer the subject (Amazon states the event there); fall back to the snippet.
  const text = `${msg.subject}\n${msg.snippet}`;
  for (const [status, re] of RULES) {
    if (re.test(text)) return { orderId, status };
  }
  return null;
}
