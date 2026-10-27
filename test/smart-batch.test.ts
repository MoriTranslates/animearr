/**
 * Smart batch grabs: the season-consistency decision, the file-priority mapping, the client-capability path (with
 * the fallback for clients that can't skip files), a magnet whose metadata arrives late, Transmission's RPC calls,
 * and the Usenet leftover clean-up (confined to AnimeArr's own download folder). Mocks and temp folders only.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-batch-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { decideSeason, planFiles, applySelection, batchLine, readBatch, compareQuality } = await import("../server/batch.js");
const { startGrab, pipelineTick } = await import("../server/pipeline.js");
const { cleanupGrab, removeJobFolder } = await import("../server/downloads.js");
const { transmissionDriver } = await import("../server/arr/moreClients.js");
type Deps = import("../server/pipeline.js").PipelineDeps;
type ExistingFile = import("../server/batch.js").ExistingFile;
type ClientFile = import("../server/arr/clients.js").ClientFile;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-batch-dl-"));
const TVDB = 600001;

before(() => {
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/AnimeArr"],
    managed: { ...s.managed, dryRun: false },
    localPathMappings: [{ from: "/data", to: tmp }],
    importer: { ...s.importer, sourceRoots: ["/data/completed/animearr", "/data/qbittorrent/completed/animearr"] },
    sabnzbd: { ...s.sabnzbd, category: "animearr" },
    qbittorrent: { ...s.qbittorrent, category: "animearr" },
    downloads: { ...s.downloads, cleanup: "auto", allowDelete: true },
  }));
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (9, ?, 'Batch Show', '/media/AnimeArr/Batch Show', 0, 0)").run(TVDB);
  // Season 1, 26 episodes: 22 have a file, E05/E10/E15/E20 are missing.
  for (let e = 1; e <= 26; e++) cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, runtime, air_utc) VALUES (?, 9, 1, ?, 0, ?, 24, 0)").run(9000 + e, e, [5, 10, 15, 20].includes(e) ? 0 : 1);
});

// ---------------------------------------------------------------- season decision

const files = (n: number, group: string | null, o: Partial<ExistingFile> = {}): ExistingFile[] => Array.from({ length: n }, (_, i) => ({ episodeId: i + 1, group, resolution: 1080, source: "web", failed: false, ...o }));
const base = { season: 1, consistency: "prefer" as const, batchEpisodes: Array.from({ length: 12 }, (_, i) => i + 1), profileResolution: 1080, recycleBin: true };

test("season decision: same group as the files → only the missing episodes", () => {
  const d = decideSeason({ ...base, existing: files(8, "Judas"), batch: { group: "Judas", resolution: 1080, source: "bluray" } });
  assert.equal(d.mode, "missing");
  assert.deepEqual(d.want, [9, 10, 11, 12]);
  assert.match(d.why, /same group as your files \(Judas\)/);
});

test("season decision: another group at the same or better quality → the whole season as a Replace season", () => {
  const d = decideSeason({ ...base, existing: files(8, "SubsPlease"), batch: { group: "Judas", resolution: 1080, source: "web" } });
  assert.equal(d.mode, "replace");
  assert.equal(d.want.length, 12);
  assert.deepEqual(d.replaces, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.match(d.why, /Replacing the whole of season 1: same quality, and keeps one group \(Judas\)/);
  const better = decideSeason({ ...base, existing: files(8, "SubsPlease"), batch: { group: "Judas", resolution: 1080, source: "bluray" } });
  assert.match(better.why, /better quality/);
});

test("season decision: another group at worse quality → missing only, and the season's group's singles are preferred", () => {
  const d = decideSeason({ ...base, existing: files(8, "Judas", { source: "bluray" }), batch: { group: "Erai-raws", resolution: 720, source: "web" } });
  assert.equal(d.mode, "missing");
  assert.deepEqual(d.want, [9, 10, 11, 12]);
  assert.equal(d.preferSingles, true);
  assert.equal(d.seasonGroup, "Judas");
  assert.match(d.why, /lower quality/);
});

test("season decision: a file that failed its check always counts as missing (replaced only with a recycling bin)", () => {
  const ex = files(8, "Judas").map((f) => (f.episodeId === 3 ? { ...f, failed: true } : f));
  const d = decideSeason({ ...base, existing: ex, batch: { group: "Judas", resolution: 1080, source: "web" } });
  assert.deepEqual(d.want.sort((a, b) => a - b), [3, 9, 10, 11, 12]);
  assert.deepEqual(d.replaces, [3]);
  const noBin = decideSeason({ ...base, recycleBin: false, existing: ex, batch: { group: "Judas", resolution: 1080, source: "web" } });
  assert.deepEqual(noBin.want, [9, 10, 11, 12]);
  assert.match(noBin.why, /recycling bin/);
});

test("season decision: consistency off → always only the missing episodes; no bin → never a replace", () => {
  const off = decideSeason({ ...base, consistency: "off", existing: files(8, "SubsPlease"), batch: { group: "Judas", resolution: 2160, source: "bluray" } });
  assert.equal(off.mode, "missing");
  assert.deepEqual(off.want, [9, 10, 11, 12]);
  assert.match(off.why, /keeping one group per season is off/);
  const noBin = decideSeason({ ...base, recycleBin: false, existing: files(8, "SubsPlease"), batch: { group: "Judas", resolution: 1080, source: "bluray" } });
  assert.equal(noBin.mode, "missing");
});

test("season decision: a season mixed from several groups is made consistent by a batch at least as good", () => {
  const ex = [...files(3, "A"), ...files(3, "B").map((f) => ({ ...f, episodeId: f.episodeId + 3 })), ...files(2, "C").map((f) => ({ ...f, episodeId: f.episodeId + 6 }))];
  const d = decideSeason({ ...base, existing: ex, batch: { group: "Judas", resolution: 1080, source: "web" } });
  assert.equal(d.mode, "replace");
  assert.equal(compareQuality({ resolution: 720, source: "bluray" }, { resolution: 1080, source: "web" }, 1080), -1);
  assert.equal(compareQuality({ resolution: null, source: null }, { resolution: 1080, source: "web" }, 1080), null);
});

// ---------------------------------------------------------------- file mapping

const ep = (name: string) => Number(/ - (\d+)/.exec(name)?.[1] ?? NaN);
const resolve26 = (name: string) => (Number.isFinite(ep(name)) ? [9000 + ep(name)] : null);
const batch26: ClientFile[] = [
  ...Array.from({ length: 26 }, (_, i) => ({ index: i, name: `[Grp] Batch Show (Batch)/[Grp] Batch Show - ${String(i + 1).padStart(2, "0")}.mkv`, size: 5e8 })),
  { index: 26, name: "[Grp] Batch Show (Batch)/[Grp] Batch Show - 05.en.ass", size: 4e4 },
  { index: 27, name: "[Grp] Batch Show (Batch)/[Grp] Batch Show - 06.en.ass", size: 4e4 },
  { index: 28, name: "[Grp] Batch Show (Batch)/Fonts/Roboto.ttf", size: 2e5 },
  { index: 29, name: "[Grp] Batch Show (Batch)/Extras/[Grp] Batch Show - NCOP.mkv", size: 1e8 },
];

test("file mapping: a 26-episode batch with 4 missing downloads only those 4 (and their subtitles and the fonts)", () => {
  const p = planFiles(batch26, { wantedIds: [9005, 9010, 9015, 9020], resolve: resolve26, keepCreditless: false });
  assert.equal(p.whole, false);
  assert.deepEqual(p.wanted.sort((a, b) => a - b), [4, 9, 14, 19, 26, 28]);
  assert.ok(p.skipped.includes(27), "the subtitle of a skipped episode is skipped with it");
  assert.ok(p.skipped.includes(29), "the creditless OP follows the creditless setting (off here)");
  assert.equal(p.skippedEpisodes.length, 22);
  const withNc = planFiles(batch26, { wantedIds: [9005, 9010, 9015, 9020], resolve: resolve26, keepCreditless: true });
  assert.ok(withNc.wanted.includes(29), "creditless OP/ED as valued extras: kept");
});

test("file mapping: a batch with a Specials/ OVA keeps the special only when it is wanted", () => {
  const list: ClientFile[] = [
    { index: 0, name: "Show S01 (BD)/Show - S01E01.mkv", size: 5e8 },
    { index: 1, name: "Show S01 (BD)/Show - S01E02.mkv", size: 5e8 },
    { index: 2, name: "Show S01 (BD)/Specials/Show - OVA - Date to Date.mkv", size: 9e8 },
  ];
  const res = (n: string) => (/OVA/.test(n) ? [7001] : /E01/.test(n) ? [7101] : /E02/.test(n) ? [7102] : null);
  const ova = planFiles(list, { wantedIds: [7001], resolve: res, keepCreditless: false });
  assert.deepEqual(ova.wanted, [2]);
  const eps = planFiles(list, { wantedIds: [7101, 7102], resolve: res, keepCreditless: false });
  assert.deepEqual(eps.wanted, [0, 1]);
  // A movie grab from the same batch: the file whose name carries the movie's subtitle.
  const movie = planFiles(list, { wantedIds: [], resolve: () => null, keepCreditless: false, movie: { subtitles: ["date to date"] } });
  assert.deepEqual(movie.wanted, [2]);
});

test("file mapping: unsafe cases download everything", () => {
  assert.equal(planFiles(batch26, { wantedIds: [9005, 9999], resolve: resolve26, keepCreditless: false }).whole, true, "a wanted episode without a file");
  assert.equal(planFiles([{ index: 0, name: "x/a.rar", size: 1 }, { index: 1, name: "x/a.r00", size: 1 }], { wantedIds: [1], resolve: () => [1], keepCreditless: false }).whole, true, "archives");
  assert.equal(planFiles(batch26.slice(0, 26), { wantedIds: batch26.slice(0, 26).map((_, i) => 9001 + i), resolve: resolve26, keepCreditless: false }).whole, true, "nothing to skip");
});

// ---------------------------------------------------------------- client capability and the pipeline

function insertGrab(o: { client: string; ref: string; batch: object; episodeIds?: number[]; protocol?: string; state?: string }) {
  const now = Date.now();
  return Number(
    db
      .prepare("INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, indexer_id, protocol, client, client_ref, state, dry_run, origin, why, candidates, batch) VALUES (?, ?, ?, 9, ?, '[Grp] Batch Show (Batch)', ?, 1, ?, ?, ?, ?, 0, 'manual', 'test', '[]', ?)")
      .run(now, now, TVDB, JSON.stringify(o.episodeIds ?? [9005, 9010, 9015, 9020]), `g${now}${Math.random()}`, o.protocol ?? "torrent", o.client, o.ref, o.state ?? "downloading", JSON.stringify(o.batch)).lastInsertRowid,
  );
}
const pendingBatch = (paused = true) => ({ mode: "pending", total: 26, wanted: 4, skippedEpisodes: [], skippedFiles: 0, leftovers: true, note: null, since: Date.now(), paused });
const opts = { wantedIds: [9005, 9010, 9015, 9020], resolve: resolve26, keepCreditless: false };

function mockClients(o: { files?: () => ClientFile[] | null; capable?: boolean } = {}) {
  const calls = { select: [] as { wanted: number[]; skipped: number[] }[], start: 0, added: [] as { paused?: boolean }[] };
  const base: Deps["clients"] = {
    addNzb: async () => ({ client: "sabnzbd", ref: "nzo1" }),
    addTorrent: async (_src, _n, op) => (calls.added.push({ paused: op?.paused }), { client: "qbittorrent", ref: `h${calls.added.length}`, ...(op?.paused ? { paused: true, select: true } : {}) }),
    status: async () => ({ state: "queued", progress: 0, clientStatus: "stoppedDL" }),
    remove: async () => undefined,
  };
  if (o.capable === false) return { clients: base, calls };
  return {
    clients: {
      ...base,
      canSelectFiles: () => true,
      listFiles: async () => (o.files ? o.files() : batch26),
      selectFiles: async (_j: unknown, wanted: number[], skipped: number[]) => void calls.select.push({ wanted, skipped }),
      start: async () => void calls.start++,
    } as Deps["clients"],
    calls,
  };
}

test("capability: files are skipped and the stopped torrent is started; the Queue line says what's skipped", async () => {
  const { clients, calls } = mockClients();
  const id = insertGrab({ client: "qbittorrent", ref: "hh1", batch: pendingBatch() });
  const out = await applySelection({ grabId: id, job: { client: "qbittorrent", ref: "hh1", select: true, paused: true }, clients, opts, log: { tvdbId: TVDB, release: "x", episodeIds: [] } });
  assert.equal(out, "partial");
  assert.equal(calls.select.length, 1);
  assert.deepEqual(calls.select[0].wanted.sort((a, b) => a - b), [4, 9, 14, 19, 26, 28]);
  assert.equal(calls.start, 1);
  const b = readBatch((db.prepare("SELECT batch FROM grabs WHERE id = ?").get(id) as { batch: string }).batch)!;
  assert.equal(b.mode, "partial");
  assert.equal(batchLine({ ...b, skippedEpisodes: [1, 2] }), "Downloading 4 of 26 episodes (you have the rest)");
});

test("capability fallback: a client that can't skip files downloads the whole batch (never left stopped, never started by us)", async () => {
  const { clients, calls } = mockClients({ capable: false });
  const id = insertGrab({ client: "deluge-x", ref: "hh2", batch: pendingBatch(false) });
  const out = await applySelection({ grabId: id, job: { client: "deluge-x", ref: "hh2", select: true }, clients, opts, log: { tvdbId: TVDB, release: "x", episodeIds: [] } });
  assert.equal(out, "whole");
  assert.equal(calls.start, 0);
  const b = readBatch((db.prepare("SELECT batch FROM grabs WHERE id = ?").get(id) as { batch: string }).batch)!;
  assert.equal(b.mode, "whole");
  assert.equal(b.leftovers, true, "the import takes only the wanted files; the rest is cleaned after it");
  assert.match(batchLine(b)!, /whole batch; importing 4 of 26/);
});

test("startGrab: a torrent batch for 4 missing episodes is added stopped and only those 4 are downloaded", async () => {
  db.prepare("UPDATE grabs SET state = 'done'").run();
  const { clients, calls } = mockClients();
  const d = { clients, fetchRelease: async () => ({ data: Buffer.from("t"), filename: "x" }), sonarr: {} as Deps["sonarr"], probe: async () => ({}) as never, localPath: () => null, sleep: async () => undefined } as Deps;
  const r = await startGrab({ tvdbId: TVDB, episodeIds: [9005, 9010, 9015, 9020], candidate: { guid: "sb1", title: "[Grp] Batch Show (Batch)", indexerId: 1, indexer: "X", protocol: "torrent", size: 1e10, downloadUrl: "http://x", label: "S01", group: "Grp", why: "test", episodeIds: Array.from({ length: 26 }, (_, i) => 9001 + i) }, fallbacks: [], origin: "manual" }, d);
  assert.equal(calls.added[0].paused, true);
  const g = db.prepare("SELECT episode_ids, batch FROM grabs WHERE id = ?").get(r.id) as { episode_ids: string; batch: string };
  assert.deepEqual(JSON.parse(g.episode_ids), [9005, 9010, 9015, 9020]);
  assert.equal(readBatch(g.batch)!.mode, "partial");
  assert.equal(calls.start, 1);
  db.prepare("UPDATE grabs SET state = 'done' WHERE id = ?").run(r.id);
});

test("magnet with delayed metadata: pending until the file list appears, then the pipeline tick selects and starts", async () => {
  let ready = false;
  const { clients, calls } = mockClients({ files: () => (ready ? batch26 : null) });
  const d = { clients, fetchRelease: async () => ({ magnet: "magnet:?xt=urn:btih:" + "ab".repeat(20), filename: "x" }), sonarr: {} as Deps["sonarr"], probe: async () => ({}) as never, localPath: () => null, sleep: async () => undefined } as Deps;
  const r = await startGrab({ tvdbId: TVDB, episodeIds: [9005, 9010, 9015, 9020], candidate: { guid: "sb2", title: "[Grp] Batch Show (Batch) v2", indexerId: 1, indexer: "X", protocol: "torrent", size: 1e10, magnetUrl: "magnet:?x", label: "S01", group: "Grp", why: "test", episodeIds: Array.from({ length: 26 }, (_, i) => 9001 + i) }, fallbacks: [], origin: "manual" }, d);
  const read = () => readBatch((db.prepare("SELECT batch FROM grabs WHERE id = ?").get(r.id) as { batch: string }).batch)!;
  assert.equal(read().mode, "pending");
  assert.equal(calls.select.length, 0);
  assert.match(batchLine(read())!, /Waiting for the torrent's file list/);
  ready = true;
  await pipelineTick(d);
  assert.equal(read().mode, "partial");
  assert.equal(calls.select.length, 1);
  assert.equal(calls.start, 1);
  db.prepare("UPDATE grabs SET state = 'done' WHERE id = ?").run(r.id);
});

test("Usenet batches download whole; no file selection is attempted", async () => {
  const { clients, calls } = mockClients();
  const d = { clients, fetchRelease: async () => ({ data: Buffer.from("n"), filename: "x" }), sonarr: {} as Deps["sonarr"], probe: async () => ({}) as never, localPath: () => null, sleep: async () => undefined } as Deps;
  const r = await startGrab({ tvdbId: TVDB, episodeIds: [9005], candidate: { guid: "sb3", title: "[Grp] Batch Show (Batch) NZB", indexerId: 1, indexer: "X", protocol: "usenet", size: 1e10, downloadUrl: "http://x", label: "S01", group: "Grp", why: "test", episodeIds: Array.from({ length: 26 }, (_, i) => 9001 + i) }, fallbacks: [], origin: "manual" }, d);
  const b = readBatch((db.prepare("SELECT batch FROM grabs WHERE id = ?").get(r.id) as { batch: string }).batch)!;
  assert.equal(b.mode, "whole");
  assert.equal(b.leftovers, true);
  assert.equal(calls.select.length, 0);
  db.prepare("UPDATE grabs SET state = 'done' WHERE id = ?").run(r.id);
});

// ---------------------------------------------------------------- Transmission (mocked RPC)

test("Transmission: .torrent added paused, files listed, files-unwanted/files-wanted set, then torrent-start", async () => {
  const sent: { method: string; arguments: Record<string, unknown> }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { method: string; arguments: Record<string, unknown> };
    sent.push(body);
    const args =
      body.method === "session-get"
        ? { "download-dir": "/downloads" }
        : body.method === "torrent-add"
          ? { "torrent-added": { hashString: "ABCDEF" } }
          : body.method === "torrent-get"
            ? { torrents: [{ metadataPercentComplete: 1, files: [{ name: "B/B - 01.mkv", length: 5 }, { name: "B/B - 02.mkv", length: 6 }] }] }
            : {};
    return new Response(JSON.stringify({ result: "success", arguments: args }), { status: 200 });
  }) as typeof fetch;
  try {
    const cfg = { id: "tr1", type: "transmission", name: "Transmission", url: "http://tr:9091", username: "", password: "", category: "animearr", priority: 1, enabled: true } as never;
    const job = await transmissionDriver.add(cfg, { data: Buffer.from("d8:announce0:e") }, { paused: true });
    assert.deepEqual(job, { ref: "abcdef", select: true, paused: true });
    assert.equal(sent.find((s) => s.method === "torrent-add")!.arguments.paused, true);
    const files = await transmissionDriver.listFiles(cfg, "abcdef");
    assert.deepEqual(files, [{ index: 0, name: "B/B - 01.mkv", size: 5 }, { index: 1, name: "B/B - 02.mkv", size: 6 }]);
    await transmissionDriver.selectFiles(cfg, "abcdef", [1], [0]);
    const set = sent.find((s) => s.method === "torrent-set" && "files-unwanted" in s.arguments)!;
    assert.deepEqual(set.arguments, { ids: ["abcdef"], "files-unwanted": [0], "files-wanted": [1] });
    await transmissionDriver.start(cfg, "abcdef");
    assert.equal(sent.at(-1)!.method, "torrent-start");
    // A magnet isn't added paused (a paused magnet never fetches its metadata); its files are skipped once listed.
    sent.length = 0;
    const mj = await transmissionDriver.add(cfg, { magnet: "magnet:?xt=urn:btih:abc" }, { paused: true });
    assert.equal(sent.find((s) => s.method === "torrent-add")!.arguments.paused, undefined);
    assert.deepEqual(mj, { ref: "abcdef", select: true, paused: false });
  } finally {
    globalThis.fetch = orig;
  }
});

// ---------------------------------------------------------------- Usenet leftovers

test("Usenet leftovers: after a confirmed import the batch's folder goes, only inside AnimeArr's folder and with deleting on", async () => {
  const job = path.join(tmp, "completed", "animearr", "Batch Show S01");
  fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(path.join(job, "Batch Show - 01.mkv"), "x"); // a leftover episode the grab never wanted
  const id = insertGrab({ client: "sabnzbd", ref: "nzo_left", protocol: "usenet", state: "done", batch: { mode: "whole", total: 26, wanted: 4, skippedEpisodes: [], skippedFiles: 0, leftovers: true, note: null, since: 0 } });
  const sab = async () => [{ nzoId: "nzo_left", storage: "/data/completed/animearr/Batch Show S01", status: "Completed" }];
  // A wanted episode still without its file: the folder stays.
  cache.prepare("UPDATE episodes SET has_file = 0 WHERE id = 9005").run();
  assert.equal(await cleanupGrab(id, "imported", { torrents: async () => [], sab, remove: async () => undefined }), null);
  assert.ok(fs.existsSync(job));
  cache.prepare("UPDATE episodes SET has_file = 1 WHERE id IN (9005, 9010, 9015, 9020)").run();
  assert.match((await cleanupGrab(id, "imported", { torrents: async () => [], sab, remove: async () => undefined }))!, /unneeded files/);
  assert.equal(fs.existsSync(job), false);
  // Outside the source roots: never.
  const outside = path.join(tmp, "elsewhere", "Batch Show S01");
  fs.mkdirSync(outside, { recursive: true });
  const id2 = insertGrab({ client: "sabnzbd", ref: "nzo_out", protocol: "usenet", state: "done", batch: { mode: "whole", total: 26, wanted: 4, skippedEpisodes: [], skippedFiles: 0, leftovers: true, note: null, since: 0 } });
  assert.equal(await cleanupGrab(id2, "imported", { torrents: async () => [], sab: async () => [{ nzoId: "nzo_out", storage: "/data/elsewhere/Batch Show S01", status: "Completed" }], remove: async () => undefined }), null);
  assert.ok(fs.existsSync(outside));
});

test("SABnzbd del_files quirk: AnimeArr removes the job's folder itself, never the root, never outside, never with deleting off", () => {
  const job = path.join(tmp, "completed", "animearr", "Job A");
  fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(path.join(job, "a.mkv"), "x");
  assert.equal(removeJobFolder("/data/completed/animearr"), null, "the category folder itself");
  assert.equal(removeJobFolder("/data/elsewhere/Job A"), null, "outside the source roots");
  patchSettings((s) => ({ ...s, downloads: { ...s.downloads, allowDelete: false } }));
  assert.equal(removeJobFolder("/data/completed/animearr/Job A"), null, "deleting is off");
  patchSettings((s) => ({ ...s, downloads: { ...s.downloads, allowDelete: true } }));
  assert.ok(removeJobFolder("/data/completed/animearr/Job A"));
  assert.equal(fs.existsSync(job), false);
});
