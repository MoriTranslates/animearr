/**
 * Blind review H2: when moving a replaced file's subtitles into the recycling bin fails part-way (EACCES, EBUSY, disk
 * full), recycle() must put back what it already moved, and say so. When even that fails, the old file is pinned in the
 * bin and a "fail" entry names where it is. Replace season must never claim it "kept the old file" for such an episode.
 */
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sparseFile } from "./sparse.js";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-rrb-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { planImport, executeImport, recycle } = await import("../server/import/importer.js");
const { pinnedInBin } = await import("../server/import/binpurge.js");
const { importAndVerify } = await import("../server/grabs/pipeline.js");
const { invalidateIndex } = await import("../server/metadata/metadata.js");
type Deps = import("../server/grabs/pipelineState.js").PipelineDeps;
type Row = import("../server/grabs/pipelineState.js").GrabRow;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-rrb-f-"));
const LIB = path.join(tmp, "lib");
const DL = path.join(tmp, "dl");
const BIN = path.join(tmp, "bin");
const write = (p: string, s = "x") => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s));
const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);
const filesUnder = (d: string): string[] =>
  fs.existsSync(d)
    ? fs
        .readdirSync(d, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.join(e.parentPath, e.name))
    : [];
const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

// Fault injection on the file operations the importer uses (restored after each test).
const realLink = fs.linkSync;
const realCopy = fs.promises.copyFile;
let linkFault: ((a: string, b: string) => string | null) | null = null;
let copyFault: ((a: string, b: string) => string | null) | null = null;
(fs as { linkSync: unknown }).linkSync = (a: fs.PathLike, b: fs.PathLike) => {
  const code = linkFault?.(path.resolve(String(a)), path.resolve(String(b)));
  if (code) throw errno(code);
  return realLink(a, b);
};
(fs.promises as { copyFile: unknown }).copyFile = async (a: fs.PathLike, b: fs.PathLike, mode?: number) => {
  const code = copyFault?.(path.resolve(String(a)), path.resolve(String(b)));
  if (code) throw errno(code);
  return realCopy(a, b, mode);
};
afterEach(() => {
  linkFault = null;
  copyFault = null;
});
const inBin = (p: string) => p.startsWith(BIN + path.sep);

const probe = async () =>
  ({
    duration: 1440,
    container: "matroska",
    video: { codec: "h264", width: 1920, height: 1080, hdr: false },
    audio: [{ lang: "ja", title: null, codec: "aac", channels: 2, default: true, forced: false }],
    subs: [{ lang: "en", title: null, codec: "ass", default: true, forced: false, partial: false }],
  }) as never;

const SHOW = path.join(LIB, "Frieren (2023)");
const S1 = path.join(SHOW, "Season 01");
/** An old episode with two subtitles, as the user has it. */
function oldEpisode(n: number) {
  const v = path.join(S1, `old ${n}.mkv`);
  const en = path.join(S1, `old ${n}.en.ass`);
  const ja = path.join(S1, `old ${n}.ja.srt`);
  write(v, `old video ${n}`);
  write(en, `old en ${n}`);
  write(ja, `old ja ${n}`);
  return { v, en, ja };
}
function assertOldInPlace(o: { v: string; en: string; ja: string }, n: number) {
  assert.equal(read(o.v), `old video ${n}`, "old video back in place");
  assert.equal(read(o.en), `old en ${n}`, "old en subtitle back in place");
  assert.equal(read(o.ja), `old ja ${n}`, "old ja subtitle back in place");
}

before(() => {
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, year, series_type, path, root_folder, monitored, synced_at) VALUES (10, 424536, 'Frieren', 2023, 'anime', '/media/AnimeArr/Frieren (2023)', '/media/AnimeArr', 1, 0)",
    )
    .run();
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/AnimeArr"],
    localPathMappings: [
      { from: "/media/AnimeArr", to: LIB },
      { from: "/data", to: DL },
      { from: "/media/Recycle", to: BIN },
    ],
    importer: { ...s.importer, allowReal: true, realBudget: -1, engine: "animearr", sourceRoots: ["/data/completed/animearr"] },
    managed: { ...s.managed, dryRun: false },
    media: {
      ...s.media,
      recycleBin: "/media/Recycle/animearr",
      skipFreeSpaceCheck: true,
      importExtraFiles: true,
      extraFileExtensions: "srt,ass",
      renameEpisodes: true,
      animeEpisodeFormat: "{Series Title} - S{season:00}E{episode:00}",
    },
  }));
});

