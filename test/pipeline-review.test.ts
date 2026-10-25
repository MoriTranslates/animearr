/**
 * Regression tests for the round-2 code review findings (grab pipeline + managed scheduler), all with mocks.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-review-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { startGrab, pipelineTick, STALL_MS, recoverGrabs, removeGrab } = await import("../server/pipeline.js");
const { queueView, grabHistory } = await import("../server/queue.js");
const { releaseDryRunDecisions } = await import("../server/managed.js");
type Deps = import("../server/pipeline.js").PipelineDeps;

const TVDB = 500001;
const removed: string[] = [];
before(() => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (1, ?, 'Test Show', '/media/AnimeArr/Test Show', 0, 0)").run(TVDB);
  // E1-E3: E1 already has a file, E2/E3 are missing.
  for (const [id, ep, has] of [[101, 1, 1], [102, 2, 0], [103, 3, 0], [104, 4, 0], [105, 5, 0], [106, 6, 0], [107, 7, 0]])
    cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, runtime, air_utc) VALUES (?, 1, 1, ?, 0, ?, 24, 0)").run(id, ep, has);
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/AnimeArr"], managed: { ...s.managed, dryRun: false } }));
});

const cand = (title: string, guid: string, episodeIds: number[], protocol: "usenet" | "torrent" = "usenet") => ({ guid, title, indexerId: 1, indexer: "X", protocol, size: 5e8, downloadUrl: "http://x/dl", label: "S01", group: null, why: "test", episodeIds });

function deps(opts: { status?: Deps["clients"]["status"]; preview?: Deps["sonarr"]["preview"]; dateAdded?: string; slowImport?: boolean } = {}) {
  const calls = { fetched: [] as string[], imports: [] as { episodeIds: number[]; path: string }[][] };
  let n = 0;
  const d: Deps = {
    clients: {
      addNzb: async () => ({ client: "sabnzbd", ref: `nzo_${++n}` }),
      addTorrent: async () => ({ client: "qbittorrent", ref: `hash${++n}` }),
      remove: async (job) => void removed.push(job.ref),
      status: opts.status ?? (async (job) => ({ state: "completed", progress: 1, path: `/data/completed/animearr/${job.ref}` })),
    },
    fetchRelease: async (r) => {
      calls.fetched.push(r.title);
      return { data: Buffer.from("x"), filename: r.title };
    },
    sonarr: {
      preview: opts.preview ?? (async (folder) => [{ path: `${folder}/ep.mkv`, size: 4e8, quality: {}, languages: [] }] as never),
      importFiles: async (files) => {
        calls.imports.push(files.map((f) => ({ episodeIds: f.episodeIds, path: f.path })));
        return { id: 1 };
      },
      command: async () => {
        if (opts.slowImport) await new Promise((r) => setTimeout(r, 30));
        return { id: 1, status: "completed" };
      },
      episode: async (id) => ({ id, seriesId: 1, seasonNumber: 1, episodeNumber: id - 100, monitored: false, hasFile: true, episodeFileId: 1000 + id }),
      episodeFile: async (id) => ({ id, seriesId: 1, seasonNumber: 1, path: `/media/AnimeArr/Test Show/Season 1/e${id}.mkv`, size: 4e8, dateAdded: opts.dateAdded ?? new Date().toISOString(), quality: { quality: { name: "WEBDL-1080p" } }, mediaInfo: { subtitles: "eng", audioLanguages: "jpn", runTime: "23:40" } }),
    },
    probe: async () => {
      throw new Error("unreachable");
    },
    localPath: () => null,
    sleep: async () => undefined,
  };
  return { d, calls };
}
const state = (id: number) => (db.prepare("SELECT state, error FROM grabs WHERE id = ?").get(id) as { state: string; error: string | null });

test("a pack never imports over episodes that already have a file", async () => {
  const { d } = deps();
  const r = await startGrab({ tvdbId: TVDB, episodeIds: [102], candidate: cand("Test Show S01 batch", "p1", [101, 102, 103]), fallbacks: [], origin: "manual" }, d);
  const g = db.prepare("SELECT episode_ids FROM grabs WHERE id = ?").get(r.id) as { episode_ids: string };
  assert.deepEqual(JSON.parse(g.episode_ids), [102, 103], "E1 has a file and wasn't asked for, so it is left alone");
  db.prepare("UPDATE grabs SET state = 'done' WHERE id = ?").run(r.id);
});

test("no second download for an episode that is already downloading", async () => {
  const { d } = deps({ status: async () => ({ state: "downloading", progress: 0.2 }) });
  const r1 = await startGrab({ tvdbId: TVDB, episodeIds: [104], candidate: cand("Test Show - 04 A", "d1", [104]), fallbacks: [], origin: "manual" }, d);
  await assert.rejects(startGrab({ tvdbId: TVDB, episodeIds: [104], candidate: cand("Test Show - 04 B", "d2", [104]), fallbacks: [], origin: "manual" }, d), /Already downloading/);
  db.prepare("UPDATE grabs SET state = 'done' WHERE id = ?").run(r1.id);
});

test("overlapping pipeline ticks import a finished download only once", async () => {
  const { d, calls } = deps({ slowImport: true });
  const r = await startGrab({ tvdbId: TVDB, episodeIds: [105], candidate: cand("Test Show - 05", "t1", [105]), fallbacks: [], origin: "manual" }, d);
  await Promise.all([pipelineTick(d), pipelineTick(d), pipelineTick(d)]);
  assert.equal(calls.imports.length, 1);
  assert.equal(state(r.id).state, "done");
});

test("a stalled download is failed after the timeout and the next (non-blocklisted) candidate is tried", async () => {
  const { d, calls } = deps({ status: async () => ({ state: "downloading", progress: 0.1 }) });
  db.prepare("INSERT INTO blocklist (guid, release, reason, at) VALUES ('s2', 'Test Show - 06 [blocked twin]', 'test', 0)").run();
  const r = await startGrab({ tvdbId: TVDB, episodeIds: [106], candidate: cand("Test Show - 06 [stuck]", "s1", [106]), fallbacks: [cand("Test Show - 06 [blocked twin]", "s2", [106]), cand("Test Show - 06 [good]", "s3", [106])], origin: "manual" }, d);
  await pipelineTick(d); // records progress 0.1
  await pipelineTick(d, Date.now() + STALL_MS + 60_000);
  assert.equal(state(r.id).state, "failed");
  assert.match(state(r.id).error ?? "", /no download progress/);
  assert.deepEqual(calls.fetched, ["Test Show - 06 [stuck]", "Test Show - 06 [good]"], "the blocklisted twin is skipped");
  assert.ok(removed.length >= 1, "the stalled download was removed from the client (queueHealth.removeFailed)");
  db.prepare("UPDATE grabs SET state = 'done' WHERE state = 'downloading'").run();
});

test("single-file torrent: only that file is imported, not other files in the category folder", async () => {
  const { d, calls } = deps({
    status: async () => ({ state: "completed", progress: 1, path: "/data/qbittorrent/completed/animearr/Test Show - 07 [good].mkv" }),
    preview: async (folder) => [{ path: `${folder}/Test Show - 07 [old blocklisted].mkv`, size: 4e8, quality: {}, languages: [] }, { path: `${folder}/Test Show - 07 [good].mkv`, size: 4e8, quality: {}, languages: [] }] as never,
  });
  await startGrab({ tvdbId: TVDB, episodeIds: [107], candidate: cand("Test Show - 07 [good]", "f1", [107], "torrent"), fallbacks: [], origin: "manual" }, d);
  await pipelineTick(d);
  assert.equal(calls.imports.length, 1);
  assert.deepEqual(calls.imports[0].map((f) => f.path), ["/data/qbittorrent/completed/animearr/Test Show - 07 [good].mkv"]);
});

test("Sonarr 'completed' but the episode still has the OLD file → needs attention, not done", async () => {
  cache.prepare("UPDATE episodes SET has_file = 0 WHERE id = 103").run();
  const { d } = deps({ dateAdded: "2020-01-01T00:00:00Z" });
  const r = await startGrab({ tvdbId: TVDB, episodeIds: [103], candidate: cand("Test Show - 03", "o1", [103]), fallbacks: [], origin: "manual" }, d);
  await pipelineTick(d);
  assert.equal(state(r.id).state, "needs-attention");
  assert.match(state(r.id).error ?? "", /doesn't have the new file/);
});

test("restart recovery: grabs stuck mid-import go to needs-attention", () => {
  const now = Date.now();
  const id = Number(db.prepare("INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, state, dry_run) VALUES (?, ?, ?, 1, '[103]', 'x', 'g', 'usenet', 'importing', 0)").run(now, now, TVDB).lastInsertRowid);
  recoverGrabs();
  assert.equal(state(id).state, "needs-attention");
});

test("leaving dry-run re-queues episodes that were only 'would grab'", () => {
  db.prepare("INSERT INTO search_state (episode_id, tvdb_id, next_at, state) VALUES (102, ?, ?, 'would-grab')").run(TVDB, Date.now() + 1e9);
  assert.equal(releaseDryRunDecisions(TVDB), 1);
  const s = db.prepare("SELECT state, next_at FROM search_state WHERE episode_id = 102").get() as { state: string; next_at: number };
  assert.equal(s.state, "waiting");
  assert.ok(s.next_at <= Date.now());
});

test("a successful import ends with a clear 'Imported ✓' entry and refreshes the series cache", async () => {
  cache.prepare("UPDATE episodes SET has_file = 0 WHERE id = 101").run();
  const { d } = deps();
  let refreshed = 0;
  d.refreshSeries = async () => void refreshed++;
  const r = await startGrab({ tvdbId: TVDB, episodeIds: [101], candidate: cand("[SubsPlease] Test Show - 01 (1080p)", "ok1", [101]), fallbacks: [], origin: "manual" }, d);
  await pipelineTick(d);
  assert.equal(state(r.id).state, "done");
  assert.equal(refreshed, 1);
  const last = db.prepare("SELECT kind, why FROM decisions ORDER BY id DESC LIMIT 1").get() as { kind: string; why: string };
  assert.equal(last.kind, "import");
  assert.match(last.why, /^Imported ✓ as S01E01: has full en subtitles/);
});

test("queue: remove a download (deletes it from the client), blocklist it with undo, and try the next candidate", async () => {
  cache.prepare("UPDATE episodes SET has_file = 0 WHERE id = 104").run();
  db.prepare("UPDATE grabs SET state = 'done' WHERE state IN ('sending', 'downloading', 'importing')").run();
  const { d, calls } = deps({ status: async () => ({ state: "downloading", progress: 0.3, etaSec: 120, speed: 5e6 }) });
  const r = await startGrab({ tvdbId: TVDB, episodeIds: [104], candidate: cand("Test Show - 04 [slow]", "q1", [104]), fallbacks: [cand("Test Show - 04 [next]", "q2", [104])], origin: "manual" }, d);
  const q = await queueView(d);
  const item = q.items.find((x) => x.id === r.id)!;
  assert.equal(item.live?.etaSec, 120);
  assert.deepEqual(item.episodes, ["S01E04"]);
  const before = removed.length;
  await removeGrab(r.id, { blocklist: true, searchNext: true }, d);
  assert.equal(removed.length, before + 1, "removed from the client");
  assert.equal((db.prepare("SELECT state FROM grabs WHERE id = ?").get(r.id) as { state: string }).state, "failed");
  assert.ok(db.prepare("SELECT 1 FROM blocklist WHERE release = 'Test Show - 04 [slow]'").get());
  assert.deepEqual(calls.fetched.slice(-1), ["Test Show - 04 [next]"]);
  assert.ok(grabHistory().some((h) => h.id === r.id && h.error === "removed by you"));
  await assert.rejects(removeGrab(r.id, { blocklist: false, searchNext: false }, d), /only downloading or needs-attention/);
});

test("queue: if the client refuses (not AnimeArr's category, or unreachable) the row is restored and nothing else happens", async () => {
  cache.prepare("UPDATE episodes SET has_file = 0 WHERE id = 105").run();
  db.prepare("UPDATE grabs SET state = 'done' WHERE state IN ('sending', 'downloading', 'importing')").run();
  const { d, calls } = deps({ status: async () => ({ state: "downloading", progress: 0.3 }) });
  d.clients.remove = async () => {
    throw new Error('that torrent is in category "sonarr", not "animearr"; leaving it alone');
  };
  const r = await startGrab({ tvdbId: TVDB, episodeIds: [105], candidate: cand("Test Show - 05 [x]", "c1", [105]), fallbacks: [cand("Test Show - 05 [y]", "c2", [105])], origin: "manual" }, d);
  const fetched = calls.fetched.length;
  await assert.rejects(removeGrab(r.id, { blocklist: true, searchNext: true }, d), /leaving it alone/);
  assert.equal((db.prepare("SELECT state FROM grabs WHERE id = ?").get(r.id) as { state: string }).state, "downloading");
  assert.equal(db.prepare("SELECT 1 FROM blocklist WHERE release = 'Test Show - 05 [x]'").get(), undefined);
  assert.equal(calls.fetched.length, fetched, "no next candidate grabbed");
  db.prepare("UPDATE grabs SET state = 'sending' WHERE id = ?").run(r.id);
  await assert.rejects(removeGrab(r.id, { blocklist: false, searchNext: false }, d), /still being sent/);
  db.prepare("UPDATE grabs SET state = 'done' WHERE id = ?").run(r.id);
});

test("queue health: waiting in the client's queue isn't a stall; a torrent without metadata fails and is removed", async () => {
  for (const [id, ep] of [[121, 21], [122, 22]]) cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, runtime, air_utc) VALUES (?, 1, 1, ?, 0, 0, 24, 0)").run(id, ep);
  const queued = deps({ status: async () => ({ state: "queued", progress: 0, clientStatus: "Queued" }) });
  const q = await startGrab({ tvdbId: TVDB, episodeIds: [121], candidate: cand("Test Show - 21", "q1", [121]), fallbacks: [], origin: "manual" }, queued.d);
  await pipelineTick(queued.d, Date.now() + STALL_MS + 60_000);
  assert.equal(state(q.id).state, "downloading", "queued behind other downloads");
  db.prepare("UPDATE grabs SET state = 'done' WHERE id = ?").run(q.id);

  const meta = deps({ status: async () => ({ state: "queued", progress: 0, clientStatus: "metaDL" }) });
  const m = await startGrab({ tvdbId: TVDB, episodeIds: [122], candidate: cand("Test Show - 22", "m1", [122], "torrent"), fallbacks: [], origin: "manual" }, meta.d);
  const ref = (db.prepare("SELECT client_ref FROM grabs WHERE id = ?").get(m.id) as { client_ref: string }).client_ref;
  await pipelineTick(queued.d, Date.now() + 2 * 3_600_000); // waited in qBit's queue for 2 h first
  await pipelineTick(meta.d, Date.now() + 2 * 3_600_000 + 30 * 60_000);
  assert.equal(state(m.id).state, "downloading", "still within metadataMin");
  await pipelineTick(meta.d, Date.now() + 2 * 3_600_000 + 61 * 60_000);
  assert.equal(state(m.id).state, "failed");
  assert.match(state(m.id).error ?? "", /metadata/);
  assert.ok(removed.includes(ref), "removed from the client");
});

test("Sonarr queue problems: only allowed roots; failed, import-blocked and not-started items are reported", async () => {
  const { sonarrQueueProblems } = await import("../server/queue.js");
  patchSettings((s) => ({ ...s, sonarr: { ...s.sonarr, url: "http://sonarr.test", apiKey: "k" } }));
  const series = { title: "Test Show", tvdbId: TVDB, path: "/media/AnimeArr/Test Show" };
  const old = new Date(Date.now() - 10 * 3_600_000).toISOString();
  const items = [
    { id: 1, title: "ok", status: "downloading", trackedDownloadStatus: "ok", size: 10, sizeleft: 5, added: old, series },
    { id: 2, title: "dead", status: "failed", trackedDownloadStatus: "error", trackedDownloadState: "failed", errorMessage: "Download failed", series, downloadId: "D2", episode: { seasonNumber: 1, episodeNumber: 1 } },
    { id: 22, title: "dead", status: "failed", trackedDownloadStatus: "error", trackedDownloadState: "failed", errorMessage: "Download failed", series, downloadId: "D2", episode: { seasonNumber: 1, episodeNumber: 2 } },
    { id: 6, title: "sonarr does it", status: "failed", trackedDownloadState: "failedPending", series, downloadId: "D6" },
    { id: 3, title: "blocked", status: "completed", trackedDownloadStatus: "warning", trackedDownloadState: "importBlocked", statusMessages: [{ title: "x", messages: ["No files found are eligible for import"] }], series },
    { id: 4, title: "never started", status: "downloading", trackedDownloadStatus: "ok", size: 10, sizeleft: 10, added: old, series },
    { id: 5, title: "tv show", status: "failed", series: { title: "TV", tvdbId: 1, path: "/media/Tv Shows/TV" } },
  ];
  const r = await sonarrQueueProblems(async () => items as never);
  assert.deepEqual(r.map((x) => [x.id, x.problem]), [[2, "failed"], [6, "sonarr-handling"], [3, "import-blocked"], [4, "stalled"]]);
  assert.deepEqual(r[0].episodes, ["S01E01", "S01E02"], "a pack is one entry");
  assert.deepEqual(r[2].messages, ["No files found are eligible for import"]);
});

test("queue health: a client error needs your attention (no blocklist, no delete); removeFailed off keeps failed downloads", async () => {
  for (const [id, ep] of [[123, 23], [124, 24]]) cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, runtime, air_utc) VALUES (?, 1, 1, ?, 0, 0, 24, 0)").run(id, ep);
  const err = deps({ status: async () => ({ state: "error", progress: 0.4, message: 'qBittorrent reports "error"' }) });
  const e = await startGrab({ tvdbId: TVDB, episodeIds: [123], candidate: cand("Test Show - 23", "e1", [123], "torrent"), fallbacks: [], origin: "manual" }, err.d);
  const before = removed.length;
  await pipelineTick(err.d);
  assert.equal(state(e.id).state, "needs-attention");
  assert.equal(db.prepare("SELECT 1 FROM blocklist WHERE release = 'Test Show - 23'").get(), undefined);
  assert.equal(removed.length, before);

  patchSettings((s) => ({ ...s, queueHealth: { ...s.queueHealth, removeFailed: false } }));
  const bad = deps({ status: async () => ({ state: "failed", progress: 0, message: "CRC error" }) });
  const f = await startGrab({ tvdbId: TVDB, episodeIds: [124], candidate: cand("Test Show - 24", "f1", [124]), fallbacks: [], origin: "manual" }, bad.d);
  await pipelineTick(bad.d);
  assert.equal(state(f.id).state, "failed");
  assert.equal(removed.length, before, "kept in the client");
  patchSettings((s) => ({ ...s, queueHealth: { ...s.queueHealth, removeFailed: true } }));
});
