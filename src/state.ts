import { readFile, writeFile, rename } from "node:fs/promises";
import { z } from "zod";

/** Tracking-number → Notion row link, established by retailer emails. */
const linkSchema = z.object({ pageId: z.string(), book: z.string() });

/** Per-merchant charge history used to detect recurring subscriptions. */
const subscriptionSchema = z.object({
  lastSeenMs: z.number().int().nonnegative(),
  count: z.number().int().positive(),
  lastAmount: z.string(),
});

// All fields default, so an older `{ "lastProcessedMs": N }` file still parses.
const stateSchema = z.object({
  /** Epoch ms of the newest shipping email processed. */
  lastProcessedMs: z.number().int().nonnegative().default(0),
  /** Epoch ms of the newest subscription/receipt email processed. */
  subscriptionLastMs: z.number().int().nonnegative().default(0),
  /** tracking number → linked Notion row. */
  links: z.record(z.string(), linkSchema).default({}),
  /** merchant key → charge history. */
  subscriptions: z.record(z.string(), subscriptionSchema).default({}),
});

export type State = z.infer<typeof stateSchema>;
export type SubscriptionRecord = z.infer<typeof subscriptionSchema>;

function empty(): State {
  return {
    lastProcessedMs: 0,
    subscriptionLastMs: 0,
    links: {},
    subscriptions: {},
  };
}

/** Load persisted state, returning a zeroed state if the file is absent. */
export async function loadState(file: string): Promise<State> {
  try {
    const raw = await readFile(file, "utf8");
    return stateSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw new Error(`Failed to read state file "${file}": ${String(err)}`);
  }
}

/** Persist state atomically (write temp + rename) to avoid torn writes. */
export async function saveState(file: string, state: State): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, file);
}
