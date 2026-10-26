/** Cutover: plan, adopt (AnimeArr only), the gated switch, state moving to AnimeArr's ids, exact file links. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { cutoverPlan, adoptShows, switchToAnimeArr } = await import("../server/cutover.js");
const { materializeAll, NATIVE_BASE } = await import("../server/native.js");

const fribb = async () => ({ mtime: 0, anidbToAnilist: new Map<number, number>(), anilistToAnidb: new Map<number, number>(), anilistToAnidbAll: new Map<number, number[]>(), anilistToTmdb: new Map<number, number>() });
const none = async () => [];

before(() => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, year, path, root_folder, monitored, series_type, synced_at) VALUES (7, 555, 'Show', 2020, '/media/Anime/Show', '/media/Anime', 1, 'anime', 0)").run();
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, series_type, synced_at) VALUES (8, 666, 'Unknown', '/media/Anime/Unknown', 1, 'anime', 0)").run();
  for (let e = 1; e <= 3; e++) cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, file_id) VALUES (?, 7, 1, ?, 1, ?, ?)").run(700 + e, e, e < 3 ? 1 : 0, e < 3 ? 70 + e : null);
  cache.prepare("INSERT INTO files (id, series_id, season, path, scene_name, release_group, quality) VALUES (71, 7, 1, '/media/Anime/Show/Season 1/weird name one.mkv', 'Show.S01E01.1080p.WEB-GRP', 'GRP', 'WEBDL-1080p')").run();
  cache.prepare("INSERT INTO files (id, series_id, season, path) VALUES (72, 7, 1, '/media/Anime/Show/Season 1/weird name two.mkv')").run();
  db.prepare("INSERT INTO entries (anilist_id, tvdb_id, tvdb_season, tvdb_offset, kind, title_english, synonyms, status, start_date, episodes, fetched_at) VALUES (900, 555, '1', 0, 'TV', 'Show', '[]', 'FINISHED', '2020-01-01', 3, 1)").run();
  db.prepare("INSERT INTO media_files (path, root, size, mtime, seen_at) VALUES ('/media/Anime/Show/Season 1/weird name one.mkv', '/media/Anime', 5, 1, 1)").run();
  // AnimeArr state keyed by Sonarr's ids:
  db.prepare("INSERT INTO search_state (episode_id, tvdb_id, next_at, state, attempts) VALUES (703, 555, 1, 'retry', 4)").run();
  db.prepare("INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, state, dry_run) VALUES (1, 1, 555, 7, '[701]', 'Show.S01E01', 'g', 'usenet', 'done', 0)").run();
});

test("plan: a file AnimeArr hasn't scanned blocks; ready after the scan; adopt changes nothing visible", async () => {
  let p = await cutoverPlan({ sonarrLists: none, sonarrNotifications: none, radarrLists: none, fribb } as never);
  assert.match(p.shows.find((s) => s.tvdbId === 555)!.blockers.join(" "), /aren't in AnimeArr's own file records/);
  db.prepare("INSERT INTO media_files (path, root, size, mtime, seen_at) VALUES ('/media/Anime/Show/Season 1/weird name two.mkv', '/media/Anime', 5, 1, 1)").run();
  p = await cutoverPlan({ sonarrLists: none, sonarrNotifications: none, radarrLists: none, fribb } as never);
  assert.deepEqual(p.shows.find((s) => s.tvdbId === 555)!.blockers, []);
  assert.match(p.shows.find((s) => s.tvdbId === 666)!.blockers[0], /no AniList entry/);
  assert.equal(adoptShows([555])[0].ok, true);
  materializeAll();
  assert.equal((cache.prepare("SELECT COUNT(*) AS n FROM series WHERE tvdb_id = 555").get() as { n: number }).n, 1, "only Sonarr's copy while Sonarr has it");
});

test("the switch: gated; refused while downloading; moves state to AnimeArr's ids; AnimeArr's copy is live at once", async () => {
  const removed: number[] = [];
  const deps = { removeSeries: async (id: number) => void removed.push(id), removeMovie: async () => undefined, sonarrQueue: async () => [], radarrQueue: async () => [] };
  patchSettings((s) => ({ ...s, importer: { ...s.importer, allowReal: false } }));
  await assert.rejects(switchToAnimeArr({ tvdbIds: [555] }, deps as never), /isn't switched on/);
  patchSettings((s) => ({ ...s, cutover: { allowArrWrites: true } }));
  await assert.rejects(switchToAnimeArr({ tvdbIds: [555] }, deps as never), /own importer/);
  patchSettings((s) => ({ ...s, importer: { ...s.importer, engine: "animearr", allowReal: true } }));
  const busy = await switchToAnimeArr({ tvdbIds: [555] }, { ...deps, sonarrQueue: async () => [{ id: 1, seriesId: 7, title: "x", status: "downloading" }] } as never);
  assert.match(busy[0].why, /Sonarr is still downloading/);
  const out = await switchToAnimeArr({ tvdbIds: [555, 666] }, deps as never);
  assert.deepEqual(removed, [7]);
  assert.equal(out.find((o) => o.id === 666)?.ok, false, "never removes a show AnimeArr didn't adopt");
  const s = cache.prepare("SELECT id FROM series WHERE tvdb_id = 555").get() as { id: number };
  assert.ok(s.id >= NATIVE_BASE, "AnimeArr's copy is live without waiting for a sync");
  const eps = cache.prepare("SELECT id, episode, has_file FROM episodes WHERE series_id = ? ORDER BY episode").all(s.id) as { id: number; episode: number; has_file: number }[];
  assert.deepEqual(eps.map((e) => e.has_file), [1, 1, 0], "odd file names are known from the links");
  const st = db.prepare("SELECT episode_id, attempts FROM search_state WHERE tvdb_id = 555").get() as { episode_id: number; attempts: number };
  assert.equal(st.episode_id, eps[2].id, "the schedule row moved to AnimeArr's episode id");
  assert.equal(st.attempts, 4);
  assert.equal((db.prepare("SELECT episode_ids FROM grabs WHERE tvdb_id = 555").get() as { episode_ids: string }).episode_ids, JSON.stringify([eps[0].id]), "grab history follows");
  assert.equal((cache.prepare("SELECT scene_name FROM files WHERE path LIKE '%one.mkv'").get() as { scene_name: string }).scene_name, "Show.S01E01.1080p.WEB-GRP", "release info kept");
});

test("resolving: a user's AniList pick unblocks a show; specials can be confirmed", async () => {
  const { matchShow, ackSpecials, showCut } = await import("../server/cutover.js");
  cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, file_id) VALUES (801, 8, 1, 1, 1, 0, NULL)").run();
  db.prepare("INSERT INTO entries (anilist_id, kind, title_english, synonyms, status, start_date, episodes, fetched_at) VALUES (950, 'TV', 'Unknown', '[]', 'FINISHED', '2019-01-01', 1, 1)").run();
  const cut = await matchShow(666, 950, 1, 0, { media: async () => [], fribb } as never);
  assert.deepEqual(cut.blockers, []);
  const row = cache.prepare("SELECT id, tvdb_id, title, path FROM series WHERE tvdb_id = 666").get() as never;
  cache.prepare("INSERT INTO files (id, series_id, season, path) VALUES (81, 8, 0, '/media/Anime/Unknown/Specials/sp.mkv')").run();
  cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, file_id) VALUES (802, 8, 0, 1, 1, 1, 81)").run();
  db.prepare("INSERT INTO media_files (path, root, size, mtime, seen_at) VALUES ('/media/Anime/Unknown/Specials/sp.mkv', '/media/Anime', 5, 1, 1)").run();
  assert.match(showCut(row).blockers.join(" "), /special/);
  ackSpecials(666, true);
  assert.deepEqual(showCut(row).blockers, []);
});
