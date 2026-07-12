import Fuse from "fuse.js";
import type { OrderRow } from "./client.js";

export interface MatchResult {
  row: OrderRow;
  /** Fuse score: 0 is a perfect match, 1 is no match. */
  score: number;
}

/**
 * Fuzzy-match an item name parsed from an email against the "Book" titles of
 * the database rows. Returns the best row whose score is within `threshold`,
 * or null when nothing is close enough.
 *
 * Two passes, most-precise first:
 *  1. Containment — a curated row name (often shorthand like "Hyrule Historia")
 *     appearing verbatim inside a longer email title ("The Legend of Zelda:
 *     Hyrule Historia"). Fuse scores this poorly, but it's a strong, exact
 *     signal, so we trust it.
 *  2. Fuse — handles typos/word-order and the inverse case (email carries a
 *     subtitle the title omits), trying both the full name and its primary
 *     (pre-colon) prefix.
 */
export function matchRow(
  itemName: string,
  rows: OrderRow[],
  threshold: number,
): MatchResult | null {
  if (!itemName || rows.length === 0) return null;

  // Pass 1: deterministic containment. High precision, so a hit short-circuits.
  const contained = containmentMatch(itemName, rows);
  if (contained) return { row: contained, score: 0.05 };

  // Pass 2: leading-prefix — the email title is a truncated prefix of a curated
  // row name ("Super Mario Encyclo…" → "Super Mario Encyclopedia"). Guarded to a
  // single unambiguous row so it can't steal a match Fuse would place better.
  const prefixed = prefixMatch(itemName, rows);
  if (prefixed) return { row: prefixed, score: 0.1 };

  // Pass 3: fuzzy.
  const fuse = new Fuse(rows, {
    keys: ["book"],
    includeScore: true,
    threshold, // Fuse rejects matches scoring worse than this
    ignoreLocation: true,
    minMatchCharLength: 2,
  });

  let best: MatchResult | null = null;
  for (const query of queryVariants(itemName)) {
    const [hit] = fuse.search(query);
    if (!hit || hit.score === undefined || hit.score > threshold) continue;
    if (!best || hit.score < best.score) {
      best = { row: hit.item, score: hit.score };
    }
  }

  return best;
}

// Franchise shorthands the user types in row names but Amazon spells out.
// Expanded on both sides so e.g. row "BotW …" matches "Breath of the Wild …".
const ABBREVIATIONS: Record<string, string[]> = {
  botw: ["breath", "of", "the", "wild"],
  totk: ["tears", "of", "the", "kingdom"],
};

/** Lowercase, strip diacritics, expand "&"→"and" + known abbreviations → tokens. */
function normalizeTokens(s: string): string[] {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining marks (é → e)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((t) => ABBREVIATIONS[t] ?? [t]);
}

/** True if `needle` appears as a contiguous run of tokens within `hay`. */
function containsTokenRun(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Match a row whose full normalized name appears verbatim (as a contiguous
 * token run) inside the item name. The most specific (longest) such name wins;
 * a tie between two equally-specific names is ambiguous and defers to Fuse.
 * Names shorter than 2 tokens / 6 chars are skipped so a generic short title
 * can't match unrelated items (this matcher also gates the General-DB dedup).
 */
function containmentMatch(itemName: string, rows: OrderRow[]): OrderRow | null {
  const item = normalizeTokens(itemName);
  if (item.length === 0) return null;

  let best: OrderRow | null = null;
  let bestLen = 0;
  let tie = false;
  for (const row of rows) {
    const rowTokens = normalizeTokens(row.book);
    const chars = rowTokens.join("").length;
    if (rowTokens.length < 2 || chars < 6) continue; // too generic to be safe
    if (!containsTokenRun(item, rowTokens)) continue;
    if (chars > bestLen) {
      best = row;
      bestLen = chars;
      tie = false;
    } else if (chars === bestLen) {
      tie = true;
    }
  }
  return tie ? null : best;
}

/**
 * Match a curated row whose name *starts with* the (possibly subject-truncated)
 * item name: every item token equals the row's token at that position, and the
 * final item token may be a prefix of the row's (catches a mid-word cut like
 * "encyclo" → "encyclopedia"). The item must be ≥2 tokens / ≥6 chars so a
 * generic short title can't prefix-match everything, and the result must be a
 * single unambiguous row (a prefix shared by two rows defers to Fuse).
 */
function prefixMatch(itemName: string, rows: OrderRow[]): OrderRow | null {
  const item = normalizeTokens(itemName);
  if (item.length < 2 || item.join("").length < 6) return null; // too generic

  let best: OrderRow | null = null;
  let bestLen = 0;
  let tie = false;
  for (const row of rows) {
    const rowTokens = normalizeTokens(row.book);
    if (rowTokens.length < item.length) continue;
    let ok = true;
    for (let j = 0; j < item.length; j++) {
      const rt = rowTokens[j]!;
      const it = item[j]!;
      if (j === item.length - 1 ? !rt.startsWith(it) : rt !== it) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const chars = rowTokens.join("").length;
    if (chars > bestLen) {
      best = row;
      bestLen = chars;
      tie = false;
    } else if (chars === bestLen) {
      tie = true;
    }
  }
  return tie ? null : best;
}

/** The full name plus its primary-title prefix (if meaningfully shorter). */
function queryVariants(itemName: string): string[] {
  const variants = [itemName];
  const primary = itemName.split(/\s*[:\-–—]\s*/)[0]?.trim();
  if (primary && primary.length >= 4 && primary !== itemName) {
    variants.push(primary);
  }
  return variants;
}
