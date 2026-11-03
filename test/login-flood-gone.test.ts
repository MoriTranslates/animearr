/**
 * Blind review round 2, R6: a login check waiting in the password-check queue still ran scrypt when its turn came,
 * even after the client had given up and disconnected. In a big flood most waiters have timed out by the time they are
 * served, so the queue spent its few slots hashing for nobody and real newcomers waited longer. A waiter whose client
 * is gone now skips the check (it counts as a failed login nobody hears about) and hands its slot straight on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-floodgone-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.TRUST_PROXY;

const { setAccount, getSettings } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { checkPasswordLimited } = await import("../server/system/auth.js");
const stored = getSettings().auth.passwordHash;

test("review R6: a queued check whose client has disconnected is skipped, and the next one is still served", async () => {
  // Two checks take both anonymous slots, so everything after them waits its turn.
  const running = [checkPasswordLimited("x", stored, "203.0.113.1"), checkPasswordLimited("y", stored, "203.0.113.2")];
  const gone = checkPasswordLimited("pw-test-1", stored, "203.0.113.3", { gone: () => true });
  const live = checkPasswordLimited("pw-test-1", stored, "203.0.113.4", { gone: () => false });
  assert.deepEqual(await Promise.all(running), [false, false]);
  assert.equal(await gone, false, "the client left, so no password check was run for it");
  assert.equal(await live, true, "the waiter behind it still gets its turn");
});

test("review R6: a connected client is checked as before, and the slots are all given back", async () => {
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      checkPasswordLimited(i % 2 ? "pw-test-1" : "nope", stored, `203.0.113.${10 + i}`, { gone: () => false }),
    ),
  );
  assert.deepEqual(results, [false, true, false, true, false, true]);
  // Nothing leaked: two fresh checks still start at once and a third still queues and finishes.
  const again = await Promise.all([1, 2, 3].map((i) => checkPasswordLimited("pw-test-1", stored, `203.0.113.${20 + i}`)));
  assert.deepEqual(again, [true, true, true]);
});
