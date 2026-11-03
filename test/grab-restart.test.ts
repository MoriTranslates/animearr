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

test("restart after an NZB was handed over, clients that can't look it up: needs a look, never failed or sent again", async () => {
  const id = cutOff(5, "usenet", "?");
  const { d, sent } = deps(async () => null);
  recoverGrabs();
  await pipelineTick(d);
  assert.equal(row(id).state, "needs-attention");
  assert.deepEqual(sent, []);
});

// The NZB is looked up by its release name in the Usenet clients (findNzb; its client-side cases: nzb-lookup.test.ts).
test("restart, the NZB is in the client (queue or history): it moves on to downloading, nothing is sent again", async () => {
  const id = cutOff(11, "usenet", "?");
  const { d, sent } = deps(async () => null);
  const asked: string[] = [];
  d.clients.findNzb = async (name) => (asked.push(name), { client: "sabnzbd", ref: "SABnzbd_nzo_11" });
  await pipelineTick(d);
  assert.deepEqual(asked, ["Show - 11 [cut]"]);
  assert.equal(row(id).state, "downloading");
  assert.deepEqual([row(id).client, row(id).client_ref], ["sabnzbd", "SABnzbd_nzo_11"]);
  assert.deepEqual(sent, []);
});

test("restart, the NZB is in no client: failed, and the next release is tried", async () => {
  const id = cutOff(12, "usenet", "?");
  const { d, sent } = deps(async () => null);
  d.clients.findNzb = async () => null;
  await pipelineTick(d);
  assert.equal(row(id).state, "failed");
  assert.deepEqual(sent, ["Show - 12 [next]"]);
  assert.equal(grabsFor("cut-12"), 1, "the cut-off release itself isn't sent again");
});

test("restart, a Usenet client down or two jobs of that name: needs a look with the reason, never sent again", async () => {
  for (const [ep, why] of [
    [13, "SABnzbd unreachable (connect ECONNREFUSED)"],
    [14, "2 jobs in the download clients are named Show - 14 [cut]"],
  ] as const) {
    const id = cutOff(ep, "usenet", "?");
    const { d, sent } = deps(async () => null);
    d.clients.findNzb = async () => {
      throw new Error(why);
    };
    await pipelineTick(d);
    assert.equal(row(id).state, "needs-attention");
    assert.ok((row(id).error ?? "").includes(why), row(id).error ?? "");
    assert.deepEqual(sent, []);
  }
});

test("a 'sending' grab cut off by a restart can be removed: from the client when it's there", async () => {
  const id = cutOff(6, "torrent", "abc666");
  const { d, removed } = deps(async (hash) => ({ client: "qbittorrent", ref: hash }));
  await removeGrab(id, { blocklist: false, searchNext: false }, d);
  assert.equal(row(id).state, "failed");
  assert.deepEqual(removed, ["abc666"]);
});

test("removing a cut-off 'sending' grab while the client is down closes it here, says to check the client, frees the episode", async () => {
  const id = cutOff(7, "torrent", "abc777");
  const { d } = deps(async () => {
    throw new Error("qBittorrent unreachable");
  });
  await removeGrab(id, { blocklist: false, searchNext: false }, d);
  assert.equal(row(id).state, "failed");
  assert.match(row(id).error ?? "", /unreachable.*check the client/);
  // The episode isn't blocked any more: a new grab for it goes through.
  const r = await startGrab(
    { tvdbId: TVDB, episodeIds: [107], candidate: cand("Show - 7 v2", "new-7", [107]), fallbacks: [], origin: "manual" },
    d,
  );
  assert.ok(!r.failed, r.message);
});

// ---------------------------------------------------------------- a cut-off torrent never stays 'sending' for good (H1)

test("a watch-folder torrent client can't be asked: findTorrent says so (CantLookUp), not 'down'", async () => {
  const { realClients, CantLookUp } = await import("../server/arr/clients.js");
  const before = structuredClone((await import("../server/system/settings.js")).getSettings());
  patchSettings((s) => ({
    ...s,
    qbittorrent: { ...s.qbittorrent, url: "" },
    extraClients: [
      {
        id: "bh1",
        type: "blackhole-torrent",
        name: "Watch folder",
        url: "",
        username: "",
        password: "",
        category: "",
        priority: 1,
        enabled: true,
        removeCompleted: false,
        pathMappings: [],
        watchFolder: "/tmp/w",
        completedFolder: "/tmp/c",
      },
    ],
  }));
  try {
    await assert.rejects(realClients.findTorrent!("ab".repeat(20)) /* a 40-hex info-hash */, (e) => e instanceof CantLookUp);
  } finally {
    patchSettings(() => before);
  }
});

test("restart, the torrent client is a watch folder: needs a look at once, never stuck 'sending', never re-sent", async () => {
  const { CantLookUp } = await import("../server/arr/clients.js");
  const id = cutOff(15, "torrent", "abc015");
  const { d, sent } = deps(async () => {
    throw new CantLookUp("Watch folder is a watch folder; AnimeArr can't ask it what it has");
  });
  await pipelineTick(d);
  assert.equal(row(id).state, "needs-attention");
  assert.match(row(id).error ?? "", /watch folder/);
  assert.deepEqual(sent, []);
});

