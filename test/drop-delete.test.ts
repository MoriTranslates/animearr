/**
 * "Drop" with "Also delete it: all episodes, the folder, and remove it from my library" (POST /api/series/:tvdbId/drop
 * with remove + deleteFiles, over HTTP, logged in), and the Blocked shows list it feeds.
 *
 * The rule: AnimeArr never calls Sonarr in this flow. It works on its own records, its own files and its own recycling
 * bin only; a show whose record Sonarr holds is AnimeArr's to delete when AnimeArr manages it. Afterwards the show is
 * gone from the library and blocked: no Sonarr sync, adoption, import list or Add brings it back until it's unblocked.
 *
 * Failure modes, one test each: Sonarr down (any Sonarr call fails the test), a same-title show with another tvdbId, a
 * show AnimeArr doesn't manage, the folder already gone, a move failing part-way, a double click, a download in
 * progress, the bin unusable, the box unticked, a retry after a refusal, the sync bringing the show back, an import
 * list adding it, Add adding it, Unblock. Movies have no Drop (the route is per tvdbId), so there is no movie case.
 */
import { test, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-dropdel-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
fs.mkdirSync(path.join(process.env.ANIMEARR_CONFIG, "cache"), { recursive: true });
fs.writeFileSync(path.join(process.env.ANIMEARR_CONFIG, "cache", "anime-list-master.xml"), "<anime-list></anime-list>");

const { setAccount, patchSettings } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");
const { cache, db } = await import("../server/system/db.js");
const { syncLibrary } = await import("../server/library/library.js");
const { adoptShows } = await import("../server/library/cutover.js");
const { searchAdd } = await import("../server/library/native.js");
const L = await import("../server/library/importLists.js");
const NATIVE_BASE = 900_000_000;
const hooks = (await import("../server/library/removeFiles.js")) as {
  removeFilesDeps: { move: (a: string, b: string) => Promise<void> };
};
const realMove = hooks.removeFilesDeps.move;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-dropdel-lib-"));
const LIB = path.join(tmp, "Anime");
const BIN = path.join(tmp, "Recycle", "animearr");
const write = (p: string, body = "x") => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, body));

// ---------------------------------------------------------------- Sonarr: every call is counted; the drop flow must make none

let sonarrCalls: string[] = [];
let sonarrSeries: unknown[] = [];
let sonarrDown = true;
const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let cookie = "";
before(async () => {
  globalThis.fetch = (async (u: string | URL) => {
    const url = new URL(String(u));
    if (url.hostname !== "sonarr.test") return realFetch(u);
    sonarrCalls.push(url.pathname);
    if (sonarrDown) throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    if (url.pathname.endsWith("/series")) return json(sonarrSeries);
    if (url.pathname.endsWith("/tag")) return json([]);
    if (url.pathname.endsWith("/episode")) return json([]);
    if (url.pathname.endsWith("/episodefile")) return json([]);
    return json({ message: "unexpected" }, 404);
  }) as typeof fetch;
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-animearr": "1" },
    payload: { username: "captain", password: "pw-test-1" },
  });
  assert.equal(login.statusCode, 200, login.body);
  cookie = [login.headers["set-cookie"]]
    .flat()
    .filter(Boolean)
    .map((c) => String(c).split(";")[0])
    .join("; ");
});
after(() => void (globalThis.fetch = realFetch));

const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, headers: { cookie, "x-animearr": "1" }, payload: payload as Record<string, unknown> });
const del = (url: string) => app.inject({ method: "DELETE", url, headers: { cookie, "x-animearr": "1" } });
const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
const dropDelete = (tvdbId: number) => post(`/api/series/${tvdbId}/drop`, { remove: true, deleteFiles: true, unmonitor: true });

const useBin = (bin = "/media/Recycle/animearr") =>
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/Anime"],
    localPathMappings: [
      { from: "/media", to: tmp },
      { from: "/media/Anime", to: LIB },
      { from: "/media/Recycle", to: path.join(tmp, "Recycle") },
    ],
    media: { ...s.media, recycleBin: bin },
    sonarr: { url: "http://sonarr.test", apiKey: "k", animeTag: "" },
  }));

