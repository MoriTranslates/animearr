/** Native movies and AnimeArr's own movie importer, on throwaway folders only. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings, getSettings } = await import("../server/settings.js");
const { addMovie, NATIVE_BASE, removeMovie } = await import("../server/native.js");
const { planMovieImport, executeMovieImport, fileLink } = await import("../server/importer.js");
type AniMedia = import("../server/anilist.js").AniMedia;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-mov-"));
const LIB = path.join(tmp, "movies");
const DL = path.join(tmp, "dl");
const BIN = path.join(tmp, "recycle");
const write = (p: string, s = "x") => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s));
const probe = async () => ({ duration: 6000, container: "matroska", video: { codec: "hevc", width: 1920, height: 1080, hdr: false, bitDepth: 10 }, audio: [{ lang: "ja", title: null, codec: "flac", channels: 2, default: true, forced: false }], subs: [] }) as never;
const media = (id: number): AniMedia => ({
  id, idMal: null, title: { romaji: "Suzume no Tojimari", english: "Suzume", native: "すずめの戸締まり" }, synonyms: [], format: "MOVIE", status: "FINISHED", episodes: 1, duration: 122, season: null, seasonYear: 2022,
  startDate: { year: 2022, month: 11, day: 11 }, endDate: { year: 2022, month: 11, day: 11 }, countryOfOrigin: "JP", coverImage: { large: null, color: null }, bannerImage: null, description: "", genres: [], isAdult: false,
  relations: { edges: [] }, airingSchedule: { nodes: [] }, nextAiringEpisode: null, streamingEpisodes: [],
});
const fribb = async () => ({ mtime: 0, anidbToAnilist: new Map<number, number>(), anilistToAnidb: new Map<number, number>(), anilistToAnidbAll: new Map<number, number[]>(), anilistToTmdb: new Map([[142770, 916224]]) });

before(() => {
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/Movies/Anime"],
    localPathMappings: [{ from: "/media/Movies/Anime", to: LIB }, { from: "/data", to: DL }, { from: "/media/Recycle", to: BIN }],
    media: { ...s.media, movieFormat: "{Movie CleanTitle} ({Release Year}) [{Quality Full}]{-Release Group}", movieFolderFormat: "{Movie CleanTitle} ({Release Year})" },
  }));
});

test("add a movie natively: folder from the movie folder format, TMDB id kept, no Radarr", async () => {
  const r = await addMovie({ anilistId: 142770, rootFolder: "/media/Movies/Anime" }, { media: async (ids) => ids.map(media), fribb });
  assert.equal(r.path, "/media/Movies/Anime/Suzume (2022)");
  const m = cache.prepare("SELECT id, tmdb_id, is_anime, has_file, is_available FROM movies WHERE id = ?").get(r.movieId) as { id: number; tmdb_id: number; is_anime: number; has_file: number; is_available: number };
  assert.equal(m.tmdb_id, 916224);
  assert.equal(m.is_anime, 1);
  assert.equal(m.is_available, 1);
  await assert.rejects(addMovie({ anilistId: 142770, rootFolder: "/media/Movies/Anime" }, { media: async (ids) => ids.map(media), fribb }), /already in your library/);
});

test("movie import: plan (biggest file, named), gated, then placed; the movie gets its file", async () => {
  const id = NATIVE_BASE + 1;
  write(path.join(DL, "Suzume.2022.1080p.BluRay.x265-GRP", "Suzume.2022.1080p.BluRay.x265-GRP.mkv"), "movie");
  write(path.join(DL, "Suzume.2022.1080p.BluRay.x265-GRP", "extras.mkv"), "e");
  const plan = await planMovieImport({ movieId: id, path: "/data/Suzume.2022.1080p.BluRay.x265-GRP", release: "Suzume.2022.1080p.BluRay.x265-GRP", client: "sabnzbd" }, { probe, minBytes: 0 });
  assert.equal(plan.items[0].problem, null);
  assert.equal(plan.items[0].destArr, "/media/Movies/Anime/Suzume (2022)/Suzume (2022) [Bluray-1080p]-GRP.mkv");
  await assert.rejects(executeMovieImport(plan), /aren't switched on/);
  patchSettings((s) => ({ ...s, importer: { ...s.importer, allowReal: true, realBudget: 1, movies: true } }));
  const res = await executeMovieImport(plan);
  assert.equal(res[0].done, true, res[0].why);
  assert.ok(fs.existsSync(path.join(LIB, "Suzume (2022)", "Suzume (2022) [Bluray-1080p]-GRP.mkv")));
  assert.equal(getSettings().importer.realBudget, 0);
  assert.equal((cache.prepare("SELECT has_file FROM movies WHERE id = ?").get(id) as { has_file: number }).has_file, 1, "the movie has its file at once");
  assert.equal(fileLink("/media/Movies/Anime/Suzume (2022)/Suzume (2022) [Bluray-1080p]-GRP.mkv"), null, "movies have no episode links");
  patchSettings((s) => ({ ...s, importer: { ...s.importer, allowReal: false } }));
});

test("two big files: import by hand; removing the movie keeps its files", async () => {
  write(path.join(DL, "two", "a.mkv"), "aaaaaaaaaa");
  write(path.join(DL, "two", "b.mkv"), "bbbbbbbbb");
  const plan = await planMovieImport({ movieId: NATIVE_BASE + 1, path: "/data/two" }, { probe, minBytes: 0 });
  assert.match(plan.items[0].problem ?? "", /several large/);
  removeMovie(NATIVE_BASE + 1);
  assert.equal(cache.prepare("SELECT COUNT(*) AS n FROM movies").get()!.n, 0);
  assert.ok(fs.existsSync(path.join(LIB, "Suzume (2022)")));
  void db;
});
