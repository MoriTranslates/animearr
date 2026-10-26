/** Cutover: plan, adopt (AnimeArr only), gated removal from Sonarr, and AnimeArr's copy taking over with exact file links. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { cutoverPlan, adoptShows, removeFromArrs } = await import("../server/cutover.js");
const { materializeAll, NATIVE_BASE } = await import("../server/native.js");

const fribb = async () => ({ mtime: 0, anidbToAnilist: new Map<number, number>(), anilistToAnidb: new Map<number, number>(), anilistToAnidbAll: new Map<number, number[]>(), anilistToTmdb: new Map<number, number>() });
const none = async () => [];

before(() => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, year, path, root_folder, monitored, series_type, synced_at) VALUES (7, 555, 'Show', 2020, '/media/Anime/Show', '/media/Anime', 1, 'anime', 0)").run();
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, series_type, synced_at) VALUES (8, 666, 'Unknown', '/media/Anime/Unknown', 1, 'anime', 0)").run();
  for (let e = 1; e <= 3; e++) cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, file_id) VALUES (?, 7, 1, ?, 1, ?, ?)").run(700 + e, e, e < 3 ? 1 : 0, e < 3 ? 70 + e : null);
  cache.prepare("INSERT INTO files (id, series_id, season, path) VALUES (71, 7, 1, '/media/Anime/Show/Season 1/weird name one.mkv')").run();
  cache.prepare("INSERT INTO files (id, series_id, season, path) VALUES (72, 7, 1, '/media/Anime/Show/Season 1/weird name two.mkv')").run();
  db.prepare("INSERT INTO entries (anilist_id, tvdb_id, tvdb_season, tvdb_offset, kind, title_english, synonyms, status, start_date, episodes, fetched_at) VALUES (900, 555, '1', 0, 'TV', 'Show', '[]', 'FINISHED', '2020-01-01', 3, 1)").run();
  for (const p of ["/media/Anime/Show/Season 1/weird name one.mkv", "/media/Anime/Show/Season 1/weird name two.mkv"]) db.prepare("INSERT INTO media_files (path, root, size, mtime, seen_at) VALUES (?, '/media/Anime', 5, 1, 1)").run(p);
});

test("plan: ready vs blocked; adopt changes nothing visible while Sonarr has the show", async () => {
  const p = await cutoverPlan({ sonarrLists: none, sonarrNotifications: none, radarrLists: none, fribb } as never);
  const show = p.shows.find((s) => s.tvdbId === 555)!;
  assert.deepEqual(show.blockers, []);
  assert.equal(show.filesCovered, 2);
  assert.match(p.shows.find((s) => s.tvdbId === 666)!.blockers[0], /no AniList entry/);
  const r = adoptShows([555, 666]);
  assert.equal(r[0].ok, true);
  assert.equal(r[1].ok, false);
  materializeAll();
  assert.equal((cache.prepare("SELECT COUNT(*) AS n FROM series WHERE tvdb_id = 555").get() as { n: number }).n, 1, "only Sonarr's copy while Sonarr has it");
});

test("removal from Sonarr is gated; afterwards AnimeArr's copy takes over with exact file links", async () => {
  const removed: number[] = [];
  const deps = { removeSeries: async (id: number) => void removed.push(id), removeMovie: async () => undefined };
  await assert.rejects(removeFromArrs({ tvdbIds: [555] }, deps), /isn't switched on/);
  patchSettings((s) => ({ ...s, cutover: { allowArrWrites: true } }));
  const out = await removeFromArrs({ tvdbIds: [555, 666] }, deps);
  assert.deepEqual(removed, [7]);
  assert.equal(out.find((o) => o.id === 666)?.ok, false, "never removes a show AnimeArr didn't adopt");
  // The next Sonarr sync drops its copy:
  for (const t of ["series WHERE id", "episodes WHERE series_id", "files WHERE series_id"]) cache.prepare(`DELETE FROM ${t} = 7`).run();
  materializeAll();
  const s = cache.prepare("SELECT id FROM series WHERE tvdb_id = 555").get() as { id: number };
  assert.ok(s.id >= NATIVE_BASE);
  const eps = cache.prepare("SELECT episode, has_file FROM episodes WHERE series_id = ? ORDER BY episode").all(s.id) as { episode: number; has_file: number }[];
  assert.deepEqual(eps.map((e) => e.has_file), [1, 1, 0], "files with odd names are known from the adoption's links");
});
