/** After-import check + repair, with mocks (no Sonarr, no files). */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-repair-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { checkNewImports } = await import("../server/repair.js");
const { planSchedule } = await import("../server/managed.js");
type Deps = import("../server/repair.js").RepairDeps;
type Probe = import("../server/verify.js").ProbeResult;

before(() => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, original_language, synced_at) VALUES (10, 800001, 'Managed Show', '/media/AnimeArr/Managed Show', 0, 'Japanese', 0)").run();
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, original_language, synced_at) VALUES (11, 800002, 'Other Show', '/media/AnimeArr/Other Show', 1, 'Japanese', 0)").run();
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, original_language, synced_at) VALUES (12, 800003, 'Main Library', '/media/Anime/Main Library', 1, 'Japanese', 0)").run();
  for (const [id, sid, ep] of [[1001, 10, 1], [1002, 10, 2], [1003, 11, 1], [1004, 12, 1], [1005, 10, 3], [1006, 10, 4], [1007, 10, 5], [1008, 10, 6], [1009, 11, 2], [1010, 11, 3], [1011, 10, 7]]) cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, runtime) VALUES (?, ?, 1, ?, 1, 1, 24)").run(id, sid, ep);
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (800001, 10, 'Managed Show', 0, 0)").run();
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/AnimeArr"], managed: { ...s.managed, dryRun: false }, repair: { mode: "log", maxPerDay: 10 } }));
});

let hid = 100;
const item = (episodeId: number, seriesId: number, title: string, show: string, downloadId?: string) => ({ id: ++hid, episodeId, seriesId, sourceTitle: title, date: new Date().toISOString(), downloadId: downloadId ?? `dl${hid}`, eventType: "downloadFolderImported", data: { fileId: String(hid), importedPath: `/media/${seriesId === 12 ? "Anime" : "AnimeArr"}/${show}/Season 1/x${hid}.mkv`, releaseGroup: "Group" } });

function deps(items: ReturnType<typeof item>[], probes: Record<number, Partial<Probe>>, sonarrSubs: Record<number, string>) {
  const calls = { failed: [] as number[], failNext: false };
  const d: Deps = {
    history: async () => items,
    episodeFile: async (id) => ({ id, seriesId: 0, seasonNumber: 1, path: "", size: 1, quality: { quality: { name: "x" } }, mediaInfo: { subtitles: sonarrSubs[id] ?? "", audioLanguages: "jpn" } }),
    grabsOf: async (episodeId) => [{ id: 9000 + episodeId, episodeId, seriesId: 0, sourceTitle: items.find((i) => i.episodeId === episodeId)!.sourceTitle, date: "", downloadId: items.find((i) => i.episodeId === episodeId)!.downloadId, eventType: "grabbed", data: {} }],
    markFailed: async (id) => {
      if (calls.failNext) throw new Error("Sonarr said 500");
      calls.failed.push(id);
    },
    probe: async (f) => ({ subs: [], audio: ["ja"], durationSec: 1400, sidecars: [], untagged: 0, ...(probes[Number(f.match(/x(\d+)/)![1])] ?? {}) }),
    localPath: (p) => p,
  };
  return { d, calls };
}

test("log mode: a forced-only English track is reported (would repair), nothing is changed", async () => {
  const a = item(1001, 10, "[BadGroup] Managed Show - 01 [1080p]", "Managed Show");
  const { d, calls } = deps([a], { [a.id]: { subs: [], forced: ["en"] } }, { [a.id]: "eng" });
  const r = await checkNewImports(d);
  assert.equal(r[0].action, "would-repair");
  assert.match(r[0].why, /forced\/signs en track/);
  assert.equal(calls.failed.length, 0);
  assert.equal(db.prepare("SELECT 1 FROM blocklist WHERE release = ?").get(a.sourceTitle), undefined);
  const again = await checkNewImports(d);
  assert.equal(again.length, 0, "each import is checked once");
});

test("auto mode: two signals → managed show is blocklisted and re-searched by AnimeArr; other show is failed in Sonarr", async () => {
  patchSettings((s) => ({ ...s, repair: { mode: "auto", maxPerDay: 10 } }));
  const m = item(1002, 10, "[ZhGroup] Managed Show - 02 [CHS]", "Managed Show");
  const o = item(1003, 11, "[ZhGroup] Other Show - 01 [CHS]", "Other Show");
  const { d, calls } = deps([m, o], { [m.id]: { subs: ["zh"] }, [o.id]: { subs: ["zh"] } }, { [m.id]: "chi", [o.id]: "chi" });
  const r = await checkNewImports(d);
  assert.deepEqual(r.map((x) => x.action), ["repaired", "repaired"]);
  assert.ok(db.prepare("SELECT 1 FROM blocklist WHERE release = ?").get(m.sourceTitle));
  assert.equal((db.prepare("SELECT state FROM search_state WHERE episode_id = 1002").get() as { state: string }).state, "replace");
  // The bad file is still there: the scheduler must not end the search because "Sonarr has a file".
  cache.prepare("UPDATE episodes SET air_utc = ? WHERE id = 1002").run(Date.now() - 86_400_000);
  planSchedule();
  assert.equal((db.prepare("SELECT state FROM search_state WHERE episode_id = 1002").get() as { state: string }).state, "replace");
  assert.deepEqual(calls.failed, [9000 + 1003], "Sonarr's grab marked failed for the non-managed show");
});

