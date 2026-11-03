/**
 * Blind review round 5, H1: a TCP forwarder or tunnel inside a TRUST_PROXY entry passes the client's own forged
 * X-Forwarded-For through untouched, and AnimeArr can't tell it from an HTTP proxy, so an internet client got the
 * default login (captain/morebooty). The rule now: the default login is only for a home browser talking directly to
 * AnimeArr. With TRUST_PROXY set to anything (exact IP, range, keyword, hop count) it is refused for every request,
 * with a message saying how to set a password. With TRUST_PROXY unset (or 0 or empty, which Fastify also treats as
 * off; review L6) a direct home peer still gets it. Normal password logins are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyRequest } from "fastify";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-r5off-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.ANIMEARR_LOCAL_NETWORKS;
delete process.env.ANIMEARR_ALLOWED_HOSTS;
process.env.TRUST_PROXY = "uniquelocal";

const { ensureDefaultAccount, setAccount } = await import("../server/system/settings.js");
await ensureDefaultAccount();
const { app } = await import("../server/index.js");
const { trustProxyOption, defaultLoginRefusal, DEFAULT_PROXY_REFUSED, DEFAULT_REMOTE_REFUSED } = await import("../server/system/auth.js");

const FORMS = ["192.168.1.2", "192.168.1.2/32", "192.168.0.0/16", "uniquelocal", "loopback", "linklocal", "1", "2"];
const OFF = [undefined, "0", "00", "", " ", "false"];

const login = (remoteAddress: string, headers: Record<string, string> = {}, password = "morebooty") =>
  app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress,
    headers: { "x-animearr": "1", host: "192.168.1.10:8990", ...headers },
    payload: { username: "captain", password },
  });

/** A request as Fastify would see it: the socket peer and the headers. */
const req = (peer: string, headers: Record<string, string> = {}) =>
  ({ ip: peer, socket: { remoteAddress: peer }, headers: { host: "192.168.1.10:8990", ...headers } }) as unknown as FastifyRequest;

const withTrust = async (value: string | undefined, fn: () => void | Promise<void>) => {
  const before = process.env.TRUST_PROXY;
  if (value === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = value;
  try {
    await fn();
  } finally {
    process.env.TRUST_PROXY = before;
  }
};

test("R5-H1 control: a headerless forwarder peer is refused", async () => {
  assert.equal((await login("192.168.1.2")).statusCode, 403);
});

test("R5-H1: same forwarder, the internet client adds its own X-Forwarded-For: still refused", async () => {
  const r = await login("192.168.1.2", { "x-forwarded-for": "192.168.1.77" });
  assert.equal(r.statusCode, 403, `default login granted through a TCP forwarder: ${r.statusCode} ${r.body}`);
  assert.match(r.body, /Set a password first: remove TRUST_PROXY/, "says what to do");
});

test("R5-H1: exact-IP, range, keyword and hop-count TRUST_PROXY all refuse over HTTP, with advice that works for each (L1)", async () => {
  let n = 0;
  for (const trust of FORMS)
    await withTrust(trust, async () => {
      n++;
      // Fresh addresses per form, so the login throttle never answers first.
      const r = await login(`10.${n}.0.2`, { "x-forwarded-for": `10.${n}.0.77` });
      assert.equal(r.statusCode, 403, `TRUST_PROXY=${trust}: ${r.body}`);
      assert.equal(r.json().error, DEFAULT_PROXY_REFUSED, `TRUST_PROXY=${trust}`);
      const direct = await login(`10.${n}.0.50`);
      assert.equal(direct.statusCode, 403, `TRUST_PROXY=${trust}, a headerless home peer: ${direct.body}`);
    });
});

test("R5-H1: under every TRUST_PROXY form no peer gets the default login, with or without headers", async () => {
  const peers: [string, Record<string, string>][] = [
    ["192.168.1.2", { "x-forwarded-for": "192.168.1.77" }],
    ["192.168.1.2", { "x-real-ip": "192.168.1.77" }],
    ["192.168.1.2", {}],
    ["192.168.1.50", {}],
    ["::ffff:192.168.1.50", {}],
    ["10.0.0.7", {}],
    ["fe80::1", {}],
    ["172.17.0.1", { "x-forwarded-for": "192.168.1.77" }],
    ["127.0.0.1", { "x-forwarded-for": "192.168.1.77" }],
  ];
  for (const trust of FORMS)
    await withTrust(trust, () => {
      for (const [peer, headers] of peers)
        assert.equal(defaultLoginRefusal(req(peer, headers), true), DEFAULT_PROXY_REFUSED, `TRUST_PROXY=${trust} from ${peer}`);
      assert.equal(defaultLoginRefusal(req("192.168.1.50"), false), null, "a changed password is never refused here");
    });
  assert.doesNotMatch(DEFAULT_PROXY_REFUSED, /\d+\.\d+\.\d+\.\d+/, "the message names no address");
});

test("R5-H1: /api/status doesn't offer the default login under TRUST_PROXY", async () => {
  const r = await app.inject({ method: "GET", url: "/api/status", remoteAddress: "192.168.1.50", headers: { host: "192.168.1.10:8990" } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().defaultLogin, undefined);
});

test("TRUST_PROXY unset, 0, empty or false is off (as Fastify sees it): a direct home peer gets the default login", async () => {
  for (const trust of OFF)
    await withTrust(trust, () => {
      assert.equal(trustProxyOption(), false, `TRUST_PROXY=${JSON.stringify(trust)}`);
      assert.equal(defaultLoginRefusal(req("192.168.1.50"), true), null, `TRUST_PROXY=${JSON.stringify(trust)}: direct home peer`);
      assert.equal(defaultLoginRefusal(req("fe80::1"), true), null, "IPv6 link-local too");
      for (const peer of ["172.17.0.1", "127.0.0.1", "::1", "fd00::5", "8.8.8.8"])
        assert.equal(defaultLoginRefusal(req(peer), true), DEFAULT_REMOTE_REFUSED, `TRUST_PROXY=${JSON.stringify(trust)}: ${peer}`);
      assert.equal(
        defaultLoginRefusal(req("192.168.1.2", { "x-forwarded-for": "192.168.1.77" }), true),
        DEFAULT_REMOTE_REFUSED,
        "a peer sending forwarded headers isn't a direct browser",
      );
      assert.equal(defaultLoginRefusal(req("192.168.1.50", { host: "evil.example.com" }), true), DEFAULT_REMOTE_REFUSED, "rebinding");
    });
});

test("TRUST_PROXY unset or 0 over HTTP: a direct home browser logs in with the default login", async () => {
  await withTrust(undefined, async () => {
    assert.equal((await login("10.20.0.50")).statusCode, 200);
  });
  await withTrust("0", async () => {
    assert.equal((await login("10.21.0.50")).statusCode, 200, "review L6: 0 no longer blocks every default login");
  });
});

test("once the password is changed, a normal login works under TRUST_PROXY", async () => {
  await setAccount("captain", "a-better-booty-123");
  const r = await login("10.30.0.2", { "x-forwarded-for": "203.0.113.9" }, "a-better-booty-123");
  assert.equal(r.statusCode, 200, r.body);
});
