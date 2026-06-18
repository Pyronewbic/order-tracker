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
import { parseOrderEmail } from "./general/parser.js";
import type { GeneralNotionClient, GeneralUpdate } from "./general/notion.js";
import { classifyItem } from "./categorize.js";
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
  // A status the target DB has no option for (toNotionStatus → null) can't be
  // written; treat it as not-applied so we don't falsely log/notify a change.
  const statusWritable = toNotionStatus(update.status) !== null;
  const willSetStatus = decision === "apply" && statusWritable;
  // Backfill category only when detected and the row has none (never overwrite a
  // manual value). Tags merge in — keep existing, add only the new ones.
  const categoryToSet = update.category && !row.category ? update.category : undefined;
  const newTags = update.tags.filter((t) => !row.tags.includes(t));
  const tagsToSet = newTags.length > 0 ? [...row.tags, ...newTags] : undefined;

  if (decision === "regress") {
    await log.warn(
      `[${label}] Skipped regression for "${row.book}": ${row.status || "(unset)"} ✗→ ${update.status}.`,
    );
  } else if (decision === "apply" && !statusWritable && !categoryToSet && !tagsToSet) {
    await log.info(
      `[${label}] No DB status for "${update.status}"; left "${row.book}" unchanged.`,
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
      await log.info(`[${label}] Forwarder shipment left the warehouse: "${msg.subject}".`);
      continue;
    }

    const code = ev.code as string; // arrival/reminder always carry a code
    const update = buildPackageUpdate(ev);
    const existing = packages.get(code);

    if (existing && isTerminalPackageStatus(existing.status)) {
      await log.info(`[${label}] Package ${code} already ${existing.status}; leaving as-is.`);
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
      await log.error(`[${label}] Failed upserting forwarder package ${code}: ${String(err)}`);
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
      amount != null ? await toUSD(amount, currencyFor(ev.platform), ev.receivedMs) : null;
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
        await log.info(`[${label}] Updated game "${ev.title}" (${ev.platform}, ${ev.status}).`);
      } else {
        const pageId = await games.createGame(ev.title, update);
        rows.set(key, { pageId, key, status: ev.status });
        await log.info(`[${label}] New game "${ev.title}" (${ev.platform}, ${ev.status}).`);
      }
    } catch (err) {
      await log.error(`[${label}] Failed upserting game "${ev.title}": ${String(err)}`);
    }
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
 * General-purchases job: parse Amazon order-confirmation mail into the
 * "Purchases (General)" DB, one row per order (keyed by order number). Orders
 * whose items are books/games — or that fuzzy-match a curated book row — are
 * skipped (owned by the domain DBs, so the spend summary never double-counts).
 * Status is set to `Ordered` on create and left alone after (no shipment/refund
 * wiring yet). No-op unless the general DB is configured.
 */
async function runGeneral(
  label: string,
  gmail: GmailClient,
  deps: Deps,
  ctx: TickContext,
  state: State,
): Promise<void> {
  const { cfg, log, general } = deps;
  if (!general) return;

  const watermark = accountState(state, label);
  const messages = await fetchNewMessages(gmail, cfg.GENERAL_QUERY, watermark.generalLastMs, log, label);
  if (messages.length === 0) {
    await log.info(`[${label}] No new purchase messages.`);
    return;
  }
  await log.info(`[${label}] Processing ${messages.length} purchase message(s).`);

  const existing = await general.listOrders();

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

      const category = mapGeneralCategory(cats);
      const usd = await toUSD(o.total, o.currency, o.dateMs);
      const label_ = o.itemCount > 1 ? `${o.dominantItem} (+${o.itemCount - 1})` : o.dominantItem;
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
          const pageId = await general.createOrder(o.orderId, { ...update, status: "Ordered" });
          existing.set(o.orderId, { pageId, orderId: o.orderId, status: "Ordered" });
          await log.info(`[${label}] New purchase ${o.orderId}: "${o.dominantItem.slice(0, 40)}" (${category}).`);
        }
      } catch (err) {
        await log.error(`[${label}] Failed upserting order ${o.orderId}: ${String(err)}`);
      }
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
