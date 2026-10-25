/** Movies (Radarr side): matching, search ranking, grab + import through Radarr with mocks. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-movies-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { parseRelease } = await import("../server/core/parser.js");
const { matchMovie, movieQueries, searchMovie, startMovieGrab, listMovies } = await import("../server/movies.js");
const { pipelineTick } = await import("../server/pipeline.js");
type Deps = import("../server/pipeline.js").PipelineDeps;

const SUZUME = { title: "Suzume", original_title: "すずめの戸締まり", alt_titles: ["Suzume no Tojimari"], year: 2022 };

before(() => {
  const ins = cache.prepare("INSERT INTO movies (id, tmdb_id, imdb_id, title, original_title, year, path, root_folder, monitored, has_file, runtime, quality_profile_id, tags, alt_titles, file, is_anime, poster, synced_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 1, 0, 122, 1, '[]', ?, NULL, 1, NULL, 0)");
  ins.run(1, 916224, "Suzume", "すずめの戸締まり", 2022, "/media/Movies/Anime/Suzume (2022)", "/media/Movies/Anime", JSON.stringify(["Suzume no Tojimari"]));
  ins.run(2, 1, "Outside Movie", null, 2020, "/media/Movies/Other/Outside Movie (2020)", "/media/Movies/Other", "[]");
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Movies/Anime"], managed: { ...s.managed, dryRun: false } }));
});

test("matching: title (any alias) and year; series releases and other years are rejected", () => {
  const ok = (n: string) => matchMovie(parseRelease(n), SUZUME).confidence;
  assert.ok(ok("[Judas] Suzume no Tojimari (2022) [BD 1080p HEVC][Dual Audio]") >= 90);
  assert.ok(ok("Suzume.2022.1080p.BluRay.x264-GROUP") >= 90);
  assert.equal(ok("[SubsPlease] Suzume - 03 (1080p)"), 0, "an episode");
  assert.equal(ok("Suzume 2012 1080p WEB"), 0, "other year");
  assert.equal(ok("[Group] Weathering With You (2019) [1080p]"), 0, "other title");
});

test("matching: sequels, packs and the TV series aren't taken for the movie", () => {
  const hf = { title: "Fate/stay night: Heaven's Feel II. lost butterfly", original_title: null, alt_titles: [], year: 2019 };
  assert.equal(matchMovie(parseRelease("[Grp] Fate stay night Heaven's Feel III spring song (2020) [BD 1080p]"), hf).confidence, 0, "III is another movie");
  const kizu = { title: "Kizumonogatari", original_title: null, alt_titles: [], year: 2016 };
  assert.equal(matchMovie(parseRelease("[Grp] Kizumonogatari Movie 2 [BD 1080p]"), kizu).confidence, 0);
  assert.equal(matchMovie(parseRelease("[Grp] Kizumonogatari Movies 1-3 [BD 1080p] Batch"), kizu).confidence, 0, "a pack");
  const yc = { title: "Laid-Back Camp The Movie", original_title: null, alt_titles: ["Yuru Camp Movie"], year: 2022 };
  assert.ok(matchMovie(parseRelease("[Grp] Yuru Camp [BD 1080p]"), yc).confidence < 80, "could be the TV series");
  assert.ok(matchMovie(parseRelease("[Grp] Yuru Camp Movie (2022) [BD 1080p]"), yc).confidence >= 90);
  const poke = { title: "Pokémon: The Movie 2000", original_title: null, alt_titles: [], year: 1999 };
  assert.ok(matchMovie(parseRelease("Pokemon.The.Movie.2000.1999.1080p.BluRay.x264-GRP"), poke).confidence >= 80);
});

test("queries: Latin titles, title + year, one native title", () => {
  assert.deepEqual(movieQueries(SUZUME), ["Suzume", "Suzume no Tojimari", "Suzume 2022", "すずめの戸締まり"]);
});

const rel = (title: string, extra: Partial<{ protocol: "usenet" | "torrent"; size: number; seeders: number }> = {}) => ({ guid: `g-${title}`, title, indexer: "X", indexerId: 1, protocol: extra.protocol ?? "torrent", size: extra.size ?? 6e9, seeders: extra.seeders ?? 50, downloadUrl: "http://x/dl", publishDate: new Date().toISOString() });

test("search ranks matching releases by the profile (English subs over raws), skipping others", async () => {
  const r = await searchMovie(1, async () => [rel("[Judas] Suzume no Tojimari (2022) [BD 1080p][Multi-Subs]"), rel("[Ohys-Raws] Suzume no Tojimari (2022) (BD 1280x720)"), rel("[SubsPlease] Suzume - 03 (1080p)")] as never);
  assert.equal(r.matched, 2);
  assert.match(r.results[0].title, /Judas/);
  assert.equal(Object.values(r.skipped).reduce((a, b) => a + b, 0), 1);
});

function deps(over: Partial<Deps> = {}) {
  const imports: unknown[] = [];
  let imported = false;
  const d: Deps = {
    clients: { addNzb: async () => ({ client: "sabnzbd", ref: "nzo1" }), addTorrent: async () => ({ client: "qbittorrent", ref: "hash1" }), remove: async () => undefined, status: async () => ({ state: "completed", progress: 1, path: "/data/torrents/animearr/Suzume (2022)" }) },
    fetchRelease: async (r) => ({ data: Buffer.from("x"), filename: r.title }),
    sonarr: {} as never,
    radarr: {
      preview: async (folder) => [{ path: `${folder}/Suzume (2022).mkv`, size: 6e9, quality: {}, languages: [] }, { path: `${folder}/Extras/NCOP.mkv`, size: 2e8, quality: {}, languages: [] }],
      importFiles: async (files, mode) => (imports.push(files), (imported = true), assert.equal(mode, "copy", "torrents are copied (keep seeding)"), { id: 9 }),
      command: async () => ({ id: 9, status: "completed" }),
      movie: async (id) => ({ id, tmdbId: 1, title: "Suzume", year: 2022, path: "/media/Movies/Anime/Suzume (2022)", monitored: true, hasFile: imported, qualityProfileId: 1, tags: [], movieFile: { path: "/media/Movies/Anime/Suzume (2022)/Suzume (2022).mkv", dateAdded: new Date().toISOString(), mediaInfo: { subtitles: "eng", audioLanguages: "jpn" } } }),
    },
    probe: async () => {
      throw new Error("unreachable");
    },
    localPath: () => null,
    sleep: async () => undefined,
    ...over,
  };
  return { d, imports };
}
const cand = (title: string) => ({ guid: `g-${title}`, title, indexerId: 1, indexer: "X", protocol: "torrent" as const, size: 6e9, downloadUrl: "http://x/dl", label: "Suzume (2022)", group: null, why: "test", episodeIds: [] });

test("grab + import: only allowed roots; the main file is imported with the movie id; verified from Radarr's track info", async () => {
  await assert.rejects(startMovieGrab({ movieId: 2, candidate: cand("Outside Movie 2020"), fallbacks: [], origin: "manual" }, deps().d), /not an allowed root folder/);
  const { d, imports } = deps();
  const g = await startMovieGrab({ movieId: 1, candidate: cand("[Judas] Suzume no Tojimari (2022)"), fallbacks: [], origin: "manual" }, d);
  assert.equal(listMovies().find((m) => m.id === 1)!.status, "downloading");
  await assert.rejects(startMovieGrab({ movieId: 1, candidate: cand("another"), fallbacks: [], origin: "manual" }, d), /already a download/);
  await pipelineTick(d);
  const row = db.prepare("SELECT state, error FROM grabs WHERE id = ?").get(g.id) as { state: string; error: string | null };
  assert.equal(row.state, "done", row.error ?? "");
  assert.deepEqual((imports[0] as { path: string; movieId: number }[]).map((f) => [path.posix.basename(f.path), f.movieId]), [["Suzume (2022).mkv", 1]]);
  assert.equal(listMovies().find((m) => m.id === 1)!.status, "have");
});

test("a movie file without English subtitles fails verification: blocklisted, next candidate tried", async () => {
  cache.prepare("UPDATE movies SET has_file = 0 WHERE id = 1").run();
  const fetched: string[] = [];
  const { d } = deps({ fetchRelease: async (r) => (fetched.push(r.title), { data: Buffer.from("x"), filename: r.title }) });
  let imported = false;
  const importFiles = d.radarr!.importFiles;
  d.radarr!.importFiles = async (f, mode) => ((imported = true), importFiles(f, mode));
  d.radarr!.movie = async (id) => ({ id, tmdbId: 1, title: "Suzume", year: 2022, path: "/media/Movies/Anime/Suzume (2022)", monitored: true, hasFile: imported, qualityProfileId: 1, tags: [], movieFile: { path: "/m/raw.mkv", dateAdded: new Date().toISOString(), mediaInfo: { subtitles: "", audioLanguages: "jpn" } } });
  const g = await startMovieGrab({ movieId: 1, candidate: cand("[Ohys-Raws] Suzume (2022)"), fallbacks: [cand("[Judas] Suzume (2022) v2")], origin: "manual" }, d);
  await pipelineTick(d);
  assert.equal((db.prepare("SELECT state FROM grabs WHERE id = ?").get(g.id) as { state: string }).state, "failed");
  const b = db.prepare("SELECT movie_id FROM blocklist WHERE release = '[Ohys-Raws] Suzume (2022)'").get() as { movie_id: number };
  assert.equal(b.movie_id, 1);
  assert.deepEqual(fetched, ["[Ohys-Raws] Suzume (2022)", "[Judas] Suzume (2022) v2"]);
});

test("a movie that has a file is only grabbed when replacing was confirmed", async () => {
  cache.prepare("UPDATE movies SET has_file = 1 WHERE id = 1").run();
  db.prepare("UPDATE grabs SET state = 'failed' WHERE movie_id = 1 AND state NOT IN ('done', 'failed')").run();
  await assert.rejects(startMovieGrab({ movieId: 1, candidate: cand("[X] Suzume (2022) new"), fallbacks: [], origin: "manual" }, deps().d), /already has a file/);
  const g = await startMovieGrab({ movieId: 1, candidate: cand("[X] Suzume (2022) new"), fallbacks: [], origin: "manual", replace: true }, deps().d);
  assert.equal((db.prepare("SELECT replace_file FROM grabs WHERE id = ?").get(g.id) as { replace_file: number }).replace_file, 1);
});
