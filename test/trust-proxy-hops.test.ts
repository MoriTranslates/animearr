/**
 * A fresh install behind a reverse proxy configured with a hop count (TRUST_PROXY=1), over HTTP (review L2, then A1 of
 * the blind review of the auth branch). Since blind review round 5 (H1) the default login is off whenever TRUST_PROXY
 * is set: no proxy can vouch for the client it reports, since a TCP forwarder passes a forged X-Forwarded-For through.
 * The refusal says to remove TRUST_PROXY while setting a password (review L1). The no-password bypass stays off, and a
 * changed password works through the proxy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-hops-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.ANIMEARR_LOCAL_NETWORKS;
delete process.env.ANIMEARR_ALLOWED_HOSTS;
process.env.TRUST_PROXY = "1";

const { ensureDefaultAccount, patchSettings, setAccount } = await import("../server/system/settings.js");
await ensureDefaultAccount();
const { app } = await import("../server/index.js");

const PROXY = "192.168.1.2"; // the reverse proxy on another machine in the home network
const login = (peer: string, headers: Record<string, string>, password = "morebooty") =>
  app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: peer,
    headers: { host: "192.168.1.5:8484", "x-animearr": "1", ...headers },
    payload: { username: "captain", password },
  });

test("R5-H1: with a hop count, the default login is refused even through a proxy on the home network", async () => {
  const r = await login(PROXY, { "x-forwarded-for": "192.168.1.20" });
  assert.equal(r.statusCode, 403, r.body);
  assert.match(r.body, /Set a password first: remove TRUST_PROXY/, "advice that works with a hop count (review L1)");
  const direct = await login("192.168.1.21", {});
  assert.equal(direct.statusCode, 403, "a direct home browser too: a hop count covers every peer");
  assert.match(direct.body, /remove TRUST_PROXY/);
});

test("review A1: a forged X-Forwarded-For through Docker's gateway gets no default login", async () => {
  // The reviewer's repro: an internet attacker reaches the published port directly; the peer shows as the gateway.
  const r = await login("172.17.0.1", { "x-forwarded-for": "192.168.1.20", host: "203.0.113.50" });
  assert.equal(r.statusCode, 403, r.body);
  for (const peer of ["172.18.0.5", "fd00:dead:beef::1", "127.0.0.1", "::1", "::ffff:172.17.0.1"])
    assert.equal((await login(peer, { "x-forwarded-for": "192.168.1.20" })).statusCode, 403, `${peer} can't vouch for a client`);
});

test("review A1: a hop count above the real number of proxies doesn't let the client pick its address", async () => {
  process.env.TRUST_PROXY = "2";
  try {
    // One real proxy: it appended the attacker's real address; the attacker supplied the entry before it.
    const r = await login(PROXY, { "x-forwarded-for": "192.168.1.20, 203.0.113.9" });
    assert.equal(r.statusCode, 403, r.body);
  } finally {
    process.env.TRUST_PROXY = "1";
  }
});

test("R5-H1: a proxy on a Docker network listed as home still gets no default login", async () => {
  process.env.ANIMEARR_LOCAL_NETWORKS = "192.168.0.0/16,172.18.0.0/16";
  try {
    assert.equal((await login("172.18.0.5", { "x-forwarded-for": "192.168.1.20" })).statusCode, 403);
    assert.equal((await login("172.17.0.1", { "x-forwarded-for": "192.168.1.20" })).statusCode, 403, "other Docker ranges neither");
  } finally {
    delete process.env.ANIMEARR_LOCAL_NETWORKS;
  }
});

test("the default login stays refused for clients outside the home network", async () => {
  const internet = await login(PROXY, { "x-forwarded-for": "203.0.113.9" });
  assert.equal(internet.statusCode, 403, "the proxy reports an internet client");
  const forged = await login("203.0.113.9", { "x-forwarded-for": "192.168.1.20" });
  assert.equal(forged.statusCode, 403, "a direct internet peer can't claim a LAN address");
  const docker = await login(PROXY, { "x-forwarded-for": "172.17.0.1" });
  assert.equal(docker.statusCode, 403, "a Docker gateway as the client isn't home");
  const chain = await login(PROXY, { "x-forwarded-for": "192.168.1.20, 203.0.113.9" });
  assert.equal(chain.statusCode, 403, "only the address the proxy itself added counts");
});

test("R5-H1: an allowed host name doesn't bring the default login back through the proxy", async () => {
  process.env.ANIMEARR_ALLOWED_HOSTS = "animearr.example.com";
  try {
    const r = await login(PROXY, { "x-forwarded-for": "192.168.1.20", host: "animearr.example.com" });
    assert.equal(r.statusCode, 403, r.body);
  } finally {
    delete process.env.ANIMEARR_ALLOWED_HOSTS;
  }
});

test("the no-password bypass stays off with a hop count", async () => {
  patchSettings((s) => ({ ...s, auth: { ...s.auth, bypassLocal: true } }));
  try {
    for (const [peer, headers] of [
      [PROXY, { "x-forwarded-for": "192.168.1.20" }],
      ["192.168.1.10", {}],
    ] as const) {
      const r = await app.inject({
        method: "GET",
        url: "/api/settings",
        remoteAddress: peer,
        headers: { host: "192.168.1.5:8484", ...headers },
      });
      assert.equal(r.statusCode, 401, `${peer} must log in`);
    }
  } finally {
    patchSettings((s) => ({ ...s, auth: { ...s.auth, bypassLocal: false } }));
  }
});

test("once the password is changed, login works through the proxy from anywhere", async () => {
  await setAccount("captain", "a-better-booty-123");
  // A second proxy address: with a hop count every request is throttled on the proxy's own address, and the refused
  // default logins above (R5-H1) have used up PROXY's free tries.
  const r = await login("192.168.1.3", { "x-forwarded-for": "203.0.113.9" }, "a-better-booty-123");
  assert.equal(r.statusCode, 200, r.body);
});
