/** "Check for updates" asks GitHub's releases (read-only) and copes with being offline. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkForUpdates, compareVersions } from "../server/releases.js";

test("version order: numbers, then a release beats its pre-release", () => {
  assert.equal(compareVersions("0.9.1", "0.9.0-beta"), 1);
  assert.equal(compareVersions("v0.9.0", "0.9.0-beta"), 1);
  assert.equal(compareVersions("0.9.0-beta", "0.9.0-beta"), 0);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
});

test("finds a newer release; a beta user hears about betas; offline says so", async () => {
  const list = [{ tag_name: "v0.9.1-beta", html_url: "https://example.invalid/r/1", draft: false, prerelease: true }, { tag_name: "v0.8.0", html_url: "x", draft: false, prerelease: false }];
  const ok = (async () => new Response(JSON.stringify(list), { status: 200 })) as unknown as typeof fetch;
  const r = await checkForUpdates(ok, 1, "0.9.0-beta");
  assert.equal(r.newer, true);
  assert.equal(r.latest, "0.9.1-beta");
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  const o = await checkForUpdates(down, 10_000_000, "0.9.2");
  assert.equal(o.offline, true);
  assert.equal(o.newer, false);
});
