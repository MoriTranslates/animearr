/**
 * "Remove from AnimeArr" with "Also delete this show's folder and files" (DELETE /api/add/:tvdbId?files=1 and
 * /api/add/movie/:movieId?files=1, over HTTP, logged in). The folder goes to AnimeArr's recycling bin file by file
 * BEFORE the show is forgotten; anything unsafe or unknown refuses and leaves both the show and its files where they
 * were. Failure modes, one test each: bin unusable, folder missing, path is a root / holds a root / outside the roots /
 * empty, a folder another show shares, Sonarr owning the show, a link inside the folder, a move failing midway (put
 * back, and put back failing too), a double click, a download in progress.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-rmfiles-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";

const { setAccount, patchSettings } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");
const { cache, db } = await import("../server/system/db.js");
const NATIVE_BASE = 900_000_000;
// The move hook (a test seam). Missing on code without this feature: then the tests run without it and fail on behaviour.
const hooks = (await import("../server/library/removeFiles.js").catch(() => null)) as {
  removeFilesDeps: { move: (a: string, b: string) => Promise<void> };
} | null;
const realMove = hooks?.removeFilesDeps.move;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-rmfiles-lib-"));
const LIB = path.join(tmp, "Anime");
const BIN = path.join(tmp, "Recycle", "animearr");
const OUT = path.join(tmp, "Elsewhere");
const write = (p: string, body = "x") => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, body));

let cookie = "";
before(async () => {
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

const del = (url: string) => app.inject({ method: "DELETE", url, headers: { cookie, "x-animearr": "1" } });
const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });

const useBin = (bin = "/media/Recycle/animearr") =>
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/Anime"],
    localPathMappings: [
      { from: "/media", to: tmp },
      { from: "/media/Anime", to: LIB },
      { from: "/media/Recycle", to: path.join(tmp, "Recycle") },
      { from: "/elsewhere", to: OUT },
    ],
    media: { ...s.media, recycleBin: bin },
  }));

/** A native show (animearr.db) plus its materialized cache row, like addShow leaves them. */
function addShow(row: number, tvdbId: number, arrPath: string) {
  db.prepare(
    "INSERT INTO native_series (id, tvdb_id, anilist_id, synthetic, title, year, path, root_folder, added_at) VALUES (?, ?, ?, 0, ?, 2020, ?, '/media/Anime', 0)",
  ).run(row, tvdbId, 50_000 + row, `Show ${row}`, arrPath);
  cache
    .prepare("INSERT INTO series (id, tvdb_id, title, path, root_folder, monitored, synced_at) VALUES (?, ?, ?, ?, '/media/Anime', 1, 0)")
    .run(NATIVE_BASE + row, tvdbId, `Show ${row}`, arrPath);
}
const hasShow = (tvdbId: number) => !!db.prepare("SELECT 1 FROM native_series WHERE tvdb_id = ?").get(tvdbId);

/** A show folder with an episode, its subtitle and a poster (13 bytes in all). */
function fill(dir: string) {
  write(path.join(dir, "Season 01", "Ep 01.mkv"), "video");
  write(path.join(dir, "Season 01", "Ep 01.en.ass"), "subs");
  write(path.join(dir, "poster.jpg"), "jpg!");
}
const SHOW_FILES = [path.join("Season 01", "Ep 01.mkv"), path.join("Season 01", "Ep 01.en.ass"), "poster.jpg"];

beforeEach(() => {
  fs.rmSync(LIB, { recursive: true, force: true });
  fs.rmSync(BIN, { recursive: true, force: true });
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(LIB, { recursive: true });
  for (const t of ["native_series", "native_movies", "grabs", "recycle_log"]) db.prepare(`DELETE FROM ${t}`).run();
  for (const t of ["series", "movies"]) cache.prepare(`DELETE FROM ${t}`).run();
  useBin();
});
afterEach(() => {
  if (hooks && realMove) hooks.removeFilesDeps.move = realMove;
});