/** A show whose record Sonarr holds (cache row with Sonarr's id), managed by AnimeArr, with an AniList entry. */
function sonarrShow(id: number, tvdbId: number, title: string, arrPath: string, o: { managed?: boolean } = {}) {
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, root_folder, monitored, series_type, synced_at) VALUES (?, ?, ?, ?, '/media/Anime', 0, 'anime', 0)",
    )
    .run(id, tvdbId, title, arrPath);
  cache
    .prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file) VALUES (?, ?, 1, 1, 0, 1)")
    .run(id * 100 + 1, id);
  if (o.managed !== false)
    db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (?, ?, ?, 0, 0)").run(tvdbId, id, title);
  db.prepare("INSERT OR REPLACE INTO entries (anilist_id, tvdb_id, kind, title_english, fetched_at) VALUES (?, ?, 'TV', ?, 0)").run(
    70_000 + id,
    tvdbId,
    title,
  );
}
function nativeShow(row: number, tvdbId: number, arrPath: string) {
  db.prepare(
    "INSERT INTO native_series (id, tvdb_id, anilist_id, synthetic, title, year, path, root_folder, added_at) VALUES (?, ?, ?, 0, ?, 2020, ?, '/media/Anime', 0)",
  ).run(row, tvdbId, 50_000 + row, `Native ${row}`, arrPath);
  cache
    .prepare("INSERT INTO series (id, tvdb_id, title, path, root_folder, monitored, synced_at) VALUES (?, ?, ?, ?, '/media/Anime', 1, 0)")
    .run(NATIVE_BASE + row, tvdbId, `Native ${row}`, arrPath);
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (?, ?, ?, 0, 0)").run(
    tvdbId,
    NATIVE_BASE + row,
    `Native ${row}`,
  );
}
function fill(dir: string) {
  write(path.join(dir, "Season 01", "Ep 01.mkv"), "video");
  write(path.join(dir, "Season 01", "Ep 02.mkv"), "video");
  write(path.join(dir, "poster.jpg"), "jpg!");
}
const FILES = [path.join("Season 01", "Ep 01.mkv"), path.join("Season 01", "Ep 02.mkv"), "poster.jpg"];
const inCache = (tvdbId: number) => !!cache.prepare("SELECT 1 FROM series WHERE tvdb_id = ?").get(tvdbId);
const isBlocked = (tvdbId: number) => !!db.prepare("SELECT 1 FROM dropped WHERE tvdb_id = ? AND removed = 1").get(tvdbId);
const isDropped = (tvdbId: number) => !!db.prepare("SELECT 1 FROM dropped WHERE tvdb_id = ?").get(tvdbId);
const filesStay = (dir: string) => {
  for (const f of FILES) assert.ok(fs.existsSync(path.join(dir, f)), `${f} stays`);
};

