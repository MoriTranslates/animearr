/**
 * The "no password on my local network" bypass with TRUST_PROXY set, over HTTP against the real app (review M1).
 * The bypass must judge the real client: never a forwarded header from a peer that isn't a listed proxy, never a
 * request through a proxy, never Docker's 172.16/12 or loopback, and never with a hop-count TRUST_PROXY.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-proxy-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.ANIMEARR_LOCAL_NETWORKS;
process.env.TRUST_PROXY = "172.18.0.0/16"; // a list: the reverse proxy's Docker network

const { setAccount, patchSettings } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");

before(() => patchSettings((s) => ({ ...s, auth: { ...s.auth, bypassLocal: true } })));

/** GET /api/settings from a socket peer with extra headers: 200 = let in by the bypass, 401 = must log in. */
async function probe(peer: string, headers: Record<string, string> = {}) {
  const r = await app.inject({
    method: "GET",
    url: "/api/settings",
    remoteAddress: peer,
    headers: { host: "192.168.1.5:8484", ...headers },
  });
  return r.statusCode;
}

test("a LAN device talking to AnimeArr directly still gets the bypass", async () => {
  assert.equal(await probe("192.168.1.10"), 200);
  assert.equal(await probe("10.0.0.7"), 200);
});

test("a LAN peer that sends forwarded headers is not let in, even with a TRUST_PROXY list (another tunnel or proxy)", async () => {
  assert.equal(await probe("192.168.1.10", { "x-forwarded-for": "203.0.113.9" }), 401);
  assert.equal(await probe("192.168.1.10", { forwarded: "for=203.0.113.9" }), 401);
  assert.equal(await probe("192.168.1.10", { "cf-connecting-ip": "203.0.113.9" }), 401);
  assert.equal(await probe("10.0.0.7", { "x-real-ip": "192.168.1.10" }), 401, "a LAN-looking header doesn't help either");
});

test("a listed proxy never gets the bypass, whatever client it forwards", async () => {
  assert.equal(await probe("172.18.0.5", { "x-forwarded-for": "203.0.113.9" }), 401);
  assert.equal(await probe("172.18.0.5", { "x-forwarded-for": "192.168.1.20" }), 401);
  assert.equal(await probe("172.18.0.5"), 401);
});

test("Docker bridge addresses and loopback are never local", async () => {
  assert.equal(await probe("172.17.0.1"), 401);
  assert.equal(await probe("172.20.5.9"), 401);
  assert.equal(await probe("127.0.0.1"), 401);
  assert.equal(await probe("::1"), 401);
});

test("IPv6-mapped addresses are judged as their IPv4 address", async () => {
  assert.equal(await probe("::ffff:192.168.1.10"), 200);
  assert.equal(await probe("::ffff:192.168.1.10", { "x-forwarded-for": "203.0.113.9" }), 401);
  assert.equal(await probe("::ffff:172.17.0.1"), 401);
  assert.equal(await probe("::ffff:127.0.0.1"), 401);
  assert.equal(await probe("::ffff:172.18.0.5", { "x-forwarded-for": "192.168.1.20" }), 401);
});

test("a hop-count TRUST_PROXY switches the bypass off", async () => {
  process.env.TRUST_PROXY = "1";
  try {
    assert.equal(await probe("192.168.1.10"), 401);
    assert.equal(await probe("192.168.1.10", { "x-forwarded-for": "192.168.1.20" }), 401);
  } finally {
    process.env.TRUST_PROXY = "172.18.0.0/16";
  }
});