test("restart, the client stays down: asked again for an hour, then it needs a look (never stuck 'sending')", async () => {
  const id = cutOff(16, "torrent", "abc016");
  const { d, sent } = deps(async () => {
    throw new Error("qBittorrent unreachable (connect ECONNREFUSED)");
  });
  const t0 = Date.now();
  await pipelineTick(d, t0);
  await pipelineTick(d, t0 + 30 * 60_000);
  assert.equal(row(id).state, "sending", "still asking within the hour");
  await pipelineTick(d, t0 + 61 * 60_000);
  assert.equal(row(id).state, "needs-attention");
  assert.match(row(id).error ?? "", /unreachable.*after 60 min/);
  assert.deepEqual(sent, []);
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

// ---------------------------------------------------------------- a grab the user removed stays removed (H2, M1)

test("a cut-off NZB the user removes while the tick waits on another client stays removed (no stale-row overwrite)", async () => {
  const slow = cutOff(17, "torrent", "slow017");
  const nzb = cutOff(18, "usenet", "?");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { d } = deps(async (hash) => {
    if (hash === "slow017") {
      await gate;
      return { client: "qbittorrent", ref: hash };
    }
    return null;
  });
  const tick = pipelineTick(d);
  await new Promise((r) => setTimeout(r, 20));
  await removeGrab(nzb, { blocklist: false, searchNext: false }, d);
  assert.equal(row(nzb).state, "failed");
  release();
  await tick;
  assert.equal(row(nzb).state, "failed", "still removed");
  assert.match(row(nzb).error ?? "", /removed by you/);
  assert.equal(row(slow).state, "downloading");
});

test("a download the user removes while the tick waits on its client stays removed: no blocklist, no next release", async () => {
  const now = Date.now();
  const id = Number(
    db
      .prepare(
        "INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, state, dry_run, origin, why, candidates, attempt, progress_at, client, client_ref) VALUES (?, ?, ?, 1, '[119]', 'Show - 19 [dl]', 'dl-19', 'torrent', 'downloading', 0, 'manual', 'test', ?, 1, ?, 'qbittorrent', 'dl019')",
      )
      .run(now, now, TVDB, JSON.stringify([cand("Show - 19 [next]", "next-19", [119])]), now).lastInsertRowid,
  );
  let answer!: (s: { state: "failed"; progress: number; message: string }) => void;
  const { d, sent } = deps(async () => null);
  d.clients.status = (job) =>
    job.ref === "dl019"
      ? new Promise((r) => (answer = r))
      : Promise.resolve({ state: "queued" as const, progress: 0, clientStatus: "queued" });
  const tick = pipelineTick(d);
  await new Promise((r) => setTimeout(r, 20));
  await removeGrab(id, { blocklist: false, searchNext: false }, d);
  answer({ state: "failed", progress: 0, message: "tracker error" });
  await tick;
  assert.equal(row(id).state, "failed");
  assert.match(row(id).error ?? "", /removed by you/);
  assert.equal(db.prepare("SELECT 1 FROM blocklist WHERE release = 'Show - 19 [dl]'").get(), undefined, "not blocklisted");
  assert.deepEqual(sent, [], "no next release grabbed after the user removed it");
});

// ---------------------------------------------------------------- removed while its release is fetched (M4)

test("removed while its .torrent/.nzb is being fetched: nothing is sent to the client", async () => {
  let fetched!: () => void;
  const { d, sent, removed } = deps(async () => null);
  d.fetchRelease = (r) => new Promise((res) => (fetched = () => res({ data: Buffer.from("x"), filename: r.title })));
  const sending = startGrab(
    { tvdbId: TVDB, episodeIds: [120], candidate: cand("Show - 20", "fetch-20", [120]), fallbacks: [], origin: "manual" },
    d,
  );
  await new Promise((r) => setTimeout(r, 20));
  const id = (db.prepare("SELECT id FROM grabs WHERE guid = 'fetch-20'").get() as { id: number }).id;
  await removeGrab(id, { blocklist: false, searchNext: false }, d);
  fetched();
  const out = await sending;
  assert.equal(out.message, "Cancelled");
  assert.deepEqual(sent, [], "never handed to the client");
  assert.deepEqual(removed, []);
  assert.equal(row(id).state, "failed");
});

test("a send that turns out to be a duplicate, landing after you removed the grab, leaves the earlier torrent alone", async () => {
  let accept!: (j: Job & { duplicate?: boolean }) => void;
  const { d, removed } = deps(async () => null);
  d.clients.addTorrent = () => new Promise((r) => (accept = r));
  const sending = startGrab(
    { tvdbId: TVDB, episodeIds: [121], candidate: cand("Show - 21", "dup-21", [121]), fallbacks: [], origin: "manual" },
    d,
  );
  await new Promise((r) => setTimeout(r, 20));
  const id = (db.prepare("SELECT id FROM grabs WHERE guid = 'dup-21'").get() as { id: number }).id;
  await removeGrab(id, { blocklist: false, searchNext: false }, d);
  accept({ client: "deluge1", ref: "theirs", duplicate: true });
  await sending;
  assert.deepEqual(removed, [], "not AnimeArr's to delete: it was in the client before");
  assert.equal(row(id).state, "failed");
});

test("restart while a removal was in flight (state 'removing'): the grab comes back to needs-attention, never stuck, and can be removed again (L19)", async () => {
  const id = cutOff(22, "torrent", "abc2222");
  db.prepare("UPDATE grabs SET state = 'removing', client = 'qbittorrent' WHERE id = ?").run(id);
  const { d, removed } = deps(async () => null);
  recoverGrabs();
  assert.equal(row(id).state, "needs-attention");
  assert.match(row(id).error ?? "", /restarted during the removal/);
  await removeGrab(id, { blocklist: false, searchNext: false }, d);
  assert.equal(row(id).state, "failed");
  assert.deepEqual(removed, ["abc2222"]);
});
