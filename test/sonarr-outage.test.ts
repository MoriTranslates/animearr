/**
 * Sonarr down or half-answering during the library sync (review 2026-11-02, H10/H12): the cache keeps the last good
 * list of shows and episodes, the sync reports a problem instead of "done", and nothing adds a Sonarr show again as a
 * native duplicate while AnimeArr has never had a complete answer from Sonarr.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-sonarr-outage-"));
process.env.ANIMEARR_NO_LOCK = "1";
fs.mkdirSync(path.join(process.env.ANIMEARR_CONFIG, "cache"), { recursive: true });
fs.writeFileSync(path.join(process.env.ANIMEARR_CONFIG, "cache", "anime-list-master.xml"), "<anime-list></anime-list>");

const { cache, db, listJobs } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { syncLibrary } = await import("../server/library/library.js");
const { addShow } = await import("../server/library/native.js");
const L = await import("../server/library/importLists.js");

// ---------------------------------------------------------------- a fake Sonarr, switchable per test

type Mode = "ok" | "down" | "timeout" | "500" | "empty" | "partial" | "notList" | "badJson" | "badItem";
let seriesMode: Mode = "ok";
let episodesMode: Mode = "ok";
let shows = [1, 2, 3];
let tags: { id: number; label: string }[] = [];

const series = (id: number) => ({
  id,
  tvdbId: 1000 + id,
  title: `Show ${id}`,
  sortTitle: `show ${id}`,
  status: "continuing",
  seriesType: id === 3 ? "standard" : "anime", // show 3 counts as anime through the "anime" tag only
  path: `/tv/Show ${id}`,
  monitored: true,
  qualityProfileId: 1,
  tags: id === 3 ? [7] : [],
  seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 0, episodeCount: 2, totalEpisodeCount: 2 } }],
  statistics: { episodeFileCount: 0, episodeCount: 2, totalEpisodeCount: 2, sizeOnDisk: 0 },
});
const episode = (seriesId: number, n: number) => ({
  id: seriesId * 100 + n,
  seriesId,
  seasonNumber: 1,
  episodeNumber: n,
  title: `Ep ${n}`,
  airDateUtc: "2026-01-01T00:00:00Z",
  monitored: true,
  hasFile: false,
  episodeFileId: 0,
});

const json = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
function answer(mode: Mode, good: () => unknown[]): Response {
  if (mode === "down") throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
  if (mode === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  if (mode === "500") return json({ message: "boom" }, 500);
  if (mode === "empty") return json([]);
  if (mode === "partial") return json(good().slice(0, 1));
  if (mode === "notList") return json({ page: 1, records: [] });
  if (mode === "badJson") return json("<html>Sonarr is starting</html>");
  if (mode === "badItem") return json([...good(), { id: 99 }]); // a record with no fields at all
  return json(good());
}

const realFetch = globalThis.fetch;
before(() => {
  patchSettings((s) => ({ ...s, allowedRoots: ["/tv"], sonarr: { url: "http://sonarr.test", apiKey: "k", animeTag: "anime" } }));
  globalThis.fetch = (async (u: string | URL) => {
    const url = new URL(String(u));
    if (url.pathname.endsWith("/series")) return answer(seriesMode, () => shows.map(series));
    if (url.pathname.endsWith("/tag")) return json(tags);
    if (url.pathname.endsWith("/episode")) {
      const id = Number(url.searchParams.get("seriesId"));
      return answer(episodesMode, () => [episode(id, 1), episode(id, 2)]);
    }
    if (url.pathname.endsWith("/episodefile")) return json([]);
    throw new Error(`unexpected ${url.pathname}`);
  }) as typeof fetch;
});
after(() => void (globalThis.fetch = realFetch));

const cachedShows = () =>
  (cache.prepare("SELECT id FROM series WHERE id < 1000000 ORDER BY id").all() as { id: number }[]).map((r) => r.id);
const cachedEpisodes = (id: number) => (cache.prepare("SELECT COUNT(*) AS n FROM episodes WHERE series_id = ?").get(id) as { n: number }).n;
const syncJob = () => (listJobs() as { name: string; state: string; detail: string }[]).find((j) => j.name === "sync");

// ---------------------------------------------------------------- never had a good answer: no native duplicates

test("before any complete Sonarr answer, Add and import lists refuse instead of adding duplicates of Sonarr's shows", async () => {
  seriesMode = "down";
  const r = await syncLibrary(true);
  assert.ok(r.errors.length, "the sync reports the outage");
  assert.equal(syncJob()?.state, "error");
  assert.deepEqual(cachedShows(), []);

  let mediaCalls = 0;
  const deps = {
    media: async () => {
      mediaCalls++;
      return [];
    },
    fribb: async () => {
      throw new Error("not reached");
    },
  } as unknown as Parameters<typeof addShow>[1];
  await assert.rejects(addShow({ anilistId: 1, rootFolder: "/tv" }, deps), (e: Error & { statusCode?: number }) => {
    assert.equal(e.statusCode, 503);
    assert.match(e.message, /Sonarr/);
    return true;
  });
  assert.equal(mediaCalls, 0);

  const l = L.saveList(null, { name: "Mine", source: "anilist", username: "me", statuses: ["CURRENT"], rootFolder: "/tv" });
  db.prepare("UPDATE import_lists SET confirmed = 1 WHERE id = ?").run(l.id);
  await assert.rejects(L.syncList(l.id), /Sonarr/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM native_series").get() as { n: number }).n, 0);
  L.deleteList(l.id);
});

test("a good sync fills the cache", async () => {
  seriesMode = "ok";
  episodesMode = "ok";
  tags = [{ id: 7, label: "anime" }];
  const r = await syncLibrary(true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(cachedShows(), [1, 2, 3]);
  assert.equal(cachedEpisodes(1), 2);
  assert.equal(syncJob()?.state, "done");
});

// ---------------------------------------------------------------- Sonarr fails in every way: the cache stays

for (const mode of ["down", "timeout", "500", "empty", "partial", "notList", "badJson", "badItem"] as const)
  test(`series list ${mode}: the cached shows and episodes stay and the sync reports a problem`, async () => {
    seriesMode = mode;
    const r = await syncLibrary();
    assert.ok(r.errors.length, `errors reported for ${mode}`);
    assert.equal(r.removed, 0);
    assert.equal(syncJob()?.state, "error");
    assert.deepEqual(cachedShows(), [1, 2, 3]);
    for (const id of [1, 2, 3]) assert.equal(cachedEpisodes(id), 2, `episodes of show ${id} kept`);
    seriesMode = "ok";
  });

test("the configured anime tag missing from Sonarr's answer keeps the shows that came in through it", async () => {
  tags = [];
  const r = await syncLibrary();
  assert.ok(r.errors.some((e) => /tag/i.test(e)));
  assert.deepEqual(cachedShows(), [1, 2, 3]);
  tags = [{ id: 7, label: "anime" }];
});

for (const mode of ["down", "500", "empty", "notList", "badJson"] as const)
  test(`episode list ${mode}: the cached episodes stay`, async () => {
    episodesMode = mode;
    const r = await syncLibrary(true);
    assert.ok(r.errors.length, `errors reported for ${mode}`);
    for (const id of [1, 2, 3]) assert.equal(cachedEpisodes(id), 2, `episodes of show ${id} kept`);
    episodesMode = "ok";
  });

// ---------------------------------------------------------------- real removals still go through

test("one show really removed from Sonarr is dropped from the cache", async () => {
  shows = [1, 2];
  const r = await syncLibrary();
  assert.deepEqual(r.errors, []);
  assert.equal(r.removed, 1);
  assert.deepEqual(cachedShows(), [1, 2]);
});

test("a full sync confirms that Sonarr really has no anime left", async () => {
  shows = [];
  await syncLibrary();
  assert.deepEqual(cachedShows(), [1, 2], "a plain sync holds the mass removal");
  const r = await syncLibrary(true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(cachedShows(), []);
  // A complete (if empty) answer was stored: adding natively is allowed again (it gets past the guard).
  await assert.rejects(
    addShow({ anilistId: 1, rootFolder: "/nowhere" }, { media: async () => [], fribb: async () => ({}) } as unknown as Parameters<
      typeof addShow
    >[1]),
    (e: Error & { statusCode?: number }) => e.statusCode !== 503,
  );
});
