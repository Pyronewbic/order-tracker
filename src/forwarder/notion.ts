import { Client } from "@notionhq/client";
import { z } from "zod";
import { withRetry } from "../retry.js";

/**
 * Status values for a forwarded package. `At Forwarder` is the only status the
 * tracker sets automatically; `Shipped`/`Received` are terminal (set by the user
 * or a one-time backfill) and the tracker never reverts them — see
 * {@link isTerminalPackageStatus}.
 */
export type PackageStatus = "At Forwarder" | "Shipped" | "Received";

/** Terminal package statuses an incoming email must never overwrite. */
export function isTerminalPackageStatus(status: string): boolean {
  return status === "Shipped" || status === "Received";
}

/** A row in the "Forwarder Packages" database, reduced to what we read. */
export interface PackageRow {
  pageId: string;
  /** Package code (title), e.g. "L". */
  code: string;
  /** Current Status select value, or "" if unset. */
  status: string;
}

/** Fields to write to a package row. Omitted fields are left unchanged. */
export interface PackageUpdate {
  status?: PackageStatus;
  arrivedMs?: number;
  from?: string;
  contents?: string;
  declaredValue?: string;
  weight?: string;
  daysLeft?: number;
  disposalByMs?: number;
}

const titleProp = z
  .object({ title: z.array(z.object({ plain_text: z.string() }).passthrough()) })
  .passthrough();

const rowSchema = z
  .object({
    id: z.string(),
    properties: z.object({
      Package: titleProp.optional(),
      Status: z
        .object({ select: z.object({ name: z.string() }).nullable() })
        .passthrough()
        .optional(),
    }),
  })
  .passthrough();

/** ISO date-only string (YYYY-MM-DD) for a Notion date property. */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function text(value: string): { rich_text: { text: { content: string } }[] } {
  return { rich_text: [{ text: { content: value } }] };
}

/**
 * Notion client for the standalone "Forwarder Packages" database. Separate from
 * the book {@link NotionClient}: a different schema, and it *creates* rows (book
 * tracking is curate/update-only), so the integration needs "Insert content".
 */
export class ForwarderNotionClient {
  private readonly notion: Client;

  constructor(
    apiKey: string,
    private readonly databaseId: string,
  ) {
    this.notion = new Client({ auth: apiKey });
  }

  /** Confirm the integration can read the database before the poll loop starts. */
  async verifyAccess(): Promise<void> {
    try {
      await withRetry(() =>
        this.notion.databases.retrieve({ database_id: this.databaseId }),
      );
    } catch (err) {
      throw new Error(
        `Cannot access forwarder database ${this.databaseId}: ${String(err)}. ` +
          `Connect the integration (••• → Connections) and grant it Read + Update + ` +
          `Insert content (Insert is required to create package rows).`,
      );
    }
  }

  /** All package rows, keyed by code. Later duplicates of a code overwrite earlier. */
  async listPackages(): Promise<Map<string, PackageRow>> {
    const byCode = new Map<string, PackageRow>();
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
        const code = (parsed.data.properties.Package?.title ?? [])
          .map((t: { plain_text: string }) => t.plain_text)
          .join("")
          .trim();
        if (!code) continue;
        byCode.set(code, {
          pageId: parsed.data.id,
          code,
          status: parsed.data.properties.Status?.select?.name ?? "",
        });
      }
      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor);

    return byCode;
  }

  /** Create a new package row for `code`; returns its page id. */
  async createPackage(code: string, update: PackageUpdate): Promise<string> {
    const properties = {
      Package: { title: [{ text: { content: code } }] },
      ...this.buildProperties(update),
    };
    const res = await withRetry(() =>
      this.notion.pages.create({
        parent: { database_id: this.databaseId },
        properties: properties as Parameters<Client["pages"]["create"]>[0]["properties"],
      }),
    );
    return res.id;
  }

  /** Update an existing package row. A no-field update is a no-op. */
  async updatePackage(pageId: string, update: PackageUpdate): Promise<void> {
    const properties = this.buildProperties(update);
    if (Object.keys(properties).length === 0) return;
    await withRetry(() =>
      this.notion.pages.update({
        page_id: pageId,
        properties: properties as Parameters<Client["pages"]["update"]>[0]["properties"],
      }),
    );
  }

  private buildProperties(update: PackageUpdate): Record<string, unknown> {
    const p: Record<string, unknown> = {};
    if (update.status) p.Status = { select: { name: update.status } };
    if (update.arrivedMs) p.Arrived = { date: { start: isoDate(update.arrivedMs) } };
    if (update.disposalByMs)
      p["Disposal by"] = { date: { start: isoDate(update.disposalByMs) } };
    if (update.from) p.From = text(update.from);
    if (update.contents) p.Contents = text(update.contents);
    if (update.declaredValue) p["Declared Value"] = text(update.declaredValue);
    if (update.weight) p.Weight = text(update.weight);
    if (typeof update.daysLeft === "number") p["Days left"] = { number: update.daysLeft };
    return p;
  }
}
