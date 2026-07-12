import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyItem, tagsFor } from "../src/categorize.js";

/** Build an ItemSignal; item name is the main signal, sender/subject optional. */
const sig = (itemName: string, from = "", subject = ""): { itemName: string; from: string; subject: string } => ({
  itemName,
  from,
  subject,
});

test("classifyItem applies priority: Digital > Accessory > Book > Electronics > Game", () => {
  // Digital wins on a digital sender even when the name reads game-y.
  assert.equal(classifyItem(sig("Zelda TotK", "digital-no-reply@amazon.co.jp")), "Digital");
  // Accessory beats Game ("case … Zelda amiibo" is an accessory, not a game).
  assert.equal(classifyItem(sig("Carrying case for Zelda amiibo")), "Accessory");
  // Book beats Game (a strategy guide is a Book even for a game franchise).
  assert.equal(classifyItem(sig("The Legend of Zelda strategy guide")), "Book");
  // Electronics beats Game.
  assert.equal(classifyItem(sig("Samsung 2TB NVMe SSD")), "Electronics");
  // Game only when nothing more specific matches.
  assert.equal(classifyItem(sig("The Legend of Zelda: Tears of the Kingdom")), "Game");
});

test("classifyItem returns null when nothing matches confidently", () => {
  assert.equal(classifyItem(sig("Generic Widget 3000")), null);
});

test("classifyItem detects digital goods from body text, not just the sender", () => {
  assert.equal(classifyItem(sig("Nintendo eShop online code")), "Digital");
});

test("tagsFor extracts franchise + attribute tags", () => {
  const tags = tagsFor(
    sig("The Legend of Zelda: TotK — Collector's Edition (preorder)"),
  );
  assert(tags.includes("Zelda"));
  assert(tags.includes("Limited Edition"));
  assert(tags.includes("Preorder"));
});

test("tagsFor tags amiibo and the Switch 2 platform", () => {
  const tags = tagsFor(sig("amiibo Mario", "", "for Nintendo Switch 2"));
  assert(tags.includes("Mario"));
  assert(tags.includes("amiibo"));
  assert(tags.includes("Switch 2"));
});

test("tagsFor is empty for an untagged generic item", () => {
  assert.deepEqual(tagsFor(sig("Generic Widget 3000")), []);
});
