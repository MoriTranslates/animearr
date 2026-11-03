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

test("L3 known limit: a Sonarr rename still running when AnimeArr stops waiting leaves the rows at the old path, never deleted", async () => {
  const from = libraryFile(517, "frieren 17.mkv", [109]);
  const to = `${SEASON_ARR}/Frieren S01E09 slow.mkv`;
  const pending = [
    {
      seriesId: 10,
      seasonNumber: 1,
      episodeNumbers: [9],
      episodeFileId: 517,
      existingPath: "Season 01/frieren 17.mkv",
      newPath: "Season 01/Frieren S01E09 slow.mkv",
    },
  ];
  const r = await applyRenameRouted(424536, [517], {
    sonarrOn: () => true,
    preview: async () => pending,
    renameFiles: async () => ({ id: 17 }),
    getCommand: async () => ({ id: 17, status: "started" }), // never finishes while AnimeArr waits
    sleep: async () => undefined,
  });
  assert.equal(r.results[0].done, false);
  assert.deepEqual(rowsAt(from), ALL, "every row is still at the old path");
  assert.deepEqual(rowsAt(to), NONE);
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
  // The old file's rows went with it to the bin (kept, not deleted), keyed by the bin's library-style path (L1).
  const binned = (
    db.prepare("SELECT path FROM file_marks WHERE path LIKE ?").all(`%${path.posix.basename(dest)}`) as { path: string }[]
  ).map((r) => r.path);
  assert.equal(binned.length, 1, JSON.stringify(binned));
  assert.equal(binned[0], `/media/Recycle/animearr/Frieren (2023)/Season 01/${path.posix.basename(dest)}`);
  // L1: when the bin is emptied, the rows of the files it deletes go too.
  const { purgeBin } = await import("../server/import/binpurge.js");
  const r = await purgeBin({ all: true });
  assert.ok(r.deleted >= 1, JSON.stringify(r));
  assert.deepEqual(rowsAt(binned[0]), NONE, "no orphan rows left for the purged file");
});

// ---------------------------------------------------------------- episode delete (through Sonarr, into its bin)

const { deleteEpisodeFiles } = await import("../server/library/episodes.js");
type EpisodeDeps = import("../server/library/episodes.js").EpisodeDeps;
const sonarrDelete = (fileId: number, arr: string, bin: { configured: boolean; path: string } | null): EpisodeDeps =>
  ({
    episode: async (id: number) => ({
      id,
      seriesId: 10,
      seasonNumber: 1,
      episodeNumber: id - 100,
      monitored: true,
      hasFile: true,
      episodeFileId: fileId,
    }),
    episodeFile: async (id: number) => ({ id, seriesId: 10, seasonNumber: 1, path: arr, size: 1, sceneName: null, quality: null }),
    deleteFile: async () => {
      fs.rmSync(path.join(LIB, arr.slice("/media/AnimeArr".length))); // what Sonarr does (to its bin)
      cache.prepare("UPDATE episodes SET file_id = NULL, has_file = 0 WHERE file_id = ?").run(fileId);
      cache.prepare("DELETE FROM files WHERE id = ?").run(fileId);
    },
    refresh: async () => undefined,
    search: (async () => []) as unknown as EpisodeDeps["search"],
    grab: (async () => ({})) as unknown as EpisodeDeps["grab"],
    recycle: async () => (bin ? { ...bin, cleanupDays: 7 } : Promise.reject(new Error("Sonarr unreachable"))),
  }) as EpisodeDeps;

test("a file deleted into Sonarr's bin takes its rows along; a new file imported at that name inherits nothing", async () => {
  const probe = async () =>
    ({
      duration: 1440,
      container: "matroska",
      video: { codec: "h264", width: 1920, height: 1080, hdr: false },
      audio: [{ lang: "ja", title: null, codec: "aac", channels: 2, default: true, forced: false }],
      subs: [{ lang: "en", title: null, codec: "ass", default: true, forced: false, partial: false }],
    }) as never;
  write(path.join(DL, "d", "Frieren.S01E09.1080p.WEB-DL-GRP.mkv"), "new 9");
  const src = { tvdbId: 424536, path: "/data/d/Frieren.S01E09.1080p.WEB-DL-GRP.mkv", episodeIds: [109], client: "sabnzbd" };
  const dest = (await planImport(src, { probe, minBytes: 0 })).items[0].destArr;
  libraryFile(509, path.posix.basename(dest), [109]);
  const r = await deleteEpisodeFiles(424536, [109], sonarrDelete(509, dest, { configured: true, path: "/media/SonarrBin" }));
  assert.equal(r.deleted.length, 1, JSON.stringify(r.skipped));
  assert.deepEqual(rowsAt(dest), NONE, "nothing left at the deleted file's name");
  // Sonarr's bin keeps the show folder: <bin>/<show folder>/<path inside the show>.
  assert.deepEqual(rowsAt(`/media/SonarrBin/Frieren (2023)/Season 01/${path.posix.basename(dest)}`), ALL, "kept, at the bin");
  // A new file at the same name.
  const res = await executeImport(await planImport(src, { probe, minBytes: 0 }));
  assert.equal(res[0].done, true, res[0].why);
  assert.equal(overridesFor(dest).length, 0, "no inherited track corrections");
  assert.equal(rowsAt(dest).file_marks, 0, "no inherited burned-in mark");
  assert.equal(linkOf(dest), JSON.stringify([109]));
});

const lastLogAbout = (name: string) =>
  (db.prepare("SELECT why FROM decisions WHERE why LIKE ? ORDER BY id DESC LIMIT 1").get(`%${name}%`) as { why: string }).why;

