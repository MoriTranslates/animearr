/**
 * Rebuild cache while a plain sync is already running (blind review L2): the full sync must not be swallowed by the
 * running plain one, because held removals are only applied by a full sync. It queues behind the running one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-sync-queue-"));
process.env.ANIMEARR_NO_LOCK = "1";
fs.mkdirSync(path.join(process.env.ANIMEARR_CONFIG, "cache"), { recursive: true });
fs.writeFileSync(path.join(process.env.ANIMEARR_CONFIG, "cache", "anime-list-master.xml"), "<anime-list></anime-list>");

const { syncLibrary, syncRunning } = await import("../server/library/library.js");

test("a full sync asked for during a plain sync runs after it instead of being swallowed", async () => {
  const plain = syncLibrary(false);
  const full = syncLibrary(true);
  assert.notEqual(full, plain, "the full sync must be its own run, not the running plain one");
  const a = await plain;
  const b = await full;
  assert.ok(b.at >= a.at);
  assert.equal(syncRunning(), false);
});

test("asking for the same kind of sync while one runs still shares it", async () => {
  const one = syncLibrary(false);
  assert.equal(syncLibrary(false), one);
  await one;
  const full = syncLibrary(true);
  assert.equal(syncLibrary(true), full);
  assert.equal(syncLibrary(false), full);
  await full;
});
