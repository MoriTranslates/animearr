/** Sonarr v3-compatible API for dashboard and mobile clients (nzb360, LunaSea, Homepage): shapes and behaviour. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-sonarrmore-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings, setAccount, regenerateApiKey } = await import("../server/settings.js");
const { guard } = await import("../server/auth.js");
const { registerSonarrApi } = await import("../server/sonarrApi.js");
type SearchResult = import("../server/search.js").SearchResult;

const LIB = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-sonarrmore-lib-"));
const queueItems: unknown[] = [];
const removed: { id: number; blocklist: boolean; searchNext: boolean }[] = [];
const grabbed: { tvdbId: number; episodeIds: number[]; guid: string; origin: string }[] = [];
const commandsRun: string[] = [];
const searches: number[][] = [];
const DAY = 86_400_000;
const now = Date.now();

const result = (guid: string, ok: boolean): SearchResult =>
  ({
    guid, title: `[Grp] Dock Tales - 0${ok ? 2 : 3} (1080p) [ABCD1234].mkv`, indexer: "TestIndexer", indexerId: 7, protocol: "torrent", size: 1_400_000_000, seeders: 12, publishDate: new Date(now - 5 * 3_600_000).toISOString(), ageHours: 5,
    episodeIds: [4202], label: "S01E02", confidence: 0.9, coversTarget: ok, extra: 0,
    rank: { accept: ok, score: 42.4, langProb: 0.9, lang: "en", langSource: "x", flags: [{ key: "k", label: "Hardcoded subs", tone: ok ? "good" : "bad" }], why: "97% English", reject: ok ? null : "Blocked by your release rule 'No batch'" },
    mappingWhy: [], group: "Grp", downloadUrl: "https://secret.example/dl?apikey=SECRET",
  }) as unknown as SearchResult;
const found = [result("guid-ok", true), result("guid-bad", false)];

const app = Fastify();
await app.register(fastifyCookie);
app.addHook("onRequest", guard);
registerSonarrApi(app, {
  urlBase: "",
  deps: {
    queue: async () => ({ items: queueItems }) as never,
    searchMissing: () => ({ searching: 0 }),
    searchEpisodes: async (_t, eps) => (searches.push(eps), { results: [] }),
    deepSearch: (async () => ({ results: found })) as never,
    startGrab: (async (req: { tvdbId: number; episodeIds: number[]; candidate: { guid: string }; origin: string }) => (grabbed.push({ tvdbId: req.tvdbId, episodeIds: req.episodeIds, guid: req.candidate.guid, origin: req.origin }), { id: 1, dryRun: true, message: "would grab" })) as never,
    removeGrab: (async (id: number, o: { blocklist: boolean; searchNext: boolean }) => (removed.push({ id, ...o }), null)) as never,
    rescan: async () => (commandsRun.push("rescan"), undefined),
    rssSync: async () => (commandsRun.push("rss"), undefined),
    backup: () => (commandsRun.push("backup"), "manual-test.db"),
  },
});
let KEY = "";
const call = async (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => {
  const r = await app.inject({ method, url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: r.statusCode, body: r.body && r.headers["content-type"]?.toString().includes("json") ? JSON.parse(r.body) : null };
};
const iso = (ms: number) => new Date(ms).toISOString();

before(async () => {
  await setAccount("owner", "owners-own-password");
  KEY = regenerateApiKey();
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Anime"], localPathMappings: [{ from: "/media/Anime", to: LIB }] }));
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, root_folder, monitored, status, poster, synced_at) VALUES (42, 888, 'Dock Tales', '/media/Anime/Dock Tales', '/media/Anime', 1, 'continuing', 'https://img.example/p.jpg', 0)").run();
  const ins = cache.prepare("INSERT INTO episodes (id, series_id, season, episode, title, air_utc, runtime, monitored, has_file, file_id) VALUES (?, 42, 1, ?, ?, ?, 24, 1, ?, ?)");
  ins.run(4201, 1, "Arrival", now - 20 * DAY, 1, 11);
  ins.run(4202, 2, "Fog", now - 10 * DAY, 0, null);
  ins.run(4203, 3, "Storm", now + 1 * DAY, 0, null);
  cache.prepare("INSERT INTO files (id, series_id, season, path, size, quality, source, release_group, scene_name, audio_langs, sub_langs, run_time, resolution, date_added, revision) VALUES (11, 42, 1, '/media/Anime/Dock Tales/Season 1/Dock Tales - S01E01.mkv', 300000000, 'WEBDL-720p', 'web', 'Grp', '[Grp] Dock Tales - 01 (720p) [ABCD1234]', 'ja', 'en', '23:40', '1280x720', ?, '{\"version\":1,\"real\":0,\"isRepack\":false}')").run(iso(now - 19 * DAY));
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since, unmonitored_in_sonarr) VALUES (888, 42, 'Dock Tales', 0, 0, 0)").run();
  const g = db.prepare("INSERT INTO grabs (id, at, updated_at, tvdb_id, series_id, episode_ids, release, guid, indexer_id, protocol, client, client_ref, state, dry_run, indexer) VALUES (?, ?, ?, 888, 42, ?, ?, 'g', 7, 'torrent', 'qbittorrent', ?, ?, ?, 'TestIndexer')");
  g.run(9, now - 2 * 3_600_000, now - 60_000, "[4202,4203]", "[Grp] Dock Tales - 02-03", "abc123", "downloading", 0);
  g.run(10, now - 20 * DAY, now - 19 * DAY, "[4201]", "[Grp] Dock Tales - 01 (720p)", "def456", "done", 0);
  g.run(11, now - 5 * DAY, now - 5 * DAY + 1000, "[4202]", "[Bad] Dock Tales - 02", "ghi789", "failed", 0);
  g.run(12, now - 1 * DAY, now - 1 * DAY, "[4202]", "[Dry] Dock Tales - 02", "dry", "done", 1);
  queueItems.push({ id: 9, tvdbId: 888, movieId: null, episodeIds: [4202, 4203], release: "[Grp] Dock Tales - 02-03", protocol: "torrent", clientName: "qBittorrent", state: "downloading", progress: 0.25, error: null, live: { state: "downloading", progress: 0.5, etaSec: 600, sizeBytes: 2000 } });
});

test("health and disk space: arrays in Sonarr's shape", async () => {
  const h = await call("GET", "/api/v3/health");
  assert.equal(h.status, 200);
  assert.ok(Array.isArray(h.body));
  const disks = (await call("GET", "/api/v3/diskspace")).body as { path: string; label: string; freeSpace: number; totalSpace: number }[];
  assert.ok(disks.length >= 1);
  assert.equal(disks[0].path, "/media/Anime");
  assert.equal(typeof disks[0].label, "string");
  assert.ok(disks[0].totalSpace > 0 && disks[0].freeSpace >= 0);
});

test("series: statistics, images with urls, seasons statistics, the fields dashboards read", async () => {
  const s = (await call("GET", "/api/v3/series/42")).body;
  assert.equal(s.statistics.episodeFileCount, 1);
  assert.equal(s.statistics.episodeCount, 2, "aired episodes");
  assert.equal(s.statistics.totalEpisodeCount, 3);
  assert.equal(typeof s.statistics.sizeOnDisk, "number");
  assert.equal(typeof s.statistics.percentOfEpisodes, "number");
  assert.equal(s.images[0].remoteUrl, "https://img.example/p.jpg");
  assert.equal(s.images[0].url, "https://img.example/p.jpg");
  assert.equal(s.seasons[0].statistics.totalEpisodeCount, 3);
  for (const k of ["alternateTitles", "originalLanguage", "tmdbId", "folder", "rootFolderPath", "qualityProfileId", "seriesType", "ratings"]) assert.ok(k in s, k);
});

test("calendar: episodes in the window, series and file nested on request", async () => {
  const r = (await call("GET", `/api/v3/calendar?start=${iso(now - 30 * DAY)}&end=${iso(now + 2 * DAY)}&unmonitored=true&includeSeries=true&includeEpisodeFile=true`)).body as Record<string, unknown>[];
  assert.deepEqual(r.map((e) => e.id), [4201, 4202, 4203]);
  assert.equal((r[0].series as { title: string }).title, "Dock Tales");
  assert.equal((r[0].episodeFile as { id: number }).id, 11);
  assert.equal(r[1].episodeFile, undefined);
  assert.equal(typeof r[0].airDateUtc, "string");
  const narrow = (await call("GET", `/api/v3/calendar?start=${iso(now)}&end=${iso(now + 2 * DAY)}`)).body as { id: number }[];
  assert.deepEqual(narrow.map((e) => e.id), [4203], "only what airs inside the window");
});

test("queue: paging, sorting, details, status", async () => {
  const q = (await call("GET", "/api/v3/queue?page=1&pageSize=1&sortKey=timeleft&includeSeries=true&includeEpisode=true")).body;
  assert.equal(q.totalRecords, 2);
  assert.equal(q.records.length, 1);
  assert.equal(q.page, 1);
  const r = q.records[0];
  for (const [k, t] of [["id", "number"], ["seriesId", "number"], ["episodeId", "number"], ["size", "number"], ["sizeleft", "number"], ["timeleft", "string"], ["estimatedCompletionTime", "string"], ["status", "string"], ["trackedDownloadStatus", "string"], ["trackedDownloadState", "string"], ["protocol", "string"], ["downloadClient", "string"], ["indexer", "string"], ["title", "string"]] as const) assert.equal(typeof r[k], t, k);
  assert.equal(r.indexer, "TestIndexer");
  assert.equal(r.quality.quality.name, "Unknown", "the release name states no resolution");
  assert.ok(Array.isArray(r.languages) && Array.isArray(r.customFormats));
  assert.equal(r.series.id, 42);
  assert.equal(r.episode.id, 4202);
  assert.equal((await call("GET", "/api/v3/queue?page=2&pageSize=1&sortKey=timeleft")).body.records[0].episodeId, 4203);
  assert.equal((await call("GET", "/api/v3/queue/details?seriesId=42")).body.length, 2);
  assert.equal((await call("GET", "/api/v3/queue/details?episodeIds=4203")).body.length, 1);
  assert.deepEqual((await call("GET", "/api/v3/queue/status")).body, { totalCount: 2, count: 2, unknownCount: 0, errors: false, warnings: false, unknownErrors: false, unknownWarnings: false });
});

test("queue delete: removes the grab, blocklist and skipRedownload map to AnimeArr's options; bulk dedupes", async () => {
  assert.equal((await call("DELETE", "/api/v3/queue/9001?removeFromClient=true&blocklist=true&skipRedownload=true")).status, 200);
  assert.deepEqual(removed.pop(), { id: 9, blocklist: true, searchNext: false });
  await call("DELETE", "/api/v3/queue/9000?blocklist=true");
  assert.deepEqual(removed.pop(), { id: 9, blocklist: true, searchNext: true }, "like Sonarr: blocklisting searches again unless told not to");
  await call("DELETE", "/api/v3/queue/9000");
  assert.deepEqual(removed.pop(), { id: 9, blocklist: false, searchNext: false });
  assert.equal((await call("DELETE", "/api/v3/queue/bulk?removeFromClient=true", { ids: [9000, 9001] })).status, 200);
  assert.deepEqual(removed, [{ id: 9, blocklist: false, searchNext: false }], "both records are one download");
  assert.equal((await call("DELETE", "/api/v3/queue/abc")).status, 400);
});

test("history: grabs, imports and failures as Sonarr events, paged, filtered; dry runs left out", async () => {
  db.prepare("INSERT INTO decisions (at, kind, tvdb_id, title, episode_ids, release, why, detail) VALUES (?, 'info', 888, 'Dock Tales', '[4201]', NULL, 'Deleted the S01E01 file', '{\"kind\":\"delete\",\"fileId\":11,\"path\":\"/media/Anime/Dock Tales/x.mkv\"}')").run(now - 1000);
  const h = (await call("GET", "/api/v3/history?page=1&pageSize=50&sortKey=date&sortDirection=descending&includeSeries=true&includeEpisode=true")).body;
  const types = h.records.map((r: { eventType: string }) => r.eventType);
  assert.equal(h.totalRecords, 7, "per episode: 2 + 1 + 1 grabbed, 1 imported, 1 failed, 1 deleted");
  for (const t of ["grabbed", "downloadFolderImported", "downloadFailed", "episodeFileDeleted"]) assert.ok(types.includes(t), t);
  assert.equal(types[0], "episodeFileDeleted", "newest first");
  const r = h.records.find((x: { eventType: string }) => x.eventType === "downloadFailed");
  for (const [k, t] of [["id", "number"], ["episodeId", "number"], ["seriesId", "number"], ["sourceTitle", "string"], ["date", "string"], ["eventType", "string"], ["data", "object"], ["quality", "object"]] as const) assert.equal(typeof r[k], t, k);
  assert.equal(r.series.title, "Dock Tales");
  assert.equal(r.episode.id, 4202);
  assert.ok(!h.records.some((x: { sourceTitle: string }) => x.sourceTitle.startsWith("[Dry]")));
  assert.equal(new Set(h.records.map((x: { id: number }) => x.id)).size, h.records.length, "ids are unique");
  assert.equal((await call("GET", "/api/v3/history?pageSize=2&page=2")).body.records.length, 2);
  const imported = (await call("GET", "/api/v3/history?eventType=3&pageSize=10")).body;
  assert.deepEqual(imported.records.map((x: { eventType: string }) => x.eventType), ["downloadFolderImported"]);
  assert.equal((await call("GET", "/api/v3/history/series?seriesId=42&eventType=4")).body.length, 1);
  assert.equal((await call("GET", "/api/v3/history/series?seriesId=999")).body.length, 0);
  assert.equal((await call("GET", `/api/v3/history/since?date=${iso(now - 10 * DAY)}`)).body.length, 5);
});

test("wanted: missing (aired, no file) and cutoff unmet (file below the quality goal)", async () => {
  const m = (await call("GET", "/api/v3/wanted/missing?page=1&pageSize=10&sortKey=episodes.airDateUtc&sortDirection=descending&includeSeries=true")).body;
  assert.equal(m.totalRecords, 1, "the unaired episode isn't missing");
  assert.equal(m.records[0].id, 4202);
  assert.equal(m.records[0].series.id, 42);
  assert.equal(m.page, 1);
  assert.equal(typeof m.pageSize, "number");
  const c = (await call("GET", "/api/v3/wanted/cutoff?includeEpisodeFile=true")).body;
  assert.equal(c.totalRecords, 1, "the 720p WEB file is below the 'Aim high' goal");
  assert.equal(c.records[0].id, 4201);
  assert.equal(c.records[0].episodeFile.quality.quality.name, "WEBDL-720p");
});

test("episode files: list, get, media info; delete is refused", async () => {
  const l = (await call("GET", "/api/v3/episodefile?seriesId=42")).body;
  assert.equal(l.length, 1);
  const f = l[0];
  assert.equal(f.relativePath, "Season 1/Dock Tales - S01E01.mkv");
  assert.equal(f.size, 300000000);
  assert.equal(f.quality.quality.id, 5);
  assert.equal(f.mediaInfo.audioLanguages, "jpn");
  assert.equal(f.mediaInfo.subtitles, "eng");
  assert.equal(f.mediaInfo.runTime, "23:40");
  assert.equal(f.releaseGroup, "Grp");
  assert.equal((await call("GET", "/api/v3/episodefile/11")).body.id, 11);
  assert.equal((await call("GET", "/api/v3/episodefile/99")).status, 404);
  assert.equal((await call("DELETE", "/api/v3/episodefile/11")).status, 405);
  assert.ok(cache.prepare("SELECT 1 FROM files WHERE id = 11").get(), "nothing was deleted");
});

test("release search and grab: rejections in plain words, download url never exposed, grab through the normal path", async () => {
  const r = (await call("GET", "/api/v3/release?episodeId=4202")).body as Record<string, unknown>[];
  assert.equal(r.length, 2);
  const ok = r.find((x) => x.guid === "guid-ok")!;
  const bad = r.find((x) => x.guid === "guid-bad")!;
  for (const [k, t] of [["guid", "string"], ["title", "string"], ["size", "number"], ["indexer", "string"], ["indexerId", "number"], ["protocol", "string"], ["approved", "boolean"], ["rejected", "boolean"], ["downloadAllowed", "boolean"], ["ageHours", "number"], ["publishDate", "string"], ["customFormatScore", "number"], ["seeders", "number"], ["quality", "object"], ["languages", "object"], ["rejections", "object"], ["mappedEpisodeNumbers", "object"]] as const) assert.equal(typeof ok[k], t, k);
  assert.equal(ok.approved, true);
  assert.deepEqual(ok.rejections, []);
  assert.equal(bad.rejected, true);
  assert.ok((bad.rejections as string[]).includes("Blocked by your release rule 'No batch'"));
  assert.ok(!JSON.stringify(r).includes("SECRET"));
  assert.deepEqual(ok.mappedEpisodeNumbers, [2]);
  assert.equal((await call("GET", "/api/v3/release")).status, 400);
  const g = await call("POST", "/api/v3/release", { guid: "guid-ok", indexerId: 7 });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.deepEqual(grabbed, [{ tvdbId: 888, episodeIds: [4202], guid: "guid-ok", origin: "manual" }]);
  assert.equal((await call("POST", "/api/v3/release", { guid: "never-searched", indexerId: 7 })).status, 404);
});

test("commands: season search, rescan, rss sync, backup; polling shows them finish; unknown ones are refused", async () => {
  searches.length = 0;
  const c = await call("POST", "/api/v3/command", { name: "SeasonSearch", seriesId: 42, seasonNumber: 1 });
  assert.equal(c.status, 201);
  assert.deepEqual(searches, [[4202]], "the aired missing episodes of the season");
  await new Promise((r) => setTimeout(r, 20));
  const polled = (await call("GET", `/api/v3/command/${c.body.id}`)).body;
  assert.equal(polled.status, "completed");
  for (const k of ["id", "name", "commandName", "status", "queued", "trigger", "priority", "body"]) assert.ok(k in polled, k);
  for (const body of [{ name: "RescanSeries", seriesId: 42 }, { name: "RssSync" }, { name: "Backup" }, { name: "RefreshSeries", seriesId: 42 }, { name: "RenameSeries", seriesIds: [42] }]) assert.equal((await call("POST", "/api/v3/command", body)).status, 201, body.name);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([...commandsRun].sort(), ["backup", "rescan", "rss"]);
  assert.ok((await call("GET", "/api/v3/command")).body.length >= 6);
  assert.equal((await call("POST", "/api/v3/command", { name: "Frobnicate" })).status, 400);
  assert.equal((await call("GET", "/api/v3/command/9999")).status, 404);
});

test("languages and quality definitions: what clients ask for on connect", async () => {
  const l = (await call("GET", "/api/v3/language")).body as { id: number; name: string }[];
  assert.ok(l.some((x) => x.id === 1 && x.name === "English") && l.some((x) => x.id === 8 && x.name === "Japanese"));
  assert.ok((await call("GET", "/api/v3/languageprofile")).body[0].languages.length > 1);
  const d = (await call("GET", "/api/v3/qualitydefinition")).body as { quality: { name: string }; title: string; minSize: number }[];
  assert.ok(d.some((x) => x.quality.name === "Bluray-1080p") && typeof d[0].minSize === "number");
  assert.equal((await call("GET", "/api/v3/mediacover/42/poster-500.jpg")).status, 302);
});
