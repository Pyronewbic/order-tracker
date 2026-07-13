import type { RuntimeConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { accountState, type State } from "./state.js";
import { GmailClient, type ParsedMessage } from "./gmail/client.js";
import { buildUpdate, parseMessage, type ShipmentUpdate } from "./gmail/parser.js";
import type { LlmClassification, LlmParser } from "./gmail/llm-parser.js";
import { NotionClient, type OrderRow } from "./notion/client.js";
import { matchRow } from "./notion/matcher.js";
import { isProtectedStatus, toNotionStatus } from "./notion/status-map.js";
import {
  isTerminalPackageStatus,
  type ForwarderNotionClient,
  type PackageUpdate,
} from "./forwarder/notion.js";
import { parseForwarderEmail, type ForwarderEvent } from "./forwarder/parser.js";
import {
  gameKey,
  isTerminalGameStatus,
  type GamesNotionClient,
  type GameUpdate,
} from "./games/notion.js";
import { parseGameEmail } from "./games/parser.js";
import { currencyFor } from "./games/fx.js";
import { parseAmount, toUSD } from "./money/fx.js";
import type { SpendSummary } from "./summary/notion.js";
import { parseOrderEmail, GENERAL_LLM_CATEGORIES } from "./general/parser.js";
import type { GeneralNotionClient, GeneralUpdate, GeneralRow } from "./general/notion.js";
import {
  parseLifecycleEmail,
  planGeneralUpdate,
  type GeneralStatus,
} from "./general/lifecycle.js";
import { parseEbayOrder, parseEbayLifecycle } from "./general/ebay.js";
import { parseShopifyOrder } from "./general/shopify.js";
import { classifyItem, techAccessoryCategory } from "./categorize.js";
import {
  accessoryStatusFromGeneral,
  accessoryStatusFromShipment,
  planAccessoryUpdate,
  type AccessoriesNotionClient,
  type AccessoryRow,
  type AccessoryStatus,
  type AccessoryUpdate,
} from "./accessories/notion.js";
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
  /** Optional forwarder (ForwardMe) tracking; null when disabled. */
  forwarder: ForwarderNotionClient | null;
  /** Optional digital-game tracking; null when disabled. */
  games: GamesNotionClient | null;
  /** Optional cross-DB spend summary; null when disabled. */
  summary: SpendSummary | null;
  /** Optional general-purchases tracking; null when disabled. */
  general: GeneralNotionClient | null;
  /** Optional tech-accessory tracking (Tech Inventory Accessories DB); null off. */
  accessories: AccessoriesNotionClient | null;
}

/** Mutable per-tick accumulators: shared Notion rows + cross-account counters. */
interface TickContext {
  rows: OrderRow[];
  rowsById: Map<string, OrderRow>;
  /** General-purchases order map (order # → row), loaded once per tick and
   * shared so the shipping fallback and the general passes dedup against one
   * map (empty when the general DB is disabled). */
  generalOrders: Map<string, GeneralRow>;
  /** Tech-accessory order map (order # → row), loaded once per tick; shared so
   * the shipping/confirmation/lifecycle passes dedup (empty when off). */
  accessoryOrders: Map<string, AccessoryRow>;
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
  // User-managed lifecycle states (e.g. To Reorder / To Sell) are owned by the
  // human — a shipment email must never overwrite them.
  if (isProtectedStatus(cur)) return "regress";
  if (isTerminalStatus(cur)) return "regress"; // terminal — nothing supersedes
  if (isTerminalStatus(next)) return "apply"; // cancel/return from any live state
  if (next === "Delayed") return cur === "Delivered" ? "regress" : "apply";
  if (cur === "Delayed") return "apply"; // any progress supersedes a delay
  // Both on the progress ladder (cur may be ""/unknown → rank 0).
  return statusRank(next) > statusRank(cur) ? "apply" : "regress";
}

// Accounts we've already alerted about an auth failure, so the daily-recurring
// invalid_grant doesn't fire a Telegram ping every tick. Cleared per account on
// its next successful poll. Module-scoped so it persists across ticks.
const authAlerted = new Set<string>();

/** A Gmail-auth failure (expired/revoked refresh token), vs a transient error. */
function isAuthError(err: unknown): boolean {
  return /invalid_grant|invalid_client|unauthorized|\b401\b/i.test(String(err));
}

