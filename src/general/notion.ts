import { Client } from "@notionhq/client";
import { z } from "zod";
import { withRetry } from "../retry.js";

/** Fields written to a general purchase row. Omitted fields are left unchanged. */
export interface GeneralUpdate {
  item?: string;
  merchant?: string;
  category?: string;
  amount?: number;
  currency?: string;
  usd?: number;
  status?: string;
  dateMs?: number;
  items?: number;
}

/** A general purchase row reduced to what we read (for upsert by order #). */
export interface GeneralRow {
  pageId: string;
  orderId: string;
  status: string;
}

const txtVal = z
  .object({ rich_text: z.array(z.object({ plain_text: z.string() }).passthrough()) })
  .passthrough();
const rowSchema = z
  .object({
    id: z.string(),
    properties: z.object({
      "Order #": txtVal.optional(),
      Status: z.object({ select: z.object({ name: z.string() }).nullable() }).passthrough().optional(),
    }),
  })
  .passthrough();

const rt = (s: string): { rich_text: { text: { content: string } }[] } => ({ rich_text: [{ text: { content: s } }] });
const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Notion client for the standalone "Purchases (General)" DB. Like the other
 * auto-populated DBs it creates rows (needs Insert content), keyed by Amazon
 * order number.
 */
export class GeneralNotionClient {
  private readonly notion: Client;

  constructor(
    apiKey: string,
    private readonly databaseId: string,
  ) {
    this.notion = new Client({ auth: apiKey });
  }

  async verifyAccess(): Promise<void> {
    try {
      await withRetry(() => this.notion.databases.retrieve({ database_id: this.databaseId }));
    } catch (err) {
      throw new Error(
        `Cannot access general-purchases database ${this.databaseId}: ${String(err)}. ` +
          `Connect the integration and grant Read + Update + Insert content.`,
      );
    }
  }

  /** Existing rows keyed by order number. */
  async listOrders(): Promise<Map<string, GeneralRow>> {
    const byOrder = new Map<string, GeneralRow>();
    let cursor: string | undefined;
    do {
      const res = await withRetry(() =>
        this.notion.databases.query({ database_id: this.databaseId, start_cursor: cursor, page_size: 100 }),
      );
      for (const raw of res.results) {
        const parsed = rowSchema.safeParse(raw);
        if (!parsed.success) continue;
        const orderId = (parsed.data.properties["Order #"]?.rich_text ?? [])
          .map((t: { plain_text: string }) => t.plain_text)
          .join("")
          .trim();
        if (!orderId) continue;
        byOrder.set(orderId, {
          pageId: parsed.data.id,
          orderId,
          status: parsed.data.properties.Status?.select?.name ?? "",
        });
      }
      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return byOrder;
  }

  async createOrder(orderId: string, u: GeneralUpdate): Promise<string> {
    const properties = {
      Item: { title: [{ text: { content: u.item ?? orderId } }] },
      "Order #": rt(orderId),
      ...this.buildProperties(u, true),
    };
    const res = await withRetry(() =>
      this.notion.pages.create({
        parent: { database_id: this.databaseId },
        properties: properties as Parameters<Client["pages"]["create"]>[0]["properties"],
      }),
    );
    return res.id;
  }

  /**
   * Advance an order's lifecycle Status (Shipped/Delivered/Cancelled/Returned).
   * Unknown select options are auto-created by the REST API on first write.
   */
  async setStatus(pageId: string, status: string): Promise<void> {
    await withRetry(() =>
      this.notion.pages.update({
        page_id: pageId,
        properties: { Status: { select: { name: status } } } as Parameters<
          Client["pages"]["update"]
        >[0]["properties"],
      }),
    );
  }

  /** Update an existing order. Status is left untouched (it may be user-advanced). */
  async updateOrder(pageId: string, u: GeneralUpdate): Promise<void> {
    const properties = this.buildProperties(u, false);
    if (Object.keys(properties).length === 0) return;
    await withRetry(() =>
      this.notion.pages.update({
        page_id: pageId,
        properties: properties as Parameters<Client["pages"]["update"]>[0]["properties"],
      }),
    );
  }

  private buildProperties(u: GeneralUpdate, includeStatus: boolean): Record<string, unknown> {
    const p: Record<string, unknown> = {};
    if (u.item) p.Item = { title: [{ text: { content: u.item } }] };
    if (u.merchant) p.Merchant = { select: { name: u.merchant } };
    if (u.category) p.Category = { select: { name: u.category } };
    if (typeof u.amount === "number") p.Amount = { number: u.amount };
    if (u.currency) p.Currency = rt(u.currency);
    if (typeof u.usd === "number") p["Spend (USD)"] = { number: u.usd };
    if (typeof u.items === "number") p.Items = { number: u.items };
    if (u.dateMs) p.Date = { date: { start: isoDate(u.dateMs) } };
    if (includeStatus && u.status) p.Status = { select: { name: u.status } };
    return p;
  }
}
