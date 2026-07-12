import { Client } from "@notionhq/client";
import { z } from "zod";
import type { OrderCategory, OrderStatus } from "../types.js";
import { withRetry } from "../retry.js";
import { fromNotionStatus, toNotionStatus } from "./status-map.js";

/** A Notion database row reduced to the fields this tracker reads. */
export interface OrderRow {
  pageId: string;
  /** Plain-text value of the "Book" title property. */
  book: string;
  /** Current "Status" select value, or "" if unset. */
  status: string;
  /** Current "Category" select value, or "" if unset/absent. */
  category: string;
  /** Current "Tags" multi-select values (names), or [] if unset/absent. */
  tags: string[];
  /** Current "ETA" date (ISO `YYYY-MM-DD`), or "" if unset. A non-empty value is
   * treated as authoritative — the tracker never overwrites it. */
  eta: string;
}

/** A page update: set any of Status, Category, Tags, ETA, Delivered-on. */
export interface RowUpdate {
  status?: OrderStatus;
  category?: OrderCategory;
  /** Full desired tag set (the caller has already merged with existing tags). */
  tags?: string[];
  /** Delivery ETA to write (epoch ms → date-only). */
  etaMs?: number;
  /** Actual delivered-on date to write (epoch ms → date-only). */
  deliveredMs?: number;
}

// Notion's API responses are loosely typed; validate the slice we depend on.
const richTextItem = z.object({ plain_text: z.string() }).passthrough();
const selectValue = z
  .object({ select: z.object({ name: z.string() }).nullable() })
  .passthrough();

const dateValue = z
  .object({ date: z.object({ start: z.string() }).nullable() })
  .passthrough();

const pageSchema = z
  .object({
    id: z.string(),
    properties: z.object({
      Book: z
        .object({ title: z.array(richTextItem) })
        .passthrough()
        .optional(),
      Status: selectValue.optional(),
      Category: selectValue.optional(),
      Tags: z
        .object({ multi_select: z.array(z.object({ name: z.string() }).passthrough()) })
        .passthrough()
        .optional(),
      ETA: dateValue.optional(),
    }),
  })
  .passthrough();

/** ISO date-only string (YYYY-MM-DD) for a Notion date property. */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class NotionClient {
  private readonly notion: Client;

  constructor(
    apiKey: string,
    private readonly databaseId: string,
  ) {
    this.notion = new Client({ auth: apiKey });
  }

  /**
   * Confirm the integration can read the database before the poll loop starts.
   * Surfaces a misconfiguration (integration not connected, or lacking the
   * Read/Update content capabilities) as a clear, actionable error instead of a
   * cryptic failure on the first tick.
   */
  async verifyAccess(): Promise<void> {
    try {
      await withRetry(() =>
        this.notion.databases.retrieve({ database_id: this.databaseId }),
      );
    } catch (err) {
      throw new Error(
        `Cannot access Notion database ${this.databaseId}: ${String(err)}. ` +
          `Connect the integration to the database (••• → Connections) and grant ` +
          `it "Read content" + "Update content" (no Insert/Delete or user info needed).`,
      );
    }
  }

  /** Fetch every row in the database (following pagination). */
  async listRows(): Promise<OrderRow[]> {
    const rows: OrderRow[] = [];
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
        const parsed = pageSchema.safeParse(raw);
        if (!parsed.success) continue; // skip non-page results defensively
        const props = parsed.data.properties;
        rows.push({
          pageId: parsed.data.id,
          book: plain(props.Book?.title),
          status: fromNotionStatus(props.Status?.select?.name ?? ""),
          category: props.Category?.select?.name ?? "",
          tags: (props.Tags?.multi_select ?? []).map((t) => t.name),
          eta: props.ETA?.date?.start ?? "",
        });
      }

      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor);

    return rows;
  }

  /**
   * Apply a {@link RowUpdate}: set any of Status, Category, and Tags. `tags`, if
   * given, is written as the complete multi-select value (the caller merges with
   * the row's existing tags). A no-field update is a no-op.
   */
  async applyUpdate(row: OrderRow, update: RowUpdate): Promise<void> {
    const properties: Record<string, unknown> = {};
    if (update.status) {
      // Skip Status when the target DB has no equivalent (toNotionStatus → null),
      // so a shipment-only status never auto-creates a junk option on a curated DB.
      const notionStatus = toNotionStatus(update.status);
      if (notionStatus) properties.Status = { select: { name: notionStatus } };
    }
    if (update.category) properties.Category = { select: { name: update.category } };
    if (update.tags && update.tags.length > 0) {
      properties.Tags = { multi_select: update.tags.map((name) => ({ name })) };
    }
    if (update.etaMs) properties.ETA = { date: { start: isoDate(update.etaMs) } };
    // "Delivered on" must exist on the DB — Notion rejects an unknown property
    // key — so it is provisioned as a documented column on the Collection DB.
    if (update.deliveredMs) {
      properties["Delivered on"] = { date: { start: isoDate(update.deliveredMs) } };
    }
    if (Object.keys(properties).length === 0) return;

    await withRetry(() =>
      this.notion.pages.update({
        page_id: row.pageId,
        properties: properties as Parameters<Client["pages"]["update"]>[0]["properties"],
      }),
    );
  }
}

function plain(items: { plain_text: string }[] | undefined): string {
  return (items ?? []).map((i) => i.plain_text).join("");
}
