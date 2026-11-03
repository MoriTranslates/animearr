/**
 * Blind review round 2, R5: a browser that was already signed in when the device cookie arrived had a session cookie
 * and no device cookie, so once that session ended during a flood the owner was in the anonymous lane. A signed-in
 * browser session now gets a device cookie on /api/status (the app asks for it on every load) when it has no valid
 * one. The API key, the home-network bypass and anonymous callers never get one: only a password login proves it's
 * the owner's browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-devupgrade-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.TRUST_PROXY;

const { setAccount, getSettings } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");
const { COOKIE, DEVICE_COOKIE, makeDevice, makeSession, validDevice } = await import("../server/system/auth.js");

const peer = "198.51.100.77"; // not the home network, so no bypass
const deviceFrom = (setCookie: string | string[] | undefined) =>
  [setCookie]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split(";")[0])
    .find((c) => c.startsWith(`${DEVICE_COOKIE}=`));
const status = (cookie?: string, extra: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: "/api/status", remoteAddress: peer, headers: { ...(cookie ? { cookie } : {}), ...extra } });

test("review R5: a signed-in session without a device cookie gets one on /api/status", async () => {
  const r = await status(`${COOKIE}=${makeSession("captain")}`);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().loggedIn, true);
  const device = deviceFrom(r.headers["set-cookie"]);
  assert.ok(device, "a device cookie is issued");
  assert.ok(validDevice(device.slice(DEVICE_COOKIE.length + 1)), "and it is valid");
  const raw = [r.headers["set-cookie"]].flat().find((c) => String(c).startsWith(`${DEVICE_COOKIE}=`));
  assert.match(String(raw), /HttpOnly/i);
  assert.match(String(raw), /SameSite=Strict/i);
});

test("review R5: a session that already has a valid device cookie isn't sent a new one", async () => {
  const dev = makeDevice();
  const r = await status(`${COOKIE}=${makeSession("captain")}; ${DEVICE_COOKIE}=${dev}`);
  assert.equal(r.statusCode, 200);
  assert.equal(deviceFrom(r.headers["set-cookie"]), undefined);
});

test("review R5: a session with a stale or forged device cookie gets a fresh valid one", async () => {
  const r = await status(`${COOKIE}=${makeSession("captain")}; ${DEVICE_COOKIE}=forged.123.abc`);
  const device = deviceFrom(r.headers["set-cookie"]);
  assert.ok(device && validDevice(device.slice(DEVICE_COOKIE.length + 1)));
});

test("review R5: anonymous callers and the API key never get a device cookie", async () => {
  const anon = await status();
  assert.equal(anon.json().loggedIn, false);
  assert.equal(deviceFrom(anon.headers["set-cookie"]), undefined, "anonymous");
  const forgedSession = await status(`${COOKIE}=not-a-session`);
  assert.equal(deviceFrom(forgedSession.headers["set-cookie"]), undefined, "bad session");
  const key = await status(undefined, { "x-api-key": getSettings().apiKey });
  assert.equal(key.statusCode, 200);
  assert.equal(key.json().via, "apikey");
  assert.equal(deviceFrom(key.headers["set-cookie"]), undefined, "API key");
});
