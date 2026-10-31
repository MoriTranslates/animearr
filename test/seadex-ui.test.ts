/** SeaDex on the show page: file comparison, source-aware matching, "Check SeaDex now" cooldown, "Upgrade now", the daily size budget. Mocks only. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-seadexui-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { qualityScore, seadexPick, seadexSource } = await import("../server/core/quality.js");
const { compareToSeadex, pickOfRelease } = await import("../server/core/seadexCompare.js");
const { budgetBytes, fitsBudget, qualityUpgradePass, startNow, upgradeSeasonNow, usedBytes } = await import("../server/qualityUpgrade.js");
const { setLock } = await import("../server/qualityLocks.js");
const { CHECK_COOLDOWN_MS, checkSeadexNow, cooldownLeft, saveSeadex } = await import("../server/seadex.js");
const { seasonComparison, filePick } = await import("../server/seadexFiles.js");
type SE = import("../server/core/quality.js").SeadexEntry;
type SR = import("../server/search.js").SearchResult;

const DAY = 86_400_000;
const GB = 1e9;
const now = Date.now();

const SEADEX: SE = {
  incomplete: false,
  torrents: [
    { group: "Kekkan", tracker: "Nyaa", best: true, dualAudio: true, tags: [] },
    { group: "SubGrp", tracker: "Nyaa", best: false, dualAudio: false, tags: [] },
    { group: "WebGrp", tracker: "Nyaa", best: false, dualAudio: false, tags: ["WEB"] },
  ],
};

// ---------------------------------------------------------------- g) source-aware matching

test("a SeaDex Blu-ray pick doesn't bless the same group's WEB, HDTV or TV raw release", () => {
  assert.equal(seadexPick("Kekkan", SEADEX, "sub", "bluray")?.level, "best");
  assert.equal(seadexPick("Kekkan", SEADEX, "sub", "web"), null);
  assert.equal(seadexPick("Kekkan", SEADEX, "sub", "hdtv"), null);
  assert.equal(seadexPick("Kekkan", SEADEX, "sub", "dvd"), null);
  assert.equal(seadexPick("Kekkan", SEADEX, "sub", null)?.level, "best", "a release that names no source keeps the benefit of the doubt");
  assert.equal(seadexPick("Kekkan", SEADEX, "sub")?.level, "best", "callers that don't know the source behave as before");
});

test("a pick tagged WEB matches that group's WEB release only; untagged picks are Blu-ray", () => {
  assert.equal(seadexSource(SEADEX.torrents[0]), "bluray");
  assert.equal(seadexSource(SEADEX.torrents[2]), "web");
  assert.equal(seadexSource({ tags: ["DVD"], tracker: "" }), "dvd");
  assert.equal(seadexSource({ tags: ["TV raw"], tracker: "" }), "hdtv");
  assert.equal(seadexPick("WebGrp", SEADEX, "sub", "web")?.level, "alt");
  assert.equal(seadexPick("WebGrp", SEADEX, "sub", "bluray"), null);
});

test("quality scoring gives the SeaDex bonus only to the matching source", () => {
  const bd = qualityScore("[Kekkan] Show - 01 (BD 1080p)", { seadex: SEADEX, mode: "dual" });
  const web = qualityScore("[Kekkan] Show - 01 (WEB 1080p)", { seadex: SEADEX, mode: "dual" });
  const tv = qualityScore("[Kekkan] Show - 01 (HDTV 1080p)", { seadex: SEADEX, mode: "dual" });
  assert.equal(bd.seadex, "best");
  assert.equal(web.seadex, null);
  assert.equal(tv.seadex, null);
  assert.ok(bd.points > web.points);
});

// ---------------------------------------------------------------- b) the comparison

test("comparison: best, alt, and 'you have X; SeaDex's best is Y'", () => {
  const best = compareToSeadex(["[Kekkan] Show - 01 (BD 1080p)", "Show.S01E02.1080p.BluRay-Kekkan"], SEADEX, "dual")!;
  assert.equal(best.verdict, "best");
  assert.equal(best.best.group, "Kekkan");
  assert.equal(best.best.dualAudio, true);
  const alt = compareToSeadex(["[SubGrp] Show - 01 (BD 1080p)"], SEADEX, "sub")!;
  assert.equal(alt.verdict, "alt");
  const worse = compareToSeadex(["[Kekkan] Show - 01 (WEB 1080p)", "[Kekkan] Show - 02 (WEB 1080p)", "[Kekkan] Show - 03 (BD 1080p)"], SEADEX, "dual")!;
  assert.equal(worse.verdict, "worse");
  assert.deepEqual(worse.counts, { best: 1, alt: 0, other: 2 });
  assert.deepEqual(worse.have, { group: "Kekkan", source: "web" });
  const other = compareToSeadex(["[SubsPlease] Show - 01 (1080p)"], SEADEX, "dual")!;
  assert.equal(other.verdict, "worse");
  assert.equal(other.have.group, "SubsPlease");
  assert.equal(compareToSeadex([], SEADEX), null);
  assert.equal(compareToSeadex(["[Kekkan] Show - 01 (BD 1080p)"], null), null);
  assert.equal(pickOfRelease("[Kekkan] Show - 01 (BD 1080p)", SEADEX, "dual"), "best");
  assert.equal(pickOfRelease("[Kekkan] Show - 01 (WEB 1080p)", SEADEX, "dual"), null);
});

// ---------------------------------------------------------------- fixtures for the DB-backed tests

let nextEp = 5000;
function show(sid: number, tvdb: number, title: string, scenes: string[], opts: { anilist?: number } = {}) {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, year, path, monitored, original_language, synced_at) VALUES (?, ?, ?, 2024, ?, 0, 'Japanese', 0)").run(sid, tvdb, title, `/media/AnimeArr/${title}`);
  const ids: number[] = [];
  scenes.forEach((scene, i) => {
    const id = nextEp++;
    cache.prepare("INSERT INTO files (id, series_id, season, path, scene_name, resolution, audio_langs, sub_langs) VALUES (?, ?, 1, ?, ?, '1920x1080', 'jpn', 'eng')").run(id + 90000, sid, `/media/AnimeArr/${title}/Season 01/${title} - S01E0${i + 1} [Tdarr x265].mkv`, scene);
    cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, file_id, air_utc, runtime) VALUES (?, ?, 1, ?, 1, 1, ?, ?, 24)").run(id, sid, i + 1, id + 90000, now - 400 * DAY);
    ids.push(id);
  });
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (?, ?, ?, 0, 0)").run(tvdb, sid, title);
  if (opts.anilist) db.prepare("INSERT INTO entries (anilist_id, tvdb_id, tvdb_season, fetched_at) VALUES (?, ?, '1', 0)").run(opts.anilist, tvdb);
  return ids;
}
const result = (title: string, episodeIds: number[], size: number): SR =>
  ({
    guid: `g-${title}`, title, indexer: "X", indexerId: 1, protocol: "usenet", size, seeders: null, publishDate: null, ageHours: 1, episodeIds, label: "S01", confidence: 95, coversTarget: true, extra: 0,
    rank: { accept: true, score: 100, langProb: 0.95, lang: "en", langSource: "x", flags: [], why: "", reject: null },
    mappingWhy: [], group: null, downloadUrl: "http://x",
  }) as SR;
const web = (n: string) => `[SubsPlease] ${n} - 01 (1080p) [AAAA1111]`;
const pack = (n: string) => `[SomeBD] ${n} (BD 1080p)`;

const E: Record<string, number[]> = {};
before(() => {
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/AnimeArr"], managed: { ...s.managed, dryRun: false }, qualityUpgrade: { mode: "auto", paused: false, seasonsPerDay: 10, gbPerDay: 10, perHour: 50, recheckDays: 21 } }));
  E.cmp = show(1, 810001, "Compare Show", ["Compare.Show.S01E01.1080p.BluRay.x264-Kekkan", "Compare.Show.S01E02.1080p.WEB-DL-Kekkan"], { anilist: 9801 });
  saveSeadex(9801, SEADEX, now);
  E.a = show(2, 810002, "Budget A", [web("Budget A")]);
  E.b = show(3, 810003, "Budget B", [web("Budget B")]);
  E.c = show(4, 810004, "Budget C", [web("Budget C")]);
  E.now = show(5, 810005, "Now Show", [web("Now Show")]);
  E.chk = show(6, 810006, "Check Show", [web("Check Show")], { anilist: 9802 });
});

test("the season comparison reads the files' ORIGINAL release names (a Tdarr re-encode keeps its scene name)", () => {
  const c = seasonComparison(810001, 1)!;
  assert.equal(c.verdict, "worse", "one file is Kekkan BD, the other Kekkan WEB");
  assert.deepEqual(c.counts, { best: 1, alt: 0, other: 1 });
  assert.equal(c.have.source, "web");
  const eps = cache.prepare("SELECT e.id, f.path, f.scene_name FROM episodes e JOIN files f ON f.id = e.file_id WHERE e.series_id = 1 ORDER BY e.episode").all() as { id: number; path: string; scene_name: string }[];
  assert.equal(filePick(810001, 1, { path: eps[0].path, sceneName: eps[0].scene_name }), "best");
  assert.equal(filePick(810001, 1, { path: eps[1].path, sceneName: eps[1].scene_name }), null);
  assert.equal(seasonComparison(810001, 7), null, "no SeaDex picks for that season");
});

// ---------------------------------------------------------------- f) the size budget

test("size budget: fits, waits, and a season bigger than the whole budget goes alone", () => {
  assert.equal(fitsBudget(0, 10 * GB, 6 * GB), "fits");
  assert.equal(fitsBudget(6 * GB, 10 * GB, 4 * GB), "fits", "exactly what is left");
  assert.equal(fitsBudget(6 * GB, 10 * GB, 6 * GB), "waits");
  assert.equal(fitsBudget(0, 10 * GB, 30 * GB), "oversize", "bigger than the whole budget, budget untouched");
  assert.equal(fitsBudget(1, 10 * GB, 30 * GB), "waits", "bigger than the whole budget, but something was grabbed today");
  assert.equal(budgetBytes({}), 100 * GB, "default 100 GB a day");
  assert.equal(budgetBytes({ gbPerDay: 5 }), 5 * GB);
});

test("auto: a season that would exceed the day's size budget waits; it is grabbed on a later day", async () => {
  const sizes: Record<number, number> = { 810002: 6 * GB, 810003: 6 * GB, 810004: 30 * GB };
  const grabbed: string[] = [];
  let gid = 970;
  const d = {
    search: (async (tvdb: number, eps: number[]) => ({ results: [result(pack(`Show${tvdb}`), eps, sizes[tvdb] ?? 1 * GB)] })) as never,
    grab: (async (req: { tvdbId: number; candidate: { title: string }; episodeIds: number[] }) => {
      grabbed.push(`${req.tvdbId}`);
      const id = ++gid;
      db.prepare("INSERT INTO grabs (id, at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, state, dry_run, purpose) VALUES (?, 0, 0, ?, 1, ?, ?, ?, 'usenet', 'downloading', 0, 'replace')").run(id, req.tvdbId, JSON.stringify(req.episodeIds), req.candidate.title, `g-${id}`);
      return { id, dryRun: false, message: "Sent" };
    }) as never,
  };
  // Only the three budget shows are candidates in these passes.
  for (const tvdb of [810001, 810005, 810006]) db.prepare("INSERT OR REPLACE INTO quality_upgrade (tvdb_id, season, state, last_at, why, updated_at) VALUES (?, 1, 'waiting', ?, '', ?)").run(tvdb, now, now);
  startNow();
  const t0 = now + 10 * 60_000;
  const r1 = await qualityUpgradePass(d, t0);
  assert.equal(r1.grabbed, 1, "6 GB fits in 10 GB; the second 6 GB doesn't");
  assert.equal(usedBytes(t0), 6 * GB);
  const waiting = db.prepare("SELECT tvdb_id, season, state, why FROM quality_upgrade WHERE state = 'budget'").all() as { tvdb_id: number; why: string }[];
  assert.ok(waiting.length >= 1, "the one that didn't fit is marked as waiting for the budget");
  assert.match(waiting[0].why, /waits/);
  assert.ok(db.prepare("SELECT 1 FROM decisions WHERE why LIKE '%waiting for the daily size budget%'").get());
  // Later days (the 24 h window empties): the waiting ones are tried again. A season bigger than the whole budget
  // goes only while the day's budget is untouched, and the decision says so.
  let at = t0;
  for (let i = 0; i < 3; i++) {
    at += DAY + 7 * 3_600_000;
    await qualityUpgradePass(d, at);
  }
  assert.deepEqual([...new Set(grabbed)].sort(), ["810002", "810003", "810004"], "every season was grabbed in the end");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM quality_upgrade WHERE state = 'budget'").get().n, 0);
  assert.ok(db.prepare("SELECT 1 FROM decisions WHERE why LIKE '%more than the whole daily budget%'").get(), "the oversized season is reported");
});

// ---------------------------------------------------------------- e) Upgrade now

test("Upgrade now: previews the watcher's pick with its size, grabs only on confirm, respects locks and practice mode", async () => {
  const grabs: string[] = [];
  const mk = (dryRun: boolean) => ({
    search: (async (_t: number, eps: number[]) => ({ results: [result(pack("Now Show"), eps, 12 * GB)] })) as never,
    grab: (async (req: { candidate: { title: string } }) => (grabs.push(req.candidate.title), { id: 990, dryRun, message: dryRun ? "dry run" : "Sent" })) as never,
  });
  const before = usedBytes(now);
  const p = await upgradeSeasonNow(810005, 1, {}, mk(false), now);
  assert.equal(p.status, "preview");
  assert.equal(p.size, 12 * GB);
  assert.equal(p.release, pack("Now Show"));
  assert.match(p.to ?? "", /Bluray/);
  assert.equal(grabs.length, 0, "a preview grabs nothing");
  const dry = await upgradeSeasonNow(810005, 1, { confirm: true }, mk(true), now);
  assert.equal(dry.status, "dry-run", "practice mode: nothing is grabbed");
  assert.equal(usedBytes(now), before, "a dry run doesn't count towards the budget");
  const p2 = await upgradeSeasonNow(810005, 1, {}, mk(false), now + 1000);
  assert.equal(p2.status, "preview");
  const done = await upgradeSeasonNow(810005, 1, { confirm: true }, mk(false), now + 2000);
  assert.equal(done.status, "grabbed");
  assert.equal(usedBytes(now + 2000), before + 12 * GB, "counts towards the budget");
  setLock(810005, 1, true);
  const locked = await upgradeSeasonNow(810005, 1, {}, mk(false), now + 3000);
  assert.equal(locked.status, "refused");
  assert.match(locked.why, /keep as is/);
  setLock(810005, 1, false);
  const nope = await upgradeSeasonNow(999999, 1, {}, mk(false), now);
  assert.equal(nope.status, "refused", "not a managed show");
});

test("Upgrade now: nothing better than the files is reported, and nothing is grabbed (no-churn rule)", async () => {
  const d = {
    search: (async (_t: number, eps: number[]) => ({ results: [result("[OtherWeb] Check Show (1080p)", eps, GB)] })) as never,
    grab: (async () => assert.fail("must not grab")) as never,
  };
  const r = await upgradeSeasonNow(810006, 1, {}, d, now);
  assert.equal(r.status, "nothing");
});

// ---------------------------------------------------------------- d) Check SeaDex now

test("Check SeaDex now: fetches and saves, then waits out the cooldown", async () => {
  assert.equal(cooldownLeft(null, now), 0);
  assert.equal(cooldownLeft(now - 60_000, now), CHECK_COOLDOWN_MS - 60_000);
  assert.equal(cooldownLeft(now - CHECK_COOLDOWN_MS - 1, now), 0);
  let calls = 0;
  const fetcher = (async (url: string) => {
    calls++;
    assert.match(String(url), /alID%3D9802/);
    return { ok: true, json: async () => ({ items: [{ incomplete: false, expand: { trs: [{ releaseGroup: "Kekkan", tracker: "Nyaa", isBest: true, dualAudio: true, tags: [] }] } }] }) };
  }) as unknown as typeof fetch;
  const first = await checkSeadexNow(810006, { fetch: fetcher }, now);
  assert.equal(first.status, "checked");
  assert.equal(first.found, 1);
  assert.equal(calls, 1);
  assert.equal((db.prepare("SELECT found FROM seadex WHERE anilist_id = 9802").get() as { found: number }).found, 1);
  const again = await checkSeadexNow(810006, { fetch: fetcher }, now + 60_000);
  assert.equal(again.status, "cooldown");
  assert.equal(calls, 1, "no request inside the cooldown");
  assert.ok(again.retryInMs > 0);
  const later = await checkSeadexNow(810006, { fetch: fetcher }, now + CHECK_COOLDOWN_MS + 1000);
  assert.equal(later.status, "checked");
  assert.equal(calls, 2);
  assert.equal((await checkSeadexNow(810002, { fetch: fetcher }, now)).status, "none", "no AniList entry known: nothing to look up");
});
