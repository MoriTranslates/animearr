/**
 * Junk logins can't lock the owner out (follow-up to review M3, found while porting the scheme to Tastearr). Behind a
 * proxy every client can share one address; junk user names from it used to take the 10 own-entry slots, so the real
 * user name landed in the address's throttled shared bucket. Now the account's own name always keeps its own entry,
 * and its password check has its own lane, so a burst of junk logins can't queue in front of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-ownerlane-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.TRUST_PROXY;

const { setAccount } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");

const login = (peer: string, username: string, password: string) =>
  app
    .inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: peer,
      headers: { "x-animearr": "1" },
      payload: { username, password },
    })
    .then((r) => r.statusCode);

test("junk user names from one address can't lock the owner out", async () => {
  const proxy = "198.51.100.40"; // everyone behind one proxy shares it
  const codes: number[] = [];
  for (let i = 0; i < 20; i++) codes.push(await login(proxy, `junk${i}`, "nope"));
  assert.ok(codes.includes(429), "the junk names did end up throttled");
  assert.equal(await login(proxy, "captain", "pw-test-1"), 200, "the owner still gets in from the same address");
});

test("control: guessing the real user name is still throttled on its own entry", async () => {
  const attacker = "198.51.100.41";
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push(await login(attacker, "captain", `guess${i}`));
  assert.deepEqual(codes.slice(0, 6), [401, 401, 401, 401, 401, 401]);
  assert.equal(codes[6], 429, "the 7th guess waits out the back-off");
  assert.equal(await login(attacker, "captain", "pw-test-1"), 429, "even the right password waits while throttled");
});

test("a burst of junk logins is capped, and the owner's check has its own lane", async () => {
  const junk = Array.from({ length: 60 }, (_, i) => login(`203.0.113.${i + 1}`, `burst${i}`, "nope"));
  const owner = login("203.0.113.200", "captain", "pw-test-1");
  const [codes, own] = await Promise.all([Promise.all(junk), owner]);
  assert.ok(codes.includes(429), "past the queue, junk checks are refused instead of piling up");
  assert.ok(codes.every((c) => c === 401 || c === 429));
  assert.equal(own, 200, "the owner isn't stuck behind the junk queue");
});
