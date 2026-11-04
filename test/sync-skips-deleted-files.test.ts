/**
 * Sonarr's file list is only a backup record and lags behind AnimeArr's own delete: until Sonarr rescans, it still
 * lists a file AnimeArr moved to its bin. The sync (refreshSeriesEpisodes) must not mark that episode "have" again.
 * A Sonarr-listed file that isn't on disk is never accepted for a managed show; one that exists still is.
 *
 * Failure modes, one test each: deleted then synced with Sonarr still listing it, a real file, a never-there file
 * (while a neighbour exists), an unmounted/empty folder (can't tell: kept), an unmanaged show (untouched).
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-syncskip-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
fs.mkdirSync(path.join(process.env.ANIMEARR_CONFIG, "cache"), { recursive: true });
fs.writeFileSync(path.join(process.env.ANIMEARR_CONFIG, "cache", "anime-list-master.xml"), "<anime-list></anime-list>");

const { setAccount, patchSettings } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { cache, db } = await import("../server/system/db.js");
const { refreshSeriesEpisodes } = await import("../server/library/library.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-syncskip-lib-"));
const LIB = path.join(tmp, "Anime");
const write = (p: string, body = "x") => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, body));

const SID = 31;
const TVDB = 9201;
const SHOW = "/media/Anime/Sync Show";
const F1 = `${SHOW}/Season 01/Sync Show - S01E01.mkv`;
const F2 = `${SHOW}/Season 01/Sync Show - S01E02.mkv`;
const local = (arr: string) => path.join(tmp, ...arr.slice("/media/".length).split("/"));

// What Sonarr (the mock) answers: both episodes have files, whatever AnimeArr did meanwhile.
let sonarrCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: string | URL) => {
  const url = new URL(String(u));
  if (url.hostname !== "sonarr.test") return realFetch(u);
  sonarrCalls.push(url.pathname);
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  if (url.pathname.endsWith("/episodefile"))
    return json(
      [
        [3301, F1],
        [3302, F2],
      ].map(([id, p]) => ({ id, seriesId: SID, seasonNumber: 1, path: p, size: 5, dateAdded: "2026-01-01T00:00:00Z" })),
    );
  if (url.pathname.endsWith("/episode"))
    return json(
      [1, 2].map((n) => ({
        id: 3200 + n,
        seriesId: SID,
        seasonNumber: 1,
        episodeNumber: n,
        monitored: true,
        hasFile: true,
        episodeFileId: 3300 + n,
      })),
    );
  return json([]);
}) as typeof fetch;
after(() => void (globalThis.fetch = realFetch));

function seed(managed = true) {
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, root_folder, monitored, series_type, synced_at) VALUES (?, ?, 'Sync Show', ?, '/media/Anime', 1, 'anime', 0)",
    )
    .run(SID, TVDB, SHOW);
  if (managed) db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (?, ?, 'Sync Show', 0, 0)").run(TVDB, SID);
}
const have = (id: number) => (cache.prepare("SELECT has_file FROM episodes WHERE id = ?").get(id) as { has_file: number } | undefined)?.has_file;
const fileRow = (id: number) => !!cache.prepare("SELECT 1 FROM files WHERE id = ?").get(id);

beforeEach(() => {
  for (const d of [LIB, path.join(tmp, "Recycle")]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(LIB, { recursive: true });
  for (const t of ["recycle_log", "managed"]) db.prepare(`DELETE FROM ${t}`).run();
  for (const t of ["series", "episodes", "files"]) cache.prepare(`DELETE FROM ${t}`).run();
  sonarrCalls = [];
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/Anime"],
    localPathMappings: [
      { from: "/media/Anime", to: LIB },
      { from: "/media", to: tmp },
    ],
    sonarr: { url: "http://sonarr.test", apiKey: "k", animeTag: "" },
  }));
});

test("delete an episode in AnimeArr, then sync while Sonarr still lists the file: it stays missing", async () => {
  seed();
  write(local(F1), "video");
  write(local(F2), "video");
  await refreshSeriesEpisodes(SID);
  assert.equal(have(3201), 1);
  // AnimeArr's own delete: the file leaves the library for the bin (the bin's own move is tested elsewhere).
  const bin = path.join(tmp, "Recycle", "Sync Show - S01E01.mkv");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.renameSync(local(F1), bin);
  const { recordBinned: rec } = await import("../server/library/episodeBin.js");
  rec({ seriesId: SID, fileId: 3301, fileArr: F1, outcome: { kind: "gone" }, binLocal: path.join(tmp, "Recycle") });
  assert.equal(have(3201), 0);
  sonarrCalls = [];
  await refreshSeriesEpisodes(SID); // Sonarr's mock still says both files exist
  assert.equal(have(3201), 0, "still missing after the sync");
  assert.equal(fileRow(3301), false, "no file row for it");
  assert.equal(have(3202), 1, "the neighbour is still had");
});

test("a file that really exists is accepted as before", async () => {
  seed();
  write(local(F1), "video");
  write(local(F2), "video");
  await refreshSeriesEpisodes(SID);
  assert.equal(have(3201), 1);
  assert.equal(have(3202), 1);
  assert.equal(fileRow(3301), true);
  assert.equal((cache.prepare("SELECT file_id FROM episodes WHERE id = 3201").get() as { file_id: number }).file_id, 3301);
});

test("a Sonarr-listed file missing on disk isn't marked present (its neighbour in the same folder is)", async () => {
  seed();
  write(local(F2), "video"); // F1 was never there
  await refreshSeriesEpisodes(SID);
  assert.equal(have(3201), 0);
  assert.equal(fileRow(3301), false);
  assert.equal(have(3202), 1);
});

test("can't tell (the show's folder is an unmounted, empty share): Sonarr's answer is kept, never read as gone", async () => {
  seed();
  // LIB exists but is empty: an empty mount point. Nothing is surely gone.
  await refreshSeriesEpisodes(SID);
  assert.equal(have(3201), 1);
  assert.equal(have(3202), 1);
});

test("a show AnimeArr doesn't manage keeps Sonarr's answer untouched", async () => {
  seed(false);
  write(local(F2), "video");
  await refreshSeriesEpisodes(SID);
  assert.equal(have(3201), 1);
  assert.equal(fileRow(3301), true);
});