/** Alert once (log + Telegram) that an account's Gmail token needs re-auth. */
async function alertAuthOnce(label: string, err: unknown, deps: Deps): Promise<void> {
  const { log, notifier } = deps;
  if (authAlerted.has(label)) {
    await log.error(`[${label}] Gmail auth still failing; account skipped this tick.`);
    return;
  }
  authAlerted.add(label);
  await log.error(
    `[${label}] Gmail auth failed (token expired or revoked): ${String(err)}`,
  );
  await notifier.notify(
    `🔒 Order tracker: Gmail auth failed for "${label}". ` +
      `Re-authorize with \`npm run auth -- ${label}\`.`,
  );
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
    generalOrders: new Map(),
    accessoryOrders: new Map(),
    updates: 0,
    llmCalls: 0,
    llmCapAlerted: false,
  };

  // Load the general order map once per tick, shared across accounts and passes:
  // the shipping fallback (E3) and the three general passes upsert into it.
  if (deps.general) {
    try {
      ctx.generalOrders = await deps.general.listOrders();
    } catch (err) {
      await log.error(`Failed to load general orders: ${String(err)}`);
    }
  }
  // Same for the tech-accessory order map (Tech Inventory Accessories DB).
  if (deps.accessories) {
    try {
      ctx.accessoryOrders = await deps.accessories.listByOrder();
    } catch (err) {
      await log.error(`Failed to load accessories: ${String(err)}`);
    }
  }

  for (const [label, gmail] of gmailByLabel) {
    try {
      await runShipping(label, gmail, deps, ctx, state);
      authAlerted.delete(label); // a successful poll clears any prior auth alert
    } catch (err) {
      if (isAuthError(err)) {
        // A dead/expired token fails every job for this account identically, and
        // silently ("0 updates"). Alert once and skip the rest of its jobs.
        await alertAuthOnce(label, err, deps);
        continue;
      }
      await log.error(`[${label}] shipping job failed: ${String(err)}`);
    }
    try {
      await runSubscriptions(label, gmail, deps, ctx, state);
    } catch (err) {
      await log.error(`[${label}] subscription job failed: ${String(err)}`);
    }
    try {
      await runForwarder(label, gmail, deps, state);
    } catch (err) {
      await log.error(`[${label}] forwarder job failed: ${String(err)}`);
    }
    try {
      await runGames(label, gmail, deps, state);
    } catch (err) {
      await log.error(`[${label}] games job failed: ${String(err)}`);
    }
    try {
      await runGeneral(label, gmail, deps, ctx, state);
    } catch (err) {
      await log.error(`[${label}] general job failed: ${String(err)}`);
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

  // Cross-DB spend summary runs once per tick (not per account), after all rows
  // are written. Isolated so a summary failure never affects the main poll.
  if (deps.summary) {
    try {
      await deps.summary.recompute(log, cfg.DRY_RUN);
    } catch (err) {
      await log.error(`Spend summary failed: ${String(err)}`);
    }
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
    let update = parseMessage(msg);

    // Cap-aware deferral: a message that needs the LLM merely to be *classified*
    // (the regex found no status) is lost if we advance the watermark past it
    // while the per-tick LLM cap is spent. When the cap is exhausted, stop here
    // WITHOUT advancing — the backlog resumes next tick over a few ticks. (Only
    // the status-gap case; a classification-only gap still records the status,
    // so losing its category to the cap is acceptable.)
    if (
      !update &&
      deps.llm &&
      !cfg.DRY_RUN &&
      ctx.llmCalls >= cfg.MAX_LLM_CALLS_PER_TICK
    ) {
      await log.warn(
        `[${label}] LLM cap reached; deferring "${msg.subject}" and the rest to next tick.`,
      );
      break;
    }

    // Advance the watermark BEFORE any branch, skip, LLM call, or failure, so a
    // message is processed at most once ever — including negative LLM verdicts,
    // which must never trigger a second paid call on a later tick.
    watermark.lastProcessedMs = Math.max(watermark.lastProcessedMs, msg.internalDateMs);

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
      // E3: capture an unmatched non-book item in the General DB before dropping.
      if (await routeToGeneral(label, msg, update, deps, ctx)) continue;
      const ident =
        update.itemName ||
        `${update.carrier} ${update.trackingNumbers.join(", ") || "(no tracking #)"}`;
      // Digital goods (codes/downloads) have no shipment to track — log them as
      // info instead of a "no match" warning so they don't read as a problem.
      if (update.category === "Digital") {
        await log.info(`[${label}] Digital order, not tracked: "${msg.subject}".`);
      } else {
        await log.warn(
          `[${label}] No Notion match for ${ident} (subject: "${msg.subject}").`,
        );
      }
      continue;
    }

    await applyShipmentUpdate(label, row, update, deps, ctx);
  }
}

