import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accessoryStatusFromGeneral,
  accessoryStatusFromShipment,
  planAccessoryUpdate,
} from "../src/accessories/notion.js";

test("shipment status maps onto the accessory delivery ladder", () => {
  assert.equal(accessoryStatusFromShipment("Ordered"), "Ordered");
  assert.equal(accessoryStatusFromShipment("In Transit"), "Shipped");
  assert.equal(accessoryStatusFromShipment("Arriving Soon"), "Arriving");
  assert.equal(accessoryStatusFromShipment("Delivered"), "Owned");
  assert.equal(accessoryStatusFromShipment("Cancelled"), "Cancelled");
});

test("general lifecycle status maps onto the accessory ladder", () => {
  assert.equal(accessoryStatusFromGeneral("Ordered"), "Ordered");
  assert.equal(accessoryStatusFromGeneral("Shipped"), "Shipped");
  assert.equal(accessoryStatusFromGeneral("Delivered"), "Owned");
  assert.equal(accessoryStatusFromGeneral("Returned"), "Cancelled");
});

test("planAccessoryUpdate advances monotonically and protects terminal/owned/wishlist", () => {
  assert.equal(planAccessoryUpdate("Ordered", "Shipped"), "apply");
  assert.equal(planAccessoryUpdate("Shipped", "Arriving"), "apply");
  assert.equal(planAccessoryUpdate("Arriving", "Owned"), "apply");
  // Same status is a no-op; a backward move is a regression.
  assert.equal(planAccessoryUpdate("Shipped", "Shipped"), "noop");
  assert.equal(planAccessoryUpdate("Arriving", "Shipped"), "regress");
  // Owned is in-hand; a stale email can't move it. Cancel can come from a live state.
  assert.equal(planAccessoryUpdate("Owned", "Shipped"), "regress");
  assert.equal(planAccessoryUpdate("Shipped", "Cancelled"), "apply");
  // A manual Wishlist row is never touched by the tracker.
  assert.equal(planAccessoryUpdate("Wishlist", "Shipped"), "regress");
});
