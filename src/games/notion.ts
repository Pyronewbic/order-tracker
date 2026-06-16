import { Client } from "@notionhq/client";
import { z } from "zod";
import { withRetry } from "../retry.js";
import type { GamePlatform, GameStatus } from "./parser.js";

/** A row in the "Digital Games" database, reduced to what we read. */
export interface GameRow {
  pageId: string;
  /** Stable key: `${platform}\n${title}`. */
  key: string;
  status: string;
}

/** Fields to write to a game row. Omitted fields are left unchanged. */
export interface GameUpdate {
  status?: GameStatus;
  platform?: GamePlatform;
  dateMs?: number;
  price?: string;
  device?: string;
}

const titleProp = z
  .object({ title: z.array(z.object({ plain_text: z.string() }).passthrough()) })
  .passthrough();
const selectProp = z
  .object({ select: z.object({ name: z.string() }).nullable() })
  .passthrough();

const rowSchema = z
  .object({
    id: z.string(),
    properties: z.object({
      Game: titleProp.optional(),
      Platform: selectProp.optional(),
      Status: selectProp.optional(),
    }),
  })
  .passthrough();

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function text(value: string): { rich_text: { text: { content: string } }[] } {
  return { rich_text: [{ text: { content: value } }] };
}

/** Stable de-dup key for a game: platform + cleaned title. */
export function gameKey(platform: string, title: string): string {
  return `${platform}\n${title}`;
}

/** `Purchased` is terminal: a later preorder email must not revert it. */
export function isTerminalGameStatus(status: string): boolean {
  return status === "Purchased";
}

/**
 * Notion client for the standalone "Digital Games" database. Like the forwarder
 * client it *creates* rows (needs "Insert content"), keyed by platform + title.
 */
export class GamesNotionClient {
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
        `Cannot access digital-games database ${this.databaseId}: ${String(err)}. ` +
          `Connect the integration (••• → Connections) and grant Read + Update + Insert content.`,
      );
    }
  }

  /** All rows, keyed by platform+title. */
  async listGames(): Promise<Map<string, GameRow>> {
    const byKey = new Map<string, GameRow>();
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
        const title = (parsed.data.properties.Game?.title ?? [])
          .map((t: { plain_text: string }) => t.plain_text)
          .join("")
          .trim();
        const platform = parsed.data.properties.Platform?.select?.name ?? "";
        if (!title || !platform) continue;
        byKey.set(gameKey(platform, title), {
          pageId: parsed.data.id,
          key: gameKey(platform, title),
          status: parsed.data.properties.Status?.select?.name ?? "",
        });
      }
      cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return byKey;
  }

  async createGame(title: string, update: GameUpdate): Promise<string> {
    const properties = {
      Game: { title: [{ text: { content: title } }] },
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

  async updateGame(pageId: string, update: GameUpdate): Promise<void> {
    const properties = this.buildProperties(update);
    if (Object.keys(properties).length === 0) return;
    await withRetry(() =>
      this.notion.pages.update({
        page_id: pageId,
        properties: properties as Parameters<Client["pages"]["update"]>[0]["properties"],
      }),
    );
  }

  private buildProperties(update: GameUpdate): Record<string, unknown> {
    const p: Record<string, unknown> = {};
    if (update.status) p.Status = { select: { name: update.status } };
    if (update.platform) p.Platform = { select: { name: update.platform } };
    if (update.dateMs) p.Date = { date: { start: isoDate(update.dateMs) } };
    if (update.price) p.Price = text(update.price);
    if (update.device) p.Device = text(update.device);
    return p;
  }
}
