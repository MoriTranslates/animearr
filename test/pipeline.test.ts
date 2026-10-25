/**
 * Grab → download → import → verify, entirely with mocks: no download client, Prowlarr or Sonarr is touched.
 * Uses a throwaway config folder.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { startGrab, pipelineTick } = await import("../server/pipeline.js");
type Deps = import("../server/pipeline.js").PipelineDeps;

const TVDB = 328670;
const EP = { s6e1: 9001, s6e2: 9002 };

before(() => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (264, ?, 'Full-Time Magister', '/media/AnimeArr/Full-Time Magister', 0, 0)").run(TVDB);
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (999, 1, 'Main Library Show', '/media/Anime/Main Library Show', 1, 0)").run();
  for (const [id, ep] of [[EP.s6e1, 1], [EP.s6e2, 2]]) cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, runtime, air_utc) VALUES (?, 264, 6, ?, 0, 0, 20, 0)").run(id, ep);
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/AnimeArr"], managed: { ...s.managed, dryRun: false } }));
});

const cand = (title: string, guid: string) => ({ guid, title, indexerId: 7, indexer: "Nzb.su", protocol: "usenet" as const, size: 5e8, downloadUrl: "http://prowlarr/7/download?apikey=x", label: "S06E01", group: null, why: "test", episodeIds: [EP.s6e1] });

function mockDeps(subsAfterImport: string[]) {
  const calls = { addNzb: 0, imports: [] as unknown[], fetched: [] as string[] };
  let n = 0;
  const deps: Deps = {
    clients: {
      addNzb: async () => ({ client: "sabnzbd", ref: `SABnzbd_nzo_${++n}` }),
      addTorrent: async () => ({ client: "qbittorrent", ref: "abc" }),
      status: async (job) => ({ state: "completed", progress: 1, path: `/data/completed/animearr/${job.ref}` }),
    },
    fetchRelease: async (r) => {
      calls.fetched.push(r.title);
      calls.addNzb++;
      return { data: Buffer.from("<nzb/>"), filename: r.title };
    },
    sonarr: {
      // Like real Sonarr: with a seriesId the folder is ignored and the series' library files come back.
      preview: async (folder, _downloadId, seriesId) =>
        (seriesId
          ? [{ path: "/media/AnimeArr/Full-Time Magister/Season 6/existing.mkv", size: 4e8, quality: {}, languages: [] }]
          : [{ path: `${folder}/episode.mkv`, size: 4e8, quality: { quality: { id: 9 } }, languages: [{ id: 8 }], releaseGroup: undefined, indexerFlags: 0 }]) as never,
      importFiles: async (files, mode) => {
        calls.imports.push({ files, mode });
        return { id: 77 };
      },
      command: async () => ({ id: 77, status: "completed" }),
      episode: async (id) => ({ id, seriesId: 264, seasonNumber: 6, episodeNumber: 1, monitored: false, hasFile: true, episodeFileId: 5 }),
      episodeFile: async () => ({ id: 5, seriesId: 264, seasonNumber: 6, path: "/media/AnimeArr/Full-Time Magister/Season 6/x.mkv", size: 4e8, quality: { quality: { name: "WEBDL-1080p" } }, mediaInfo: { subtitles: subsAfterImport.join("/"), audioLanguages: "jpn", runTime: "20:01" } }),
    },
    probe: async () => {
      throw new Error("not reachable");
    },
    localPath: () => null,
    sleep: async () => undefined,
  };
  return { deps, calls };
}

test("dry-run (global switch on): nothing sent, log says what it would grab and import", async () => {
  patchSettings((s) => ({ ...s, managed: { ...s.managed, dryRun: true } }));
  const { deps, calls } = mockDeps(["eng"]);
  const r = await startGrab({ tvdbId: TVDB, episodeIds: [EP.s6e1], candidate: cand("Quan.Zhi.Fa.Shi.S6.-.01", "g1"), fallbacks: [], origin: "manual" }, deps);
  assert.equal(r.dryRun, true);
  assert.equal(calls.addNzb, 0);
  const d = db.prepare("SELECT kind, why FROM decisions ORDER BY id DESC LIMIT 1").get() as { kind: string; why: string };
  assert.equal(d.kind, "would-grab");
  assert.match(d.why, /would grab Quan\.Zhi\.Fa\.Shi\.S6\.-\.01/);
  assert.match(d.why, new RegExp(`S06E01 \\(episode id ${EP.s6e1}\\)`));
  patchSettings((s) => ({ ...s, managed: { ...s.managed, dryRun: false } }));
});

test("allowed-root guard: a show outside the allowed root folders is refused", async () => {
  const { deps } = mockDeps(["eng"]);
  await assert.rejects(startGrab({ tvdbId: 1, episodeIds: [1], candidate: cand("x", "g0"), fallbacks: [], origin: "manual" }, deps), /not an allowed root folder/);
});

test("grab → download → ManualImport with explicit episode IDs → verify OK", async () => {
  const { deps, calls } = mockDeps(["eng", "chi"]);
  const r = await startGrab({ tvdbId: TVDB, episodeIds: [EP.s6e1], candidate: cand("Quan.Zhi.Fa.Shi.S6.-.01", "g2"), fallbacks: [], origin: "manual" }, deps);
  assert.equal(r.dryRun, false);
  await pipelineTick(deps);
  assert.equal(calls.imports.length, 1);
  const imp = calls.imports[0] as { files: { seriesId: number; episodeIds: number[]; path: string }[]; mode: string };
  assert.deepEqual(imp.files[0].episodeIds, [EP.s6e1]);
  assert.equal(imp.files[0].seriesId, 264);
  assert.equal(imp.mode, "auto");
  const g = db.prepare("SELECT state FROM grabs WHERE id = ?").get(r.id) as { state: string };
  assert.equal(g.state, "done");
});

test("verify fails (Chinese subs only) → blocklisted, next candidate is tried", async () => {
  const { deps, calls } = mockDeps(["chi"]);
  const r = await startGrab({ tvdbId: TVDB, episodeIds: [EP.s6e1], candidate: cand("[BadGroup] Quanzhi Fashi S6 - 01", "g3"), fallbacks: [cand("[GoodGroup] Quanzhi Fashi S6 - 01", "g4")], origin: "managed" }, deps);
  // Managed shows also need the show's own dry-run off; this show isn't managed, so the scheduler path would be dry.
  assert.equal(r.dryRun, true);
  const r2 = await startGrab({ tvdbId: TVDB, episodeIds: [EP.s6e1], candidate: cand("[BadGroup] Quanzhi Fashi S6 - 01", "g5"), fallbacks: [cand("[GoodGroup] Quanzhi Fashi S6 - 01", "g6")], origin: "manual" }, deps);
  await pipelineTick(deps);
  const g = db.prepare("SELECT state, error FROM grabs WHERE id = ?").get(r2.id) as { state: string; error: string };
  assert.equal(g.state, "failed");
  assert.match(g.error, /subtitles zh only|no subtitles/);
  assert.ok(db.prepare("SELECT 1 FROM blocklist WHERE release = ?").get("[BadGroup] Quanzhi Fashi S6 - 01"));
  assert.deepEqual(calls.fetched, ["[BadGroup] Quanzhi Fashi S6 - 01", "[GoodGroup] Quanzhi Fashi S6 - 01"]);
  const learned = db.prepare("SELECT total, subs FROM group_langs WHERE grp = 'badgroup' AND origin = 'verify' AND source = '*'").get() as { total: number; subs: string } | undefined;
  assert.ok(learned && learned.total === 1 && JSON.parse(learned.subs).zh === 1, "verification feeds the learned language table");
});

test("import problems that aren't the release's fault: needs attention, no blocklist, no next candidate; retry works", async () => {
  const { deps, calls } = mockDeps(["eng"]);
  const broken = { ...deps, sonarr: { ...deps.sonarr, preview: async () => [] as never } };
  const r = await startGrab({ tvdbId: TVDB, episodeIds: [EP.s6e2], candidate: { ...cand("[OKGroup] Quanzhi Fashi S6 - 02", "g7"), episodeIds: [EP.s6e2] }, fallbacks: [cand("[Other] Quanzhi Fashi S6 - 02", "g8")], origin: "manual" }, broken);
  await pipelineTick(broken);
  const g = db.prepare("SELECT state FROM grabs WHERE id = ?").get(r.id) as { state: string };
  assert.equal(g.state, "needs-attention");
  assert.equal(db.prepare("SELECT 1 FROM blocklist WHERE release = ?").get("[OKGroup] Quanzhi Fashi S6 - 02"), undefined);
  assert.deepEqual(calls.fetched, ["[OKGroup] Quanzhi Fashi S6 - 02"]);
  const { retryImport } = await import("../server/pipeline.js");
  retryImport(r.id);
  await pipelineTick(deps);
  assert.equal((db.prepare("SELECT state FROM grabs WHERE id = ?").get(r.id) as { state: string }).state, "done");
});
