/** Franchise links: Anime-Lists (with S0 episodes), title fallback, manual corrections, and the S0 double-download guard. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-franchise-"));
process.env.ANIMEARR_CONFIG = dir;
process.env.ANIMEARR_NO_LOCK = "1";
fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
fs.writeFileSync(
  path.join(dir, "cache", "anime-list-master.xml"),
  `<?xml version="1.0" encoding="utf-8"?><anime-list>
  <anime anidbid="2369" tvdbid="74796" defaulttvdbseason="a" episodeoffset="" tmdbtv="30984" tmdbseason="1" tmdboffset="" tmdbid="" imdbid=""><name>Bleach</name></anime>
  <anime anidbid="4515" tvdbid="74796" defaulttvdbseason="0" episodeoffset="2" tmdbtv="" tmdbseason="" tmdboffset="" tmdbid="15575" imdbid="tt1105263"><name>Gekijouban Bleach: Memories of Nobody</name>
    <mapping-list><mapping anidbseason="0" tvdbseason="0">;1-0;</mapping><mapping anidbseason="1" tvdbseason="0">;2-3;3-3;4-3;</mapping></mapping-list></anime>
  <anime anidbid="5352" tvdbid="74796" defaulttvdbseason="0" episodeoffset="" tmdbtv="" tmdbseason="" tmdboffset="" tmdbid="17101" imdbid=""><name>Gekijouban Bleach: The DiamondDust Rebellion</name>
    <mapping-list><mapping anidbseason="1" tvdbseason="0">;1-4;</mapping></mapping-list></anime>
</anime-list>`,
);

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { moviesForSeries, seriesForMovie, movieSpecials, setLink, refuseMovieSpecials } = await import("../server/franchise.js");
const { episodeRows } = await import("../server/episodes.js");

before(() => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (716, 74796, 'Bleach', '/media/Anime/Bleach', 1, 0), (717, 80000, 'Hell Girl', '/media/Anime/Hell Girl', 1, 0)").run();
  for (const [id, ep, title] of [[9001, 1, "Recap"], [9003, 3, "Memories of Nobody"], [9004, 4, "The DiamondDust Rebellion"], [9006, 6, "Hell Verse"]] as const)
    cache.prepare("INSERT INTO episodes (id, series_id, season, episode, title, monitored, has_file, runtime) VALUES (?, 716, 0, ?, ?, 0, 0, 90)").run(id, ep, title);
  const ins = cache.prepare("INSERT INTO movies (id, tmdb_id, title, year, path, monitored, has_file, is_anime, synced_at) VALUES (?, ?, ?, ?, ?, 1, ?, 1, 0)");
  ins.run(1, 15575, "Bleach: Memories of Nobody", 2006, "/media/Movies/Anime/x", 1);
  ins.run(2, 17101, "Bleach: The DiamondDust Rebellion", 2007, "/media/Movies/Anime/y", 0);
  ins.run(3, 73245, "Bleach: Hell Verse", 2010, "/media/Movies/Anime/z", 0);
  ins.run(4, 5, "Bleachers United", 2015, "/media/Movies/Anime/w", 0);
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Anime", "/media/Movies/Anime"] }));
});

test("Bleach: Anime-Lists links two movies with their S0 episodes; the title fallback adds Hell Verse (not 'Bleachers')", () => {
  const ms = moviesForSeries(74796);
  assert.deepEqual(ms.map((m) => [m.movieId, m.source, m.s0Episode]), [[1, "anime-lists", 3], [2, "anime-lists", 4], [3, "title", null]]);
  assert.deepEqual(seriesForMovie(3).map((s) => s.tvdbId), [74796]);
  assert.deepEqual(seriesForMovie(4), []);
});

test("S0 specials that are movies are flagged and never grabbed as episodes", () => {
  const flagged = movieSpecials(716);
  assert.deepEqual([...flagged.keys()].sort(), [9003, 9004, 9006]);
  assert.equal(episodeRows(716).find((r) => r.id === 9003)!.movie!.title, "Bleach: Memories of Nobody");
  assert.equal(episodeRows(716).find((r) => r.id === 9001)!.movie, null);
  assert.throws(() => refuseMovieSpecials(716, [9004]), /handled by Radarr/);
  assert.doesNotThrow(() => refuseMovieSpecials(716, [9001]));
});

test("manual corrections win: unlink a wrong match, link one by hand", () => {
  setLink(74796, 3, false);
  assert.ok(!moviesForSeries(74796).some((m) => m.movieId === 3));
  setLink(80000, 4, true);
  assert.deepEqual(moviesForSeries(80000).map((m) => [m.movieId, m.source]), [[4, "manual"]]);
  assert.ok(db.prepare("SELECT 1 FROM franchise_links WHERE tvdb_id = 80000 AND movie_id = 4 AND action = 'link'").get());
});
