/** Quality upgrade watcher: goals, locks, Tdarr re-encodes, the first-run plan, pause, budgets, SeaDex cache. Mocks only. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-quality-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { getSettings, patchSettings } = await import("../server/settings.js");
const { profileFor, saveProfile, defaultProfile } = await import("../server/profiles.js");
const { capOf, pickUpgrade, planState, qualityUpgradePass, startNow, upgradeUnits } = await import("../server/qualityUpgrade.js");
const { keepTagFor, locksFor, setLock } = await import("../server/qualityLocks.js");
const { parseSeadex, saveSeadex, seadexForSeason, seadexPass } = await import("../server/seadex.js");
type Deps = import("../server/qualityUpgrade.js").QualityDeps;
type SR = import("../server/search.js").SearchResult;

const DAY = 86_400_000;
const now = Date.now();
before(() => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, year, path, monitored, original_language, synced_at) VALUES (40, 700001, 'Web Show', 2024, '/media/AnimeArr/Web Show', 0, 'Japanese', 0), (41, 700002, 'Encoded Show', 2020, '/media/AnimeArr/Encoded Show', 0, 'Japanese', 0), (42, 700003, 'Old Show', 1992, '/media/AnimeArr/Old Show', 0, 'Japanese', 0)").run();
  // [episode id, series, season, ep, path, scene name]
  const rows: [number, number, number, number, string, string | null][] = [
    [4001, 40, 1, 1, "/media/AnimeArr/Web Show/Season 01/Web Show - S01E01.mkv", "[SubsPlease] Web Show - 01 (1080p) [AAAA1111]"],
    [4002, 40, 1, 2, "/media/AnimeArr/Web Show/Season 01/Web Show - S01E02.mkv", "[SubsPlease] Web Show - 02 (1080p) [AAAA2222]"],
    [4003, 40, 1, 3, "/media/AnimeArr/Web Show/Season 01/Web Show - S01E03 [Remaster].mkv", "[SubsPlease] Web Show - 03 (1080p)"],
    [4004, 40, 2, 1, "/media/AnimeArr/Web Show/Season 02/Web Show - S02E01 [Keep].mkv", "[SubsPlease] Web Show S2 - 01 (1080p)"],
    // Tdarr re-encoded it: the file name says x265, the recorded original release is the Blu-ray.
    [4101, 41, 1, 1, "/media/AnimeArr/Encoded Show/Season 01/Encoded Show - S01E01 [WEBDL-1080p x265].mkv", "Encoded.Show.S01E01.1080p.BluRay.x264-Grp"],
    [4201, 42, 1, 1, "/media/AnimeArr/Old Show/Season 01/Old Show - S01E01.mkv", "[Grp] Old Show - 01 [DVD 480p]"],
  ];
  for (const [id, sid, season, ep, p, scene] of rows) {
    cache.prepare("INSERT INTO files (id, series_id, season, path, scene_name, resolution, audio_langs, sub_langs) VALUES (?, ?, ?, ?, ?, '1920x1080', 'jpn', 'eng')").run(id + 50000, sid, season, p, scene);
    cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, file_id, air_utc, runtime) VALUES (?, ?, ?, ?, 1, 1, ?, ?, 24)").run(id, sid, season, ep, id + 50000, now - 400 * DAY);
  }
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (700001, 40, 'Web Show', 0, 0), (700002, 41, 'Encoded Show', 0, 0), (700003, 42, 'Old Show', 0, 0)").run();
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/AnimeArr"], managed: { ...s.managed, dryRun: false }, qualityUpgrade: { mode: "auto", paused: false, seasonsPerDay: 1, perHour: 10, recheckDays: 21 } }));
});

const result = (title: string, episodeIds: number[], over: Partial<SR> = {}): SR =>
  ({
    guid: `g-${title}`, title, indexer: "X", indexerId: 1, protocol: "usenet", size: 8e9, seeders: null, publishDate: null, ageHours: 1, episodeIds, label: "S01", confidence: 95, coversTarget: true, extra: 0,
    rank: { accept: true, score: 100, langProb: 0.95, lang: "en", langSource: "x", flags: [], why: "", reject: null },
    mappingWhy: [], group: null, downloadUrl: "http://x",
    ...over,
  }) as SR;

function deps(results: SR[]) {
  const calls = { searched: [] as number[][], grabbed: [] as { title: string; purpose?: string | null; episodeIds: number[] }[] };
  let gid = 950;
  const d: Deps = {
    search: (async (_tvdb: number, eps: number[]) => (calls.searched.push(eps), { results })) as never,
    grab: (async (req: { candidate: { title: string }; episodeIds: number[]; purpose?: string | null }) => {
      calls.grabbed.push({ title: req.candidate.title, purpose: req.purpose, episodeIds: req.episodeIds });
      const id = ++gid;
      db.prepare("INSERT INTO grabs (id, at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, state, dry_run, purpose) VALUES (?, 0, 0, 700001, 40, ?, ?, ?, 'usenet', 'downloading', 0, 'replace')").run(id, JSON.stringify(req.episodeIds), req.candidate.title, `g-${id}`);
      return { id, dryRun: false, message: "Sent to sabnzbd" };
    }) as never,
  };
  return { d, calls };
}

test("the default goal is Aim high and the goal question starts unanswered", () => {
  assert.equal(profileFor(null).qualityGoal, "high");
  assert.equal(profileFor(700001).reencode, "tdarr");
  assert.equal(getSettings().qualityGoalAsked, false);
  // The wizard / Home card saves the answer on the default profile.
  saveProfile(defaultProfile().id, { qualityGoal: "collector" });
  assert.equal(profileFor(700001).qualityGoal, "collector");
  saveProfile(defaultProfile().id, { qualityGoal: "nonsense" as never });
  assert.equal(profileFor(700001).qualityGoal, "collector", "an unknown goal keeps the old one");
  saveProfile(defaultProfile().id, { qualityGoal: "high" });
});

test("units: files below the goal; [Keep]/[Remaster] files skipped; a Tdarr re-encode judged by its original release", () => {
  const units = upgradeUnits(now);
  const web = units.find((u) => u.tvdbId === 700001);
  assert.ok(web);
  assert.equal(web.season, 1, "season 2's only file is tagged [Keep]");
  assert.deepEqual(web.files.map((f) => f.episodeId), [4001, 4002], "the [Remaster] file is never touched");
  assert.ok(!units.some((u) => u.tvdbId === 700002), "re-encoded by Tdarr, but the original was a Blu-ray: at the goal");
  assert.ok(units.some((u) => u.tvdbId === 700003), "the DVD show is below Blu-ray until the cap kicks in");
});

test("locks: a locked season leaves the plan, and its files get the {Keep Tag}", () => {
  assert.equal(keepTagFor(700001, 1), false);
  setLock(700001, 1, true);
  assert.deepEqual(locksFor(700001), { show: false, seasons: [1] });
  assert.equal(keepTagFor(700001, 1), true);
  assert.ok(!upgradeUnits(now).some((u) => u.tvdbId === 700001));
  setLock(700001, 1, false);
  setLock(700001, null, true);
  assert.ok(!upgradeUnits(now).some((u) => u.tvdbId === 700001), "the whole show locked");
  setLock(700001, null, false);
  assert.ok(upgradeUnits(now).some((u) => u.tvdbId === 700001));
});

test("a keep-original profile is locked by definition (Tdarr skips its [Keep] files too)", () => {
  const p = saveProfile(null, { name: "Originals", reencode: "keep" });
  db.prepare("INSERT INTO series_prefs (tvdb_id, profile_id, updated_at) VALUES (700003, ?, 0)").run(p.id);
  assert.equal(keepTagFor(700003, 1), true);
  assert.ok(!upgradeUnits(now).some((u) => u.tvdbId === 700003));
  db.prepare("DELETE FROM series_prefs WHERE tvdb_id = 700003").run();
});

test("no Blu-ray exists: a DVD-era show caps at the best seen after two searches", () => {
  assert.equal(capOf({ best_seen: "dvd", no_bd: 1 }, 1992, null, now), null);
  assert.equal(capOf({ best_seen: "dvd", no_bd: 2 }, 1992, null, now), "dvd");
  assert.equal(capOf({ best_seen: "web-1080", no_bd: 3 }, 2024, now - 30 * DAY, now), null, "a recent show keeps waiting for its BD");
  assert.equal(capOf({ best_seen: "web-1080", no_bd: 6 }, 2015, now - 400 * DAY, now), "web-1080");
});

test("pickUpgrade: must beat every file it replaces; packs first; no burn-ins or dead torrents", () => {
  const unit = upgradeUnits(now).find((u) => u.tvdbId === 700001)!;
  const ctx = { seadex: null, mode: "sub" as const, minConfidence: 80 };
  const pack = result("[SomeBD] Web Show (BD 1080p)", [4001, 4002]);
  const single = result("[SomeBD] Web Show - 01 (BD 1080p)", [4001]);
  const sameWeb = result("[OtherWeb] Web Show (1080p)", [4001, 4002]);
  assert.equal(pickUpgrade([single, pack], unit, ctx)?.result.title, pack.title);
  assert.equal(pickUpgrade([sameWeb], unit, ctx), null, "an equal WEB release isn't an upgrade");
  assert.equal(pickUpgrade([result("[SomeBD] Web Show (BD 1080p)", [4001, 4002], { rank: { ...pack.rank, flags: [{ key: "burnIn", label: "", tone: "warn" }] } })], unit, ctx), null);
  assert.equal(pickUpgrade([result("[SomeBD] Web Show (BD 1080p)", [4001, 4002], { protocol: "torrent", seeders: 0 })], unit, ctx), null);
});

test("the first run only lists its plan; grabs wait a day or for Start now; pause stops them", async () => {
  const { d, calls } = deps([result("[SomeBD] Web Show (BD 1080p)", [4001, 4002])]);
  const first = await qualityUpgradePass(d, now);
  assert.equal(first.planned, true);
  assert.equal(calls.searched.length, 0);
  assert.ok(planState(now).planAt);
  assert.equal(planState(now).live, false);
  const waiting = await qualityUpgradePass(d, now + 60_000);
  assert.equal(waiting.searched, 0, "still within the day to look at the plan");
  patchSettings((s) => ({ ...s, qualityUpgrade: { ...s.qualityUpgrade, paused: true } }));
  startNow();
  assert.equal((await qualityUpgradePass(d, now + 120_000)).paused, true);
  assert.equal(calls.searched.length, 0);
  patchSettings((s) => ({ ...s, qualityUpgrade: { ...s.qualityUpgrade, paused: false } }));
});

test("auto: the upgrade is a Replace-season grab of the files below the goal, within the daily budget", async () => {
  const { d, calls } = deps([result("[SomeBD] Web Show (BD 1080p)", [4001, 4002]), result("[SomeBD] Old Show (BD 1080p)", [4201])]);
  // The Old Show was looked at a moment ago (not due), so Web Show is the only candidate this pass.
  db.prepare("INSERT OR REPLACE INTO quality_upgrade (tvdb_id, season, state, last_at, why, updated_at) VALUES (700003, 1, 'waiting', ?, '', ?)").run(now, now);
  const r = await qualityUpgradePass(d, now + 180_000);
  assert.equal(r.grabbed, 1, "seasonsPerDay = 1");
  assert.equal(calls.grabbed[0].purpose, "replace");
  assert.deepEqual(calls.grabbed[0].episodeIds, [4001, 4002]);
  const st = db.prepare("SELECT state, release FROM quality_upgrade WHERE tvdb_id = 700001 AND season = 1").get() as { state: string; release: string };
  assert.equal(st.state, "grabbed");
  const why = (db.prepare("SELECT why FROM decisions WHERE why LIKE 'Quality upgrade for Web Show S01%' ORDER BY id DESC LIMIT 1").get() as { why: string }).why;
  assert.match(why, /Bluray 1080p beats your WEB 1080p/);
  assert.match(why, /recycling bin/);
  // The budget is spent: nothing more today.
  assert.equal((await qualityUpgradePass(d, now + 240_000)).grabbed, 0);
  // The grab finished: the season counts as upgraded.
  db.prepare("UPDATE grabs SET state = 'done' WHERE release = '[SomeBD] Web Show (BD 1080p)'").run();
  await qualityUpgradePass(d, now + 300_000);
  assert.equal((db.prepare("SELECT state FROM quality_upgrade WHERE tvdb_id = 700001 AND season = 1").get() as { state: string }).state, "upgraded");
});

test("SeaDex: parsed from releases.moe, cached per AniList entry, merged per TVDB season, fetched within a budget", async () => {
  const json = { items: [{ alID: 9001, incomplete: false, expand: { trs: [{ releaseGroup: "A&C", tracker: "Nyaa", isBest: true, dualAudio: true, tags: ["VFR"] }, { releaseGroup: "A&C", tracker: "AB", isBest: true, dualAudio: true, tags: [] }, { releaseGroup: "Alt", tracker: "Nyaa", isBest: false, dualAudio: false }] } }] };
  const e = parseSeadex(json)!;
  assert.equal(e.torrents.length, 2, "the same group on two trackers counts once");
  assert.equal(parseSeadex({ items: [] }), null);
  db.prepare("INSERT INTO entries (anilist_id, tvdb_id, tvdb_season, fetched_at) VALUES (9001, 700001, '1', 0), (9002, 700001, '1', 0)").run();
  saveSeadex(9001, e, now);
  saveSeadex(9002, null, now);
  const merged = seadexForSeason(700001, 1)!;
  assert.deepEqual(merged.torrents.map((t) => t.group), ["A&C", "Alt"]);
  assert.equal(seadexForSeason(700001, 9), null);
  // Due entries are fetched with the injected fetch (no network in tests).
  db.prepare("INSERT INTO entries (anilist_id, tvdb_id, tvdb_season, fetched_at) VALUES (9003, 700002, '1', 0)").run();
  const urls: string[] = [];
  const r = await seadexPass({ fetch: (async (u: string) => (urls.push(u), new Response(JSON.stringify(json), { status: 200 }))) as never }, now);
  assert.ok(r.fetched >= 1);
  assert.ok(urls.every((u) => u.startsWith("https://releases.moe/api/collections/entries/records?") && u.includes("alID%3D")));
  assert.ok(seadexForSeason(700002, 1));
});
