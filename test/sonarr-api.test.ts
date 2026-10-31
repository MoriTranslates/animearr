/** Sonarr v3-compatible API for request apps: auth, profiles/roots/tags, lookup, add, monitoring, delete safety, queue. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-sonarrapi-"));
process.env.ANIMEARR_NO_LOCK = "1";
// Anime-Lists: AniDB 5001/5002 are TVDB 777 seasons 1 and 2.
fs.mkdirSync(path.join(process.env.ANIMEARR_CONFIG, "cache"), { recursive: true });
fs.writeFileSync(
  path.join(process.env.ANIMEARR_CONFIG, "cache", "anime-list-master.xml"),
  `<anime-list><anime anidbid="5001" tvdbid="777" defaulttvdbseason="1" episodeoffset=""><name>Harbor Tales</name></anime><anime anidbid="5002" tvdbid="777" defaulttvdbseason="2" episodeoffset=""><name>Harbor Tales 2</name></anime></anime-list>`,
);

const { cache, db } = await import("../server/db.js");
const { patchSettings, setAccount, regenerateApiKey } = await import("../server/settings.js");
const { guard } = await import("../server/auth.js");
const { registerSonarrApi } = await import("../server/sonarrApi.js");
const { NATIVE_BASE } = await import("../server/native.js");
const { scopeFor } = await import("../server/scope.js");
const { saveProfile } = await import("../server/profiles.js");
type AniMedia = import("../server/anilist.js").AniMedia;

const media = (id: number): AniMedia => ({
  id, idMal: null, title: { romaji: id === 601 ? "Minato Monogatari" : "Minato Monogatari 2", english: id === 601 ? "Harbor Tales" : "Harbor Tales 2", native: null }, synonyms: [], format: "TV", status: "FINISHED", episodes: 2, duration: 24,
  season: null, seasonYear: id === 601 ? 2020 : 2022, startDate: { year: id === 601 ? 2020 : 2022, month: 1, day: 1 }, endDate: { year: id === 601 ? 2020 : 2022, month: 1, day: 8 }, countryOfOrigin: "JP", coverImage: { large: "https://img.example/cover.jpg", color: null },
  bannerImage: null, description: "", genres: [], isAdult: false, relations: { edges: [] }, airingSchedule: { nodes: [{ episode: 1, airingAt: (id === 601 ? 1577836800 : 1640995200) }, { episode: 2, airingAt: (id === 601 ? 1578441600 : 1641600000) }] },
  nextAiringEpisode: null, streamingEpisodes: [],
});
const fribb = async () => ({ mtime: 0, anidbToAnilist: new Map([[5001, 601], [5002, 602]]), anilistToAnidb: new Map([[601, 5001], [602, 5002]]), anilistToAnidbAll: new Map<number, number[]>(), anilistToTmdb: new Map<number, number>() });
const LIB = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-sonarrapi-lib-"));
const searched: number[] = [];
const queueItems: unknown[] = [];

const app = Fastify();
await app.register(fastifyCookie);
app.addHook("onRequest", guard);
registerSonarrApi(app, {
  urlBase: "/animearr",
  deps: {
    media: async (ids) => ids.map(media),
    fribb,
    searchMissing: (tvdbId) => (searched.push(tvdbId), { searching: 1 }),
    searchEpisodes: async () => ({ results: [] }),
    searchTitles: async () => ({ results: [], anilist: "ok" as const }),
    queue: async () => ({ items: queueItems }) as never,
  },
});
let KEY = "";
const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

before(async () => {
  await setAccount("owner", "owners-own-password");
  KEY = regenerateApiKey();
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Anime"], localPathMappings: [{ from: "/media/Anime", to: LIB }] }));
});

test("auth: the API key as a header or ?apikey=, nothing without it; Sonarr 4 on the wire with the URL base", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/api/v3/system/status" })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: "/api/v3/system/status?apikey=wrong" })).statusCode, 401);
  const q = await app.inject({ method: "GET", url: `/api/v3/system/status?apikey=${KEY}` });
  assert.equal(q.statusCode, 200);
  const st = JSON.parse(q.body);
  assert.equal(st.version.split(".")[0], "4", "request apps skip language profiles for Sonarr 4");
  assert.equal(st.urlBase, "/animearr");
  assert.equal((await call("GET", "/api/v3/system/status")).status, 200);
});

test("profiles keep their numeric ids; root folders and tags", async () => {
  const a = (await call("GET", "/api/v3/qualityprofile")).body;
  assert.equal(a.length, 1);
  saveProfile(null, { name: "Dub fans", watchMode: "dub" });
  const b = (await call("GET", "/api/v3/qualityprofile")).body as { id: number; name: string }[];
  assert.equal(b.length, 2);
  assert.equal(b.find((p) => p.name === a[0].name)?.id, a[0].id, "adding a profile doesn't renumber the others");
  assert.notEqual(b[0].id, b[1].id);
  const roots = (await call("GET", "/api/v3/rootfolder")).body;
  assert.deepEqual(roots.map((r: { path: string }) => r.path), ["/media/Anime"]);
  assert.ok(roots[0].id > 0);
  const t = await call("POST", "/api/v3/tag", { label: "Requested " });
  assert.equal(t.status, 201);
  assert.equal(t.body.label, "requested");
  assert.equal((await call("POST", "/api/v3/tag", { label: "requested" })).body.id, t.body.id, "the same label is the same tag");
  assert.equal((await call("GET", "/api/v3/tag")).body.length, 1);
});

test("lookup by TVDB id: an anime not in the library comes back without an id, with its Anime-Lists seasons", async () => {
  const r = (await call("GET", "/api/v3/series/lookup?term=tvdb:777")).body;
  assert.equal(r.length, 1);
  assert.equal(r[0].id, undefined);
  assert.equal(r[0].tvdbId, 777);
  assert.equal(r[0].seriesType, "anime");
  assert.deepEqual(r[0].seasons.map((s: { seasonNumber: number }) => s.seasonNumber), [1, 2]);
  assert.deepEqual((await call("GET", "/api/v3/series/lookup?term=tvdb:123456")).body, [], "not anime as far as the mappings know");
});

test("add (what Jellyseerr sends): a native show, managed, only the requested season monitored, search started", async () => {
  const profiles = (await call("GET", "/api/v3/qualityprofile")).body as { id: number; name: string }[];
  const dub = profiles.find((p) => p.name === "Dub fans")!;
  const tag = (await call("GET", "/api/v3/tag")).body[0];
  const r = await call("POST", "/api/v3/series", {
    tvdbId: 777, title: "Harbor Tales", qualityProfileId: dub.id, seasons: [{ seasonNumber: 1, monitored: false }, { seasonNumber: 2, monitored: true }], tags: [tag.id], seasonFolder: true,
    monitored: true, rootFolderPath: "/media/Anime", seriesType: "anime", addOptions: { ignoreEpisodesWithFiles: true, searchForMissingEpisodes: true },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.id >= NATIVE_BASE);
  assert.equal(r.body.tvdbId, 777);
  assert.equal(r.body.monitored, true);
  assert.equal(r.body.qualityProfileId, dub.id);
  assert.deepEqual(r.body.tags, [tag.id]);
  assert.deepEqual(r.body.seasons.map((s: { seasonNumber: number; monitored: boolean }) => [s.seasonNumber, s.monitored]), [[1, false], [2, true]]);
  assert.equal(r.body.seasons[1].statistics.totalEpisodeCount, 2);
  assert.equal(r.body.seasons[1].statistics.episodeFileCount, 0);
  const sc = scopeFor(777);
  assert.equal(sc.seasons, "picked");
  assert.deepEqual(sc.picked, [2]);
  assert.deepEqual(searched, [777]);
  assert.ok(db.prepare("SELECT 1 FROM managed WHERE tvdb_id = 777").get());
  // Now it's in the library: lookup has the id, the list filters by TVDB id, a second add is refused.
  assert.equal((await call("GET", "/api/v3/series/lookup?term=tvdb:777")).body[0].id, r.body.id);
  assert.equal((await call("GET", "/api/v3/series?tvdbId=777")).body.length, 1);
  assert.equal((await call("POST", "/api/v3/series", { tvdbId: 777, rootFolderPath: "/media/Anime" })).status, 400);
  assert.equal((await call("POST", "/api/v3/series", { tvdbId: 123456, rootFolderPath: "/media/Anime" })).status, 404);
});

test("monitoring: PUT series picks seasons; episode/monitor works per season", async () => {
  const s = (await call("GET", "/api/v3/series?tvdbId=777")).body[0];
  const put = await call("PUT", "/api/v3/series", { ...s, seasons: s.seasons.map((x: object) => ({ ...x, monitored: true })) });
  assert.equal(put.status, 202);
  assert.deepEqual(scopeFor(777).picked, [1, 2]);
  const eps = (await call("GET", `/api/v3/episode?seriesId=${s.id}`)).body as { id: number; seasonNumber: number; monitored: boolean }[];
  assert.equal(eps.length, 4);
  assert.ok(eps.every((e) => e.monitored));
  const s1 = eps.filter((e) => e.seasonNumber === 1).map((e) => e.id);
  await call("PUT", "/api/v3/episode/monitor", { episodeIds: [s1[0]], monitored: false });
  assert.deepEqual(scopeFor(777).picked, [1, 2], "one episode off doesn't drop its season");
  await call("PUT", "/api/v3/episode/monitor", { episodeIds: s1, monitored: false });
  assert.deepEqual(scopeFor(777).picked, [2]);
  await call("PUT", "/api/v3/episode/monitor", { episodeIds: [s1[1]], monitored: true });
  assert.deepEqual(scopeFor(777).picked, [1, 2]);
});

test("commands: missing-episode search runs AnimeArr's search; unknown commands are refused", async () => {
  const s = (await call("GET", "/api/v3/series?tvdbId=777")).body[0];
  searched.length = 0;
  const c = await call("POST", "/api/v3/command", { name: "MissingEpisodeSearch", seriesId: s.id });
  assert.equal(c.status, 201);
  assert.deepEqual(searched, [777]);
  assert.equal((await call("GET", `/api/v3/command/${c.body.id}`)).body.name, "MissingEpisodeSearch");
  assert.equal((await call("POST", "/api/v3/command", { name: "RescanSeries", seriesId: s.id })).status, 201);
  assert.equal((await call("POST", "/api/v3/command", { name: "Backup" })).status, 400);
});

test("queue: one record per episode with the fields request apps read", async () => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, root_folder, monitored, synced_at) VALUES (42, 888, 'Sonarr Show', '/media/Anime/Sonarr Show', '/media/Anime', 1, 0)").run();
  cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file) VALUES (4201, 42, 1, 1, 1, 0), (4202, 42, 1, 2, 1, 0)").run();
  db.prepare("INSERT INTO grabs (id, at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, client, client_ref, state, dry_run) VALUES (9, 1, 1, 888, 42, '[4201,4202]', '[Grp] Sonarr Show - 01-02', 'g', 'torrent', 'qbittorrent', 'abc123', 'downloading', 0)").run();
  queueItems.push({ id: 9, tvdbId: 888, movieId: null, episodeIds: [4201, 4202], release: "[Grp] Sonarr Show - 01-02", protocol: "torrent", clientName: "qBittorrent", state: "downloading", progress: 0.25, error: null, live: { state: "downloading", progress: 0.5, etaSec: 3725, sizeBytes: 1000 } });
  const q = (await call("GET", "/api/v3/queue?includeEpisode=true")).body;
  assert.equal(q.totalRecords, 2);
  const r = q.records[0];
  assert.equal(r.seriesId, 42);
  assert.equal(r.episodeId, 4201);
  assert.equal(r.size, 1000);
  assert.equal(r.sizeleft, 500);
  assert.equal(r.timeleft, "01:02:05");
  assert.equal(r.status, "downloading");
  assert.equal(r.trackedDownloadStatus, "ok");
  assert.equal(r.downloadId, "abc123");
  assert.equal(r.protocol, "torrent");
  assert.equal(r.episode.episodeNumber, 1);
  assert.ok(r.estimatedCompletionTime);
  assert.equal((await call("GET", "/api/v3/queue?page=2&pageSize=1")).body.records[0].episodeId, 4202);
});

test("delete: a native show leaves AnimeArr but its files stay; a Sonarr-owned show is refused", async () => {
  const s = (await call("GET", "/api/v3/series?tvdbId=777")).body[0];
  const folder = path.join(LIB, path.basename(s.path));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, "Harbor Tales - S01E01.mkv");
  fs.writeFileSync(file, "x");
  const d = await call("DELETE", `/api/v3/series/${s.id}?deleteFiles=true&addImportExclusion=false`);
  assert.equal(d.status, 200);
  assert.ok(fs.existsSync(file), "deleteFiles is ignored: files are never deleted through this API");
  assert.equal((await call("GET", "/api/v3/series?tvdbId=777")).body.length, 0);
  assert.equal((await call("DELETE", "/api/v3/series/42?deleteFiles=true")).status, 409);
  assert.equal((await call("GET", "/api/v3/series/42")).status, 200, "Sonarr's show is still there");
});
