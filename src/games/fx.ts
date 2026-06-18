// Approximate month-end OFFICIAL FX rates, in units of local currency per 1 USD.
// Used to express multi-currency game spend in a single USD figure ("list price
// in USD" basis — card taxes are NOT included). These are hand-maintained
// estimates; extend with new months as needed. An unknown month falls back to
// the nearest earlier month present (then the earliest). ARS especially is only
// a ballpark — the peso moved several-fold over 2023–2024.
const RATES: Record<string, Record<string, number>> = {
  ARS: {
    "2023-01": 185, "2023-02": 188, "2023-03": 202, "2023-04": 216,
    "2023-05": 232, "2023-06": 248, "2023-07": 268, "2023-08": 320,
    "2023-09": 350, "2023-10": 350, "2023-11": 357, "2023-12": 550,
    "2024-01": 830, "2024-04": 870, "2024-07": 930, "2024-10": 980,
    "2024-12": 1030, "2025-04": 1100, "2025-08": 1250, "2025-12": 1350,
    "2026-06": 1450,
  },
  JPY: {
    "2023-06": 140, "2023-12": 145, "2024-06": 157, "2024-12": 153,
    "2025-06": 145, "2025-11": 154, "2025-12": 157, "2026-01": 157,
    "2026-03": 150, "2026-04": 148, "2026-05": 148, "2026-06": 145,
  },
};

export type Currency = "USD" | "ARS" | "JPY";

/** Currency of a game platform, from its region suffix (eShop US/AR/JP, Amazon JP). */
export function currencyFor(platform: string): Currency {
  if (platform.endsWith(" AR")) return "ARS";
  if (platform.endsWith(" JP")) return "JPY";
  return "USD"; // eShop US and anything else default to USD
}

/**
 * Parse a localized price string into a number. Handles US "1,234.56" and
 * AR/JP "1.234,56" / "3,960" by treating the last separator with 1–2 trailing
 * digits as the decimal and the rest as thousands.
 */
export function parseAmount(s: string): number | null {
  const m = s.match(/[\d.,]+/);
  if (!m) return null;
  let t = m[0];
  const li = Math.max(t.lastIndexOf(","), t.lastIndexOf("."));
  if (li >= 0) {
    const after = t.length - li - 1;
    if (after === 1 || after === 2) {
      const dec = t[li]!;
      const thou = dec === "," ? "." : ",";
      t = t.split(thou).join("").replace(dec, ".");
    } else {
      t = t.replace(/[.,]/g, "");
    }
  }
  const v = parseFloat(t);
  return Number.isNaN(v) ? null : v;
}

function rateFor(cur: Currency, ym: string): number | null {
  if (cur === "USD") return 1;
  const table = RATES[cur];
  if (!table) return null;
  if (table[ym]) return table[ym]!;
  const keys = Object.keys(table).sort();
  let best: string | undefined;
  for (const k of keys) if (k <= ym) best = k;
  best ??= keys[0];
  return best ? (table[best] ?? null) : null;
}

/**
 * Convert a local amount to USD at the purchase month's official rate. Returns
 * null if the currency/month can't be resolved (caller leaves USD blank).
 */
export function toUSD(amount: number, cur: Currency, dateMs: number): number | null {
  const ym = new Date(dateMs).toISOString().slice(0, 7);
  const rate = rateFor(cur, ym);
  if (rate == null || rate === 0) return null;
  return Math.round((amount / rate) * 100) / 100;
}
