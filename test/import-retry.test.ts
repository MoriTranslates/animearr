/**
 * Blind review L22: an automatic import of several files that failed part-way must finish on "Retry import": what the
 * first try already placed is neither copied again nor refused as "a different file already has that name".
 * Series season packs and multi-part movies.
 */
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sparseFile } from "./sparse.js";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-iretry-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { importAndVerify } = await import("../server/grabs/pipeline.js");
const { importMovie } = await import("../server/library/movies.js");
const { invalidateIndex } = await import("../server/metadata/metadata.js");
const { NATIVE_BASE } = await import("../server/library/nativeIds.js");
type Deps = import("../server/grabs/pipelineState.js").PipelineDeps;
type Row = import("../server/grabs/pipelineState.js").GrabRow;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-iretry-f-"));
const LIB = path.join(tmp, "lib");
const DL = path.join(tmp, "dl");
const big = (p: string) => sparseFile(p, 31e6);

// The final rename of one file fails on the first try (a locked or unreachable destination).
const realLink = fs.linkSync;
let failDest: RegExp | null = null;
(fs as { linkSync: unknown }).linkSync = (a: fs.PathLike, b: fs.PathLike) => {
  if (failDest && failDest.test(String(b)) && !String(b).endsWith(".animearr-part"))
    throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" });
  return realLink(a, b);
};
afterEach(() => (failDest = null));

before(() => {
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/Anime", "/media/Movies"],
    importer: {
      ...s.importer,
      engine: "animearr",
      allowReal: true,
      realBudget: -1,
      movies: true,
      sourceRoots: ["/data/completed/animearr"],
    },
    localPathMappings: [
      { from: "/media/Anime", to: path.join(LIB, "anime") },
      { from: "/media/Movies", to: path.join(LIB, "movies") },
      { from: "/data", to: DL },
    ],
    media: {
      ...s.media,
      recycleBin: "",
      skipFreeSpaceCheck: true,
      renameEpisodes: true,
      animeEpisodeFormat: "{Series Title} - S{season:00}E{episode:00}",
      movieFormat: "{Movie CleanTitle} ({Release Year})",
    },
    managed: { ...s.managed, dryRun: false },
  }));
});

const localOf = (p: string) =>
  p.replace("/data", DL).replace("/media/Anime", path.join(LIB, "anime")).replace("/media/Movies", path.join(LIB, "movies"));
const probe = async () => ({ durationSec: 1440, audio: ["ja", "en"], subs: ["en"], sidecars: [], untagged: 0, forced: [] });
const deps = (pack: string) =>
  ({
    clients: {
      addNzb: async () => ({ client: "sabnzbd", ref: "x" }),
      addTorrent: async () => ({ client: "qbittorrent", ref: "h" }),
      remove: async () => undefined,
      status: async () => ({ state: "completed", progress: 1, path: pack }),
    },
    fetchRelease: async () => ({ data: Buffer.from(""), filename: "x" }),
    sonarr: {
      preview: async (folder: string) =>
        fs.readdirSync(localOf(folder)).map((f) => ({ path: `${folder}/${f}`, size: 5e8, quality: {}, languages: [] })),
      importFiles: async () => ({ id: 1 }),
      command: async () => ({ id: 1, status: "completed" }),
      episode: async () => ({}),
      episodeFile: async () => ({}),
    },
    probe,
    localPath: localOf,
    sleep: async () => undefined,
    refreshSeries: async () => undefined,
    cleanup: async () => null,
  }) as unknown as Deps;
