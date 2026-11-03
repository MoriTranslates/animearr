/**
 * Blind review A5: with a TRUST_PROXY *list*, the default login through the proxy was refused from home too, so a
 * fresh install reachable only through its proxy could never change the password. A5 let a listed home proxy vouch
 * for the client it reports; blind review round 5 (H1) took that back: a TCP forwarder at that address passes a
 * forged X-Forwarded-For through, so with TRUST_PROXY set the default login is off for every request, and the refusal
 * says how to set a password (TRUST_PROXY unset, directly from home).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-listlogin-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.ANIMEARR_LOCAL_NETWORKS;
delete process.env.ANIMEARR_ALLOWED_HOSTS;
process.env.TRUST_PROXY = "192.168.1.2,172.18.0.0/16";

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

test("R5-H1: a listed proxy on the home network no longer vouches for the default login", async () => {
  assert.equal(await login("192.168.1.2", "192.168.1.20"), 403, "it may be a TCP forwarder passing a forged header");
});

test("a listed proxy on a Docker network never vouches, even with that network listed as home", async () => {
  // The reviewer's setup: peer 172.18.0.5 inside TRUST_PROXY=172.18.0.0/16.
  assert.equal(await login("172.18.0.5", "192.168.1.20"), 403, "the listed range also holds Docker's gateway");
  assert.equal(await login("172.18.0.1", "192.168.1.20"), 403, "the gateway itself, with a forged header");
  process.env.ANIMEARR_LOCAL_NETWORKS = "192.168.0.0/16,172.18.0.0/16";
  try {
    assert.equal(await login("172.18.0.5", "192.168.1.20"), 403, "listed as home on purpose: still no proxy vouches (R5-H1)");
  } finally {
    delete process.env.ANIMEARR_LOCAL_NETWORKS;
  }
});

test("only a listed proxy vouches, and only for a home client", async () => {
  assert.equal(await login("192.168.1.30", "192.168.1.20"), 403, "a LAN peer that isn't the listed proxy");
  assert.equal(await login("192.168.1.2", "203.0.113.9"), 403, "an internet client through the proxy");
  assert.equal(await login("192.168.1.2", "192.168.1.20, 203.0.113.9"), 403, "only the entry the proxy added counts");
  assert.equal(await login("203.0.113.9", "192.168.1.20"), 403, "a direct internet peer");
});
