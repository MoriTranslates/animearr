/**
 * Junk logins can't lock the owner out (follow-up to review M3, found while porting the scheme to Tastearr). Behind a
 * proxy every client can share one address; junk user names from it used to take the 10 own-entry slots, so the real
 * user name landed in the address's throttled shared bucket. Now the account's own name always keeps its own entry.
 * Password checks run a few at a time, shared fairly between addresses (blind review B4: a lane picked by the user
 * name in the request was easy to fill, since the name isn't secret), with addresses the owner logged in from served
 * first and signed-in requests never queued behind anonymous ones (B7).
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
const { DEVICE_COOKIE, validDevice } = await import("../server/system/auth.js");

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

test("review A4: a successful login clears the address's shared back-off", async () => {
  const proxy = "198.51.100.42";
  for (let i = 0; i < 20; i++) await login(proxy, `junk${i}`, "nope");
  assert.equal(await login(proxy, "someone-new", "nope"), 429, "new names from the address are in back-off");
  assert.equal(await login(proxy, "captain", "pw-test-1"), 200);
  assert.equal(await login(proxy, "someone-else", "nope"), 401, "after a real login the address starts fresh");
});

test("control: guessing the real user name is still throttled on its own entry", async () => {
  const attacker = "198.51.100.41";
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push(await login(attacker, "captain", `guess${i}`));
  assert.deepEqual(codes.slice(0, 6), [401, 401, 401, 401, 401, 401]);
  assert.equal(codes[6], 429, "the 7th guess waits out the back-off");
  assert.equal(await login(attacker, "captain", "pw-test-1"), 429, "even the right password waits while throttled");
});

test("review B4: a flood naming the real user from 30 addresses can't refuse the owner", async () => {
  // The reviewer's repro: 30 concurrent logins as captain/<random> from 30 addresses, then the owner from a fresh one.
  const flood = Array.from({ length: 30 }, (_, i) => login(`192.0.2.${i + 1}`, "captain", `random${i}`));
  const owner = login("192.0.2.200", "captain", "pw-test-1");
  const [codes, own] = await Promise.all([Promise.all(flood), owner]);
  assert.ok(
    codes.every((c) => c === 401),
    `the flood is answered, not refused: ${[...new Set(codes)]}`,
  );
  assert.equal(own, 200, "the owner gets in");
});

test("a browser the owner logged in with before (device cookie) is served ahead of a flood, from any address", async () => {
  const first = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: "198.18.0.7",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password: "pw-test-1" },
  });
  const device = [first.headers["set-cookie"]]
    .flat()
    .map((c) => String(c).split(";")[0])
    .find((c) => c.startsWith(`${DEVICE_COOKIE}=`));
  assert.ok(device, "a device cookie is set on login");
  const done: string[] = [];
  // Records finished password checks only (401 = checked and wrong, 200 = the owner); instant 429 refusals don't count.
  const track = (p: Promise<number>, tag: string) => p.then((c) => (c !== 429 && done.push(tag), c));
  // The flood names the real user, from 30 addresses and from the very address the owner is now behind.
  const shared = "198.18.1.250";
  const flood = [
    ...Array.from({ length: 30 }, (_, i) => login(`198.18.1.${i + 1}`, "captain", `x${i}`)),
    ...Array.from({ length: 12 }, (_, i) => login(shared, "captain", `z${i}`)),
  ].map((p) => track(p, "flood"));
  await new Promise((r) => setImmediate(r)); // the flood is queued first
  const owner = track(
    app
      .inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: shared,
        headers: { "x-animearr": "1", cookie: device },
        payload: { username: "captain", password: "pw-test-1" },
      })
      .then((r) => r.statusCode),
    "owner",
  );
  const [, own] = await Promise.all([Promise.all(flood), owner]);
  assert.equal(own, 200, "throttled and queued on its own, not with the address it shares");
  // Its own lane: at most the checks already running when it arrived finish first, not the ~34 queued ones.
  assert.ok(done.indexOf("owner") <= 4, `served after ${done.indexOf("owner")} of ${done.length - 1} flood checks`);
  // A password change voids every device cookie (it is signed with the settings secret).
  const id = validDevice(device.split("=")[1]);
  assert.ok(id);
  await setAccount("captain", "pw-test-1");
  assert.equal(validDevice(device.split("=")[1]), null);
});

test("one address can't queue without limit: its extra checks are refused, other addresses aren't", async () => {
  const many = Array.from({ length: 20 }, (_, i) => login("198.18.2.9", `name${i}`, "nope"));
  const other = login("198.18.2.10", "captain", "pw-test-1");
  const [codes, own] = await Promise.all([Promise.all(many), other]);
  assert.ok(codes.includes(429), "past its share, one address gets 'too many at once'");
  assert.equal(own, 200);
});

test("review B7: a signed-in password change isn't queued behind anonymous logins", async () => {
  const cookieRes = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: "198.18.3.1",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password: "pw-test-1" },
  });
  const cookie = String([cookieRes.headers["set-cookie"]].flat()[0]).split(";")[0];
  const flood = Array.from({ length: 30 }, (_, i) => login(`198.18.4.${i + 1}`, "captain", `y${i}`));
  const change = app.inject({
    method: "PUT",
    url: "/api/auth/account",
    remoteAddress: "198.18.3.1",
    headers: { cookie, "x-animearr": "1" },
    payload: { currentPassword: "pw-test-1", password: "pw-test-9-xx" },
  });
  const [, r] = await Promise.all([Promise.all(flood), change]);
  assert.equal(r.statusCode, 200, r.body);
  await setAccount("captain", "pw-test-1");
});
