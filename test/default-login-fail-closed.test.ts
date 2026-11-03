/**
 * Blind review round 4, H1 and M2: the default login (captain/morebooty) is a convenience for a home browser talking
 * directly to AnimeArr. When AnimeArr can't be sure that's what it is talking to, it refuses.
 * H1: a single IP named in TRUST_PROXY may be Docker's gateway (what a host-run proxy looks like from inside a bridge
 * container), and internet traffic relayed by docker-proxy arrives from that same address, so it must not vouch.
 * M2: with a range or keyword in TRUST_PROXY, a home peer that sends no proxy headers may be a TCP forwarder or tunnel
 * (nginx stream, frp, ssh -R, socat) carrying internet traffic, so it isn't taken as a home browser.
 * Round 5, H1 went further: with TRUST_PROXY set to anything the default login is refused for every request (see
 * default-login-trust-proxy-off.test.ts); these cases stay as regression checks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-r4fc-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.ANIMEARR_LOCAL_NETWORKS;
delete process.env.ANIMEARR_ALLOWED_HOSTS;
process.env.TRUST_PROXY = "uniquelocal,172.17.0.1";

const { ensureDefaultAccount } = await import("../server/system/settings.js");
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
  const before = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = value;
  try {
    await fn();
  } finally {
    process.env.TRUST_PROXY = before;
  }
};

test("R4-H1: Docker's gateway named in TRUST_PROXY can't vouch for a forged X-Forwarded-For", async () => {
  const r = await login("172.17.0.1", { "x-forwarded-for": "192.168.1.77" });
  assert.equal(r.statusCode, 403, `default login granted: ${r.body}`);
  assert.match(r.body, /set a password/i, "the refusal says what to do");
  assert.doesNotMatch(r.body, /172\.17\.0\.1/, "without showing internal addresses to whoever is asking");
});

test("R4-H1: no single address on a Docker network or ULA vouches, in any spelling", async () => {
  for (const [trust, peer] of [
    ["172.18.0.2", "172.18.0.2"],
    ["172.18.0.2/32", "172.18.0.2"],
    ["uniquelocal,172.18.0.2", "::ffff:172.18.0.2"],
    ["fd00::2", "fd00::2"],
  ])
    await withTrust(trust, async () => {
      const r = await login(peer, { "x-forwarded-for": "192.168.1.78" });
      assert.equal(r.statusCode, 403, `${trust} from ${peer}: ${r.body}`);
    });
});

test("R4-M2: a headerless home peer inside a TRUST_PROXY range or keyword is refused", async () => {
  for (const trust of ["192.168.0.0/16", "uniquelocal", "10.0.0.0/8,192.168.0.0/16"])
    await withTrust(trust, async () => {
      for (const peer of ["192.168.1.2", "::ffff:192.168.1.2"]) {
        if (trust.startsWith("10.") && peer.includes(":")) continue;
        const r = await login(peer);
        assert.equal(r.statusCode, 403, `${trust} from ${peer}: ${r.body}`);
        assert.match(r.body, /TRUST_PROXY/, "the refusal says why: TRUST_PROXY covers this address");
      }
    });
  await withTrust("10.0.0.0/8,192.168.0.0/16", async () => {
    assert.equal((await login("10.0.0.7")).statusCode, 403, "10/8 too");
  });
});

test("R5-H1: with TRUST_PROXY set, even a home browser it doesn't cover gets no default login", async () => {
  await withTrust("192.168.1.2", async () => {
    const r = await login("192.168.1.50");
    assert.equal(r.statusCode, 403, "TRUST_PROXY set: the default login is off for every request");
    assert.match(r.body, /Set a password first: remove TRUST_PROXY/);
  });
});
