/**
 * Regression tests for the 2026-11-01 review findings (started as repro tests on verify/gemini-claims; they now assert
 * the fixed behaviour): the batch free-space check, the delete guard for paths that CONTAIN the library, a rollback that
 * can't put the old file back, Sonarr-API query names in any case and the series editor, and outbound address checks.
 * The checks that were already right (stale parts, tar names) stay as regression tests.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { sparseFile } from "./sparse.js";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-harden-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, CONFIG_DIR } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { planImport, executeImport, clearStalePart } = await import("../server/importer.js");
const { removeDownloadPath, inProtected } = await import("../server/grabs/downloads.js");
const { tarUnpack, tarPack } = await import("../server/system/backupTransfer.js");
const { pinnedInBin, purgeBin, unpinBinned, binStatus } = await import("../server/binpurge.js");
const { blockedOutboundHost } = await import("../server/system/outbound.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-harden-fs-"));
const LIB = path.join(tmp, "lib");
const DL = path.join(tmp, "dl");
const BIN = path.join(tmp, "recycle");
const probe = async () =>
  ({
    duration: 1440,
    container: "matroska",
    video: { codec: "h264", width: 1920, height: 1080, hdr: false },
    audio: [{ lang: "ja", title: null, codec: "aac", channels: 2, default: true, forced: false }],
    subs: [{ lang: "en", title: null, codec: "ass", default: true, forced: false, partial: false }],
  }) as never;
const write = (p: string, s = "x") => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s));

before(() => {
  fs.mkdirSync(path.join(LIB, "Show (2023)"), { recursive: true });
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, year, series_type, path, root_folder, monitored, synced_at) VALUES (10, 424536, 'Show', 2023, 'anime', '/media/AnimeArr/Show (2023)', '/media/AnimeArr', 1, 0)",
    )
    .run();
  for (const e of [1, 2])
    cache
      .prepare(
        "INSERT INTO episodes (id, series_id, season, episode, absolute, title, monitored, has_file) VALUES (?, 10, 1, ?, ?, ?, 1, 0)",
      )
      .run(100 + e, e, e, `Ep ${e}`);
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/AnimeArr"],
    localPathMappings: [
      { from: "/media/AnimeArr", to: LIB },
      { from: "/data", to: DL },
      { from: "/media/Recycle", to: BIN },
    ],
  }));
});

test("T9: Minimum Free Space is checked for the batch as a whole; hardlinks on the same disk take no space", async () => {
  const S = 400 * 1024 * 1024;
  const dir = path.join(DL, "batch");
  for (const e of [1, 2]) sparseFile(path.join(dir, `[Grp] Show - 0${e} (1080p).mkv`), S);
  const st = fs.statfsSync(LIB);
  const free = st.bavail * st.bsize;
  // Room for one file plus half of another above the minimum: each file alone fits, both together don't.
  const minMb = Math.floor((free - 1.5 * S) / (1024 * 1024));
  patchSettings((s) => ({ ...s, media: { ...s.media, skipFreeSpaceCheck: false, minimumFreeSpaceMb: minMb, useHardlinks: false } }));
  const files = fs
    .readdirSync(dir)
    .sort()
    .map((f) => path.join(fs.realpathSync(dir), f));
  const input = { tvdbId: 424536, path: "/data/batch", client: "qbittorrent", assign: { [files[0]]: [101], [files[1]]: [102] } };
  const plan = await planImport(input, { probe, minBytes: 0 });
  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[0].action, "copy");
  assert.equal(plan.items[0].problem, null, "the first copy fits");
  assert.match(plan.items[1].problem ?? "", /not enough free space.*together with the others/, "the second would cross the minimum");
  // Hardlinks within one disk need no room at all.
  patchSettings((s) => ({ ...s, media: { ...s.media, useHardlinks: true } }));
  const linked = await planImport(input, { probe, minBytes: 0 });
  assert.equal(linked.items[0].action, "hardlink");
  assert.deepEqual(
    linked.items.map((i) => i.problem),
    [null, null],
  );
  patchSettings((s) => ({ ...s, media: { ...s.media, skipFreeSpaceCheck: true, useHardlinks: false } }));
});

test("M1: the delete guard refuses a path that CONTAINS a library/allowed root or the config folder", async () => {
  const lib = path.join(DL, "media", "anime", "Show");
  write(path.join(lib, "ep1.mkv"));
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/data/media/anime"],
    importer: { ...s.importer, sourceRoots: ["/data"] },
    downloads: { ...s.downloads, allowDelete: true },
  }));
  try {
    assert.equal(await removeDownloadPath("/data/media/anime/Show"), null, "inside the library: refused");
    assert.equal(await removeDownloadPath("/data/media"), null, "an ancestor of the library: refused");
    assert.ok(fs.existsSync(path.join(lib, "ep1.mkv")), "the library file is still there");
    assert.equal(inProtected(path.dirname(CONFIG_DIR)), true, "a folder holding AnimeArr's config");
    assert.equal(inProtected(path.join(CONFIG_DIR, "backups")), true, "inside the config folder");
    // An ordinary finished download under the source root still goes.
    write(path.join(DL, "done", "Some.Release", "a.mkv"));
    assert.ok(await removeDownloadPath("/data/done/Some.Release"));
    assert.equal(fs.existsSync(path.join(DL, "done", "Some.Release")), false);
  } finally {
    patchSettings((s) => ({
      ...s,
      allowedRoots: ["/media/AnimeArr"],
      importer: { ...s.importer, sourceRoots: ["/data/completed/animearr"] },
      downloads: { ...s.downloads, allowDelete: false },
    }));
  }
});

test("M4: a replace whose rollback fails says where both files are and pins the old one in the bin", async () => {
  patchSettings((s) => ({
    ...s,
    importer: { ...s.importer, allowReal: true, realBudget: -1 },
    media: { ...s.media, recycleBin: "/media/Recycle/animearr/", recycleBinCleanupDays: 1, skipFreeSpaceCheck: true },
  }));
  const old = path.join(LIB, "Show (2023)", "Season 01", "old ep1.mkv");
  write(old, "old");
  cache
    .prepare("INSERT INTO files (id, series_id, season, path) VALUES (900, 10, 1, '/media/AnimeArr/Show (2023)/Season 01/old ep1.mkv')")
    .run();
  cache.prepare("UPDATE episodes SET file_id = 900, has_file = 1 WHERE id = 101").run();
  const src = path.join(DL, "usenet", "Show.S01E01.1080p.WEB-DL-GRP.mkv");
  write(src, "new");
  const plan = await planImport(
    {
      tvdbId: 424536,
      path: "/data/usenet/Show.S01E01.1080p.WEB-DL-GRP.mkv",
      episodeIds: [101],
      release: "Show.S01E01.1080p.WEB-DL-GRP",
      client: "sabnzbd",
    },
    { probe, minBytes: 0 },
  );
  const it = plan.items[0];
  assert.equal(it.problem, null);
  assert.equal(it.action, "move");
  // Something lands at the final name AND at the old file's place between two steps: placing fails, rollback fails.
  const realLink = fs.linkSync;
  (fs as { linkSync: typeof fs.linkSync }).linkSync = ((a: fs.PathLike, b: fs.PathLike) => {
    if (path.resolve(String(b)) === path.resolve(it.dest)) {
      fs.writeFileSync(it.dest, "stray");
      fs.writeFileSync(old, "stray");
    }
    return realLink(a, b);
  }) as typeof fs.linkSync;
  let res;
  try {
    res = await executeImport(plan);
  } finally {
    (fs as { linkSync: typeof fs.linkSync }).linkSync = realLink;
  }
  const binned = path.join(BIN, "animearr", "Show (2023)", "Season 01", "old ep1.mkv");
  assert.equal(res[0].done, false);
  assert.match(res[0].why, /couldn't be put back/);
  assert.ok(res[0].why.includes(binned), `names the bin location: ${res[0].why}`);
  assert.ok(res[0].why.includes(src), "names where the new file is (moved back to its source)");
  assert.equal(fs.readFileSync(binned, "utf8"), "old");
  assert.equal(fs.readFileSync(src, "utf8"), "new");
  const pins = pinnedInBin();
  assert.deepEqual(
    pins.map((p) => path.resolve(p.path)),
    [path.resolve(binned)],
  );
  assert.match(pins[0].why, /couldn't put this file back/);
  assert.equal(binStatus().pinned.length, 1, "shown in Audit → Recycle");
  // Never purged while pinned, not even by "Empty bin now".
  const r = await purgeBin({ all: true });
  assert.ok(fs.existsSync(binned), "pinned file kept");
  assert.equal("pinned" in r ? r.pinned : 0, 1);
  // Once the user dealt with it, the bin's normal rules apply again.
  assert.equal(unpinBinned(binned), true);
  await purgeBin({ all: true });
  assert.equal(fs.existsSync(binned), false);
  patchSettings((s) => ({ ...s, importer: { ...s.importer, allowReal: false } }));
});

test("D2 (was already right): a stale .animearr-part is only removed while its source still exists", async () => {
  const dir = path.join(tmp, "crash");
  fs.mkdirSync(dir, { recursive: true });
  const part = path.join(dir, "ep.mkv.animearr-part");
  const src = path.join(dir, "src.mkv");
  fs.writeFileSync(part, "new file, its source was moved");
  assert.equal(clearStalePart(part, src), false, "source gone (a move was cut off): the part is the only copy and stays");
  assert.ok(fs.existsSync(part));
  fs.writeFileSync(src, "source still here");
  assert.equal(clearStalePart(part, src), true, "source still there (copy/hardlink cut off): the part is redundant");
});

test("T1 (was already right): tar entry names are only map keys, never paths", () => {
  const m = tarUnpack(tarPack([{ name: "../../evil.txt", data: Buffer.from("x") }]));
  assert.deepEqual([...m.keys()], ["../../evil.txt"]);
  assert.equal(fs.existsSync(path.resolve(process.cwd(), "../../evil.txt")), false);
});

test("S3/S4: Sonarr-API query names in any case; the series editor maps onto AnimeArr and never touches files", async () => {
  const { registerSonarrApi } = await import("../server/sonarrApi.js");
  const app = Fastify({ routerOptions: { caseSensitive: false } });
  registerSonarrApi(app, { urlBase: "", deps: {} as never } as never);
  await app.ready();
  for (const q of ["seriesId", "seriesID", "SERIESID"]) {
    const r = await app.inject({ method: "GET", url: `/api/v3/episode?${q}=10` });
    assert.equal(r.statusCode, 200, q);
    assert.equal((r.json() as unknown[]).length, 2, q);
  }
  assert.equal((await app.inject({ method: "GET", url: "/api/v3/episodefile?seriesID=10" })).statusCode, 200);
  assert.equal(((await app.inject({ method: "GET", url: "/api/v3/series?TVDBID=424536" })).json() as unknown[]).length, 1);

  const put = (payload: object) => app.inject({ method: "PUT", url: "/api/v3/series/editor", payload });
  assert.equal((await put({ seriesIds: [10], deleteFiles: true })).statusCode, 400, "never deletes files");
  assert.equal((await put({ seriesIds: [10], moveFiles: true, rootFolderPath: "/media/Other" })).statusCode, 400, "never moves files");
  assert.equal(
    (await put({ seriesIds: [10], rootFolderPath: "/media/Other" })).statusCode,
    400,
    "a different root folder would mean moving files",
  );
  assert.equal((await put({ seriesIds: [] })).statusCode, 400);
  assert.equal((await put({ seriesIds: [10], rootFolderPath: "/media/AnimeArr/" })).statusCode, 202, "the same root folder is fine");
  const tag = (await app.inject({ method: "POST", url: "/api/v3/tag", payload: { label: "phone" } })).json() as { id: number };
  let r = await put({ seriesIds: [10], monitored: true, tags: [tag.id], applyTags: "add" });
  assert.equal(r.statusCode, 202, r.body);
  let s = (r.json() as { monitored: boolean; tags: number[] }[])[0];
  assert.equal(s.monitored, true);
  assert.deepEqual(s.tags, [tag.id]);
  r = await put({ seriesIds: [10], monitored: false, tags: [tag.id], applyTags: "remove" });
  s = (r.json() as { monitored: boolean; tags: number[] }[])[0];
  assert.equal(s.monitored, false);
  assert.deepEqual(s.tags, []);
  assert.equal((await put({ seriesIds: [10], qualityProfileId: 9999 })).statusCode, 404);
  await app.close();
});

test("M10: outbound addresses refuse link-local and metadata in every spelling; the LAN stays allowed", () => {
  const host = (u: string) => new URL(u).hostname;
  for (const u of [
    "http://169.254.169.254/",
    "http://[::ffff:169.254.169.254]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[0:0:0:0:0:ffff:a9fe:a9fe]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[fe80::1]/",
    "http://[febf::1]/",
    "http://[fd00:ec2::254]/",
    "http://2852039166/",
    "http://0xa9.0xfe.0xa9.0xfe/",
    "http://metadata.google.internal/",
    "http://0.0.0.0/",
    "http://[::]/",
    "http://100.100.100.200/",
  ])
    assert.equal(blockedOutboundHost(host(u)), true, u);
  for (const u of [
    "http://192.168.1.10:8989/",
    "http://10.0.0.5/",
    "http://172.17.0.1/",
    "http://localhost:8080/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://[::ffff:192.168.1.10]/",
    "http://sonarr.lan/",
    "https://example.com/",
    "http://[2001:db8::1]/",
  ])
    assert.equal(blockedOutboundHost(host(u)), false, u);
});

test("regexes meant as \b word boundaries are real boundaries (they were literal backspace bytes)", async () => {
  const { qualityResource } = await import("../server/sonarrResources.js");
  assert.deepEqual(
    qualityResource("[Grp] Show - 05v2 REPACK (1080p)").revision,
    { version: 1, real: 0, isRepack: true },
    "05v2 isn't a lone v2",
  );
  assert.deepEqual(qualityResource("Show.S01E05.v2.REPACK.1080p.WEB-DL-Grp").revision, { version: 2, real: 0, isRepack: true });
  assert.equal(qualityResource("Show.S01E05.1080p.WEB-DL-Grp").revision.isRepack, false);
  // No source file carries a control character any more.
  for (const f of ["sonarrApi.ts", "episodes.ts", "search/search.ts", "importer.ts"])
    assert.ok(!/[\x00-\x08]/.test(fs.readFileSync(new URL(`../server/${f}`, import.meta.url), "utf8")), f);
});