/**
 * Resolve a {@link ShipmentUpdate} to a Notion row. Primary: fuzzy-match the
 * item name and, on success, record this update's tracking numbers AND order
 * number so later title-less emails (a carrier update, or Amazon IN's
 * "Delivered: 1 item | Order # …") resolve to the same row. Fallback: resolve
 * via a previously-recorded tracking-number or order-number link.
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
      const link = { pageId: row.pageId, book: row.book };
      for (const tn of update.trackingNumbers) state.links[tn] = link;
      if (update.orderId) state.orderLinks[update.orderId] = link;
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

  // Last resort: a title-less update (e.g. Amazon IN "Delivered … Order # …")
  // resolves via the order-number link a prior titled email established.
  if (!row && update.orderId) {
    const link = state.orderLinks[update.orderId];
    if (link) row = ctx.rowsById.get(link.pageId);
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
  // A status the target DB has no option for (toNotionStatus → null) can't be
  // written; treat it as not-applied so we don't falsely log/notify a change.
  const statusWritable = toNotionStatus(update.status) !== null;
  const willSetStatus = decision === "apply" && statusWritable;
  // Backfill category only when detected and the row has none (never overwrite a
  // manual value). Tags merge in — keep existing, add only the new ones.
  const categoryToSet = update.category && !row.category ? update.category : undefined;
  const newTags = update.tags.filter((t) => !row.tags.includes(t));
  const tagsToSet = newTags.length > 0 ? [...row.tags, ...newTags] : undefined;
  // ETA: write a parsed ETA only when the row has none — an existing/manual ETA
  // is authoritative and never overwritten. Never on a Delivered email.
  const etaToSet =
    update.etaMs && !row.eta && update.status !== "Delivered" ? update.etaMs : undefined;
  // Delivered-on: stamp the email's date on the transition into Delivered.
  const deliveredToSet =
    update.status === "Delivered" && decision === "apply"
      ? update.deliveredMs
      : undefined;
  const nothingElse = !categoryToSet && !tagsToSet && !etaToSet && !deliveredToSet;

  if (decision === "regress") {
    await log.warn(
      `[${label}] Skipped regression for "${row.book}": ${row.status || "(unset)"} ✗→ ${update.status}.`,
    );
  } else if (decision === "apply" && !statusWritable && nothingElse) {
    await log.info(
      `[${label}] No DB status for "${update.status}"; left "${row.book}" unchanged.`,
    );
  } else if (decision === "noop" && nothingElse) {
    await log.info(`[${label}] No change: "${row.book}" already ${update.status}.`);
  }

  if (!willSetStatus && nothingElse) return; // nothing to write

  const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

  if (cfg.DRY_RUN) {
    const parts: string[] = [];
    if (willSetStatus) parts.push(`status → ${update.status}`);
    if (categoryToSet) parts.push(`category → ${categoryToSet}`);
    if (tagsToSet) parts.push(`+tags [${newTags.join(", ")}]`);
    if (etaToSet) parts.push(`ETA → ${isoDay(etaToSet)}`);
    if (deliveredToSet) parts.push(`delivered → ${isoDay(deliveredToSet)}`);
    await log.info(`[${label}] [dry-run] would set "${row.book}": ${parts.join(", ")}.`);
    return;
  }

  try {
    await notion.applyUpdate(row, {
      status: willSetStatus ? update.status : undefined,
      category: categoryToSet,
      tags: tagsToSet,
      etaMs: etaToSet,
      deliveredMs: deliveredToSet,
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
    if (etaToSet) row.eta = isoDay(etaToSet); // authoritative once set, this tick
    if (!willSetStatus) {
      const bits: string[] = [];
      if (categoryToSet) bits.push(`category ${categoryToSet}`);
      if (newTags.length) bits.push(`tags [${newTags.join(", ")}]`);
      if (etaToSet) bits.push(`ETA ${isoDay(etaToSet)}`);
      if (deliveredToSet) bits.push(`delivered ${isoDay(deliveredToSet)}`);
      if (bits.length)
        await log.info(`[${label}] Updated "${row.book}": ${bits.join("; ")}.`);
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
      await log.warn(
        `LLM call cap (${cfg.MAX_LLM_CALLS_PER_TICK}/tick) reached; skipping further LLM calls this tick.`,
      );
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

/** Turn a parsed ForwardMe event into the fields to write to its package row. */
function buildPackageUpdate(ev: ForwarderEvent): PackageUpdate {
  const update: PackageUpdate = { status: "At Forwarder" };
  if (ev.kind === "arrival") {
    update.arrivedMs = ev.receivedMs;
    update.from = ev.from;
    update.contents = ev.contents;
    update.declaredValue = ev.declaredValue;
    update.weight = ev.weight;
  } else if (ev.kind === "reminder" && typeof ev.daysLeft === "number") {
    update.daysLeft = ev.daysLeft;
    // A countdown goes stale; persist the concrete deadline it implies instead.
    update.disposalByMs = ev.receivedMs + ev.daysLeft * 86_400_000;
  }
  return update;
}

/**
 * Forwarder job for one account: parse ForwardMe arrival/reminder mail into the
 * standalone "Forwarder Packages" DB, keyed by ForwardMe's opaque package code.
 * Creates a row on first sight, updates it thereafter. A user-set `Shipped` is
 * never reverted; outbound shipment emails (uncorrelatable to a code) are logged
 * only. No-op unless the forwarder DB is configured.
 */
async function runForwarder(
  label: string,
  gmail: GmailClient,
  deps: Deps,
  state: State,
): Promise<void> {
  const { cfg, log, forwarder } = deps;
  if (!forwarder) return;

  const watermark = accountState(state, label);
  const messages = await fetchNewMessages(
    gmail,
    cfg.FORWARDER_QUERY,
    watermark.forwarderLastMs,
    log,
    label,
  );
  if (messages.length === 0) {
    await log.info(`[${label}] No new forwarder messages.`);
    return;
  }
  await log.info(`[${label}] Processing ${messages.length} forwarder message(s).`);

  const packages = await forwarder.listPackages();

  for (const msg of messages) {
    // Advance the watermark before any branch/skip so a message is processed once.
    watermark.forwarderLastMs = Math.max(watermark.forwarderLastMs, msg.internalDateMs);

    const ev = parseForwarderEmail(msg);
    if (!ev) continue;
    if (ev.kind === "outbound") {
      await log.info(
        `[${label}] Forwarder shipment left the warehouse: "${msg.subject}".`,
      );
      continue;
    }

    const code = ev.code as string; // arrival/reminder always carry a code
    const update = buildPackageUpdate(ev);
    const existing = packages.get(code);

    if (existing && isTerminalPackageStatus(existing.status)) {
      await log.info(
        `[${label}] Package ${code} already ${existing.status}; leaving as-is.`,
      );
      continue;
    }

    if (cfg.DRY_RUN) {
      await log.info(
        `[${label}] [dry-run] would ${existing ? "update" : "create"} package ${code} ` +
          `(${ev.kind}${ev.daysLeft != null ? `, ${ev.daysLeft}d left` : ""}).`,
      );
      continue;
    }

    try {
      if (existing) {
        // Don't rewrite Status if it already matches — avoids a needless write.
        if (existing.status === update.status) delete update.status;
        await forwarder.updatePackage(existing.pageId, update);
        await log.info(`[${label}] Updated forwarder package ${code} (${ev.kind}).`);
      } else {
        const pageId = await forwarder.createPackage(code, update);
        packages.set(code, { pageId, code, status: update.status ?? "At Forwarder" });
        await log.info(`[${label}] New forwarder package ${code}.`);
      }
    } catch (err) {
      await log.error(
        `[${label}] Failed upserting forwarder package ${code}: ${String(err)}`,
      );
    }
  }
}

/**
 * Digital-games job for one account: parse Amazon JP digital + Nintendo eShop
 * purchase/preorder mail into the standalone "Digital Games" DB, keyed by
 * platform + title (so an order and its later code-delivery, or a preorder and
 * its purchase, collapse onto one row). `Purchased` is never reverted to
 * `Preordered`. No-op unless the games DB is configured.
 */