const importsOf = (like: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE kind = 'import' AND why LIKE ?").get(like) as { n: number }).n;
const stateOf = (id: number) =>
  db.prepare("SELECT state, error FROM grabs WHERE id = ?").get(id) as { state: string; error: string | null };

test("a season pack that failed part-way: Retry import places the rest; the episode already placed isn't touched", async () => {
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, year, series_type, path, root_folder, monitored, synced_at) VALUES (77, 283963, 'Absolute Duo', 2015, 'anime', '/media/Anime/Absolute Duo', '/media/Anime', 1, 0)",
    )
    .run();
  invalidateIndex();
  for (const e of [1, 2])
    cache
      .prepare(
        "INSERT INTO episodes (id, series_id, season, episode, absolute, title, monitored, has_file, runtime) VALUES (?, 77, 1, ?, ?, ?, 1, 0, 24)",
      )
      .run(700 + e, e, e, `Episode ${e}`);
  const packDir = "[Judas] Absolute Duo (Season 01) (Batch)";
  for (const e of [1, 2]) big(path.join(DL, "completed", "animearr", packDir, `[Judas] Absolute Duo - S01E0${e}.mkv`));
  const pack = `/data/completed/animearr/${packDir}`;
  const id = Number(
    db
      .prepare(
        "INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, indexer_id, protocol, client, client_ref, state, dry_run, origin, why, candidates) VALUES (?, ?, 283963, 77, '[701,702]', ?, 'g1', 9, 'torrent', 'qbittorrent', 'h', 'importing', 0, 'manual', 'test', '[]')",
      )
      .run(Date.now(), Date.now(), "[Judas] Absolute Duo (Season 01) [BD 1080p] (Batch)").lastInsertRowid,
  );
  const row = () => db.prepare("SELECT * FROM grabs WHERE id = ?").get(id) as unknown as Row;
  failDest = /S01E02\.mkv$/;
  await importAndVerify(row(), pack, deps(pack));
  assert.equal(stateOf(id).state, "needs-attention", "the first try stopped at E02");
  const e1 = path.join(LIB, "anime", "Absolute Duo", "Season 01", "Absolute Duo - S01E01.mkv");
  assert.ok(fs.existsSync(e1), "E01 was placed");
  const e1Ino = fs.statSync(e1).ino;
  failDest = null;
  db.prepare("UPDATE grabs SET state = 'importing' WHERE id = ?").run(id);
  await importAndVerify(row(), pack, deps(pack));
  const s = stateOf(id);
  assert.equal(s.state, "done", s.error ?? "");
  assert.ok(fs.existsSync(path.join(LIB, "anime", "Absolute Duo", "Season 01", "Absolute Duo - S01E02.mkv")), "E02 placed on the retry");
  assert.equal(fs.statSync(e1).ino, e1Ino, "E01 is the same file (not replaced or copied again)");
  assert.equal(importsOf("Imported S01E01 →%"), 1, "E01 imported once");
  assert.equal(importsOf("Imported S01E02 →%"), 1, "E02 imported once");
});

test("a multi-part movie that failed part-way: Retry import places the missing part only", async () => {
  const MID = NATIVE_BASE + 4242;
  cache
    .prepare(
      "INSERT INTO movies (id, tmdb_id, title, year, path, root_folder, monitored, has_file, is_anime, runtime, synced_at, is_available) VALUES (?, 4242, 'Parted', 2020, '/media/Movies/Parted (2020)', '/media/Movies', 1, 0, 1, 96, 0, 1)",
    )
    .run(MID);
  const dir = "Parted.2020.1080p.BluRay-GRP";
  for (const n of [1, 2]) sparseFile(path.join(DL, "completed", "animearr", dir, `Parted.2020.Part.${n}.1080p.BluRay-GRP.mkv`), 2e9);
  const folder = `/data/completed/animearr/${dir}`;
  const id = Number(
    db
      .prepare(
        "INSERT INTO grabs (at, updated_at, movie_id, episode_ids, release, guid, indexer_id, protocol, client, client_ref, state, dry_run, origin, why, candidates) VALUES (?, ?, ?, '[]', ?, 'g2', 9, 'torrent', 'qbittorrent', 'h2', 'importing', 0, 'manual', 'test', '[]')",
      )
      .run(Date.now(), Date.now(), MID, dir).lastInsertRowid,
  );
  const row = () => db.prepare("SELECT * FROM grabs WHERE id = ?").get(id) as unknown as Row;
  const mdeps = { ...deps(folder), probe: async () => ({ ...(await probe()), durationSec: 48 * 60 }) } as unknown as Deps;
  failDest = /pt2\.mkv$/;
  await importMovie(row(), folder, mdeps);
  assert.equal(stateOf(id).state, "needs-attention", JSON.stringify(stateOf(id)));
  const movieDir = path.join(LIB, "movies", "Parted (2020)");
  const pt1 = fs.readdirSync(movieDir).find((f) => /pt1\.mkv$/.test(f));
  assert.ok(pt1, `part 1 was placed: ${fs.readdirSync(movieDir).join(", ")}`);
  const ino = fs.statSync(path.join(movieDir, pt1!)).ino;
  failDest = null;
  db.prepare("UPDATE grabs SET state = 'importing' WHERE id = ?").run(id);
  await importMovie(row(), folder, mdeps);
  const s = stateOf(id);
  assert.equal(s.state, "done", s.error ?? "");
  assert.deepEqual(
    fs
      .readdirSync(movieDir)
      .filter((f) => f.endsWith(".mkv"))
      .map((f) => f.replace(/^.* - /, ""))
      .sort(),
    ["pt1.mkv", "pt2.mkv"],
  );
  assert.equal(fs.statSync(path.join(movieDir, pt1!)).ino, ino, "part 1 untouched");
});

