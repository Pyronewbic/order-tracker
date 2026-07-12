import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectStatus,
  extractItemName,
  parseMessage,
  resolveEtaMs,
} from "../src/gmail/parser.js";
import { msg } from "./helpers.js";

const ANCHOR = Date.parse("2026-01-15T00:00:00Z"); // a Thursday
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

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

test("resolveEtaMs reads absolute and relative delivery dates", () => {
  assert.equal(isoDay(resolveEtaMs("Arriving Jan 20", ANCHOR)!), "2026-01-20");
  assert.equal(isoDay(resolveEtaMs("Expected delivery: 3 February", ANCHOR)!), "2026-02-03");
  assert.equal(isoDay(resolveEtaMs("will be delivered tomorrow", ANCHOR)!), "2026-01-16");
  assert.equal(isoDay(resolveEtaMs("Out for delivery today", ANCHOR)!), "2026-01-15");
  // Thursday Jan 15 → next Monday is the 19th.
  assert.equal(isoDay(resolveEtaMs("Estimated delivery Monday", ANCHOR)!), "2026-01-19");
  // A date-only range ("Delivers Jul 17 – Jul 21") takes the start.
  const jul = Date.parse("2026-07-04T00:00:00Z");
  assert.equal(isoDay(resolveEtaMs("Delivers Jul 17 – Jul 21 by Standard", jul)!), "2026-07-17");
});

test("resolveEtaMs returns undefined for no or implausible dates", () => {
  assert.equal(resolveEtaMs("Out for delivery", ANCHOR), undefined); // cue, no date
  assert.equal(resolveEtaMs("your order has shipped", ANCHOR), undefined); // no date
  assert.equal(resolveEtaMs("was delivered on Jan 3", ANCHOR), undefined); // past → rejected
  assert.equal(resolveEtaMs("a shop we've loved since 1999", ANCHOR), undefined); // no cue
});

test("parseMessage attaches a parsed ETA for in-motion mail", () => {
  const u = parseMessage(
    msg({ subject: "Arriving tomorrow: Super Mario Bros", from: "shipment-tracking@amazon.com" }),
  );
  assert(u);
  assert.equal(u.status, "Arriving Soon");
  assert.equal(isoDay(u.etaMs!), "2026-01-16");
  assert.equal(u.deliveredMs, undefined);
});

test("parseMessage records a Delivered date, not an ETA", () => {
  const u = parseMessage(msg({ subject: "Delivered: Super Mario Bros" }));
  assert(u);
  assert.equal(u.status, "Delivered");
  assert.equal(u.etaMs, undefined);
  assert.equal(isoDay(u.deliveredMs!), "2026-01-15");
});
