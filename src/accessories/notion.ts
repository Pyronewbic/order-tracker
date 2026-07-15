import { Client } from "@notionhq/client";
import { z } from "zod";
import { withRetry } from "../retry.js";
import type { OrderStatus } from "../types.js";
import type { GeneralStatus } from "../general/lifecycle.js";

/**
 * Delivery ladder for an auto-tracked tech accessory in the Tech Inventory
 * Accessories DB. `Owned` = delivered / in hand; `Cancelled` is terminal.
 * `Wishlist` is a manual value the tracker never sets and never overwrites.
 */
export type AccessoryStatus = "Ordered" | "Shipped" | "Arriving" | "Owned" | "Cancelled";

const RANK: Record<string, number> = { Ordered: 1, Shipped: 2, Arriving: 3, Owned: 4 };

/** Map the tracker's internal shipment status onto the accessory ladder. */
export function accessoryStatusFromShipment(s: OrderStatus): AccessoryStatus {
  switch (s) {
    case "Delivered":
      return "Owned";
    case "Arriving Soon":
      return "Arriving";
    case "In Transit":
    case "Delayed":
      return "Shipped";
    case "Cancelled":
    case "Returned":
      return "Cancelled";
    default:
      return "Ordered";
  }
}

/** Map a general-order lifecycle status onto the accessory ladder. */
export function accessoryStatusFromGeneral(s: GeneralStatus): AccessoryStatus {
  switch (s) {
    case "Delivered":
      return "Owned";
    case "Shipped":
      return "Shipped";
    case "Cancelled":
    case "Returned":
      return "Cancelled";
    default:
      return "Ordered";
  }
}

/**
 * Decide a transition on the accessory ladder: "noop" / "regress" / "apply".
 * Monotonic (Ordered → Shipped → Arriving → Owned). `Cancelled` is terminal;
 * `Owned` is protected (once in hand a stale email can't move it); a manual
 * `Wishlist` is never touched.
 */
export function planAccessoryUpdate(
  cur: string,
  next: AccessoryStatus,
): "noop" | "regress" | "apply" {
  if (next === cur) return "noop";
  if (cur === "Cancelled" || cur === "Owned" || cur === "Wishlist") return "regress";
  if (next === "Cancelled") return "apply";
  return (RANK[next] ?? 0) > (RANK[cur] ?? 0) ? "apply" : "regress";
}

/** Fields written to an accessory row. Omitted fields are left unchanged. */
export interface AccessoryUpdate {
  name?: string;
  amount?: number;
  /** ISO-4217-ish code (USD/INR/…) → the Currency select. */
  currency?: string;
  /** One of the Accessories DB's category buckets. */
  category?: string;
  orderUrl?: string;
  notes?: string;
  status?: AccessoryStatus;
  /** Delivery ETA (epoch ms → date-only) for the accessory Arrivals calendar. */
  etaMs?: number;
  /** Actual delivered-on date (epoch ms → date-only), set on →Owned. Feeds the
   * warranty-period formulas (Warranty ends / days left). */
  deliveredMs?: number;
}

/** An accessory row reduced to what we read (only the auto-tracked ones). */
export interface AccessoryRow {
  pageId: string;
  orderId: string;
  status: string;
  /** Charged amount, or null when the row is still unpriced — a shipment-created
   * row whose confirmation never supplied a price. Drives the price recovery. */
  amount: number | null;
  /** Currency of {@link amount}; needed to compare a row against a recovered
   * price like-for-like (a USD row must never be diffed against an INR total). */
  currency: string | null;
}

const rt = (s: string): { rich_text: { text: { content: string } }[] } => ({
  rich_text: [{ text: { content: s } }],
});
const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const rowSchema = z
  .object({
    id: z.string(),
    properties: z.object({
      "Order #": z
        .object({
          rich_text: z.array(z.object({ plain_text: z.string() }).passthrough()),
        })
        .passthrough()
        .optional(),
      Status: z
        .object({ select: z.object({ name: z.string() }).nullable() })
        .passthrough()
        .optional(),
      Amount: z.object({ number: z.number().nullable() }).passthrough().optional(),
      Currency: z
        .object({ select: z.object({ name: z.string() }).nullable() })
        .passthrough()
        .optional(),
    }),
  })
  .passthrough();

