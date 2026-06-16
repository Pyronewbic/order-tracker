import type { OrderStatus } from "../types.js";

// The tracker reasons in a shipment-oriented status vocabulary (see types.ts).
// The target Notion database may use its own, collection-oriented vocabulary.
// These maps translate at the Notion boundary so the rest of the app only ever
// deals with the internal vocabulary. A database that already uses the internal
// names needs no entries here — unmapped values pass through unchanged.

// Notion select value → internal status (applied when reading rows).
// `Preorder` is treated as the earliest ladder stage so a preordered item can
// still advance to In Transit / Delivered once it ships.
const READ_MAP: Record<string, OrderStatus> = {
  Preorder: "Ordered",
};

// Internal status → Notion select value (applied when writing).
//  - present, string : write that option.
//  - present, null   : the target DB has no equivalent — leave Status untouched.
//  - absent          : write the internal name verbatim (generic DB fallback).
const WRITE_MAP: Partial<Record<OrderStatus, string | null>> = {
  "In Transit": "In Transit",
  "Arriving Soon": "Arriving Soon",
  Delivered: "Delivered",
  Delayed: "In Transit", // no "Delayed" option here — fold into In Transit
  Ordered: null, // no equivalent — don't downgrade a curated row
  Cancelled: null, // user manages cancellations manually (To Reorder / To Sell)
  Returned: null,
};

// Statuses that represent a user-managed lifecycle decision the tracker must
// never overwrite from an incoming shipment email.
const PROTECTED = new Set(["To Reorder", "To Sell"]);

/** Translate a Notion Status value into the tracker's internal vocabulary. */
export function fromNotionStatus(raw: string): string {
  return READ_MAP[raw] ?? raw;
}

/**
 * Translate an internal status into the Notion Status value to write, or null if
 * the target database has no equivalent (Status should then be left as-is).
 */
export function toNotionStatus(status: OrderStatus): string | null {
  return status in WRITE_MAP ? (WRITE_MAP[status] as string | null) : status;
}

/** Whether a (current) Notion status is user-managed and must not be overwritten. */
export function isProtectedStatus(status: string): boolean {
  return PROTECTED.has(status);
}