test("M1: a usenet (moved) multi-part movie that failed part-way: Retry import places the rest, never fails or blocklists", async () => {
  const MID = NATIVE_BASE + 4343;
  cache
    .prepare(
      "INSERT INTO movies (id, tmdb_id, title, year, path, root_folder, monitored, has_file, is_anime, runtime, synced_at, is_available) VALUES (?, 4343, 'Usenet Parted', 2021, '/media/Movies/Usenet Parted (2021)', '/media/Movies', 1, 0, 1, 96, 0, 1)",
    )
    .run(MID);
  const dir = "Usenet.Parted.2021.1080p.BluRay-GRP";
  for (const n of [1, 2]) sparseFile(path.join(DL, "completed", "animearr", dir, `Usenet.Parted.2021.Part.${n}.1080p.BluRay-GRP.mkv`), 2e9);
  const folder = `/data/completed/animearr/${dir}`;
  const id = Number(
    db
      .prepare(
        "INSERT INTO grabs (at, updated_at, movie_id, episode_ids, release, guid, indexer_id, protocol, client, client_ref, state, dry_run, origin, why, candidates) VALUES (?, ?, ?, '[]', ?, 'g3', 9, 'usenet', 'sabnzbd', 'x3', 'importing', 0, 'manual', 'test', '[]')",
      )
      .run(Date.now(), Date.now(), MID, dir).lastInsertRowid,
  );
  const row = () => db.prepare("SELECT * FROM grabs WHERE id = ?").get(id) as unknown as Row;
  const mdeps = { ...deps(folder), probe: async () => ({ ...(await probe()), durationSec: 48 * 60 }) } as unknown as Deps;
  failDest = /Usenet Parted \(2021\) - pt2\.mkv$/;
  await importMovie(row(), folder, mdeps);
  assert.equal(stateOf(id).state, "needs-attention", JSON.stringify(stateOf(id)));
  const movieDir = path.join(LIB, "movies", "Usenet Parted (2021)");
  const pt1 = path.join(movieDir, "Usenet Parted (2021) - pt1.mkv");
  assert.ok(fs.existsSync(pt1), `part 1 was placed: ${fs.readdirSync(movieDir).join(", ")}`);
  assert.equal(fs.readdirSync(path.join(DL, "completed", "animearr", dir)).length, 1, "usenet: part 1 was moved out of the download");
  const ino = fs.statSync(pt1).ino;
  failDest = null;
  db.prepare("UPDATE grabs SET state = 'importing' WHERE id = ?").run(id);
  await importMovie(row(), folder, mdeps);
  const s = stateOf(id);
  assert.equal(s.state, "done", s.error ?? "");
  assert.deepEqual(
    fs
      .readdirSync(movieDir)
      .filter((f) => f.endsWith(".mkv"))
      .sort(),
    ["Usenet Parted (2021) - pt1.mkv", "Usenet Parted (2021) - pt2.mkv"],
  );
  assert.equal(fs.statSync(pt1).ino, ino, "part 1 untouched");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM blocklist").get() as { n: number }).n, 0, "nothing blocklisted");
});