test("one signal only (Sonarr's track info says English) → suspected, nothing changed", async () => {
  const a = item(1005, 10, "[Group] Managed Show - 03 [1080p]", "Managed Show");
  const { d, calls } = deps([a], { [a.id]: { subs: [] } }, { [a.id]: "eng" });
  const r = await checkNewImports(d);
  assert.equal(r[0].action, "suspected");
  assert.equal(calls.failed.length, 0);
});

test("files outside the allowed roots are ignored; AnimeArr's own grabs are skipped; daily cap holds", async () => {
  const outside = item(1004, 12, "[ZhGroup] Main Library - 01 [CHS]", "Main Library");
  const ownTitle = "[SubsPlease] Managed Show - 04 (1080p)";
  db.prepare("INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, state, dry_run, client_ref) VALUES (0, 0, 800001, 10, '[1006]', ?, 'g', 'torrent', 'done', 0, 'abcdef0123')").run(ownTitle);
  const own = item(1006, 10, "Managed.Show.S01E04.1080p.mkv", "Managed Show", "ABCDEF0123");
  const { d } = deps([outside, own], {}, {});
  const r = await checkNewImports(d);
  assert.deepEqual(r.map((x) => x.action), ["skipped"]);
  patchSettings((s) => ({ ...s, repair: { mode: "auto", maxPerDay: 2 } }));
  const c = item(1001, 10, "[ZhGroup] Managed Show - 01 v2 [CHS]", "Managed Show");
  const deps2 = deps([c], { [c.id]: { subs: ["zh"] } }, { [c.id]: "chi" });
  const r2 = await checkNewImports(deps2.d);
  assert.equal(r2[0].action, "capped", r2[0].why);
});

test("a bad season pack is one repair: blocklisted once, each episode re-searched, one unit of the daily budget", async () => {
  patchSettings((s) => ({ ...s, repair: { mode: "auto", maxPerDay: 10 } }));
  const pack = "[ZhGroup] Managed Show S01 [CHS]";
  const a = item(1007, 10, pack, "Managed Show", "PACK1");
  const b = item(1008, 10, pack, "Managed Show", "PACK1");
  const { d } = deps([a, b], { [a.id]: { subs: ["zh"] }, [b.id]: { subs: ["zh"] } }, { [a.id]: "chi", [b.id]: "chi" });
  const r = await checkNewImports(d);
  assert.deepEqual(r.map((x) => x.action), ["repaired", "repaired"]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM blocklist WHERE release = ?").get(pack) as { n: number }).n, 1);
  for (const e of [1007, 1008]) assert.equal((db.prepare("SELECT state FROM search_state WHERE episode_id = ?").get(e) as { state: string }).state, "replace");
});

test("a Sonarr error during repair is recorded once and not retried", async () => {
  const a = item(1009, 11, "[ZhGroup] Other Show - 02 [CHS]", "Other Show");
  const { d, calls } = deps([a], { [a.id]: { subs: ["zh"] } }, { [a.id]: "chi" });
  calls.failNext = true;
  const r = await checkNewImports(d);
  assert.equal(r[0].action, "error");
  assert.equal((await checkNewImports(d)).length, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM blocklist WHERE release = ?").get(a.sourceTitle) as { n: number }).n, 1);
});

test("global dry-run: non-managed shows aren't touched; a short file alone is only suspected; unknown shows wait", async () => {
  patchSettings((s) => ({ ...s, managed: { ...s.managed, dryRun: true } }));
  const a = item(1010, 11, "[ZhGroup] Other Show - 03 [CHS]", "Other Show");
  const short = item(1011, 10, "[Group] Managed Show - 07", "Managed Show");
  const unknown = { ...item(1, 99, "[Group] New Show - 01", "New Show"), seriesId: 99 };
  const { d, calls } = deps([a, short, unknown], { [a.id]: { subs: ["zh"] }, [short.id]: { subs: ["en"], durationSec: 300 } }, { [a.id]: "chi", [short.id]: "eng" });
  const r = await checkNewImports(d);
  assert.deepEqual(r.map((x) => x.action), ["would-repair", "suspected"]);
  assert.equal(calls.failed.length, 0);
  patchSettings((s) => ({ ...s, managed: { ...s.managed, dryRun: false } }));
});
