/**
 * A malformed entry in ANIMEARR_LOCAL_NETWORKS or TRUST_PROXY matches nothing (blind review A10); at startup each one
 * is named in a warning, once, so a typo doesn't silently make the user's own network "not home".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-netwarn-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { warnNetworkSettings } = await import("../server/system/auth.js");

test("each malformed network entry is named once; valid ones say nothing", () => {
  process.env.ANIMEARR_LOCAL_NETWORKS = "192.168.0.0/16, 192.168.1.0/33, fd7a:115c:a1e0::/48, 2001:db8::/, nonsense";
  process.env.TRUST_PROXY = "172.18.0.0/16,10.0.0.0/abc,192.168.1.2";
  try {
    const seen: string[] = [];
    warnNetworkSettings((m) => seen.push(m));
    warnNetworkSettings((m) => seen.push(m)); // a second call repeats nothing
    assert.equal(seen.length, 4, seen.join("\n"));
    for (const bad of ["192.168.1.0/33", "2001:db8::/", "nonsense", "10.0.0.0/abc"])
      assert.ok(
        seen.some((m) => m.includes(`"${bad}"`)),
        `names ${bad}`,
      );
    assert.ok(seen.some((m) => m.includes("ANIMEARR_LOCAL_NETWORKS")) && seen.some((m) => m.includes("TRUST_PROXY")));
  } finally {
    delete process.env.ANIMEARR_LOCAL_NETWORKS;
    delete process.env.TRUST_PROXY;
  }
});
