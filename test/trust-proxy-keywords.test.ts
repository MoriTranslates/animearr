/**
 * Blind review round 2, R7: Fastify (through proxy-addr) accepts the keywords loopback, linklocal and uniquelocal in
 * TRUST_PROXY and trusts those ranges for req.ip, but AnimeArr's own checks didn't know them: the startup warning
 * called them "ignored and matches nothing" and isListedProxy matched no peer, so the two disagreed about which peers
 * are proxies. Now trustProxyOption spells each keyword out as the same ranges, so both read one list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-tpkeywords-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.ANIMEARR_LOCAL_NETWORKS;
delete process.env.ANIMEARR_ALLOWED_HOSTS;
process.env.TRUST_PROXY = "loopback, uniquelocal";

const { trustProxyOption, warnNetworkSettings } = await import("../server/system/auth.js");
const { ensureDefaultAccount } = await import("../server/system/settings.js");
await ensureDefaultAccount();
const { app } = await import("../server/index.js");

const login = (peer: string, xff: string) =>
  app
    .inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: peer,
      headers: { host: "192.168.1.5:8484", "x-animearr": "1", "x-forwarded-for": xff },
      payload: { username: "captain", password: "morebooty" },
    })
    .then((r) => r.statusCode);

test("R7: the proxy-addr keywords become the same ranges Fastify uses", () => {
  assert.deepEqual(trustProxyOption(), ["127.0.0.1/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]);
  process.env.TRUST_PROXY = "linklocal,192.168.1.2";
  try {
    assert.deepEqual(trustProxyOption(), ["169.254.0.0/16", "fe80::/10", "192.168.1.2"]);
  } finally {
    process.env.TRUST_PROXY = "loopback, uniquelocal";
  }
});

test("R7: no 'ignored and matches nothing' warning for a keyword", () => {
  process.env.TRUST_PROXY = "loopback,linklocal,uniquelocal,Loopback";
  try {
    const seen: string[] = [];
    warnNetworkSettings((m) => seen.push(m));
    assert.equal(seen.length, 1, seen.join("\n"));
    assert.ok(seen[0].includes('"Loopback"'), "proxy-addr's keywords are lower-case only; a misspelt one is still named");
  } finally {
    process.env.TRUST_PROXY = "loopback, uniquelocal";
  }
});

test("R7: a peer Fastify trusts through a keyword is a proxy for AnimeArr too", async () => {
  // Before: 192.168.1.2 wasn't a "listed proxy", so the default login from home through it was refused.
  assert.equal(await login("192.168.1.2", "192.168.1.20"), 200, "a home proxy inside uniquelocal vouches for a home client");
  assert.equal(await login("192.168.1.2", "203.0.113.9"), 403, "an internet client through that proxy");
  assert.equal(await login("172.18.0.5", "192.168.1.20"), 403, "Docker's 172.16/12 is in uniquelocal but never home");
  assert.equal(await login("127.0.0.1", "192.168.1.20"), 403, "loopback is in the list but never home");
  assert.equal(await login("203.0.113.9", "192.168.1.20"), 403, "an internet peer isn't a listed proxy");
});

test("R7: a peer inside a keyword range gets no no-password bypass", async () => {
  const { setBypassLocal } = await import("../server/system/settings.js");
  setBypassLocal(true);
  try {
    const r = await app.inject({ method: "GET", url: "/api/shows", remoteAddress: "192.168.1.2", headers: { host: "192.168.1.5:8484" } });
    assert.equal(r.statusCode, 401, "a listed proxy is never the user's device");
  } finally {
    setBypassLocal(false);
  }
});
