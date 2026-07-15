import { loadRuntimeConfig } from "./config.js";
import { GmailClient, makeOAuthClient } from "./gmail/client.js";
import { AccessoriesNotionClient, type AccessoryRow } from "./accessories/notion.js";
import { recoverOrderPrice, type PriceCache } from "./general/price-lookup.js";

/**
 * One-off repair pass for accessory prices.
 *
 * The daemon prices an accessory from its order confirmation, but a row created
 * by a shipment (or by hand) before that confirmation was seen — or after its
 * confirmation had already scrolled past the general watermark — stays unpriced
 * forever. This walks every auto-tracked accessory row, recovers each order's
 * charged total from mail (by order #, watermark-independent), and:
 *
 *   - fills a **blank** Amount, and
 *   - **reports** (never overwrites) an Amount that disagrees with the mail, so a
 *     deliberate manual value is never clobbered.
 *
 * Usage:
 *   npm run backfill:prices              fill blanks, report mismatches
 *   npm run backfill:prices -- --dry-run preview only, write nothing
 */

/** Amounts within this many currency units are treated as equal (rounding). */
const EPSILON = 1;

interface Finding {
  row: AccessoryRow;
  found: number;
  currency: string;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const cfg = await loadRuntimeConfig();

  if (!cfg.TECH_ACCESSORIES_DATABASE_ID) {
    throw new Error("TECH_ACCESSORIES_DATABASE_ID is not set — nothing to backfill.");
  }
  const accessories = new AccessoriesNotionClient(
    cfg.NOTION_API_KEY,
    cfg.TECH_ACCESSORIES_DATABASE_ID,
  );
  await accessories.verifyAccess();

  const gmails = cfg.accounts.map(
    (a) =>
      new GmailClient(
        makeOAuthClient({
          clientId: cfg.GMAIL_CLIENT_ID,
          clientSecret: cfg.GMAIL_CLIENT_SECRET,
          refreshToken: a.refreshToken,
        }),
      ),
  );

  const rows = await accessories.listByOrder();
  console.log(
    `${rows.size} accessory row(s) with an order #${dryRun ? "  [DRY RUN — no writes]" : ""}\n`,
  );

  const cache: PriceCache = new Map();
  const filled: Finding[] = [];
  const mismatched: Finding[] = [];
  const notFound: AccessoryRow[] = [];

  for (const row of rows.values()) {
    // The order may live in any of the authorized inboxes — try each in turn.
    let found = null;
    for (const gmail of gmails) {
      found = await recoverOrderPrice(gmail, row.orderId, cache);
      if (found) break;
    }

    if (!found) {
      if (row.amount === null) notFound.push(row);
      continue;
    }

    if (row.amount === null) {
      filled.push({ row, found: found.total, currency: found.currency });
      if (!dryRun) {
        await accessories.updateAccessory(row.pageId, {
          amount: found.total,
          currency: found.currency,
        });
      }
    } else if (
      // Only diff like-for-like: a USD row against an INR grand total is
      // meaningless (an Amazon US order billed in ₹ reports both).
      row.currency === found.currency &&
      Math.abs(row.amount - found.total) > EPSILON
    ) {
      mismatched.push({ row, found: found.total, currency: found.currency });
    }
  }

  const label = (f: Finding): string =>
    `  ${f.row.orderId.padEnd(22)} mail=${f.currency} ${f.found}`;

  console.log(`✅ Filled ${filled.length} blank amount(s)${dryRun ? " (would)" : ""}:`);
  filled.forEach((f) => console.log(label(f)));

  console.log(
    `\n⚠️  ${mismatched.length} same-currency mismatch(es) — NOT changed, review these.` +
      `\n    (An order split across several rows will flag: the mail carries the` +
      `\n     order total, each row only its own item.)`,
  );
  mismatched.forEach((f) => console.log(`${label(f)}  vs  notion=${f.row.amount}`));

  console.log(`\n❔ ${notFound.length} unpriced row(s) with no price found in mail:`);
  notFound.forEach((r) => console.log(`  ${r.orderId}`));
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
