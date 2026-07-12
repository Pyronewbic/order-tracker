import type { ParsedMessage } from "../gmail/client.js";
import { parseAmount } from "../money/fx.js";
import type { GeneralOrder } from "./parser.js";
import type { GeneralStatus, LifecycleEvent } from "./lifecycle.js";

// eBay order numbers are NN-NNNNN-NNNNN (distinct from Amazon's NNN-NNNNNNN-NNNNNNN).
const ORDER_RE = /\b\d{2}-\d{5}-\d{5}\b/;

/** Strip zero-width/HTML-entity noise and collapse whitespace. */
function clean(s: string): string {
  return s
    .replace(/[​-‏̀-ͯ⁠-⁯]/g, "")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Order confirmed: Umbreon 092/187 …" → "Umbreon 092/187" (drop prefix + ellipsis). */
function titleFromSubject(subject: string): string {
  return clean(subject)
    .replace(/^order confirmed:\s*/i, "")
    .replace(/\s*(?:\.{3}|…)\s*$/, "")
    .trim();
}

/**
 * Recover the full item title from the body by anchoring on the subject's
 * (truncated) title as a literal prefix, then reading up to the price/quantity/
 * Item-ID that follows the item line. Returns null when the prefix isn't found
 * (caller falls back to the subject). Anchoring avoids the boilerplate that a
 * fixed "order has shipped. … Price:" pattern grabs for Open-Box listings.
 */
function fullTitleFromBody(body: string, subjectTitle: string): string | null {
  if (subjectTitle.length < 8) return null; // too short to anchor reliably
  const idx = body.indexOf(subjectTitle);
  if (idx < 0) return null;
  const after = body.slice(idx);
  const m = after.match(/^(.+?)\s*(?:Price:|Item ID:|Qty\b|Quantity\b)/i);
  const title = (m?.[1] ?? subjectTitle).trim().slice(0, 160);
  // Reject a match that ran into eBay boilerplate (no real title contains these).
  if (/Money Back Guarantee|Open Box item|eBay sent this/i.test(title)) return null;
  return title || null;
}

/**
 * Parse an eBay "Order confirmed" email into a {@link GeneralOrder}, or null if
 * it isn't a parseable confirmation. The order number lives in the body; the
 * charged total is the amount after "Total charged to" (grand total incl.
 * shipping), falling back to the last dollar amount. eBay.com bills in USD.
 */
export function parseEbayOrder(msg: ParsedMessage): GeneralOrder | null {
  if (!/order confirmed/i.test(msg.subject)) return null;
  const body = clean(msg.body || msg.snippet);

  const orderId = body.match(ORDER_RE)?.[0] ?? msg.subject.match(ORDER_RE)?.[0];
  if (!orderId) return null;

  // Total precedence: "Total in USD $X" wins — eBay shows it when the card is
  // charged in a non-USD currency, and it's the true USD total. Only then is
  // "Total charged to … $Y" the order total (a USD-charged order, no USD line);
  // for a foreign charge that $Y is the local-currency amount (e.g. INR rendered
  // with a "$"), which must NOT be read as USD. Last resort: the final $ amount.
  const totalStr =
    body.match(/Total in USD\s*\$\s?([\d.,]+)/i)?.[1] ??
    body.match(/Total charged to[^$]*\$\s?([\d.,]+)/i)?.[1] ??
    [...body.matchAll(/\$\s?([\d.,]+)/g)].at(-1)?.[1];
  const total = totalStr ? parseAmount(totalStr) : null;
  if (total == null) return null;

  // The subject truncates the item ("…Team Ro…"). The body holds the full title,
  // but its position varies by listing type (a plain "order has shipped. <title>
  // Price:" anchor grabs boilerplate for Open-Box/guarantee listings). Anchor
  // instead on the subject's (truncated) title as a literal prefix, then read to
  // the price/Item-ID that follows the item line — falling back to the subject.
  const subjectTitle = titleFromSubject(msg.subject);
  const title = fullTitleFromBody(body, subjectTitle) || subjectTitle || orderId;
  return {
    orderId,
    merchant: "eBay",
    dominantItem: title,
    itemCount: 1,
    itemNames: [title],
    total,
    currency: "USD",
    dateMs: msg.internalDateMs,
  };
}

/**
 * Parse an eBay post-order email (shipment / delivery / refund) into a
 * {@link LifecycleEvent}, or null when it carries no order number or no
 * recognizable status. A refund maps to Returned (net-zero); cancellations are
 * intentionally not parsed here — they use a different id and always arrive with
 * a refund email, which is matchable. The order number is in the subject
 * (refunds) or body (shipment/delivery).
 */
export function parseEbayLifecycle(msg: ParsedMessage): LifecycleEvent | null {
  const orderId =
    msg.subject.match(ORDER_RE)?.[0] ?? clean(msg.body).match(ORDER_RE)?.[0];
  if (!orderId) return null;

  const subject = msg.subject;
  let status: GeneralStatus | null = null;
  if (/refund/i.test(subject)) status = "Returned";
  else if (/delivered|dropped off/i.test(subject)) status = "Delivered";
  else if (/with its carrier|out for delivery|on its way|has shipped/i.test(subject))
    status = "Shipped";
  if (!status) return null;

  return { orderId, status };
}
