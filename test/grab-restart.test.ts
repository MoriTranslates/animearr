/**
 * A grab caught in 'sending' by a restart (review 2026-11-02, H9): it is resolved against the download client (arrived:
 * it moves on; never arrived: failed and the next candidate is tried; client down: it waits and is asked again, never
 * failed and never sent twice), and the user can remove a 'sending' grab.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-grab-restart-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { startGrab, pipelineTick, recoverGrabs, removeGrab } = await import("../server/grabs/pipeline.js");
type Deps = import("../server/grabs/pipelineState.js").PipelineDeps;
type Job = { client: string; ref: string };

const TVDB = 600001;
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
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/AnimeArr"], managed: { ...s.managed, dryRun: false } }));
});

const cand = (title: string, guid: string, episodeIds: number[], protocol: "usenet" | "torrent" = "torrent") => ({
  guid,
  title,
  indexerId: 1,
  indexer: "X",
  protocol,
  size: 5e8,
  downloadUrl: "http://x/dl",
  label: "S01",
  group: null,
  why: "test",
  episodeIds,
});

/** Fake clients: `find` answers whether a torrent (by hash) is in a client; it throws while the client is down. */
function deps(find: (hash: string) => Promise<Job | null>) {
  const sent: string[] = [];
  const removed: string[] = [];
  const d: Deps = {
    clients: {
      addNzb: async (_d, name) => (sent.push(name), { client: "sabnzbd", ref: `nzo-${sent.length}` }),
      addTorrent: async (_s, name) => (sent.push(name), { client: "qbittorrent", ref: `hash-${sent.length}` }),
      remove: async (job) => void removed.push(job.ref),
      status: async () => ({ state: "queued", progress: 0, clientStatus: "queued" }),
      findTorrent: find,
    },
    fetchRelease: async (r) => ({ data: Buffer.from("x"), filename: r.title }),
    sonarr: {} as Deps["sonarr"],
    probe: async () => {
      throw new Error("unused");
    },
    localPath: () => null,
    sleep: async () => undefined,
  };
  return { d, sent, removed };
}

/** A grab row as a restart leaves it: 'sending', fresh (seconds old), not being sent by this process. */
function cutOff(ep: number, protocol: "usenet" | "torrent", clientRef: string | null) {
  const now = Date.now();
  const next = cand(`Show - ${ep} [next]`, `next-${ep}`, [100 + ep], protocol);
  return Number(
    db
      .prepare(
        "INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, state, dry_run, origin, why, candidates, attempt, progress_at, client_ref) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'sending', 0, 'manual', 'test', ?, 1, ?, ?)",
      )
      .run(now, now, TVDB, JSON.stringify([100 + ep]), `Show - ${ep} [cut]`, `cut-${ep}`, protocol, JSON.stringify([next]), now, clientRef)
      .lastInsertRowid,
  );
}
const row = (id: number) =>
  db.prepare("SELECT state, error, client, client_ref FROM grabs WHERE id = ?").get(id) as {
    state: string;
    error: string | null;
    client: string | null;
    client_ref: string | null;
  };
const grabsFor = (guid: string) => (db.prepare("SELECT COUNT(*) AS n FROM grabs WHERE guid = ?").get(guid) as { n: number }).n;

test("restart, the torrent did reach the client: the grab moves on to downloading, nothing is sent again", async () => {
  const id = cutOff(1, "torrent", "abc111");
  const { d, sent } = deps(async (hash) => (hash === "abc111" ? { client: "qbittorrent", ref: hash } : null));
  recoverGrabs();
  await pipelineTick(d);
  assert.equal(row(id).state, "downloading");
  assert.equal(row(id).client, "qbittorrent");
  assert.equal(row(id).client_ref, "abc111");
  assert.deepEqual(sent, []);
});

test("restart, the torrent never reached the client: failed, and the next candidate is tried", async () => {
  const id = cutOff(2, "torrent", "abc222");
  const { d, sent } = deps(async () => null);
  recoverGrabs();
  await pipelineTick(d);
  assert.equal(row(id).state, "failed");
  assert.deepEqual(sent, ["Show - 2 [next]"]);
  assert.equal(grabsFor("cut-2"), 1, "the cut-off release itself isn't sent again");
});

