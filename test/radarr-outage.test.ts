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

const { cache, db, listJobs } = await import("../server/system/db.js");
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

// ---------------------------------------------------------------- multi-part movie records (movie_parts)

const partsRecord = (movieId: number) => db.prepare("SELECT 1 FROM movie_parts WHERE movie_id = ?").get(movieId);
const hasFile = (movieId: number) =>
  (cache.prepare("SELECT has_file FROM movies WHERE id = ?").get(movieId) as { has_file: number }).has_file;

test("a refused or malformed Radarr answer never deletes a multi-part movie record; an accepted one still does", async () => {
  ids = [1, 2, 3];
  mode = "ok";
  await syncLibrary(true);
  // Movie 1: parts AnimeArr imported that are now gone from disk (an accepted sync drops this record).
  const gone = path.join(process.env.ANIMEARR_CONFIG!, "gone");
  fs.mkdirSync(gone); // the folder is readable and lists something, but not the parts: really gone
  fs.writeFileSync(path.join(gone, "other.nfo"), "x");
  db.prepare("INSERT OR REPLACE INTO movie_parts (movie_id, file, at) VALUES (?, ?, ?)").run(
    1,
    JSON.stringify({ parts: [`${gone}/cd1.mkv`, `${gone}/cd2.mkv`] }),
    Date.now(),
  );
  for (const m of ["empty", "partial", "notList", "badItem"] as const) {
    mode = m;
    await syncLibrary();
    assert.ok(partsRecord(1), `record kept after a ${m} answer`);
  }
  mode = "ok";
  await syncLibrary();
  assert.ok(!partsRecord(1), "an accepted sync still drops a record whose parts are gone");
});

test("a refused Radarr answer still counts a multi-part movie's stacked parts as its file", async () => {
  const dir = fs.mkdtempSync(path.join(process.env.ANIMEARR_CONFIG!, "parts-"));
  const parts = ["cd1.mkv", "cd2.mkv"].map((f) => path.join(dir, f));
  for (const p of parts) fs.writeFileSync(p, "x");
  db.prepare("INSERT OR REPLACE INTO movie_parts (movie_id, file, at) VALUES (?, ?, ?)").run(1, JSON.stringify({ parts }), Date.now());
  mode = "partial"; // returns movie 1 (hasFile false in Radarr's eyes) and holds the removal of 2 and 3
  await syncLibrary();
  assert.equal(hasFile(1), 1);
  assert.ok(partsRecord(1));
  mode = "ok";
});

// ---------------------------------------------------------------- multi-part records vs an unreachable share

/** A library root with a multi-part movie folder under it; `state` sets up what the share looks like. */
function partsUnder(name: string) {
  const root = path.join(process.env.ANIMEARR_CONFIG!, name);
  const folder = path.join(root, "Movies", "Film (2001)");
  const parts = ["cd1.mkv", "cd2.mkv"].map((f) => path.join(folder, f));
  patchSettings((s) => ({ ...s, allowedRoots: [...s.allowedRoots, root.split(path.sep).join("/")] }));
  db.prepare("INSERT OR REPLACE INTO movie_parts (movie_id, file, at) VALUES (?, ?, ?)").run(1, JSON.stringify({ parts }), Date.now());
  return { root, folder, parts };
}

test("an unmounted share (the library root is missing) keeps the multi-part record and its file", async () => {
  partsUnder("share-missing"); // nothing created on disk
  mode = "ok";
  ids = [1, 2, 3];
  await syncLibrary(true);
  assert.ok(partsRecord(1));
  assert.equal(hasFile(1), 1, "still counts as having its file");
});

test("an empty mount point (the root is there but empty) keeps the multi-part record", async () => {
  const { root } = partsUnder("share-empty");
  fs.mkdirSync(root, { recursive: true });
  await syncLibrary(true);
  assert.ok(partsRecord(1));
});

test("a share mounted below the root (its empty mount point inside a root with content) keeps the record", async () => {
  const { root } = partsUnder("share-nested");
  fs.mkdirSync(path.join(root, "Movies"), { recursive: true }); // the share's mount point, empty: not mounted
  fs.writeFileSync(path.join(root, "other.txt"), "x");
  await syncLibrary(true);
  assert.ok(partsRecord(1));
});

test("an empty movie folder (a bind mount made empty, not mounted) keeps the multi-part record", async () => {
  const { root, folder } = partsUnder("share-empty-folder");
  fs.mkdirSync(folder, { recursive: true }); // the movie's own folder exists but is empty
  fs.writeFileSync(path.join(root, "other.txt"), "x");
  await syncLibrary(true);
  assert.ok(partsRecord(1));
});

test("a permission error reading the movie folder keeps the multi-part record", async (t) => {
  const { root, folder, parts } = partsUnder("share-eacces");
  fs.mkdirSync(folder, { recursive: true });
  for (const p of parts) fs.writeFileSync(p, "x");
  fs.writeFileSync(path.join(root, "other.txt"), "x");
  const real = fs.readdirSync;
  const denied = (p: fs.PathLike) => path.resolve(String(p)) === path.resolve(folder);
  t.mock.method(fs, "readdirSync", ((p: fs.PathLike, o?: never) => {
    if (denied(p)) throw Object.assign(new Error(`EACCES: permission denied, scandir '${String(p)}'`), { code: "EACCES" });
    return real(p, o);
  }) as typeof fs.readdirSync);
  t.mock.method(fs, "accessSync", ((p: fs.PathLike) => {
    if (denied(path.dirname(String(p))) || denied(p)) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
  }) as typeof fs.accessSync);
  await syncLibrary(true);
  assert.ok(partsRecord(1));
});

test("a part really deleted (its folder readable) or the whole movie folder deleted (root reachable) drops the record", async () => {
  const { root, folder, parts } = partsUnder("share-real");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(parts[0], "x"); // cd2 is gone
  await syncLibrary(true);
  assert.ok(!partsRecord(1), "one part gone");

  const again = partsUnder("share-real");
  fs.rmSync(again.folder, { recursive: true }); // the whole movie folder is gone, the root still has other content
  fs.mkdirSync(path.join(root, "Movies", "Another (2002)"), { recursive: true });
  await syncLibrary(true);
  assert.ok(!partsRecord(1), "movie folder gone");
});