async function runGames(
  label: string,
  gmail: GmailClient,
  deps: Deps,
  state: State,
): Promise<void> {
  const { cfg, log, games } = deps;
  if (!games) return;

  const watermark = accountState(state, label);
  const messages = await fetchNewMessages(
    gmail,
    cfg.GAMES_QUERY,
    watermark.gamesLastMs,
    log,
    label,
  );
  if (messages.length === 0) {
    await log.info(`[${label}] No new digital-game messages.`);
    return;
  }
  await log.info(`[${label}] Processing ${messages.length} digital-game message(s).`);

  const rows = await games.listGames();

  for (const msg of messages) {
    // Advance the watermark before any branch/skip so a message is processed once.
    watermark.gamesLastMs = Math.max(watermark.gamesLastMs, msg.internalDateMs);

    const ev = parseGameEmail(msg);
    if (!ev) continue;

    const key = gameKey(ev.platform, ev.title);
    const existing = rows.get(key);

    if (existing && isTerminalGameStatus(existing.status) && ev.status === "Preordered") {
      continue; // don't revert a purchased game to preordered
    }

    const amount = ev.price ? parseAmount(ev.price) : null;
    const usd =
      amount != null
        ? await toUSD(amount, currencyFor(ev.platform), ev.receivedMs)
        : null;
    const update: GameUpdate = {
      status: ev.status,
      platform: ev.platform,
      dateMs: ev.receivedMs,
      price: ev.price,
      device: ev.device,
      usd: usd ?? undefined,
    };

    if (cfg.DRY_RUN) {
      await log.info(
        `[${label}] [dry-run] would ${existing ? "update" : "create"} game "${ev.title}" ` +
          `(${ev.platform}, ${ev.status}).`,
      );
      continue;
    }

    try {
      if (existing) {
        if (existing.status === ev.status) delete update.status;
        await games.updateGame(existing.pageId, update);
        await log.info(
          `[${label}] Updated game "${ev.title}" (${ev.platform}, ${ev.status}).`,
        );
      } else {
        const pageId = await games.createGame(ev.title, update);
        rows.set(key, { pageId, key, status: ev.status });
        await log.info(
          `[${label}] New game "${ev.title}" (${ev.platform}, ${ev.status}).`,
        );
      }
    } catch (err) {
      await log.error(`[${label}] Failed upserting game "${ev.title}": ${String(err)}`);
    }
  }
}

/** Amazon storefront from a shipment email's sender domain (for the merchant). */
function amazonMerchant(from: string): string {
  const f = from.toLowerCase();
  if (f.includes("amazon.co.jp")) return "Amazon JP";
  if (f.includes("amazon.in")) return "Amazon IN";
  return "Amazon US";
}

/** Amazon order-details URL for a storefront + order number. */
function amazonOrderUrl(merchant: string, orderId: string): string {
  const tld =
    merchant === "Amazon IN" ? "in" : merchant === "Amazon JP" ? "co.jp" : "com";
  return `https://www.amazon.${tld}/gp/css/order-details?orderID=${orderId}`;
}

/**
 * Auto-add or advance a tech accessory in the Tech Inventory Accessories DB.
 * Spend-only (amount comes from an order confirmation; a shipment carries none),
 * deduped on the shared per-tick accessory map, and it never steals an order the
 * general DB already owns (avoids a duplicate during the changeover). "From now"
 * is inherent: the calling pass only sees mail newer than its watermark. Returns
 * true when it handled the order (created / advanced / enriched, or dry-run).
 */
async function upsertAccessory(
  deps: Deps,
  ctx: TickContext,
  a: {
    label: string;
    orderId: string;
    name: string;
    category: string;
    status: AccessoryStatus;
    merchant: string;
    dateMs: number;
    amount?: number;
    currency?: string;
    etaMs?: number;
    /** Storefront link (non-Amazon sources); Amazon derives its own from the id. */
    orderUrl?: string;
  },
): Promise<boolean> {
  const { cfg, log, accessories } = deps;
  if (!accessories) return false;
  if (ctx.generalOrders.has(a.orderId)) return false; // already owned by general DB

  const existing = ctx.accessoryOrders.get(a.orderId);

  if (cfg.DRY_RUN) {
    await log.info(
      `[${a.label}] [dry-run] would ${existing ? "advance" : "add"} accessory ${a.orderId} → ${a.status} (${a.category}).`,
    );
    return true;
  }

  try {
    if (existing) {
      if (planAccessoryUpdate(existing.status, a.status) === "apply") {
        await accessories.setStatus(existing.pageId, a.status);
        existing.status = a.status;
        ctx.updates++;
        await log.info(`[${a.label}] Accessory ${a.orderId} → ${a.status}.`);
      }
      // Enrich the price (a confirmation arriving after the shipment that first
      // created the row) and/or the ETA (from a shipment) if this call has them.
      const enrich: AccessoryUpdate = {};
      if (typeof a.amount === "number") {
        enrich.amount = a.amount;
        enrich.currency = a.currency;
      }
      if (a.etaMs) enrich.etaMs = a.etaMs;
      if (Object.keys(enrich).length > 0) {
        await accessories.updateAccessory(existing.pageId, enrich);
      }
    } else {
      const pageId = await accessories.createAccessory(a.orderId, {
        name: a.name,
        category: a.category,
        amount: a.amount,
        currency: a.currency,
        etaMs: a.etaMs,
        orderUrl:
          a.orderUrl ??
          (a.merchant.startsWith("Amazon")
            ? amazonOrderUrl(a.merchant, a.orderId)
            : undefined),
        status: a.status,
        notes: `Auto-added from ${a.merchant} order ${a.orderId}.`,
      });
      ctx.accessoryOrders.set(a.orderId, {
        pageId,
        orderId: a.orderId,
        status: a.status,
      });
      ctx.updates++;
      await log.info(
        `[${a.label}] Added accessory ${a.orderId}: "${a.name.slice(0, 40)}" (${a.category}, ${a.status}).`,
      );
    }
    return true;
  } catch (err) {
    await log.error(
      `[${a.label}] Failed upserting accessory ${a.orderId}: ${String(err)}`,
    );
    return false;
  }
}

