/**
 * Detach: AnimeArr takes adopted shows and movies over without any call to Sonarr or Radarr (they keep their records as
 * the user's backup), and "AnimeArr runs without Sonarr/Radarr" sends them no request of any kind.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-detach-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { patchSettings, getSettings } = await import("../server/system/settings.js");
const { adoptShows, detach, resumeCutovers, setWithoutArr, withoutArrBlockers } = await import("../server/library/cutover.js");
const { materializeAll, NATIVE_BASE } = await import("../server/library/native.js");
const { syncLibrary } = await import("../server/library/library.js");

const SONARR = "sonarr.test";
const RADARR = "radarr.test";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-detach-f-"));
const LIB = path.join(tmp, "lib");
const DL = path.join(tmp, "dl");
const BIN = path.join(tmp, "bin");
const write = (p: string, s = "x") => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s));

// ---------------------------------------------------------------- fetch: every request is recorded; Sonarr/Radarr scripted
const realFetch = globalThis.fetch;
let calls: string[] = [];
let arr: "down" | "up" = "down";
const sonarrSeries = (tvdbId: number, id: number, title: string) => ({
  id,
  tvdbId,
  title,
  status: "ended",
  seriesType: "anime",
  path: `/media/Anime/${title}`,
  monitored: true,
  qualityProfileId: 1,
  tags: [],
  seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 2, totalEpisodeCount: 3, episodeCount: 3 } }],
});
const radarrMovie = (id: number, tmdbId: number, title: string, anime: boolean) => ({
  id,
  tmdbId,
  title,
  year: 2019,
  path: `/media/${anime ? "AnimeMovies" : "Movies"}/${title}`,
  rootFolderPath: `/media/${anime ? "AnimeMovies" : "Movies"}`,
  monitored: true,
  hasFile: false,
  qualityProfileId: 1,
  tags: [],
});
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
before(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url.href);
    if (url.hostname !== SONARR && url.hostname !== RADARR) throw new TypeError("fetch failed (no network in tests)");
    if (arr === "down") throw new TypeError("fetch failed (connect ECONNREFUSED)");
    const p = url.pathname.replace(/^\/api\/v3/, "");
    // Sonarr still lists the detached show (it keeps its record), Radarr the detached movie and a non-anime one.
    if (url.hostname === SONARR && p === "/series") return json([sonarrSeries(555, 7, "Show")]);
    if (url.hostname === RADARR && p === "/movie")
      return json([radarrMovie(31, 4242, "Film", true), radarrMovie(32, 5555, "Not Anime", false)]);
    return json([]);
  }) as typeof fetch;
});
after(() => void (globalThis.fetch = realFetch));
const plain = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;
const arrCalls = () => calls.filter((u) => u.includes(SONARR) || u.includes(RADARR));

before(() => {
  patchSettings((s) => ({
    ...s,
    sonarr: { ...s.sonarr, url: `http://${SONARR}:8989`, apiKey: "test-sonarr-key" },
    radarr: { ...s.radarr, url: `http://${RADARR}:7878`, apiKey: "test-radarr-key", animeRoots: ["/media/AnimeMovies"] },
    allowedRoots: ["/media/Anime"],
    localPathMappings: [
      { from: "/media/Anime", to: LIB },
      { from: "/data", to: DL },
      { from: "/media/Recycle", to: BIN },
    ],
    importer: { ...s.importer, engine: "animearr", allowReal: true, movies: true, allowRename: true, realBudget: -1 },
    media: {
      ...s.media,
      renameEpisodes: true,
      recycleBin: "/media/Recycle/animearr",
      skipFreeSpaceCheck: true,
      episodeTitleRequired: "never",
      animeEpisodeFormat: "{Series Title} - S{season:00}E{episode:00} [{Quality Full}]",
    },
  }));
  // Sonarr show 555 (Sonarr id 7): 3 episodes, 2 with files; AnimeArr's catalog knows it and has scanned both files.
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, year, path, root_folder, monitored, series_type, synced_at, seasons) VALUES (7, 555, 'Show', 2020, '/media/Anime/Show', '/media/Anime', 1, 'anime', 0, '[]')",
    )
    .run();
  for (let e = 1; e <= 3; e++)
    cache
      .prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, file_id) VALUES (?, 7, 1, ?, 1, ?, ?)")
      .run(700 + e, e, e < 3 ? 1 : 0, e < 3 ? 70 + e : null);
  for (const [id, name, scene] of [
    [71, "Show - S01E01.mkv", "Show.S01E01.1080p.WEB-GRP"],
    [72, "Show - S01E02.mkv", null],
  ] as const) {
    const arrPath = `/media/Anime/Show/Season 1/${name}`;
    cache.prepare("INSERT INTO files (id, series_id, season, path, scene_name) VALUES (?, 7, 1, ?, ?)").run(id, arrPath, scene);
    db.prepare(
      "INSERT INTO media_files (path, root, size, mtime, video, audio, subs, seen_at) VALUES (?, '/media/Anime', 5, 1, ?, '[]', '[]', 1)",
    ).run(arrPath, JSON.stringify({ codec: "h264", width: 1920, height: 1080 }));
    write(path.join(LIB, "Show", "Season 1", name), `video ${id}`);
  }
  db.prepare(
    "INSERT INTO entries (anilist_id, tvdb_id, tvdb_season, tvdb_offset, kind, title_english, synonyms, status, start_date, episodes, fetched_at) VALUES (900, 555, '1', 0, 'TV', 'Show', '[]', 'FINISHED', '2020-01-01', 3, 1)",
  ).run();
  // AnimeArr state keyed by Sonarr's ids.
  db.prepare("INSERT INTO search_state (episode_id, tvdb_id, next_at, state, attempts) VALUES (703, 555, 1, 'retry', 4)").run();
  db.prepare("INSERT INTO upgrade_state (episode_id, tvdb_id, file_id, state, updated_at) VALUES (702, 555, 72, 'waiting', 1)").run();
  db.prepare(
    "INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, state, dry_run) VALUES (1, 1, 555, 7, '[701]', 'Show.S01E01', 'g', 'usenet', 'done', 0)",
  ).run();
  db.prepare("INSERT INTO decisions (at, kind, tvdb_id, episode_ids, why) VALUES (1, 'info', 555, '[702]', 'x')").run();
  // Radarr: an adopted anime movie (31) with AnimeArr state, and a non-anime movie (32) AnimeArr must never touch.
  cache
    .prepare(
      "INSERT INTO movies (id, tmdb_id, title, year, path, root_folder, monitored, has_file, is_anime, synced_at) VALUES (31, 4242, 'Film', 2019, '/media/AnimeMovies/Film', '/media/AnimeMovies', 1, 0, 1, 0)",
    )
    .run();
  cache
    .prepare(
      "INSERT INTO movies (id, tmdb_id, title, year, path, root_folder, monitored, has_file, is_anime, synced_at) VALUES (32, 5555, 'Not Anime', 2019, '/media/Movies/Not Anime', '/media/Movies', 1, 0, 0, 0)",
    )
    .run();
  db.prepare(
    "INSERT INTO native_movies (anilist_id, tmdb_id, title, year, path, root_folder, added_at) VALUES (990, 4242, 'Film', 2019, '/media/AnimeMovies/Film', '/media/AnimeMovies', 1)",
  ).run();
  db.prepare("INSERT INTO movie_wanted (movie_id, wanted, at) VALUES (31, 1, 1)").run();
  db.prepare(
    "INSERT INTO grabs (at, updated_at, movie_id, episode_ids, release, guid, protocol, state, dry_run) VALUES (1, 1, 31, '[]', 'Film.2019', 'gm', 'usenet', 'done', 0)",
  ).run();
  assert.equal(adoptShows([555])[0].ok, true);
  materializeAll();
});

const nativeShow = () =>
  db.prepare("SELECT id, detached_at FROM native_series WHERE tvdb_id = 555").get() as { id: number; detached_at: number | null };
const nativeMovie = () =>
  db.prepare("SELECT id, detached_at FROM native_movies WHERE tmdb_id = 4242").get() as { id: number; detached_at: number | null };
const epId = (e: number) => NATIVE_BASE + nativeShow().id * 1_000_000 + 10_000 + e;
/** Everything the detach moves, as one comparable snapshot. */
const snapshot = () =>
  JSON.stringify({
    series: cache.prepare("SELECT id, tvdb_id FROM series ORDER BY id").all(),
    episodes: cache.prepare("SELECT id, has_file FROM episodes ORDER BY id").all(),
    movies: cache.prepare("SELECT id, tmdb_id, is_anime FROM movies ORDER BY id").all(),
    search: db.prepare("SELECT episode_id, attempts FROM search_state ORDER BY episode_id").all(),
    upgrade: db.prepare("SELECT episode_id FROM upgrade_state ORDER BY episode_id").all(),
    grabs: db.prepare("SELECT id, episode_ids, series_id, movie_id FROM grabs ORDER BY id").all(),
    decisions: db.prepare("SELECT episode_ids FROM decisions WHERE why = 'x'").all(),
    wanted: db.prepare("SELECT movie_id FROM movie_wanted").all(),
    natives: db.prepare("SELECT tvdb_id, detached_at FROM native_series ORDER BY id").all(),
    nativeMovies: db.prepare("SELECT tmdb_id, detached_at FROM native_movies ORDER BY id").all(),
  });

