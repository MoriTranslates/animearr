/**
 * A short episode list from Sonarr (review 2026-11-02, H11): Sonarr's own series statistics say how many episodes each
 * season has, so a list with fewer is a half answer. It keeps the cached episodes (and the managed searches for them)
 * and is re-read on the next sync. A real removal (the statistics drop too) still applies, and a search closed because
 * an episode left Sonarr reopens when the episode comes back.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-episode-gap-"));
process.env.ANIMEARR_NO_LOCK = "1";
fs.mkdirSync(path.join(process.env.ANIMEARR_CONFIG, "cache"), { recursive: true });
fs.writeFileSync(path.join(process.env.ANIMEARR_CONFIG, "cache", "anime-list-master.xml"), "<anime-list></anime-list>");

const { cache, db } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { syncLibrary, refreshSeriesEpisodes } = await import("../server/library/library.js");
const { planSchedule, planBacklog } = await import("../server/library/managed.js");
const { setScope, validateScope } = await import("../server/library/scope.js");

const DAY = 86_400_000;
const now = Date.now();

type Mode = "ok" | "short" | "otherSeason" | "badItem" | "500";
let mode: Mode = "ok";
/** Episodes Sonarr really has, per season, and whether /series carries statistics. */
let real: Record<number, number> = { 1: 3, 2: 1 };
let withStats = true;

const series = () => ({
  id: 1,
  tvdbId: 1001,
  title: "Show",
  status: "continuing",
  seriesType: "anime",
  path: "/tv/Show",
  monitored: true,
  qualityProfileId: 1,
  tags: [],
  seasons: Object.entries(real).map(([s, n]) => ({
    seasonNumber: Number(s),
    monitored: true,
    ...(withStats ? { statistics: { episodeFileCount: 0, episodeCount: n, totalEpisodeCount: n } } : {}),
  })),
});
const episode = (season: number, n: number) => ({
  id: season * 100 + n,
  seriesId: 1,
  seasonNumber: season,
  episodeNumber: n,
  airDateUtc: new Date(now - (season === 2 ? 1 : 3) * DAY).toISOString(),
  monitored: true,
  hasFile: false,
  episodeFileId: 0,
});
const allEpisodes = () => Object.entries(real).flatMap(([s, n]) => Array.from({ length: n }, (_, i) => episode(Number(s), i + 1)));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const realFetch = globalThis.fetch;
before(() => {
  patchSettings((s) => ({ ...s, sonarr: { url: "http://sonarr.test", apiKey: "k", animeTag: "" } }));
  globalThis.fetch = (async (u: string | URL) => {
    const url = new URL(String(u));
    if (url.pathname.endsWith("/series")) return json([series()]);
    if (url.pathname.endsWith("/episodefile")) return json([]);
    if (url.pathname.endsWith("/episode")) {
      const eps = allEpisodes();
      if (mode === "500") return json({ message: "boom" }, 500);
      if (mode === "short") return json(eps.filter((e) => e.id !== 103)); // S01E03 missing
      if (mode === "otherSeason") return json(eps.filter((e) => e.seasonNumber !== 2)); // a whole season missing
      if (mode === "badItem") return json([...eps.slice(0, 2), { seasonNumber: 1 }]);
      return json(eps);
    }
    throw new Error(`unexpected ${url.pathname}`);
  }) as typeof fetch;
});
after(() => void (globalThis.fetch = realFetch));

const cachedIds = () =>
  (cache.prepare("SELECT id FROM episodes WHERE series_id = 1 ORDER BY id").all() as { id: number }[]).map((r) => r.id);
const search = (id: number) =>
  db.prepare("SELECT state, last_why FROM search_state WHERE episode_id = ?").get(id) as { state: string; last_why: string } | undefined;

test("a good read fills the cache and the managed show gets its searches", async () => {
  const r = await syncLibrary(true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(cachedIds(), [101, 102, 103, 201]);
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (1001, 1, 'Show', 1, 0)").run();
  setScope([1001], validateScope({ seasons: "all", episodes: "all" }));
  planSchedule(now);
  for (const id of [101, 102, 103, 201]) assert.equal(search(id)?.state, "waiting", `episode ${id} scheduled`);
});

for (const m of ["short", "otherSeason", "badItem", "500"] as const)
  test(`episode list ${m}: the cached episodes and their searches stay, and the sync reports it`, async () => {
    mode = m;
    const r = await syncLibrary(true);
    assert.ok(r.errors.length, `errors reported for ${m}`);
    assert.deepEqual(cachedIds(), [101, 102, 103, 201]);
    planBacklog(now);
    planSchedule(now);
    for (const id of [101, 102, 103, 201]) assert.equal(search(id)?.state, "waiting", `episode ${id} still searched`);
    mode = "ok";
  });

test("the refresh after an import checks against the statistics from the last sync", async () => {
  mode = "short";
  await assert.rejects(refreshSeriesEpisodes(1), /Sonarr/);
  assert.deepEqual(cachedIds(), [101, 102, 103, 201]);
  mode = "ok";
});

test("without statistics a shorter list can't be told from a half answer: the cached episodes stay", async () => {
  withStats = false;
  mode = "short";
  const r = await syncLibrary(true);
  assert.ok(r.errors.length);
  assert.deepEqual(cachedIds(), [101, 102, 103, 201]);
  mode = "ok";
  const ok = await syncLibrary(true);
  assert.deepEqual(ok.errors, [], "a list as long as the cached one still applies");
  withStats = true;
});

test("a real removal (Sonarr's statistics drop too) applies and closes the search; it reopens when the episode comes back", async () => {
  real = { 1: 2, 2: 1 };
  const r = await syncLibrary(true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(cachedIds(), [101, 102, 201]);
  planBacklog(now);
  assert.equal(search(103)?.state, "done");
  assert.equal(search(103)?.last_why, "no longer in Sonarr");

  real = { 1: 3, 2: 1 };
  await syncLibrary(true);
  assert.deepEqual(cachedIds(), [101, 102, 103, 201]);
  planSchedule(now);
  assert.equal(search(103)?.state, "waiting", "back in Sonarr: searched again");
});

test("an older episode's search, closed while it was gone from the cache, reopens in the missing-episode search", () => {
  patchSettings((s) => ({ ...s, backlog: { ...s.backlog, enabled: true } }));
  cache.prepare("UPDATE episodes SET air_utc = ? WHERE id = 101").run(now - 60 * DAY);
  db.prepare("UPDATE search_state SET state = 'done', last_why = 'no longer in Sonarr', last_at = ? WHERE episode_id = 101").run(now);
  planBacklog(now);
  assert.equal(search(101)?.state, "backlog");
});
