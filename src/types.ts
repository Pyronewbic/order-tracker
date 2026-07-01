/**
 * Notion "Status" select values this tracker manages. Four form a monotonic
 * progress ladder (Ordered → In Transit → Arriving Soon → Delivered); the rest
 * are handled as special transitions (see the transition helpers below):
 * `Delayed` is a transient exception, `Cancelled`/`Returned` are terminal.
 */
export const ORDER_STATUSES = [
  "Ordered",
  "In Transit",
  "Delayed",
  "Arriving Soon",
  "Delivered",
  "Cancelled",
  "Returned",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Item-type categories assigned to an order row. */
export const ORDER_CATEGORIES = [
  "Game",
  "Book",
  "Accessory",
  "Electronics",
  "Digital",
  "Other",
] as const;

export type OrderCategory = (typeof ORDER_CATEGORIES)[number];

// Monotonic progress ladder. Only these advance linearly; Delayed (exception)
// and Cancelled/Returned (terminal) are handled explicitly in the transition
// rules (see pipeline.planUpdate). Unknown/empty/non-progress statuses rank 0.
const PROGRESS_RANK: Partial<Record<OrderStatus, number>> = {
  Ordered: 1,
  "In Transit": 2,
  "Arriving Soon": 3,
  Delivered: 4,
};

/** Progress-ladder rank of a status; unknown/empty/non-progress values rank 0. */
export function statusRank(status: string): number {
  return (PROGRESS_RANK as Record<string, number>)[status] ?? 0;
}

/** Terminal statuses: once set, a stale shipment email can't move them. */
export const TERMINAL_STATUSES = ["Cancelled", "Returned"] as const;

/** Whether a status is terminal (Cancelled/Returned). */
export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}
