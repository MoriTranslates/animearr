/**
 * "Not ours to delete" (blind review of the jobs branch, M4/L6): a torrent the client already had before AnimeArr's
 * add (a duplicate), or one a restart's lookup found there (AnimeArr can't tell whether it was there before), is
 * tracked as usual but never removed or deleted by AnimeArr: not by Remove, the failure clean-up, the malware
 * rejection, the clean-up after the outcome, or the periodic sweep. qBittorrent is asked before the add.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-not-ours-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { startGrab, pipelineTick, removeGrab } = await import("../server/grabs/pipeline.js");
const { rejectUnsafeDownload } = await import("../server/grabs/grabSteps.js");
const { cleanupGrab, runCleanup } = await import("../server/grabs/downloads.js");
const { realClients } = await import("../server/arr/clients.js");
type Deps = import("../server/grabs/pipelineState.js").PipelineDeps;
type GrabRow = import("../server/grabs/pipelineState.js").GrabRow;
type OwnTorrent = import("../server/arr/clients.js").OwnTorrent;

const TVDB = 610001;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-not-ours-dl-"));
const QB = path.join(tmp, "qbittorrent", "completed", "animearr");

before(() => {
  cache
    .prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (1, ?, 'Show', '/media/AnimeArr/Show', 0, 0)")
    .run(TVDB);
  for (let ep = 1; ep <= 20; ep++)
    cache
      .prepare(
        "INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, runtime, air_utc) VALUES (?, 1, 1, ?, 0, 0, 24, 0)",
      )
      .run(100 + ep, ep);
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/AnimeArr"],
    managed: { ...s.managed, dryRun: false },
    queueHealth: { ...s.queueHealth, removeFailed: true, strikes: 1 },
    localPathMappings: [{ from: "/data", to: tmp }],
    importer: { ...s.importer, sourceRoots: ["/data/qbittorrent/completed/animearr"] },
    qbittorrent: { ...s.qbittorrent, url: "", category: "animearr" },
    downloads: { ...s.downloads, cleanup: "auto", allowDelete: true },
  }));
});

const cand = (title: string, guid: string, episodeIds: number[]) => ({
  guid,
  title,
  indexerId: 1,
  indexer: "X",
  protocol: "torrent" as const,
  size: 5e8,
  downloadUrl: "http://x/dl",
  label: "S01",
  group: null,
  why: "test",
  episodeIds,
});

function deps(
  o: { duplicate?: boolean; status?: Deps["clients"]["status"]; find?: () => Promise<{ client: string; ref: string } | null> } = {},
) {
  const removed: string[] = [];
  const d: Deps = {
    clients: {
      addNzb: async () => ({ client: "sabnzbd", ref: "nzo" }),
      addTorrent: async () => ({ client: "deluge1", ref: o.duplicate ? "theirs" : "mine", ...(o.duplicate ? { duplicate: true } : {}) }),
      remove: async (job) => void removed.push(job.ref),
      status: o.status ?? (async () => ({ state: "queued", progress: 0, clientStatus: "queued" })),
      findTorrent: o.find ?? (async () => null),
    },
    fetchRelease: async (r) => ({ data: Buffer.from("x"), filename: r.title }),
    sonarr: {} as Deps["sonarr"],
    probe: async () => {
      throw new Error("unused");
    },
    localPath: () => null,
    sleep: async () => undefined,
  };
  return { d, removed };
}
const notOurs = (id: number) => (db.prepare("SELECT not_ours FROM grabs WHERE id = ?").get(id) as { not_ours: number }).not_ours;
const state = (id: number) => db.prepare("SELECT state, error FROM grabs WHERE id = ?").get(id) as { state: string; error: string | null };
let ep = 0;
async function grab(duplicate: boolean) {
  ep++;
  const { d } = deps({ duplicate });
  const r = await startGrab(
    { tvdbId: TVDB, episodeIds: [100 + ep], candidate: cand(`Show - ${ep}`, `g-${ep}`, [100 + ep]), fallbacks: [], origin: "manual" },
    d,
  );
  return r.id;
}

// ---------------------------------------------------------------- when it's set

test("a duplicate add is marked 'not ours'; a fresh one isn't", async () => {
  assert.equal(notOurs(await grab(true)), 1);
  assert.equal(notOurs(await grab(false)), 0);
});

test("a torrent a restart's lookup finds in the client is adopted as 'not ours' (it may have been there before)", async () => {
  const now = Date.now();
  const id = Number(
    db
      .prepare(
        "INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, state, dry_run, origin, why, candidates, attempt, progress_at, client_ref) VALUES (?, ?, ?, 1, '[120]', 'Show - 20 [cut]', 'cut-20', 'torrent', 'sending', 0, 'manual', 'test', '[]', 1, ?, 'hash20')",
      )
      .run(now, now, TVDB, now).lastInsertRowid,
  );
  const { d } = deps({ find: async () => ({ client: "deluge1", ref: "hash20" }) });
  await pipelineTick(d);
  assert.equal(state(id).state, "downloading");
  assert.equal(notOurs(id), 1);
});

// ---------------------------------------------------------------- every delete path honours it

test("Remove leaves a 'not ours' torrent in the client and says so", async () => {
  const id = await grab(true);
  const { d, removed } = deps();
  await removeGrab(id, { blocklist: false, searchNext: false }, d);
  assert.deepEqual(removed, []);
  assert.equal(state(id).state, "failed");
  assert.match(state(id).error ?? "", /left .*client/);
});

test("the failure clean-up (removeFailed) leaves a 'not ours' torrent and its data alone", async () => {
  const id = await grab(true);
  const { d, removed } = deps({ status: async () => ({ state: "failed", progress: 0, message: "tracker error" }) });
  await pipelineTick(d);
  assert.equal(state(id).state, "failed");
  assert.ok(!removed.includes("theirs"), JSON.stringify(removed));
});

test("the malware rejection leaves a 'not ours' torrent and its data alone", async () => {
  const id = await grab(true);
  const { d, removed } = deps();
  const row = db.prepare("SELECT * FROM grabs WHERE id = ?").get(id) as unknown as GrabRow;
  await rejectUnsafeDownload(row, "holds an .exe", d, "while it was downloading");
  assert.deepEqual(removed, []);
  assert.equal(state(id).state, "failed");
});

const torrent = (hash: string, over: Partial<OwnTorrent> = {}): OwnTorrent => ({
  hash,
  name: hash,
  contentPath: `/data/qbittorrent/completed/animearr/${hash}.mkv`,
  savePath: "/data/qbittorrent/completed/animearr",
  size: 3000,
  state: "pausedUP",
  ratio: 2,
  seedingTimeSec: 86_400,
  completedOn: Date.now() - 86_400_000,
  ratioLimit: -2,
  seedingTimeLimitMin: -2,
  ...over,
});
const qbGrab = (ref: string, state: string, notOursFlag: number) =>
  Number(
    db
      .prepare(
        "INSERT INTO grabs (at, updated_at, tvdb_id, episode_ids, release, guid, protocol, client, client_ref, state, dry_run, not_ours) VALUES (1, 1, ?, '[]', ?, ?, 'torrent', 'qbittorrent', ?, ?, 0, ?)",
      )
      .run(TVDB, `Rel ${ref}`, `g-${ref}`, ref, state, notOursFlag).lastInsertRowid,
  );

test("the clean-up after the outcome (imported, or rejected an hour ago) leaves a 'not ours' torrent alone", async () => {
  const removed: string[] = [];
  const cdeps = {
    torrents: async () => [torrent("theirs-done"), torrent("theirs-failed")],
    sab: async () => [],
    remove: async (j: { ref: string }) => void removed.push(j.ref),
  };
  const done = qbGrab("theirs-done", "done", 1);
  const failed = qbGrab("theirs-failed", "failed", 1);
  db.prepare("INSERT INTO decisions (at, kind, why, detail) VALUES (?, 'fail', 'x', ?)").run(
    Date.now() - 2 * 3_600_000,
    JSON.stringify({ grabId: failed }),
  );
  db.prepare("UPDATE grabs SET updated_at = ? WHERE id = ?").run(Date.now() - 2 * 3_600_000, failed);
  assert.equal(await cleanupGrab(done, "imported", cdeps), null);
  assert.equal(await cleanupGrab(failed, "rejected", cdeps), null);
  assert.deepEqual(removed, []);
});

test("the periodic clean-up sweep removes AnimeArr's own seeded torrent but never a 'not ours' one", async () => {
  for (const h of ["mine-seeded", "theirs-seeded"]) {
    fs.mkdirSync(QB, { recursive: true });
    fs.writeFileSync(path.join(QB, `${h}.mkv`), Buffer.alloc(3000));
  }
  qbGrab("mine-seeded", "done", 0);
  qbGrab("theirs-seeded", "done", 1);
  const removed: string[] = [];
  await runCleanup({ only: ["leftover"] }, {
    torrents: async () => [torrent("mine-seeded"), torrent("theirs-seeded")],
    sab: async () => [],
    remove: async (j: { ref: string }) => void removed.push(j.ref),
  } as never);
  assert.ok(removed.includes("mine-seeded"), `own one still cleaned: ${JSON.stringify(removed)}`);
  assert.ok(!removed.includes("theirs-seeded"));
});

// ---------------------------------------------------------------- qBittorrent: asked before the add

test("qBittorrent: a torrent it already has is not added again and comes back as a duplicate", async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  const hash = "cd".repeat(20);
  patchSettings((s) => ({ ...s, qbittorrent: { ...s.qbittorrent, url: "http://qb.test", username: "" } }));
  globalThis.fetch = (async (u: string | URL) => {
    const url = new URL(String(u));
    calls.push(url.pathname + url.search);
    if (url.pathname.endsWith("/torrents/info")) return new Response(JSON.stringify([{ hash }]), { status: 200 });
    if (url.pathname.endsWith("/torrents/categories")) return new Response("{}", { status: 200 });
    return new Response("Ok.", { status: 200 });
  }) as typeof fetch;
  try {
    const job = await realClients.addTorrent({ magnet: `magnet:?xt=urn:btih:${hash}` }, "Show - 01", {});
    assert.deepEqual({ ref: job.ref, duplicate: job.duplicate }, { ref: hash, duplicate: true });
    assert.ok(!calls.some((c) => c.includes("/torrents/add")), JSON.stringify(calls));
  } finally {
    globalThis.fetch = realFetch;
    patchSettings((s) => ({ ...s, qbittorrent: { ...s.qbittorrent, url: "" } }));
  }
});
after(() => undefined);

// ---------------------------------------------------------------- qBittorrent: a torrent still being moved is not done

test("qBittorrent: a finished torrent still in the moving state is not reported completed (M13)", async () => {
  const realFetch = globalThis.fetch;
  const hash = "ef".repeat(20);
  let state = "moving";
  patchSettings((s) => ({ ...s, qbittorrent: { ...s.qbittorrent, url: "http://qb.test", username: "" } }));
  globalThis.fetch = (async (u: string | URL) => {
    const url = new URL(String(u));
    if (url.pathname.endsWith("/torrents/info"))
      return new Response(
        JSON.stringify([{ hash, progress: 1, state, content_path: "/dl/x", eta: 0, dlspeed: 0, size: 5, num_seeds: 0 }]),
        { status: 200 },
      );
    return new Response("Ok.", { status: 200 });
  }) as typeof fetch;
  try {
    const job = { client: "qbittorrent", ref: hash } as never;
    assert.equal((await realClients.status(job)).state, "queued", "mid-move must wait");
    state = "stalledUP";
    assert.equal((await realClients.status(job)).state, "completed", "once moved it is done");
  } finally {
    globalThis.fetch = realFetch;
    patchSettings((s) => ({ ...s, qbittorrent: { ...s.qbittorrent, url: "" } }));
  }
});