/**
 * Notion client for the Tech Inventory "Accessories" DB. Creates rows keyed by
 * Amazon order number (a hidden "Order #" column); manual rows carry no order #
 * and are therefore never read, matched, or overwritten by the tracker.
 */
export class AccessoriesNotionClient {
  private readonly notion: Client;

  constructor(
    apiKey: string,
    private readonly databaseId: string,
  ) {
    this.notion = new Client({ auth: apiKey });
  }

  async verifyAccess(): Promise<void> {
    try {
      await withRetry(() =>
        this.notion.databases.retrieve({ database_id: this.databaseId }),
      );
    } catch (err) {
      throw new Error(
        `Cannot access accessories database ${this.databaseId}: ${String(err)}. ` +
          `Connect the integration and grant Read + Update + Insert content.`,
      );
    }
  }

  /** Auto-tracked rows keyed by order # (rows without an order # are skipped). */
  async listByOrder(): Promise<Map<string, AccessoryRow>> {
    const byOrder = new Map<string, AccessoryRow>();
    let cursor: string | undefined;
    do {
      const res = await withRetry(() =>
        this.notion.databases.query({
          database_id: this.databaseId,
          start_cursor: cursor,
          page_size: 100,
        }),
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
          amount: parsed.data.properties.Amount?.number ?? null,
          currency: parsed.data.properties.Currency?.select?.name ?? null,
        });
      }
      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return byOrder;
  }

  async createAccessory(orderId: string, u: AccessoryUpdate): Promise<string> {
    const properties = this.buildProps(u, true);
    if (!properties.Name) properties.Name = { title: [{ text: { content: orderId } }] };
    properties["Order #"] = rt(orderId);
    const res = await withRetry(() =>
      this.notion.pages.create({
        parent: { database_id: this.databaseId },
        properties: properties as Parameters<Client["pages"]["create"]>[0]["properties"],
      }),
    );
    return res.id;
  }

  /**
   * Advance an accessory's delivery Status. On an →`Owned` transition,
   * `deliveredMs` (the delivering email's date) is stamped on the "Delivered
   * date" column so the warranty-period formulas have an actual arrival date.
   */
  async setStatus(
    pageId: string,
    status: AccessoryStatus,
    deliveredMs?: number,
  ): Promise<void> {
    const properties: Record<string, unknown> = { Status: { select: { name: status } } };
    if (deliveredMs && status === "Owned") {
      properties["Delivered date"] = { date: { start: isoDate(deliveredMs) } };
    }
    await withRetry(() =>
      this.notion.pages.update({
        page_id: pageId,
        properties: properties as Parameters<Client["pages"]["update"]>[0]["properties"],
      }),
    );
  }

  /** Enrich an existing row (name/amount/category/link). Status untouched. */
  async updateAccessory(pageId: string, u: AccessoryUpdate): Promise<void> {
    const properties = this.buildProps(u, false);
    if (Object.keys(properties).length === 0) return;
    await withRetry(() =>
      this.notion.pages.update({
        page_id: pageId,
        properties: properties as Parameters<Client["pages"]["update"]>[0]["properties"],
      }),
    );
  }

  private buildProps(
    u: AccessoryUpdate,
    includeStatus: boolean,
  ): Record<string, unknown> {
    const p: Record<string, unknown> = {};
    if (u.name) p.Name = { title: [{ text: { content: u.name } }] };
    if (typeof u.amount === "number") p.Amount = { number: u.amount };
    if (u.currency) p.Currency = { select: { name: u.currency } };
    if (u.category) p.Category = { select: { name: u.category } };
    if (u.orderUrl) p["Order link"] = { url: u.orderUrl };
    if (u.etaMs) p.ETA = { date: { start: isoDate(u.etaMs) } };
    if (u.deliveredMs) p["Delivered date"] = { date: { start: isoDate(u.deliveredMs) } };
    if (u.notes) p.Notes = rt(u.notes);
    if (includeStatus && u.status) p.Status = { select: { name: u.status } };
    return p;
  }
}
