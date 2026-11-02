/**
 * Delete a season's files (Show page ⋯ menu): the same guarded delete as one episode (Sonarr, its recycle bin, the
 * allowed roots), only that season's files, never a file outside the show's folder or one shared with another season,
 * and every file it couldn't delete is reported. Sonarr is mocked: nothing real is deleted.
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
type Deps = import("../server/library/episodes.js").EpisodeDeps;

const TVDB = 730001;
const SHOW = "/media/Anime/Delly";
const DAY = 86_400_000;
// episode id → [season, episode, file id]
const EPS: Record<number, [number, number, number | null]> = {
  8101: [1, 1, 98101],
  8102: [1, 2, 98102],
  8103: [1, 3, 98103], // a multi-episode file: S01E03 + S02E01
  8104: [1, 4, 98104], // Sonarr's record points outside the show's folder
  8105: [1, 5, 98105], // Sonarr refuses this delete
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

before(() => {
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Anime"] }));
  cache
    .prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, status, synced_at) VALUES (81, ?, 'Delly', ?, 1, 'ended', 0)")
    .run(TVDB, SHOW);
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, monitored, status, synced_at) VALUES (82, 730002, 'Empty', '/media/Anime/Empty', 1, 'ended', 0)",
    )
    .run();
  const ins = cache.prepare(
    "INSERT INTO episodes (id, series_id, season, episode, title, air_utc, monitored, has_file, file_id, runtime) VALUES (?, 81, ?, ?, 'x', ?, 1, ?, ?, 24)",
  );
  for (const [id, [season, n, fileId]] of Object.entries(EPS))
    ins.run(Number(id), season, n, Date.now() - 100 * DAY, fileId ? 1 : 0, fileId);
  cache
    .prepare(
      "INSERT INTO episodes (id, series_id, season, episode, title, air_utc, monitored, has_file, file_id, runtime) VALUES (8301, 82, 1, 1, 'x', 0, 1, 0, NULL, 24)",
    )
    .run();
});

function deps(deleted: number[]): Deps {
  return {
    episode: async (id) => ({
      id,
      seriesId: 81,
      seasonNumber: EPS[id][0],
      episodeNumber: EPS[id][1],
      monitored: true,
      hasFile: !!EPS[id][2],
      episodeFileId: EPS[id][2] ?? undefined,
    }),
    episodeFile: async (id) => ({ id, seriesId: 81, seasonNumber: 1, path: PATHS[id], size: 1, sceneName: null, quality: null }),
    deleteFile: async (id) => {
      if (id === 98105) throw new Error("Sonarr: HTTP 500");
      deleted.push(id);
    },
    refresh: async () => undefined,
    search: (async () => []) as unknown as Deps["search"],
    grab: (async () => ({})) as unknown as Deps["grab"],
  } as Deps;
}

test("only that season's own files are deleted; the rest is reported honestly, one reason each", async () => {
  const deleted: number[] = [];
  const r = await deleteSeasonFiles(TVDB, 1, deps(deleted));
  assert.deepEqual(deleted.sort(), [98101, 98102], "never season 2's file, never the shared or outside one");
  assert.equal(r.asked, 5, "the season's episodes with a file (S01E06 has none)");
  assert.deepEqual(
    r.deleted.map((d) => d.episodeId),
    [8101, 8102],
  );
  const why = new Map(r.skipped.map((s) => [s.episodeId, s.why]));
  assert.match(why.get(8103)!, /also holds S02E01/);
  assert.match(why.get(8104)!, /outside the show's folder/);
  assert.match(why.get(8105)!, /HTTP 500/, "Sonarr's failure is passed on, not swallowed");
  assert.equal(r.skipped.length, 3);
});

test("a season without files is refused; so is a show outside the allowed roots", async () => {
  await assert.rejects(deleteSeasonFiles(730002, 1, deps([])), /no files/);
  await assert.rejects(deleteSeasonFiles(TVDB, 7, deps([])), /no files/);
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Other"] }));
  try {
    await assert.rejects(deleteSeasonFiles(TVDB, 1, deps([])), /outside the allowed root folders/);
  } finally {
    patchSettings((s) => ({ ...s, allowedRoots: ["/media/Anime"] }));
  }
});

test("the one-episode delete (⋯ → Delete file) refuses a file outside the show's folder too", async () => {
  const deleted: number[] = [];
  const r = await deleteEpisodeFiles(TVDB, [8104], deps(deleted));
  assert.deepEqual(deleted, []);
  assert.match(r.skipped[0].why, /outside the show's folder/);
  // A multi-episode file deleted on its own is fine (it's what the user picked).
  const r2 = await deleteEpisodeFiles(TVDB, [8201], deps(deleted));
  assert.deepEqual(deleted, [98103]);
  assert.deepEqual(r2.deleted[0].episodes, ["S01E03", "S02E01"]);
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