test("M1: a retry whose remaining part fails its check goes to needs-attention, never failed/blocklisted", async () => {
  const MID = NATIVE_BASE + 4444;
  cache
    .prepare(
      "INSERT INTO movies (id, tmdb_id, title, year, path, root_folder, monitored, has_file, is_anime, runtime, synced_at, is_available) VALUES (?, 4444, 'Bad Part', 2022, '/media/Movies/Bad Part (2022)', '/media/Movies', 1, 0, 1, 96, 0, 1)",
    )
    .run(MID);
  const dir = "Bad.Part.2022.1080p.BluRay-GRP";
  for (const n of [1, 2]) sparseFile(path.join(DL, "completed", "animearr", dir, `Bad.Part.2022.Part.${n}.1080p.BluRay-GRP.mkv`), 2e9);
  const folder = `/data/completed/animearr/${dir}`;
  const id = Number(
    db
      .prepare(
        "INSERT INTO grabs (at, updated_at, movie_id, episode_ids, release, guid, indexer_id, protocol, client, client_ref, state, dry_run, origin, why, candidates) VALUES (?, ?, ?, '[]', ?, 'g4', 9, 'usenet', 'sabnzbd', 'x4', 'importing', 0, 'manual', 'test', '[]')",
      )
      .run(Date.now(), Date.now(), MID, dir).lastInsertRowid,
  );
  const row = () => db.prepare("SELECT * FROM grabs WHERE id = ?").get(id) as unknown as Row;
  let subs = ["en"];
  const mdeps = { ...deps(folder), probe: async () => ({ ...(await probe()), subs, durationSec: 48 * 60 }) } as unknown as Deps;
  failDest = /Bad Part \(2022\) - pt2\.mkv$/;
  await importMovie(row(), folder, mdeps);
  assert.equal(stateOf(id).state, "needs-attention");
  failDest = null;
  subs = []; // the remaining part now fails the language check
  db.prepare("UPDATE grabs SET state = 'importing' WHERE id = ?").run(id);
  await importMovie(row(), folder, mdeps);
  assert.equal(stateOf(id).state, "needs-attention", JSON.stringify(stateOf(id)));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM blocklist").get() as { n: number }).n, 0, "nothing blocklisted");
});

test("M1: a Radarr movie whose part 1 Radarr already picked up as its file: Retry import still finishes", async () => {
  const MID = 4545;
  cache
    .prepare(
      "INSERT INTO movies (id, tmdb_id, title, year, path, root_folder, monitored, has_file, is_anime, runtime, synced_at, is_available) VALUES (?, 4545, 'Radarr Parted', 2023, '/media/Movies/Radarr Parted (2023)', '/media/Movies', 1, 0, 1, 96, 0, 1)",
    )
    .run(MID);
  const dir = "Radarr.Parted.2023.1080p.BluRay-GRP";
  for (const n of [1, 2]) sparseFile(path.join(DL, "completed", "animearr", dir, `Radarr.Parted.2023.Part.${n}.1080p.BluRay-GRP.mkv`), 2e9);
  const folder = `/data/completed/animearr/${dir}`;
  const id = Number(
    db
      .prepare(
        "INSERT INTO grabs (at, updated_at, movie_id, episode_ids, release, guid, indexer_id, protocol, client, client_ref, state, dry_run, origin, why, candidates) VALUES (?, ?, ?, '[]', ?, 'g5', 9, 'usenet', 'sabnzbd', 'x5', 'importing', 0, 'manual', 'test', '[]')",
      )
      .run(Date.now(), Date.now(), MID, dir).lastInsertRowid,
  );
  const row = () => db.prepare("SELECT * FROM grabs WHERE id = ?").get(id) as unknown as Row;
  const pt1Arr = "/media/Movies/Radarr Parted (2023)/Radarr Parted (2023) - pt1.mkv";
  let radarrFile: string | null = null;
  const mdeps = {
    ...deps(folder),
    probe: async () => ({ ...(await probe()), durationSec: 48 * 60 }),
    radarr: {
      movie: async () => ({
        id: MID,
        path: "/media/Movies/Radarr Parted (2023)",
        hasFile: !!radarrFile,
        runtime: 96,
        movieFile: radarrFile ? { path: radarrFile } : undefined,
      }),
      preview: async (f: string) => fs.readdirSync(localOf(f)).map((x) => ({ path: `${f}/${x}`, size: 2e9, quality: {}, languages: [] })),
    },
  } as unknown as Deps;
  failDest = /Radarr Parted \(2023\) - pt2\.mkv$/;
  await importMovie(row(), folder, mdeps);
  assert.equal(stateOf(id).state, "needs-attention", JSON.stringify(stateOf(id)));
  radarrFile = pt1Arr; // Radarr picked up part 1 as the movie's file meanwhile
  failDest = null;
  db.prepare("UPDATE grabs SET state = 'importing' WHERE id = ?").run(id);
  await importMovie(row(), folder, mdeps);
  assert.equal(stateOf(id).state, "done", JSON.stringify(stateOf(id)));
  assert.ok(fs.existsSync(path.join(LIB, "movies", "Radarr Parted (2023)", "Radarr Parted (2023) - pt2.mkv")));
});
