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
  /** Amazon order number (NNN-NNNNNNN-NNNNNNN), if present. Links title-less
   * updates (e.g. Amazon IN "Delivered: 1 item | Order # …") back to a row. */
  orderId?: string;
  /** Carrier name ("Amazon", "UPS", …) or "Unknown". */
  carrier: string;
  /** Item-type category, or null when it can't be determined confidently. */
  category: OrderCategory | null;
  /** Deterministic tags (franchise/attributes); may be empty. */
  tags: string[];
  /** Short human-readable detail used in logs / notifications. */
  detail: string;
  /** Parsed delivery ETA (epoch ms, date-only) for a still-in-motion order, if
   * the email states one. Feeds the Notion ETA / calendar. */
  etaMs?: number;
  /** For a Delivered email, the email's own date (epoch ms) — the actual
   * delivered-on date, recorded so slip = ETA − delivered. */
  deliveredMs?: number;
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

const ORDER_NUMBER_RE = /\b\d{3}-\d{7}-\d{7}\b/;

/** Amazon order number from the subject (preferred) or body, if present. */
function extractOrderId(msg: ParsedMessage): string | undefined {
  return (
    msg.subject.match(ORDER_NUMBER_RE)?.[0] ??
    (msg.body || msg.snippet).match(ORDER_NUMBER_RE)?.[0]
  );
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const WEEKDAY: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
const DAY_MS = 86_400_000;

/**
 * Resolve a delivery ETA (epoch ms, UTC date-only) from a shipment email,
 * anchored to when the email was received. Only text adjacent to a delivery cue
 * is examined, so an unrelated date (an order date, a price, a copyright year)
 * can't be misread. Absolute dates are tried first, then relative words
 * (today / tomorrow / weekday). Returns undefined when no plausible date is
 * found; a result is accepted only within [anchor − 1 day, anchor + 60 days],
 * which rejects past dates and year misparses. Best-effort by design — a manual
 * ETA always wins at the write layer.
 */
export function resolveEtaMs(text: string, anchorMs: number): number | undefined {
  const cue = text.match(
    /(?:arriv\w*|deliver\w*|expected|estimated|scheduled)[^.\n]{0,40}/i,
  );
  if (!cue) return undefined;
  const scope = cue[0].toLowerCase();

  const a = new Date(anchorMs);
  const anchorUTC = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const MON = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";

  let eta: number | undefined;
  const md = scope.match(
    new RegExp(`\\b(${MON})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`),
  );
  const dm = scope.match(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON})[a-z]*(?:,?\\s*(\\d{4}))?`),
  );
  if (md || dm) {
    const mon = MONTHS[(md ? md[1] : dm![2])!]!;
    const day = Number(md ? md[2] : dm![1]);
    const yr = md ? md[3] : dm![3];
    const year = yr ? Number(yr) : a.getUTCFullYear();
    let cand = Date.UTC(year, mon, day);
    // No explicit year and the date is well in the past → a Dec→Jan rollover.
    if (!yr && cand < anchorUTC - 35 * DAY_MS) cand = Date.UTC(year + 1, mon, day);
    if (day >= 1 && day <= 31) eta = cand;
  } else if (/\btoday\b/.test(scope)) {
    eta = anchorUTC;
  } else if (/\btomorrow\b/.test(scope)) {
    eta = anchorUTC + DAY_MS;
  } else {
    const wd = scope.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/);
    if (wd) {
      const target = WEEKDAY[wd[1]!]!;
      const cur = new Date(anchorUTC).getUTCDay();
      let delta = (target - cur + 7) % 7;
      if (delta === 0) delta = 7; // "arriving Monday" when today is Monday → next
      eta = anchorUTC + delta * DAY_MS;
    }
  }

  if (eta === undefined) return undefined;
  // Reject a past date (a misread order date) or an implausibly far one (a
  // year misparse); 120 days still covers slow international / preorder ETAs.
  if (eta < anchorUTC - DAY_MS || eta > anchorUTC + 120 * DAY_MS) return undefined;
  return eta;
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
  // Only pre-delivery states carry a meaningful ETA; a Delivered email instead
  // records its own date as the actual delivered-on date.
  const inMotion =
    status === "Ordered" ||
    status === "In Transit" ||
    status === "Arriving Soon" ||
    status === "Delayed";
  return {
    status,
    itemName,
    trackingNumbers: extractTrackingNumbers(haystack, carrier),
    orderId: extractOrderId(msg),
    carrier: carrier?.name ?? "Unknown",
    category: classifyItem(signal),
    tags: tagsFor(signal),
    detail: msg.subject.trim(),
    etaMs: inMotion ? resolveEtaMs(haystack, msg.internalDateMs) : undefined,
    deliveredMs: status === "Delivered" ? msg.internalDateMs : undefined,
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
