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
 * Email subjects often carry a subtitle the Notion title omits
 * ("Title: Subtitle" vs "Title"), so we also try the primary title (text
 * before the first colon/dash) and keep whichever query scores best.
 */
export function matchRow(
  itemName: string,
  rows: OrderRow[],
  threshold: number,
): MatchResult | null {
  if (!itemName || rows.length === 0) return null;

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

/** The full name plus its primary-title prefix (if meaningfully shorter). */
function queryVariants(itemName: string): string[] {
  const variants = [itemName];
  const primary = itemName.split(/\s*[:\-–—]\s*/)[0]?.trim();
  if (primary && primary.length >= 4 && primary !== itemName) {
    variants.push(primary);
  }
  return variants;
}
