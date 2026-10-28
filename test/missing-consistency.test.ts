/**
 * One definition of "missing episode" across screens (playtest: Schedule said none, Settings 0, Audit/Fill-in 34, and
 * Frieren's premiere episodes 1–4 vanished because AniList's airing schedule starts at episode 5).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-missing-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { materialize } = await import("../server/native.js");
const { gaps } = await import("../server/audit.js");
const { missingInScope } = await import("../server/fillin.js");
const { backlogSummary } = await import("../server/managed.js");
const { setScope, missingScoped } = await import("../server/scope.js");

const DAY = 86_400_000;
const PREMIERE = Date.parse("2023-09-29");
let sid = 0;

before(() => {
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Anime"] }));
  const ins = db.prepare("INSERT INTO entries (anilist_id, tvdb_id, tvdb_season, tvdb_offset, kind, title_english, synonyms, status, start_date, episodes, fetched_at) VALUES (?, 4242, ?, 0, 'TV', ?, '[]', 'FINISHED', ?, ?, 1)");
  ins.run(901, "1", "Frieren", "2023-09-29", 28);
  ins.run(902, "2", "Frieren 2", "2026-01-16", 10);
  const ep = db.prepare("INSERT INTO entry_episodes (anilist_id, number, title, air_utc, source) VALUES (?, ?, NULL, ?, 'anilist')");
  // Like AniList: season 1's schedule starts at episode 5 (1–4 aired together on the premiere day).
  for (let n = 5; n <= 28; n++) ep.run(901, n, PREMIERE + (n - 4) * 7 * DAY);
  for (let n = 1; n <= 10; n++) ep.run(902, n, Date.parse("2026-01-16") + (n - 1) * 7 * DAY);
  db.prepare("INSERT INTO native_series (tvdb_id, anilist_id, synthetic, title, year, path, root_folder, added_at) VALUES (4242, 901, 0, 'Frieren', 2023, '/media/Anime/Frieren (2023)', '/media/Anime', 1)").run();
  materialize(db.prepare("SELECT * FROM native_series WHERE tvdb_id = 4242").get() as never);
  sid = (cache.prepare("SELECT id FROM series WHERE tvdb_id = 4242").get() as { id: number }).id;
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (4242, ?, 'Frieren', 1, 0)").run(sid);
  setScope([4242], { seasons: "all", recentN: 1, episodes: "missing", specials: false, creditless: false });
});

test("episodes before the first dated one have aired too (premiere date), so they count as missing", () => {
  const rows = cache.prepare("SELECT episode, air_utc FROM episodes WHERE series_id = ? AND season = 1 AND episode <= 5 ORDER BY episode").all(sid) as { episode: number; air_utc: number | null }[];
  assert.deepEqual(rows.slice(0, 4).map((r) => r.air_utc), [PREMIERE, PREMIERE, PREMIERE, PREMIERE]);
  assert.ok(rows[4].air_utc! > PREMIERE);
});

test("Audit, Fill-in, the Settings missing search and Schedule agree on the number", () => {
  const now = Date.now();
  const g = gaps().series.find((s) => s.tvdbId === 4242)!;
  assert.equal(g.missing.length, 38, "every missing episode is listed, whole seasons too");
  assert.deepEqual(g.missingSeasons.map((m) => m.season), [1, 2], "a show with nothing yet has every season missing");
  assert.equal(missingInScope(4242, now), 38);
  assert.equal(missingScoped(4242, sid, now).length, 38);
  const b = backlogSummary(now);
  assert.equal(b.missingAll, 38);
  assert.equal(b.missing, 38, "all aired more than 30 days ago");
});
