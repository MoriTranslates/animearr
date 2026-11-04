/**
 * Blind review M15: the importer's recycle() used the raw bin setting and skipped the bin guard, so a replaced episode
 * could be moved into a "bin" inside the library (or a relative bin under the working folder). Now it goes through
 * binFolder(): a refused bin means nothing is replaced and the old file stays where it was, and the plan and the result
 * say why.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-rbg-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { planImport, executeImport, planMovieImport, recycle } = await import("../server/import/importer.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-rbg-f-"));
process.chdir(tmp); // a relative bin would land under the working folder: keep that inside the scratch folder
const LIB = path.join(tmp, "lib");
const DL = path.join(tmp, "dl");
const SHOW = path.join(LIB, "Frieren (2023)");
const OLD = path.join(SHOW, "Season 01", "ep1 old.mkv");
const OLD_SUB = path.join(SHOW, "Season 01", "ep1 old.en.ass");
const probe = async () =>
  ({
    duration: 1440,
    container: "matroska",
    video: { codec: "h264", width: 1920, height: 1080, hdr: false },
    audio: [{ lang: "ja", title: null, codec: "aac", channels: 2, default: true, forced: false }],
    subs: [{ lang: "en", title: null, codec: "ass", default: true, forced: false, partial: false }],
  }) as never;
const write = (p: string, s = "x") => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s));

/** Every file under a folder (to prove nothing moved anywhere). */
const filesUnder = (d: string): string[] =>
  fs.existsSync(d)
    ? fs
        .readdirSync(d, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.join(e.parentPath, e.name))
    : [];

const setBin = (recycleBin: string) => patchSettings((s) => ({ ...s, media: { ...s.media, recycleBin } }));

before(() => {
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, year, series_type, path, root_folder, monitored, synced_at) VALUES (10, 424536, 'Frieren', 2023, 'anime', '/media/AnimeArr/Frieren (2023)', '/media/AnimeArr', 1, 0)",
    )
    .run();
  cache
    .prepare(
      "INSERT INTO episodes (id, series_id, season, episode, absolute, title, monitored, has_file) VALUES (101, 10, 1, 1, 1, 'One', 1, 1)",
    )
    .run();
  cache
    .prepare("INSERT INTO files (id, series_id, season, path) VALUES (505, 10, 1, '/media/AnimeArr/Frieren (2023)/Season 01/ep1 old.mkv')")
    .run();
  cache.prepare("UPDATE episodes SET file_id = 505 WHERE id = 101").run();
  write(OLD, "old episode");
  write(OLD_SUB, "old subs");
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/AnimeArr"],
    localPathMappings: [
      { from: "/media/AnimeArr", to: LIB },
      { from: "/data", to: DL },
    ],
    importer: { ...s.importer, allowReal: true, realBudget: -1 },
    media: { ...s.media, skipFreeSpaceCheck: true, importExtraFiles: true, extraFileExtensions: "srt,ass" },
  }));
});

const untouched = () => {
  assert.equal(fs.readFileSync(OLD, "utf8"), "old episode", "the old episode is where it was");
  assert.equal(fs.readFileSync(OLD_SUB, "utf8"), "old subs", "its subtitle is where it was");
};

test("recycle() refuses a bin inside the library, a relative bin and '/', and moves nothing", async () => {
  for (const bin of ["/media/AnimeArr/Recycle", "/media/AnimeArr/Frieren (2023)/bin", "recycle", "/"]) {
    setBin(bin);
    const before = filesUnder(LIB).sort();
    await assert.rejects(recycle(OLD, SHOW), /nothing was replaced/, bin);
    untouched();
    assert.deepEqual(filesUnder(LIB).sort(), before, `${bin}: nothing moved in the library`);
    assert.equal(fs.existsSync(path.join(tmp, "recycle")), false, `${bin}: nothing under the working folder`);
  }
});