test("refused while AnimeArr is downloading or importing it; nothing moves", async () => {
  const g = db
    .prepare(
      "INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, state, dry_run) VALUES (1, 1, 555, 7, '[703]', 'Show.S01E03', 'g3', 'usenet', 'downloading', 0)",
    )
    .run().lastInsertRowid;
  const gm = db
    .prepare(
      "INSERT INTO grabs (at, updated_at, movie_id, episode_ids, release, guid, protocol, state, dry_run) VALUES (1, 1, 31, '[]', 'Film.2019.v2', 'gm2', 'usenet', 'importing', 0)",
    )
    .run().lastInsertRowid;
  const before_ = snapshot();
  const out = await detach({ all: true });
  assert.match(out.find((x) => x.kind === "show")!.why, /still downloading or importing/);
  assert.match(out.find((x) => x.kind === "movie")!.why, /still downloading or importing/);
  assert.equal(snapshot(), before_);
  db.prepare("DELETE FROM grabs WHERE id IN (?, ?)").run(g, gm);
});

test("Sonarr and Radarr unreachable: the detach still succeeds, asks them nothing, and moves every piece of state", async () => {
  arr = "down";
  calls = [];
  const out = await detach({ all: true });
  assert.deepEqual(
    out.map((x) => [x.kind, x.ok]),
    [
      ["show", true],
      ["movie", true],
    ],
    JSON.stringify(out),
  );
  assert.deepEqual(arrCalls(), [], "not one request to Sonarr or Radarr");
  assert.ok(nativeShow().detached_at && nativeMovie().detached_at);
  assert.equal(cache.prepare("SELECT 1 FROM series WHERE id = 7").get(), undefined, "Sonarr's cached copy is gone");
  const s = cache.prepare("SELECT id FROM series WHERE tvdb_id = 555").get() as { id: number };
  assert.ok(s.id >= NATIVE_BASE, "AnimeArr's copy is live");
  assert.deepEqual(plain(db.prepare("SELECT episode_id, attempts FROM search_state").all()), [{ episode_id: epId(3), attempts: 4 }]);
  assert.deepEqual(plain(db.prepare("SELECT episode_id FROM upgrade_state").all()), [{ episode_id: epId(2) }]);
  const g = db.prepare("SELECT episode_ids, series_id FROM grabs WHERE guid = 'g'").get() as { episode_ids: string; series_id: number };
  assert.equal(g.episode_ids, JSON.stringify([epId(1)]));
  assert.equal(g.series_id, s.id);
  assert.equal(
    (db.prepare("SELECT episode_ids FROM decisions WHERE why = 'x'").get() as { episode_ids: string }).episode_ids,
    JSON.stringify([epId(2)]),
  );
  const mid = NATIVE_BASE + nativeMovie().id;
  assert.ok(db.prepare("SELECT 1 FROM movie_wanted WHERE movie_id = ?").get(mid), "movie state moved to AnimeArr's id");
  assert.equal((db.prepare("SELECT movie_id FROM grabs WHERE guid = 'gm'").get() as { movie_id: number }).movie_id, mid);
  assert.equal(cache.prepare("SELECT 1 FROM movies WHERE id = 31").get(), undefined, "Radarr's cached copy is gone");
  assert.ok(cache.prepare("SELECT 1 FROM movies WHERE id = ?").get(mid), "AnimeArr's movie is live");
  assert.ok(cache.prepare("SELECT 1 FROM movies WHERE id = 32 AND is_anime = 0").get(), "the non-anime movie is untouched");
  assert.equal(db.prepare("SELECT 1 FROM cutover_pending").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM cutover_pending_movies").get(), undefined);
});

test("a second detach changes nothing", async () => {
  const before_ = snapshot();
  const out = await detach({ all: true });
  assert.deepEqual(out, [], "nothing left to detach");
  const again = await detach({ tvdbIds: [555] });
  assert.equal(again[0].ok, true);
  assert.match(again[0].why, /already detached/);
  assert.equal(snapshot(), before_);
});

test("a sync while Sonarr/Radarr still list them: no duplicate, nothing moves back; the non-anime movie stays as it was", async () => {
  arr = "up";
  const before_ = snapshot();
  const r = await syncLibrary(true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.series, 0, "the detached show isn't taken from Sonarr");
  assert.equal((cache.prepare("SELECT COUNT(*) AS n FROM series WHERE tvdb_id = 555").get() as { n: number }).n, 1);
  assert.equal((cache.prepare("SELECT COUNT(*) AS n FROM movies WHERE tmdb_id = 4242").get() as { n: number }).n, 1);
  assert.ok(cache.prepare("SELECT 1 FROM movies WHERE id = 32 AND is_anime = 0").get(), "Radarr's non-anime movie is still only listed");
  assert.equal(snapshot(), before_);
  arr = "down";
});

test("a Sonarr/Radarr outage during a sync leaves AnimeArr's own shows and movies alone", async () => {
  arr = "down";
  const before_ = snapshot();
  const r = await syncLibrary(true);
  assert.ok(r.errors.length, "the outage is reported");
  assert.equal(snapshot(), before_);
});

test("a detach cut off after its journal is finished on the next start without asking Sonarr or Radarr", async () => {
  // A second adopted show (Sonarr id 9) and movie (Radarr id 41), journaled as detaches but never finished.
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, root_folder, monitored, series_type, synced_at) VALUES (9, 557, 'Other', '/media/Anime/Other', '/media/Anime', 1, 'anime', 0)",
    )
    .run();
  cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file) VALUES (901, 9, 1, 1, 1, 0)").run();
  db.prepare(
    "INSERT INTO entries (anilist_id, tvdb_id, tvdb_season, tvdb_offset, kind, title_english, synonyms, status, start_date, episodes, fetched_at) VALUES (901, 557, '1', 0, 'TV', 'Other', '[]', 'FINISHED', '2021-01-01', 1, 1)",
  ).run();
  assert.equal(adoptShows([557])[0].ok, true);
  const row = (db.prepare("SELECT id FROM native_series WHERE tvdb_id = 557").get() as { id: number }).id;
  const target = NATIVE_BASE + row * 1_000_000 + 10_000 + 1;
  db.prepare("INSERT INTO search_state (episode_id, tvdb_id, next_at, state, attempts) VALUES (901, 557, 1, 'retry', 2)").run();
  db.prepare("INSERT INTO cutover_pending (tvdb_id, sonarr_id, native_id, id_map, at, detach) VALUES (557, 9, ?, ?, 1, 1)").run(
    row,
    JSON.stringify([[901, target]]),
  );
  cache
    .prepare(
      "INSERT INTO movies (id, tmdb_id, title, year, path, root_folder, monitored, has_file, is_anime, synced_at) VALUES (41, 4343, 'Film Two', 2020, '/media/AnimeMovies/Film Two', '/media/AnimeMovies', 1, 0, 1, 0)",
    )
    .run();
  const nm = Number(
    db
      .prepare(
        "INSERT INTO native_movies (anilist_id, tmdb_id, title, year, path, root_folder, added_at) VALUES (991, 4343, 'Film Two', 2020, '/media/AnimeMovies/Film Two', '/media/AnimeMovies', 1)",
      )
      .run().lastInsertRowid,
  );
  db.prepare("INSERT INTO movie_wanted (movie_id, wanted, at) VALUES (41, 1, 1)").run();
  db.prepare("INSERT INTO cutover_pending_movies (movie_id, native_id, at, detach) VALUES (41, ?, 1, 1)").run(nm);
  const never = async () => assert.fail("Sonarr/Radarr must not be asked about a detach");
  calls = [];
  const out = await resumeCutovers({ sonarrHasSeries: never, radarrHasMovie: never });
  assert.deepEqual(out, [{ tvdbId: 557, finished: true }]);
  assert.deepEqual(arrCalls(), []);
  assert.equal((db.prepare("SELECT episode_id FROM search_state WHERE tvdb_id = 557").get() as { episode_id: number }).episode_id, target);
  assert.ok((db.prepare("SELECT detached_at FROM native_series WHERE id = ?").get(row) as { detached_at: number }).detached_at);
  assert.ok(db.prepare("SELECT 1 FROM movie_wanted WHERE movie_id = ?").get(NATIVE_BASE + nm));
  assert.ok((db.prepare("SELECT detached_at FROM native_movies WHERE id = ?").get(nm) as { detached_at: number }).detached_at);
  assert.equal(db.prepare("SELECT 1 FROM cutover_pending").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM cutover_pending_movies").get(), undefined);
  assert.equal(cache.prepare("SELECT 1 FROM series WHERE id = 9").get(), undefined);
  assert.equal(cache.prepare("SELECT 1 FROM movies WHERE id = 41").get(), undefined);
});

