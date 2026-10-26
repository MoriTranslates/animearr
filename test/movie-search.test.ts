/** Movie search: release watching, budget, backoff, Radarr already downloading, follow-ups; movie dual upgrades. Mocks only. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-moviesearch-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { moviePass, planMovies } = await import("../server/movieSearch.js");
const { setMoviePrefs } = await import("../server/profiles.js");
const { upgradePass, moviePlaceholders } = await import("../server/upgrade.js");
type SR = Awaited<ReturnType<typeof import("../server/movies.js").searchMovie>>["results"][number];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();
const st = (id: number) => db.prepare("SELECT state, next_at, attempts, last_why FROM movie_search WHERE movie_id = ?").get(id) as { state: string; next_at: number; attempts: number; last_why: string } | undefined;

before(() => {
  const ins = cache.prepare("INSERT INTO movies (id, tmdb_id, title, year, path, monitored, has_file, is_anime, synced_at, is_available, digital_release, file) VALUES (?, ?, ?, 2024, ?, ?, ?, 1, 0, ?, ?, ?)");
  ins.run(1, 11, "Released Movie", "/media/Movies/Anime/a", 1, 0, 1, now - 10 * DAY, null);
  ins.run(2, 12, "Future Movie", "/media/Movies/Anime/b", 1, 0, 0, now + 5 * DAY, null);
  ins.run(3, 13, "Unmonitored Movie", "/media/Movies/Anime/c", 0, 0, 1, now - 10 * DAY, null);
  ins.run(4, 14, "Outside Movie", "/media/Movies/Other/d", 1, 0, 1, now - 10 * DAY, null);
  ins.run(5, 15, "Have Movie", "/media/Movies/Anime/e", 1, 1, 1, now - 10 * DAY, JSON.stringify({ path: "/m/e.mkv", sceneName: null, releaseGroup: null, quality: null, audio: ["ja"], subs: ["en"], runTime: null, resolution: "1920x1080" }));
  ins.run(6, 16, "Radarr Has It", "/media/Movies/Anime/f", 1, 0, 1, now - 10 * DAY, null);
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Movies/Anime"], managed: { ...s.managed, dryRun: false }, movieSearch: { enabled: true, delayHours: 6, perHour: 2, retryDays: 7 } }));
});

const res = (title: string, over: Partial<SR> = {}) =>
  ({ guid: `g-${title}`, title, indexer: "X", indexerId: 1, protocol: "usenet", size: 6e9, seeders: null, publishDate: null, ageHours: 1, episodeIds: [], label: "", confidence: 95, rank: { accept: true, score: 100, langProb: 0.95, lang: "en", langSource: "", flags: [], why: "ok", reject: null }, mappingWhy: [], group: null, downloadUrl: "http://x", ...over }) as SR;

test("plan: released + wanted → waiting; future → unreleased; unmonitored, outside roots and owned ones are left out", () => {
  planMovies(now);
  assert.equal(st(1)!.state, "waiting");
  assert.equal(st(2)!.state, "unreleased");
  assert.ok(st(2)!.next_at >= now + 5 * DAY + 6 * HOUR - 1000, "release + delay");
  for (const id of [3, 4, 5]) assert.equal(st(id), undefined);
});

test("pass: grabs within the budget, skips what Radarr is downloading, backs off when nothing is found", async () => {
  const grabbed: number[] = [];
  const deps = {
    search: (async (id: number) => ({ results: id === 1 ? [res("Released Movie 2024 1080p")] : [], matched: 0, found: 3 })) as never,
    grab: (async (r: { movieId: number }) => (grabbed.push(r.movieId), { id: 77, dryRun: false, message: "Sent to sabnzbd" })) as never,
    radarrQueue: async (id: number) => (id === 6 ? [{ id: 1 }] : []),
  };
  const r = await moviePass(deps, now);
  assert.equal(r.searched, 1, "movie 6 skipped (Radarr has it), movie 1 searched; movie 2 isn't due");
  assert.deepEqual(grabbed, [1]);
  assert.equal(st(1)!.state, "grabbed");
  assert.match(st(6)!.last_why, /Radarr is downloading/);
  // The grab fails → searching again in an hour; nothing acceptable → backoff.
  db.prepare("INSERT INTO grabs (id, at, updated_at, episode_ids, release, guid, protocol, state, dry_run, movie_id) VALUES (77, 0, 0, '[]', 'x', 'g', 'usenet', 'failed', 0, 1)").run();
  const none = { ...deps, search: (async () => ({ results: [], matched: 0, found: 2 })) as never, radarrQueue: async () => [] };
  await moviePass(none, now + 2 * HOUR);
  assert.equal(st(1)!.state, "retry", "the failed grab is searched again an hour later");
  await moviePass(none, now + 4 * HOUR);
  assert.equal(st(1)!.attempts, 2);
  assert.ok(st(1)!.next_at >= now + 4 * HOUR + 12 * HOUR - 1000, "second attempt waits 12 h");
});

test("dual upgrades for movies: a Dual-mode movie with a sub-only file is a placeholder; log mode reports", async () => {
  setMoviePrefs(5, null, "dual");
  assert.deepEqual(moviePlaceholders().map((m) => m.movieId), [5]);
  patchSettings((s) => ({ ...s, dualUpgrade: { mode: "log", perHour: 4, recheckDays: 3, maxAgeDays: 365 } }));
  const r = await upgradePass({ search: (async () => ({ results: [] })) as never, grab: (async () => ({})) as never, searchMovie: (async () => ({ results: [res("Have Movie 2024 1080p Dual Audio", { rank: { accept: true, score: 120, langProb: 0.95, lang: "en", langSource: "", flags: [{ key: "dual", label: "Dual", tone: "info" }], why: "dual", reject: null } })], matched: 1 })) as never, grabMovie: (async () => { throw new Error("log mode must not grab"); }) as never }, now);
  assert.equal(r.found, 1);
  assert.equal((db.prepare("SELECT state FROM movie_upgrade WHERE movie_id = 5").get() as { state: string }).state, "found");
});
