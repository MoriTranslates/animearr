/** Episode management with mocks: statuses, delete, re-grab, calendar. Nothing real is deleted or grabbed. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-eps-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { calendar, deleteEpisodeFiles, episodeRows, regrabEpisodes, seriesHeader } = await import("../server/episodes.js");
type Deps = import("../server/episodes.js").EpisodeDeps;

const TVDB = 600001;
const H = 3_600_000;
before(() => {
  const now = Date.now();
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, status, overview, synced_at) VALUES (5, ?, 'Pilot Show', '/media/AnimeArr/Pilot Show', 0, 'continuing', 'A show.', 0)").run(TVDB);
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, status, synced_at) VALUES (6, 600002, 'Main Library Show', '/media/Anime/Main Library Show', 1, 'continuing', 0)").run();
  const ep = cache.prepare("INSERT INTO episodes (id, series_id, season, episode, title, air_utc, monitored, has_file, file_id, runtime) VALUES (?, ?, 1, ?, ?, ?, 1, ?, ?, 24)");
  ep.run(501, 5, 1, "One", now - 72 * H, 1, 9001);
  ep.run(502, 5, 2, "Two", now - 24 * H, 0, null);
  ep.run(503, 5, 3, "Three", now + 48 * H, 0, null);
  ep.run(504, 5, 4, "Four", now - 2 * H, 0, null);
  ep.run(601, 6, 1, "Other", now - 24 * H, 1, 9101);
  cache.prepare("INSERT INTO files (id, series_id, season, path, size, quality, source, release_group, scene_name, audio_langs, sub_langs) VALUES (9001, 5, 1, '/media/AnimeArr/Pilot Show/Season 1/Pilot Show - S01E01.mkv', 1400000000, 'HDTV-1080p', 'television', 'SubsPlease', '[SubsPlease] Pilot Show - 01 (1080p) [ABCD1234]', 'ja', 'en')").run();
  // E04 is downloading.
  db.prepare("INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, state, dry_run, progress) VALUES (?, ?, ?, 5, '[504]', 'x', 'g', 'usenet', 'downloading', 0, 0.45)").run(now, now, TVDB);
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (?, 5, 'Pilot Show', 0, ?)").run(TVDB, now);
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/AnimeArr"], managed: { ...s.managed, dryRun: false } }));
});

function deps(calls: { deleted: number[]; searched: number[]; grabbed: string[] }): Deps {
  return {
    episode: async (id) => ({ id, seriesId: 5, seasonNumber: 1, episodeNumber: id - 500, monitored: true, hasFile: id === 501, episodeFileId: id === 501 ? 9001 : undefined }),
    episodeFile: async (id) => ({ id, seriesId: 5, seasonNumber: 1, path: "/media/AnimeArr/Pilot Show/Season 1/Pilot Show - S01E01.mkv", size: 1, sceneName: "[SubsPlease] Pilot Show - 01 (1080p) [ABCD1234]", quality: { quality: { name: "HDTV-1080p" } } }),
    deleteFile: async (id) => void calls.deleted.push(id),
    refresh: async () => undefined,
    search: (async (_tvdb: number, eps: number[]) => {
      calls.searched.push(...eps);
      const r = (title: string, accept = true) => ({ guid: title, title, indexer: "X", indexerId: 1, protocol: "usenet", size: 1e9, seeders: null, publishDate: null, ageHours: 1, episodeIds: eps, label: "S01E01", confidence: 95, coversTarget: true, extra: 0, rank: { accept, score: 100, langProb: 0.97, lang: "en", langSource: "", flags: [], why: "ok", reject: null }, mappingWhy: [], group: null });
      return { results: [r("[SubsPlease] Pilot Show - 01 (1080p) [ABCD1234]"), r("[Erai-raws] Pilot Show - 01 [1080p][Multiple Subtitle]")] };
    }) as unknown as Deps["search"],
    grab: (async (req: { candidate: { title: string } }) => {
      calls.grabbed.push(req.candidate.title);
      return { id: 1, dryRun: false, message: "Sent to sabnzbd" };
    }) as unknown as Deps["grab"],
  };
}

test("episode statuses: have / missing / downloading (with progress) / unaired; AnimeArr's source label (WEB for SubsPlease)", () => {
  const rows = episodeRows(5);
  const by = new Map(rows.map((r) => [r.episode, r]));
  assert.equal(by.get(1)!.status, "have");
  assert.equal(by.get(1)!.file!.source, "WEB", "Sonarr says HDTV, AnimeArr knows SubsPlease is a web rip");
  assert.deepEqual(by.get(1)!.file!.subs, ["en"]);
  assert.equal(by.get(2)!.status, "missing");
  assert.equal(by.get(3)!.status, "unaired");
  assert.equal(by.get(4)!.status, "downloading");
  assert.equal(by.get(4)!.progress, 0.45);
  assert.equal(rows[0].season, 1);
  assert.deepEqual(rows.map((r) => r.episode), [4, 3, 2, 1], "newest first");
});

test("series header: counts, next airing, language health", () => {
  const h = seriesHeader(TVDB)!;
  assert.equal(h.counts.have, 1);
  assert.equal(h.counts.missing, 1);
  assert.equal(h.counts.downloading, 1);
  assert.equal(h.nextEpisode?.episode, 3);
  assert.equal(h.language.lang, "en");
  assert.equal(h.language.withLang, 1);
  assert.equal(h.language.have, 1);
  assert.equal(h.profile.watchMode, "sub");
  assert.equal(h.overview, "A show.");
});

test("delete: guarded by allowed roots; deletes through Sonarr; asks to search again for a managed live show", async () => {
  const calls = { deleted: [] as number[], searched: [] as number[], grabbed: [] as string[] };
  await assert.rejects(deleteEpisodeFiles(600002, [601], deps(calls)), /outside the allowed root folders/);
  const r = await deleteEpisodeFiles(TVDB, [501, 502, 601], deps(calls));
  assert.deepEqual(calls.deleted, [9001]);
  assert.deepEqual(r.deleted.map((d) => d.episodeId), [501]);
  assert.deepEqual(r.skipped.map((d) => d.why), ["no file", "not an episode of this show"]);
  assert.equal(r.askSearch, true);
});

test("re-grab: blocklists the current release and grabs the next best one", async () => {
  const calls = { deleted: [] as number[], searched: [] as number[], grabbed: [] as string[] };
  const r = await regrabEpisodes(TVDB, [501], deps(calls));
  assert.deepEqual(calls.grabbed, ["[Erai-raws] Pilot Show - 01 [1080p][Multiple Subtitle]"]);
  assert.ok(db.prepare("SELECT 1 FROM blocklist WHERE release = ?").get("[SubsPlease] Pilot Show - 01 (1080p) [ABCD1234]"));
  assert.equal(r[0].outcome, "Sent to sabnzbd");
  const undo = db.prepare("SELECT undo FROM decisions WHERE why LIKE 'Re-grab: blocklisted%' ORDER BY id DESC").get() as { undo: string };
  assert.match(undo.undo, /unblock/);
});

test("calendar: range and managed filter", () => {
  const now = Date.now();
  const all = calendar(now - 7 * 24 * H, now + 14 * 24 * H, false);
  assert.ok(all.some((e) => e.tvdbId === 600002));
  const managed = calendar(now - 7 * 24 * H, now + 14 * 24 * H, true);
  assert.ok(managed.every((e) => e.tvdbId === TVDB));
  assert.deepEqual(managed.map((e) => e.status), ["have", "missing", "downloading", "unaired"]);
});

test("re-grab never blocklists in dry-run, or when nothing else was found", async () => {
  const before = (db.prepare("SELECT COUNT(*) n FROM blocklist").get() as { n: number }).n;
  const calls = { deleted: [] as number[], searched: [] as number[], grabbed: [] as string[] };
  const dry = deps(calls);
  dry.grab = (async () => ({ id: 2, dryRun: true, message: "would grab" })) as unknown as Deps["grab"];
  await regrabEpisodes(TVDB, [501], dry);
  const none = deps(calls);
  none.search = (async () => ({ results: [] })) as unknown as Deps["search"];
  const r = await regrabEpisodes(TVDB, [501], none);
  assert.match(r[0].outcome, /nothing else acceptable/);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM blocklist").get() as { n: number }).n, before);
});

test("delete re-checks Sonarr live: a stale cache can't delete another series' file", async () => {
  const calls = { deleted: [] as number[], searched: [] as number[], grabbed: [] as string[] };
  const d = deps(calls);
  d.episode = async (id) => ({ id, seriesId: 999, seasonNumber: 1, episodeNumber: 1, monitored: true, hasFile: true, episodeFileId: 9001 });
  const r = await deleteEpisodeFiles(TVDB, [501], d);
  assert.deepEqual(calls.deleted, []);
  assert.match(r.skipped[0].why, /another series/);
});

test("re-grab is capped at 10 episodes per request", async () => {
  const calls = { deleted: [] as number[], searched: [] as number[], grabbed: [] as string[] };
  await assert.rejects(regrabEpisodes(TVDB, Array.from({ length: 11 }, (_, i) => 501 + i), deps(calls)), /at most 10/);
});