test("'runs without Sonarr/Radarr' is refused while a show or anime movie still comes from them, and lists them", async () => {
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, root_folder, monitored, series_type, synced_at) VALUES (11, 777, 'Not Adopted', '/media/Anime/Not Adopted', '/media/Anime', 1, 'anime', 0)",
    )
    .run();
  cache
    .prepare(
      "INSERT INTO movies (id, tmdb_id, title, year, path, root_folder, monitored, has_file, is_anime, synced_at) VALUES (51, 6000, 'Anime Film Left', 2018, '/media/AnimeMovies/Anime Film Left', '/media/AnimeMovies', 1, 0, 1, 0)",
    )
    .run();
  assert.throws(() => setWithoutArr(true), /Not Adopted[\s\S]*Anime Film Left/);
  assert.equal(getSettings().cutover.withoutArr, false);
  cache.prepare("DELETE FROM series WHERE id = 11").run();
  cache.prepare("DELETE FROM movies WHERE id = 51").run();
  // Radarr's non-anime movie (32) never blocks: AnimeArr doesn't manage it.
  assert.deepEqual(withoutArrBlockers(), []);
  assert.equal(setWithoutArr(true).withoutArr, true);
});

test("runs without Sonarr/Radarr: zero requests to either across sync, import, rename, scan, delete, re-grab and monitoring", async () => {
  arr = "up"; // they'd answer; they must not be asked
  calls = [];
  const { planImport, executeImport, planRename, applyRenameRouted } = await import("../server/import/importer.js");
  const { scanFolder } = await import("../server/import/mediafiles.js");
  const { setManaged, unmonitorInSonarr } = await import("../server/library/managed.js");
  const { dropShow, undropShow } = await import("../server/library/dropped.js");
  const { deleteEpisodeFiles, regrabEpisodes, realEpisodeDeps } = await import("../server/library/episodes.js");
  const { refreshSeriesEpisodes } = await import("../server/library/library.js");
  const { repairTick } = await import("../server/import/repair.js");
  const { sonarrQueueProblems } = await import("../server/grabs/queue.js");
  const { recycleStatus } = await import("../server/import/recycle.js");
  const { connectionsOverview } = await import("../server/system/connections.js");
  const { arrPreview } = await import("../server/system/wizard.js");
  const { cutoverPlan } = await import("../server/library/cutover.js");
  const probe = async () =>
    ({
      duration: 1440,
      container: "matroska",
      video: { codec: "h264", width: 1920, height: 1080, hdr: false },
      audio: [{ lang: "ja", title: null, codec: "aac", channels: 2, default: true, forced: false }],
      subs: [{ lang: "en", title: null, codec: "ass", default: true, forced: false, partial: false }],
    }) as never;

  const sync = await syncLibrary(true);
  assert.deepEqual(sync.errors, []);
  write(path.join(DL, "r", "Show.S01E03.1080p.WEB-DL-GRP.mkv"), "new 3");
  const plan = await planImport(
    { tvdbId: 555, path: "/data/r/Show.S01E03.1080p.WEB-DL-GRP.mkv", episodeIds: [epId(3)], client: "sabnzbd" },
    { probe, minBytes: 0 },
  );
  assert.equal(plan.items[0]?.problem ?? null, null, JSON.stringify(plan.items));
  const imp = await executeImport(plan);
  assert.equal(imp[0].done, true, imp[0].why);
  const sid = (cache.prepare("SELECT id FROM series WHERE tvdb_id = 555").get() as { id: number }).id;
  const renames = planRename(555).items;
  await applyRenameRouted(
    555,
    renames.map((i) => i.fileId),
  );
  await scanFolder("/media/Anime/Show", probe);
  await refreshSeriesEpisodes(sid);
  setManaged([555], true);
  setManaged([555], false);
  await assert.rejects(unmonitorInSonarr(555, false)); // not managed / added in AnimeArr: refused, never sent
  await dropShow(555, { unmonitor: true });
  undropShow(555);
  const del = await deleteEpisodeFiles(555, [epId(1)]);
  assert.equal(del.deleted.length, 1, JSON.stringify(del.skipped));
  await regrabEpisodes(555, [epId(2)], {
    ...realEpisodeDeps,
    search: async () => ({ results: [], indexers: [] }) as never,
  });
  assert.equal(repairTick(), null);
  assert.deepEqual(await sonarrQueueProblems(), []);
  await recycleStatus();
  await connectionsOverview().catch(() => undefined);
  await arrPreview();
  const sonarrApi = await import("../server/arr/sonarr.js");
  const radarrApi = await import("../server/arr/radarr.js");
  const fribb = async () => ({
    mtime: 0,
    anidbToAnilist: new Map<number, number>(),
    anilistToAnidb: new Map<number, number>(),
    anilistToAnidbAll: new Map<number, number[]>(),
    anilistToTmdb: new Map<number, number>(),
  });
  await cutoverPlan({
    sonarrLists: sonarrApi.getImportLists,
    sonarrNotifications: sonarrApi.getNotifications,
    radarrLists: radarrApi.getRadarrImportLists,
    fribb,
  });
  await resumeCutovers();
  assert.deepEqual(arrCalls(), [], `requests to Sonarr/Radarr: ${arrCalls().join(", ")}`);
});