test("restart, the client is down: the grab waits (not failed, not re-sent) and is resolved once the client answers", async () => {
  const id = cutOff(3, "torrent", "abc333");
  let up = false;
  const { d, sent } = deps(async (hash) => {
    if (!up) throw new Error("qBittorrent unreachable (connect ECONNREFUSED)");
    return { client: "qbittorrent", ref: hash };
  });
  recoverGrabs();
  await pipelineTick(d);
  await pipelineTick(d);
  assert.equal(row(id).state, "sending");
  assert.match(row(id).error ?? "", /unreachable/);
  assert.deepEqual(sent, []);
  up = true;
  await pipelineTick(d);
  assert.equal(row(id).state, "downloading");
  assert.deepEqual(sent, []);
});

test("restart before anything was handed to a client: failed, and the next candidate is tried", async () => {
  const id = cutOff(4, "torrent", null);
  const { d, sent } = deps(async () => {
    throw new Error("not asked");
  });
  recoverGrabs();
  await pipelineTick(d);
  assert.equal(row(id).state, "failed");
  assert.deepEqual(sent, ["Show - 4 [next]"]);
});

test("restart after an NZB was handed over (no id to look it up by): needs a look, never failed or sent again", async () => {
  const id = cutOff(5, "usenet", "?");
  const { d, sent } = deps(async () => null);
  recoverGrabs();
  await pipelineTick(d);
  assert.equal(row(id).state, "needs-attention");
  assert.deepEqual(sent, []);
});

test("a 'sending' grab cut off by a restart can be removed: from the client when it's there", async () => {
  const id = cutOff(6, "torrent", "abc666");
  const { d, removed } = deps(async (hash) => ({ client: "qbittorrent", ref: hash }));
  await removeGrab(id, { blocklist: false, searchNext: false }, d);
  assert.equal(row(id).state, "failed");
  assert.deepEqual(removed, ["abc666"]);
});

test("removing a cut-off 'sending' grab while the client is down says so and keeps it", async () => {
  const id = cutOff(7, "torrent", "abc777");
  const { d } = deps(async () => {
    throw new Error("qBittorrent unreachable");
  });
  await assert.rejects(removeGrab(id, { blocklist: false, searchNext: false }, d), /unreachable/);
  assert.equal(row(id).state, "sending");
});

test("a cut-off NZB or never-sent grab can be removed", async () => {
  const { d } = deps(async () => null);
  for (const id of [cutOff(8, "usenet", "?"), cutOff(9, "torrent", null)]) {
    await removeGrab(id, { blocklist: false, searchNext: false }, d);
    assert.equal(row(id).state, "failed");
  }
});

test("a grab being sent right now can be removed: once the client accepts it, it is taken back out", { timeout: 10_000 }, async () => {
  let accept!: (j: Job) => void;
  const { d, removed } = deps(async () => null);
  const add = d.clients.addTorrent;
  // Only this release hangs in the client (others, e.g. a leftover cut-off grab's next candidate, go through).
  d.clients.addTorrent = (src, name, o) => (name === "Show - 10" ? new Promise<Job>((r) => (accept = r)) : add(src, name, o));
  const sending = startGrab(
    { tvdbId: TVDB, episodeIds: [110], candidate: cand("Show - 10", "live-10", [110]), fallbacks: [], origin: "manual" },
    d,
  );
  await new Promise((r) => setTimeout(r, 10));
  const id = (db.prepare("SELECT id FROM grabs WHERE guid = 'live-10'").get() as { id: number }).id;
  assert.equal(row(id).state, "sending");
  await pipelineTick(d); // a tick meanwhile leaves a send in progress alone
  assert.equal(row(id).state, "sending");
  await removeGrab(id, { blocklist: false, searchNext: false }, d);
  accept({ client: "qbittorrent", ref: "live-hash" });
  await sending;
  assert.equal(row(id).state, "failed");
  assert.deepEqual(removed, ["live-hash"]);
});
