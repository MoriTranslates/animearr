/** Blackhole download clients (Usenet and Torrent): off by default, never auto-picked over a real client, folder drop and watch. Temp folders only. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-bh-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { db, cache } = await import("../server/db.js");
const { patchSettings, getSettings } = await import("../server/settings.js");
const { saveClient } = await import("../server/connectionsAdmin.js");
const { clientsFor, partialCapable } = await import("../server/arr/clients.js");
const { blackholeDriver, normName, isTempName, STABLE_MS } = await import("../server/arr/blackhole.js");
const { cleanupGrab } = await import("../server/downloads.js");
type Cfg = import("../server/settings.js").ClientCfg;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-bh-data-"));
const WATCH = path.join(tmp, "bh", "watch");
const DONE = path.join(tmp, "bh", "completed");
before(() => {
  fs.mkdirSync(WATCH, { recursive: true });
  fs.mkdirSync(DONE, { recursive: true });
  patchSettings((s) => ({ ...s, localPathMappings: [{ from: "/data", to: tmp }], importer: { ...s.importer, sourceRoots: ["/data/completed/animearr"] }, downloads: { ...s.downloads, cleanup: "auto", allowDelete: true } }));
});

test("a new blackhole starts off, and can't be turned on until its folders pass (completed folder must be a source root)", () => {
  const c = saveClient(null, { type: "blackhole-torrent", watchFolder: "/data/bh/watch", completedFolder: "/data/bh/completed" });
  assert.equal(c.enabled, false, "off by default");
  assert.equal(c.saveMagnets, false);
  assert.equal(c.timeoutHours, 24);
  assert.throws(() => saveClient(c.id, { ...c, enabled: true }), /source roots/);
  patchSettings((s) => ({ ...s, importer: { ...s.importer, sourceRoots: ["/data/completed/animearr", "/data/bh/completed"] } }));
  assert.equal(saveClient(c.id, { ...c, enabled: true }).enabled, true);
  assert.equal(partialCapable("blackhole-torrent"), false, "no file selection: batches use the whole-download fallback");
});

test("never picked automatically while a real client of the protocol is on, unless it is the preferred one", () => {
  const bh = getSettings().extraClients.find((x) => x.type === "blackhole-torrent")!;
  // No real torrent client: the blackhole is used.
  assert.deepEqual(clientsFor("torrent").map((c) => c.id), [bh.id]);
  // qBittorrent configured and on (priority 1); the blackhole at priority 50, then at the same priority 1: never picked.
  patchSettings((s) => ({ ...s, qbittorrent: { ...s.qbittorrent, url: "http://qb:8080" } }));
  assert.deepEqual(clientsFor("torrent").map((c) => c.id), ["qbittorrent"]);
  saveClient(bh.id, { ...bh, priority: 1 });
  assert.deepEqual(clientsFor("torrent").map((c) => c.id), ["qbittorrent"]);
  // Preferred: a better priority than every real client.
  patchSettings((s) => ({ ...s, clientPrefs: { ...s.clientPrefs, qbittorrent: { priority: 5, enabled: true } } }));
  assert.deepEqual(clientsFor("torrent").map((c) => c.id), [bh.id, "qbittorrent"]);
  // qBittorrent switched off: the blackhole is the only one again.
  patchSettings((s) => ({ ...s, clientPrefs: { ...s.clientPrefs, qbittorrent: { priority: 5, enabled: false } } }));
  assert.deepEqual(clientsFor("torrent").map((c) => c.id), [bh.id]);
});

const cfg = (o: Partial<Cfg> = {}): Cfg => ({ id: "bh1", type: "blackhole-torrent", name: "Torrent Blackhole", url: "", username: "", password: "", category: "animearr", priority: 50, enabled: true, removeCompleted: false, pathMappings: [], watchFolder: "/data/bh/watch", completedFolder: "/data/bh/completed", saveMagnets: false, timeoutHours: 24, ...o });

test("grab drops the file named after the release; magnets only with .magnet files on", async () => {
  let now = 1_000_000;
  const d = blackholeDriver({ local: (p) => p.replace("/data", tmp), sourceRoots: () => ["/data/bh/completed"], now: () => now });
  const r = await d.addTorrent(cfg(), { data: Buffer.from("d4:infod4:name1:aee") }, "[Grp] Show: Part 2 - 01 (1080p)");
  assert.ok(fs.existsSync(path.join(WATCH, "[Grp] Show_ Part 2 - 01 (1080p).torrent")));
  // The same name again: never overwritten.
  await d.addTorrent(cfg(), { data: Buffer.from("x") }, "[Grp] Show: Part 2 - 01 (1080p)");
  assert.ok(fs.existsSync(path.join(WATCH, "[Grp] Show_ Part 2 - 01 (1080p) (1).torrent")));
  await assert.rejects(d.addTorrent(cfg(), { magnet: "magnet:?xt=urn:btih:x" }, "Mag"), /refused a magnet-only release/);
  await d.addTorrent(cfg({ saveMagnets: true }), { magnet: "magnet:?xt=urn:btih:x" }, "Mag");
  assert.equal(fs.readFileSync(path.join(WATCH, "Mag.magnet"), "utf8"), "magnet:?xt=urn:btih:x");
  const n = await d.addNzb(cfg({ type: "blackhole-usenet" }), Buffer.from("<nzb/>"), "Show.S01E02.1080p");
  assert.ok(fs.existsSync(path.join(WATCH, "Show.S01E02.1080p.nzb")));
  assert.match(n, /^1000000:Show\.S01E02\.1080p$/);
  // Remove: only the watch file (AnimeArr can't remove it from your downloader).
  await d.remove(cfg(), r.ref);
  assert.equal(fs.existsSync(path.join(WATCH, "[Grp] Show_ Part 2 - 01 (1080p).torrent")), false);
  now += 1;
});

test("completion: waits, ignores temp names, needs the same size twice a minute apart; times out after the limit", async () => {
  let now = 5_000_000;
  const d = blackholeDriver({ local: (p) => p.replace("/data", tmp), sourceRoots: () => ["/data/bh/completed"], now: () => now });
  const ref = `${now}:[Grp] Show - 03 (1080p)`;
  let st = await d.status(cfg(), ref);
  assert.equal(st.state, "queued");
  assert.equal(st.clientStatus, "Waiting for download…");
  assert.equal(st.progress, 0);
  // Still being written (qBittorrent's .!qB, a _UNPACK_ folder): not it yet.
  fs.writeFileSync(path.join(DONE, "[Grp] Show - 03 (1080p).mkv.!qB"), "partial");
  fs.mkdirSync(path.join(DONE, "_UNPACK_[Grp] Show - 03 (1080p)"));
  assert.equal(isTempName("[Grp] Show - 03 (1080p).mkv.!qB"), true);
  assert.equal((await d.status(cfg(), ref)).state, "queued");
  fs.renameSync(path.join(DONE, "[Grp] Show - 03 (1080p).mkv.!qB"), path.join(DONE, "[Grp] Show - 03 (1080p).mkv"));
  st = await d.status(cfg(), ref);
  assert.equal(st.state, "queued", "first sighting: size recorded");
  now += STABLE_MS / 2;
  assert.equal((await d.status(cfg(), ref)).state, "queued", "too soon");
  now += STABLE_MS;
  st = await d.status(cfg(), ref);
  assert.equal(st.state, "completed");
  assert.equal(st.path, "/data/bh/completed/[Grp] Show - 03 (1080p).mkv");
  assert.equal(normName("[Grp] Show - 03 (1080p).mkv"), normName("[Grp] Show - 03 (1080p)"));
  // Never seen: failed after the timeout (the pipeline blocklists and tries the next release).
  const old = `${now - 25 * 3_600_000}:Never Arrives`;
  st = await d.status(cfg(), old);
  assert.equal(st.state, "failed");
  assert.match(st.message!, /within 24 h/);
});

test("Usenet blackhole: after a confirmed import its finished folder goes (inside a source root, deleting on); torrents never", async () => {
  patchSettings((s) => ({ ...s, extraClients: [...s.extraClients, cfg({ id: "bhu", type: "blackhole-usenet" }), cfg({ id: "bht", type: "blackhole-torrent" })] }));
  fs.mkdirSync(path.join(DONE, "Show.S01E04.1080p"), { recursive: true });
  fs.writeFileSync(path.join(DONE, "Show.S01E04.1080p", "show.nfo"), "x");
  const ins = (client: string, release: string) => Number(db.prepare("INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, client, client_ref, state, dry_run, origin, why, candidates) VALUES (0, 0, 1, 1, '[]', ?, 'g', 'usenet', ?, ?, 'done', 0, 'manual', '', '[]')").run(release, client, `1:${release}`).lastInsertRowid);
  const none = { torrents: async () => [], sab: async () => [], remove: async () => undefined };
  assert.match((await cleanupGrab(ins("bhu", "Show.S01E04.1080p"), "imported", none))!, /deleted the download folder/);
  assert.equal(fs.existsSync(path.join(DONE, "Show.S01E04.1080p")), false);
  fs.mkdirSync(path.join(DONE, "Show.S01E05.1080p"), { recursive: true });
  assert.equal(await cleanupGrab(ins("bht", "Show.S01E05.1080p"), "imported", none), null);
  assert.ok(fs.existsSync(path.join(DONE, "Show.S01E05.1080p")), "a torrent blackhole's files are your downloader's (it may be seeding)");
  void cache;
});
