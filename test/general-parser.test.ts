import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOrderEmail } from "../src/general/parser.js";
import { msg } from "./helpers.js";

test("parseOrderEmail reads a single Amazon order (merchant, item, total, currency)", () => {
  const orders = parseOrderEmail(
    msg({
      from: "auto-confirm@amazon.in",
      body: "Order # 112-1234567-1234567 * UGREEN USB-C Hub Quantity: 1 2,700.90 INR Total: 2,700.90 INR",
    }),
  );
  assert.equal(orders.length, 1);
  const o = orders[0]!;
  assert.equal(o.orderId, "112-1234567-1234567");
  assert.equal(o.merchant, "Amazon IN");
  assert.equal(o.dominantItem, "UGREEN USB-C Hub");
  assert.equal(o.itemCount, 1);
  assert.equal(o.total, 2700.9);
  assert.equal(o.currency, "INR");
});

test("parseOrderEmail splits multiple orders and picks the dominant item", () => {
  const orders = parseOrderEmail(
    msg({
      from: "digital-no-reply@amazon.co.jp",
      body:
        "Order # 249-1111111-2222222 " +
        "* Cheap Sticker Quantity: 1 500 JPY " +
        "* Xenoblade Art Book Quantity: 1 5896 JPY " +
        "Total: 6396 JPY " +
        "Order # 250-3333333-4444444 " +
        "* Single Item Quantity: 2 1200 JPY Total: 1200 JPY",
    }),
  );
  assert.equal(orders.length, 2);
  // Dominant item is the highest-priced line in the first order.
  assert.equal(orders[0]!.dominantItem, "Xenoblade Art Book");
  assert.equal(orders[0]!.itemCount, 2);
  assert.equal(orders[0]!.currency, "JPY");
  assert.equal(orders[0]!.total, 6396);
  assert.equal(orders[1]!.orderId, "250-3333333-4444444");
});

test("parseOrderEmail returns [] for a non-order email", () => {
  assert.deepEqual(
    parseOrderEmail(msg({ subject: "your weekly deals", body: "big savings" })),
    [],
  );
});

test("parseOrderEmail skips an order block with no parseable total", () => {
  const orders = parseOrderEmail(
    msg({
      body: "Order # 112-0000000-0000000 * Some Item Quantity: 1 (price on site) USD",
    }),
  );
  assert.deepEqual(orders, []);
});
