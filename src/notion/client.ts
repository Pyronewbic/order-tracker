import { Client } from "@notionhq/client";
import { z } from "zod";
import type { OrderCategory, OrderStatus } from "../types.js";
import { withRetry } from "../retry.js";

/** A Notion database row reduced to the fields this tracker reads. */
export interface OrderRow {
  pageId: string;
  /** Plain-text value of the "Book" title property. */
  book: string;
  /** Current plain-text value of the "Notes" rich-text property. */
  notes: string;
  /** Current "Status" select value, or "" if unset. */
  status: string;
  /** Current "Category" select value, or "" if unset/absent. */
  category: string;
}

/** A page update: set the status (with a Notes line) and/or the category. */
export interface RowUpdate {
  status?: OrderStatus;
  category?: OrderCategory;
  detail: string;
  at: Date;
}

// Notion's API responses are loosely typed; validate the slice we depend on.
const richTextItem = z.object({ plain_text: z.string() }).passthrough();

const pageSchema = z
  .object({
    id: z.string(),
    properties: z.object({
      Book: z
        .object({ title: z.array(richTextItem) })
        .passthrough()
        .optional(),
      Notes: z
        .object({ rich_text: z.array(richTextItem) })
        .passthrough()
        .optional(),
      Status: z
        .object({ select: z.object({ name: z.string() }).nullable() })
        .passthrough()
        .optional(),
      Category: z
        .object({ select: z.object({ name: z.string() }).nullable() })
        .passthrough()
        .optional(),
    }),
  })
  .passthrough();

const NOTE_CHUNK = 1900; // Notion caps a single rich-text item at 2000 chars.

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
          notes: plain(props.Notes?.rich_text),
          status: props.Status?.select?.name ?? "",
          category: props.Category?.select?.name ?? "",
        });
      }

      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor);

    return rows;
  }

  /**
   * Apply a {@link RowUpdate}: when `status` is set, update Status and prepend a
   * timestamped line to Notes (latest first, previous text preserved); when
   * `category` is set, update Category. A no-field update is a no-op.
   */
  async applyUpdate(row: OrderRow, update: RowUpdate): Promise<void> {
    const properties: Record<string, unknown> = {};

    if (update.status) {
      const line = `[${update.at.toISOString()}] ${update.status} — ${update.detail}`;
      const combined = row.notes ? `${line}\n${row.notes}` : line;
      properties.Status = { select: { name: update.status } };
      properties.Notes = { rich_text: toRichText(combined) };
    }
    if (update.category) {
      properties.Category = { select: { name: update.category } };
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

/** Split text into <=2000-char rich-text items so Notion accepts it. */
function toRichText(text: string): { text: { content: string } }[] {
  const clipped = text.slice(0, NOTE_CHUNK * 5); // keep notes from growing unbounded
  const chunks: { text: { content: string } }[] = [];
  for (let i = 0; i < clipped.length; i += NOTE_CHUNK) {
    chunks.push({ text: { content: clipped.slice(i, i + NOTE_CHUNK) } });
  }
  return chunks.length ? chunks : [{ text: { content: "" } }];
}
