/**
 * Repro tests for claims in the 2026-11-01 Gemini review (verification branch only, not for nightly).
 * Each test asserts the CURRENT behaviour, so a passing test = the claim/finding is reproduced.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-verify-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { planImport } = await import("../server/importer.js");
const { removeDownloadPath } = await import("../server/downloads.js");
const { tarUnpack, tarPack } = await import("../server/backupTransfer.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-verify-fs-"));
const LIB = path.join(tmp, "lib");
const DL = path.join(tmp, "dl");
const probe = async () => ({ duration: 1440, container: "matroska", video: { codec: "h264", width: 1920, height: 1080, hdr: false }, audio: [{ lang: "ja", title: null, codec: "aac", channels: 2, default: true, forced: false }], subs: [{ lang: "en", title: null, codec: "ass", default: true, forced: false, partial: false }] }) as never;

before(() => {
  fs.mkdirSync(path.join(LIB, "Show (2023)"), { recursive: true });
  cache.prepare("INSERT INTO series (id, tvdb_id, title, year, series_type, path, monitored, synced_at) VALUES (10, 424536, 'Show', 2023, 'anime', '/media/AnimeArr/Show (2023)', 1, 0)").run();
  for (const e of [1, 2]) cache.prepare("INSERT INTO episodes (id, series_id, season, episode, absolute, title, monitored, has_file) VALUES (?, 10, 1, ?, ?, ?, 1, 0)").run(100 + e, e, e, `Ep ${e}`);
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/AnimeArr"],
    localPathMappings: [{ from: "/media/AnimeArr", to: LIB }, { from: "/data", to: DL }],
  }));
});

test("Gemini #9 (CONFIRMED): Minimum Free Space is checked per file, not for the batch as a whole", async () => {
  const S = 40 * 1024 * 1024;
  const dir = path.join(DL, "batch");
  fs.mkdirSync(dir, { recursive: true });
  for (const e of [1, 2]) fs.writeFileSync(path.join(dir, `[Grp] Show - 0${e} (1080p).mkv`), Buffer.alloc(S));
  const st = fs.statfsSync(LIB);
  const free = st.bavail * st.bsize;
  // Room for one file plus half of another above the minimum: each file alone passes, both together don't.
  const minMb = Math.floor((free - 1.5 * S) / (1024 * 1024));
  patchSettings((s) => ({ ...s, media: { ...s.media, skipFreeSpaceCheck: false, minimumFreeSpaceMb: minMb, useHardlinks: false } }));
  const files = fs.readdirSync(dir).map((f) => path.join(fs.realpathSync(dir), f));
  const plan = await planImport({ tvdbId: 424536, path: "/data/batch", client: "qbittorrent", assign: { [files[0]]: [101], [files[1]]: [102] } }, { probe, minBytes: 0 });
  assert.equal(plan.items.length, 2);
  assert.equal(plan.items[0].action, "copy");
  assert.deepEqual(plan.items.map((i) => i.problem), [null, null], "both items pass the free-space check");
  assert.ok(free - 2 * S < minMb * 1024 * 1024, "yet copying both would leave less than the minimum");
});

test("Missed: inProtected() refuses paths INSIDE a library root but not a path that CONTAINS one (removeDownloadPath)", async () => {
  // Only reachable when a source root is broad (here "/data") and a client reports an ancestor of the library.
  const lib = path.join(DL, "media", "anime", "Show");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, "ep1.mkv"), "x");
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/data/media/anime"],
    importer: { ...s.importer, sourceRoots: ["/data"] },
    downloads: { ...s.downloads, allowDelete: true },
  }));
  assert.equal(await removeDownloadPath("/data/media/anime/Show"), null, "inside the library: refused");
  const r = await removeDownloadPath("/data/media");
  assert.ok(r, "an ancestor of the library is NOT refused");
  assert.equal(fs.existsSync(path.join(lib, "ep1.mkv")), false, "the library file was deleted");
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/AnimeArr"], importer: { ...s.importer, sourceRoots: ["/data/completed/animearr"] } }));
});

test("Gemini §5 crash window (FALSE): a stale .animearr-part is only removed while its source still exists", async () => {
  const { clearStalePart } = await import("../server/importer.js");
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

test("Gemini #1 path-traversal part (FALSE): tar entry names are only map keys", () => {
  const t = tarPack([{ name: "../../evil.txt", data: Buffer.from("x") }]);
  const m = tarUnpack(t);
  assert.deepEqual([...m.keys()], ["../../evil.txt"]);
  assert.equal(fs.existsSync(path.resolve(process.cwd(), "../../evil.txt")), false);
});

test("Gemini §4 case-sensitivity (PARTLY): /episode?seriesID= gets a 400, /episodefile?seriesID= works", async () => {
  const { registerSonarrApi } = await import("../server/sonarrApi.js");
  const app = Fastify({ routerOptions: { caseSensitive: false } });
  registerSonarrApi(app, { urlBase: "", deps: {} as never } as never);
  await app.ready();
  const lower = await app.inject({ method: "GET", url: "/api/v3/episode?seriesId=10" });
  assert.equal(lower.statusCode, 200);
  assert.equal((lower.json() as unknown[]).length, 2);
  const upper = await app.inject({ method: "GET", url: "/api/v3/episode?seriesID=10" });
  assert.equal(upper.statusCode, 400, "Sonarr itself binds query names case-insensitively");
  const files = await app.inject({ method: "GET", url: "/api/v3/episodefile?seriesID=10" });
  assert.equal(files.statusCode, 200);
  await app.close();
});
