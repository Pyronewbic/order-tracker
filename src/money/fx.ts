import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../fsutil.js";

/** ISO-4217 currency code (USD, JPY, ARS, INR, EUR, …). */
export type Currency = string;

// Fallback OFFICIAL rates, in local units per 1 USD. Used when the FX API
// doesn't cover a currency (e.g. ARS — ECB doesn't publish it) or is
// unreachable. Hand-maintained, monthly granularity; extend as needed. An
// unknown month falls back to the nearest earlier month present.
const FALLBACK_RATES: Record<string, Record<string, number>> = {
  ARS: {
    "2023-01": 185, "2023-02": 188, "2023-03": 202, "2023-04": 216,
    "2023-05": 232, "2023-06": 248, "2023-07": 268, "2023-08": 320,
    "2023-09": 350, "2023-10": 350, "2023-11": 357, "2023-12": 550,
    "2024-01": 830, "2024-04": 870, "2024-07": 930, "2024-10": 980,
    "2024-12": 1030, "2025-04": 1100, "2025-08": 1250, "2025-12": 1350,
    "2026-06": 1450,
  },
  // JPY is covered by the API at daily resolution; this is only a safety net.
  JPY: {
    "2023-06": 140, "2024-06": 157, "2025-06": 145, "2026-01": 152, "2026-06": 148,
  },
};

// Currencies the FX API (Frankfurter / ECB) doesn't cover — skip the call.
const API_UNSUPPORTED = new Set(["ARS"]);

const CACHE_FILE = process.env.FX_CACHE_FILE ?? "fx-cache.json";
// Cache maps `${currency}:${YYYY-MM-DD}` → USD per 1 unit of that currency.
let cache: Record<string, number> | null = null;
let loading: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (cache) return;
  loading ??= (async () => {
    try {
      cache = JSON.parse(await readFile(CACHE_FILE, "utf8")) as Record<string, number>;
    } catch {
      cache = {};
    }
  })();
  await loading;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

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

/** USD per 1 unit of `cur` for `ym` from the fallback table (nearest earlier month). */
function fallbackUsdPerUnit(cur: Currency, ym: string): number | null {
  const table = FALLBACK_RATES[cur];
  if (!table) return null;
  let rate = table[ym];
  if (rate == null) {
    let best: string | undefined;
    for (const k of Object.keys(table).sort()) if (k <= ym) best = k;
    best ??= Object.keys(table).sort()[0];
    rate = best ? table[best] : undefined;
  }
  return rate ? 1 / rate : null;
}

/** Daily USD-per-unit from Frankfurter (ECB), or null if unsupported/unreachable. */
async function apiUsdPerUnit(cur: Currency, date: string): Promise<number | null> {
  if (API_UNSUPPORTED.has(cur)) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(
      `https://api.frankfurter.dev/v1/${date}?base=${encodeURIComponent(cur)}&symbols=USD`,
      { signal: ctrl.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as { rates?: { USD?: number } };
    const r = body.rates?.USD;
    return typeof r === "number" && r > 0 ? r : null;
  } catch {
    return null;
  }
}

/**
 * Convert `amount` of `cur` to USD at the rate for `dateMs`. Cache-first
 * (`fx-cache.json`), then a daily API rate, then the monthly fallback table.
 * Returns null only if no rate can be resolved at all. Results (incl. fallback)
 * are cached per currency+date so a given day is resolved at most once.
 */
export async function toUSD(amount: number, cur: Currency, dateMs: number): Promise<number | null> {
  if (cur === "USD") return round2(amount);
  await ensureLoaded();
  const date = new Date(dateMs).toISOString().slice(0, 10);
  const key = `${cur}:${date}`;
  let perUnit = cache![key];
  if (perUnit == null) {
    perUnit =
      (await apiUsdPerUnit(cur, date)) ?? fallbackUsdPerUnit(cur, date.slice(0, 7)) ?? NaN;
    if (Number.isNaN(perUnit)) return null;
    cache![key] = perUnit;
    await writeFileAtomic(CACHE_FILE, JSON.stringify(cache, null, 2));
  }
  return round2(amount * perUnit);
}