test("a subtitle that can't be moved (EACCES on the 3rd file): what was moved comes back, nothing stays in the bin", async () => {
  const o = oldEpisode(1);
  linkFault = (_a, b) => (inBin(b) && b.endsWith("old 1.ja.srt") ? "EACCES" : null);
  await assert.rejects(recycle(o.v, SHOW), (e: Error) => {
    assert.match(e.message, /old 1\.ja\.srt.*EACCES/);
    assert.match(e.message, /nothing was replaced/);
    return true;
  });
  assertOldInPlace(o, 1);
  assert.deepEqual(filesUnder(BIN), [], "nothing left in the bin");
});

test("disk full while copying a subtitle to a bin on another disk: rolled back, no partial copy left", async () => {
  const o = oldEpisode(2);
  linkFault = (_a, b) => (inBin(b) ? "EXDEV" : null); // the bin is on another disk: moves are copies
  copyFault = (_a, b) => (b.endsWith("old 2.en.ass") ? "ENOSPC" : null);
  await assert.rejects(recycle(o.v, SHOW), /ENOSPC.*nothing was replaced/);
  assertOldInPlace(o, 2);
  assert.deepEqual(filesUnder(BIN), [], "no partial copy, nothing left in the bin");
});

/** A one-episode import replacing `o`, planned with everything fine. */
async function planReplace(epId: number, n: number, srcName: string) {
  cache
    .prepare("INSERT INTO episodes (id, series_id, season, episode, absolute, title, monitored, has_file) VALUES (?, 10, 1, ?, ?, ?, 1, 1)")
    .run(epId, n, n, `Ep ${n}`);
  cache
    .prepare("INSERT INTO files (id, series_id, season, path) VALUES (?, 10, 1, ?)")
    .run(epId, `/media/AnimeArr/Frieren (2023)/Season 01/old ${n}.mkv`);
  cache.prepare("UPDATE episodes SET file_id = ? WHERE id = ?").run(epId, epId);
  const src = path.join(DL, "m", srcName);
  write(src, `new ${n}`);
  const plan = await planImport(
    { tvdbId: 424536, path: `/data/m/${srcName}`, episodeIds: [epId], client: "sabnzbd" },
    { probe, minBytes: 0 },
  );
  assert.equal(plan.items[0].problem, null);
  assert.equal(plan.items[0].action, "move");
  return { plan, src };
}
const failsSince = (at: number) =>
  db.prepare("SELECT why FROM decisions WHERE kind = 'fail' AND at >= ? ORDER BY id").all(at) as { why: string }[];

test("a manual import whose old file can't go to the bin: refused, everything back, and a fail entry says so", async () => {
  const o = oldEpisode(3);
  const { plan, src } = await planReplace(103, 3, "Frieren.S01E03.v2.mkv");
  const t0 = Date.now();
  linkFault = (_a, b) => (inBin(b) && b.endsWith("old 3.ja.srt") ? "EBUSY" : null);
  const res = await executeImport(plan);
  assert.equal(res[0].done, false);
  assert.match(res[0].why, /EBUSY.*nothing was replaced/);
  assertOldInPlace(o, 3);
  assert.equal(read(src), "new 3", "the download went back");
  assert.equal(fs.existsSync(plan.items[0].dest), false);
  assert.deepEqual(filesUnder(BIN), []);
  const fails = failsSince(t0);
  assert.equal(fails.length, 1, JSON.stringify(fails));
  assert.match(fails[0].why, /Import of .* failed.*EBUSY.*nothing was replaced/);
});

