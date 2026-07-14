import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planUpdate,
  planAccessoryReclaim,
  orderNumberKey,
  findAccessoryByOrder,
} from "../src/pipeline.js";
import type { GeneralRow } from "../src/general/notion.js";
import type { AccessoryRow } from "../src/accessories/notion.js";
import { row, update } from "./helpers.js";

const gRow = (priced: boolean): GeneralRow => ({
  pageId: "g1",
  orderId: "111-1",
  status: "Shipped",
  priced,
});

const aRow = (orderId: string): AccessoryRow => ({
  pageId: `p-${orderId}`,
  orderId,
  status: "Ordered",
});

test("advances only along the monotonic progress ladder", () => {
  assert.equal(
    planUpdate(row("X", { status: "Ordered" }), update("In Transit")),
    "apply",
  );
  assert.equal(
    planUpdate(row("X", { status: "Delivered" }), update("In Transit")),
    "regress",
  );
  assert.equal(
    planUpdate(row("X", { status: "In Transit" }), update("In Transit")),
    "noop",
  );
});

test("terminal, protected, and delayed transitions", () => {
  // Terminal can be set from a live state, but nothing supersedes it.
  assert.equal(
    planUpdate(row("X", { status: "Delivered" }), update("Returned")),
    "apply",
  );
  assert.equal(
    planUpdate(row("X", { status: "Cancelled" }), update("In Transit")),
    "regress",
  );
  // User-managed statuses are never overwritten by a shipment email.
  assert.equal(
    planUpdate(row("X", { status: "To Reorder" }), update("In Transit")),
    "regress",
  );
  // Delayed can be set from an active state, not after Delivered; progress supersedes it.
  assert.equal(
    planUpdate(row("X", { status: "In Transit" }), update("Delayed")),
    "apply",
  );
  assert.equal(
    planUpdate(row("X", { status: "Delivered" }), update("Delayed")),
    "regress",
  );
  assert.equal(
    planUpdate(row("X", { status: "Delayed" }), update("Arriving Soon")),
    "apply",
  );
});

test("planAccessoryReclaim: reclaim unpriced placeholders, keep priced purchases", () => {
  // No general row for this order → the accessory pass just creates/advances.
  assert.equal(planAccessoryReclaim(undefined), "none");
  // A priced general row is a real purchase → leave it in General, don't duplicate.
  assert.equal(planAccessoryReclaim(gRow(true)), "keep-general");
  // An unpriced E3 placeholder (truncated shipping subject filed it in General
  // before the confirmation revealed it was an accessory) → reclaim it.
  assert.equal(planAccessoryReclaim(gRow(false)), "reclaim");
});

test("orderNumberKey reduces store-namespaced / bare order numbers to one key", () => {
  assert.equal(orderNumberKey("eXtremeRate #95413"), "95413");
  assert.equal(orderNumberKey("95413"), "95413");
  assert.equal(orderNumberKey("#95413"), "95413");
  assert.equal(orderNumberKey("  ShopName #95413 "), "95413");
  // Amazon ids carry no "#", so they key to themselves (never a bare-number collision).
  assert.equal(orderNumberKey("171-6487940-6092366"), "171-6487940-6092366");
});

test("findAccessoryByOrder dedups a manual/bare row against a Shopify-namespaced id", () => {
  // The dupe bug: daemon keys "eXtremeRate #95413"; a manual row used "95413".
  const orders = new Map<string, AccessoryRow>([["95413", aRow("95413")]]);
  // Exact miss, but the normalized order number reconciles them → advance in place.
  assert.equal(findAccessoryByOrder(orders, "eXtremeRate #95413")?.orderId, "95413");
  // Exact match still wins.
  assert.equal(findAccessoryByOrder(orders, "95413")?.orderId, "95413");
  // A different order does not false-match.
  assert.equal(findAccessoryByOrder(orders, "eXtremeRate #99999"), undefined);
  // An unrelated Amazon id never collides with a bare Shopify number.
  const amz = new Map<string, AccessoryRow>([
    ["171-6487940-6092366", aRow("171-6487940-6092366")],
  ]);
  assert.equal(findAccessoryByOrder(amz, "eXtremeRate #95413"), undefined);
});
