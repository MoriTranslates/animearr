/**
 * Per-file rows keyed by the file's path (file_links, file_meta, track_overrides, file_marks) follow the file when
 * AnimeArr renames it, all together or not at all; a replaced file's rows never stick to the new file at that path.
 */
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-rrows-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { planRename, applyRename, applyRenameRouted, renameBack, planImport, executeImport } = await import("../server/import/importer.js");
const { overridesFor } = await import("../server/import/trackOverrides.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-rrows-f-"));
const LIB = path.join(tmp, "lib");
const DL = path.join(tmp, "dl");
const BIN = path.join(tmp, "bin");
const SEASON_ARR = "/media/AnimeArr/Frieren (2023)/Season 01";
const SEASON = path.join(LIB, "Frieren (2023)", "Season 01");
const write = (p: string, s = "x") => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s));

const realLink = fs.linkSync;
let linkFault: ((a: string, b: string) => string | null) | null = null;
(fs as { linkSync: unknown }).linkSync = (a: fs.PathLike, b: fs.PathLike) => {
  const code = linkFault?.(path.resolve(String(a)), path.resolve(String(b)));
  if (code) throw Object.assign(new Error(`${code}: simulated`), { code });
  return realLink(a, b);
};
afterEach(() => {
  linkFault = null;
  db.exec("DROP TRIGGER IF EXISTS refuse_marks");
});

before(() => {
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, year, series_type, path, root_folder, monitored, synced_at) VALUES (10, 424536, 'Frieren', 2023, 'anime', '/media/AnimeArr/Frieren (2023)', '/media/AnimeArr', 1, 0)",
    )
    .run();
  for (let e = 1; e <= 9; e++)
    cache
      .prepare(
        "INSERT INTO episodes (id, series_id, season, episode, absolute, title, monitored, has_file) VALUES (?, 10, 1, ?, ?, ?, 1, 0)",
      )
      .run(100 + e, e, e, `Ep ${e}`);
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/AnimeArr"],
    localPathMappings: [
      { from: "/media/AnimeArr", to: LIB },
      { from: "/data", to: DL },
      { from: "/media/Recycle", to: BIN },
    ],
    importer: { ...s.importer, allowRename: true, allowReal: true, realBudget: -1 },
    media: {
      ...s.media,
      renameEpisodes: true,
      recycleBin: "/media/Recycle/animearr",
      skipFreeSpaceCheck: true,
      animeEpisodeFormat: "{Series Title} - S{season:00}E{episode:00} [{Quality Full}]",
    },
  }));
});

