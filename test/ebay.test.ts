import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEbayOrder, parseEbayLifecycle } from "../src/general/ebay.js";
import { msg } from "./helpers.js";

test("parseEbayOrder: order #, USD total (prefers the 'in USD' line), title", () => {
  const o = parseEbayOrder(
    msg({
      subject: "Order confirmed: Umbreon 092/187 Special Illustration Rare",
      // A foreign-currency charge shows both a local "$" amount and the true USD
      // total; the USD line must win so an INR amount isn't read as dollars.
      body: "Order number 12-34567-89012. Total charged to your card $3,940.46 Total in USD $45.00",
      internalDateMs: Date.parse("2026-02-01"),
    }),
  );
  assert(o);
  assert.equal(o.orderId, "12-34567-89012");
  assert.equal(o.total, 45);
  assert.equal(o.currency, "USD");
  assert.equal(o.merchant, "eBay");
});

test("parseEbayOrder ignores non-confirmation mail", () => {
  assert.equal(
    parseEbayOrder(msg({ subject: "Your item has shipped", body: "12-34567-89012" })),
    null,
  );
});

test("parseEbayLifecycle maps subject phrasing to status", () => {
  assert.equal(
    parseEbayLifecycle(msg({ subject: "Your refund for 12-34567-89012" }))?.status,
    "Returned",
  );
  assert.equal(
    parseEbayLifecycle(msg({ subject: "Order 12-34567-89012 was delivered" }))?.status,
    "Delivered",
  );
  assert.equal(
    parseEbayLifecycle(msg({ subject: "Your order 12-34567-89012 has shipped" }))?.status,
    "Shipped",
  );
  assert.equal(
    parseEbayLifecycle(msg({ subject: "12-34567-89012 leave feedback" })),
    null,
  );
});
