/** AnimeArr's recycling bin: retention from the time a file went in (not its date), only inside the bin, Empty now. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-bin-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { patchSettings } = await import("../server/settings.js");
const { cache } = await import("../server/db.js");
// The library (so the bin can be checked against it).
cache.prepare("INSERT INTO series (id, tvdb_id, title, path, root_folder, monitored, synced_at) VALUES (1, 1, 'Show', '/media/Anime/Show', '/media/Anime', 1, 0)").run();
const { purgeBin, noteBinned, binFolder } = await import("../server/binpurge.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-binf-"));
const BIN = path.join(tmp, "Recycle", "animearr");
const LIB = path.join(tmp, "Anime");
const write = (p: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, "x"));
const DAY = 86_400_000;

test("purges by the time a file went into the bin; keeps forever at 0 days; refuses unsafe bins; Empty now", () => {
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Anime"], localPathMappings: [{ from: "/media/Recycle", to: path.join(tmp, "Recycle") }, { from: "/media/Anime", to: LIB }], media: { ...s.media, recycleBin: "/media/Recycle/animearr/", recycleBinCleanupDays: 3 } }));
  const old = path.join(BIN, "Show", "old.mkv");
  const fresh = path.join(BIN, "Show", "fresh.mkv");
  write(old);
  write(fresh);
  const now = Date.now();
  noteBinned(old, 1, now - 4 * DAY);
  noteBinned(fresh, 1, now - 1 * DAY);
  // The file dates don't matter (an old original's date would otherwise purge it at once).
  fs.utimesSync(fresh, new Date(2001, 0, 1), new Date(2001, 0, 1));
  const r = purgeBin({ now });
  assert.equal(r.deleted, 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  // Untracked files start their clock now.
  const legacy = path.join(BIN, "legacy.mkv");
  write(legacy);
  assert.equal(purgeBin({ now: now + 2 * DAY }).deleted, 1, "fresh (3 days old by then) goes; legacy starts its clock");
  assert.equal(fs.existsSync(legacy), true);
  // 0 days = keep forever.
  patchSettings((s) => ({ ...s, media: { ...s.media, recycleBinCleanupDays: 0 } }));
  assert.equal(purgeBin({ now: now + 99 * DAY }).deleted, 0);
  // Unsafe bins are refused.
  patchSettings((s) => ({ ...s, media: { ...s.media, recycleBin: "/media/Anime" } }));
  assert.ok("error" in binFolder());
  patchSettings((s) => ({ ...s, media: { ...s.media, recycleBin: "/" } }));
  assert.ok("error" in binFolder());
  patchSettings((s) => ({ ...s, media: { ...s.media, recycleBin: "" } }));
  assert.ok("error" in binFolder());
  // Never AnimeArr's own data folder (settings, database, backups), inside it, or a folder holding it.
  const conf = process.env.ANIMEARR_CONFIG!;
  patchSettings((s) => ({ ...s, localPathMappings: [...s.localPathMappings, { from: "/media/Conf", to: conf }, { from: "/media/Above", to: path.dirname(conf) }] }));
  for (const b of ["/media/Conf", "/media/Conf/bin", "/media/Above"]) {
    patchSettings((s) => ({ ...s, media: { ...s.media, recycleBin: b } }));
    const r = binFolder();
    // (The folder above also holds this test's library, so it may be refused for that first.)
    assert.ok("error" in r && /data folder|library folder/.test(r.error), b);
  }
  // Empty now.
  patchSettings((s) => ({ ...s, media: { ...s.media, recycleBin: "/media/Recycle/animearr/" } }));
  assert.equal(purgeBin({ all: true }).deleted, 1);
  assert.equal(fs.existsSync(legacy), false);
});
