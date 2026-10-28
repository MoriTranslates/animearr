/** Own metadata catalog: AniList entries with Anime-Lists mappings, franchises, episode titles. Mocked AniList. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-catalog-"));
process.env.ANIMEARR_CONFIG = dir;
process.env.ANIMEARR_NO_LOCK = "1";
fs.mkdirSync(path.join(dir, "cache"), { recursive: true });
fs.writeFileSync(
  path.join(dir, "cache", "anime-list-master.xml"),
  `<?xml version="1.0" encoding="utf-8"?><anime-list>
  <anime anidbid="100" tvdbid="5000" defaulttvdbseason="1" episodeoffset="" tmdbtv="77" tmdbseason="1" tmdboffset="" tmdbid="" imdbid=""><name>Show S1</name></anime>
  <anime anidbid="101" tvdbid="5000" defaulttvdbseason="2" episodeoffset="" tmdbtv="77" tmdbseason="2" tmdboffset="" tmdbid="" imdbid=""><name>Show S2</name></anime>
  <anime anidbid="102" tvdbid="movie" defaulttvdbseason="" episodeoffset="" tmdbtv="" tmdbseason="" tmdboffset="" tmdbid="999" imdbid=""><name>Show Movie</name></anime>
</anime-list>`,
);

const { cache, db } = await import("../server/db.js");
const { refreshCatalog, entriesForSeries, catalogEpisode, parseStreamingTitle } = await import("../server/catalog.js");
const { episodeRows } = await import("../server/episodes.js");
type M = import("../server/anilist.js").AniMedia;

const media = (id: number, title: string, format: string, rel: [number, string][], extra: Partial<M> = {}): M => ({
  id, idMal: null, title: { romaji: `${title} (romaji)`, english: title, native: "テスト" }, synonyms: [], format, status: "FINISHED", episodes: 12, duration: 24, season: null, seasonYear: 2020,
  startDate: { year: 2020, month: id - 1000, day: 1 }, endDate: { year: 2020, month: 12, day: 1 }, countryOfOrigin: "JP", coverImage: { large: null, color: null }, bannerImage: null, description: "<b>x</b>",
  genres: [], isAdult: false, relations: { edges: rel.map(([to, t]) => ({ relationType: t, node: { id: to, type: "ANIME", format: null } })) }, airingSchedule: { nodes: [] }, nextAiringEpisode: null, streamingEpisodes: [], ...extra,
});

before(() => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (1, 5000, 'Show', '/media/Anime/Show', 1, 0)").run();
  cache.prepare("INSERT INTO episodes (id, series_id, season, episode, title, monitored, has_file, air_utc) VALUES (1, 1, 2, 3, 'TBA', 1, 0, 0), (2, 1, 2, 4, 'Real Title', 1, 0, 0)").run();
});

test("streaming titles parse", () => {
  assert.deepEqual(parseStreamingTitle("Episode 3 - The Return"), [3, "The Return"]);
  assert.equal(parseStreamingTitle("Special: Behind the scenes"), null);
});

test("refresh: library entries via Anime-Lists + Fribb, one hop of relations, franchises, TBA titles filled", async () => {
  const fribb = async () => ({ at: 0, anidbToAnilist: new Map([[100, 1001], [101, 1002], [102, 1003]]), anilistToAnidb: new Map([[1001, 100], [1002, 101], [1003, 102]]), anilistToTmdb: new Map<number, number>() });
  const all: Record<number, M> = {
    1001: media(1001, "Show", "TV", [[1002, "SEQUEL"]]),
    1002: media(1002, "Show Season 2", "TV", [[1001, "PREQUEL"], [1003, "SEQUEL"], [4444, "CHARACTER"]], { streamingEpisodes: [{ title: "Episode 3 - The Third One" }], airingSchedule: { nodes: [{ episode: 3, airingAt: 1_700_000_000 }] }, trailer: { id: "abc_D-1", site: "youtube", thumbnail: "https://i.ytimg.com/vi/abc_D-1/hqdefault.jpg" } }),
    1003: media(1003, "Show: The Movie", "MOVIE", [[1002, "PREQUEL"]]),
  };
  const asked: number[][] = [];
  const r = await refreshCatalog({}, { fribb: fribb as never, media: async (ids: number[]) => (asked.push(ids), ids.map((i) => all[i]).filter(Boolean)) });
  assert.equal(r.fetched, 2, "the two library seasons first");
  await refreshCatalog({ force: true }, { fribb: fribb as never, media: async (ids: number[]) => ids.map((i) => all[i]).filter(Boolean) });
  const c = entriesForSeries(5000);
  assert.deepEqual(c.entries.map((e) => [e.anilistId, e.tvdbSeason]), [[1001, "1"], [1002, "2"]]);
  assert.deepEqual(c.related.map((e) => e.kind), ["MOVIE"], "the movie joined the franchise (one hop out)");
  assert.equal(c.franchise?.title, "Show");
  assert.deepEqual(c.entries.map((e) => e.trailer), [null, { site: "youtube", id: "abc_D-1", thumbnail: null }], "trailer kept as site + id only (no thumbnail stored)");
  assert.ok(!db.prepare("SELECT 1 FROM entries WHERE anilist_id = 4444").get(), "character relations aren't followed");
  assert.equal(catalogEpisode(5000, 2, 3, null)?.title, "The Third One");
  const rows = episodeRows(1);
  assert.equal(rows.find((x) => x.id === 1)!.title, "The Third One", "TBA replaced by the catalog title");
  assert.equal(rows.find((x) => x.id === 2)!.title, "Real Title");
});

test("only one hop out from the library: a chain never crawls further; entries leaving the library are pruned", async () => {
  const fribb = async () => ({ at: 0, anidbToAnilist: new Map([[100, 1001], [101, 1002]]), anilistToAnidb: new Map([[1001, 100], [1002, 101]]), anilistToTmdb: new Map<number, number>() });
  const all: Record<number, M> = {
    1001: media(1001, "Show", "TV", [[1002, "SEQUEL"]]),
    1002: media(1002, "Show Season 2", "TV", [[1001, "PREQUEL"], [1003, "SEQUEL"]]),
    1003: media(1003, "Show: The Movie", "MOVIE", [[1002, "PREQUEL"], [1004, "SEQUEL"]]),
    1004: media(1004, "Far Away Sequel", "TV", [[1003, "PREQUEL"], [1005, "SEQUEL"]]),
  };
  const asked = new Set<number>();
  const deps = { fribb: fribb as never, media: async (ids: number[]) => (ids.forEach((i) => asked.add(i)), ids.map((i) => all[i]).filter(Boolean)) };
  for (let i = 0; i < 3; i++) await refreshCatalog({ force: true }, deps);
  assert.ok(!asked.has(1004), "two hops out is never fetched");
  assert.ok(!db.prepare("SELECT 1 FROM entries WHERE anilist_id = 1004").get());
});
