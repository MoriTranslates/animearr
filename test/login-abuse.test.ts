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
const { loginAllowed, loginSucceeded, LOGIN_THROTTLE_MAX, OWNER_GUESS_BURST, resetOwnerGuessBudget, throttleSize } =
  await import("../server/system/auth.js");

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

test("review A3: a map full of throttled entries neither refuses newcomers nor forgets the throttled", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 3, 12) });
  t.mock.timers.tick(31 * 60_000); // earlier entries expire
  // The reviewer's repro: 10,000 IPv6 /64s (one tunnelbroker /48 has 65,536), each past its free tries.
  const v6 = (i: number) => `2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::1`;
  for (let i = 0; i < LOGIN_THROTTLE_MAX; i++) for (let k = 0; k < 6; k++) loginAllowed(v6(i), "guess");
  assert.ok(throttleSize() <= LOGIN_THROTTLE_MAX);
  // The owner from a fresh address (a new phone, a hotel) still gets in.
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: "198.51.100.77",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password: "pw-test-1" },
  });
  assert.equal(r.statusCode, 200, r.body);
  // The throttled entries were not evicted to make room: their back-off still holds.
  assert.equal(loginAllowed(v6(0), "guess"), false, "still in back-off");
  assert.ok(throttleSize() <= LOGIN_THROTTLE_MAX);
});

test("review R1: with the main table full, guesses at the real user name still back off per address", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 3, 18) });
  t.mock.timers.tick(31 * 60_000);
  resetOwnerGuessBudget();
  const v6 = (i: number) => `2001:db8:9:${(i & 0xffff).toString(16)}::1`;
  for (let i = 0; i < LOGIN_THROTTLE_MAX; i++) for (let k = 0; k < 6; k++) loginAllowed(v6(i), `name${i % 10}`);
  assert.equal(throttleSize(), LOGIN_THROTTLE_MAX, "the main table is full");
  // The reviewer's repro: 200 back-to-back guesses at the real name from one more address.
  let allowed = 0;
  for (let i = 0; i < 200; i++) if (loginAllowed("203.0.113.9", "captain")) allowed++;
  assert.equal(allowed, 6, "5 free tries and one more, then the back-off holds");
});

test("review R1: a global budget bounds guesses at the real user name across all addresses; known devices skip it", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 4, 18) });
  t.mock.timers.tick(31 * 60_000);
  resetOwnerGuessBudget();
  const addr = (i: number) => `100.${(i >> 8) & 255}.${i & 255}.7`;
  let allowed = 0;
  for (let i = 0; i < 1000; i++) if (loginAllowed(addr(i), "captain")) allowed++;
  assert.equal(allowed, OWNER_GUESS_BURST, "a burst, then refused from every address");
  assert.equal(loginAllowed("100.250.0.1", "CAPTAIN"), false, "any spelling of the real name counts");
  assert.equal(loginAllowed("100.250.0.2", "someone-else"), true, "other names aren't in this budget");
  assert.equal(loginAllowed("100.250.0.3", "captain", "known-device-id"), true, "a known device isn't counted");
  t.mock.timers.tick(60_000);
  let later = 0;
  for (let i = 1000; i < 1100; i++) if (loginAllowed(addr(i), "captain")) later++;
  assert.equal(later, 30, "then about 30 a minute");
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
