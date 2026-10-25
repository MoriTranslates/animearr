/** Recycle bin report: Sonarr's setting, anime shows only, newest first, purge dates. No Sonarr. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-recycle-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { recycleStatus, resetRecycleCache } = await import("../server/recycle.js");

const bin = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-bin-"));
before(() => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (1, 700001, 'Anime Show', '/media/AnimeArr/Anime Show', 1, 0), (2, 700002, 'TV Show', '/media/Tv Shows/TV Show', 1, 0)").run();
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/AnimeArr"] }));
  for (const [dir, file, ago] of [["Anime Show/Season 1", "Anime Show - S01E01.mkv", 2], ["Anime Show", "Anime Show - S01E02.mkv", 1], ["TV Show", "TV Show - S01E01.mkv", 1]] as const) {
    fs.mkdirSync(path.join(bin, dir), { recursive: true });
    const f = path.join(bin, dir, file);
    fs.writeFileSync(f, "x");
    const t = new Date(Date.now() - ago * 86_400_000);
    fs.utimesSync(f, t, t);
  }
});

test("lists anime files in Sonarr's recycle bin, newest first, with the purge date", async () => {
  resetRecycleCache();
  const r = await recycleStatus({ get: async () => ({ recycleBin: "/recycle", recycleBinCleanupDays: 7 }), localPath: (p) => (p === "/recycle" ? bin : null) });
  assert.equal(r.configured, true);
  assert.equal(r.reachable, true);
  assert.deepEqual(r.items.map((i) => i.path), ["/recycle/Anime Show/Anime Show - S01E02.mkv", "/recycle/Anime Show/Season 1/Anime Show - S01E01.mkv"]);
  assert.equal(r.totalCount, 2);
  // Sonarr purges a show's folder by its newest file: both share the newer date.
  assert.equal(r.items[1].purgeAt, r.items[0].purgeAt);
  assert.ok(Math.abs(r.items[0].purgeAt! - (r.items[0].deletedAt + 7 * 86_400_000)) < 1000);
});

test("no recycle bin in Sonarr is reported as such", async () => {
  resetRecycleCache();
  const r = await recycleStatus({ get: async () => ({ recycleBin: "", recycleBinCleanupDays: 7 }), localPath: () => null });
  assert.equal(r.configured, false);
});

test("the setting is cached briefly; fresh reads skip the cache; unreachable folders are reported", async () => {
  resetRecycleCache();
  let calls = 0;
  const get = async () => (calls++, { recycleBin: calls > 1 ? "/recycle" : "", recycleBinCleanupDays: 7 });
  const t0 = Date.now();
  assert.equal((await recycleStatus({ get, localPath: () => null }, t0)).configured, false);
  assert.equal((await recycleStatus({ get, localPath: () => null }, t0 + 1000)).configured, false, "cached");
  const fresh = await recycleStatus({ get, localPath: () => null }, t0 + 2000, true);
  assert.equal(fresh.configured, true);
  assert.equal(fresh.reachable, false);
});