beforeEach(() => {
  for (const d of [LIB, BIN]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(LIB, { recursive: true });
  for (const t of ["native_series", "native_movies", "grabs", "recycle_log", "managed", "dropped", "entries", "import_list_exclusions"])
    db.prepare(`DELETE FROM ${t}`).run();
  for (const t of ["series", "movies", "episodes"]) cache.prepare(`DELETE FROM ${t}`).run();
  sonarrCalls = [];
  sonarrDown = true;
  useBin();
});
afterEach(() => void (hooks.removeFilesDeps.move = realMove));

test("a managed show whose record Sonarr holds: files to AnimeArr's bin, card gone, blocked; Sonarr (down) is never called", async () => {
  sonarrShow(11, 8001, "Pirate Show", "/media/Anime/Pirate Show");
  const dir = path.join(LIB, "Pirate Show");
  fill(dir);
  const plan = await get("/api/series/8001/remove-plan");
  assert.equal(plan.statusCode, 200, plan.body);
  assert.deepEqual(
    { ...JSON.parse(plan.body), reason: undefined },
    { path: "/media/Anime/Pirate Show", canDelete: true, exists: true, files: 3, bytes: 14, reason: undefined },
  );
  const r = await dropDelete(8001);
  assert.equal(r.statusCode, 200, r.body);
  const body = JSON.parse(r.body);
  assert.equal(body.removed, true);
  assert.equal(body.binned.moved, 3);
  for (const f of FILES) assert.ok(fs.existsSync(path.join(BIN, "Pirate Show", f)), `${f} is in AnimeArr's bin`);
  assert.equal(fs.existsSync(dir), false, "the folder is gone");
  assert.equal(inCache(8001), false, "its card is gone");
  assert.equal(cache.prepare("SELECT 1 FROM episodes WHERE series_id = 11").get(), undefined, "its episodes are forgotten");
  assert.equal(db.prepare("SELECT 1 FROM managed WHERE tvdb_id = 8001").get(), undefined);
  assert.equal(isBlocked(8001), true);
  assert.deepEqual(sonarrCalls, [], "no Sonarr call at all (not even the unmonitor)");
  // It is in the Blocked shows list, with the title, date and why.
  const list = JSON.parse((await get("/api/blocked")).body) as { tvdbId: number; title: string; at: number; why: string }[];
  assert.equal(list.length, 1);
  assert.equal(list[0].tvdbId, 8001);
  assert.equal(list[0].title, "Pirate Show");
  assert.ok(list[0].at > 0);
  assert.match(list[0].why, /deleted|removed/i);
  // Its AniList entry is excluded from import lists too (one table: the exclusions carry the tvdbId).
  assert.ok(db.prepare("SELECT 1 FROM import_list_exclusions WHERE anilist_id = 70011 AND tvdb_id = 8001").get());
});

test("the box unticked: a plain drop, as today; the files, the card and the record all stay", async () => {
  sonarrShow(11, 8002, "Kept Show", "/media/Anime/Kept Show");
  fill(path.join(LIB, "Kept Show"));
  const r = await post("/api/series/8002/drop", {});
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(isDropped(8002), true);
  assert.equal(isBlocked(8002), false);
  assert.equal(inCache(8002), true);
  filesStay(path.join(LIB, "Kept Show"));
  assert.deepEqual(JSON.parse((await get("/api/blocked")).body), []);
});

test("a same-title show with another tvdbId is never touched", async () => {
  sonarrShow(11, 8003, "Twin", "/media/Anime/Twin");
  sonarrShow(12, 8004, "Twin", "/media/Anime/Twin (2024)");
  fill(path.join(LIB, "Twin"));
  fill(path.join(LIB, "Twin (2024)"));
  const r = await dropDelete(8003);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(inCache(8004), true);
  assert.equal(isDropped(8004), false);
  assert.ok(db.prepare("SELECT 1 FROM managed WHERE tvdb_id = 8004").get());
  filesStay(path.join(LIB, "Twin (2024)"));
  // And when the other one shares the folder: refused, nothing changes.
  sonarrShow(13, 8005, "Shared A", "/media/Anime/Shared");
  sonarrShow(14, 8006, "Shared B", "/media/Anime/Shared");
  fill(path.join(LIB, "Shared"));
  const s = await dropDelete(8005);
  assert.equal(s.statusCode, 409, s.body);
  assert.match(JSON.parse(s.body).error, /also uses/);
  assert.equal(isDropped(8005), false, "a refused delete changes nothing");
  assert.equal(inCache(8005), true);
  filesStay(path.join(LIB, "Shared"));
});

test("a Sonarr show AnimeArr doesn't manage: its files are Sonarr's; the delete is refused with the reason", async () => {
  sonarrShow(11, 8007, "Not Ours", "/media/Anime/Not Ours", { managed: false });
  fill(path.join(LIB, "Not Ours"));
  const plan = JSON.parse((await get("/api/series/8007/remove-plan")).body);
  assert.equal(plan.canDelete, false);
  assert.match(plan.reason, /manage/);
  const r = await dropDelete(8007);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(inCache(8007), true);
  assert.equal(isDropped(8007), false);
  filesStay(path.join(LIB, "Not Ours"));
  // The plain drop still works.
  assert.equal((await post("/api/series/8007/drop", {})).statusCode, 200);
  assert.equal(isDropped(8007), true);
});

test("dropped earlier (while managed), deleted later: still AnimeArr's to delete; dropped while unmanaged: not", async () => {
  sonarrShow(11, 8020, "Later", "/media/Anime/Later");
  sonarrShow(12, 8021, "Never Managed", "/media/Anime/Never Managed", { managed: false });
  fill(path.join(LIB, "Later"));
  fill(path.join(LIB, "Never Managed"));
  assert.equal((await post("/api/series/8020/drop", {})).statusCode, 200);
  assert.equal((await post("/api/series/8021/drop", {})).statusCode, 200);
  const r = await dropDelete(8020);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(JSON.parse(r.body).binned.moved, 3);
  assert.equal(isBlocked(8020), true);
  const n = await dropDelete(8021);
  assert.equal(n.statusCode, 409, n.body);
  filesStay(path.join(LIB, "Never Managed"));
});

test("the folder already gone: removed and blocked, nothing moved, and the answer says so", async () => {
  sonarrShow(11, 8008, "Gone", "/media/Anime/Gone");
  const r = await dropDelete(8008);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(JSON.parse(r.body).binned.folderMissing, true);
  assert.equal(inCache(8008), false);
  assert.equal(isBlocked(8008), true);
});

test("a move failing part-way: what moved comes back, and the show is neither dropped, removed nor blocked", async () => {
  sonarrShow(11, 8009, "Midway", "/media/Anime/Midway");
  const dir = path.join(LIB, "Midway");
  fill(dir);
  let n = 0;
  hooks.removeFilesDeps.move = async (a, b) => {
    if (++n === 2) throw new Error("disk full");
    await realMove(a, b);
  };
  const r = await dropDelete(8009);
  assert.equal(r.statusCode, 500, r.body);
  assert.match(JSON.parse(r.body).error, /disk full/);
  assert.equal(inCache(8009), true);
  assert.equal(isDropped(8009), false);
  assert.ok(db.prepare("SELECT 1 FROM managed WHERE tvdb_id = 8009").get(), "still managed");
  filesStay(dir);
  // A retry once the disk is fine finishes the job.
  hooks.removeFilesDeps.move = realMove;
  const again = await dropDelete(8009);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(isBlocked(8009), true);
});

test("a double click: the second is refused while the first runs; the files move once", async () => {
  sonarrShow(11, 8010, "Twice", "/media/Anime/Twice");
  fill(path.join(LIB, "Twice"));
  let open!: () => void;
  const gate = new Promise<void>((res) => (open = res));
  hooks.removeFilesDeps.move = async (a, b) => {
    await gate;
    await realMove(a, b);
  };
  const first = dropDelete(8010);
  await new Promise((res) => setTimeout(res, 50));
  const second = await dropDelete(8010);
  open();
  assert.equal(second.statusCode, 409, second.body);
  assert.match(JSON.parse(second.body).error, /already being removed/);
  const r = await first;
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(JSON.parse(r.body).binned.moved, 3);
});

test("a download in progress: refused, nothing changes", async () => {
  sonarrShow(11, 8011, "Busy", "/media/Anime/Busy");
  fill(path.join(LIB, "Busy"));
  db.prepare(
    "INSERT INTO grabs (at, updated_at, tvdb_id, episode_ids, release, guid, protocol, state, dry_run) VALUES (0, 0, 8011, '[]', 'r', 'g', 'torrent', 'downloading', 0)",
  ).run();
  const r = await dropDelete(8011);
  assert.equal(r.statusCode, 409, r.body);
  assert.match(JSON.parse(r.body).error, /download/);
  assert.equal(isDropped(8011), false);
  assert.equal(inCache(8011), true);
  filesStay(path.join(LIB, "Busy"));
});

test("the bin unusable: the plan says why, the delete is refused, the plain drop still works", async () => {
  useBin("");
  sonarrShow(11, 8012, "No Bin", "/media/Anime/No Bin");
  fill(path.join(LIB, "No Bin"));
  const plan = JSON.parse((await get("/api/series/8012/remove-plan")).body);
  assert.equal(plan.canDelete, false);
  assert.match(plan.reason, /recycling bin/);
  const r = await dropDelete(8012);
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(isDropped(8012), false);
  filesStay(path.join(LIB, "No Bin"));
  assert.equal((await post("/api/series/8012/drop", {})).statusCode, 200);
});

test("a show added in AnimeArr: dropped, its folder binned, forgotten and blocked", async () => {
  nativeShow(1, 8013, "/media/Anime/Native One");
  fill(path.join(LIB, "Native One"));
  const r = await dropDelete(8013);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(JSON.parse(r.body).binned.moved, 3);
  assert.equal(db.prepare("SELECT 1 FROM native_series WHERE tvdb_id = 8013").get(), undefined);
  assert.equal(inCache(8013), false);
  assert.equal(isBlocked(8013), true);
  assert.deepEqual(sonarrCalls, []);
});

test("the show page's Remove for a Sonarr-held show: the same flow without the files (remove only), still blocked", async () => {
  sonarrShow(11, 8014, "Remove Only", "/media/Anime/Remove Only");
  fill(path.join(LIB, "Remove Only"));
  const r = await post("/api/series/8014/drop", { remove: true });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(inCache(8014), false);
  assert.equal(isBlocked(8014), true);
  filesStay(path.join(LIB, "Remove Only"));
  assert.deepEqual(sonarrCalls, []);
});

test("Sonarr's next sync and the cutover adoption never bring a blocked show back", async () => {
  sonarrShow(11, 8015, "Blocked One", "/media/Anime/Blocked One");
  assert.equal((await dropDelete(8015)).statusCode, 200);
  sonarrDown = false;
  const rec = (id: number, tvdbId: number, title: string) => ({
    id,
    tvdbId,
    title,
    status: "continuing",
    seriesType: "anime",
    path: `/media/Anime/${title}`,
    monitored: false,
    qualityProfileId: 1,
    tags: [],
    seasons: [{ seasonNumber: 1, monitored: false, statistics: { episodeFileCount: 0, episodeCount: 0, totalEpisodeCount: 0 } }],
  });
  sonarrSeries = [rec(11, 8015, "Blocked One"), rec(12, 8016, "Still Here")];
  await syncLibrary(true);
  assert.equal(inCache(8016), true, "the sync ran");
  assert.equal(inCache(8015), false, "the blocked show isn't shown again");
  // Even if a row came back some other way, adoption refuses it.
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (11, 8015, 'Blocked One', '/media/Anime/Blocked One', 0, 0)",
    )
    .run();
  const out = adoptShows([8015]);
  assert.equal(out[0].ok, false);
  assert.match(out[0].why, /blocked/i);
});

