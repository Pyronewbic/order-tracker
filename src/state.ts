import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeFileAtomic } from "./fsutil.js";

/** Tracking-number → Notion row link, established by retailer emails. */
const linkSchema = z.object({ pageId: z.string(), book: z.string() });

/** Per-merchant charge history used to detect recurring subscriptions. */
const subscriptionSchema = z.object({
  lastSeenMs: z.number().int().nonnegative(),
  count: z.number().int().positive(),
  lastAmount: z.string(),
});

/** Per-account watermarks. All fields default so a partial record still parses. */
const accountWatermarkSchema = z.object({
  /** Epoch ms of the newest shipping email processed for this account. */
  lastProcessedMs: z.number().int().nonnegative().default(0),
  /** Epoch ms of the newest subscription/receipt email processed. */
  subscriptionLastMs: z.number().int().nonnegative().default(0),
  /** Epoch ms of the newest forwarder (ForwardMe) email processed. */
  forwarderLastMs: z.number().int().nonnegative().default(0),
  /** Epoch ms of the newest digital-game email processed. */
  gamesLastMs: z.number().int().nonnegative().default(0),
});

// Every field defaults, and the legacy top-level timestamps are folded into the
// "default" account, so an older single-account state.json migrates cleanly.
const stateSchema = z
  .object({
    // Legacy single-account fields (pre multi-account); read only to migrate.
    lastProcessedMs: z.number().int().nonnegative().optional(),
    subscriptionLastMs: z.number().int().nonnegative().optional(),
    /** label → watermarks. */
    accounts: z.record(z.string(), accountWatermarkSchema).default({}),
    /** tracking number → linked Notion row (global; cross-account dedup). */
    links: z.record(z.string(), linkSchema).default({}),
    /** merchant key → charge history (global). */
    subscriptions: z.record(z.string(), subscriptionSchema).default({}),
  })
  .transform((s) => {
    const accounts = { ...s.accounts };
    // Migrate a legacy single-account file: seed "default" from the old
    // top-level watermarks so existing users don't reprocess their whole inbox.
    if (
      Object.keys(accounts).length === 0 &&
      (s.lastProcessedMs || s.subscriptionLastMs)
    ) {
      accounts.default = {
        lastProcessedMs: s.lastProcessedMs ?? 0,
        subscriptionLastMs: s.subscriptionLastMs ?? 0,
        forwarderLastMs: 0,
        gamesLastMs: 0,
      };
    }
    return { accounts, links: s.links, subscriptions: s.subscriptions };
  });

export type State = z.infer<typeof stateSchema>;
export type AccountWatermark = z.infer<typeof accountWatermarkSchema>;
export type SubscriptionRecord = z.infer<typeof subscriptionSchema>;

function empty(): State {
  return { accounts: {}, links: {}, subscriptions: {} };
}

/**
 * Return the watermark record for `label`, lazily creating a zeroed one on
 * first use. Mutating the returned object advances that account's watermarks in
 * place; `saveState` then persists them.
 */
export function accountState(state: State, label: string): AccountWatermark {
  let rec = state.accounts[label];
  if (!rec) {
    rec = { lastProcessedMs: 0, subscriptionLastMs: 0, forwarderLastMs: 0, gamesLastMs: 0 };
    state.accounts[label] = rec;
  }
  return rec;
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

/** Persist state atomically (temp + rename) with owner-only permissions. */
export async function saveState(file: string, state: State): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(state, null, 2));
}
