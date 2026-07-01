import type { ParsedMessage } from "../src/gmail/client.js";
import type { OrderRow } from "../src/notion/client.js";
import type { ShipmentUpdate } from "../src/gmail/parser.js";
import type { OrderStatus } from "../src/types.js";

/** Build a ParsedMessage with sensible defaults; override only what a test needs. */
export function msg(partial: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    id: "m1",
    internalDateMs: Date.parse("2026-01-15T00:00:00Z"),
    subject: "",
    from: "",
    snippet: "",
    body: "",
    ...partial,
  };
}

/** Build a Notion OrderRow (only `book`/`status` usually matter to a test). */
export function row(book: string, extra: Partial<OrderRow> = {}): OrderRow {
  return { pageId: "p1", book, status: "", category: "", tags: [], ...extra };
}

/** Build a ShipmentUpdate for a given status. */
export function update(
  status: OrderStatus,
  extra: Partial<ShipmentUpdate> = {},
): ShipmentUpdate {
  return {
    status,
    itemName: "",
    trackingNumbers: [],
    carrier: "Unknown",
    category: null,
    tags: [],
    detail: "",
    ...extra,
  };
}
