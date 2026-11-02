/** "Change file date" and "Delete empty folders": Sonarr's media-management settings, wired into AnimeArr's own importer. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-tidy-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { airDateMtime, applyFileDate, pruneEmptyFolders } = await import("../server/tidy.js");

const DAY = 86_400_000;
const posix = (p: string) => p.split(path.sep).join("/");
const lib = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-tidy-lib-"));
const show = path.join(lib, "Tidy Show");
const aired = Date.UTC(2025, 2, 14, 15, 30);

before(() => {
  patchSettings((s) => ({ ...s, allowedRoots: [posix(lib)] }));
  cache
    .prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (70, 900001, 'Tidy Show', ?, 0, 0)")
    .run(`${posix(lib)}/Tidy Show`);
  cache
    .prepare(
      "INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, air_utc) VALUES (7001, 70, 1, 1, 1, 0, ?), (7002, 70, 1, 2, 1, 0, ?), (7003, 70, 1, 3, 1, 0, NULL), (7004, 70, 1, 4, 1, 0, ?)",
    )
    .run(aired, aired + 7 * DAY, Date.now() + 30 * DAY);
});

test("file date: none leaves the file alone; UTC uses the air time; local uses the day; no date or a future date does nothing", () => {
  assert.equal(airDateMtime([7001], "none"), null);
  assert.equal(airDateMtime([7001], "utcAirDate")?.getTime(), aired);
  const local = airDateMtime([7001], "localAirDate")!;
  assert.equal(local.getHours(), 0);
  assert.ok(Math.abs(local.getTime() - aired) <= DAY);
  assert.equal(airDateMtime([7003], "utcAirDate"), null, "no air date known");
  assert.equal(airDateMtime([7004], "utcAirDate"), null, "not aired yet");
  assert.equal(airDateMtime([7002, 7001], "utcAirDate")?.getTime(), aired, "a multi-episode file takes its first episode");
});

test("file date: applied to the file only when the setting asks for it", () => {
  fs.mkdirSync(path.join(show, "Season 01"), { recursive: true });
  const f = path.join(show, "Season 01", "Tidy Show - S01E01.mkv");
  fs.writeFileSync(f, "x");
  assert.equal(applyFileDate(f, [7001]), false, "default: none");
  patchSettings((s) => ({ ...s, media: { ...s.media, fileDate: "utcAirDate" } }));
  assert.equal(applyFileDate(f, [7001]), true);
  assert.equal(Math.round(fs.statSync(f).mtimeMs / 1000), Math.round(aired / 1000));
  assert.equal(applyFileDate(path.join(show, "nope.mkv"), [7001]), false, "a missing file never throws");
  patchSettings((s) => ({ ...s, media: { ...s.media, fileDate: "none" } }));
});

test("empty folders: off by default, then only truly empty season and show folders go, never the library root", () => {
  const season = path.join(show, "Season 01");
  const other = path.join(show, "Season 02");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, ".hidden"), "x");
  fs.rmSync(path.join(season, "Tidy Show - S01E01.mkv"));
  assert.deepEqual(pruneEmptyFolders([season], show), [], "off by default");
  assert.ok(fs.existsSync(season));
  patchSettings((s) => ({ ...s, media: { ...s.media, deleteEmptyFolders: true } }));
  assert.deepEqual(pruneEmptyFolders([other], show), [], "a hidden file counts as something inside");
  assert.ok(fs.existsSync(other));
  // The empty season goes, the show folder stays while Season 02 is there.
  assert.equal(pruneEmptyFolders([season], show).length, 1);
  assert.ok(!fs.existsSync(season));
  assert.ok(fs.existsSync(show));
  // Once Season 02 is emptied, the show folder goes too, and the library root is never touched.
  fs.rmSync(path.join(other, ".hidden"));
  assert.equal(pruneEmptyFolders([other], show).length, 2);
  assert.ok(!fs.existsSync(show));
  assert.ok(fs.existsSync(lib), "the library folder stays");
});

test("empty folders: nothing outside the show's folder, and a show folder that is a library root is refused", () => {
  const stray = path.join(lib, "Stray");
  fs.mkdirSync(stray);
  assert.deepEqual(pruneEmptyFolders([stray], path.join(lib, "Tidy Show")), [], "outside the show folder");
  assert.ok(fs.existsSync(stray));
  assert.deepEqual(pruneEmptyFolders([lib], lib), [], "the root itself");
  assert.ok(fs.existsSync(lib));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-tidy-out-"));
  assert.deepEqual(pruneEmptyFolders([outside], outside), [], "not under a library root");
  assert.ok(fs.existsSync(outside));
  patchSettings((s) => ({ ...s, media: { ...s.media, deleteEmptyFolders: false } }));
});
