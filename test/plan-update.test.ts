import { test } from "node:test";
import assert from "node:assert/strict";
import { planUpdate } from "../src/pipeline.js";
import { row, update } from "./helpers.js";

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