/**
 * E3: capture an unmatched, non-book shipping item in the General DB instead of
 * dropping it as "No Notion match". Requires a stable Amazon order # (tracking-
 * only mail can't be keyed and is still dropped); Book/Game/Digital are left to
 * their domain DBs. Spend is left blank — a later order confirmation supplies
 * the amount — so this stays spend-only and never invents a value. Deduped
 * against the shared per-tick order map, so the confirmation and lifecycle
 * passes collapse onto the same row. Returns true when it handled the message
 * (created/advanced a row, or previewed one in dry-run), false to fall through
 * to the normal no-match logging.
 */
async function routeToGeneral(
  label: string,
  msg: ParsedMessage,
  update: ShipmentUpdate,
  deps: Deps,
  ctx: TickContext,
): Promise<boolean> {
  const { cfg, log, general } = deps;
  if (!update.orderId) return false;

  // Tech accessories go to the Tech Inventory Accessories DB, not the general DB.
  // Advance one already tracked there, or create a new one from a titled shipment.
  if (deps.accessories) {
    const known = ctx.accessoryOrders.has(update.orderId);
    const cat = update.itemName
      ? techAccessoryCategory({
          itemName: update.itemName,
          from: msg.from,
          subject: msg.subject,
        })
      : null;
    if (known || cat) {
      const handled = await upsertAccessory(deps, ctx, {
        label,
        orderId: update.orderId,
        name: update.itemName || `Order ${update.orderId}`,
        category: cat ?? "Other",
        status: accessoryStatusFromShipment(update.status),
        merchant: amazonMerchant(msg.from),
        dateMs: msg.internalDateMs,
        etaMs: update.etaMs,
      });
      if (handled) return true;
    }
  }

  if (!general) return false;
  if (
    update.category === "Book" ||
    update.category === "Game" ||
    update.category === "Digital"
  ) {
    return false; // domain-owned, or no shipment to track
  }

  const category =
    update.category === "Accessory"
      ? "Accessories"
      : update.category === "Electronics"
        ? "Electronics"
        : "Other";
  const gStatus: GeneralStatus =
    update.status === "Delivered"
      ? "Delivered"
      : update.status === "In Transit" || update.status === "Arriving Soon"
        ? "Shipped"
        : "Ordered";
  const orderId = update.orderId;
  const item = update.itemName || `Order ${orderId}`;
  const deliveredMs = gStatus === "Delivered" ? msg.internalDateMs : undefined;
  const existing = ctx.generalOrders.get(orderId);

  if (cfg.DRY_RUN) {
    await log.info(
      `[${label}] [dry-run] would route order ${orderId} to General (${category}, ${gStatus}).`,
    );
    return true;
  }

  try {
    if (existing) {
      // Advance an already-known order along the general ladder; a noop/regress
      // still counts as "handled" so it isn't re-logged as a no-match.
      if (planGeneralUpdate(existing.status, gStatus) === "apply") {
        await general.setStatus(existing.pageId, gStatus, deliveredMs);
        existing.status = gStatus;
        ctx.updates++;
        await log.info(
          `[${label}] General order ${orderId} → ${gStatus} (from shipping).`,
        );
      }
    } else {
      const pageId = await general.createOrder(orderId, {
        item,
        merchant: amazonMerchant(msg.from),
        category,
        dateMs: msg.internalDateMs,
        deliveredMs,
        etaMs: update.etaMs, // puts the routed item on the General delivery calendar
        status: gStatus,
      });
      ctx.generalOrders.set(orderId, { pageId, orderId, status: gStatus });
      ctx.updates++;
      await log.info(
        `[${label}] Routed order ${orderId} to General: "${item.slice(0, 40)}" (${category}, ${gStatus}).`,
      );
    }
    return true;
  } catch (err) {
    await log.error(
      `[${label}] Failed routing order ${orderId} to General: ${String(err)}`,
    );
    return false;
  }
}

// Map the deterministic item categories to the general taxonomy. Returns the
// shared category if all items agree, else "Other". (Book/Game are filtered out
// by the caller — they're owned by the domain DBs.)
function mapGeneralCategory(cats: (string | null)[]): string {
  const MAP: Record<string, string> = {
    Accessory: "Accessories",
    Electronics: "Electronics",
    Digital: "Software/Digital",
    Other: "Other",
  };
  const mapped = (cats.filter(Boolean) as string[]).map((c) => MAP[c] ?? "Other");
  const uniq = [...new Set(mapped)];
  return uniq.length === 1 ? uniq[0]! : "Other";
}

/**
 * Resolve a general-order category: deterministic keyword mapping first, then the
 * LLM gap layer when that can't place it (bounded by the shared per-tick LLM
 * budget; never in dry-run), then `fallback` if still unplaced. Amazon passes
 * "Other"; eBay passes "Collectibles" (the right prior for this user's uncategorized
 * eBay buys). Backfill orders the LLM couldn't reach get the fallback and are
 * refined by a one-shot re-categorization.
 */
