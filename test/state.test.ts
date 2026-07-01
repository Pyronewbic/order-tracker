import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, rm } from "node:fs/promises";
import { loadState } from "../src/state.js";

test("migrates a legacy single-account state file into the 'default' account", async () => {
  const f = join(tmpdir(), `tracker-state-test-${process.pid}.json`);
  await writeFile(f, JSON.stringify({ lastProcessedMs: 123, subscriptionLastMs: 45 }));
  try {
    const s = await loadState(f);
    assert.equal(s.accounts.default?.lastProcessedMs, 123);
    assert.equal(s.accounts.default?.subscriptionLastMs, 45);
    assert.deepEqual(s.links, {});
    assert.deepEqual(s.orderLinks, {});
  } finally {
    await rm(f, { force: true });
  }
});

test("an absent state file yields an empty, fully-defaulted state", async () => {
  const s = await loadState(join(tmpdir(), `tracker-missing-${process.pid}.json`));
  assert.deepEqual(s.accounts, {});
  assert.deepEqual(s.links, {});
  assert.deepEqual(s.orderLinks, {});
  assert.deepEqual(s.subscriptions, {});
});
