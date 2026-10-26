/** Dual-audio upgrades: placeholders, log vs auto, budget, follow-ups, stale cache, strict import check. Mocks only. */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-upgrade-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");

// These tests cover the earlier Sonarr/Radarr import route; the settings can't choose it any more.
patchSettings((s) => ({ ...s, importer: { ...s.importer, engine: "sonarr" } }));

// AnimeArr owns "wanted" for movies: mirror the fixtures' monitored flag into it before each test.
beforeEach(() => {
  for (const r of cache.prepare("SELECT id, monitored FROM movies").all() as { id: number; monitored: number }[]) db.prepare("INSERT OR REPLACE INTO movie_wanted (movie_id, wanted, at) VALUES (?, ?, 0)").run(r.id, r.monitored);
});
const { setSeriesPrefs } = await import("../server/profiles.js");
const { placeholders, qualifies, upgradePass } = await import("../server/upgrade.js");
const { startGrab, pipelineTick } = await import("../server/pipeline.js");
type Deps = import("../server/upgrade.js").UpgradeDeps;
type SR = import("../server/search.js").SearchResult;
type PDeps = import("../server/pipeline.js").PipelineDeps;

const DAY = 86_400_000;
const now = Date.now();
before(() => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, original_language, synced_at) VALUES (30, 600001, 'Dual Show', '/media/AnimeArr/Dual Show', 0, 'Japanese', 0), (31, 600002, 'Sub Show', '/media/AnimeArr/Sub Show', 0, 'Japanese', 0)").run();
  // [episode id, series, ep, audio, monitored]
  for (const [id, sid, ep, audio, mon] of [[3001, 30, 1, "jpn", 1], [3002, 30, 2, "jpn/eng", 1], [3003, 30, 3, "jpn", 1], [3004, 30, 4, "jpn", 0], [3101, 31, 1, "jpn", 1]] as const) {
    cache.prepare("INSERT INTO files (id, series_id, season, path, audio_langs, sub_langs, resolution) VALUES (?, ?, 1, ?, ?, 'eng', '1920x1080')").run(id + 50000, sid, `/x/${id}.mkv`, audio);
    cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, file_id, air_utc, runtime) VALUES (?, ?, 1, ?, ?, 1, ?, ?, 24)").run(id, sid, ep, mon, id + 50000, now - 20 * DAY);
  }
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (600001, 30, 'Dual Show', 0, 0), (600002, 31, 'Sub Show', 0, 0)").run();
  setSeriesPrefs(600001, null, "dual");
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/AnimeArr"], managed: { ...s.managed, dryRun: false }, dualUpgrade: { mode: "log", perHour: 1, recheckDays: 3, maxAgeDays: 365 } }));
});

const result = (title: string, over: Partial<SR> & { flags?: string[]; langProb?: number } = {}): SR =>
  ({
    guid: `g-${title}`, title, indexer: "X", indexerId: 1, protocol: "usenet", size: 1e9, seeders: null, publishDate: null, ageHours: 1, episodeIds: [], label: "S01", confidence: 95, coversTarget: true, extra: 0,
    rank: { accept: true, score: 100, langProb: over.langProb ?? 0.95, lang: "en", langSource: "x", flags: (over.flags ?? ["dual"]).map((k) => ({ key: k, label: k, tone: "info" })), why: "dual audio", reject: null },
    mappingWhy: [], group: null, downloadUrl: "http://x",
    ...over,
  }) as SR;

function deps(results: SR[]) {
  const calls = { searched: [] as number[], grabbed: [] as { title: string; purpose?: string | null }[] };
  let gid = 900;
  const d: Deps = {
    search: (async (_tvdb: number, eps: number[]) => (calls.searched.push(eps[0]), { results })) as never,
    grab: (async (req: { candidate: { title: string }; episodeIds: number[]; purpose?: string | null }) => {
      calls.grabbed.push({ title: req.candidate.title, purpose: req.purpose });
      const id = ++gid;
      db.prepare("INSERT INTO grabs (id, at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, state, dry_run, purpose) VALUES (?, 0, 0, 600001, 30, ?, ?, ?, 'usenet', 'downloading', 0, 'dual-upgrade')").run(id, JSON.stringify(req.episodeIds), req.candidate.title, `g-${id}`);
      return { id, dryRun: false, message: "Sent to sabnzbd" };
    }) as never,
  };
  return { d, calls };
}

test("placeholders: only monitored sub-only files of dual-mode managed shows in allowed roots", () => {
  assert.deepEqual(placeholders(now).map((p) => p.episodeId).sort(), [3001, 3003]);
});

