/**
 * Episode and season delete (Show page ⋯ → Delete file, Delete season files…) over HTTP, logged in.
 *
 * The rule: AnimeArr never calls Sonarr for anime. Sonarr's records are only the user's backup; this delete works on
 * AnimeArr's own records, its own files and its own recycling bin only. The video and its sidecars (subtitles, nfo,
 * thumb) go to AnimeArr's bin, the records say "missing" at once, and nothing is ever hard-deleted.
 *
 * Failure modes, one test each: any Sonarr call (counted, Sonarr down), a file outside the show's folder, a show whose
 * folder is a library root, the bin unusable, a move failing part-way, a season delete, a double request.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-epbin-"));
process.env.ANIMEARR_NO_LOCK = "1";
process.env.ANIMEARR_TEST_APP = "1";
process.env.LOG_LEVEL = "silent";
fs.mkdirSync(path.join(process.env.ANIMEARR_CONFIG, "cache"), { recursive: true });
fs.writeFileSync(path.join(process.env.ANIMEARR_CONFIG, "cache", "anime-list-master.xml"), "<anime-list></anime-list>");

const { setAccount, patchSettings } = await import("../server/system/settings.js");
await setAccount("captain", "pw-test-1");
const { app } = await import("../server/index.js");
const { cache, db } = await import("../server/system/db.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-epbin-lib-"));
const LIB = path.join(tmp, "Anime");
const BIN = path.join(tmp, "Recycle", "animearr");
const write = (p: string, body = "x") => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, body));

// ---------------------------------------------------------------- Sonarr: every call is counted; this delete must make none

let sonarrCalls: string[] = [];
const realFetch = globalThis.fetch;
let cookie = "";
before(async () => {
  globalThis.fetch = (async (u: string | URL) => {
    const url = new URL(String(u));
    if (url.hostname !== "sonarr.test") return realFetch(u);
    sonarrCalls.push(url.pathname);
    throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
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
const delEpisodes = (episodeIds: number[]) => post("/api/episodes/delete", { tvdbId: TVDB, episodeIds, confirm: true });
const delSeason = (season: number) => post(`/api/series/${TVDB}/seasons/${season}/delete`, { confirm: true });

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
    managed: { ...s.managed, dryRun: false },
  }));

// ---------------------------------------------------------------- one managed show whose record Sonarr holds

const TVDB = 9101;
const SID = 21;
const SHOW = "/media/Anime/Bin Show";
const SHOW_LOCAL = path.join(LIB, "Bin Show");
// episode id → [season, episode, file id, file path (library path)]
const EPS: [number, number, number, number | null, string | null][] = [
  [2101, 1, 1, 3101, `${SHOW}/Season 01/Bin Show - S01E01.mkv`],
  [2102, 1, 2, 3102, `${SHOW}/Season 01/Bin Show - S01E02.mkv`],
  [2103, 1, 3, 3103, `${SHOW}/Season 01/Bin Show - S01E03.mkv`],
  [2104, 1, 4, 3104, "/media/Anime/Other Show/Season 01/Other - S01E01.mkv"], // the record points outside the show
  [2105, 1, 5, null, null], // no file
  [2201, 2, 1, 3201, `${SHOW}/Season 02/Bin Show - S02E01.mkv`],
];
const local = (arr: string) => path.join(tmp, ...arr.slice("/media/".length).split("/"));
const inBin = (arr: string) => path.join(BIN, ...arr.slice("/media/Anime/".length).split("/"));
const SIDECARS = [".en.ass", ".nfo", "-thumb.jpg"];
const sidecarsOf = (arr: string) => SIDECARS.map((s) => arr.replace(/\.mkv$/, s));

function seed(o: { showPath?: string } = {}) {
  const showPath = o.showPath ?? SHOW;
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, root_folder, monitored, series_type, synced_at) VALUES (?, ?, 'Bin Show', ?, '/media/Anime', 1, 'anime', 0)",
    )
    .run(SID, TVDB, showPath);
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (?, ?, 'Bin Show', 0, 0)").run(TVDB, SID);
  const insE = cache.prepare(
    "INSERT INTO episodes (id, series_id, season, episode, title, air_utc, monitored, has_file, file_id, runtime) VALUES (?, ?, ?, ?, 'x', 0, 1, ?, ?, 24)",
  );
  const insF = cache.prepare("INSERT INTO files (id, series_id, season, path, size) VALUES (?, ?, ?, ?, 5)");
  for (const [id, season, ep, fileId, arr] of EPS) {
    insE.run(id, SID, season, ep, fileId ? 1 : 0, fileId);
    if (!fileId || !arr) continue;
    insF.run(fileId, SID, season, arr);
    write(local(arr), "video");
    for (const s of sidecarsOf(arr)) write(local(s), "side");
    db.prepare("INSERT INTO media_files (path, root, size, mtime, seen_at) VALUES (?, '/media/Anime', 5, 0, 0)").run(arr);
    db.prepare("INSERT INTO file_links (path, tvdb_id, episode_ids, at) VALUES (?, ?, ?, 0)").run(arr, TVDB, JSON.stringify([id]));
  }
  // Not a sidecar of S01E01 ("Show - 01.5.ass" belongs to another file), and the show's own poster: both stay.
  write(path.join(SHOW_LOCAL, "Season 01", "Bin Show - S01E01.5.ass"), "other");
  write(path.join(SHOW_LOCAL, "poster.jpg"), "poster");
}

const hasFile = (id: number) =>
  cache.prepare("SELECT has_file, file_id FROM episodes WHERE id = ?").get(id) as { has_file: number; file_id: number | null };
const recorded = (arr: string) => ({
  media: !!db.prepare("SELECT 1 FROM media_files WHERE path = ?").get(arr),
  link: !!db.prepare("SELECT 1 FROM file_links WHERE path = ?").get(arr),
});
const binFiles = () => {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }))
      e.isDirectory() ? walk(path.join(d, e.name)) : out.push(path.relative(BIN, path.join(d, e.name)).split(path.sep).join("/"));
  };
  walk(BIN);
  return out.sort();
};
const stays = (arr: string) => {
  assert.ok(fs.existsSync(local(arr)), `${arr} stays`);
  for (const s of sidecarsOf(arr)) assert.ok(fs.existsSync(local(s)), `${s} stays`);
};

beforeEach(() => {
  for (const d of [LIB, path.join(tmp, "Recycle")]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(LIB, { recursive: true });
  for (const t of ["grabs", "recycle_log", "managed", "media_files", "file_links", "file_meta"]) db.prepare(`DELETE FROM ${t}`).run();
  for (const t of ["series", "episodes", "files"]) cache.prepare(`DELETE FROM ${t}`).run();
  sonarrCalls = [];
  useBin();
});

// ---------------------------------------------------------------- the tests

test("one episode: the file goes to AnimeArr's bin, never through Sonarr (any Sonarr call fails this)", async () => {
  seed();
  const r = await delEpisodes([2101]);
  assert.equal(r.statusCode, 200, r.body);
  const body = JSON.parse(r.body) as { deleted: { episodeId: number }[]; skipped: unknown[]; affected: number[]; askSearch: boolean };
  assert.deepEqual(
    body.deleted.map((d) => d.episodeId),
    [2101],
    r.body,
  );
  assert.deepEqual(body.skipped, []);
  assert.deepEqual(body.affected, [2101]);
  assert.equal(body.askSearch, true, "a managed, live show asks to search again");
  assert.deepEqual(sonarrCalls, [], "no Sonarr call at all: no delete, no lookup, no rescan, no recycle-bin setting");
  const arr = EPS[0][4]!;
  assert.equal(fs.existsSync(local(arr)), false, "gone from the library");
  assert.ok(fs.existsSync(inBin(arr)), "in AnimeArr's bin, under the show's folder");
  assert.ok(db.prepare("SELECT 1 FROM recycle_log WHERE path = ?").get(path.resolve(inBin(arr))), "the bin's clock starts now");
});

test("its sidecars (subtitles, nfo, thumb) go with it; another file's subtitle and the show's poster stay", async () => {
  seed();
  const r = await delEpisodes([2101]);
  assert.equal(r.statusCode, 200, r.body);
  const arr = EPS[0][4]!;
  for (const s of sidecarsOf(arr)) {
    assert.equal(fs.existsSync(local(s)), false, `${s} left the library`);
    assert.ok(fs.existsSync(inBin(s)), `${s} is in the bin`);
  }
  assert.ok(fs.existsSync(path.join(SHOW_LOCAL, "Season 01", "Bin Show - S01E01.5.ass")), "S01E01.5's subtitle stays");
  assert.ok(fs.existsSync(path.join(SHOW_LOCAL, "poster.jpg")), "the poster stays");
  stays(EPS[1][4]!);
});

test("records: the episode is missing at once, its file rows go, its per-file rows follow it into the bin", async () => {
  seed();
  const r = await delEpisodes([2101]);
  assert.equal(r.statusCode, 200, r.body);
  const arr = EPS[0][4]!;
  assert.deepEqual({ ...hasFile(2101) }, { has_file: 0, file_id: null });
  assert.equal(cache.prepare("SELECT 1 FROM files WHERE id = 3101").get(), undefined);
  assert.deepEqual(recorded(arr), { media: false, link: false });
  assert.ok(db.prepare("SELECT 1 FROM file_links WHERE path = ?").get("/media/Recycle/animearr/Bin Show/Season 01/Bin Show - S01E01.mkv"));
  // The UI's view: the episode row says missing.
  const { episodeRows } = await import("../server/library/episodes.js");
  assert.equal(episodeRows(SID).find((e) => e.id === 2101)?.status, "missing");
  assert.deepEqual({ ...hasFile(2102) }, { has_file: 1, file_id: 3102 }, "the neighbour keeps its file");
  assert.deepEqual(sonarrCalls, []);
});

test("a file outside the show's folder is refused (nothing moves); so is a show whose folder is a library root", async () => {
  seed();
  write(local(EPS[3][4]!), "someone else's");
  const r = await delEpisodes([2104]);
  assert.equal(r.statusCode, 200, r.body);
  const body = JSON.parse(r.body) as { deleted: unknown[]; skipped: { episodeId: number; why: string }[] };
  assert.deepEqual(body.deleted, []);
  assert.match(body.skipped[0].why, /outside the show's folder/);
  assert.ok(fs.existsSync(local(EPS[3][4]!)), "the other show's file stays");
  assert.deepEqual({ ...hasFile(2104) }, { has_file: 1, file_id: 3104 });
  assert.deepEqual(binFiles(), []);
  // The show's record says its folder is the library root itself: never a root.
  for (const t of ["series", "episodes", "files"]) cache.prepare(`DELETE FROM ${t}`).run();
  for (const t of ["managed", "media_files", "file_links"]) db.prepare(`DELETE FROM ${t}`).run();
  seed({ showPath: "/media/Anime" });
  const r2 = await delEpisodes([2101]);
  const why =
    r2.statusCode === 200 ? (JSON.parse(r2.body) as { skipped: { why: string }[] }).skipped.map((s) => s.why).join("; ") : r2.body;
  assert.match(why, /root/i, r2.body);
  stays(EPS[0][4]!);
  assert.deepEqual(binFiles(), []);
  assert.deepEqual(sonarrCalls, []);
});

test("the bin unusable (not set, or inside the library): refused with a clear reason, nothing changes", async () => {
  for (const bin of ["", "/media/Anime/Recycle"]) {
    for (const t of ["series", "episodes", "files"]) cache.prepare(`DELETE FROM ${t}`).run();
    for (const t of ["managed", "media_files", "file_links"]) db.prepare(`DELETE FROM ${t}`).run();
    useBin(bin);
    seed();
    for (const res of [await delEpisodes([2101]), await delSeason(1)]) {
      assert.equal(res.statusCode, 409, res.body);
      assert.match(JSON.parse(res.body).error ?? res.body, /recycling bin/i);
      assert.doesNotMatch(res.body, /Sonarr/);
    }
    stays(EPS[0][4]!);
    assert.deepEqual({ ...hasFile(2101) }, { has_file: 1, file_id: 3101 });
    assert.deepEqual(recorded(EPS[0][4]!), { media: true, link: true });
    assert.deepEqual(binFiles(), []);
  }
  assert.deepEqual(sonarrCalls, [], "no fallback to Sonarr");
});

test("a move failing part-way is reported honestly: what moved is recorded as gone, what's left stays recorded", async () => {
  seed();
  const hooks = (await import("../server/library/episodeBin.js")) as { episodeBinDeps: { move: (a: string, b: string) => Promise<void> } };
  const realMove = hooks.episodeBinDeps.move;
  // S01E02's video is locked: its sidecars already moved must come back, S01E01 and S01E03 still go.
  hooks.episodeBinDeps.move = async (a, b) => {
    if (a.endsWith("Bin Show - S01E02.mkv")) throw new Error("EBUSY: file in use");
    return realMove(a, b);
  };
  try {
    const r = await delSeason(1);
    assert.equal(r.statusCode, 200, r.body);
    const body = JSON.parse(r.body) as { deleted: { episodeId: number }[]; skipped: { episodeId: number; why: string }[] };
    assert.deepEqual(body.deleted.map((d) => d.episodeId).sort(), [2101, 2103]);
    const why = new Map(body.skipped.map((s) => [s.episodeId, s.why]));
    assert.match(why.get(2102)!, /EBUSY/);
    assert.match(why.get(2104)!, /outside the show's folder/);
    stays(EPS[1][4]!);
    assert.deepEqual({ ...hasFile(2102) }, { has_file: 1, file_id: 3102 }, "still recorded");
    assert.deepEqual(recorded(EPS[1][4]!), { media: true, link: true });
    assert.deepEqual({ ...hasFile(2101) }, { has_file: 0, file_id: null });
    assert.deepEqual({ ...hasFile(2103) }, { has_file: 0, file_id: null });
    assert.ok(!binFiles().some((f) => f.includes("S01E02")), `nothing of S01E02 in the bin: ${binFiles().join(", ")}`);
  } finally {
    hooks.episodeBinDeps.move = realMove;
  }
  assert.deepEqual(sonarrCalls, []);
});

test("a sidecar that can't be put back after a failed move is named, and the episode stays recorded", async () => {
  seed();
  const hooks = (await import("../server/library/episodeBin.js")) as { episodeBinDeps: { move: (a: string, b: string) => Promise<void> } };
  const realMove = hooks.episodeBinDeps.move;
  hooks.episodeBinDeps.move = async (a, b) => {
    if (a.endsWith("Bin Show - S01E01.mkv")) throw new Error("EBUSY: file in use");
    if (a.startsWith(BIN) && a.endsWith(".nfo")) throw new Error("EACCES: no way back");
    return realMove(a, b);
  };
  try {
    const r = await delEpisodes([2101]);
    assert.equal(r.statusCode, 200, r.body);
    const body = JSON.parse(r.body) as { deleted: unknown[]; skipped: { why: string }[] };
    assert.deepEqual(body.deleted, []);
    assert.match(body.skipped[0].why, /EBUSY/);
    assert.match(body.skipped[0].why, /still in the bin: Bin Show - S01E01\.nfo/);
    assert.ok(fs.existsSync(local(EPS[0][4]!)), "the video stays");
    assert.deepEqual({ ...hasFile(2101) }, { has_file: 1, file_id: 3101 }, "still recorded");
  } finally {
    hooks.episodeBinDeps.move = realMove;
  }
});

test("a season delete covers every episode of that season, and only that season", async () => {
  seed();
  const r = await delSeason(1);
  assert.equal(r.statusCode, 200, r.body);
  const body = JSON.parse(r.body) as { asked: number; deleted: { episodeId: number }[]; skipped: { episodeId: number; why: string }[] };
  assert.deepEqual(body.deleted.map((d) => d.episodeId).sort(), [2101, 2102, 2103]);
  for (const [, season, , , arr] of EPS) {
    if (!arr || season !== 1 || arr.includes("Other Show")) continue;
    assert.ok(fs.existsSync(inBin(arr)), `${arr} in the bin`);
    for (const s of sidecarsOf(arr)) assert.ok(fs.existsSync(inBin(s)), `${s} in the bin`);
  }
  stays(EPS[5][4]!);
  assert.deepEqual({ ...hasFile(2201) }, { has_file: 1, file_id: 3201 }, "season 2 untouched");
  assert.equal(
    (cache.prepare("SELECT COUNT(*) AS n FROM episodes WHERE series_id = ? AND season = 1 AND has_file = 1").get(SID) as { n: number }).n,
    1,
    "only the refused outside file",
  );
  assert.deepEqual(sonarrCalls, []);
});

test("a double request (double click, two tabs, a retry) never moves the same file twice", async () => {
  seed();
  const [a, b] = await Promise.all([delEpisodes([2101, 2101]), delEpisodes([2101])]);
  const moved = [a, b]
    .filter((x) => x.statusCode === 200)
    .flatMap((x) => (JSON.parse(x.body) as { deleted: { episodeId: number }[] }).deleted);
  assert.equal(moved.length, 1, `${a.body} / ${b.body}`);
  const again = await delEpisodes([2101]);
  assert.equal(again.statusCode, 200, again.body);
  assert.deepEqual(JSON.parse(again.body).deleted, []);
  const arr = EPS[0][4]!;
  const copies = binFiles().filter((f) => f.includes("S01E01") && !f.includes("S01E01.5"));
  assert.equal(copies.length, 1 + SIDECARS.length, `each file once, never a stamped second copy: ${copies.join(", ")}`);
  assert.ok(fs.existsSync(inBin(arr)));
  assert.deepEqual(sonarrCalls, []);
});