test("the plan says the replacement can't be done safely, and running it leaves the old file and the download alone", async () => {
  setBin("/media/AnimeArr/Recycle");
  const src = path.join(DL, "y", "Frieren.S01E01.v2.mkv");
  write(src, "new episode");
  const plan = await planImport(
    { tvdbId: 424536, path: "/data/y/Frieren.S01E01.v2.mkv", episodeIds: [101], client: "sabnzbd" },
    { probe, minBytes: 0 },
  );
  assert.match(plan.items[0].problem ?? "", /recycling bin .* library folder.*can't be replaced safely/);
  const res = await executeImport(plan);
  assert.equal(res[0].done, false);
  assert.match(res[0].why, /library folder/);
  untouched();
  assert.equal(fs.readFileSync(src, "utf8"), "new episode", "the download is still there");
  assert.equal(fs.existsSync(path.join(LIB, "Recycle")), false, "no bin was made inside the library");
});

test("a bin that becomes unsafe between plan and run: the run refuses, rolls the new file back, keeps the old one", async () => {
  const BIN = path.join(tmp, "bin");
  patchSettings((s) => ({ ...s, localPathMappings: [...s.localPathMappings, { from: "/media/Recycle", to: BIN }] }));
  setBin("/media/Recycle/animearr");
  const src = path.join(DL, "z", "Frieren.S01E01.v3.mkv");
  write(src, "newer episode");
  const plan = await planImport(
    { tvdbId: 424536, path: "/data/z/Frieren.S01E01.v3.mkv", episodeIds: [101], client: "sabnzbd" },
    { probe, minBytes: 0 },
  );
  assert.equal(plan.items[0].problem, null, "planned with a good bin");
  assert.equal(plan.items[0].action, "move");
  setBin("/media/AnimeArr/Recycle"); // changed meanwhile
  const res = await executeImport(plan);
  assert.equal(res[0].done, false);
  assert.match(res[0].why, /library folder.*nothing was replaced/);
  untouched();
  assert.equal(fs.readFileSync(src, "utf8"), "newer episode", "the moved download went back");
  assert.equal(fs.existsSync(plan.items[0].dest), false, "nothing at the new name");
  assert.deepEqual(
    filesUnder(LIB).filter((f) => f.endsWith(".animearr-part")),
    [],
    "no temporary file left in the library",
  );
  assert.deepEqual(filesUnder(BIN), [], "nothing in the old bin either");
});

test("with a good bin the replacement still works (the old file and its subtitle go to the bin)", async () => {
  const BIN = path.join(tmp, "bin");
  setBin("/media/Recycle/animearr");
  const moved = await recycle(OLD, SHOW);
  assert.equal(moved.length, 2);
  for (const m of moved) assert.ok(path.resolve(m.to).startsWith(path.join(BIN, "animearr") + path.sep), m.to);
  assert.equal(fs.existsSync(OLD), false);
});

test("a movie replacement is refused the same way when the bin is inside the library", async () => {
  const MOV = path.join(LIB, "Suzume (2022)", "Suzume (2022).mkv");
  write(MOV, "old movie");
  cache
    .prepare(
      "INSERT INTO movies (id, tmdb_id, title, year, path, root_folder, monitored, has_file, is_anime, synced_at, file) VALUES (7, 916224, 'Suzume', 2022, '/media/AnimeArr/Suzume (2022)', '/media/AnimeArr', 1, 1, 1, 0, ?)",
    )
    .run(JSON.stringify({ path: "/media/AnimeArr/Suzume (2022)/Suzume (2022).mkv" }));
  write(path.join(DL, "m", "Suzume.2022.1080p.BluRay-GRP.mkv"), "new movie");
  setBin("/media/AnimeArr/Suzume (2022)/bin");
  const plan = await planMovieImport(
    { movieId: 7, path: "/data/m/Suzume.2022.1080p.BluRay-GRP.mkv", client: "sabnzbd" },
    { probe, minBytes: 0 },
  );
  assert.match(plan.items[0].problem ?? "", /library folder.*can't be replaced safely/);
  assert.equal(fs.readFileSync(MOV, "utf8"), "old movie");
});
