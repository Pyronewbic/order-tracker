import { test } from "node:test";
import assert from "node:assert/strict";
import { detectStatus, extractItemName, parseMessage } from "../src/gmail/parser.js";
import { msg } from "./helpers.js";

test("detectStatus classifies common phrasings", () => {
  assert.equal(detectStatus("Your package has been delivered"), "Delivered");
  assert.equal(detectStatus("Your order has shipped"), "In Transit");
  assert.equal(detectStatus("Out for delivery"), "Arriving Soon");
  assert.equal(detectStatus("Your order has been cancelled"), "Cancelled");
  assert.equal(detectStatus("Your refund has been processed"), "Returned");
  assert.equal(detectStatus("Thank you for your order"), "Ordered");
  assert.equal(detectStatus("newsletter: our favourite reads"), null);
});

test("detectStatus: future delivery beats completed-delivery", () => {
  assert.equal(
    detectStatus("Your order has shipped and will be delivered tomorrow"),
    "Arriving Soon",
  );
});

test("extractItemName pulls titles from Amazon subjects", () => {
  assert.equal(extractItemName('Shipped: "Hyrule Historia"'), "Hyrule Historia");
  assert.equal(
    extractItemName("Your order of Super Mario Bros has shipped"),
    "Super Mario Bros",
  );
  assert.equal(
    extractItemName("Delivered: Metroid Prime Remastered"),
    "Metroid Prime Remastered",
  );
  assert.equal(extractItemName("Your package update"), "");
});

test("parseMessage returns status and extracts the Amazon order number", () => {
  const u = parseMessage(
    msg({
      subject: "Delivered: 1 item | Order # 112-1234567-1234567",
      from: "shipment-tracking@amazon.com",
    }),
  );
  assert(u);
  assert.equal(u.status, "Delivered");
  assert.equal(u.orderId, "112-1234567-1234567");
});

test("parseMessage returns null when no shipping status is present", () => {
  assert.equal(parseMessage(msg({ subject: "your monthly newsletter" })), null);
});
