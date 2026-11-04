/**
 * The file scan drops the records of roots that "aren't library roots any more". Those roots come from the Sonarr /
 * Radarr cache, so a cache that was never filled (rebuilt while Sonarr was down) made every Sonarr root look removed
 * and wiped its probe data (review 2026-11-02, H10 downstream). It only prunes once the libraries were read.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-scan-roots-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { scanLibrary } = await import("../server/import/mediafiles.js");
const { markListRead } = await import("../server/library/native.js");
const { NATIVE_BASE } = await import("../server/library/nativeIds.js");

const probe = async () => {
  throw new Error("nothing to probe");
};
const records = () => (db.prepare("SELECT COUNT(*) AS n FROM media_files WHERE root = '/tv-sonarr'").get() as { n: number }).n;

before(() => {
  // Only a native show is in the cache (its root is unreachable here); the Sonarr shows were never read in.
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, root_folder, monitored, synced_at) VALUES (?, 1, 'Native', '/tv-native/Native', '/tv-native', 1, 0)",
    )
    .run(NATIVE_BASE + 1);
  db.prepare("INSERT INTO media_files (path, root, size, mtime, seen_at) VALUES ('/tv-sonarr/Show/e1.mkv', '/tv-sonarr', 1, 1, 1)").run();
});

test("Sonarr's library never read into the cache: the scan keeps the records of roots it can't see", async () => {
  patchSettings((s) => ({ ...s, sonarr: { url: "http://sonarr.test", apiKey: "k", animeTag: "" } }));
  await scanLibrary({ probe });
  assert.equal(records(), 1);
});

test("once Sonarr's list was read (and the root really isn't one any more), the records go", async () => {
  markListRead("Sonarr", 0);
  await scanLibrary({ probe });
  assert.equal(records(), 0);
});