async function categorizeOrder(
  cats: (string | null)[],
  dominantItem: string,
  merchant: string,
  fallback: string,
  deps: Deps,
  ctx: TickContext,
): Promise<string> {
  let category = mapGeneralCategory(cats);
  if (
    category === "Other" &&
    deps.llm &&
    !deps.cfg.DRY_RUN &&
    ctx.llmCalls < deps.cfg.MAX_LLM_CALLS_PER_TICK
  ) {
    ctx.llmCalls++;
    try {
      const llmCat = await deps.llm.categorizeGeneral(dominantItem, merchant, [
        ...GENERAL_LLM_CATEGORIES,
      ]);
      if (llmCat) category = llmCat;
    } catch (err) {
      await deps.log.warn(
        `LLM categorize failed for "${dominantItem.slice(0, 40)}": ${String(err)}`,
      );
    }
  }
  return category === "Other" ? fallback : category;
}

/**
 * General-purchases job: maintains the "Purchases (General)" DB via three
 * independent passes over the shared order map (loaded once) — Amazon
 * confirmations ({@link runGeneralConfirmations}), Amazon post-order lifecycle
 * ({@link runGeneralLifecycle}), and eBay confirmations + lifecycle
 * ({@link runEbay}). Each pass has its own query + watermark and its own "no new
 * mail" guard, so an idle Amazon inbox never blocks the lifecycle or eBay work.
 * No-op unless the general DB is configured.
 */
async function runGeneral(
  label: string,
  gmail: GmailClient,
  deps: Deps,
  ctx: TickContext,
  state: State,
): Promise<void> {
  const { general } = deps;
  if (!general) return;

  // Shared per-tick order map (loaded once in runTick). All three passes and the
  // shipping fallback dedup against it, so a row created by any of them is
  // visible to the others within the same tick.
  const existing = ctx.generalOrders;
  await runGeneralConfirmations(label, gmail, deps, ctx, existing, state);
  await runGeneralLifecycle(label, gmail, deps, ctx, existing, state);
  await runEbay(label, gmail, deps, ctx, existing, state);
  await runShopify(label, gmail, deps, ctx, existing, state);
}

/**
 * Shopify pass: capture "Order #… confirmed" mail from any Shopify storefront
 * (`SHOPIFY_QUERY`) — brands that sell direct off Shopify rather than a
 * marketplace. Tech accessories route to the Tech Inventory Accessories DB
 * (self-categorized, priced); everything else to the general Purchases DB — both
 * keyed by the store-namespaced order number, Status `Ordered`. Seeded "from now"
 * on first run so enabling it never backfills years of unrelated DTC orders.
 * Confirmation-only: Shopify shipment/delivery mail isn't parsed (advance those
 * by hand). No-op unless the general DB is configured.
 */
async function runShopify(
  label: string,
  gmail: GmailClient,
  deps: Deps,
  ctx: TickContext,
  existing: Map<string, { pageId: string; orderId: string; status: string }>,
  state: State,
): Promise<void> {
  const { cfg, log, general } = deps;
  if (!general) return;

  const watermark = accountState(state, label);
  // First run for this account: seed the watermark to now instead of fetching the
  // whole Shopify history (which spans every store the user has ever bought from).
  if (watermark.shopifyLastMs === 0) {
    watermark.shopifyLastMs = Date.now();
    await log.info(`[${label}] Shopify tracking seeded from now (no backfill).`);
    return;
  }

  const messages = await fetchNewMessages(
    gmail,
    cfg.SHOPIFY_QUERY,
    watermark.shopifyLastMs,
    log,
    label,
  );
  if (messages.length === 0) {
    await log.info(`[${label}] No new Shopify messages.`);
    return;
  }
  await log.info(`[${label}] Processing ${messages.length} Shopify message(s).`);

  for (const msg of messages) {
    watermark.shopifyLastMs = Math.max(watermark.shopifyLastMs, msg.internalDateMs);

    const o = parseShopifyOrder(msg);
    if (!o) continue;
    if (existing.has(o.orderId)) continue; // already created (idempotent)

    const cats = o.itemNames.map((n) =>
      classifyItem({ itemName: n, from: msg.from, subject: msg.subject }),
    );
    if (cats.some((c) => c === "Book" || c === "Game")) continue; // domain-owned
    if (o.itemNames.some((n) => matchRow(n, ctx.rows, cfg.MATCH_THRESHOLD))) {
      await log.info(
        `[${label}] Shopify order ${o.orderId} matches a tracked book; skipped.`,
      );
      continue;
    }

    // Tech accessories go to the Tech Inventory Accessories DB (priced), not the
    // general Purchases DB.
    if (deps.accessories) {
      const techCat = techAccessoryCategory({
        itemName: o.dominantItem,
        from: msg.from,
        subject: msg.subject,
      });
      if (
        techCat &&
        (await upsertAccessory(deps, ctx, {
          label,
          orderId: o.orderId,
          name:
            o.itemCount > 1 ? `${o.dominantItem} (+${o.itemCount - 1})` : o.dominantItem,
          category: techCat,
          status: "Ordered",
          merchant: o.merchant,
          dateMs: o.dateMs,
          amount: o.total,
          currency: o.currency,
          orderUrl: o.orderUrl,
        }))
      ) {
        continue; // routed to Accessories — skip the general DB
      }
    }

    if (cfg.DRY_RUN) {
      await log.info(
        `[${label}] [dry-run] would create Shopify order ${o.orderId} ` +
          `(${o.currency} ${o.total}).`,
      );
      continue;
    }

    try {
      const category = await categorizeOrder(
        cats,
        o.dominantItem,
        o.merchant,
        "Other",
        deps,
        ctx,
      );
      const usd = await toUSD(o.total, o.currency, o.dateMs);
      const pageId = await general.createOrder(o.orderId, {
        item:
          o.itemCount > 1 ? `${o.dominantItem} (+${o.itemCount - 1})` : o.dominantItem,
        merchant: o.merchant,
        category,
        amount: o.total,
        currency: o.currency,
        usd: usd ?? undefined,
        dateMs: o.dateMs,
        items: o.itemCount,
        status: "Ordered",
      });
      existing.set(o.orderId, { pageId, orderId: o.orderId, status: "Ordered" });
      await log.info(
        `[${label}] New Shopify purchase ${o.orderId}: "${o.dominantItem.slice(0, 40)}" (${category}).`,
      );
    } catch (err) {
      await log.error(
        `[${label}] Failed upserting Shopify order ${o.orderId}: ${String(err)}`,
      );
    }
  }
}