test("qualifies: named dual audio only; no placeholders, burn-ins, or lower resolution", () => {
  assert.ok(qualifies(result("[G] Dual Show - 01 [1080p][Dual Audio]"), 80, 1080));
  assert.ok(!qualifies(result("[G] Dual Show - 01 [1080p]", { flags: [] }), 80, 1080), "dub only probable (learned), not named dual");
  assert.ok(!qualifies(result("[G] Dual Show - 01 [1080p][Dual Audio]", { flags: ["dual", "burnIn"] }), 80, 1080));
  assert.ok(!qualifies(result("[G] Dual Show - 01 [480p][Dual Audio]"), 80, 1080), "lower resolution than the placeholder");
});

test("log mode reports within the hourly budget; nothing grabbed", async () => {
  const { d, calls } = deps([result("[G] Dual Show - 01 [subs only]", { flags: ["placeholder"] }), result("[G] Dual Show - 01 [1080p][Dual Audio]")]);
  const r = await upgradePass(d, now);
  assert.equal(r.searched, 1, "budget: 1 per hour");
  assert.equal(calls.grabbed.length, 0);
  assert.equal((db.prepare("SELECT state FROM upgrade_state WHERE episode_id = ?").get(calls.searched[0]) as { state: string }).state, "found");
});

test("auto mode: grabs marked dual-upgrade; done → upgraded even while the cache is stale; no repeat search", async () => {
  patchSettings((s) => ({ ...s, dualUpgrade: { ...s.dualUpgrade, mode: "auto", perHour: 5 } }));
  db.prepare("DELETE FROM upgrade_state").run();
  db.prepare("DELETE FROM upgrade_searches").run();
  const { d, calls } = deps([result("[G] Dual Show - 01 [1080p][Dual Audio]")]);
  await upgradePass(d, now);
  assert.deepEqual(calls.grabbed.map((g) => g.purpose), ["dual-upgrade", "dual-upgrade"]);
  db.prepare("UPDATE grabs SET state = 'done' WHERE purpose = 'dual-upgrade'").run();
  const again = deps([result("[G] Dual Show - 01 [1080p][Dual Audio]")]);
  db.prepare("DELETE FROM upgrade_searches").run();
  await upgradePass(again.d, now + 10 * DAY);
  assert.equal((db.prepare("SELECT state FROM upgrade_state WHERE episode_id = 3001").get() as { state: string }).state, "upgraded");
  assert.equal(again.calls.searched.length, 0, "the cache still shows the old file: wait for the refresh, don't search again");
  // The refresh shows the new file with the dub: done.
  cache.prepare("UPDATE files SET audio_langs = 'jpn/eng' WHERE id IN (?, ?)").run(3001 + 50000, 3003 + 50000);
  await upgradePass(again.d, now + 11 * DAY);
  assert.equal((db.prepare("SELECT state FROM upgrade_state WHERE episode_id = 3001").get() as { state: string }).state, "upgraded");
});

test("import of a dual-upgrade grab is strict: a sub-only file fails before it replaces anything", async () => {
  cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, file_id, air_utc, runtime) VALUES (3005, 30, 1, 5, 1, 1, NULL, 0, 24)").run();
  const imports: unknown[] = [];
  const pd: PDeps = {
    clients: { addNzb: async () => ({ client: "sabnzbd", ref: "nzo9" }), addTorrent: async () => ({ client: "qbittorrent", ref: "h" }), remove: async () => undefined, status: async () => ({ state: "completed", progress: 1, path: "/data/usenet/animearr/Dual Show - 05" }) },
    fetchRelease: async (r) => ({ data: Buffer.from("x"), filename: r.title }),
    sonarr: { preview: async (folder: string) => [{ path: `${folder}/Dual Show - 05.mkv`, size: 4e8, quality: {}, languages: [] }], importFiles: async (f: unknown) => (imports.push(f), { id: 1 }), command: async () => ({ id: 1, status: "completed" }), episode: async () => ({}) , episodeFile: async () => ({}) } as never,
    probe: async () => ({ subs: ["en"], audio: ["ja"], durationSec: 1420, sidecars: [], untagged: 0 }),
    localPath: (p) => p,
    sleep: async () => undefined,
  };
  const cand = { guid: "u5", title: "[G] Dual Show - 05 [Dual Audio]", indexerId: 1, indexer: "X", protocol: "usenet" as const, size: 4e8, downloadUrl: "http://x", label: "S01E05", group: "G", why: "t", episodeIds: [3005] };
  const g = await startGrab({ tvdbId: 600001, episodeIds: [3005], candidate: cand, fallbacks: [], origin: "managed", purpose: "dual-upgrade" }, pd);
  await pipelineTick(pd);
  const row = db.prepare("SELECT state, error FROM grabs WHERE id = ?").get(g.id) as { state: string; error: string };
  assert.equal(row.state, "failed");
  assert.match(row.error, /not the dual-audio release/);
  assert.equal(imports.length, 0, "nothing imported");
  assert.ok(db.prepare("SELECT 1 FROM blocklist WHERE release = ?").get(cand.title));
});
