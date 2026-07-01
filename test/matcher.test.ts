import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRow } from "../src/notion/matcher.js";
import { row } from "./helpers.js";

test("containment: a curated shorthand inside a longer email title", () => {
  const rows = [row("Hyrule Historia"), row("Super Mario Odyssey")];
  const m = matchRow("The Legend of Zelda: Hyrule Historia", rows, 0.4);
  assert(m);
  assert.equal(m.row.book, "Hyrule Historia");
});

test("abbreviation expansion (TotK) matches the spelled-out title", () => {
  const m = matchRow("Tears of the Kingdom Master Works", [row("TotK")], 0.4);
  assert(m);
  assert.equal(m.row.book, "TotK");
});

test("fuzzy match tolerates a typo", () => {
  const m = matchRow("Super Mario Odyssy", [row("Super Mario Odyssey")], 0.4);
  assert(m);
  assert.equal(m.row.book, "Super Mario Odyssey");
});

test("returns null when nothing is close enough", () => {
  assert.equal(
    matchRow("Completely Unrelated Widget", [row("Super Mario Odyssey")], 0.4),
    null,
  );
});

test("empty item name or empty row set yields null", () => {
  assert.equal(matchRow("", [row("Some Book Title")], 0.4), null);
  assert.equal(matchRow("anything", [], 0.4), null);
});
