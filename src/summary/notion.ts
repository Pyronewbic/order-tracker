import { Client } from "@notionhq/client";
import { withRetry } from "../retry.js";
import { parseAmount, toUSD, type Currency } from "../money/fx.js";
import { isTerminalGeneralStatus } from "../general/lifecycle.js";
import type { Logger } from "../logger.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const txt = (p: any): string => (p?.rich_text ?? []).map((t: { plain_text: string }) => t.plain_text).join("");
const rt = (s: string): { rich_text: { text: { content: string } }[] } => ({ rich_text: [{ text: { content: s } }] });

// Notion property bags are dynamically shaped; read them through this helper
// instead of sprinkling `any` casts at every call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NotionProps = Record<string, any>;
const propsOf = (r: unknown): NotionProps => (r as { properties: NotionProps }).properties;

/** Currency of a book row, from the price symbol (₹/¥/$) with Source as fallback. */
function bookCurrency(price: string, source: string): Currency {
  if (price.includes("₹")) return "INR";
  if (price.includes("¥") || price.includes("￥")) return "JPY";
  if (source === "Amazon IN") return "INR";
  if (source === "Amazon JP") return "JPY";
  return "USD";
}

/**
 * Map a general-purchase merchant to its Spend Summary `Source` bucket. The
 * three Amazon regions collapse to one "Amazon" bucket (region detail lives in
 * the Purchases DB); eBay is its own bucket so slab spend is separable. Anything
 * unmapped falls back to "General".
 */
function generalSource(merchant: string): string {
  if (merchant === "eBay") return "eBay";
  if (merchant.startsWith("Amazon")) return "Amazon";
  return "General";
}

interface Bucket {
  usd: number;
  items: number;
}

/**
 * Maintains the cross-DB "Spend Summary" (Source × Month, in USD). Notion can't
 * sum across separate databases, so each tick this reads the spend-bearing DBs,
 * converts to USD (books from their free-text Price; games already carry a
 * Spend(USD)), and upserts one summary row per Source+Month. Books' per-row
 * Spend(USD) is also refreshed here so a manual Price edit is reflected. The
 * forwarder DB is intentionally excluded (logistics, no price).
 */
export class SpendSummary {
  private readonly notion: Client;

  constructor(
    apiKey: string,
    private readonly summaryDbId: string,
    private readonly booksDbId: string,
    private readonly gamesDbId: string | null,
    private readonly generalDbId: string | null,
  ) {
    this.notion = new Client({ auth: apiKey });
  }

  async verifyAccess(): Promise<void> {
    try {
      await withRetry(() => this.notion.databases.retrieve({ database_id: this.summaryDbId }));
    } catch (err) {
      throw new Error(
        `Cannot access spend-summary database ${this.summaryDbId}: ${String(err)}. ` +
          `Connect the integration and grant Read + Update + Insert content.`,
      );
    }
  }

