/**
 * Manual import (Sonarr-like picker), batches that bundle a movie/special, series batches grabbed for a movie, leftover
 * temporary files and ASCII-safe JSON. Throwaway folders and mocks only.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-manual-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { movieSubtitles, namesSubtitle, fileForMovie, looksLikeEpisodes } = await import("../server/core/movieTitle.js");
const { browseImport, clearStalePart, planMovieImport } = await import("../server/importer.js");
const { searchMovie, startMovieGrab } = await import("../server/movies.js");
const { pipelineTick } = await import("../server/pipeline.js");
const { fixesFor } = await import("../server/fixes.js");
const { asciiJson } = await import("../server/json.js");
type Deps = import("../server/pipeline.js").PipelineDeps;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-manual-fs-"));
const DL = path.join(tmp, "dl");
const OTHER = path.join(tmp, "other");
const LIB = path.join(tmp, "movies");
const write = (p: string, s = "x", mtime?: number) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
  if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000);
};
const DAL = { title: "Date A Live: Date to Date", original_title: "デート・ア・ライブ DATE TO DATE", alt_titles: [] as string[], year: 2013 };
const BATCH = "[Beltraz] Date A Live [2013] [Directors Cut] [BD 1080p HEVC OPUS]";

before(() => {
  const ins = cache.prepare("INSERT INTO movies (id, tmdb_id, imdb_id, title, original_title, year, path, root_folder, monitored, has_file, runtime, quality_profile_id, tags, alt_titles, file, is_anime, poster, synced_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 1, 0, ?, 1, '[]', ?, NULL, 1, NULL, 0)");
  ins.run(1338, 1608694, DAL.title, DAL.original_title, 2013, "/media/Movies/Anime/Date A Live Date to Date (2013)", "/media/Movies/Anime", 24, "[]");
  ins.run(1355, 412383, "KanColle Movie", "劇場版 艦これ", 2016, "/media/Movies/Anime/KanColle Movie (2016)", "/media/Movies/Anime", 93, JSON.stringify(["Kantai Collection: KanColle Movie"]));
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/Movies/Anime"],
    managed: { ...s.managed, dryRun: false },
    localPathMappings: [{ from: "/media/Movies/Anime", to: LIB }, { from: "/data/completed/animearr", to: DL }, { from: "/data/other", to: OTHER }],
    importer: { ...s.importer, engine: "sonarr", sourceRoots: ["/data/completed/animearr"] },
  }));
});

test("subtitles: the part that tells a franchise movie apart; names carry it or not", () => {
  const subs = movieSubtitles([DAL.title, DAL.original_title, ...DAL.alt_titles]);
  assert.deepEqual(subs, ["date to date"]);
  assert.ok(namesSubtitle("[Beltraz] Date A Live - OVA - Date to Date", subs));
  assert.ok(namesSubtitle("Date.A.Live.Date.to.Date.2013.1080p.BluRay", subs));
  assert.ok(!namesSubtitle(BATCH, subs));
  // From a linked series title, without a separator.
  assert.deepEqual(movieSubtitles(["Date A Live Mayuri Judgement"], ["Date A Live"]), ["mayuri judgement"]);
  // Movies without a subtitle (or whose "subtitle" is only "The Movie"/a number) need nothing.
  assert.deepEqual(movieSubtitles(["Suzume", "Suzume no Tojimari"]), []);
  assert.deepEqual(movieSubtitles(["Pokémon: The Movie 2000"]), []);
  assert.deepEqual(movieSubtitles(["KanColle Movie"], ["KanColle"]), []);
});

test("files: the one named after the movie is picked; numbered episodes look like a series batch", () => {
  const subs = ["date to date"];
  const files = [...Array.from({ length: 12 }, (_, i) => ({ path: `/d/${BATCH}/[Beltraz] Date A Live - ${String(i + 1).padStart(2, "0")} - Title.mkv` })), { path: `/d/${BATCH}/Specials/[Beltraz] Date A Live - OVA - Date to Date.mkv` }];
  assert.equal(fileForMovie(files, subs)?.path, files[12].path);
  assert.equal(fileForMovie(files.slice(0, 12), subs), null);
  assert.ok(looksLikeEpisodes(files.slice(0, 12)));
  assert.ok(!looksLikeEpisodes([{ path: "/d/Movie Part 1.mkv" }, { path: "/d/Movie Part 2.mkv" }]), "two parts of one movie are not a batch");
  assert.ok(!looksLikeEpisodes([{ path: "/d/Movie.2016.1080p.mkv" }]));
});

const rel = (title: string, size = 6e9) => ({ guid: `g-${title}`, title, indexer: "X", indexerId: 1, protocol: "usenet" as const, size, seeders: null, downloadUrl: "http://x/dl", publishDate: new Date().toISOString() });

test("search: a batch that doesn't name the special stays a candidate, ranked below one that does", async () => {
  const r = await searchMovie(1338, async () => [rel(BATCH, 7e10), rel("[Beltraz] Date A Live - Date to Date [2013] [BD 1080p HEVC OPUS]", 4e8)] as never);
  assert.equal(r.matched, 2, JSON.stringify(r.skipped));
  assert.match(r.results[0].title, /Date to Date/);
  assert.equal(r.results[1].title, BATCH);
  assert.match(r.results[1].mappingWhy.join(" "), /doesn't name "date to date"/);
});

function deps(files: { path: string; size: number }[], imports: { path: string }[][], fetched: string[] = []): Deps {
  let imported = false;
  return {
    clients: { addNzb: async () => ({ client: "sabnzbd", ref: `nzo${fetched.length}` }), addTorrent: async () => ({ client: "qbittorrent", ref: "h" }), remove: async () => undefined, status: async () => ({ state: "completed", progress: 1, path: `/data/completed/animearr/${BATCH}` }) },
    fetchRelease: async (r) => (fetched.push(r.title), { data: Buffer.from("x"), filename: r.title }),
    sonarr: {} as never,
    radarr: {
      preview: async () => files.map((f) => ({ ...f, quality: {}, languages: [] })),
      importFiles: async (f) => (imports.push(f as { path: string }[]), (imported = true), { id: 1 }),
      command: async () => ({ id: 1, status: "completed" }),
      movie: async (id) => ({ id, tmdbId: 1, title: DAL.title, year: 2013, path: "/media/Movies/Anime/Date A Live Date to Date (2013)", monitored: true, hasFile: imported, qualityProfileId: 1, tags: [], runtime: 24, movieFile: { path: "/media/Movies/Anime/Date A Live Date to Date (2013)/x.mkv", dateAdded: new Date().toISOString(), mediaInfo: { subtitles: "eng", audioLanguages: "jpn" } } }),
    },
    probe: async () => {
      throw new Error("unreachable");
    },
    localPath: () => null,
    sleep: async () => undefined,
  };
}
const cand = (title: string) => ({ guid: `g-${title}`, title, indexerId: 1, indexer: "X", protocol: "usenet" as const, size: 6e9, downloadUrl: "http://x/dl", label: "Date A Live: Date to Date (2013)", group: null, why: "test", episodeIds: [] });
const folder = `/data/completed/animearr/${BATCH}`;
const episodes = Array.from({ length: 12 }, (_, i) => ({ path: `${folder}/[Beltraz] Date A Live - ${String(i + 1).padStart(2, "0")} - Ep.mkv`, size: 5e9 + i }));

test("import: a season batch that bundles the special imports just the special", async () => {
  const imports: { path: string }[][] = [];
  const special = { path: `${folder}/Specials/[Beltraz] Date A Live - OVA - Date to Date.mkv`, size: 3.7e8 };
  const d = deps([...episodes, special], imports);
  const g = await startMovieGrab({ movieId: 1338, candidate: cand(BATCH), fallbacks: [], origin: "manual" }, d);
  await pipelineTick(d);
  const row = db.prepare("SELECT state, error FROM grabs WHERE id = ?").get(g.id) as { state: string; error: string | null };
  assert.equal(row.state, "done", row.error ?? "");
  assert.deepEqual(imports.map((f) => f.map((x) => path.posix.basename(x.path))), [["[Beltraz] Date A Live - OVA - Date to Date.mkv"]]);
  cache.prepare("UPDATE movies SET has_file = 0, file = NULL WHERE id = 1338").run();
});

test("import: a season batch without the special is the wrong release: blocklisted, next candidate grabbed", async () => {
  db.prepare("UPDATE grabs SET state = 'failed' WHERE movie_id = 1338 AND state != 'failed'").run();
  const imports: { path: string }[][] = [];
  const fetched: string[] = [];
  const d = deps(episodes, imports, fetched);
  const other = `${BATCH} v2`;
  const g = await startMovieGrab({ movieId: 1338, candidate: cand(other), fallbacks: [cand("[Grp] Date A Live Date to Date (2013) [BD]")], origin: "manual" }, d);
  await pipelineTick(d);
  const row = db.prepare("SELECT state, error FROM grabs WHERE id = ?").get(g.id) as { state: string; error: string | null };
  assert.equal(row.state, "failed");
  assert.match(row.error ?? "", /wrong release: this is a series batch \(12 numbered episodes, none of them named "date to date"\)/);
  assert.ok(db.prepare("SELECT 1 FROM blocklist WHERE release = ? AND movie_id = 1338").get(other), "blocklisted for the movie");
  assert.deepEqual(fetched, [other, "[Grp] Date A Live Date to Date (2013) [BD]"], "the next candidate was grabbed");
  assert.equal(imports.length, 0, "nothing imported, nobody asked to pick by hand");
});

test("import: two big files that aren't episodes are still for the user to pick", async () => {
  db.prepare("UPDATE grabs SET state = 'failed' WHERE movie_id = 1338 AND state != 'failed'").run();
  const imports: { path: string }[][] = [];
  const d = deps([{ path: `${folder}/Movie A.mkv`, size: 5e9 }, { path: `${folder}/Other Film.mkv`, size: 4e9 }], imports);
  const g = await startMovieGrab({ movieId: 1338, candidate: cand("[X] Date A Live Date to Date two"), fallbacks: [], origin: "manual" }, d);
  await pipelineTick(d);
  const row = db.prepare("SELECT state, error FROM grabs WHERE id = ?").get(g.id) as { state: string; error: string | null };
  assert.equal(row.state, "needs-attention");
  assert.match(row.error ?? "", /several large video files/);
  const fix = fixesFor(row.error!, { grabId: g.id, movieId: 1338 }).find((f) => f.action === "importManual");
  assert.deepEqual(fix?.params, { movieId: 1338, path: null, grabId: g.id }, "the dialog starts in the grab's download");
});

test("manual movie plan of a batch folder picks the special; the episodes are left alone", async () => {
  const dir = path.join(DL, "plan-batch");
  for (let i = 1; i <= 3; i++) write(path.join(dir, `[Beltraz] Date A Live - 0${i} - Ep.mkv`), "e".repeat(50));
  write(path.join(dir, "Specials", "[Beltraz] Date A Live - OVA - Date to Date.mkv"), "s".repeat(10));
  const plan = await planMovieImport({ movieId: 1338, path: "/data/completed/animearr/plan-batch" }, { probe: async () => null as never, minBytes: 0 });
  assert.equal(plan.items.length, 1);
  assert.equal(path.basename(plan.items[0].source), "[Beltraz] Date A Live - OVA - Date to Date.mkv");
  assert.equal(plan.items[0].problem, null);
  assert.match(plan.notes.join(" "), /picked .*Date to Date/);
});

test("browse: only inside the download roots, newest first, sizes and videos flagged", () => {
  const now = Date.now();
  write(path.join(DL, "old", "a.mkv"), "a".repeat(100), now - 86_400_000);
  fs.utimesSync(path.join(DL, "old"), (now - 86_400_000) / 1000, (now - 86_400_000) / 1000);
  write(path.join(DL, "new", "b.mkv"), "b".repeat(30));
  write(path.join(DL, "new", "b.nfo"), "n");
  write(path.join(OTHER, "secret.mkv"), "s");
  const roots = browseImport({});
  assert.deepEqual(roots.entries.map((e) => e.path), ["/data/completed/animearr"]);
  const top = browseImport({ path: "/data/completed/animearr" });
  assert.equal(top.parent, null);
  const names = top.entries.map((e) => e.name);
  assert.ok(names.indexOf("new") < names.indexOf("old"), "newest first");
  const nw = top.entries.find((e) => e.name === "new")!;
  assert.equal(nw.dir, true);
  assert.equal(nw.videos, 1);
  assert.equal(nw.size, 31);
  const inside = browseImport({ path: "/data/completed/animearr/new" });
  assert.equal(inside.parent, "/data/completed/animearr");
  assert.deepEqual(inside.entries.map((e) => [e.name, e.video]).sort(), [["b.mkv", true], ["b.nfo", false]]);
  assert.throws(() => browseImport({ path: "/data/completed/animearr/../other" }), /isn't allowed/);
  assert.throws(() => browseImport({ path: "/data/other" }), /only browses/);
  assert.throws(() => browseImport({ path: "/etc" }), /only browses/);
  // A symlink pointing out of the root is neither listed nor followed.
  try {
    fs.symlinkSync(OTHER, path.join(DL, "escape"), "dir");
    assert.ok(!browseImport({ path: "/data/completed/animearr" }).entries.some((e) => e.name === "escape"));
    assert.throws(() => browseImport({ path: "/data/completed/animearr/escape" }), /only browses/);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e; // Windows without symlink rights
  }
  // The grab's own download folder (resolved by the server) is browsable too.
  assert.equal(browseImport({ path: "/data/other", extra: ["/data/other"] }).entries[0].name, "secret.mkv");
});

test("browse: a grab whose download is one file outside the roots shows that file, and nothing beside it", () => {
  write(path.join(OTHER, "single", "[RUDY] Quints - 01.mkv"), "x".repeat(10));
  write(path.join(OTHER, "single", "neighbour.mkv"), "y");
  const grab = "/data/other/single/[RUDY] Quints - 01.mkv";
  const r = browseImport({ path: grab, extra: [grab] });
  assert.equal(r.path, grab);
  assert.equal(r.parent, null, "no way up out of a single-file download");
  assert.deepEqual(r.entries.map((e) => [e.name, e.dir, e.video]), [["[RUDY] Quints - 01.mkv", false, true]]);
  assert.ok(browseImport({ extra: [grab] }).entries.some((e) => e.path === grab), "listed among the roots");
  assert.throws(() => browseImport({ path: "/data/other/single", extra: [grab] }), /only browses/);
  assert.throws(() => browseImport({ path: "/data/other/single/neighbour.mkv", extra: [grab] }), /only browses/);
  // Without the grab, the same file stays off limits (a typed path can't reach it).
  assert.throws(() => browseImport({ path: grab }), /only browses/);
});

test("a leftover .animearr-part from a cut-off import is cleared before the retry (only while the source exists)", () => {
  const src = path.join(DL, "kc", "KanColle.mkv");
  write(src, "movie");
  const part = path.join(LIB, "KanColle Movie (2016)", "KanColle Movie (2016).mkv.animearr-part");
  write(part, "half");
  assert.equal(clearStalePart(part, src), true);
  assert.ok(!fs.existsSync(part));
  write(part, "only copy");
  assert.equal(clearStalePart(part, path.join(DL, "kc", "gone.mkv")), false, "the source is gone: the part may be the only copy");
  assert.ok(fs.existsSync(part));
  assert.equal(clearStalePart(path.join(LIB, "x.mkv"), src), false, "never anything but a part file");
});

test("fixes: an import that broke off offers the manual import from the grab", () => {
  const f = fixesFor("AnimeArr restarted during the import; check the show folder, then retry the import", { grabId: 80, movieId: 1355 });
  assert.ok(f.some((x) => x.action === "importManual" && (x.params as { grabId: number }).grabId === 80));
  assert.ok(!fixesFor("real movie imports by AnimeArr's importer are switched off (Settings)", { grabId: 1, movieId: 1 }).some((x) => x.action === "importManual"));
});

test("JSON responses are ASCII-only (a client that decodes as cp1252 can't garble them)", () => {
  const v = { label: "Import manually…", jp: "デート・ア・ライブ", emoji: "✓ 🎬" };
  const s = asciiJson(v);
  assert.match(s, /^[\x20-\x7e]*$/);
  assert.deepEqual(JSON.parse(s), v);
  assert.ok(s.includes("\\u2026"));
  // Decoded as Latin-1 it is still the same JSON.
  assert.deepEqual(JSON.parse(Buffer.from(s, "utf8").toString("latin1")), v);
});

test("a manual import from a grab's fix finishes that grab (and cleans up by the usual rule)", async () => {
  const { finishGrabByHand } = await import("../server/pipeline.js");
  const g = db.prepare("SELECT id FROM grabs WHERE state = 'needs-attention' ORDER BY id DESC LIMIT 1").get() as { id: number };
  const cleaned: [number, string][] = [];
  assert.equal(await finishGrabByHand(g.id, "Date A Live: Date to Date (2013)", { cleanup: async (id, o) => (cleaned.push([id, o]), null) }), true);
  assert.equal((db.prepare("SELECT state FROM grabs WHERE id = ?").get(g.id) as { state: string }).state, "done");
  assert.deepEqual(cleaned, [[g.id, "imported"]]);
  assert.equal(await finishGrabByHand(g.id, "again", { cleanup: async () => null }), false, "only once");
});
