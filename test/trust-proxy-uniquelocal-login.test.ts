/**
 * Blind review round 3, M1: since R7 the TRUST_PROXY keywords stand for their whole ranges, so with
 * TRUST_PROXY=uniquelocal every 10/8 and 192.168/16 peer was a "listed proxy". A home browser connecting directly
 * (no forwarded headers) was then refused the default login because no proxy had vouched for it, and a proxy on a
 * Docker network (172.18.x) could never vouch, so a fresh install couldn't be logged into at all.
 * Round 3 loosened that; blind review round 4 (H1, M2) took the loosening back: the default login fails closed. A
 * headerless peer that TRUST_PROXY covers is refused (it may be a TCP forwarder), with a message saying why and what
 * to do, and a proxy on a Docker network never vouches, even when named by its exact IP (it may be Docker's gateway).
 * A home browser that TRUST_PROXY doesn't cover still gets the default login; R7 (no no-password bypass) holds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-r3ul-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.ANIMEARR_LOCAL_NETWORKS;
delete process.env.ANIMEARR_ALLOWED_HOSTS;
process.env.TRUST_PROXY = "uniquelocal";

const { ensureDefaultAccount, setBypassLocal } = await import("../server/system/settings.js");
await ensureDefaultAccount();
const { app } = await import("../server/index.js");

const login = (remoteAddress: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress,
    headers: { "x-animearr": "1", host: "192.168.1.10:8990", ...headers },
    payload: { username: "captain", password: "morebooty" },
  });

const withTrust = async (value: string, fn: () => Promise<void>) => {
  process.env.TRUST_PROXY = value;
  try {
    await fn();
  } finally {
    process.env.TRUST_PROXY = "uniquelocal";
  }
};

test("R4-M2: TRUST_PROXY=uniquelocal, a headerless home peer is refused and told why and what to do", async () => {
  const r = await login("192.168.1.50");
  assert.equal(r.statusCode, 403, r.body);
  assert.match(r.body, /TRUST_PROXY covers this device/, "says why");
  assert.match(r.body, /Set a password first/, "says what to do");
  assert.doesNotMatch(r.body, /192\.168\.1\.50/, "doesn't echo the address");
  assert.equal((await login("10.0.0.7")).statusCode, 403, "10/8 too");
  assert.equal((await login("::ffff:192.168.1.50")).statusCode, 403, "IPv4-mapped spelling");
});

test("R3-M1: a direct home browser TRUST_PROXY doesn't cover gets the default login, with a host name AnimeArr expects", async () => {
  await withTrust("192.168.1.2", async () => {
    assert.equal((await login("192.168.1.51", { host: "evil.example.com" })).statusCode, 403, "unexpected host");
    assert.equal((await login("192.168.1.51")).statusCode, 200, "LAN address as host");
  });
});

test("R3-M1: TRUST_PROXY=uniquelocal, a direct home browser still gets no no-password bypass (R7)", async () => {
  setBypassLocal(true);
  try {
    const r = await app.inject({ method: "GET", url: "/api/shows", remoteAddress: "192.168.1.50", headers: { host: "192.168.1.10:8990" } });
    assert.equal(r.statusCode, 401, "a peer Fastify treats as a proxy is never the user's device");
  } finally {
    setBypassLocal(false);
  }
});

test("R3-M1: Docker's 172.16/12 and loopback inside uniquelocal/loopback never count as a direct home browser", async () => {
  await withTrust("loopback,uniquelocal", async () => {
    for (const peer of ["172.18.0.1", "172.17.0.1", "127.0.0.1", "::1", "fd00::5"])
      assert.equal((await login(peer)).statusCode, 403, `${peer} with no headers`);
  });
});

test("R3-M1: through a Docker proxy with TRUST_PROXY=uniquelocal the login is refused and the message says what to set", async () => {
  const r = await login("172.19.0.7", { "x-forwarded-for": "192.168.1.52" });
  assert.equal(r.statusCode, 403, r.body);
  assert.match(r.body, /Set a password first: open AnimeArr directly/, "the refusal tells the user what to do");
  assert.doesNotMatch(r.body, /172\.19\.0\.7/, "but doesn't show internal addresses to whoever is asking");
  const plain = await login("172.19.0.7");
  assert.doesNotMatch(plain.body, /reverse proxy/, "no proxy hint for a Docker peer that sent no client header");
});

test("R4-H1: a Docker proxy named by its exact IP in TRUST_PROXY no longer vouches (it may be Docker's gateway)", async () => {
  for (const trust of ["uniquelocal,172.18.0.2", "172.18.0.2", "172.18.0.2/32"])
    await withTrust(trust, async () => {
      const r = await login("172.18.0.2", { "x-forwarded-for": "192.168.1.53" });
      assert.equal(r.statusCode, 403, `${trust}: ${r.body}`);
      assert.match(r.body, /Set a password first/, `${trust}: says what to do`);
    });
});

test("R3-M1: the exact-IP proxy still can't vouch for an internet client, and Docker's gateway still can't vouch", async () => {
  await withTrust("uniquelocal,172.18.0.2", async () => {
    assert.equal((await login("172.18.0.2", { "x-forwarded-for": "203.0.113.9" })).statusCode, 403, "internet client via the proxy");
    assert.equal((await login("172.18.0.2", { "x-forwarded-for": "172.18.0.1" })).statusCode, 403, "the gateway as the client");
    assert.equal(
      (await login("172.18.0.2", { "x-forwarded-for": "192.168.1.54, 203.0.113.9" })).statusCode,
      403,
      "only the entry the proxy added counts",
    );
    assert.equal((await login("172.18.0.1", { "x-forwarded-for": "192.168.1.54" })).statusCode, 403, "the gateway with a forged header");
    assert.equal((await login("172.18.0.2")).statusCode, 403, "the named proxy itself, with no client header");
  });
  await withTrust("172.18.0.0/16", async () => {
    assert.equal((await login("172.18.0.2", { "x-forwarded-for": "192.168.1.55" })).statusCode, 403, "a range holds the gateway too");
  });
});

test("R3-M1: loopback named exactly in TRUST_PROXY still can't vouch", async () => {
  for (const trust of ["127.0.0.1", "::1"])
    await withTrust(trust, async () => {
      const peer = trust;
      assert.equal((await login(peer, { "x-forwarded-for": "192.168.1.56" })).statusCode, 403, trust);
    });
});

test("R3-M1: a home proxy named exactly without a client header is not taken as the client", async () => {
  await withTrust("192.168.1.2", async () => {
    const bare = await login("192.168.1.2");
    assert.equal(bare.statusCode, 403, "the named proxy forwarded without X-Forwarded-For");
    assert.match(bare.body, /TRUST_PROXY covers this device/);
    assert.equal((await login("192.168.1.2", { "x-forwarded-for": "192.168.1.57" })).statusCode, 200, "with it, it vouches");
  });
});
