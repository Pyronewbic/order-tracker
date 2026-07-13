import type { ParsedMessage } from "../gmail/client.js";

/**
 * General spend categories the LLM may assign — the unified taxonomy minus the
 * domain-owned `Books`/`Games` (those are filtered out before categorization, so
 * the model can't reintroduce them into the general DB).
 */
export const GENERAL_LLM_CATEGORIES = [
  "Electronics",
  "Accessories",
  "Collectibles",
  "Software/Digital",
  "Home",
  "Groceries",
  "Clothing",
  "Subscriptions",
  "Other",
] as const;

/** A single order parsed from an Amazon order-confirmation email. */
export interface GeneralOrder {
  /** Amazon order number, e.g. "112-5330094-0667440". */
  orderId: string;
  /** "Amazon US" / "Amazon IN" / "Amazon JP", from the sender domain. */
  merchant: string;
  /** Highest-priced (or first) item name, for the row label. */
  dominantItem: string;
  /** Number of distinct line items in this order. */
  itemCount: number;
  /** Item names (for categorization). */
  itemNames: string[];
  /** Order total in `currency` (the amount actually charged). */
  total: number;
  /** ISO-4217 currency of the total (INR/JPY/USD…). */
  currency: string;
  /** Epoch ms the order was placed (the email date). */
  dateMs: number;
  /** Storefront order/details URL, when the source carries one (Shopify). */
  orderUrl?: string;
}

function merchantFor(from: string): string {
  const f = from.toLowerCase();
  if (f.includes("amazon.co.jp")) return "Amazon JP";
  if (f.includes("amazon.in")) return "Amazon IN";
  return "Amazon US";
}

// "1.234,56" / "1,234.56" / "5896" → number. Last separator with 1–2 trailing
// digits is the decimal; otherwise separators are thousands.
function num(s: string): number | null {
  const m = s.match(/[\d.,]+/);
  if (!m) return null;
  let t = m[0];
  const li = Math.max(t.lastIndexOf(","), t.lastIndexOf("."));
  if (li >= 0) {
    const after = t.length - li - 1;
    if (after === 1 || after === 2) {
      const dec = t[li]!;
      t = t
        .split(dec === "," ? "." : ",")
        .join("")
        .replace(dec, ".");
    } else t = t.replace(/[.,]/g, "");
  }
  const v = parseFloat(t);
  return Number.isNaN(v) ? null : v;
}

const ITEM_RE = /\*\s*(.+?)\s+Quantity:\s*\d+\s+([\d.,]+)\s+([A-Z]{3})/g;
const TOTAL_RE = /(?:Grand Total|Total)\s*:?\s*([\d.,]+)\s+([A-Z]{3})/;

/**
 * Parse an Amazon order-confirmation email into one or more {@link GeneralOrder}s.
 * A single email can bundle several `Order #` blocks, so we split on them and
 * parse each independently. Returns [] for non-order mail. The total is taken
 * from the order's own Total/Grand-Total line (the charged amount + currency).
 */
export function parseOrderEmail(msg: ParsedMessage): GeneralOrder[] {
  const body = (msg.body || msg.snippet).replace(/\s+/g, " ");
  const merchant = merchantFor(msg.from);
  const dateMs = msg.internalDateMs;

  // Split the body into per-order segments at each "Order # NNN".
  const marks = [...body.matchAll(/Order #\s*([0-9][0-9-]+)/g)];
  if (marks.length === 0) return [];

  const orders: GeneralOrder[] = [];
  for (let i = 0; i < marks.length; i++) {
    const orderId = marks[i]![1]!;
    const start = marks[i]!.index!;
    const end = i + 1 < marks.length ? marks[i + 1]!.index! : body.length;
    const seg = body.slice(start, end);

    const items: { name: string; amount: number; currency: string }[] = [];
    for (const m of seg.matchAll(ITEM_RE)) {
      const amount = num(m[2]!);
      if (amount != null) items.push({ name: m[1]!.trim(), amount, currency: m[3]! });
    }
    if (items.length === 0) continue;

    const totalM = seg.match(TOTAL_RE);
    const total = totalM ? num(totalM[1]!) : null;
    const currency = totalM ? totalM[2]! : items[0]!.currency;
    if (total == null) continue;

    const dominant = [...items].sort((a, b) => b.amount - a.amount)[0]!;
    orders.push({
      orderId,
      merchant,
      dominantItem: dominant.name,
      itemCount: items.length,
      itemNames: items.map((it) => it.name),
      total,
      currency,
      dateMs,
    });
  }
  return orders;
}
