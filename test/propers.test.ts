/** Propers and repacks: v2 / v3 / REPACK / PROPER releases, the same-group upgrade rule, the setting's three modes, locks. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-propers-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { parseRelease } = await import("../server/core/parser.js");
const { isNewerRevision, revisionOf, versionPoints } = await import("../server/core/propers.js");
const { beatsCurrent, qualityScore } = await import("../server/core/quality.js");
const { rankRelease } = await import("../server/core/rank.js");
const { decideSeason } = await import("../server/batch.js");
const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { fileRevision, haveRevisions, newerVersionOf } = await import("../server/propers.js");
const { pickUpgrade, qualityUpgradePass, startNow, upgradeUnits } = await import("../server/qualityUpgrade.js");
const { setLock } = await import("../server/qualityLocks.js");
type SR = import("../server/search.js").SearchResult;
type Deps = import("../server/qualityUpgrade.js").QualityDeps;

const DAY = 86_400_000;
const now = Date.now();

// ---------------------------------------------------------------- parser

test("parser: v2 / v3 on the episode, and scene PROPER / REPACK / RERIP / REAL count as the next version", () => {
  assert.equal(parseRelease("[SubsPlease] Some Show - 09v2 (1080p) [ABCD1234].mkv").version, 2);
  assert.equal(parseRelease("[SubsPlease] Some Show - 09v3 (1080p) [ABCD1234].mkv").version, 3);
  assert.equal(parseRelease("Some.Show.S01E09v2.1080p.WEB.H264-GRP").version, 2);
  assert.equal(parseRelease("Some.Show.S01E09.REPACK.1080p.WEB.H264-GRP").version, 2);
  assert.equal(parseRelease("Some.Show.S01E09.PROPER.1080p.WEB.H264-GRP").version, 2);
  assert.equal(parseRelease("Some.Show.S01E09.RERIP.1080p.BluRay.x264-GRP").version, 2);
  assert.equal(parseRelease("Some Show S01E09 REAL 1080p WEB-DL").version, 2);
  assert.equal(parseRelease("Some.Show.S01E09.1080p.BluRay.REPACK2-GRP").version, 3);
  assert.equal(parseRelease("[SubsPlease] Some Show - 09 (1080p) [ABCD1234].mkv").version, 1);
  // The same words inside a title are just words.
  assert.equal(parseRelease("Real Girl S01E09 1080p WEB-DL-GRP").version, 1);
  assert.equal(parseRelease("[Grp] Proper Care - 09 (1080p)").version, 1);
  assert.equal(parseRelease("Some.Show.S01E09.REPACK.1080p.WEB.H264-GRP").episodes[0], 9, "episode numbers are untouched");
});

// ---------------------------------------------------------------- the rule

const have = { group: "SubsPlease", version: 1 };

test("preferAndUpgrade: the same group's higher version is an upgrade; case of the group doesn't matter", () => {
  const r = isNewerRevision(have, revisionOf("[subsplease] Some Show - 09v2 (1080p)"), "preferAndUpgrade");
  assert.equal(r.ok, true);
  assert.match(r.why, /v2 of the episode you have from SubsPlease \(fixes a v1\)/);
  assert.equal(isNewerRevision(have, revisionOf("Some.Show.S01E09.REPACK.1080p.WEB-SubsPlease"), "preferAndUpgrade").ok, true);
  assert.equal(isNewerRevision({ group: "SubsPlease", version: 2 }, { group: "SubsPlease", version: 3 }, "preferAndUpgrade").ok, true);
});

test("a different group's v2, an equal version and a lower version are not upgrades", () => {
  assert.equal(isNewerRevision(have, revisionOf("[Erai-raws] Some Show - 09v2 (1080p)"), "preferAndUpgrade").ok, false);
  assert.equal(isNewerRevision(have, revisionOf("[SubsPlease] Some Show - 09 (1080p)"), "preferAndUpgrade").ok, false);
  assert.equal(isNewerRevision({ group: "SubsPlease", version: 2 }, { group: "SubsPlease", version: 1 }, "preferAndUpgrade").ok, false);
  assert.equal(isNewerRevision({ group: null, version: 1 }, { group: null, version: 2 }, "preferAndUpgrade").ok, false, "no group on either side: can't tell it is the same release");
});

test("doNotUpgrade and doNotPrefer never replace a file; doNotPrefer also ignores versions in scoring", () => {
  const cand = revisionOf("[SubsPlease] Some Show - 09v2 (1080p)");
  assert.equal(isNewerRevision(have, cand, "doNotUpgrade").ok, false);
  assert.equal(isNewerRevision(have, cand, "doNotPrefer").ok, false);
  assert.equal(versionPoints(2, "preferAndUpgrade"), 2);
  assert.equal(versionPoints(2, "doNotUpgrade"), 2, "still preferred when choosing a new release");
  assert.equal(versionPoints(2, "doNotPrefer"), 0);
  assert.equal(versionPoints(1, "preferAndUpgrade"), 0);
});

test("a locked file is never replaced, not even by a v2", () => {
  assert.equal(isNewerRevision({ ...have, locked: true }, revisionOf("[SubsPlease] Some Show - 09v2 (1080p)"), "preferAndUpgrade").ok, false);
});

test("beatsCurrent: the no-churn rule yields to a newer version of the same group, but not to a lower category", () => {
  const cur = qualityScore("[SubsPlease] Some Show - 09 (1080p)", { tiers: null });
  const same = qualityScore("[SubsPlease] Some Show - 09v2 (1080p)", { tiers: null });
  const best = { ...cur, seadex: "best" as const }; // already its category's best
  assert.equal(beatsCurrent(same, best).ok, false, "without the revision rule an equal category never swaps");
  const rev = { have, cand: revisionOf("[SubsPlease] Some Show - 09v2 (1080p)"), mode: "preferAndUpgrade" as const };
  assert.equal(beatsCurrent(same, best, rev).ok, true);
  assert.equal(beatsCurrent(same, best, { ...rev, mode: "doNotUpgrade" }).ok, false);
  assert.equal(beatsCurrent(same, best, { ...rev, have: { ...have, locked: true } }).ok, false);
  const worse = qualityScore("[SubsPlease] Some Show - 09v2 (720p)", { tiers: null });
  assert.equal(beatsCurrent(worse, best, rev).ok, false, "a v2 in a lower quality category is not an upgrade");
});

// ---------------------------------------------------------------- ranking

const profile = { subLangs: ["en"], softOnly: true, preferUncensored: false, protocolOrder: ["usenet" as const, "torrent" as const], resolution: 1080 };
const info = { protocol: "usenet" as const, size: 1.4e9, episodeCount: 1, runtimeMin: 24 };
const rank = (title: string, known = {}) => rankRelease(parseRelease(title), info, profile, null, known);

test("search ranking: the higher version wins among one group's releases; the flag says why; doNotPrefer ignores versions", () => {
  const v1 = rank("[SubsPlease] Some Show - 09 (1080p) [AAAA1111]", { have });
  const v2 = rank("[SubsPlease] Some Show - 09v2 (1080p) [BBBB2222]", { have });
  assert.ok(v2.score > v1.score);
  assert.ok(v2.flags.some((f) => f.key === "newerVersion" && f.label === "Newer version"));
  assert.match(v2.why, /v2 of the episode you have from SubsPlease \(fixes a v1\) — upgrade/);
  assert.ok(!v1.flags.some((f) => f.key === "newerVersion"));
  const other = rank("[Erai-raws] Some Show - 09v2 (1080p) [CCCC3333]", { have });
  assert.ok(!other.flags.some((f) => f.key === "newerVersion"), "another group's v2 is just a v2");
  assert.ok(!rank("[SubsPlease] Some Show - 09v2 (1080p)", { have, propers: "doNotUpgrade" }).flags.some((f) => f.key === "newerVersion"));
  assert.equal(rank("[SubsPlease] Some Show - 09v2 (1080p)", { propers: "doNotPrefer" }).score, rank("[SubsPlease] Some Show - 09 (1080p)", { propers: "doNotPrefer" }).score);
  assert.ok(rank("[SubsPlease] Some Show - 09v2 (1080p)", { propers: "doNotUpgrade" }).score > rank("[SubsPlease] Some Show - 09 (1080p)", { propers: "doNotUpgrade" }).score);
  assert.ok(!rank("[SubsPlease] Some Show - 09v2 (1080p)", { have: { ...have, locked: true } }).flags.some((f) => f.key === "newerVersion"), "locked");
});

// ---------------------------------------------------------------- season batches

test("season batch from the same group: only files it has a newer version of are replaced", () => {
  const input = {
    season: 1,
    consistency: "prefer" as const,
    batchEpisodes: [1, 2, 3],
    existing: [
      { episodeId: 1, group: "SubsPlease", resolution: 1080, source: "web" as const, failed: false, version: 1 },
      { episodeId: 2, group: "SubsPlease", resolution: 1080, source: "web" as const, failed: false, version: 2 },
      { episodeId: 3, group: "SubsPlease", resolution: 1080, source: "web" as const, failed: false, version: 1, locked: true },
    ],
    batch: { group: "SubsPlease", resolution: 1080, source: "web" as const, version: 2 },
    profileResolution: 1080,
    recycleBin: true,
    propers: "preferAndUpgrade" as const,
  };
  const d = decideSeason(input);
  assert.deepEqual(d.replaces, [1], "episode 2 is v2 already, episode 3 is locked");
  assert.deepEqual(d.want, [1]);
  assert.match(d.why, /newer version \(v2\)/);
  assert.deepEqual(decideSeason({ ...input, propers: "doNotUpgrade" }).replaces, []);
  assert.deepEqual(decideSeason({ ...input, propers: undefined }).replaces, []);
  assert.deepEqual(decideSeason({ ...input, recycleBin: false }).replaces, [], "no recycling bin: nothing is replaced");
});

// ---------------------------------------------------------------- library: which version do we have

before(() => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, year, path, monitored, original_language, synced_at) VALUES (60, 800001, 'Prop Show', 2026, '/media/AnimeArr/Prop Show', 0, 'Japanese', 0)").run();
  // [episode id, season, episode, path, scene name]
  const rows: [number, number, number, string, string | null][] = [
    [6001, 1, 1, "/media/AnimeArr/Prop Show/Season 01/Prop Show - S01E01.mkv", "[Grp] Prop Show - 01 (BD 1080p) [AAAA1111]"],
    [6002, 1, 2, "/media/AnimeArr/Prop Show/Season 01/Prop Show - S01E02.mkv", "[Grp] Prop Show - 02v2 (BD 1080p) [AAAA2222]"],
    [6003, 1, 3, "/media/AnimeArr/Prop Show/Season 01/Prop Show - S01E03 [Remaster].mkv", "[Grp] Prop Show - 03 (BD 1080p)"],
    [6004, 1, 4, "/media/AnimeArr/Prop Show/Season 01/Prop Show - S01E04 [BD 1080p].mkv", null],
  ];
  for (const [id, season, ep, p, scene] of rows) {
    cache.prepare("INSERT INTO files (id, series_id, season, path, scene_name, resolution, audio_langs, sub_langs) VALUES (?, 60, ?, ?, ?, '1920x1080', 'jpn', 'eng')").run(id + 50000, season, p, scene);
    cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, file_id, air_utc, runtime) VALUES (?, 60, ?, ?, 1, 1, ?, ?, 24)").run(id, season, ep, id + 50000, now - 3 * DAY);
  }
  // Episode 4 was imported by AnimeArr itself: no scene name, but the finished grab remembers the release.
  db.prepare("INSERT INTO grabs (id, at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, state, dry_run) VALUES (990, 0, 0, 800001, 60, '[6004]', '[Grp] Prop Show - 04v2 (BD 1080p) [DDDD4444]', 'g-990', 'usenet', 'done', 0)").run();
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (800001, 60, 'Prop Show', 0, 0)").run();
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/AnimeArr"], managed: { ...s.managed, dryRun: false }, media: { ...s.media, recycleBin: "/media/bin" }, qualityUpgrade: { mode: "auto", paused: false, seasonsPerDay: 5, perHour: 10, recheckDays: 21 } }));
});

test("the file we have: group and version from the scene name, the grab history, Sonarr's revision or the file name", () => {
  const h = haveRevisions(800001, [6001, 6002, 6003, 6004]);
  assert.deepEqual(h.get(6001), { group: "Grp", version: 1, locked: false });
  assert.equal(h.get(6002)?.version, 2);
  assert.equal(h.get(6003)?.locked, true, "[Remaster] in the file name");
  assert.equal(h.get(6004)?.version, 2, "from the release AnimeArr grabbed");
  const f = { path: "/x/Some Show - S01E01.mkv", scene_name: "[Grp] Some Show - 01 (1080p)", release_group: "Grp", revision: JSON.stringify({ version: 2, real: 0, isRepack: true }) };
  assert.equal(fileRevision(1, f).version, 2, "Sonarr's quality revision counts");
  assert.equal(fileRevision(1, { ...f, scene_name: null, revision: null, path: "/x/[Grp] Some Show - 01v3 (1080p).mkv" }).version, 3, "file name as the last resort");
});

test("locks: a locked season or show reads as locked", () => {
  setLock(800001, 1, true);
  assert.equal(haveRevisions(800001, [6001]).get(6001)?.locked, true);
  setLock(800001, 1, false);
  assert.equal(haveRevisions(800001, [6001]).get(6001)?.locked, false);
});

test("newerVersionOf follows the setting", () => {
  assert.equal(newerVersionOf(800001, [6001], "[Grp] Prop Show - 01v2 (BD 1080p)", "preferAndUpgrade").ok, true);
  assert.equal(newerVersionOf(800001, [6001], "[Grp] Prop Show - 01v2 (BD 1080p)", "doNotUpgrade").ok, false);
  assert.equal(newerVersionOf(800001, [6001], "[Other] Prop Show - 01v2 (BD 1080p)", "preferAndUpgrade").ok, false);
  assert.equal(newerVersionOf(800001, [6002], "[Grp] Prop Show - 02v2 (BD 1080p)", "preferAndUpgrade").ok, false, "same version");
  assert.equal(newerVersionOf(800001, [6003], "[Grp] Prop Show - 03v2 (BD 1080p)", "preferAndUpgrade").ok, false, "[Remaster]");
});

// ---------------------------------------------------------------- the watcher

const result = (title: string, episodeIds: number[]): SR =>
  ({
    guid: `g-${title}`, title, indexer: "X", indexerId: 1, protocol: "usenet", size: 1.4e9, seeders: null, publishDate: null, ageHours: 1, episodeIds, label: "S01", confidence: 95, coversTarget: true, extra: 0,
    rank: { accept: true, score: 100, langProb: 0.95, lang: "en", langSource: "x", flags: [], why: "", reject: null },
    mappingWhy: [], group: null, downloadUrl: "http://x",
  }) as SR;

function deps(results: SR[]) {
  const calls = { searched: 0, grabbed: [] as { title: string; purpose?: string | null; episodeIds: number[] }[] };
  let gid = 995;
  const d: Deps = {
    search: (async () => (calls.searched++, { results })) as never,
    grab: (async (req: { candidate: { title: string }; episodeIds: number[]; purpose?: string | null }) => {
      calls.grabbed.push({ title: req.candidate.title, purpose: req.purpose, episodeIds: req.episodeIds });
      const id = ++gid;
      db.prepare("INSERT INTO grabs (id, at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, state, dry_run, purpose) VALUES (?, 0, 0, 800001, 60, ?, ?, ?, 'usenet', 'downloading', 0, 'replace')").run(id, JSON.stringify(req.episodeIds), req.candidate.title, `g-${id}`);
      return { id, dryRun: false, message: "Sent to sabnzbd" };
    }) as never,
  };
  return { d, calls };
}
const resetState = () => db.prepare("DELETE FROM quality_upgrade").run();

test("units: recent files at their goal are checked for a newer version, only under preferAndUpgrade", () => {
  assert.equal(upgradeUnits(now).length, 0, "all files meet the goal: nothing below it");
  const u = upgradeUnits(now, { propers: true }).find((x) => x.tvdbId === 800001);
  assert.ok(u?.properOnly);
  assert.deepEqual(u.files.map((f) => f.episodeId).sort(), [6001, 6002, 6004], "the [Remaster] file is skipped");
  patchSettings((s) => ({ ...s, media: { ...s.media, propers: "doNotUpgrade" } }));
  assert.equal(upgradeUnits(now, { propers: true }).length, 0);
  patchSettings((s) => ({ ...s, media: { ...s.media, propers: "preferAndUpgrade" } }));
  // Old episodes aren't chased.
  cache.prepare("UPDATE episodes SET air_utc = ?").run(now - 60 * DAY);
  assert.equal(upgradeUnits(now, { propers: true }).length, 0);
  cache.prepare("UPDATE episodes SET air_utc = ?").run(now - 3 * DAY);
});

test("pickUpgrade: a same-group v2 of a recent file qualifies; another group, the same version or a lower quality do not", () => {
  const unit = upgradeUnits(now, { propers: true }).find((x) => x.tvdbId === 800001)!;
  const ctx = { seadex: null, mode: "sub" as const, minConfidence: 80, propers: "preferAndUpgrade" as const };
  const v2 = result("[Grp] Prop Show - 01v2 (BD 1080p) [EEEE5555]", [6001]);
  assert.equal(pickUpgrade([v2], unit, ctx)?.result.title, v2.title);
  assert.match(pickUpgrade([v2], unit, ctx)!.why, /v2 of the episode you have from Grp/);
  assert.equal(pickUpgrade([result("[Other] Prop Show - 01v2 (BD 1080p)", [6001])], unit, ctx), null);
  assert.equal(pickUpgrade([result("[Grp] Prop Show - 02v2 (BD 1080p)", [6002])], unit, ctx), null, "episode 2 is v2 already");
  assert.equal(pickUpgrade([result("[Grp] Prop Show - 01v2 (WEB 720p)", [6001])], unit, ctx), null);
  assert.equal(pickUpgrade([v2], unit, { ...ctx, propers: "doNotUpgrade" }), null);
  assert.equal(pickUpgrade([v2], unit, { ...ctx, propers: "doNotPrefer" }), null);
  // The same group's v1 is just what we have; a Blu-ray from elsewhere is not a reason to swap a file at its goal.
  assert.equal(pickUpgrade([result("[Grp] Prop Show - 01 (BD 1080p)", [6001]), result("[Other] Prop Show - 01 (BD 1080p)", [6001])], unit, ctx), null);
});

test("the watcher grabs a v2 as a Replace grab; a locked season or doNotUpgrade grabs nothing", async () => {
  startNow();
  const v2 = result("[Grp] Prop Show - 01v2 (BD 1080p) [EEEE5555]", [6001]);
  patchSettings((s) => ({ ...s, media: { ...s.media, propers: "doNotUpgrade" } }));
  resetState();
  const off = deps([v2]);
  assert.equal((await qualityUpgradePass(off.d, now + 1000)).grabbed, 0);
  patchSettings((s) => ({ ...s, media: { ...s.media, propers: "preferAndUpgrade" } }));
  resetState();
  setLock(800001, 1, true);
  const locked = deps([v2]);
  assert.equal((await qualityUpgradePass(locked.d, now + 2000)).grabbed, 0);
  assert.equal(locked.calls.searched, 0, "a locked season isn't even searched");
  setLock(800001, 1, false);
  resetState();
  const on = deps([v2]);
  assert.equal((await qualityUpgradePass(on.d, now + 3000)).grabbed, 1);
  assert.equal(on.calls.grabbed[0].purpose, "replace");
  assert.deepEqual(on.calls.grabbed[0].episodeIds, [6001]);
  const why = (db.prepare("SELECT why FROM decisions WHERE why LIKE 'Quality upgrade for Prop Show S01%' ORDER BY id DESC LIMIT 1").get() as { why: string }).why;
  assert.match(why, /v2 of the episode you have from Grp \(fixes a v1\) — upgrade/);
});