test("an import list skips a blocked show; Add marks it blocked and refuses it unless asked to add anyway", async () => {
  sonarrShow(11, 8017, "Listed Show", "/media/Anime/Listed Show");
  assert.equal((await dropDelete(8017)).statusCode, 200);
  const plan = await L.planList(
    { source: "anilist", username: "x", statuses: ["CURRENT"], rootFolder: "/media/Anime", movieRootFolder: "" },
    {
      fetcher: fetch,
      entries: async () => [{ id: 70011, status: "CURRENT" }],
      media: async () => [],
      fribb: async () => ({
        mtime: 0,
        anidbToAnilist: new Map(),
        anilistToAnidb: new Map(),
        anilistToAnidbAll: new Map(),
        anilistToTmdb: new Map(),
      }),
    } as unknown as L.ListDeps,
  );
  assert.equal(plan.add.length, 0);
  assert.equal(plan.items[0].action, "skip");
  const found = await searchAdd("Listed Show", {
    search: async () => [],
    fribb: async () => ({
      mtime: 0,
      anidbToAnilist: new Map(),
      anilistToAnidb: new Map(),
      anilistToAnidbAll: new Map(),
      anilistToTmdb: new Map(),
    }),
    timeoutMs: 100,
  } as unknown as Parameters<typeof searchAdd>[1]);
  const hit = found.results.find((x) => x.anilistId === 70011) as { blocked?: boolean } | undefined;
  assert.equal(hit?.blocked, true, "Add's search marks it blocked");
  const add = await post("/api/add", { anilistId: 70011, rootFolder: "/media/Anime" });
  assert.equal(add.statusCode, 409, add.body);
  assert.match(JSON.parse(add.body).error, /blocked/i);
});

test("Unblock: off the list, its exclusions cleared, and Add no longer refuses it as blocked", async () => {
  sonarrShow(11, 8018, "Unblock Me", "/media/Anime/Unblock Me");
  assert.equal((await dropDelete(8018)).statusCode, 200);
  const r = await del("/api/blocked/8018");
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(JSON.parse((await get("/api/blocked")).body), []);
  assert.equal(isDropped(8018), false);
  assert.equal(db.prepare("SELECT 1 FROM import_list_exclusions WHERE tvdb_id = 8018").get(), undefined);
  const add = await post("/api/add", { anilistId: 70011, rootFolder: "/media/Anime" });
  assert.doesNotMatch(add.body, /blocked|dropped/i, add.body);
});

test("Add anyway: unblocks first, then adds as usual", async () => {
  sonarrShow(11, 8019, "Anyway", "/media/Anime/Anyway");
  assert.equal((await dropDelete(8019)).statusCode, 200);
  const add = await post("/api/add", { anilistId: 70011, rootFolder: "/media/Anime", unblock: true });
  assert.doesNotMatch(add.body, /blocked|dropped/i, add.body);
  assert.equal(isBlocked(8019), false);
});
