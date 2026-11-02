/**
 * Login abuse without an account (review M2, M3): a request nobody has authenticated can't make the server buffer a big
 * body, and the login throttle stays bounded under a flood of addresses without forgetting a real attacker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-loginabuse-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";

const { setAccount } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");
const { loginAllowed, loginSucceeded, LOGIN_THROTTLE_MAX, throttleSize } = await import("../server/system/auth.js");

const MB = 1024 * 1024;

test("the login route refuses a big body with 413 instead of buffering it", async () => {
  for (const [type, payload] of [
    ["application/octet-stream", Buffer.alloc(5 * MB)],
    ["application/json", JSON.stringify({ username: "x".repeat(900_000), password: "y" })],
    ["application/json", JSON.stringify({ username: "x".repeat(64 * 1024), password: "y" })],
  ] as const) {
    const r = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-animearr": "1", "content-type": type }, payload });
    assert.equal(r.statusCode, 413, `${type} ${payload.length} bytes → ${r.statusCode}`);
  }
  // A normal login still works.
  const ok = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password: "pw-test-1" },
  });
  assert.equal(ok.statusCode, 200, ok.body);
});

test("other routes: the backup-sized limit only applies to the backup upload", async () => {
  // Without a login, the guard answers before any body is read.
  const r = await app.inject({
    method: "POST",
    url: "/api/system/backup/upload",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.alloc(5 * MB),
  });
  assert.equal(r.statusCode, 401);
  // An unknown path doesn't buffer a backup-sized body either.
  const u = await app.inject({
    method: "POST",
    url: "/no/such/route",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.alloc(5 * MB),
  });
  assert.ok([404, 413].includes(u.statusCode), `unknown path → ${u.statusCode}`);
  // Status (the other route reachable without a login) takes no body that matters, and refuses a big one.
  const s = await app.inject({
    method: "GET",
    url: "/api/status",
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.alloc(5 * MB),
  });
  assert.ok([200, 413].includes(s.statusCode));
  // A logged-in backup upload still takes a body far over the 1 MB default (it is read, then refused as not a backup).
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password: "pw-test-1" },
  });
  const cookie = String([login.headers["set-cookie"]].flat()[0]).split(";")[0];
  const up = await app.inject({
    method: "POST",
    url: "/api/system/backup/upload",
    headers: { cookie, "x-animearr": "1", "content-type": "application/octet-stream" },
    payload: Buffer.alloc(5 * MB),
  });
  assert.notEqual(up.statusCode, 413, up.body);
  assert.equal(up.statusCode, 400, up.body);
});

test("the throttle stays bounded under a flood of addresses and never forgets an attacker", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 2, 12) });
  // An attacker with many failures: each attempt waits out the back-off first.
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(16_000);
    assert.equal(loginAllowed("203.0.113.9", "captain"), true);
  }
  assert.equal(loginAllowed("203.0.113.9", "captain"), false, "throttled right after an attempt");
  // A flood of unique addresses (and long user names).
  for (let i = 0; i < LOGIN_THROTTLE_MAX * 2; i++)
    loginAllowed(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, `u${i}${"z".repeat(500)}`);
  assert.ok(throttleSize() <= LOGIN_THROTTLE_MAX, `map holds ${throttleSize()} entries`);
  // The attacker's count survived: past the back-off one more try is allowed, and right after it the next is not.
  t.mock.timers.tick(16_000);
  assert.equal(loginAllowed("203.0.113.9", "captain"), true);
  assert.equal(loginAllowed("203.0.113.9", "captain"), false, "the flood did not reset the attacker's throttle");
  loginSucceeded("203.0.113.9", "captain");
});

test("when the map is full of throttled entries, new ones are refused rather than evicting them", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 3, 12) });
  t.mock.timers.tick(31 * 60_000); // earlier entries expire
  const ip = (i: number) => `10.99.${(i >> 8) & 255}.${i & 255}`;
  // Fill the map with entries that are past their free tries.
  for (let i = 0; i < LOGIN_THROTTLE_MAX; i++) for (let k = 0; k < 6; k++) loginAllowed(`a${i}`, "captain");
  assert.ok(throttleSize() <= LOGIN_THROTTLE_MAX);
  assert.equal(loginAllowed(ip(1), "captain"), false, "a new key is refused while the map is full of throttled entries");
  t.mock.timers.tick(16_000);
  // Existing throttled entries are still there: their next try sets a back-off again.
  assert.equal(loginAllowed("a0", "captain"), true);
  assert.equal(loginAllowed("a0", "captain"), false);
  // Once they expire, new keys are accepted again.
  t.mock.timers.tick(31 * 60_000);
  assert.equal(loginAllowed(ip(2), "captain"), true);
});

test("one address rotating user names gets a few entries, then shares one throttled bucket", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 5, 12) });
  t.mock.timers.tick(31 * 60_000);
  loginAllowed("198.51.100.1", "warmup"); // triggers the sweep of earlier tests' entries
  const before = throttleSize();
  let allowed = 0;
  for (let i = 0; i < 1000; i++) if (loginAllowed("198.51.100.7", `guess${i}`)) allowed++;
  assert.ok(throttleSize() - before <= 20, `one address added ${throttleSize() - before} entries`);
  assert.ok(allowed < 100, `rotating names got ${allowed} tries without back-off`);
  // Another address with the real user name is unaffected.
  assert.equal(loginAllowed("198.51.100.8", "captain"), true);
});
