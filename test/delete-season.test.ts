/**
 * Delete a season's files (Show page ⋯ menu): the same guarded delete as one episode (AnimeArr's own recycling bin,
 * never Sonarr, the allowed roots), only that season's files, never a file outside the show's folder or one shared
 * with another season, and every file it couldn't delete is reported. Real files in a scratch folder.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-delseason-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { deleteEpisodeFiles, deleteSeasonFiles, insideFolder } = await import("../server/library/episodes.js");
const hooks = await import("../server/library/episodeBin.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-delseason-lib-"));
const TVDB = 730001;
const SHOW = "/media/Anime/Delly";
const DAY = 86_400_000;
// episode id → [season, episode, file id]
const EPS: Record<number, [number, number, number | null]> = {
  8101: [1, 1, 98101],
  8102: [1, 2, 98102],
  8103: [1, 3, 98103], // a multi-episode file: S01E03 + S02E01
  8104: [1, 4, 98104], // the record points outside the show's folder
  8105: [1, 5, 98105], // its move fails
  8106: [1, 6, null], // no file
  8201: [2, 1, 98103],
  8202: [2, 2, 98202],
};
const PATHS: Record<number, string> = {
  98101: `${SHOW}/Season 01/Delly - S01E01.mkv`,
  98102: `${SHOW}/Season 01/Delly - S01E02.mkv`,
  98103: `${SHOW}/Season 01/Delly - S01E03 + S02E01.mkv`,
  98104: "/media/Anime/Someone Else/Season 01/Other - S01E01.mkv",
  98105: `${SHOW}/Season 01/Delly - S01E05.mkv`,
  98202: `${SHOW}/Season 02/Delly - S02E02.mkv`,
};
const local = (arr: string) => path.join(tmp, ...arr.slice("/media/".length).split("/"));

before(() => {
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/Anime"],
    localPathMappings: [{ from: "/media", to: tmp }],
    media: { ...s.media, recycleBin: "/media/Recycle/animearr" },
  }));
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, root_folder, monitored, status, synced_at) VALUES (81, ?, 'Delly', ?, '/media/Anime', 1, 'ended', 0)",
    )
    .run(TVDB, SHOW);
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, root_folder, monitored, status, synced_at) VALUES (82, 730002, 'Empty', '/media/Anime/Empty', '/media/Anime', 1, 'ended', 0)",
    )
    .run();
  const ins = cache.prepare(
    "INSERT INTO episodes (id, series_id, season, episode, title, air_utc, monitored, has_file, file_id, runtime) VALUES (?, 81, ?, ?, 'x', ?, 1, ?, ?, 24)",
  );
  for (const [id, [season, n, fileId]] of Object.entries(EPS))
    ins.run(Number(id), season, n, Date.now() - 100 * DAY, fileId ? 1 : 0, fileId);
  for (const [id, p] of Object.entries(PATHS)) {
    cache.prepare("INSERT INTO files (id, series_id, season, path, size) VALUES (?, 81, 1, ?, 1)").run(Number(id), p);
    fs.mkdirSync(path.dirname(local(p)), { recursive: true });
    fs.writeFileSync(local(p), "v");
  }
  cache
    .prepare(
      "INSERT INTO episodes (id, series_id, season, episode, title, air_utc, monitored, has_file, file_id, runtime) VALUES (8301, 82, 1, 1, 'x', 0, 1, 0, NULL, 24)",
    )
    .run();
});

test("only that season's own files go to the bin; the rest is reported honestly, one reason each", async () => {
  const realMove = hooks.episodeBinDeps.move;
  hooks.episodeBinDeps.move = async (a, b) => {
    if (a.endsWith("S01E05.mkv")) throw new Error("EBUSY: file in use");
    return realMove(a, b);
  };
  try {
    const r = await deleteSeasonFiles(TVDB, 1);
    assert.equal(r.asked, 5, "the season's episodes with a file (S01E06 has none)");
    assert.deepEqual(
      r.deleted.map((d) => d.episodeId),
      [8101, 8102],
    );
    for (const id of [98101, 98102]) assert.equal(fs.existsSync(local(PATHS[id])), false);
    for (const id of [98103, 98104, 98105, 98202]) assert.ok(fs.existsSync(local(PATHS[id])), `${PATHS[id]} stays`);
    const why = new Map(r.skipped.map((s) => [s.episodeId, s.why]));
    assert.match(why.get(8103)!, /also holds S02E01/);
    assert.match(why.get(8104)!, /outside the show's folder/);
    assert.match(why.get(8105)!, /EBUSY/, "the move's failure is passed on, not swallowed");
    assert.equal(r.skipped.length, 3);
  } finally {
    hooks.episodeBinDeps.move = realMove;
  }
});

test("a season without files is refused; so is a show outside the allowed roots", async () => {
  await assert.rejects(deleteSeasonFiles(730002, 1), /no files/);
  await assert.rejects(deleteSeasonFiles(TVDB, 7), /no files/);
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Other"] }));
  try {
    await assert.rejects(deleteSeasonFiles(TVDB, 1), /outside the allowed root folders/);
  } finally {
    patchSettings((s) => ({ ...s, allowedRoots: ["/media/Anime"] }));
  }
});

test("the one-episode delete (⋯ → Delete file) refuses a file outside the show's folder too", async () => {
  const r = await deleteEpisodeFiles(TVDB, [8104]);
  assert.deepEqual(r.deleted, []);
  assert.match(r.skipped[0].why, /outside the show's folder/);
  // A multi-episode file deleted on its own is fine (it's what the user picked): both its episodes become missing.
  const r2 = await deleteEpisodeFiles(TVDB, [8201, 8103]);
  assert.deepEqual(r2.deleted[0].episodes, ["S01E03", "S02E01"]);
  assert.equal(r2.deleted.length, 1, "one file, one move");
  assert.deepEqual(r2.skipped, [], "the other episode of the same file isn't reported as 'no file'");
  assert.equal(fs.existsSync(local(PATHS[98103])), false);
  const left = cache.prepare("SELECT COUNT(*) AS n FROM episodes WHERE file_id = 98103").get() as { n: number };
  assert.equal(left.n, 0);
});

test("insideFolder: strictly inside, `..` resolved, no prefix tricks, Windows paths without case", () => {
  assert.equal(insideFolder("/media/Anime/Delly/Season 01/a.mkv", "/media/Anime/Delly"), true);
  assert.equal(insideFolder("/media/Anime/Delly/../Other/a.mkv", "/media/Anime/Delly"), false);
  assert.equal(insideFolder("/media/Anime/Delly 2/a.mkv", "/media/Anime/Delly"), false);
  assert.equal(insideFolder("/media/Anime/Dellyx/a.mkv", "/media/Anime/Delly/"), false);
  assert.equal(insideFolder("/media/Anime/Delly", "/media/Anime/Delly"), false, "the folder itself is not a file in it");
  assert.equal(insideFolder("D:\\TV\\Delly\\S1\\a.mkv", "d:\\tv\\delly"), true);
  assert.equal(insideFolder("/a.mkv", ""), false);
  assert.equal(insideFolder("/a.mkv", "/"), false, "the root is never a show folder");
});