  private async queryAll(dbId: string): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    do {
      const r = await withRetry(() =>
        this.notion.databases.query({ database_id: dbId, start_cursor: cursor, page_size: 100 }),
      );
      out.push(...(r.results as Record<string, unknown>[]));
      cursor = r.has_more ? (r.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return out;
  }

  /** Recompute and upsert all Source×Month buckets. Writes only changed rows. */
  async recompute(log: Logger, dryRun: boolean): Promise<void> {
    const buckets = new Map<string, Bucket>(); // `${source}|${month}`
    const add = (source: string, month: string, usd: number): void => {
      const k = `${source}|${month}`;
      const b = buckets.get(k) ?? { usd: 0, items: 0 };
      b.usd += usd;
      b.items += 1;
      buckets.set(k, b);
    };

    // Books: convert manual Price → USD, refresh per-row Spend(USD), accumulate.
    for (const r of await this.queryAll(this.booksDbId)) {
      const props = propsOf(r);
      const price = txt(props.Price);
      if (!price) continue;
      const amount = parseAmount(price);
      if (amount == null) continue;
      const source = props.Source?.select?.name ?? "";
      const dateStr: string = props.ETA?.date?.start ?? (r as { created_time: string }).created_time;
      const usd = await toUSD(amount, bookCurrency(price, source), new Date(dateStr).getTime());
      if (usd == null) continue;
      const prev = props["Spend (USD)"]?.number ?? null;
      if (!dryRun && prev !== usd) {
        await withRetry(() =>
          this.notion.pages.update({
            page_id: (r as { id: string }).id,
            properties: { "Spend (USD)": { number: usd } } as never,
          }),
        );
      }
      add("Books", new Date(dateStr).toISOString().slice(0, 7), usd);
    }

    // Games: already carry Spend(USD); accumulate by purchase month.
    if (this.gamesDbId) {
      for (const r of await this.queryAll(this.gamesDbId)) {
        const props = propsOf(r);
        const usd = props["Spend (USD)"]?.number;
        if (typeof usd !== "number") continue;
        const dateStr: string = props.Date?.date?.start ?? (r as { created_time: string }).created_time;
        add("Games", new Date(dateStr).toISOString().slice(0, 7), usd);
      }
    }

    // General: carry Spend(USD); accumulate by order month, bucketed by merchant
    // (Amazon vs eBay) so slab spend is separable. Cancelled/Returned orders are
    // excluded so a refunded purchase net-zeros (its row keeps the original USD
    // for reference; the summary just doesn't count it).
    if (this.generalDbId) {
      for (const r of await this.queryAll(this.generalDbId)) {
        const props = propsOf(r);
        if (isTerminalGeneralStatus(props.Status?.select?.name ?? "")) continue;
        const usd = props["Spend (USD)"]?.number;
        if (typeof usd !== "number") continue;
        const dateStr: string = props.Date?.date?.start ?? (r as { created_time: string }).created_time;
        const source = generalSource(props.Merchant?.select?.name ?? "");
        add(source, new Date(dateStr).toISOString().slice(0, 7), usd);
      }
    }

    // Upsert summary rows (create new / update changed only).
    const existing = new Map<string, { pageId: string; usd: number; items: number }>();
    for (const r of await this.queryAll(this.summaryDbId)) {
      const props = propsOf(r);
      const source = props.Source?.select?.name;
      const month = txt(props.Month);
      if (!source || !month) continue;
      existing.set(`${source}|${month}`, {
        pageId: (r as { id: string }).id,
        usd: props["Spend (USD)"]?.number ?? 0,
        items: props.Items?.number ?? 0,
      });
    }

    let writes = 0;
    for (const [k, b] of buckets) {
      const [source, month] = k.split("|");
      const usd = Math.round(b.usd * 100) / 100;
      const ex = existing.get(k);
      if (ex && ex.usd === usd && ex.items === b.items) continue;
      writes += 1;
      if (dryRun) continue;
      const properties = {
        Bucket: { title: [{ text: { content: `${source} ${month}` } }] },
        Source: { select: { name: source } },
        Month: rt(month!),
        "Spend (USD)": { number: usd },
        Items: { number: b.items },
      } as never;
      if (ex) {
        await withRetry(() => this.notion.pages.update({ page_id: ex.pageId, properties }));
      } else {
        await withRetry(() =>
          this.notion.pages.create({ parent: { database_id: this.summaryDbId }, properties }),
        );
      }
    }

    // Archive buckets that no longer have any qualifying spend (e.g. every one
    // of a month's general orders was refunded). The summary is fully derived
    // each run, so archiving loses nothing — a fresh row is created if spend
    // returns. Scoped to sources scanned this run, so disabling a source DB
    // doesn't wipe its historical buckets.
    const activeSources = new Set(["Books"]);
    if (this.gamesDbId) activeSources.add("Games");
    if (this.generalDbId) {
      activeSources.add("Amazon");
      activeSources.add("eBay");
      activeSources.add("General"); // legacy bucket; kept so old "General" rows get archived
    }
    let archived = 0;
    for (const [k, ex] of existing) {
      if (buckets.has(k)) continue;
      if (!activeSources.has(k.split("|")[0]!)) continue;
      archived += 1;
      if (dryRun) continue;
      await withRetry(() => this.notion.pages.update({ page_id: ex.pageId, archived: true }));
    }

    await log.info(
      `[summary] ${writes} bucket(s) ${dryRun ? "would change" : "updated"}` +
        (archived ? `, ${archived} emptied bucket(s) ${dryRun ? "would be" : ""} archived` : "") +
        ".",
    );
  }
}