test("happy path: every file goes to the bin (same layout), then the show is forgotten; nothing hard-deleted", async () => {
  addShow(1, 7001, "/media/Anime/Show One");
  const dir = path.join(LIB, "Show One");
  fill(dir);
  const plan = await get("/api/add/7001/remove-plan");
  assert.equal(plan.statusCode, 200, plan.body);
  assert.deepEqual(
    { ...JSON.parse(plan.body), reason: undefined },
    { path: "/media/Anime/Show One", canDelete: true, exists: true, files: 3, bytes: 13, reason: undefined },
  );
  const r = await del("/api/add/7001?files=1");
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(JSON.parse(r.body).binned.moved, 3);
  assert.equal(hasShow(7001), false, "forgotten after the move");
  assert.equal(fs.existsSync(dir), false, "the empty show folder is gone");
  for (const f of SHOW_FILES) assert.ok(fs.existsSync(path.join(BIN, "Show One", f)), `${f} is in the bin`);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM recycle_log").get() as { n: number }).n, 3, "the bin's retention starts now");
});

test("without the box ticked, the files are left alone (the old behaviour)", async () => {
  addShow(1, 7002, "/media/Anime/Kept");
  fill(path.join(LIB, "Kept"));
  const r = await del("/api/add/7002");
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(hasShow(7002), false);
  for (const f of SHOW_FILES) assert.ok(fs.existsSync(path.join(LIB, "Kept", f)));
});

test("bin unusable (none set, or inside the library): refused, the show and every file stay", async () => {
  for (const bin of ["", "/media/Anime/Recycle"]) {
    useBin(bin);
    addShow(1, 7003, "/media/Anime/No Bin");
    fill(path.join(LIB, "No Bin"));
    const plan = JSON.parse((await get("/api/add/7003/remove-plan")).body);
    assert.equal(plan.canDelete, false, bin);
    assert.match(plan.reason ?? "", /recycling bin/);
    const r = await del("/api/add/7003?files=1");
    assert.equal(r.statusCode, 409, r.body);
    assert.match(r.body, /recycling bin/);
    assert.equal(hasShow(7003), true, "never forgotten when the files couldn't go");
    for (const f of SHOW_FILES) assert.ok(fs.existsSync(path.join(LIB, "No Bin", f)));
    db.prepare("DELETE FROM native_series").run();
    cache.prepare("DELETE FROM series").run();
  }
});

test("folder already gone: the show is removed, nothing moved, and the answer says so", async () => {
  addShow(1, 7004, "/media/Anime/Gone");
  const plan = JSON.parse((await get("/api/add/7004/remove-plan")).body);
  assert.equal(plan.exists, false);
  const r = await del("/api/add/7004?files=1");
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(JSON.parse(r.body).binned.folderMissing, true);
  assert.equal(JSON.parse(r.body).binned.moved, 0);
  assert.equal(hasShow(7004), false);
});

test("a show whose path is a root, holds a root, is outside the roots, too deep or empty: refused, nothing moves", async () => {
  write(path.join(LIB, "Other Show", "e.mkv"));
  write(path.join(OUT, "Show", "e.mkv"));
  write(path.join(LIB, "Group", "Deep", "e.mkv"));
  const cases: [string, RegExp][] = [
    ["/media/Anime", /root/],
    ["/media/Anime/", /root/],
    ["/media", /root/],
    ["/elsewhere/Show", /root/],
    ["/media/Anime/Group/Deep", /root/],
    ["/media/Anime/../Elsewhere/Show", /root/],
    ["", /no folder/],
    ["   ", /no folder/],
  ];
  let row = 10;
  for (const [p, why] of cases) {
    row++;
    addShow(row, 7000 + row, p);
    const plan = JSON.parse((await get(`/api/add/${7000 + row}/remove-plan`)).body);
    assert.equal(plan.canDelete, false, p);
    const r = await del(`/api/add/${7000 + row}?files=1`);
    assert.equal(r.statusCode, 409, `${p}: ${r.body}`);
    assert.match(JSON.parse(r.body).error, why, p);
    assert.equal(hasShow(7000 + row), true, p);
  }
  assert.ok(fs.existsSync(path.join(LIB, "Other Show", "e.mkv")));
  assert.ok(fs.existsSync(path.join(OUT, "Show", "e.mkv")));
  assert.ok(fs.existsSync(path.join(LIB, "Group", "Deep", "e.mkv")));
  assert.equal(fs.existsSync(BIN), false, "nothing went into the bin");
});

