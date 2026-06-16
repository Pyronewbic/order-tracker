import type { ParsedMessage } from "../gmail/client.js";

export interface ChargeInfo {
  /** Best-effort merchant name, derived from the sender. */
  merchant: string;
  /** Formatted amount as found in the email, or "unknown amount". */
  amount: string;
  /** True if the email explicitly reads like a subscription/recurring charge. */
  isSubscription: boolean;
  /** Subject line, for the alert detail. */
  detail: string;
}

// Phrases that mark an email as a subscription/recurring charge rather than a
// one-off purchase.
const SUBSCRIPTION_RE =
  /\b(subscription|recurring|auto-?renew(?:al|ed|s)?|renews?|renewed|membership|monthly plan|annual plan|your plan|billed (?:monthly|annually|yearly))\b/i;

// Currency amount: symbol or ISO code, then a number with optional thousands
// separators and decimals. Covers $, £, €, ₹ and USD/GBP/EUR/INR.
const AMOUNT_RE =
  /(?:USD|GBP|EUR|INR|US\$|[$£€₹])\s?\d{1,3}(?:[,\d]*)(?:\.\d{2})?/i;

/**
 * Parse a receipt/billing email into a {@link ChargeInfo}, or null if it does
 * not look like a charge (no amount and no subscription language).
 */
export function parseCharge(msg: ParsedMessage): ChargeInfo | null {
  const text = `${msg.subject}\n${msg.body || msg.snippet}`;
  const amount = text.match(AMOUNT_RE)?.[0]?.replace(/\s+/g, " ").trim();
  const isSubscription = SUBSCRIPTION_RE.test(text);

  if (!amount && !isSubscription) return null;

  return {
    merchant: extractMerchant(msg.from),
    amount: amount ?? "unknown amount",
    isSubscription,
    detail: msg.subject.trim(),
  };
}

/**
 * Derive a merchant name from a `From` header. Prefers the display name
 * ("Netflix" <…>); otherwise uses the email domain's main label.
 */
export function extractMerchant(from: string): string {
  const display = from.match(/^\s*"?([^"<]+?)"?\s*</);
  if (display?.[1]?.trim()) return display[1].trim();

  const domain = from.match(/@([^>\s]+)/)?.[1];
  if (domain) {
    const label = domain.split(".").slice(-2, -1)[0] ?? domain;
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  return from.trim() || "Unknown merchant";
}
