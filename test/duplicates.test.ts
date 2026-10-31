/** Duplicate listings: an episode filed under another library series is owned elsewhere and never bought twice. */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-dup-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { duplicateListings, overlapsFor, ownedElsewhere, resetDuplicateCache } = await import("../server/duplicates.js");
const { missingScoped, scopedEpisodeIds } = await import("../server/scope.js");
const { autoSearchEpisodes } = await import("../server/autosearch.js");
const { planSchedule } = await import("../server/managed.js");
const { missingInScope } = await import("../server/fillin.js");
const { upgradeUnits } = await import("../server/qualityUpgrade.js");
const { startGrab } = await import("../server/pipeline.js");

const DAY = 86_400_000;
const now = Date.now();
const SLAYERS = 77681;
const SPELLS = 383379;

function series(id: number, tvdb: number, title: string, aids: number[] = []) {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, anidb_ids, synced_at) VALUES (?, ?, ?, ?, 0, ?, 0)").run(id, tvdb, title, `/media/AnimeArr/${title}`, JSON.stringify(aids.map((aid) => ({ aid, season: 1 }))));
}
let nextEp = 1000;
function episode(seriesId: number, season: number, ep: number, file: boolean, scene: string | null = null) {
  const id = nextEp++;
  if (file) cache.prepare("INSERT INTO files (id, series_id, season, path, scene_name, resolution, audio_langs, sub_langs) VALUES (?, ?, ?, ?, ?, '1920x1080', 'jpn', 'eng')").run(id + 90000, seriesId, season, `/media/AnimeArr/S${seriesId}/S${season}E${ep}.mkv`, scene);
  cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, file_id, air_utc, runtime) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 24)").run(id, seriesId, season, ep, file ? 1 : 0, file ? id + 90000 : null, now - 5 * DAY);
  return id;
}
function entry(anilist: number, aid: number, tvdb: number, season: string, offset: number, episodes: number) {
  db.prepare("INSERT INTO entries (anilist_id, anidb_id, tvdb_id, tvdb_season, tvdb_offset, kind, title_romaji, episodes, fetched_at) VALUES (?, ?, ?, ?, ?, 'OVA', ?, ?, 0)").run(anilist, aid, tvdb, season, offset, `Entry ${anilist}`, episodes);
}
const ids: Record<string, number[]> = {};
const count = (sql: string, ...args: number[]) => (db.prepare(sql).get(...args) as { n: number }).n;

before(() => {
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/AnimeArr"], managed: { ...s.managed, dryRun: false } }));
  // Slayers (parent): S01E01 plus the Blu-ray specials S00E03-05.
  series(1, SLAYERS, "Slayers");
  episode(1, 1, 1, true);
  ids.parent = [3, 4, 5].map((n) => episode(1, 0, n, true, "[Grp] Slayers - Book of Spells BD 1080p"));
  // The standalone listing: 3 episodes, no files; the catalog files AniList 1170 under Slayers S0, offset 2.
  series(2, SPELLS, "Slayers: The Book of Spells", [2950]);
  ids.spells = [1, 2, 3].map((n) => episode(2, 1, n, false));
  entry(1170, 2950, SLAYERS, "0", 2, 3);
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (?, 2, 'Slayers: The Book of Spells', 0, 0)").run(SPELLS);
  // Berserk 1997 (25 episodes, files) and Berserk 2016 (own catalog entry, no files): same title, different shows.
  series(3, 70, "Berserk");
  for (let n = 1; n <= 25; n++) episode(3, 1, n, true);
  entry(8000, 8000, 70, "1", 0, 25);
  series(4, 330000, "Berserk", [9000]);
  ids.berserk2016 = Array.from({ length: 12 }, (_, i) => episode(4, 1, i + 1, false));
  entry(9000, 9000, 330000, "1", 0, 12);
  // A duplicate whose parent holds no files: listed in the audit, never blocked.
  series(7, 500, "Parent Empty");
  episode(7, 0, 1, false);
  episode(7, 0, 2, false);
  series(8, 501, "Standalone Empty", [5000]);
  ids.empty = [1, 2].map((n) => episode(8, 1, n, false));
  entry(5000, 5000, 500, "0", 0, 2);
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (501, 8, 'Standalone Empty', 0, 0), (330000, 4, 'Berserk', 0, 0)").run();
  // Series with no ids at all: only an exact title whose episode count agrees may match.
  series(9, 600, "Slayers Spells Titled", []);
  ids.titled = [1, 2, 3].map((n) => episode(9, 1, n, false));
  series(10, 601, "Berserk Look-alike", []);
  Array.from({ length: 12 }, (_, i) => episode(10, 1, i + 1, false));
});
beforeEach(() => resetDuplicateCache());

test("the standalone's episodes are owned elsewhere, with the home they are filed under", () => {
  const owned = ownedElsewhere(SPELLS);
  assert.deepEqual([...owned.keys()].sort(), [...ids.spells].sort());
  const first = owned.get(ids.spells[0])!;
  assert.equal(first.label, "Slayers S00E03");
  assert.equal(owned.get(ids.spells[2])!.label, "Slayers S00E05");
  assert.equal(first.other.tvdbId, SLAYERS);
  assert.equal(first.via, "ids");
});

