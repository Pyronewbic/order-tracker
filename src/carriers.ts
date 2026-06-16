/**
 * Carrier definitions used to (a) label which carrier an email came from and
 * (b) extract tracking numbers so carrier-only updates can be linked back to
 * the retailer email that first identified the item.
 *
 * Tracking-number patterns are deliberately specific. Generic "any 12 digits"
 * matching would collide with order numbers and dates, so each carrier uses
 * its documented format.
 */
export interface Carrier {
  name: string;
  /** Matches the email's `From` header. */
  sender: RegExp;
  /** Patterns that extract this carrier's tracking numbers. */
  tracking: RegExp[];
}

const UPS_TRACKING = /\b1Z[0-9A-Z]{16}\b/g;

export const CARRIERS: Carrier[] = [
  {
    name: "Amazon",
    sender: /amazon\.(com|in)\b/i,
    // Amazon Logistics (TBA…) plus any carrier number Amazon embeds.
    tracking: [/\bTBA\d{9,15}\b/g, UPS_TRACKING],
  },
  {
    name: "UPS",
    sender: /\bups\.com\b/i,
    tracking: [UPS_TRACKING],
  },
  {
    name: "FedEx",
    sender: /\bfedex\.com\b/i,
    tracking: [/\b\d{12}\b/g, /\b\d{15}\b/g, /\b\d{20}\b/g],
  },
  {
    name: "USPS",
    sender: /\busps\.com\b/i,
    // Impb (9-prefixed 22-digit) and international S10 (……US).
    tracking: [/\b9[0-9]{21}\b/g, /\b[A-Z]{2}\d{9}US\b/g],
  },
  {
    name: "India Post",
    sender: /\bindiapost\.gov\.in\b/i,
    tracking: [/\b[A-Z]{2}\d{9}IN\b/g],
  },
];

/** Identify the carrier from the `From` header, or null if unrecognized. */
export function detectCarrier(from: string): Carrier | null {
  return CARRIERS.find((c) => c.sender.test(from)) ?? null;
}

/**
 * Extract unique tracking numbers from `text` using the carrier's patterns
 * (falling back to every carrier's patterns when the carrier is unknown).
 */
export function extractTrackingNumbers(
  text: string,
  carrier: Carrier | null,
): string[] {
  const patterns = (carrier ? [carrier] : CARRIERS).flatMap((c) => c.tracking);
  const found = new Set<string>();
  for (const re of patterns) {
    for (const match of text.matchAll(re)) found.add(match[0]);
  }
  return [...found];
}
