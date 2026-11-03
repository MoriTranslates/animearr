/**
 * IPv6 in the address rules (review L4 and the M3 follow-up):
 * - the login throttle groups IPv6 clients by their /64 (one home or one server gets a whole /64), keeps IPv4 per
 *   address, and treats IPv4-mapped IPv6 as IPv4;
 * - IPv6 ULA (fc00::/7) is not "home" by default, like Docker's 172.16/12: Docker's own IPv6 networks are ULA. It can be
 *   listed in ANIMEARR_LOCAL_NETWORKS (IPv6 CIDRs work there now). Link-local and loopback rules are unchanged.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-ipv6-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.TRUST_PROXY;
delete process.env.ANIMEARR_LOCAL_NETWORKS;

const { setAccount, patchSettings } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");
const { loginAllowed, throttleSize } = await import("../server/system/auth.js");

before(() => patchSettings((s) => ({ ...s, auth: { ...s.auth, bypassLocal: true } })));

/** Tries until the throttle refuses; returns how many were allowed (6 = the 5 free tries plus one). */
function triesUntilRefused(addrs: string[], user = "captain") {
  let n = 0;
  for (const a of addrs) {
    if (!loginAllowed(a, user)) return n;
    n++;
  }
  return n;
}

test("IPv6 clients are throttled per /64, not per address", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 2, 12) });
  const same64 = Array.from({ length: 50 }, (_, i) => `2001:db8:1:2::${(i + 1).toString(16)}`);
  assert.equal(triesUntilRefused(same64), 6, "50 addresses in one /64 share one throttle");
  assert.equal(loginAllowed("2001:db8:1:2:aaaa:bbbb:cccc:dddd", "captain"), false, "any spelling inside that /64");
  assert.equal(loginAllowed("2001:db8:1:3::1", "captain"), true, "the next /64 is someone else");
});

test("IPv4 stays per address, and IPv4-mapped IPv6 counts as the IPv4 address", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 3, 12) });
  assert.equal(triesUntilRefused(Array(10).fill("192.0.2.1")), 6);
  assert.equal(loginAllowed("::ffff:192.0.2.1", "captain"), false, "mapped form shares the IPv4 entry");
  assert.equal(loginAllowed("192.0.2.2", "captain"), true, "the neighbouring IPv4 address is separate");
});

test("rotating IPv6 addresses and user names inside one /64 adds only a few entries", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 4, 12) });
  t.mock.timers.tick(31 * 60_000);
  loginAllowed("198.51.100.1", "warmup");
  const before = throttleSize();
  for (let i = 0; i < 2000; i++) loginAllowed(`2001:db8:9:9:${(i >> 8).toString(16)}::${(i & 255).toString(16)}`, `guess${i}`);
  assert.ok(throttleSize() - before <= 20, `one /64 added ${throttleSize() - before} entries`);
});

async function probe(peer: string) {
  const r = await app.inject({ method: "GET", url: "/api/settings", remoteAddress: peer, headers: { host: "192.168.1.5:8484" } });
  return r.statusCode;
}

test("IPv6 ULA is not home network by default; link-local still is, loopback still isn't", async () => {
  assert.equal(await probe("192.168.1.10"), 200, "IPv4 LAN unchanged");
  assert.equal(await probe("fd12:3456:789a::5"), 401, "ULA (Docker's IPv6 networks are ULA)");
  assert.equal(await probe("fc00::1"), 401);
  assert.equal(await probe("fd7a:115c:a1e0::1"), 401, "Tailscale's ULA range needs to be listed");
  assert.equal(await probe("fe80::1234"), 200, "link-local unchanged");
  assert.equal(await probe("::1"), 401, "loopback unchanged");
});

test("ANIMEARR_LOCAL_NETWORKS can list IPv6 ranges", async () => {
  process.env.ANIMEARR_LOCAL_NETWORKS = "192.168.0.0/16, fd7a:115c:a1e0::/48";
  try {
    assert.equal(await probe("fd7a:115c:a1e0:ab12::1"), 200, "listed ULA range");
    assert.equal(await probe("fd7a:115c:a1e1::1"), 401, "just outside it");
    assert.equal(await probe("fd12:3456:789a::5"), 401, "another ULA");
    assert.equal(await probe("192.168.1.10"), 200);
    assert.equal(await probe("::ffff:192.168.1.10"), 200, "IPv4-mapped against an IPv4 range");
    assert.equal(await probe("10.0.0.7"), 401, "the list replaces the defaults");
  } finally {
    delete process.env.ANIMEARR_LOCAL_NETWORKS;
  }
});

test("review A10: a malformed IPv4 prefix matches nothing instead of half the internet", async () => {
  for (const bad of ["192.168.1.0/33", "192.168.1.0/-1", "192.168.1.0/abc", "192.168.1.0/", "192.168.1.0/8.5"]) {
    process.env.ANIMEARR_LOCAL_NETWORKS = bad;
    try {
      assert.equal(await probe("203.0.113.9"), 401, `${bad}: an internet address isn't home`);
      assert.equal(await probe("192.168.1.10"), 401, `${bad}: a broken entry matches nothing`);
    } finally {
      delete process.env.ANIMEARR_LOCAL_NETWORKS;
    }
  }
  for (const bad of ["2001:db8::/", "2001:db8::/129", "2001:db8::/32/1"]) {
    process.env.ANIMEARR_LOCAL_NETWORKS = bad;
    try {
      assert.equal(await probe("2001:db8:ffff::1"), 401, `${bad}: an empty or broken IPv6 prefix matches nothing`);
    } finally {
      delete process.env.ANIMEARR_LOCAL_NETWORKS;
    }
  }
  process.env.ANIMEARR_LOCAL_NETWORKS = "192.168.1.10, 10.0.0.0/32, 0.0.0.0/0x";
  try {
    assert.equal(await probe("192.168.1.10"), 200, "a bare address means just that address");
    assert.equal(await probe("192.168.1.11"), 401);
  } finally {
    delete process.env.ANIMEARR_LOCAL_NETWORKS;
  }
});
