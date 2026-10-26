/** Native Add: search (AniList + local catalog, abbreviations), add a show without Sonarr, cache rows, files. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { addShow, searchAdd, NATIVE_BASE, rematerializeSeries } = await import("../server/native.js");
const { renameRoute } = await import("../server/importer.js");
type AniMedia = import("../server/anilist.js").AniMedia;

const media = (id: number, over: Partial<AniMedia> = {}): AniMedia => ({
  id, idMal: null, title: { romaji: "Mo Dao Zu Shi", english: "The Founder of Diabolism", native: "魔道祖师" }, synonyms: ["MDZS"], format: "ONA", status: "FINISHED", episodes: 3, duration: 24,
  season: null, seasonYear: 2018, startDate: { year: 2018, month: 7, day: 9 }, endDate: { year: 2018, month: 10, day: 1 }, countryOfOrigin: "CN", coverImage: { large: null, color: null }, bannerImage: null,
  description: "", genres: [], isAdult: false, relations: { edges: [] }, airingSchedule: { nodes: [{ episode: 1, airingAt: 1531100000 }, { episode: 2, airingAt: 1531700000 }, { episode: 3, airingAt: 1532300000 }] },
  nextAiringEpisode: null, streamingEpisodes: [{ title: "Episode 1 - Wei Ying" }], ...over,
});
const fribb = async () => ({ mtime: 0, anidbToAnilist: new Map<number, number>(), anilistToAnidb: new Map<number, number>(), anilistToAnidbAll: new Map<number, number[]>(), anilistToTmdb: new Map<number, number>() });
const LIB = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-native-"));

before(() => {
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Anime"], localPathMappings: [{ from: "/media/Anime", to: LIB }] }));
});

test("search: AniList results with type badges, plus local abbreviations once known", async () => {
  const r = (await searchAdd("founder of diabolism", { search: async () => [media(101)], fribb, timeoutMs: 1000 })).results;
  assert.equal(r[0].anilistId, 101);
  assert.equal(r[0].kind, "ONA");
  assert.equal(r[0].inLibrary, null);
});

test("add a donghua TVDB doesn't have: season 1 under a synthetic id, episodes from the catalog, no Sonarr", async () => {
  const added = await addShow({ anilistId: 101, rootFolder: "/media/Anime" }, { media: async (ids) => ids.map((i) => media(i)), fribb });
  assert.equal(added.tvdbId, NATIVE_BASE + 101);
  assert.equal(added.synthetic, true);
  assert.equal(added.path, "/media/Anime/The Founder of Diabolism (2018)");
  const s = cache.prepare("SELECT id, title, series_type, original_language FROM series WHERE tvdb_id = ?").get(added.tvdbId) as { id: number; title: string; series_type: string; original_language: string };
  assert.ok(s.id >= NATIVE_BASE);
  assert.equal(s.original_language, "Chinese");
  const eps = cache.prepare("SELECT season, episode, title FROM episodes WHERE series_id = ? ORDER BY episode").all(s.id) as { season: number; episode: number; title: string | null }[];
  assert.deepEqual(eps.map((e) => `${e.season}x${e.episode}`), ["1x1", "1x2", "1x3"]);
  assert.equal(eps[0].title, "Wei Ying");
  const alts = (cache.prepare("SELECT title FROM alt_titles WHERE series_id = ?").all(s.id) as { title: string }[]).map((a) => a.title);
  assert.ok(alts.includes("Mo Dao Zu Shi") && alts.includes("MDZS"));
  assert.equal(renameRoute(added.tvdbId, { sonarrOn: () => true }), "animearr", "a native show is renamed by AnimeArr");
  await assert.rejects(addShow({ anilistId: 101, rootFolder: "/media/Anime" }, { media: async (ids) => ids.map((i) => media(i)), fribb }), /already in your library/);
  // Now it's in the catalog: the abbreviation finds it locally, marked as in the library.
  const r = (await searchAdd("mdzs", { search: async () => [], fribb, timeoutMs: 1000 })).results;
  assert.equal(r[0].anilistId, 101);
  assert.equal(r[0].inLibrary?.native, true);
});

test("files under the show's folder (AnimeArr's own records) become the episodes' files", () => {
  const s = cache.prepare("SELECT id FROM series WHERE tvdb_id = ?").get(NATIVE_BASE + 101) as { id: number };
  db.prepare("INSERT INTO media_files (path, root, size, mtime, seen_at) VALUES (?, '/media/Anime', 5, 1, 1)").run("/media/Anime/The Founder of Diabolism (2018)/Season 1/The Founder of Diabolism (2018) - S01E02 - x.mkv");
  rematerializeSeries(s.id);
  const e2 = cache.prepare("SELECT has_file, file_id FROM episodes WHERE series_id = ? AND episode = 2").get(s.id) as { has_file: number; file_id: number };
  assert.equal(e2.has_file, 1);
  assert.ok(cache.prepare("SELECT 1 FROM files WHERE id = ?").get(e2.file_id));
});

test("movies and roots outside the allowed ones are refused", async () => {
  await assert.rejects(addShow({ anilistId: 202, rootFolder: "/elsewhere" }, { media: async (ids) => ids.map((i) => media(i, { format: "MOVIE" })), fribb }), /root folder/);
  await assert.rejects(addShow({ anilistId: 202, rootFolder: "/media/Anime" }, { media: async (ids) => ids.map((i) => media(i, { format: "MOVIE" })), fribb }), /Movies/);
});

test("removing a native show drops its rows, never files", async () => {
  const { removeShow } = await import("../server/native.js");
  removeShow(NATIVE_BASE + 101);
  assert.equal(cache.prepare("SELECT COUNT(*) AS n FROM series WHERE tvdb_id = ?").get(NATIVE_BASE + 101)!.n, 0);
  assert.throws(() => removeShow(NATIVE_BASE + 101), /wasn't added/);
});

test("a TVDB-mapped show: entries on their seasons, overlaps de-duplicated, absolute in order; Sonarr's copy wins", async () => {
  const { materialize } = await import("../server/native.js");
  const ins = db.prepare("INSERT INTO entries (anilist_id, tvdb_id, tvdb_season, tvdb_offset, kind, title_english, synonyms, status, start_date, episodes, fetched_at) VALUES (?, 555, ?, ?, 'TV', ?, '[]', 'FINISHED', ?, ?, 1)");
  ins.run(301, "1", 0, "Show", "2020-01-01", 24); // AniList keeps both cours as one 24-episode entry
  ins.run(302, "1", 12, "Show Part 2", "2020-07-01", 12); // AniDB's split: S1 13–24 (overlap)
  ins.run(303, "2", 0, "Show 2", "2022-01-01", 12);
  db.prepare("INSERT INTO native_series (tvdb_id, anilist_id, synthetic, title, year, path, root_folder, added_at) VALUES (555, 301, 0, 'Show', 2020, '/media/Anime/Show (2020)', '/media/Anime', 1)").run();
  const row = db.prepare("SELECT * FROM native_series WHERE tvdb_id = 555").get() as never;
  const r = materialize(row);
  assert.equal(r.episodes, 36);
  const sid = (cache.prepare("SELECT id FROM series WHERE tvdb_id = 555").get() as { id: number }).id;
  const s2e1 = cache.prepare("SELECT absolute FROM episodes WHERE series_id = ? AND season = 2 AND episode = 1").get(sid) as { absolute: number };
  assert.equal(s2e1.absolute, 25);
  // Sonarr gets the same series later: the native copy is parked, Sonarr's is the only one.
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (77, 555, 'Show', '/media/Anime/Show', 1, 0)").run();
  assert.equal(materialize(row).parked, true);
  assert.equal((cache.prepare("SELECT COUNT(*) AS n FROM series WHERE tvdb_id = 555").get() as { n: number }).n, 1);
});

test("root folders must be one of the allowed ones exactly", async () => {
  await assert.rejects(addShow({ anilistId: 101, rootFolder: "/media/Anime/../../etc" }, { media: async (ids) => ids.map((i) => media(i)), fribb }), /allowed root folders/);
});

test("search keys: CJK titles match themselves, not everything", async () => {
  const r = (await searchAdd("魔道祖师", { search: async () => [], fribb, timeoutMs: 1000 })).results;
  assert.ok(r.every((x) => x.native === "魔道祖师"));
  assert.ok(r.length >= 1);
});
