import type { ParsedMessage } from "../gmail/client.js";
import { parseAmount } from "../money/fx.js";
import type { GeneralOrder } from "./parser.js";

/**
 * Merchant name from a Shopify sender's display name, e.g.
 * `"eXtremeRate Retail" <store+123@t.shopifyemail.com>` → "eXtremeRate". Drops a
 * generic storefront suffix (Retail/Store/Shop/Official) so the order key and row
 * label read as the brand. Falls back to the sender's local-part.
 */
function storeName(from: string): string {
  const display = from.match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim();
  const name =
    display ||
    from
      .split("@")[0]
      ?.replace(/[+<].*$/, "")
      .trim() ||
    "Shopify";
  return name.replace(/\s+(?:Retail|Store|Shop|Official)$/i, "").trim() || name;
}

/** First storefront link in the body (skips Shopify's own tracking domains). */
function storeUrl(body: string): string | undefined {
  for (const m of body.matchAll(/https?:\/\/[^\s)"]+/gi)) {
    const url = m[0];
    if (!/shopify(?:email)?\.com|myshopify\.com/i.test(url)) {
      return url.split("?")[0]; // drop the syclid tracking query
    }
  }
  return undefined;
}

// "<item name> × <qty> [SKU] $<price>" — the name has no "$"/"×"; an optional SKU
// token can sit between the quantity and the price (Shopify prints one for some
// line items). Global: successive matches walk the order-summary block, each
// starting after the previous item's price.
const ITEM_RE = /([^$×]+?)\s*×\s*\d+\s+(?:[A-Za-z0-9]{2,12}\s+)?\$\s?([\d.,]+)/g;
// The order total: word-boundary "Total" excludes "Subtotal"; a trailing ISO
// code is the true currency ("Total $79.72 USD").
const TOTAL_RE = /\bTotal\s+\$\s?([\d.,]+)(?:\s+([A-Z]{3}))?/;
// Add-on/insurance lines that aren't products (never the row's dominant item).
const NON_ITEM = /shipping protection|shipping insurance|route protection|\btip\b/i;

/**
 * Parse a Shopify store's "Order #… confirmed" email into a {@link GeneralOrder},
 * or null if it isn't a parseable Shopify confirmation. Shopify order numbers are
 * per-store (not globally unique), so the order key is namespaced by store —
 * "<store> #<number>" — to avoid colliding with another store's (or Amazon's)
 * ids. Stores bill in one currency, read from the Total line; only "$" totals are
 * parsed (an ISO suffix refines the currency, else USD), so a non-dollar store is
 * skipped rather than mis-valued. Spend-only; shipment/delivery mail isn't parsed.
 */
export function parseShopifyOrder(msg: ParsedMessage): GeneralOrder | null {
  if (!/shopifyemail\.com/i.test(msg.from)) return null;
  const num = msg.subject.match(/Order\s+#\s*([A-Za-z0-9][\w-]*)/i)?.[1];
  if (!num) return null;

  const body = (msg.body || msg.snippet).replace(/\s+/g, " ");
  // Scope to the order-summary block so header/footer text isn't parsed as items.
  const start = body.search(/Order summary/i);
  const seg = (start >= 0 ? body.slice(start) : body).replace(
    /^.*?Order summary\s*-*\s*/i,
    "",
  );

  const items: { name: string; amount: number }[] = [];
  for (const m of seg.matchAll(ITEM_RE)) {
    const name = m[1]!.trim().replace(/^-+\s*/, "");
    const amount = parseAmount(m[2]!);
    if (name && amount != null && !NON_ITEM.test(name)) items.push({ name, amount });
  }
  if (items.length === 0) return null;

  const totalM = body.match(TOTAL_RE);
  const total = totalM ? parseAmount(totalM[1]!) : null;
  if (total == null) return null;
  const currency = totalM?.[2] ?? "USD";

  const store = storeName(msg.from);
  const dominant = [...items].sort((a, b) => b.amount - a.amount)[0]!;
  return {
    orderId: `${store} #${num}`,
    merchant: store,
    dominantItem: dominant.name,
    itemCount: items.length,
    itemNames: items.map((it) => it.name),
    total,
    currency,
    dateMs: msg.internalDateMs,
    orderUrl: storeUrl(body),
  };
}
