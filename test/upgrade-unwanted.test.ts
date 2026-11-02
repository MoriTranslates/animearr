/**
 * An episode you don't monitor is never upgraded or replaced automatically (Sonarr's rule, user-approved 2026-11-02):
 * the quality and dual-audio watchers skip every episode outside the show's scope, season by season, while "Upgrade
 * now" and a hand-started replacement still work on them. Mocks only: nothing is searched or grabbed for real.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-upg-unwanted-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { setSeriesPrefs } = await import("../server/library/profiles.js");
const { setScope } = await import("../server/library/scope.js");
const { qualityUpgradePass, startNow, upgradeSeasonNow, upgradeUnits } = await import("../server/search/qualityUpgrade.js");
const { placeholders } = await import("../server/search/upgrade.js");
const { searchAgainSoon } = await import("../server/library/episodes.js");
type Deps = import("../server/search/qualityUpgrade.js").QualityDeps;
type SR = import("../server/search/search.js").SearchResult;

const DAY = 86_400_000;
const now = Date.now();
// Continuing, default scope (the latest season): S1 is not monitored, S2 is.
const LONG = 760001;
// Dual watch mode, default scope: S1 sub-only files are not monitored, S2's are.
const DUAL = 760002;
// Managed with scope "none": nothing is monitored.
const NONE = 760003;

before(() => {
  const series = cache.prepare(
    "INSERT INTO series (id, tvdb_id, title, path, monitored, status, original_language, synced_at) VALUES (?, ?, ?, ?, 1, 'continuing', 'Japanese', 0)",
  );
  series.run(60, LONG, "Long Show", "/media/AnimeArr/Long Show");
  series.run(61, DUAL, "Dual Show", "/media/AnimeArr/Dual Show");
  series.run(62, NONE, "None Show", "/media/AnimeArr/None Show");
  const file = cache.prepare(
    "INSERT INTO files (id, series_id, season, path, scene_name, resolution, audio_langs, sub_langs) VALUES (?, ?, ?, ?, ?, '1920x1080', ?, 'eng')",
  );
  const ep = cache.prepare(
    "INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, file_id, air_utc, runtime) VALUES (?, ?, ?, ?, 1, 1, ?, ?, 24)",
  );
  // [episode id, series id, title, season, episode, audio]
  for (const [id, sid, title, season, n, audio] of [
    [6011, 60, "Long Show", 1, 1, "jpn"],
    [6012, 60, "Long Show", 1, 2, "jpn"],
    [6021, 60, "Long Show", 2, 1, "jpn"],
    [6022, 60, "Long Show", 2, 2, "jpn"],
    [6111, 61, "Dual Show", 1, 1, "jpn"],
    [6121, 61, "Dual Show", 2, 1, "jpn"],
    [6211, 62, "None Show", 1, 1, "jpn"],
  ] as const) {
    const p = `/media/AnimeArr/${title}/Season 0${season}/${title} - S0${season}E0${n}.mkv`;
    file.run(id + 50000, sid, season, p, `[SubsPlease] ${title} - ${season}${n} (1080p) [ABCD${id}]`, audio);
    ep.run(id, sid, season, n, id + 50000, now - (season === 1 ? 400 : 20) * DAY);
  }
  db.prepare(
    "INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (?, 60, 'Long Show', 0, 0), (?, 61, 'Dual Show', 0, 0), (?, 62, 'None Show', 0, 0)",
  ).run(LONG, DUAL, NONE);
  setScope([NONE], { seasons: "all", recentN: 1, episodes: "none", specials: false, creditless: false });
  setSeriesPrefs(DUAL, null, "dual");
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/AnimeArr"],
    managed: { ...s.managed, dryRun: false },
    qualityUpgrade: { mode: "auto", paused: false, seasonsPerDay: 5, perHour: 10, recheckDays: 21 },
    dualUpgrade: { mode: "log", perHour: 5, recheckDays: 3, maxAgeDays: 1000 },
  }));
});

const result = (title: string, episodeIds: number[]): SR =>
  ({
    guid: `g-${title}`,
    title,
    indexer: "X",
    indexerId: 1,
    protocol: "usenet",
    size: 8e9,
    seeders: null,
    publishDate: null,
    ageHours: 1,
    episodeIds,
    label: "S01",
    confidence: 95,
    coversTarget: true,
    extra: 0,
    rank: { accept: true, score: 100, langProb: 0.95, lang: "en", langSource: "x", flags: [], why: "", reject: null },
    mappingWhy: [],
    group: null,
    downloadUrl: "http://x",
  }) as SR;

function deps() {
  const calls = { searched: [] as number[][], grabbed: [] as number[][] };
  let gid = 970;
  const d: Deps = {
    search: (async (_tvdb: number, eps: number[]) => (
      calls.searched.push(eps),
      { results: [result(`[SomeBD] Long Show (BD 1080p) ${eps.join("-")}`, eps)] }
    )) as never,
    grab: (async (req: { candidate: { title: string }; episodeIds: number[] }) => {
      calls.grabbed.push(req.episodeIds);
      const id = ++gid;
      db.prepare(
        "INSERT INTO grabs (id, at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, state, dry_run, purpose) VALUES (?, 0, 0, ?, 60, ?, ?, ?, 'usenet', 'downloading', 0, 'replace')",
      ).run(id, LONG, JSON.stringify(req.episodeIds), req.candidate.title, `g-${id}`);
      return { id, dryRun: false, message: "Sent to sabnzbd" };
    }) as never,
  };
  return { d, calls };
}

test("quality watcher: an out-of-scope season of a default-scope show gets no upgrade; the wanted season does", async () => {
  const units = (await upgradeUnits(now)).filter((u) => u.tvdbId === LONG);
  assert.deepEqual(
    units.map((u) => u.season),
    [2],
    "S1 is outside the default scope (latest season)",
  );
  const all = (await upgradeUnits(now, { includeUnwanted: true })).filter((u) => u.tvdbId === LONG);
  assert.deepEqual(
    all.map((u) => u.season),
    [1, 2],
    "S1 really is below the goal: only monitoring keeps it out",
  );
  const { d, calls } = deps();
  startNow();
  await qualityUpgradePass(d, now + 120_000);
  assert.ok(calls.searched.length > 0, "the watcher ran");
  assert.ok(
    calls.searched.every((eps) => !eps.includes(6011) && !eps.includes(6012)),
    "S1 was never searched",
  );
  assert.ok(
    calls.grabbed.every((eps) => !eps.includes(6011) && !eps.includes(6012)),
    "S1 was never grabbed",
  );
  assert.ok(
    calls.grabbed.some((eps) => eps.includes(6021)),
    "a wanted episode still upgrades",
  );
});

test("a show that wants nothing (scope 'none') is never upgraded", async () => {
  assert.ok(!(await upgradeUnits(now)).some((u) => u.tvdbId === NONE));
});

test("dual-audio watcher: sub-only files of an unmonitored season aren't placeholders to upgrade", () => {
  const ids = placeholders(now)
    .filter((w) => w.tvdbId === DUAL)
    .map((w) => w.episodeId);
  assert.deepEqual(ids, [6121]);
});

test("by hand it still works: 'Upgrade now' on an unmonitored season, and a replacement search for an unwanted episode", async () => {
  const { d, calls } = deps();
  const r = await upgradeSeasonNow(LONG, 1, {}, d, now + 600_000);
  assert.notEqual(r.status, "refused", JSON.stringify(r));
  assert.deepEqual(calls.searched.at(-1), [6011, 6012]);
  searchAgainSoon(NONE, [6211], { replace: true, why: "you asked" });
  const st = db.prepare("SELECT state FROM search_state WHERE episode_id = 6211").get() as { state: string } | undefined;
  assert.equal(st?.state, "replace", "the hand-started replacement is queued even though nothing of the show is wanted");
});