test("the rollback fails too: the old video is pinned in the bin and a fail entry names where it is", async () => {
  const o = oldEpisode(4);
  const { plan, src } = await planReplace(104, 4, "Frieren.S01E04.v2.mkv");
  const t0 = Date.now();
  linkFault = (a, b) => (inBin(b) && b.endsWith("old 4.ja.srt") ? "EACCES" : inBin(a) && b === path.resolve(o.v) ? "EBUSY" : null);
  const res = await executeImport(plan);
  const binned = path.join(BIN, "animearr", "Frieren (2023)", "Season 01", "old 4.mkv");
  assert.equal(res[0].done, false);
  assert.match(res[0].why, /couldn't be put back/);
  assert.ok(res[0].why.includes(binned), res[0].why);
  assert.equal(read(binned), "old video 4", "the old video is safe in the bin");
  assert.equal(read(o.en), "old en 4", "the subtitle that could come back did");
  assert.equal(read(o.ja), "old ja 4", "the subtitle that never moved is in place");
  assert.equal(read(src), "new 4", "the download went back");
  assert.ok(
    pinnedInBin().some((p) => path.resolve(p.path) === path.resolve(binned)),
    "pinned: never purged",
  );
  const fails = failsSince(t0);
  assert.equal(fails.length, 1, JSON.stringify(fails));
  assert.ok(fails[0].why.includes(binned), fails[0].why);
});

// ---------------------------------------------------------------- replace season

const big = (p: string) => sparseFile(p, 31e6);
function grabFor(tvdb: number, seriesId: number, epIds: number[], release: string) {
  const now = Date.now();
  const id = Number(
    db
      .prepare(
        "INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, indexer_id, protocol, client, client_ref, state, dry_run, origin, why, candidates, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, 9, 'torrent', 'qbittorrent', 'h', 'importing', 0, 'manual', 'test', '[]', 'replace')",
      )
      .run(now, now, tvdb, seriesId, JSON.stringify(epIds), release, `g-${release}`).lastInsertRowid,
  );
  return { id, row: db.prepare("SELECT * FROM grabs WHERE id = ?").get(id) as unknown as Row };
}
const localOf = (p: string) => p.replace("/data", DL).replace("/media/AnimeArr", LIB);
const deps = (pack: string) =>
  ({
    clients: {
      addNzb: async () => ({ client: "sabnzbd", ref: "x" }),
      addTorrent: async () => ({ client: "qbittorrent", ref: "h" }),
      remove: async () => undefined,
      status: async () => ({ state: "completed", progress: 1, path: pack }),
    },
    fetchRelease: async () => ({ data: Buffer.from(""), filename: "x" }),
    sonarr: {
      preview: async (folder: string) =>
        fs.readdirSync(localOf(folder)).map((f) => ({ path: `${folder}/${f}`, size: 5e8, quality: {}, languages: [] })),
      importFiles: async () => ({ id: 1 }),
      command: async () => ({ id: 1, status: "completed" }),
      episode: async () => ({}),
      episodeFile: async () => ({}),
    },
    probe: async () => ({ durationSec: 1440, audio: ["ja", "en"], subs: ["en"], sidecars: [], untagged: 0, forced: [] }),
    localPath: localOf,
    sleep: async () => undefined,
    refreshSeries: async () => undefined,
    cleanup: async () => null,
  }) as unknown as Deps;

/** A series of `n` episodes with old files (and subtitles), plus a season pack replacing all of them. */
function seasonSetup(seriesId: number, tvdb: number, title: string, n: number) {
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, year, series_type, path, root_folder, monitored, synced_at) VALUES (?, ?, ?, 2015, 'anime', ?, '/media/AnimeArr', 1, 0)",
    )
    .run(seriesId, tvdb, title, `/media/AnimeArr/${title}`);
  invalidateIndex(); // the pack's file names are identified against the library's titles
  const olds: { v: string; en: string; ja: string }[] = [];
  const packDir = `[Judas] ${title} (Season 01) (Batch)`;
  for (let e = 1; e <= n; e++) {
    const dir = path.join(LIB, title, "Season 01");
    const o = { v: path.join(dir, `old E0${e}.mkv`), en: path.join(dir, `old E0${e}.en.ass`), ja: path.join(dir, `old E0${e}.ja.srt`) };
    write(o.v, `old video ${e}`);
    write(o.en, `old en ${e}`);
    write(o.ja, `old ja ${e}`);
    olds.push(o);
    const fid = seriesId * 100 + e;
    cache
      .prepare("INSERT INTO files (id, series_id, season, path, size) VALUES (?, ?, 1, ?, 4)")
      .run(fid, seriesId, `/media/AnimeArr/${title}/Season 01/old E0${e}.mkv`);
    cache
      .prepare(
        "INSERT INTO episodes (id, series_id, season, episode, absolute, title, monitored, has_file, file_id, runtime) VALUES (?, ?, 1, ?, ?, ?, 1, 1, ?, 24)",
      )
      .run(fid, seriesId, e, e, `Episode ${e}`, fid);
    big(path.join(DL, "completed", "animearr", packDir, `[Judas] ${title} - S01E0${e}.mkv`));
  }
  return { olds, pack: `/data/completed/animearr/${packDir}`, epIds: olds.map((_, i) => seriesId * 100 + i + 1) };
}