test("scope: owned-elsewhere episodes are not missing and not searched (managed, backlog and fill-in read this)", () => {
  assert.equal(scopedEpisodeIds(SPELLS, 2, now).size, 0);
  assert.equal(missingScoped(SPELLS, 2, now).length, 0);
  assert.equal(missingInScope(SPELLS, now), 0);
  planSchedule(now);
  assert.equal(count("SELECT COUNT(*) AS n FROM search_state WHERE tvdb_id = ?", SPELLS), 0);
});

test("automatic search skips them with the reason and never searches", async () => {
  let searched = 0;
  const r = await autoSearchEpisodes(SPELLS, ids.spells, { search: (async () => (searched++, { results: [] })) as never, grab: (async () => assert.fail("must not grab")) as never });
  assert.equal(searched, 0);
  assert.equal(r.results.length, 3);
  assert.ok(r.results.every((o) => o.outcome === "skipped" && /owned elsewhere \(filed as Slayers S00E0[345]\)/.test(o.why)));
  assert.ok(db.prepare("SELECT 1 FROM decisions WHERE why LIKE '%owned elsewhere%'").get());
});

test("the grab chokepoint refuses automatic and managed grabs (upgrades and pack extras can't slip through)", async () => {
  const candidate = { guid: "g", title: "x", indexerId: 1, indexer: "X", protocol: "usenet", size: 1, downloadUrl: "u", label: "", group: null, why: "", episodeIds: ids.spells } as never;
  await assert.rejects(startGrab({ tvdbId: SPELLS, episodeIds: ids.spells, candidate, fallbacks: [], origin: "managed" }), /owned elsewhere/);
  await assert.rejects(startGrab({ tvdbId: SPELLS, episodeIds: ids.spells, candidate, fallbacks: [], origin: "manual", automatic: true }), /owned elsewhere/);
});

test("the upgrade watcher leaves the duplicate's own files alone", () => {
  // A DVD copy of one episode sits in the standalone: the Blu-ray under Slayers is the one that counts.
  const e = ids.spells[0];
  cache.prepare("INSERT INTO files (id, series_id, season, path, scene_name, resolution) VALUES (777, 2, 1, '/media/AnimeArr/Spells/E1.mkv', '[Grp] Slayers Spells DVD 480p', '720x480')").run();
  cache.prepare("UPDATE episodes SET has_file = 1, file_id = 777 WHERE id = ?").run(e);
  try {
    assert.ok(!upgradeUnits(now).some((u) => u.tvdbId === SPELLS));
  } finally {
    cache.prepare("UPDATE episodes SET has_file = 0, file_id = NULL WHERE id = ?").run(e);
  }
});

test("the audit lists the duplicates from ids, with overlap and file counts", () => {
  const row = duplicateListings().find((x) => x.tvdbId === SPELLS && x.otherTvdbId === SLAYERS)!;
  assert.equal(row.mine, "S01E01–03");
  assert.equal(row.there, "S00E03–05");
  assert.deepEqual(row.thereFiles, { files: 3, total: 3 });
  assert.equal(row.mineFiles.files, 0);
  assert.equal(row.blocking, true);
  assert.equal(row.managed, true);
});

test("Berserk 1997 vs 2016: same title, different shows, never flagged", () => {
  assert.equal(ownedElsewhere(330000).size, 0);
  assert.equal(overlapsFor(330000).length, 0);
  assert.ok(!duplicateListings().some((x) => x.tvdbId === 330000 || x.otherTvdbId === 70));
  // No ids either: the title matches but the episode counts (12 vs 25) don't.
  assert.equal(overlapsFor(601, { titleAids: () => [8000] }).length, 0);
});

test("a duplicate whose other home has no files is not blocked, but is listed", () => {
  assert.equal(ownedElsewhere(501).size, 0);
  assert.equal(overlapsFor(501).length, 2);
  assert.equal(missingInScope(501, now), 2);
  const row = duplicateListings().find((x) => x.tvdbId === 501)!;
  assert.equal(row.blocking, false);
  assert.equal(row.otherTvdbId, 500);
});

test("with no ids the exact title plus an agreeing episode count still resolves (title fallback)", () => {
  const o = overlapsFor(600, { titleAids: () => [2950] });
  assert.equal(o.length, 3);
  assert.equal(o[0].via, "title");
  assert.equal(overlapsFor(600, { titleAids: () => [] }).length, 0);
});

test("reverse direction: the parent's empty season is owned when the standalone listing has the files (Lodoss case)", () => {
  // Record of Lodoss War (parent, ids) files Chronicles as S02; the standalone Chronicles (no ids) has all 3 files.
  series(700, 78777, "Record of Lodoss War", [137]);
  const parentS2 = [1, 2, 3].map((n) => episode(700, 2, n, false));
  series(701, 79270, "Record of Lodoss War: Chronicles of the Heroic Knight");
  [1, 2, 3].forEach((n) => episode(701, 1, n, true));
  entry(4100, 137, 78777, "2", 0, 3);
  const deps = { titleAids: (t: string) => (/Chronicles/.test(t) ? [137] : []) };
  const owned = ownedElsewhere(78777, deps);
  assert.deepEqual([...owned.keys()].sort(), [...parentS2].sort());
  assert.match(owned.get(parentS2[0])!.label, /Chronicles of the Heroic Knight S01E01/);
  // The standalone itself is not blocked: its episodes are the ones with files.
  assert.equal(ownedElsewhere(79270, deps).size, 0);
});