/** A library file (with its scan record) holding `eps`, plus one row of every per-file kind at its path. */
function libraryFile(id: number, name: string, eps: number[]) {
  const arr = `${SEASON_ARR}/${name}`;
  write(path.join(SEASON, name), `video ${id}`);
  cache
    .prepare("INSERT INTO files (id, series_id, season, path, scene_name, quality, revision) VALUES (?, 10, 1, ?, NULL, 'WEBDL-1080p', ?)")
    .run(id, arr, JSON.stringify({ version: 1 }));
  for (const e of eps) cache.prepare("UPDATE episodes SET file_id = ?, has_file = 1 WHERE id = ?").run(id, e);
  db.prepare(
    "INSERT OR REPLACE INTO media_files (path, root, size, mtime, video, audio, subs, seen_at) VALUES (?, '/media/AnimeArr', 1, 1, ?, '[]', '[]', 1)",
  ).run(arr, JSON.stringify({ codec: "h264", width: 1920, height: 1080, hdr: false, bitDepth: 8 }));
  addRows(arr, eps);
  return arr;
}
function addRows(arr: string, eps: number[]) {
  const now = Date.now();
  db.prepare("INSERT OR REPLACE INTO file_links (path, tvdb_id, episode_ids, at) VALUES (?, 424536, ?, ?)").run(
    arr,
    JSON.stringify(eps),
    now,
  );
  db.prepare(
    "INSERT OR REPLACE INTO file_meta (path, scene_name, release_group, quality, revision) VALUES (?, 'Scene.Name', 'GRP', 'WEBDL-1080p', NULL)",
  ).run(arr);
  db.prepare("INSERT OR REPLACE INTO track_overrides (path, track_index, lang, forced, at) VALUES (?, 2, 'en', 0, ?)").run(arr, now);
  db.prepare("INSERT OR REPLACE INTO track_overrides (path, track_index, lang, forced, at) VALUES (?, 3, 'en', 1, ?)").run(arr, now);
  db.prepare("INSERT OR REPLACE INTO file_marks (path, tvdb_id, burned_lang, at) VALUES (?, 424536, 'en', ?)").run(arr, now);
}
/** How many rows of each kind sit at a path. */
function rowsAt(arr: string) {
  const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE path = ?`).get(arr) as { n: number }).n;
  return { file_links: n("file_links"), file_meta: n("file_meta"), track_overrides: n("track_overrides"), file_marks: n("file_marks") };
}
const ALL = { file_links: 1, file_meta: 1, track_overrides: 2, file_marks: 1 };
const NONE = { file_links: 0, file_meta: 0, track_overrides: 0, file_marks: 0 };
const linkOf = (arr: string) =>
  (db.prepare("SELECT episode_ids FROM file_links WHERE path = ?").get(arr) as { episode_ids: string } | undefined)?.episode_ids;
const planFor = (id: number) => planRename(424536).items.find((i) => i.fileId === id)!;

test("a rename (multi-episode file) takes every per-file row along, and its undo brings them back", async () => {
  const from = libraryFile(501, "frieren 1-2.mkv", [101, 102]);
  const it = planFor(501);
  assert.equal(it.problem, null);
  const res = await applyRename(424536, [501]);
  assert.equal(res[0].done, true, res[0].why);
  assert.deepEqual(rowsAt(from), NONE, "nothing left at the old name");
  assert.deepEqual(rowsAt(it.to), ALL, "everything at the new name");
  assert.equal(linkOf(it.to), JSON.stringify([101, 102]), "both episodes of the file are still linked");
  assert.equal(overridesFor(it.to).length, 2, "the track corrections apply to the renamed file");
  assert.equal(overridesFor(from).length, 0);
  // Undo, as Activity runs it.
  const undo = (db.prepare("SELECT undo FROM decisions WHERE undo LIKE '%rename-back%' ORDER BY id DESC LIMIT 1").get() as { undo: string })
    .undo;
  await renameBack(JSON.parse(undo).args);
  assert.deepEqual(rowsAt(from), ALL, "the undo brings the rows back");
  assert.deepEqual(rowsAt(it.to), NONE);
  assert.equal(overridesFor(from).length, 2);
});

test("a rename that fails (the file can't be moved) leaves the rows on the old name", async () => {
  const from = libraryFile(503, "frieren 3.mkv", [103]);
  const it = planFor(503);
  linkFault = (a) => (a === path.resolve(path.join(SEASON, "frieren 3.mkv")) ? "EACCES" : null);
  const res = await applyRename(424536, [503]);
  assert.equal(res[0].done, false);
  assert.deepEqual(rowsAt(from), ALL);
  assert.deepEqual(rowsAt(it.to), NONE);
  assert.ok(fs.existsSync(path.join(SEASON, "frieren 3.mkv")));
});

test("rows that can't follow: the file goes back to its old name, and the result says so", async () => {
  const from = libraryFile(504, "frieren 4.mkv", [104]);
  const it = planFor(504);
  db.exec("CREATE TRIGGER refuse_marks BEFORE UPDATE ON file_marks BEGIN SELECT RAISE(ABORT, 'disk I/O error (simulated)'); END");
  const res = await applyRename(424536, [504]);
  assert.equal(res[0].done, false);
  assert.match(res[0].why, /not renamed.*disk I\/O error/);
  assert.ok(fs.existsSync(path.join(SEASON, "frieren 4.mkv")), "the file is back at its old name");
  assert.equal(fs.existsSync(path.join(LIB, it.to.slice("/media/AnimeArr".length))), false);
  assert.deepEqual(rowsAt(from), ALL, "all rows still at the old name (none moved half-way)");
  assert.deepEqual(rowsAt(it.to), NONE);
});

test("a name differing only by case: the rows always sit where the file really is", async () => {
  // The name the naming settings give, in lower case (on Windows that is the same file).
  libraryFile(505, "probe.mkv", [105]);
  const target = path.posix.basename(planFor(505).to);
  cache.prepare("DELETE FROM files WHERE id = 505").run();
  db.prepare("DELETE FROM media_files WHERE path = ?").run(`${SEASON_ARR}/probe.mkv`);
  for (const t of ["file_links", "file_meta", "track_overrides", "file_marks"])
    db.prepare(`DELETE FROM ${t} WHERE path = ?`).run(`${SEASON_ARR}/probe.mkv`);
  fs.rmSync(path.join(SEASON, "probe.mkv"));
  libraryFile(506, target.toLowerCase(), [105]);
  await applyRename(424536, [506]);
  const onDisk = fs.readdirSync(SEASON).find((f) => f.toLowerCase() === target.toLowerCase())!;
  assert.deepEqual(rowsAt(`${SEASON_ARR}/${onDisk}`), ALL, `rows follow the name on disk (${onDisk})`);
});

test("a rename done by Sonarr: the rows follow once Sonarr has renamed the file", async () => {
  const from = libraryFile(507, "frieren 7.mkv", [107]);
  const to = `${SEASON_ARR}/Frieren S01E07.mkv`;
  let pending = [
    {
      seriesId: 10,
      seasonNumber: 1,
      episodeNumbers: [7],
      episodeFileId: 507,
      existingPath: "Season 01/frieren 7.mkv",
      newPath: "Season 01/Frieren S01E07.mkv",
    },
  ];
  const r = await applyRenameRouted(424536, [507], {
    sonarrOn: () => true,
    preview: async () => pending,
    renameFiles: async () => ((pending = []), { id: 9 }),
    getCommand: async () => ({ id: 9, status: "completed" }),
    sleep: async () => undefined,
  });
  assert.equal(r.results[0].done, true);
  assert.deepEqual(rowsAt(to), ALL);
  assert.deepEqual(rowsAt(from), NONE);
});

test("a replaced file's corrections and marks never stick to the new file that takes its name", async () => {
  const probe = async () =>
    ({
      duration: 1440,
      container: "matroska",
      video: { codec: "h264", width: 1920, height: 1080, hdr: false },
      audio: [{ lang: "ja", title: null, codec: "aac", channels: 2, default: true, forced: false }],
      subs: [{ lang: "en", title: null, codec: "ass", default: true, forced: false, partial: false }],
    }) as never;
  write(path.join(DL, "r", "Frieren.S01E08.1080p.WEB-DL-GRP.mkv"), "new 8");
  const first = await planImport(
    { tvdbId: 424536, path: "/data/r/Frieren.S01E08.1080p.WEB-DL-GRP.mkv", episodeIds: [108], client: "sabnzbd" },
    { probe, minBytes: 0 },
  );
  const dest = first.items[0].destArr;
  // The old file has exactly that name, with the user's corrections on it.
  libraryFile(508, path.posix.basename(dest), [108]);
  const plan = await planImport(
    { tvdbId: 424536, path: "/data/r/Frieren.S01E08.1080p.WEB-DL-GRP.mkv", episodeIds: [108], client: "sabnzbd" },
    { probe, minBytes: 0 },
  );
  assert.equal(plan.items[0].problem, null);
  assert.ok(plan.items[0].replaces, "replaces the old file");
  const res = await executeImport(plan);
  assert.equal(res[0].done, true, res[0].why);
  const at = rowsAt(dest);
  assert.equal(at.track_overrides, 0, "the old file's track corrections don't apply to the new file");
  assert.equal(at.file_marks, 0, "nor its burned-in mark");
  assert.equal(at.file_meta, 0, "nor its release details");
  assert.equal(linkOf(dest), JSON.stringify([108]), "the new file is linked to its episode");
  // The old file's rows went with it to the bin (kept, not deleted).
  const binned = (
    db.prepare("SELECT path FROM file_marks WHERE path LIKE ?").all(`%${path.posix.basename(dest)}`) as { path: string }[]
  ).map((r) => r.path);
  assert.equal(binned.length, 1, JSON.stringify(binned));
  assert.match(binned[0], /bin\/animearr\//);
});
