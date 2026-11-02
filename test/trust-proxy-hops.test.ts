/**
 * A fresh install behind a reverse proxy configured with a hop count (TRUST_PROXY=1), over HTTP (review L2, then A1 of
 * the blind review of the auth branch). The default login judges the client the proxy reports, but only when the proxy
 * itself (the socket peer) is on the home network: Docker's 172.16/12, ULA and loopback are where internet traffic
 * arrives through Docker's gateway or docker-proxy, so they never vouch for an X-Forwarded-For. Only the last entry
 * (the one that proxy added) counts, whatever the hop count. The no-password bypass stays off.
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

test("the default login works from home through a proxy on the home network", async () => {
  const r = await login(PROXY, { "x-forwarded-for": "192.168.1.20" });
  assert.equal(r.statusCode, 200, r.body);
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

test("a proxy on a Docker network counts once its range is listed as home", async () => {
  process.env.ANIMEARR_LOCAL_NETWORKS = "192.168.0.0/16,172.18.0.0/16";
  try {
    assert.equal((await login("172.18.0.5", { "x-forwarded-for": "192.168.1.20" })).statusCode, 200);
    assert.equal((await login("172.17.0.1", { "x-forwarded-for": "192.168.1.20" })).statusCode, 403, "other Docker ranges still don't");
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

test("the default login through the proxy needs a host name AnimeArr expects", async () => {
  const r = await login(PROXY, { "x-forwarded-for": "192.168.1.20", host: "animearr.example.com" });
  assert.equal(r.statusCode, 403);
  assert.match(r.body, /ANIMEARR_ALLOWED_HOSTS/);
  process.env.ANIMEARR_ALLOWED_HOSTS = "animearr.example.com";
  try {
    const ok = await login(PROXY, { "x-forwarded-for": "192.168.1.20", host: "animearr.example.com" });
    assert.equal(ok.statusCode, 200, ok.body);
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
  const r = await login(PROXY, { "x-forwarded-for": "203.0.113.9" }, "a-better-booty-123");
  assert.equal(r.statusCode, 200, r.body);
});
