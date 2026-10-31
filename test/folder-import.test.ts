/** Import an existing folder without Sonarr: folder-name parsing, matching, skip rules, adopting as-is, never touching files. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { addShow, checkExistingPath, NATIVE_BASE } = await import("../server/native.js");
const { adoptFolder, matchFolder, parseFolderName, scanRoot, scoreTitle } = await import("../server/folderImport.js");
const { scanFolder } = await import("../server/mediafiles.js");
type AniMedia = import("../server/anilist.js").AniMedia;
type AddResult = import("../server/native.js").AddResult;

const ROOT = "/media/Anime";
const LIB = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-import-"));
before(() => {
  patchSettings((s) => ({ ...s, allowedRoots: [ROOT], localPathMappings: [{ from: ROOT, to: LIB }] }));
});

const fribb = async () => ({ mtime: 0, anidbToAnilist: new Map<number, number>([[777, 9001]]), anilistToAnidb: new Map<number, number>(), anilistToAnidbAll: new Map<number, number[]>(), anilistToTmdb: new Map<number, number>() });
const res = (id: number, title: string, over: Partial<AddResult> = {}): AddResult => ({
  anilistId: id, title, romaji: null, native: null, kind: "TV", year: 2016, episodes: 12, status: "FINISHED", cover: null, country: "JP", tvdbId: null, tmdbMovie: null, inLibrary: null, matchedBy: "AniList", trailer: null, ...over,
});
const searchOf = (results: AddResult[]) => ({ search: async () => ({ results, anilist: "ok" }), fribb, media: async () => [] as AniMedia[] });

// ---------------------------------------------------------------- folder names

test("folder names: ID hints in every style, year, tags", () => {
  assert.deepEqual(parseFolderName("Frieren (2023) {tvdb-424536}").hints, { tvdb: 424536 });
  assert.deepEqual(parseFolderName("Frieren [tvdbid-424536]").hints, { tvdb: 424536 });
  assert.deepEqual(parseFolderName("Gate {anidb-12665}").hints, { anidb: 12665 });
  assert.deepEqual(parseFolderName("Gate [anidbid-12665]").hints, { anidb: 12665 });
  assert.deepEqual(parseFolderName("Gate {tmdb-4242}").hints, { tmdb: 4242 });
  const p = parseFolderName("Frieren - Beyond Journey's End (2023) {tvdb-424536}");
  assert.equal(p.title, "Frieren - Beyond Journey's End");
  assert.equal(p.year, 2023);
  assert.equal(parseFolderName("[SubsPlease] Sword.Art.Online [1080p]").title, "Sword Art Online");
  assert.equal(parseFolderName("Konosuba (BD 1080p) (2016)").title, "Konosuba");
  assert.equal(parseFolderName("86 (2021)").title, "86");
  assert.equal(parseFolderName("Plain Show").year, null);
});

// ---------------------------------------------------------------- matching

test("matching: sequel names, subtitles after a colon, romaji vs English, years", async () => {
  // "2nd Season" folder: the entry carrying the same season marker is the exact fit.
  assert.ok(scoreTitle("Konosuba God's blessing on this wonderful world 2nd Season", { title: "KONOSUBA -God's blessing on this wonderful world! 2nd Season", romaji: null, native: null }).score >= 0.95);
  assert.ok(scoreTitle("Konosuba Season 2", { title: "Konosuba", romaji: null, native: null }).score >= 0.8);
  // Romaji folder vs English-titled entry.
  const rz = await matchFolder("Re Zero kara Hajimeru Isekai Seikatsu (2016)", searchOf([res(10, "Re:ZERO -Starting Life in Another World-", { romaji: "Re:Zero kara Hajimeru Isekai Seikatsu" }), res(11, "Re:Creators")]));
  assert.equal(rz.best?.anilistId, 10);
  assert.equal(rz.confidence, "confident");
  assert.match(rz.reason, /matches/);
  // Subtitle after a colon on the folder only: the main title still finds it, but not "confident".
  const fz = await matchFolder("Fate Zero: Remix Edition", searchOf([res(20, "Fate/Zero", { year: 2011 })]));
  assert.equal(fz.best?.anilistId, 20);
  assert.notEqual(fz.confidence, "confident");
  // Year breaks a tie between two shows with the same title.
  const yr = await matchFolder("Gundam Build (2013)", searchOf([res(30, "Gundam Build", { year: 2019 }), res(31, "Gundam Build", { year: 2013 })]));
  assert.equal(yr.best?.anilistId, 31);
  // Movies are never offered (series only).
  const mv = await matchFolder("Kimi no Na wa", searchOf([res(40, "Kimi no Na wa", { kind: "MOVIE" })]));
  assert.equal(mv.best, null);
  assert.equal(mv.confidence, "none");
  // Two different shows equally close: ambiguous, so not confident.
  const amb = await matchFolder("Gate", searchOf([res(50, "Gate", { tvdbId: 1 }), res(51, "Gate", { tvdbId: 2 })]));
  assert.notEqual(amb.confidence, "confident");
});

test("matching: an ID in the folder name wins over the title", async () => {
  db.prepare("INSERT OR REPLACE INTO entries (anilist_id, title_english, title_romaji, synonyms, kind, season_year, episodes, tvdb_id, tvdb_season, tvdb_offset, fetched_at) VALUES (9001, 'Hinted Show', NULL, '[]', 'TV', 2020, 12, 55555, '1', 0, 0)").run();
  const byTvdb = await matchFolder("Totally Different Title {tvdb-55555}", { ...searchOf([res(1, "Totally Different Title")]), search: async () => assert.fail("title search shouldn't run") });
  assert.equal(byTvdb.best?.anilistId, 9001);
  assert.equal(byTvdb.confidence, "confident");
  assert.match(byTvdb.reason, /TVDB 55555/);
  const byAnidb = await matchFolder("Whatever [anidbid-777]", { ...searchOf([]), search: async () => assert.fail("title search shouldn't run") });
  assert.equal(byAnidb.best?.anilistId, 9001);
  // An ID nobody knows falls back to the title, and says so.
  const unknown = await matchFolder("Gate {tvdb-1}", searchOf([res(60, "Gate")]));
  assert.equal(unknown.best?.anilistId, 60);
  assert.match(unknown.reason, /isn't a show AnimeArr knows/);
});

// ---------------------------------------------------------------- scanning + adopting

const media = (id: number, over: Partial<AniMedia> = {}): AniMedia => ({
  id, idMal: null, title: { romaji: "Imported Show", english: "Imported Show", native: null }, synonyms: [], format: "TV", status: "FINISHED", episodes: 3, duration: 24,
  season: null, seasonYear: 2019, startDate: { year: 2019, month: 1, day: 1 }, endDate: { year: 2019, month: 3, day: 1 }, countryOfOrigin: "JP", coverImage: { large: null, color: null }, bannerImage: null,
  description: "", genres: [], isAdult: false, relations: { edges: [] }, airingSchedule: { nodes: [{ episode: 1, airingAt: 1546300800 }, { episode: 2, airingAt: 1546900000 }, { episode: 3, airingAt: 1547500000 }] },
  nextAiringEpisode: null, streamingEpisodes: [], ...over,
});
const emptyFribb = async () => ({ mtime: 0, anidbToAnilist: new Map<number, number>(), anilistToAnidb: new Map<number, number>(), anilistToAnidbAll: new Map<number, number[]>(), anilistToTmdb: new Map<number, number>() });
const probe = async () => ({ duration: 1, container: "matroska", video: null, audio: [], subs: [] });
const touch = (rel: string, body = "x") => {
  fs.mkdirSync(path.dirname(path.join(LIB, rel)), { recursive: true });
  fs.writeFileSync(path.join(LIB, rel), body);
};
const tree = (dir = LIB): string[] => fs.readdirSync(dir, { withFileTypes: true, recursive: true }).map((e) => `${path.relative(dir, path.join(e.parentPath, e.name))}:${e.isFile() ? fs.statSync(path.join(e.parentPath, e.name)).size : "d"}`).sort();

test("scan: lists show folders, skips hidden, system and owned ones; refuses roots that aren't allowed", () => {
  touch("Imported Show (2019)/Imported Show - S01E01.mkv");
  touch("Owned Show/ep.mkv");
  touch(".hidden/ep.mkv");
  touch("@eaDir/x.mkv");
  touch("loose.mkv");
  fs.mkdirSync(path.join(LIB, "Empty Folder"));
  cache.prepare("INSERT INTO series (id, tvdb_id, title, sort_title, year, status, series_type, path, root_folder, monitored, tags, seasons, added, synced_at) VALUES (1, 1, 'Owned Show', 'owned show', 2000, 'ended', 'anime', ?, ?, 1, '[]', '[]', '', 0)").run(`${ROOT}/Owned Show`, ROOT);
  const r = scanRoot(ROOT);
  assert.deepEqual(r.folders.map((f) => f.name), ["Empty Folder", "Imported Show (2019)"]);
  assert.equal(r.folders.find((f) => f.name === "Empty Folder")?.videos, 0);
  assert.equal(r.folders.find((f) => f.name === "Imported Show (2019)")?.videos, 1);
  assert.deepEqual(r.skipped, { owned: 1, hidden: 2 });
  assert.throws(() => scanRoot("/media/Other"), /allowed root/);
  assert.throws(() => scanRoot(`${ROOT}/Owned Show`), /allowed root/);
});

test("adding with an existing path: must be a real folder directly inside an allowed root and not owned", async () => {
  const deps = { media: async (ids: number[]) => ids.map((i) => media(i)), fribb: emptyFribb };
  await assert.rejects(addShow({ anilistId: 501, rootFolder: ROOT, existingPath: "/elsewhere/Imported Show (2019)" }, deps), /directly inside|outside/);
  await assert.rejects(addShow({ anilistId: 501, rootFolder: ROOT, existingPath: `${ROOT}/Sub/Deeper` }, deps), /directly inside/);
  await assert.rejects(addShow({ anilistId: 501, rootFolder: ROOT, existingPath: `${ROOT}/../etc` }, deps), /directly inside|outside/);
  await assert.rejects(addShow({ anilistId: 501, rootFolder: ROOT, existingPath: `${ROOT}/Not There` }, deps), /can't open/);
  await assert.rejects(addShow({ anilistId: 501, rootFolder: ROOT, existingPath: `${ROOT}/Owned Show` }, deps), /already belongs/);
  assert.throws(() => checkExistingPath(`${ROOT}/loose.mkv`, ROOT), /can't open/); // a file isn't a folder
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM native_series").get()?.n, 0);
});

test("adopt: the folder becomes the show's path, files are mapped, the rest is listed; nothing on disk changes", async () => {
  touch("Imported Show (2019)/Imported Show - S01E02.mkv", "two");
  touch("Imported Show (2019)/[Grp] Imported Show - 03 [1080p].mkv", "three");
  touch("Imported Show (2019)/Bonus/mystery clip.mkv", "clip");
  touch("Imported Show (2019)/notes.txt", "keep me");
  const before = tree();
  // Anything that would change the disk is a failure, whoever calls it.
  const forbidden = ["renameSync", "rmSync", "rmdirSync", "unlinkSync", "writeFileSync", "appendFileSync", "mkdirSync", "copyFileSync", "cpSync", "truncateSync", "utimesSync", "chmodSync", "symlinkSync", "linkSync"] as const;
  const real = new Map<string, unknown>();
  const touched: string[] = [];
  for (const k of forbidden) {
    real.set(k, (fs as Record<string, unknown>)[k]);
    (fs as Record<string, unknown>)[k] = (...a: unknown[]) => {
      touched.push(`${k}(${String(a[0])})`);
      throw new Error(`import must not call fs.${k}`);
    };
  }
  let r: Awaited<ReturnType<typeof adoptFolder>>;
  try {
    r = await adoptFolder({ rootFolder: ROOT, name: "Imported Show (2019)", anilistId: 501 }, { add: (i) => addShow(i, { media: async (ids) => ids.map((x) => media(x)), fribb: emptyFribb }), scan: (p) => scanFolder(p, probe) });
  } finally {
    for (const [k, v] of real) (fs as Record<string, unknown>)[k] = v;
  }
  assert.deepEqual(touched, []);
  assert.deepEqual(tree(), before);
  assert.equal(r.tvdbId, NATIVE_BASE + 501);
  assert.equal(r.path, `${ROOT}/Imported Show (2019)`);
  assert.equal(r.episodes, 3);
  assert.equal(r.mapped, 3);
  assert.deepEqual(r.unmapped.map((u) => path.posix.basename(u.path)), ["mystery clip.mkv"]);
  const s = cache.prepare("SELECT id, path, monitored FROM series WHERE tvdb_id = ?").get(r.tvdbId) as { id: number; path: string; monitored: number };
  assert.equal(s.path, r.path);
  const withFile = cache.prepare("SELECT episode FROM episodes WHERE series_id = ? AND has_file = 1 ORDER BY episode").all(s.id) as { episode: number }[];
  assert.deepEqual(withFile.map((e) => e.episode), [1, 2, 3]);
  // Adding it again (or another show onto the same folder) is refused.
  await assert.rejects(adoptFolder({ rootFolder: ROOT, name: "Imported Show (2019)", anilistId: 501 }, { add: (i) => addShow(i, { media: async (ids) => ids.map((x) => media(x)), fribb: emptyFribb }), scan: (p) => scanFolder(p, probe) }), /already/);
  assert.deepEqual(scanRoot(ROOT).folders.map((f) => f.name), ["Empty Folder"], "the adopted folder no longer shows up as importable");
});

test("adopt refuses odd folder names", async () => {
  for (const name of ["", "..", "a/b", "a\\b"]) await assert.rejects(adoptFolder({ rootFolder: ROOT, name, anilistId: 1 }), /Not a folder name/);
  await assert.rejects(adoptFolder({ rootFolder: "/media/Other", name: "x", anilistId: 1 }), /allowed root/);
});
