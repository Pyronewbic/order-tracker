import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmount, toUSD } from "../src/money/fx.js";

test("parseAmount handles US and EU/JP separators and bare integers", () => {
  assert.equal(parseAmount("1,234.56"), 1234.56);
  assert.equal(parseAmount("1.234,56"), 1234.56);
  assert.equal(parseAmount("$3,960"), 3960);
  assert.equal(parseAmount("¥1980"), 1980);
  assert.equal(parseAmount("₹499"), 499);
  assert.equal(parseAmount("12"), 12);
  assert.equal(parseAmount("no price here"), null);
});

test("toUSD passes USD through unchanged (no network/cache I/O)", async () => {
  assert.equal(await toUSD(42, "USD", Date.parse("2026-01-01")), 42);
});
