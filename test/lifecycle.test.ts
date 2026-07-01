import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planGeneralUpdate,
  parseLifecycleEmail,
  isTerminalGeneralStatus,
} from "../src/general/lifecycle.js";
import { msg } from "./helpers.js";

test("planGeneralUpdate: ladder advances, terminals lock", () => {
  assert.equal(planGeneralUpdate("Ordered", "Shipped"), "apply");
  assert.equal(planGeneralUpdate("Shipped", "Ordered"), "regress");
  assert.equal(planGeneralUpdate("Ordered", "Ordered"), "noop");
  assert.equal(planGeneralUpdate("Ordered", "Cancelled"), "apply");
  assert.equal(planGeneralUpdate("Cancelled", "Delivered"), "regress");
  assert.equal(planGeneralUpdate("Delivered", "Returned"), "apply");
  assert.equal(planGeneralUpdate("", "Ordered"), "apply");
});

test("isTerminalGeneralStatus", () => {
  assert.equal(isTerminalGeneralStatus("Cancelled"), true);
  assert.equal(isTerminalGeneralStatus("Returned"), true);
  assert.equal(isTerminalGeneralStatus("Shipped"), false);
});

test("parseLifecycleEmail reads order # + status, most-terminal first", () => {
  const d = parseLifecycleEmail(
    msg({ subject: "Delivered: 1 item, Order # 112-1234567-1234567" }),
  );
  assert(d);
  assert.deepEqual(d, { orderId: "112-1234567-1234567", status: "Delivered" });

  const r = parseLifecycleEmail(
    msg({ subject: "Your refund for order 112-1234567-1234567 is complete" }),
  );
  assert(r);
  assert.equal(r.status, "Returned");
});

test("parseLifecycleEmail returns null without an order # or status", () => {
  assert.equal(
    parseLifecycleEmail(msg({ subject: "Shipped soon", body: "no order number" })),
    null,
  );
  assert.equal(
    parseLifecycleEmail(
      msg({ subject: "Problem during shipping, order 112-1234567-1234567" }),
    ),
    null,
  );
});
