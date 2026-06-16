/** The three Notion "Status" select values this tracker manages. */
export const ORDER_STATUSES = ["Delivered", "In Transit", "Arriving Soon"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