/**
 * Amazon order-confirmation pass: parse `GENERAL_QUERY` mail into new general
 * rows (Status `Ordered`). Book/game orders — and fuzzy matches against the
 * curated book DB — are skipped (owned by the domain DBs). Its "no new mail"
 * early-return is local, so it never blocks the lifecycle/eBay passes.
 */
async function runGeneralConfirmations(
  label: string,
  gmail: GmailClient,
  deps: Deps,
  ctx: TickContext,
  existing: Map<string, { pageId: string; orderId: string; status: string }>,
  state: State,
): Promise<void> {
  const { cfg, log, general } = deps;
  if (!general) return;

  const watermark = accountState(state, label);
  const messages = await fetchNewMessages(
    gmail,
    cfg.GENERAL_QUERY,
    watermark.generalLastMs,
    log,
    label,
  );
  if (messages.length === 0) {
    await log.info(`[${label}] No new purchase messages.`);
    return;
  }
  await log.info(`[${label}] Processing ${messages.length} purchase message(s).`);

  for (const msg of messages) {
    watermark.generalLastMs = Math.max(watermark.generalLastMs, msg.internalDateMs);

    for (const o of parseOrderEmail(msg)) {
      const cats = o.itemNames.map((n) =>
        classifyItem({ itemName: n, from: msg.from, subject: msg.subject }),
      );
      if (cats.some((c) => c === "Book" || c === "Game")) continue; // domain-owned
      // Safety net against the curated books DB (catches booky items with no keyword).
      if (o.itemNames.some((n) => matchRow(n, ctx.rows, cfg.MATCH_THRESHOLD))) {
        await log.info(`[${label}] Order ${o.orderId} matches a tracked book; skipped.`);
        continue;
      }

      // Tech accessories go to the Tech Inventory Accessories DB (with price),
      // not the general Purchases DB.
      if (deps.accessories) {
        const techCat = techAccessoryCategory({
          itemName: o.dominantItem,
          from: msg.from,
          subject: msg.subject,
        });
        if (
          techCat &&
          (await upsertAccessory(deps, ctx, {
            label,
            orderId: o.orderId,
            name:
              o.itemCount > 1
                ? `${o.dominantItem} (+${o.itemCount - 1})`
                : o.dominantItem,
            category: techCat,
            status: "Ordered",
            merchant: o.merchant,
            dateMs: o.dateMs,
            amount: o.total,
            currency: o.currency,
          }))
        ) {
          continue; // routed to Accessories — skip the general DB
        }
      }

      const category = await categorizeOrder(
        cats,
        o.dominantItem,
        o.merchant,
        "Other",
        deps,
        ctx,
      );
      const usd = await toUSD(o.total, o.currency, o.dateMs);
      const label_ =
        o.itemCount > 1 ? `${o.dominantItem} (+${o.itemCount - 1})` : o.dominantItem;
      const update: GeneralUpdate = {
        item: label_,
        merchant: o.merchant,
        category,
        amount: o.total,
        currency: o.currency,
        usd: usd ?? undefined,
        dateMs: o.dateMs,
        items: o.itemCount,
      };
      const exists = existing.get(o.orderId);

      if (cfg.DRY_RUN) {
        await log.info(
          `[${label}] [dry-run] would ${exists ? "update" : "create"} order ${o.orderId} ` +
            `(${category}, ${o.currency} ${o.total}).`,
        );
        continue;
      }

      try {
        if (exists) {
          await general.updateOrder(exists.pageId, update);
        } else {
          const pageId = await general.createOrder(o.orderId, {
            ...update,
            status: "Ordered",
          });
          existing.set(o.orderId, { pageId, orderId: o.orderId, status: "Ordered" });
          await log.info(
            `[${label}] New purchase ${o.orderId}: "${o.dominantItem.slice(0, 40)}" (${category}).`,
          );
        }
      } catch (err) {
        await log.error(`[${label}] Failed upserting order ${o.orderId}: ${String(err)}`);
      }
    }
  }
}

/**
 * eBay pass for general orders: a single query (`EBAY_QUERY`) carries both
 * confirmations and post-order mail. Confirmations create a `Collectibles` row
 * (keyed by eBay's order number); shipment/delivery/refund mail advances it via
 * the shared {@link planGeneralUpdate} ladder (refund → Returned, net-zeroed by
 * the summary). eBay buys are collectibles the user values in a separate app, so
 * this captures spend only — no grade/cert parsing. Processed oldest-first, so a
 * confirmation creates the row before later mail advances it.
 */
