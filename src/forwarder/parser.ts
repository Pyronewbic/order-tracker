import type { ParsedMessage } from "../gmail/client.js";

/** The kinds of ForwardMe notification we act on. */
export type ForwarderEventKind = "arrival" | "reminder" | "outbound";

/**
 * A parsed ForwardMe email. ForwardMe identifies packages only by an opaque
 * code (e.g. "L") — there is no item title or tracking number — so a package is
 * keyed by that code. `outbound` events (a shipment leaving the warehouse) can't
 * be tied back to a code, so they carry no fields and are only logged.
 */
export interface ForwarderEvent {
  kind: ForwarderEventKind;
  /** Epoch ms the email was received (the event time). */
  receivedMs: number;
  /** Package code; present for arrival/reminder, absent for outbound. */
  code?: string;
  /** Origin marketplace ("eBay", …) — arrival only. */
  from?: string;
  /** Free-text contents ("1 x Trading Card") — arrival only. */
  contents?: string;
  /** Declared value, formatted with a leading "$" — arrival only. */
  declaredValue?: string;
  /** Weight as written ("0.1 lbs", "0.05 kg") — arrival only. */
  weight?: string;
  /** Days of storage remaining before disposal — reminder only. */
  daysLeft?: number;
}

const OUTBOUND = /\[ship\]|flying to you|shipment request/i;
const ARRIVAL = /your package arrived|has safely arrived/i;
const REMINDER =
  /last\s+\d+\s+day\s+for\s+package|approaching storage limit|reminder about your package/i;

/** First capture group of the first matching pattern, trimmed; else undefined. */
function firstMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

// ForwardMe's mail is messy — a degenerate template sometimes renders the code
// as the literal word "undefined". Treat that (and empties) as "no code".
function cleanCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const c = code.trim();
  return c && c.toLowerCase() !== "undefined" ? c : undefined;
}

/**
 * Parse a ForwardMe email into a {@link ForwarderEvent}, or null if it isn't one
 * we track (e.g. billing/subscription mail). Caller should pre-filter to
 * ForwardMe's sender; this only classifies the content.
 */
export function parseForwarderEmail(msg: ParsedMessage): ForwarderEvent | null {
  const subject = msg.subject;
  const body = msg.body || msg.snippet;
  const receivedMs = msg.internalDateMs;

  // Order matters: arrival ("arrived") and outbound ("[SHIP]"/"flying") have
  // distinct phrasing; reminders are the broad fallback.
  if (ARRIVAL.test(subject) || ARRIVAL.test(body)) {
    const code = cleanCode(
      firstMatch(body, [
        /package\s+(\w+)\s+has safely arrived/i,
        /Package ID #\s*(\w+)/i,
      ]),
    );
    if (!code) return null; // an arrival we can't key is useless
    const declared = firstMatch(body, [/Declared Value\s*\$?\s*([\d,.]+)/i]);
    return {
      kind: "arrival",
      receivedMs,
      code,
      from: firstMatch(body, [/From\s+([\w .&-]{2,20}?)\s+(?:Weight|Dimensions)/i]),
      contents: firstMatch(body, [
        /Contents:\s*•?\s*(.+?)\s*(?:Please check|If anything)/i,
      ]),
      declaredValue: declared ? `$${declared}` : undefined,
      weight: firstMatch(body, [/Weight\s+([\d.]+\s*(?:kg|lbs?|g))/i]),
    };
  }

  if (OUTBOUND.test(subject)) {
    return { kind: "outbound", receivedMs };
  }

  if (REMINDER.test(subject) || REMINDER.test(body)) {
    const code = cleanCode(
      firstMatch(subject, [
        /last\s+\d+\s+day\s+for\s+package\s+(\w+)/i,
        /package\s+(\w+)\s+approaching storage limit/i,
        /reminder about your package\s+(\w+)\s+storage/i,
      ]) ?? firstMatch(body, [/package\s+(\w+)\s+(?:has|is|approaching|exceeded)/i]),
    );
    if (!code) return null;

    let daysLeft: number | undefined;
    const n =
      firstMatch(subject, [/last\s+(\d+)\s+day/i]) ??
      firstMatch(body, [/only\s+(\d+)\s+day/i]);
    if (n) daysLeft = Number(n);
    // "approaching storage limit. Last Day to take an action" → effectively 1 day.
    else if (/approaching storage limit/i.test(subject)) daysLeft = 1;

    return { kind: "reminder", receivedMs, code, daysLeft };
  }

  return null;
}
