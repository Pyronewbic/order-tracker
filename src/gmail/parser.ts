import type { OrderCategory, OrderStatus } from "../types.js";
import type { ParsedMessage } from "./client.js";
import { detectCarrier, extractTrackingNumbers } from "../carriers.js";
import { classifyItem, tagsFor } from "../categorize.js";

export interface ShipmentUpdate {
  status: OrderStatus;
  /** Item/book name from the subject. "" when the email omits it (typical of
   * pure carrier notifications). */
  itemName: string;
  /** Tracking numbers found in the email, used to link carrier updates. */
  trackingNumbers: string[];
  /** Carrier name ("Amazon", "UPS", …) or "Unknown". */
  carrier: string;
  /** Item-type category, or null when it can't be determined confidently. */
  category: OrderCategory | null;
  /** Deterministic tags (franchise/attributes); may be empty. */
  tags: string[];
  /** Short human-readable detail used in logs / notifications. */
  detail: string;
}

/**
 * Status phrases are checked most-specific first. "Out for delivery" must be
 * tested before the generic "delivered" check, and "delivered" before
 * "shipped", so a forwarded thread quoting an earlier event can't downgrade a
 * later one.
 */
const STATUS_RULES: { status: OrderStatus; patterns: RegExp[] }[] = [
  // Decisive states first; "Ordered" (weakest signal) is checked last so a
  // "your order has shipped" email resolves to In Transit, not Ordered.
  {
    status: "Cancelled",
    patterns: [
      /\bhas been cancell?ed\b/i,
      /\border (?:was |has been |is )?cancell?ed\b/i,
      /\b(?:we|amazon)[^.]{0,30}cancell?ed your\b/i,
      /^cancell?ed[:\s-]/i,
      /ご注文[^。]{0,12}キャンセル/,
    ],
  },
  {
    status: "Returned",
    patterns: [
      /\byour return\b/i,
      /\breturn (?:was |has been |is )?(?:received|completed|processed)\b/i,
      /\brefund (?:was |has been |is )?(?:issued|processed|completed)\b/i,
      /\breturned to (?:sender|seller|us)\b/i,
      /^returned[:\s-]/i,
    ],
  },
  {
    status: "Delayed",
    patterns: [
      /\b(?:delivery|shipment|package|order) (?:is |has been |was )?delayed\b/i,
      /\bdelay(?:ed)? (?:in )?(?:your )?(?:delivery|shipment)\b/i,
      /\bdelivery (?:exception|attempt(?:ed)? (?:failed|unsuccessful))\b/i,
      /\b(?:couldn'?t|could not|unable to|were unable to|failed to) (?:be )?deliver/i,
      /\battempted delivery\b/i,
    ],
  },
  {
    status: "Arriving Soon",
    patterns: [
      /out for delivery/i,
      /arriving\b/i,
      /scheduled for delivery/i,
      // Future delivery ("will be delivered tomorrow", "expected delivery
      // Monday") must beat the completed-delivery check below.
      /(?:will be|to be|expected(?: to be)?|estimated|scheduled)\s+deliver/i,
      /deliver(?:y|ed)?\s+(?:today|tomorrow|on\b|by\b)/i,
      /(?:expected|estimated)\s+delivery/i,
    ],
  },
  {
    status: "Delivered",
    patterns: [/\bdelivered\b/i, /was delivered/i, /has been delivered/i],
  },
  {
    status: "In Transit",
    patterns: [
      /has shipped/i,
      /\bshipped\b/i,
      /on its way/i,
      /on the way/i,
      /in transit/i,
      /dispatched/i,
      /label created/i,
    ],
  },
  {
    status: "Ordered",
    patterns: [
      /^ordered[:\s-]/i,
      /\border (?:has been )?(?:placed|confirmed|received)\b/i,
      /\bthank you for your order\b/i,
      /\bwe(?:'ve| have) received your order\b/i,
      /\border confirmation\b/i,
    ],
  },
];

/** Determine the order status from subject + body, or null if none matches. */
export function detectStatus(text: string): OrderStatus | null {
  for (const rule of STATUS_RULES) {
    if (rule.patterns.some((p) => p.test(text))) return rule.status;
  }
  return null;
}

/**
 * Pull the item/book name out of an Amazon subject line. Amazon phrasings vary
 * by locale, so we try, in order: a quoted title, the text after "of", then a
 * `Shipped:`/`Delivered:` prefix. Returns "" if nothing usable is found.
 */
export function extractItemName(subject: string): string {
  const quoted = subject.match(/["“”']([^"“”']{3,})["“”']/);
  if (quoted?.[1]) return cleanItemName(quoted[1]);

  const ofMatch = subject.match(
    /\border (?:of|for)\s+(.+?)(?:\s+(?:has|is|was|and|have)\b|$)/i,
  );
  if (ofMatch?.[1]) return cleanItemName(ofMatch[1]);

  const prefixMatch = subject.match(
    /^(?:shipped|delivered|out for delivery|ordered)\s*[:\-]\s*(.+)$/i,
  );
  if (prefixMatch?.[1]) return cleanItemName(prefixMatch[1]);

  return "";
}

/** Trim Amazon noise like "and 2 more items" and surrounding punctuation. */
function cleanItemName(raw: string): string {
  return raw
    .replace(/\s+and\s+\d+\s+more\s+items?.*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s"“”':;,.-]+|[\s"“”':;,.-]+$/g, "")
    .trim();
}

/**
 * Assemble a {@link ShipmentUpdate} for a known status. Carrier, tracking
 * numbers, and detail are always derived deterministically from the email here;
 * the LLM fallback supplies only `status` (and optionally `itemNameOverride`) so
 * tracking numbers are never invented by the model.
 */
export function buildUpdate(
  msg: ParsedMessage,
  status: OrderStatus,
  itemNameOverride?: string,
): ShipmentUpdate {
  const carrier = detectCarrier(msg.from);
  const haystack = `${msg.subject}\n${msg.body || msg.snippet}`;
  const itemName = itemNameOverride?.trim() || extractItemName(msg.subject);

  const signal = { itemName, from: msg.from, subject: msg.subject };
  return {
    status,
    itemName,
    trackingNumbers: extractTrackingNumbers(haystack, carrier),
    carrier: carrier?.name ?? "Unknown",
    category: classifyItem(signal),
    tags: tagsFor(signal),
    detail: msg.subject.trim(),
  };
}

/**
 * Parse a Gmail message into a {@link ShipmentUpdate}, or null if no shipping
 * status can be determined. An email with a recognizable status but no item
 * name is still returned — it can be matched to a Notion row by tracking number
 * instead. Returning null is the signal for the optional LLM fallback to try.
 */
export function parseMessage(msg: ParsedMessage): ShipmentUpdate | null {
  // Subject is the most reliable status signal; fall back to the body.
  const status =
    detectStatus(msg.subject) ?? detectStatus(msg.body) ?? detectStatus(msg.snippet);
  if (!status) return null;
  return buildUpdate(msg, status);
}
