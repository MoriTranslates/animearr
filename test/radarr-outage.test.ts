/**
 * Radarr down or half-answering during the library sync (review 2026-11-02, H10/H12 for movies): the movie cache keeps
 * the last good list, the sync reports a problem instead of "done", and no movie is added natively as a duplicate of a
 * Radarr movie while AnimeArr has never had a complete answer from Radarr.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-radarr-outage-"));
process.env.ANIMEARR_NO_LOCK = "1";
fs.mkdirSync(path.join(process.env.ANIMEARR_CONFIG, "cache"), { recursive: true });
fs.writeFileSync(path.join(process.env.ANIMEARR_CONFIG, "cache", "anime-list-master.xml"), "<anime-list></anime-list>");

const { cache, listJobs } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { syncLibrary } = await import("../server/library/library.js");
const { addMovie } = await import("../server/library/native.js");

type Mode = "ok" | "down" | "timeout" | "500" | "empty" | "partial" | "notList" | "badJson" | "badItem";
let mode: Mode = "ok";
let ids = [1, 2, 3];

const movie = (id: number) => ({
  id,
  tmdbId: 5000 + id,
  title: `Movie ${id}`,
  path: `/movies/Movie ${id}`,
  rootFolderPath: "/movies",
  monitored: true,
  hasFile: false,
  qualityProfileId: 1,
  tags: [],
  genres: ["Animation"],
  originalLanguage: { name: "Japanese" },
});

const json = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const realFetch = globalThis.fetch;
before(() => {
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/movies"],
    radarr: { url: "http://radarr.test", apiKey: "k", animeRoots: [], animeProfileIds: [] },
  }));
  globalThis.fetch = (async (u: string | URL) => {
    const url = new URL(String(u));
    if (!url.pathname.endsWith("/movie")) throw new Error(`unexpected ${url.pathname}`);
    if (mode === "down") throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    if (mode === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (mode === "500") return json({ message: "boom" }, 500);
    if (mode === "empty") return json([]);
    if (mode === "partial") return json([movie(ids[0])]);
    if (mode === "notList") return json({ page: 1, records: [] });
    if (mode === "badJson") return json("<html>Radarr is starting</html>");
    if (mode === "badItem") return json([...ids.map(movie), { id: 99 }]);
    return json(ids.map(movie));
  }) as typeof fetch;
});
after(() => void (globalThis.fetch = realFetch));

const cachedMovies = () =>
  (cache.prepare("SELECT id FROM movies WHERE id < 1000000 ORDER BY id").all() as { id: number }[]).map((r) => r.id);
const syncJob = () => (listJobs() as { name: string; state: string; detail: string }[]).find((j) => j.name === "sync");
const noNetwork = { media: async () => [], fribb: async () => ({}) } as unknown as Parameters<typeof addMovie>[1];

test("before any complete Radarr answer, adding a movie natively is refused instead of risking a duplicate", async () => {
  mode = "down";
  const r = await syncLibrary(true);
  assert.ok(r.errors.length);
  assert.equal(syncJob()?.state, "error");
  assert.deepEqual(cachedMovies(), []);
  let called = 0;
  const deps = { media: async () => (called++, []), fribb: async () => ({}) } as unknown as Parameters<typeof addMovie>[1];
  await assert.rejects(addMovie({ anilistId: 1, rootFolder: "/movies" }, deps), (e: Error & { statusCode?: number }) => {
    assert.equal(e.statusCode, 503);
    assert.match(e.message, /Radarr/);
    return true;
  });
  assert.equal(called, 0);
});

test("a good sync fills the movie cache", async () => {
  mode = "ok";
  const r = await syncLibrary(true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(cachedMovies(), [1, 2, 3]);
  assert.equal(syncJob()?.state, "done");
});

for (const m of ["down", "timeout", "500", "empty", "partial", "notList", "badJson", "badItem"] as const)
  test(`movie list ${m}: the cached movies stay and the sync reports a problem`, async () => {
    mode = m;
    const r = await syncLibrary();
    assert.ok(r.errors.length, `errors reported for ${m}`);
    assert.equal(syncJob()?.state, "error");
    assert.deepEqual(cachedMovies(), [1, 2, 3]);
    if (m === "empty" || m === "partial") assert.ok(r.errors.some((e) => e.includes("Settings → System → Rebuild cache")));
    mode = "ok";
  });

test("one movie really removed from Radarr is dropped from the cache", async () => {
  ids = [1, 2];
  const r = await syncLibrary();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(cachedMovies(), [1, 2]);
});

test("a full sync confirms that Radarr really has no movies left", async () => {
  ids = [];
  await syncLibrary();
  assert.deepEqual(cachedMovies(), [1, 2], "a plain sync holds the mass removal");
  const r = await syncLibrary(true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(cachedMovies(), []);
  // A complete (if empty) answer was stored: adding natively gets past the guard (and fails on the folder instead).
  await assert.rejects(
    addMovie({ anilistId: 1, rootFolder: "/nowhere" }, noNetwork),
    (e: Error & { statusCode?: number }) => e.statusCode !== 503,
  );
});
