import type { RuntimeConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { accountState, type State } from "./state.js";
import {
  GmailClient,
  type ParsedMessage,
} from "./gmail/client.js";
import { buildUpdate, parseMessage, type ShipmentUpdate } from "./gmail/parser.js";
import type { LlmClassification, LlmParser } from "./gmail/llm-parser.js";
import { NotionClient, type OrderRow } from "./notion/client.js";
import { matchRow } from "./notion/matcher.js";
import { parseCharge } from "./subscriptions/parser.js";
import { classifyCharge } from "./subscriptions/tracker.js";
import type { Notifier } from "./telegram/client.js";
import { isTerminalStatus, statusRank } from "./types.js";

/** Shared collaborators for a poll. Built once at startup, reused every tick. */
export interface Deps {
  cfg: RuntimeConfig;
  notion: NotionClient;
  notifier: Notifier;
  log: Logger;
  /** Optional LLM fallback; null when disabled (opt-out or no API key). */
  llm: LlmParser | null;
}

/** Mutable per-tick accumulators: shared Notion rows + cross-account counters. */
interface TickContext {
  rows: OrderRow[];
  rowsById: Map<string, OrderRow>;
  /** Notion updates applied this tick (for the update-cap alarm). */
  updates: number;
  /** LLM calls made this tick across ALL accounts (for the per-tick cap). */
  llmCalls: number;
  /** Whether the one-shot LLM-cap alert has already fired this tick. */
  llmCapAlerted: boolean;
}

/** Summary of what a tick did (used by callers/tests). */
export interface TickStats {
  updates: number;
  llmCalls: number;
}

/** Fetch messages newer than `sinceMs`, oldest first, for a given query. */
export async function fetchNewMessages(
  gmail: GmailClient,
  query: string,
  sinceMs: number,
  log?: Logger,
  label?: string,
): Promise<ParsedMessage[]> {
  // Gmail's `after:` is second-resolution; subtract 1s to avoid an off-by-one
  // miss, then de-dup precisely against the stored millisecond timestamp.
  const afterSec = sinceMs > 0 ? Math.floor(sinceMs / 1000) - 1 : undefined;
  const ids = await gmail.listMessageIds(query, afterSec);
  if (ids.length === 0) return [];

  // allSettled so one un-fetchable message (malformed/oversized, a transient
  // error) can't wedge the whole inbox — failures are skipped and retried next
  // tick once newer mail advances the watermark past them.
  const settled = await Promise.allSettled(ids.map((id) => gmail.getMessage(id)));
  const fetched: ParsedMessage[] = [];
  let failures = 0;
  for (const r of settled) {
    if (r.status === "fulfilled") fetched.push(r.value);
    else failures++;
  }
  if (failures > 0 && log) {
    await log.warn(
      `${label ? `[${label}] ` : ""}Skipped ${failures} message(s) that failed to fetch; will retry next tick.`,
    );
  }

  return fetched
    .filter((m) => m.internalDateMs > sinceMs)
    .sort((a, b) => a.internalDateMs - b.internalDateMs);
}

/**
 * Decide what to do with a status transition (current → new):
 *  - "noop": same status — skip.
 *  - "regress": the new status can't supersede the current one — skip + log.
 *  - "apply": the new status should be written.
 *
 * Rules: Cancelled/Returned are terminal (nothing supersedes them) but can be
 * set from any non-terminal state (incl. Delivered → Returned). Delayed can be
 * set from any active state but not after Delivered (stale), and any progress
 * update supersedes a Delayed. The remaining four form a monotonic ladder
 * (Ordered < In Transit < Arriving Soon < Delivered) that can only advance.
 */
export function planUpdate(
  row: OrderRow,
  update: ShipmentUpdate,
): "noop" | "regress" | "apply" {
  const cur = row.status;
  const next = update.status;
  if (next === cur) return "noop";
  if (isTerminalStatus(cur)) return "regress"; // terminal — nothing supersedes
  if (isTerminalStatus(next)) return "apply"; // cancel/return from any live state
  if (next === "Delayed") return cur === "Delivered" ? "regress" : "apply";
  if (cur === "Delayed") return "apply"; // any progress supersedes a delay
  // Both on the progress ladder (cur may be ""/unknown → rank 0).
  return statusRank(next) > statusRank(cur) ? "apply" : "regress";
}

/**
 * Run one poll across all accounts: fetch Notion rows once, then process each
 * account's shipping + subscription jobs sequentially with per-job failure
 * isolation. Returns per-tick counters. Does NOT load or persist state — the
 * caller owns that so a single state file is written once per tick.
 */
export async function runTick(
  deps: Deps,
  gmailByLabel: Map<string, GmailClient>,
  state: State,
): Promise<TickStats> {
  const { cfg, notion, notifier, log } = deps;

  const rows = await notion.listRows();
  const ctx: TickContext = {
    rows,
    rowsById: new Map(rows.map((r) => [r.pageId, r])),
    updates: 0,
    llmCalls: 0,
    llmCapAlerted: false,
  };

  for (const [label, gmail] of gmailByLabel) {
    try {
      await runShipping(label, gmail, deps, ctx, state);
    } catch (err) {
      await log.error(`[${label}] shipping job failed: ${String(err)}`);
    }
    try {
      await runSubscriptions(label, gmail, deps, ctx, state);
    } catch (err) {
      await log.error(`[${label}] subscription job failed: ${String(err)}`);
    }
  }

  // Soft alarm (not a hard stop): an unusually large tick likely means a
  // misconfigured query. A legitimate first-run backlog still completes.
  if (ctx.updates > cfg.MAX_UPDATES_PER_TICK) {
    await log.warn(
      `Applied ${ctx.updates} updates this tick (> ${cfg.MAX_UPDATES_PER_TICK}); possible query misconfiguration.`,
    );
    await notifier.notify(
      `⚠️ Order tracker applied ${ctx.updates} updates in one tick ` +
        `(cap ${cfg.MAX_UPDATES_PER_TICK}). Check your shipping query if this is unexpected.`,
    );
  }

  return { updates: ctx.updates, llmCalls: ctx.llmCalls };
}

/** Shipping job for one account: match emails to rows and push status updates. */
async function runShipping(
  label: string,
  gmail: GmailClient,
  deps: Deps,
  ctx: TickContext,
  state: State,
): Promise<void> {
  const { cfg, log } = deps;
  const watermark = accountState(state, label);

  const messages = await fetchNewMessages(
    gmail,
    cfg.GMAIL_QUERY,
    watermark.lastProcessedMs,
    log,
    label,
  );
  if (messages.length === 0) {
    await log.info(`[${label}] No new shipping messages.`);
    return;
  }
  await log.info(`[${label}] Processing ${messages.length} shipping message(s).`);

  for (const msg of messages) {
    // Advance the watermark BEFORE any branch, skip, LLM call, or failure, so a
    // message is processed at most once ever — including negative LLM verdicts,
    // which must never trigger a second paid call on a later tick.
    watermark.lastProcessedMs = Math.max(
      watermark.lastProcessedMs,
      msg.internalDateMs,
    );

    let update = parseMessage(msg);
    if (!update) {
      // Status gap: the regex couldn't classify this email — ask the LLM.
      if (!deps.llm) {
        await log.warn(`[${label}] Skipped (no status; LLM off): "${msg.subject}".`);
        continue;
      }
      const cls = await callLlm(label, msg, deps, ctx);
      if (!cls) continue; // dry-run / capped / error (already logged)
      if (!cls.isShipping || !cls.status) {
        await log.info(`[${label}] LLM: not an order/shipment: "${msg.subject}".`);
        continue;
      }
      update = buildUpdate(msg, cls.status, cls.itemName ?? undefined);
      if (!update.category && cls.category) update.category = cls.category;
      update.tags = mergeTags(update.tags, cls.tags);
    } else if (deps.llm && !update.category && !cfg.DRY_RUN) {
      // Classification gap: a status was found but the item couldn't be typed —
      // let the LLM fill category + tags (gaps only, bounded by the per-tick cap).
      const cls = await callLlm(label, msg, deps, ctx);
      if (cls) {
        if (cls.category) update.category = cls.category;
        update.tags = mergeTags(update.tags, cls.tags);
      }
    }

    const row = resolveRow(label, update, ctx, state, cfg.MATCH_THRESHOLD);
    if (!row) {
      const ident =
        update.itemName ||
        `${update.carrier} ${update.trackingNumbers.join(", ") || "(no tracking #)"}`;
      // Digital goods (codes/downloads) have no shipment to track — log them as
      // info instead of a "no match" warning so they don't read as a problem.
      if (update.category === "Digital") {
        await log.info(`[${label}] Digital order, not tracked: "${msg.subject}".`);
      } else {
        await log.warn(`[${label}] No Notion match for ${ident} (subject: "${msg.subject}").`);
      }
      continue;
    }

    await applyShipmentUpdate(label, row, update, deps, ctx);
  }
}

/**
 * Resolve a {@link ShipmentUpdate} to a Notion row. Primary: fuzzy-match the
 * item name and, on success, record this update's tracking numbers so later
 * carrier-only emails (from any account) resolve to the same row. Fallback:
 * resolve via a previously-recorded tracking link.
 */
function resolveRow(
  label: string,
  update: ShipmentUpdate,
  ctx: TickContext,
  state: State,
  threshold: number,
): OrderRow | undefined {
  let row: OrderRow | undefined;

  if (update.itemName) {
    const match = matchRow(update.itemName, ctx.rows, threshold);
    if (match) {
      row = match.row;
      for (const tn of update.trackingNumbers) {
        state.links[tn] = { pageId: row.pageId, book: row.book };
      }
    }
  }

  if (!row) {
    for (const tn of update.trackingNumbers) {
      const link = state.links[tn];
      if (link) {
        row = ctx.rowsById.get(link.pageId);
        if (row) break;
      }
    }
  }

  return row;
}

/** Apply (or skip) a resolved update, enforcing the runtime guardrails. */
async function applyShipmentUpdate(
  label: string,
  row: OrderRow,
  update: ShipmentUpdate,
  deps: Deps,
  ctx: TickContext,
): Promise<void> {
  const { cfg, notion, notifier, log } = deps;

  const decision = planUpdate(row, update);
  const willSetStatus = decision === "apply";
  // Backfill category only when detected and the row has none (never overwrite a
  // manual value). Tags merge in — keep existing, add only the new ones.
  const categoryToSet = update.category && !row.category ? update.category : undefined;
  const newTags = update.tags.filter((t) => !row.tags.includes(t));
  const tagsToSet = newTags.length > 0 ? [...row.tags, ...newTags] : undefined;

  if (decision === "regress") {
    await log.warn(
      `[${label}] Skipped regression for "${row.book}": ${row.status || "(unset)"} ✗→ ${update.status}.`,
    );
  } else if (decision === "noop" && !categoryToSet && !tagsToSet) {
    await log.info(`[${label}] No change: "${row.book}" already ${update.status}.`);
  }

  if (!willSetStatus && !categoryToSet && !tagsToSet) return; // nothing to write

  if (cfg.DRY_RUN) {
    const parts: string[] = [];
    if (willSetStatus) parts.push(`status → ${update.status}`);
    if (categoryToSet) parts.push(`category → ${categoryToSet}`);
    if (tagsToSet) parts.push(`+tags [${newTags.join(", ")}]`);
    await log.info(`[${label}] [dry-run] would set "${row.book}": ${parts.join(", ")}.`);
    return;
  }

  try {
    await notion.applyUpdate(row, {
      status: willSetStatus ? update.status : undefined,
      category: categoryToSet,
      tags: tagsToSet,
    });
    ctx.updates++;
    if (willSetStatus) {
      // Reflect the write in the in-memory row so later messages this tick see
      // the new status (keeps the no-op / regression guards accurate per tick).
      row.status = update.status;
      await log.change(row.book, update.status, update.detail, label);
      await notifier.notifyStatusChange(row.book, update.status, update.detail, label);
    }
    if (categoryToSet) row.category = categoryToSet;
    if (tagsToSet) row.tags = tagsToSet;
    if (!willSetStatus) {
      const bits: string[] = [];
      if (categoryToSet) bits.push(`category ${categoryToSet}`);
      if (newTags.length) bits.push(`tags [${newTags.join(", ")}]`);
      if (bits.length) await log.info(`[${label}] Tagged "${row.book}": ${bits.join("; ")}.`);
    }
  } catch (err) {
    await log.error(`[${label}] Failed updating "${row.book}": ${String(err)}`);
  }
}

/** Union of two tag lists, de-duplicated, order-stable. */
function mergeTags(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Make one gated LLM call. Returns the classification, or null when the call was
 * skipped (dry-run / per-tick cap) or errored — all logged. The caller must
 * have already confirmed `deps.llm` is set. Enforces the cost/blast-radius
 * controls: skipped in dry-run, and a per-tick cap counted across all accounts
 * (the watermark has already advanced, so a skipped message is never retried).
 */
async function callLlm(
  label: string,
  msg: ParsedMessage,
  deps: Deps,
  ctx: TickContext,
): Promise<LlmClassification | null> {
  const { cfg, log, llm, notifier } = deps;
  if (!llm) return null;

  if (cfg.DRY_RUN) {
    await log.info(`[${label}] [dry-run] LLM call skipped for "${msg.subject}".`);
    return null;
  }

  if (ctx.llmCalls >= cfg.MAX_LLM_CALLS_PER_TICK) {
    if (!ctx.llmCapAlerted) {
      ctx.llmCapAlerted = true;
      await log.warn(`LLM call cap (${cfg.MAX_LLM_CALLS_PER_TICK}/tick) reached; skipping further LLM calls this tick.`);
      await notifier.notify(
        `⚠️ Order tracker hit the LLM cap (${cfg.MAX_LLM_CALLS_PER_TICK}/tick). ` +
          `Remaining unclassified mail was skipped — check your shipping query.`,
      );
    }
    await log.info(`[${label}] LLM cap reached; skipping: "${msg.subject}".`);
    return null;
  }

  // Count the attempt before the call, so an error still consumes cap budget.
  ctx.llmCalls++;
  try {
    return await llm.classify(msg);
  } catch (err) {
    await log.error(`[${label}] LLM error for "${msg.subject}": ${String(err)}`);
    return null;
  }
}

/** Subscription job for one account: scan receipt mail, alert on charges. */
async function runSubscriptions(
  label: string,
  gmail: GmailClient,
  deps: Deps,
  _ctx: TickContext,
  state: State,
): Promise<void> {
  const { cfg, notifier, log } = deps;
  if (!cfg.SUBSCRIPTION_QUERY) return;

  const watermark = accountState(state, label);
  const messages = await fetchNewMessages(
    gmail,
    cfg.SUBSCRIPTION_QUERY,
    watermark.subscriptionLastMs,
    log,
    label,
  );
  if (messages.length === 0) {
    await log.info(`[${label}] No new receipt messages.`);
    return;
  }
  await log.info(`[${label}] Scanning ${messages.length} receipt message(s).`);

  for (const msg of messages) {
    watermark.subscriptionLastMs = Math.max(
      watermark.subscriptionLastMs,
      msg.internalDateMs,
    );

    const charge = parseCharge(msg);
    if (!charge) continue;

    const verdict = classifyCharge(
      charge,
      state.subscriptions[charge.merchant.toLowerCase()],
      msg.internalDateMs,
    );
    state.subscriptions[verdict.key] = verdict.record;

    if (verdict.alert) {
      await log.info(`[${label}] Charge alert: ${charge.merchant} ${charge.amount}`);
      // In dry-run the notifier logs instead of sending (DryRunNotifier).
      await notifier.notify(verdict.alert);
    }
  }
}
