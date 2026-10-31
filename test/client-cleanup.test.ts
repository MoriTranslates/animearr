/**
 * Clean-up after a confirmed import for NZBGet ("remove finished jobs") and Transmission, against mocked RPC endpoints
 * and throwaway folders: request shapes, and the safety rules (only AnimeArr's own category/label, never unknown or
 * out-of-root folders, seeding rules respected).
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { cleanupGrab } = await import("../server/downloads.js");
const { realClients } = await import("../server/arr/clients.js");
type Cfg = import("../server/settings.js").ClientCfg;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-cc-"));
const NZB_DIR = path.join(tmp, "usenet", "animearr");
const TR_DIR = path.join(tmp, "torrents", "animearr");
const client = (over: Partial<Cfg>): Cfg => ({ id: "x", type: "nzbget", name: "NZBGet", url: "http://nzbget", username: "u", password: "p", category: "animearr", priority: 1, enabled: true, removeCompleted: true, pathMappings: [], ...over });

const write = (p: string, bytes = 10) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, Buffer.alloc(bytes)));
let nextGrab = 100;
const addGrab = (clientId: string, ref: string, state = "done") => {
  const id = ++nextGrab;
  db.prepare("INSERT INTO grabs (id, at, updated_at, tvdb_id, episode_ids, release, guid, protocol, client, client_ref, state, dry_run) VALUES (?, 1, 1, 1, '[]', ?, 'g', 'usenet', ?, ?, ?, 0)").run(id, `Rel.${id}`, clientId, ref, state);
  return id;
};

interface Rpc { method: string; args: unknown }
let rpc: Rpc[] = [];
let realFetch: typeof fetch;
const mock = (handler: (method: string, args: unknown) => unknown, session = false) => {
  rpc = [];
  globalThis.fetch = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    if (session && !init.headers["X-Transmission-Session-Id"]) return new Response("", { status: 409, headers: { "X-Transmission-Session-Id": "sid" } });
    const b = JSON.parse(init.body) as { method: string; params?: unknown; arguments?: unknown };
    const args = b.params ?? b.arguments;
    rpc.push({ method: b.method, args });
    const out = handler(b.method, args);
    return new Response(JSON.stringify(session ? { result: "success", arguments: out } : { result: out, error: null }), { status: 200 });
  }) as typeof fetch;
};
before(() => {
  realFetch = globalThis.fetch;
  patchSettings((s) => ({
    ...s,
    localPathMappings: [{ from: "/data", to: tmp }],
    importer: { ...s.importer, sourceRoots: ["/data/usenet/animearr", "/data/torrents/animearr"] },
    downloads: { ...s.downloads, cleanup: "auto", allowDelete: true },
    extraClients: [client({ id: "nzbget1" }), client({ id: "tr1", type: "transmission", name: "Transmission", url: "http://tr", removeCompleted: false })],
  }));
});
beforeEach(() => {
  db.prepare("DELETE FROM grabs").run();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
});
afterEach(() => (globalThis.fetch = realFetch));

const deps = { torrents: async () => [], sab: async () => [], remove: realClients.remove };
const history = (over: Record<string, unknown> = {}) => [{ NZBID: 42, Status: "SUCCESS/ALL", Category: "animearr", DestDir: "/data/usenet/animearr/Show.S01E01", FinalDir: "", ...over }];

// ---------------------------------------------------------------- NZBGet

test("NZBGet: after an import, a finished job with no video left leaves the history and its folder goes", async () => {
  write(path.join(NZB_DIR, "Show.S01E01", "show.nfo"));
  mock((m) => (m === "history" ? history() : m === "listgroups" ? [] : true));
  const id = addGrab("nzbget1", "42");
  const did = await cleanupGrab(id, "imported", deps);
  assert.match(did ?? "", /deleted the download folder and removed the job from NZBGet/);
  assert.equal(fs.existsSync(path.join(NZB_DIR, "Show.S01E01")), false);
  const edit = rpc.find((r) => r.method === "editqueue");
  assert.deepEqual(edit?.args, ["HistoryFinalDelete", "", [42]], "NZBGet's own call shape: command, parameter, NZBIDs");
});

test("NZBGet: a job in another category is never touched (no delete, folder kept)", async () => {
  write(path.join(NZB_DIR, "Show.S01E01", "show.nfo"));
  mock((m) => (m === "history" ? history({ Category: "tv" }) : m === "listgroups" ? [] : true));
  assert.equal(await cleanupGrab(addGrab("nzbget1", "42"), "imported", deps), null);
  assert.equal(rpc.some((r) => r.method === "editqueue"), false);
  assert.equal(fs.existsSync(path.join(NZB_DIR, "Show.S01E01", "show.nfo")), true);
});

test("NZBGet: a folder that still holds a video stays, and so does the job", async () => {
  write(path.join(NZB_DIR, "Show.S01E01", "unimported.mkv"));
  mock((m) => (m === "history" ? history() : true));
  assert.equal(await cleanupGrab(addGrab("nzbget1", "42"), "imported", deps), null);
  assert.equal(rpc.some((r) => r.method === "editqueue"), false);
  assert.equal(fs.existsSync(path.join(NZB_DIR, "Show.S01E01", "unimported.mkv")), true);
});

test("NZBGet: a folder outside AnimeArr's download folders is never deleted, and the job stays", async () => {
  write(path.join(tmp, "elsewhere", "Show.S01E01", "show.nfo"));
  mock((m) => (m === "history" ? history({ DestDir: "/data/elsewhere/Show.S01E01" }) : true));
  assert.equal(await cleanupGrab(addGrab("nzbget1", "42"), "imported", deps), null);
  assert.equal(rpc.some((r) => r.method === "editqueue"), false);
  assert.equal(fs.existsSync(path.join(tmp, "elsewhere", "Show.S01E01", "show.nfo")), true);
});

test("NZBGet: 'remove finished jobs' off, or a failed job, does nothing; with deleting off only the history entry goes", async () => {
  write(path.join(NZB_DIR, "Show.S01E01", "show.nfo"));
  mock((m) => (m === "history" ? history() : m === "listgroups" ? [] : true));
  patchSettings((s) => ({ ...s, extraClients: s.extraClients.map((c) => (c.id === "nzbget1" ? { ...c, removeCompleted: false } : c)), downloads: { ...s.downloads, allowDelete: false } }));
  assert.equal(await cleanupGrab(addGrab("nzbget1", "42"), "imported", deps), null, "removeCompleted off and deleting off: nothing");
  patchSettings((s) => ({ ...s, extraClients: s.extraClients.map((c) => (c.id === "nzbget1" ? { ...c, removeCompleted: true } : c)) }));
  mock((m) => (m === "history" ? history({ Status: "FAILURE/PAR" }) : true));
  assert.equal(await cleanupGrab(addGrab("nzbget1", "42"), "imported", deps), null, "only a successful job");
  mock((m) => (m === "history" ? history() : m === "listgroups" ? [] : true));
  const did = await cleanupGrab(addGrab("nzbget1", "42"), "imported", deps);
  assert.equal(did, "removed the finished job from NZBGet");
  assert.equal(fs.existsSync(path.join(NZB_DIR, "Show.S01E01", "show.nfo")), true, "deleting is off: the folder stays");
  assert.ok(rpc.some((r) => r.method === "editqueue"));
  patchSettings((s) => ({ ...s, downloads: { ...s.downloads, allowDelete: true } }));
});

// ---------------------------------------------------------------- Transmission

const tor = (over: Record<string, unknown> = {}) => ({ hashString: "ABCDEF0123", name: "Show.S01E01", percentDone: 1, status: 0, downloadDir: "/data/torrents/animearr", labels: ["animearr"], uploadRatio: 2.1, secondsSeeding: 10 * 86400, doneDate: 1_700_000_000, totalSize: 1000, eta: -1, rateDownload: 0, peersSendingToUs: 0, error: 0, errorString: "", ...over });

test("Transmission: an imported torrent whose seeding is done is removed with its data (torrent-remove, delete-local-data)", async () => {
  mock((m) => (m === "torrent-get" ? { torrents: [tor()] } : {}), true);
  const did = await cleanupGrab(addGrab("tr1", "abcdef0123"), "imported", deps);
  assert.equal(did, "removed the torrent (seeding done)");
  const rm = rpc.find((r) => r.method === "torrent-remove");
  assert.deepEqual(rm?.args, { ids: ["abcdef0123"], "delete-local-data": true });
});

test("Transmission: still seeding (ratio and time not met), or a torrent that isn't AnimeArr's label/folder, is left alone", async () => {
  mock((m) => (m === "torrent-get" ? { torrents: [tor({ status: 6, uploadRatio: 0.1, secondsSeeding: 3600, doneDate: Math.floor(Date.now() / 1000) })] } : {}), true);
  assert.equal(await cleanupGrab(addGrab("tr1", "abcdef0123"), "imported", deps), null);
  assert.equal(rpc.some((r) => r.method === "torrent-remove"), false, "seeding rules respected");
  mock((m) => (m === "torrent-get" ? { torrents: [tor({ labels: ["tv"], downloadDir: "/data/torrents/tv" })] } : {}), true);
  assert.equal(await cleanupGrab(addGrab("tr1", "abcdef0123"), "imported", deps), null);
  assert.equal(rpc.some((r) => r.method === "torrent-remove"), false, "not our label: never removed");
});

test("Transmission: a rejected torrent goes only after an hour; deleting switched off removes nothing", async () => {
  mock((m) => (m === "torrent-get" ? { torrents: [tor({ status: 4, percentDone: 0.5 })] } : {}), true);
  const fresh = addGrab("tr1", "abcdef0123", "failed");
  db.prepare("UPDATE grabs SET updated_at = ? WHERE id = ?").run(Date.now(), fresh);
  assert.equal(await cleanupGrab(fresh, "rejected", deps), null);
  const old = addGrab("tr1", "abcdef0123", "failed");
  db.prepare("UPDATE grabs SET updated_at = ? WHERE id = ?").run(Date.now() - 2 * 3_600_000, old);
  assert.match((await cleanupGrab(old, "rejected", deps)) ?? "", /removed the rejected torrent/);
  patchSettings((s) => ({ ...s, downloads: { ...s.downloads, allowDelete: false } }));
  rpc = [];
  assert.equal(await cleanupGrab(addGrab("tr1", "abcdef0123"), "imported", deps), null);
  assert.equal(rpc.length, 0, "no request at all");
  patchSettings((s) => ({ ...s, downloads: { ...s.downloads, allowDelete: true } }));
});