test("a folder another show (or Sonarr's copy of this show) also uses: refused", async () => {
  addShow(1, 7020, "/media/Anime/Shared");
  fill(path.join(LIB, "Shared"));
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, root_folder, monitored, synced_at) VALUES (5, 9999, 'Other', ?, '/media/Anime', 1, 0)",
    )
    .run("/media/Anime/Shared");
  let r = await del("/api/add/7020?files=1");
  assert.equal(r.statusCode, 409, r.body);
  assert.match(JSON.parse(r.body).error, /another show|also uses/);
  assert.equal(hasShow(7020), true);
  cache.prepare("DELETE FROM series WHERE id = 5").run();
  // Sonarr has the same show (its copy is the one in use): its files aren't AnimeArr's to bin.
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, root_folder, monitored, synced_at) VALUES (6, 7020, 'Sonarr copy', ?, '/media/Anime', 1, 0)",
    )
    .run("/media/Anime/Sonarr Copy");
  r = await del("/api/add/7020?files=1");
  assert.equal(r.statusCode, 409, r.body);
  assert.match(JSON.parse(r.body).error, /Sonarr/);
  assert.equal(hasShow(7020), true);
  for (const f of SHOW_FILES) assert.ok(fs.existsSync(path.join(LIB, "Shared", f)));
});

test("a link inside the folder: refused (never followed out of the folder)", async (t) => {
  addShow(1, 7030, "/media/Anime/Linked");
  fill(path.join(LIB, "Linked"));
  write(path.join(OUT, "precious.mkv"));
  try {
    fs.symlinkSync(OUT, path.join(LIB, "Linked", "extras"), "junction");
  } catch {
    t.skip("can't make a link here");
    return;
  }
  const r = await del("/api/add/7030?files=1");
  assert.equal(r.statusCode, 409, r.body);
  assert.match(JSON.parse(r.body).error, /link/);
  assert.equal(hasShow(7030), true);
  assert.ok(fs.existsSync(path.join(OUT, "precious.mkv")));
  for (const f of SHOW_FILES) assert.ok(fs.existsSync(path.join(LIB, "Linked", f)));
});

test("a download in progress for the show: refused until it finishes", async () => {
  addShow(1, 7040, "/media/Anime/Busy");
  fill(path.join(LIB, "Busy"));
  db.prepare(
    "INSERT INTO grabs (at, updated_at, tvdb_id, episode_ids, release, guid, protocol, state, dry_run) VALUES (0, 0, 7040, '[]', 'r', 'g', 'torrent', 'downloading', 0)",
  ).run();
  const r = await del("/api/add/7040?files=1");
  assert.equal(r.statusCode, 409, r.body);
  assert.match(JSON.parse(r.body).error, /download/);
  assert.equal(hasShow(7040), true);
  for (const f of SHOW_FILES) assert.ok(fs.existsSync(path.join(LIB, "Busy", f)));
});

test("a move that fails midway: what moved comes back, the show stays, and the answer says what happened", async () => {
  addShow(1, 7050, "/media/Anime/Midway");
  const dir = path.join(LIB, "Midway");
  fill(dir);
  let n = 0;
  if (hooks && realMove)
    hooks.removeFilesDeps.move = async (a, b) => {
      if (++n === 2) throw new Error("disk full");
      await realMove(a, b);
    };
  const r = await del("/api/add/7050?files=1");
  assert.equal(r.statusCode, 500, r.body);
  const msg = JSON.parse(r.body).error as string;
  assert.match(msg, /disk full/);
  assert.match(msg, /still in AnimeArr/);
  assert.match(msg, /put back/);
  assert.equal(hasShow(7050), true);
  for (const f of SHOW_FILES) assert.ok(fs.existsSync(path.join(dir, f)), `${f} is back in the show folder`);
});

