/**
 * Blind review round 3, H1: a80a63c (R5) made GET /api/status hand a signed-in session without a device cookie a
 * fresh one. A stolen session cookie could then mint unlimited device cookies; each got its own 5 free tries outside
 * the global real-name budget, they survived logout, and they could fill the shared device lane and the 256-entry
 * device table. The minting is reverted: only a correct password (login or password change) issues a device cookie.
 * R5 (a browser signed in before device cookies existed has none until its next password login) is a documented
 * limit in SECURITY.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-devmint-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.TRUST_PROXY;

const { setAccount, getSettings, endAllSessions } = await import("../server/system/settings.js");
const realPassword = "real-pass-1"; // test-only
await setAccount("captain", realPassword);
const { app } = await import("../server/index.js");
const { COOKIE, DEVICE_COOKIE, makeDevice, makeSession, resetOwnerGuessBudget, OWNER_GUESS_BURST } =
  await import("../server/system/auth.js");

const attacker = "198.51.100.66"; // not the home network, so no bypass
const deviceFrom = (setCookie: string | string[] | undefined) =>
  [setCookie]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split(";")[0])
    .find((c) => c.startsWith(`${DEVICE_COOKIE}=`));
const status = (cookie?: string, extra: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: "/api/status", remoteAddress: attacker, headers: { ...(cookie ? { cookie } : {}), ...extra } });

test("review H1: a session alone never gets a device cookie from /api/status, however often it asks", async () => {
  const stolen = `${COOKIE}=${makeSession("captain")}`;
  const ids = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const r = await status(stolen);
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().loggedIn, true);
    const d = deviceFrom(r.headers["set-cookie"]);
    if (d) ids.add(d);
  }
  assert.equal(ids.size, 0, "no device cookie minted from a session");
  // A stale or forged device cookie isn't replaced either.
  const forged = await status(`${stolen}; ${DEVICE_COOKIE}=forged.123.abc`);
  assert.equal(deviceFrom(forged.headers["set-cookie"]), undefined);
});

test("review H1: after logout, a stolen session leaves nothing that guesses past the global budget", async () => {
  const stolen = `${COOKIE}=${makeSession("captain")}`;
  const devices: string[] = [];
  for (let i = 0; i < 20; i++) {
    const d = deviceFrom((await status(stolen)).headers["set-cookie"]);
    if (d) devices.push(d);
  }
  endAllSessions(); // the owner logs out to kill the stolen session
  resetOwnerGuessBudget();
  const cookieFor = (i: number) => devices[i % Math.max(devices.length, 1)];
  let wrong = 0;
  let throttled = 0;
  for (let k = 0; k < 100; k++) {
    const cookie = cookieFor(k);
    const r = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: attacker,
      headers: { "x-animearr": "1", ...(cookie ? { cookie } : {}) },
      payload: { username: "captain", password: `guess-${k}` },
    });
    if (r.statusCode === 401) wrong++;
    else if (r.statusCode === 429) throttled++;
  }
  assert.ok(throttled > 0, "the guesses are throttled");
  assert.ok(wrong < OWNER_GUESS_BURST, `${wrong} guesses checked; global burst is ${OWNER_GUESS_BURST}`);
});

test("review R5 kept: a session that already has a valid device cookie isn't sent a new one", async () => {
  const r = await status(`${COOKIE}=${makeSession("captain")}; ${DEVICE_COOKIE}=${makeDevice()}`);
  assert.equal(r.statusCode, 200);
  assert.equal(deviceFrom(r.headers["set-cookie"]), undefined);
});

test("review H1: anonymous callers and the API key never get a device cookie from /api/status", async () => {
  const anon = await status();
  assert.equal(anon.json().loggedIn, false);
  assert.equal(deviceFrom(anon.headers["set-cookie"]), undefined, "anonymous");
  const key = await status(undefined, { "x-api-key": getSettings().apiKey });
  assert.equal(key.statusCode, 200);
  assert.equal(key.json().via, "apikey");
  assert.equal(deviceFrom(key.headers["set-cookie"]), undefined, "API key");
});

test("review H1: a correct password login still issues a device cookie", async () => {
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: "198.51.100.90",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password: realPassword },
  });
  assert.equal(r.statusCode, 200);
  assert.ok(deviceFrom(r.headers["set-cookie"]), "login sets the device cookie");
});
