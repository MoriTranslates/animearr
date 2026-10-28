import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyRequest } from "fastify";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-auth-"));
process.env.ANIMEARR_NO_LOCK = "1";
delete process.env.ANIMEARR_LOCAL_NETWORKS;
delete process.env.TRUST_PROXY;
const { usingDefaultPassword, setAccount, getSettings, patchSettings, checkPassword, ensureDefaultAccount, DEFAULT_LOGIN } = await import("../server/settings.js");
const { defaultLoginRefusal, DEFAULT_REMOTE_REFUSED } = await import("../server/auth.js");

/** A request as Fastify would see it: the client IP, the socket peer, and the Host header. */
const req = (ip: string, headers: Record<string, string> = {}) => ({ ip, socket: { remoteAddress: ip }, headers: { host: "192.168.1.10:8484", ...headers } }) as unknown as FastifyRequest;

test("fresh install gets the default login captain/morebooty; the flag clears once the password changes", async () => {
  assert.deepEqual({ ...DEFAULT_LOGIN }, { username: "captain", password: "morebooty" });
  assert.equal(getSettings().auth.passwordHash, "");
  assert.equal(await ensureDefaultAccount(), true, "a fresh install creates the account");
  const a = getSettings().auth;
  assert.equal(a.username, "captain");
  assert.equal(await checkPassword("morebooty", a.passwordHash), true);
  assert.equal(JSON.stringify(getSettings()).includes("morebooty"), false, "only the hash is stored, never the plaintext");
  assert.equal(a.bypassLocal, false, "no-password-on-LAN stays off unless the user ticks it");
  assert.equal(await usingDefaultPassword(), true);
  await setAccount("captain", "a-better-booty-123");
  assert.equal(await usingDefaultPassword(), false, "changing the password clears the default flag (and the banner)");
});

test("existing installs: an account that already exists is never reset or altered", async () => {
  await setAccount("owner", "owners-own-password");
  patchSettings((s) => ({ ...s, auth: { ...s.auth, bypassLocal: true } }));
  const before = structuredClone(getSettings());
  assert.equal(await ensureDefaultAccount(), false, "migration is a no-op with an account");
  assert.equal(await ensureDefaultAccount(), false, "and stays one on every restart");
  assert.deepEqual(getSettings().auth, before.auth, "username, password hash and local bypass unchanged");
  assert.equal(getSettings().secret, before.secret, "sessions stay valid");
  assert.equal(await usingDefaultPassword(), false);
});

test("safety rule: while the password is the default, logins are refused from outside the home network", () => {
  for (const ip of ["192.168.1.20", "10.0.0.5", "::ffff:192.168.1.9", "fd00::1234", "fe80::1"]) assert.equal(defaultLoginRefusal(req(ip), true), null, `${ip} is home`);
  for (const ip of ["8.8.8.8", "203.0.113.7", "::ffff:1.2.3.4", "2001:db8::1", "100.64.0.1"]) assert.equal(defaultLoginRefusal(req(ip), true), DEFAULT_REMOTE_REFUSED, `${ip} is not home`);
  assert.equal(DEFAULT_REMOTE_REFUSED, "The default password only works from your home network. Log in from home and change it first.");
  // Docker's 172.16/12 and loopback don't count by default (a reverse proxy or tunnel would look local).
  assert.equal(defaultLoginRefusal(req("172.17.0.1"), true), DEFAULT_REMOTE_REFUSED);
  assert.equal(defaultLoginRefusal(req("127.0.0.1"), true), DEFAULT_REMOTE_REFUSED);
  // Through an untrusted proxy a LAN address proves nothing.
  assert.equal(defaultLoginRefusal(req("192.168.1.20", { "x-forwarded-for": "8.8.8.8" }), true), DEFAULT_REMOTE_REFUSED);
  // DNS rebinding: a LAN IP but a foreign host name.
  assert.equal(defaultLoginRefusal(req("192.168.1.20", { host: "evil.example.com" }), true), DEFAULT_REMOTE_REFUSED);
  // Once the password is changed, logins work from anywhere again.
  assert.equal(defaultLoginRefusal(req("8.8.8.8"), false), null);
});

test("safety rule follows ANIMEARR_LOCAL_NETWORKS", () => {
  process.env.ANIMEARR_LOCAL_NETWORKS = "172.16.0.0/12";
  try {
    assert.equal(defaultLoginRefusal(req("172.20.0.4"), true), null, "a listed range counts as home");
    assert.equal(defaultLoginRefusal(req("192.168.1.20"), true), DEFAULT_REMOTE_REFUSED, "the list replaces the defaults");
  } finally {
    delete process.env.ANIMEARR_LOCAL_NETWORKS;
  }
});