test("M3: a permanent delete (Sonarr has no bin) drops the file's rows; a new file at that name starts clean", async () => {
  const arr = libraryFile(510, "frieren 510.mkv", [106]);
  const r = await deleteEpisodeFiles(424536, [106], sonarrDelete(510, arr, { configured: false, path: "" }));
  assert.equal(r.deleted.length, 1, JSON.stringify(r.skipped));
  assert.deepEqual(rowsAt(arr), NONE, "nothing about the deleted file is left at its name");
  assert.equal(overridesFor(arr).length, 0, "a new file at that name gets no inherited track corrections");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM file_marks WHERE path LIKE '%frieren 510%'").get() as { n: number }).n, 0, "dropped");
  assert.match(lastLogAbout("frieren 510.mkv"), /track corrections and burned-in mark .*dropped/);
});

test("M3: a delete whose bin Sonarr didn't report sets the rows aside (recoverable), never at the old name", async () => {
  const arr = libraryFile(511, "frieren 511.mkv", [102]);
  const r = await deleteEpisodeFiles(424536, [102], sonarrDelete(511, arr, null));
  assert.equal(r.deleted.length, 1, JSON.stringify(r.skipped));
  assert.deepEqual(rowsAt(arr), NONE, "nothing left at its name");
  assert.equal(overridesFor(arr).length, 0, "a new file at that name gets no inherited track corrections");
  const aside = (db.prepare("SELECT path FROM file_marks WHERE path LIKE 'deleted:%'").get() as { path: string } | undefined)?.path;
  assert.ok(aside && aside.endsWith(`:${arr}`), `kept under a reserved key: ${aside}`);
  assert.deepEqual(rowsAt(aside!), ALL, "every row kept, under that key");
  assert.match(lastLogAbout("frieren 511.mkv"), /set aside/);
});

// ---------------------------------------------------------------- rename undo: only the file AnimeArr renamed (L9)

/** Renames file `id` and returns its undo args, as Activity stores them. */
async function renamedWithUndo(id: number, name: string, ep: number) {
  libraryFile(id, name, [ep]);
  const res = await applyRename(424536, [id]);
  assert.equal(res[0].done, true, res[0].why);
  const undo = (db.prepare("SELECT undo FROM decisions WHERE undo LIKE '%rename-back%' ORDER BY id DESC LIMIT 1").get() as { undo: string })
    .undo;
  return JSON.parse(undo).args as { from: string; to: string; size: number; mtime?: number; ino?: number };
}

test("L9: the undo refuses when another file of the same size now has the new name", async () => {
  const args = await renamedWithUndo(512, "frieren 12.mkv", 103);
  // Replaced meanwhile by a different file of exactly the same size.
  const content = fs.readFileSync(args.from);
  fs.rmSync(args.from);
  fs.writeFileSync(args.from, Buffer.alloc(content.length, 0x41));
  fs.utimesSync(args.from, new Date(2020, 0, 1), new Date(2020, 0, 1));
  await assert.rejects(renameBack(args), /isn't the file AnimeArr renamed|changed since the rename/);
  assert.ok(fs.existsSync(args.from), "the other file stays where it is");
  assert.equal(fs.existsSync(args.to), false, "nothing is renamed back");
});

test("L9: the undo refuses when the renamed file was changed in place (same size, new time)", async () => {
  const args = await renamedWithUndo(513, "frieren 13.mkv", 104);
  const later = new Date(Date.now() + 3_600_000);
  fs.utimesSync(args.from, later, later);
  await assert.rejects(renameBack(args), /changed since the rename/);
  assert.ok(fs.existsSync(args.from));
});

test("L9: an undo logged before mtime was kept still works by size, and says so", async () => {
  const args = await renamedWithUndo(514, "frieren 14.mkv", 106);
  const { mtime: _m, ino: _i, ...old } = args;
  await renameBack(old);
  assert.ok(fs.existsSync(args.to), "renamed back");
  const note = db.prepare("SELECT why FROM decisions WHERE why LIKE '%by its size only%' ORDER BY id DESC LIMIT 1").get() as
    { why: string } | undefined;
  assert.ok(note, "a note says it was checked by size only");
});

test("Unraid /mnt/user (shfs): a different inode number for the same file (same size and time) doesn't block the undo", async () => {
  const args = await renamedWithUndo(515, "frieren 15.mkv", 107);
  // shfs may hand out another inode number for the same file after an array stop/start or a restart.
  await renameBack({ ...args, ino: (args.ino ?? 1) + 987_654 });
  assert.ok(fs.existsSync(args.to), "renamed back");
  assert.equal(fs.existsSync(args.from), false);
});

test("L2: stale rows already at the new name are replaced, not merged into the renamed file's", async () => {
  cache
    .prepare(
      "INSERT INTO episodes (id, series_id, season, episode, absolute, title, monitored, has_file) VALUES (110, 10, 1, 10, 10, 'Ep 10', 1, 0)",
    )
    .run();
  libraryFile(516, "frieren 16.mkv", [110]);
  const it = planFor(516);
  // Left at the new name by a file replaced outside AnimeArr: a correction for track 7 (the renamed file has none).
  db.prepare("INSERT INTO track_overrides (path, track_index, lang, forced, at) VALUES (?, 7, 'de', 0, 1)").run(it.to);
  const res = await applyRename(424536, [516]);
  assert.equal(res[0].done, true, res[0].why);
  assert.deepEqual(
    overridesFor(it.to)
      .map((o) => o.trackIndex)
      .sort(),
    [2, 3],
    "the renamed file's own corrections (tracks 2 and 3), not the stale track 7",
  );
});
