/** Download-folder rules and the clean-up, on throwaway folders and mocked clients only. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { measure, evaluate, grabGate, cleanupPlan, runCleanup } = await import("../server/downloads.js");
type OwnTorrent = import("../server/arr/clients.js").OwnTorrent;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-dl-"));
const SAB = path.join(tmp, "completed", "animearr");
const QB = path.join(tmp, "qbittorrent", "completed", "animearr");
const write = (p: string, bytes: number) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, Buffer.alloc(bytes)));
const old = (p: string) => fs.utimesSync(p, new Date(Date.now() - 3 * 86_400_000), new Date(Date.now() - 3 * 86_400_000));
const torrent = (over: Partial<OwnTorrent> = {}): OwnTorrent => ({ hash: "abc", name: "Show.S01E01", contentPath: "/data/qbittorrent/completed/animearr/Show.S01E01.mkv", savePath: "/data/qbittorrent/completed/animearr", size: 3000, state: "uploading", ratio: 0.2, seedingTimeSec: 3600, completedOn: Date.now() - 3600_000, ratioLimit: -2, seedingTimeLimitMin: -2, ...over });
const sabHist = async () => [
  { nzoId: "SAB_1", storage: "/data/completed/animearr/Usenet.Show.S01E02-xpost", status: "Completed" },
  { nzoId: "SAB_3", storage: "/data/completed/animearr/Pack.S01", status: "Completed" },
];
const deps = (t: OwnTorrent[] = [torrent()]) => ({ torrents: async () => t, sab: sabHist });

before(() => {
  patchSettings((s) => ({ ...s, localPathMappings: [{ from: "/data", to: tmp }], importer: { ...s.importer, sourceRoots: ["/data/completed/animearr", "/data/qbittorrent/completed/animearr"] }, sabnzbd: { ...s.sabnzbd, category: "animearr" }, qbittorrent: { ...s.qbittorrent, category: "animearr" } }));
  const ins = db.prepare("INSERT INTO grabs (at, updated_at, tvdb_id, episode_ids, release, guid, protocol, client, client_ref, state, dry_run, movie_id) VALUES (1, 1, 1, '[]', ?, 'g', ?, ?, ?, ?, 0, ?)");
  ins.run("Usenet.Show.S01E02", "usenet", "sabnzbd", "SAB_1", "done", null);
  ins.run("Show.S01E01", "torrent", "qbittorrent", "abc", "done", null);
  ins.run("Pack.S01", "usenet", "sabnzbd", "SAB_3", "done", null);
  write(path.join(SAB, "Usenet.Show.S01E02-xpost", "readme.txt"), 10);
  write(path.join(SAB, "Pack.S01", "Pack.S00E01.special.mkv"), 1000); // a special left for Radarr: stays
  write(path.join(SAB, "Mystery.Folder", "a.mkv"), 2000);
  old(path.join(SAB, "Mystery.Folder"));
  write(path.join(SAB, "_UNPACK_Something", "x.mkv"), 100);
  old(path.join(SAB, "_UNPACK_Something"));
  write(path.join(QB, "Show.S01E01.mkv"), 3000);
  write(path.join(QB, "Unknown.Torrent.mkv"), 3000);
  old(path.join(QB, "Unknown.Torrent.mkv"));
});

test("measure: AnimeArr's folders only, ownership from the clients; imported-and-seeding torrents left out", async () => {
  const m = await measure({ fresh: true }, deps());
  assert.equal(m.items.length, 6);
  assert.equal(m.items.find((i) => i.name === "Usenet.Show.S01E02-xpost")?.grab?.id, 1, "SABnzbd's history path, not a name guess");
  assert.equal(m.byScope.both.items, 5, "the seeding torrent isn't counted");
});

test("rules: strictest wins, backlog-only lets new episodes through, pause-until-cleared waits for resume-at, manual grabs pass", async () => {
  patchSettings((s) => ({ ...s, downloads: { ...s.downloads, freeSpaceGb: 1, rules: [{ id: "a", name: "Items", metric: "items", threshold: 2, action: "pauseUntilUnder", resumeAt: null, scope: "both", applies: "backlog", enabled: true }] } }));
  const m = await measure({ fresh: true }, deps());
  evaluate(m);
  assert.equal(grabGate("show", false).paused, true);
  assert.equal(grabGate("show", true).paused, false, "new episodes still come");
  assert.equal(grabGate("show", false, { manual: true }).paused, false, "a grab started by hand passes the folder rules");
  patchSettings((s) => ({ ...s, downloads: { ...s.downloads, rules: [{ id: "b", name: "Hard", metric: "items", threshold: 2, action: "pauseUntilCleared", resumeAt: 1, scope: "both", applies: "all", enabled: true }] } }));
  evaluate(m);
  assert.equal(grabGate("movie", true).paused, true);
  evaluate({ ...m, byScope: { ...m.byScope, both: { sizeGb: 0, items: 2 } } });
  assert.equal(grabGate("movie", true).paused, true, "still above resume-at");
  evaluate({ ...m, byScope: { ...m.byScope, both: { sizeGb: 0, items: 1 } } });
  assert.equal(grabGate("movie", true).paused, false);
  patchSettings((s) => ({ ...s, downloads: { ...s.downloads, rules: [] } }));
});

test("free space under the limit pauses everything, even manual grabs", async () => {
  const m = await measure({ fresh: true }, deps());
  patchSettings((s) => ({ ...s, downloads: { ...s.downloads, freeSpaceGb: 100_000 } }));
  evaluate(m);
  assert.match((grabGate("show", true, { manual: true }) as { why: string }).why, /free/);
  patchSettings((s) => ({ ...s, downloads: { ...s.downloads, freeSpaceGb: 1 } }));
  evaluate(m);
});

test("clean-up plan: only client-owned leftovers; torrents through qBittorrent once seeding is done; unknown SAB folders moved aside", async () => {
  const { actions } = await cleanupPlan(deps([torrent({ state: "pausedUP", ratio: 2 })]));
  const kinds = actions.map((a) => `${a.step}:${path.posix.basename(a.target)}`).sort();
  assert.deepEqual(kinds, ["leftover:Show.S01E01.mkv", "leftover:Usenet.Show.S01E02-xpost", "quarantine:Mystery.Folder"]);
  // Seeding not done: the torrent stays.
  assert.ok(!(await cleanupPlan(deps())).actions.some((a) => a.client === "qbittorrent"));
  // qBittorrent unreadable: nothing in its folder is touched.
  const broken = await cleanupPlan({ torrents: async () => Promise.reject(new Error("down")), sab: sabHist });
  assert.ok(!broken.actions.some((a) => a.client === "qbittorrent"));
});

test("running the clean-up: deletions gated; torrents only through the client; moved aside, never deleted", async () => {
  const removed: string[] = [];
  const d = { ...deps([torrent({ state: "pausedUP", ratio: 2 })]), remove: async (j: { ref: string }) => void removed.push(j.ref) };
  const res = await runCleanup({}, d as never);
  assert.ok(res.filter((r) => r.action.destructive).every((r) => !r.ok), "no deletions while not allowed");
  assert.ok(fs.existsSync(path.join(SAB, "Usenet.Show.S01E02-xpost", "readme.txt")));
  assert.ok(fs.existsSync(path.join(SAB, ".animearr-quarantine", "Mystery.Folder")));
  patchSettings((s) => ({ ...s, downloads: { ...s.downloads, allowDelete: true } }));
  await runCleanup({}, d as never);
  assert.equal(fs.existsSync(path.join(SAB, "Usenet.Show.S01E02-xpost")), false);
  assert.deepEqual(removed, ["abc"]);
  assert.ok(fs.existsSync(path.join(QB, "Show.S01E01.mkv")), "a torrent's data is never deleted from disk by AnimeArr itself");
  assert.ok(fs.existsSync(path.join(QB, "Unknown.Torrent.mkv")), "unknown torrent data is never touched");
  assert.ok(fs.existsSync(path.join(SAB, "Pack.S01", "Pack.S00E01.special.mkv")), "a download with a video left stays");
  assert.ok(fs.existsSync(path.join(SAB, "_UNPACK_Something")), "unpacking folders stay");
});

test("free space on Unraid: the cache pool counts when downloads sit on the FUSE union (shfs)", async () => {
  const { mountOf, freeSpaceTarget } = await import("../server/downloads.js");
  const mounts = "rootfs / rootfs rw 0 0\nshfs /data fuse.shfs rw 0 0\n/dev/nvme0n1p1 /unraid/cache btrfs ro 0 0\n";
  assert.deepEqual(mountOf("/data/completed/animearr", mounts), { point: "/data", type: "fuse.shfs" });
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-cache-"));
  assert.deepEqual(freeSpaceTarget("/data/completed/animearr", mounts, cache), { path: cache, label: "cache" });
  assert.equal(freeSpaceTarget("/data/completed/animearr", "xfs /data xfs rw 0 0\n", cache), null, "a plain disk is measured as is");
  assert.equal(freeSpaceTarget("/data/completed/animearr", mounts, path.join(cache, "missing")), null, "no cache mount: the share itself");
  patchSettings((s) => ({ ...s, downloads: { ...s.downloads, freeSpacePath: "/mnt/somewhere" } }));
  assert.deepEqual(freeSpaceTarget("/data/x", mounts, cache), { path: "/mnt/somewhere", label: "somewhere" }, "the setting wins");
  patchSettings((s) => ({ ...s, downloads: { ...s.downloads, freeSpacePath: "" } }));
});