async function runEbay(
  label: string,
  gmail: GmailClient,
  deps: Deps,
  ctx: TickContext,
  existing: Map<string, { pageId: string; orderId: string; status: string }>,
  state: State,
): Promise<void> {
  const { cfg, log, general } = deps;
  if (!general) return;

  const watermark = accountState(state, label);
  const messages = await fetchNewMessages(
    gmail,
    cfg.EBAY_QUERY,
    watermark.ebayLastMs,
    log,
    label,
  );
  if (messages.length === 0) {
    await log.info(`[${label}] No new eBay messages.`);
    return;
  }
  await log.info(`[${label}] Processing ${messages.length} eBay message(s).`);

  for (const msg of messages) {
    watermark.ebayLastMs = Math.max(watermark.ebayLastMs, msg.internalDateMs);

    // Confirmation → create the order row (idempotent; an existing row is left
    // as-is so a later lifecycle advance isn't clobbered back to Ordered).
    const order = parseEbayOrder(msg);
    if (order) {
      if (existing.has(order.orderId)) continue;
      if (cfg.DRY_RUN) {
        await log.info(`[${label}] [dry-run] would create eBay order ${order.orderId}.`);
        continue;
      }
      try {
        const cats = order.itemNames.map((n) =>
          classifyItem({ itemName: n, from: msg.from, subject: msg.subject }),
        );
        const category = await categorizeOrder(
          cats,
          order.dominantItem,
          "eBay",
          "Collectibles",
          deps,
          ctx,
        );
        const usd = await toUSD(order.total, order.currency, order.dateMs);
        const pageId = await general.createOrder(order.orderId, {
          item: order.dominantItem,
          merchant: "eBay",
          category,
          amount: order.total,
          currency: order.currency,
          usd: usd ?? undefined,
          dateMs: order.dateMs,
          items: order.itemCount,
          status: "Ordered",
        });
        existing.set(order.orderId, {
          pageId,
          orderId: order.orderId,
          status: "Ordered",
        });
        await log.info(
          `[${label}] New eBay order ${order.orderId}: "${order.dominantItem.slice(0, 40)}".`,
        );
      } catch (err) {
        await log.error(
          `[${label}] Failed creating eBay order ${order.orderId}: ${String(err)}`,
        );
      }
      continue;
    }

    // Lifecycle → advance an existing order (unknown orders are ignored).
    const ev = parseEbayLifecycle(msg);
    if (!ev) continue;
    const row = existing.get(ev.orderId);
    if (!row) continue;

    const decision = planGeneralUpdate(row.status, ev.status);
    if (decision === "noop") continue;
    if (decision === "regress") {
      await log.info(
        `[${label}] eBay order ${ev.orderId}: ${row.status || "(unset)"} ✗→ ${ev.status} (skipped).`,
      );
      continue;
    }
    if (cfg.DRY_RUN) {
      await log.info(
        `[${label}] [dry-run] would set eBay order ${ev.orderId} → ${ev.status}.`,
      );
      continue;
    }
    try {
      await general.setStatus(
        row.pageId,
        ev.status,
        ev.status === "Delivered" ? msg.internalDateMs : undefined,
      );
      row.status = ev.status;
      await log.info(`[${label}] eBay order ${ev.orderId} → ${ev.status}.`);
    } catch (err) {
      await log.error(
        `[${label}] Failed advancing eBay order ${ev.orderId}: ${String(err)}`,
      );
    }
  }
}

/**
 * Lifecycle pass for general orders: read post-order Amazon mail (shipment /
 * delivery / cancellation / refund), match by order number, and advance the
 * row's Status along `Ordered → Shipped → Delivered` (monotonic) or to a
 * terminal `Cancelled`/`Returned` (which the spend summary then excludes, so a
 * refunded order net-zeros). Lifecycle mail whose order isn't in the general DB
 * (e.g. a book/game order, owned by its domain DB) is ignored.
 */
async function runGeneralLifecycle(
  label: string,
  gmail: GmailClient,
  deps: Deps,
  ctx: TickContext,
  existing: Map<string, { pageId: string; orderId: string; status: string }>,
  state: State,
): Promise<void> {
  const { cfg, log, general } = deps;
  if (!general) return;

  const watermark = accountState(state, label);
  const messages = await fetchNewMessages(
    gmail,
    cfg.GENERAL_LIFECYCLE_QUERY,
    watermark.generalLifecycleLastMs,
    log,
    label,
  );
  if (messages.length === 0) {
    await log.info(`[${label}] No new order-lifecycle messages.`);
    return;
  }
  await log.info(`[${label}] Processing ${messages.length} order-lifecycle message(s).`);

  for (const msg of messages) {
    watermark.generalLifecycleLastMs = Math.max(
      watermark.generalLifecycleLastMs,
      msg.internalDateMs,
    );

    const ev = parseLifecycleEmail(msg);
    if (!ev) continue;

    // A tech accessory tracked in the Accessories DB advances there, not here.
    if (
      ctx.accessoryOrders.has(ev.orderId) &&
      (await upsertAccessory(deps, ctx, {
        label,
        orderId: ev.orderId,
        name: `Order ${ev.orderId}`,
        category: "Other",
        status: accessoryStatusFromGeneral(ev.status),
        merchant: amazonMerchant(msg.from),
        dateMs: msg.internalDateMs,
      }))
    ) {
      continue;
    }

    const row = existing.get(ev.orderId);
    if (!row) continue; // not a general order (book/game, or never confirmed)

    const decision = planGeneralUpdate(row.status, ev.status);
    if (decision === "noop") continue;
    if (decision === "regress") {
      await log.info(
        `[${label}] Order ${ev.orderId}: ${row.status || "(unset)"} ✗→ ${ev.status} (skipped).`,
      );
      continue;
    }

    if (cfg.DRY_RUN) {
      await log.info(
        `[${label}] [dry-run] would set order ${ev.orderId} → ${ev.status}.`,
      );
      continue;
    }

    try {
      await general.setStatus(
        row.pageId,
        ev.status,
        ev.status === "Delivered" ? msg.internalDateMs : undefined,
      );
      row.status = ev.status; // keep the map current for later mail this tick
      await log.info(`[${label}] Order ${ev.orderId} → ${ev.status}.`);
    } catch (err) {
      await log.error(`[${label}] Failed advancing order ${ev.orderId}: ${String(err)}`);
    }
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