test("a move that fails midway AND can't put a file back: the show stays and the stranded file is named", async () => {
  addShow(1, 7051, "/media/Anime/Stranded");
  const dir = path.join(LIB, "Stranded");
  fill(dir);
  let n = 0;
  if (hooks && realMove)
    hooks.removeFilesDeps.move = async (a, b) => {
      n++;
      if (n === 2) throw new Error("disk full");
      if (n === 3) throw new Error("locked"); // the put-back of file 1
      await realMove(a, b);
    };
  const r = await del("/api/add/7051?files=1");
  assert.equal(r.statusCode, 500, r.body);
  const msg = JSON.parse(r.body).error as string;
  assert.match(msg, /still in the recycling bin/);
  assert.match(msg, /still in AnimeArr/);
  assert.equal(hasShow(7051), true);
});

test("a double click (two requests at once): the second is refused while the first runs; files move once", async () => {
  addShow(1, 7060, "/media/Anime/Twice");
  fill(path.join(LIB, "Twice"));
  let open!: () => void;
  const gate = new Promise<void>((res) => (open = res));
  if (hooks && realMove)
    hooks.removeFilesDeps.move = async (a, b) => {
      await gate;
      await realMove(a, b);
    };
  const first = del("/api/add/7060?files=1");
  await new Promise((res) => setTimeout(res, 50));
  const second = await del("/api/add/7060?files=1");
  open?.();
  assert.equal(second.statusCode, 409, second.body);
  assert.match(JSON.parse(second.body).error, /already being removed/);
  const r = await first;
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(JSON.parse(r.body).binned.moved, 3);
  // Asked again afterwards: it's gone.
  assert.equal((await del("/api/add/7060?files=1")).statusCode, 404);
});

test("movies (one folder per movie): the same rule", async () => {
  db.prepare(
    "INSERT INTO native_movies (id, anilist_id, tmdb_id, title, year, path, root_folder, added_at) VALUES (1, 60001, NULL, 'Film', 2020, '/media/Anime/Film (2020)', '/media/Anime', 0)",
  ).run();
  cache
    .prepare(
      "INSERT INTO movies (id, title, path, root_folder, monitored, has_file, is_anime, synced_at) VALUES (?, 'Film', '/media/Anime/Film (2020)', '/media/Anime', 1, 1, 1, 0)",
    )
    .run(NATIVE_BASE + 1);
  write(path.join(LIB, "Film (2020)", "Film.mkv"), "movie");
  const plan = JSON.parse((await get(`/api/add/movie/${NATIVE_BASE + 1}/remove-plan`)).body);
  assert.equal(plan.canDelete, true, JSON.stringify(plan));
  assert.equal(plan.files, 1);
  const r = await del(`/api/add/movie/${NATIVE_BASE + 1}?files=1`);
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(fs.existsSync(path.join(BIN, "Film (2020)", "Film.mkv")));
  assert.equal(fs.existsSync(path.join(LIB, "Film (2020)")), false);
  assert.equal(db.prepare("SELECT 1 FROM native_movies").get(), undefined);
  // A movie whose path is the root: refused.
  db.prepare(
    "INSERT INTO native_movies (id, anilist_id, tmdb_id, title, year, path, root_folder, added_at) VALUES (2, 60002, NULL, 'Bad', 2020, '/media/Anime', '/media/Anime', 0)",
  ).run();
  const bad = await del(`/api/add/movie/${NATIVE_BASE + 2}?files=1`);
  assert.equal(bad.statusCode, 409, bad.body);
  assert.ok(db.prepare("SELECT 1 FROM native_movies WHERE id = 2").get());
});

test("a name already in the bin is never overwritten", async () => {
  addShow(1, 7070, "/media/Anime/Again");
  fill(path.join(LIB, "Again"));
  write(path.join(BIN, "Again", "poster.jpg"), "older");
  const r = await del("/api/add/7070?files=1");
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(fs.readFileSync(path.join(BIN, "Again", "poster.jpg"), "utf8"), "older");
  const kept = fs.readdirSync(path.join(BIN, "Again")).filter((f) => f.startsWith("poster") && f !== "poster.jpg");
  assert.equal(kept.length, 1, "the new poster sits next to it under a stamped name");
});
