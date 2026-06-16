/** The three Notion "Status" select values this tracker manages. */
export const ORDER_STATUSES = ["Delivered", "In Transit", "Arriving Soon"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Monotonic progress ranking for the status-regression guard. A shipment may
 * only advance: In Transit → Arriving Soon → Delivered. An unknown/empty
 * current status ranks 0, so a fresh row can move to any status; `Delivered` is
 * terminal because nothing outranks it.
 */
const STATUS_RANK: Record<OrderStatus, number> = {
  "In Transit": 1,
  "Arriving Soon": 2,
  Delivered: 3,
};

/** Rank of a status string; unknown/empty values rank 0. */
export function statusRank(status: string): number {
  return (STATUS_RANK as Record<string, number>)[status] ?? 0;
}
