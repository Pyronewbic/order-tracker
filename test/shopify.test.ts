import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShopifyOrder } from "../src/general/shopify.js";
import { techAccessoryCategory } from "../src/categorize.js";
import { msg } from "./helpers.js";

// A representative eXtremeRate (Shopify storefront) order-confirmation body: the
// "Order summary" block with a Shipping-Protection add-on, three line items each
// as "<name> × <qty> [SKU] $<price>", then the totals with a currency-suffixed
// Total line.
const EXTREMERATE_BODY =
  "Thank you for your purchase! eXtremeRate Retail ( https://www.extremerate.com?syclid=abc ) " +
  "Order #95371 View your order ( https://www.extremerate.com/63303811322/orders/deadbeef/authenticate?key=xyz ) " +
  "Order summary ------------- " +
  "Shipping Protection × 1 S003 $1.75 " +
  "eXtremeRate DIY Replacement Full Set Shells with Buttons for Nintendo Switch 2 - Deluxe Version - The Great Wave × 1 $48.99 " +
  "eXtremeRate DIY Replacement Full Set Buttons for Nintendo Switch 2 - Blue & Orange × 1 $18.99 " +
  "eXtremeRate Replacement Decorative Strips for Joycon 2 of Nintendo Switch 2 - Blue & Orange × 1 $9.99 " +
  "Subtotal $79.72 Shipping $0.00 Taxes $0.00 Total $79.72 USD";

function extremerate(partial = {}) {
  return msg({
    from: "eXtremeRate Retail <store+63303811322@t.shopifyemail.com>",
    subject: "Order #95371 confirmed",
    body: EXTREMERATE_BODY,
    ...partial,
  });
}

test("parseShopifyOrder reads store, namespaced order key, total, and currency", () => {
  const o = parseShopifyOrder(extremerate());
  assert.ok(o);
  assert.equal(o.merchant, "eXtremeRate"); // "Retail" suffix dropped
  assert.equal(o.orderId, "eXtremeRate #95371"); // store-namespaced (not just "95371")
  assert.equal(o.total, 79.72); // the Total line, not the $48.99 dominant item
  assert.equal(o.currency, "USD"); // from the ISO suffix on the Total line
  assert.equal(o.orderUrl, "https://www.extremerate.com"); // first non-Shopify link, query stripped
});

test("parseShopifyOrder picks the dominant item and excludes the shipping add-on", () => {
  const o = parseShopifyOrder(extremerate())!;
  assert.match(o.dominantItem, /Full Set Shells with Buttons/); // highest-priced real item
  assert.equal(o.itemCount, 3); // Shipping Protection is not counted as an item
  assert.ok(!o.itemNames.some((n) => /Shipping Protection/i.test(n)));
});

test("the dominant shell item routes to the Accessories DB as Case/Carry", () => {
  const o = parseShopifyOrder(extremerate())!;
  assert.equal(
    techAccessoryCategory({ itemName: o.dominantItem, from: "", subject: "" }),
    "Case/Carry",
  );
});

test("parseShopifyOrder ignores non-Shopify senders", () => {
  assert.equal(parseShopifyOrder(extremerate({ from: "auto-confirm@amazon.in" })), null);
});

test("parseShopifyOrder returns null without an order number", () => {
  assert.equal(parseShopifyOrder(extremerate({ subject: "Your order shipped" })), null);
});

test("parseShopifyOrder skips a non-dollar total rather than mis-valuing it", () => {
  // An INR storefront renders "Total ₹7,983.69 INR" — no "$", so it's skipped.
  const o = parseShopifyOrder(
    extremerate({
      body: EXTREMERATE_BODY.replace("Total $79.72 USD", "Total ₹7,983.69 INR"),
    }),
  );
  assert.equal(o, null);
});