test("Replace season: an episode whose old file is stranded in the bin is never reported as 'kept the old file'", async () => {
  const { olds, pack, epIds } = seasonSetup(20, 283963, "Absolute Duo", 3);
  // E01: a subtitle can't move, the rollback works (old file really kept). E02: same, and the rollback fails
  // (stranded in the bin). E03: swaps normally.
  linkFault = (a, b) =>
    inBin(b) && /old E0[12]\.ja\.srt$/.test(b) ? "EACCES" : inBin(a) && b === path.resolve(olds[1].v) ? "EBUSY" : null;
  const { id, row } = grabFor(283963, 20, epIds, "[Judas] Absolute Duo (Season 01) [BD 1080p] (Batch)");
  const t0 = Date.now();
  await importAndVerify(row, pack, deps(pack));
  linkFault = null;
  assertOldInPlace(olds[0], 1);
  assert.equal(read(olds[1].v), null, "E02's old video is not in the library");
  const g = db.prepare("SELECT state, error FROM grabs WHERE id = ?").get(id) as { state: string; error: string | null };
  assert.equal(g.state, "needs-attention", g.error ?? "");
  assert.match(g.error ?? "", /1 episode kept its old file/);
  assert.match(g.error ?? "", /S01E02.*couldn't be put back|couldn't be put back.*S01E02/);
  const log = db.prepare("SELECT why FROM decisions WHERE why LIKE 'Replace season:%' AND at >= ? ORDER BY id DESC").get(t0) as {
    why: string;
  };
  const keptPart = log.why.split(/;\s*the old file of/i)[0];
  assert.match(keptPart, /kept the old file for S01E01/);
  assert.doesNotMatch(keptPart, /S01E02/, `E02 must not be listed as kept: ${log.why}`);
  assert.match(log.why, /S01E02/);
});

test("Replace season stopped with nothing swapped never says 'nothing in your library changed' when a file is stranded", async () => {
  const { olds, pack, epIds } = seasonSetup(30, 900002, "Other Show", 1);
  linkFault = (a, b) =>
    inBin(b) && /old E01\.ja\.srt$/.test(b) && b.includes("Other Show")
      ? "EACCES"
      : inBin(a) && b === path.resolve(olds[0].v)
        ? "EBUSY"
        : null;
  const { id, row } = grabFor(900002, 30, epIds, "[Judas] Other Show (Season 01) [BD 1080p] (Batch)");
  await importAndVerify(row, pack, deps(pack));
  linkFault = null;
  const g = db.prepare("SELECT state, error FROM grabs WHERE id = ?").get(id) as { state: string; error: string | null };
  assert.equal(g.state, "needs-attention", g.error ?? "");
  assert.doesNotMatch(g.error ?? "", /Nothing in your library changed/);
  assert.match(g.error ?? "", /couldn't be put back/);
});
