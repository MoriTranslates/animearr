/** ⚡ Automatic search: grab the best, confidence gate → needs a look, season pack preferred, guards. Mocks only. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-auto-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { autoSearchEpisodes } = await import("../server/autosearch.js");
type SR = import("../server/search.js").SearchResult;

before(() => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (50, 700500, 'Auto Show', '/media/AnimeArr/Auto Show', 1, 0)").run();
  for (const ep of [1, 2, 3, 4, 5]) cache.prepare("INSERT INTO episodes (id, series_id, season, episode, title, monitored, has_file, air_utc, runtime) VALUES (?, 50, 1, ?, ?, 1, 0, 0, 24)").run(5000 + ep, ep, `Title ${ep}`);
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/AnimeArr"], managed: { ...s.managed, dryRun: false, minConfidence: 80 } }));
});

const r = (title: string, episodeIds: number[], over: Partial<SR> & { flags?: string[] } = {}): SR =>
  ({
    guid: `g-${title}`, title, indexer: "X", indexerId: 1, protocol: "usenet", size: 1e9, seeders: null, publishDate: null, ageHours: 1, episodeIds, label: "", confidence: 95, coversTarget: true, extra: 0,
    rank: { accept: true, score: 100, langProb: 0.97, lang: "en", langSource: "", flags: (over.flags ?? []).map((k) => ({ key: k, label: k, tone: "info" })), why: "97% English, Usenet", reject: null },
    mappingWhy: [], group: null, downloadUrl: "http://x", ...over,
  }) as SR;

function deps(byTargets: (ids: number[]) => SR[]) {
  const grabbed: { title: string; ids: number[] }[] = [];
  return {
    grabbed,
    d: {
      search: (async (_t: number, ids: number[]) => ({ results: byTargets(ids) })) as never,
      grab: (async (req: { candidate: { title: string }; episodeIds: number[] }) => (grabbed.push({ title: req.candidate.title, ids: req.episodeIds }), { id: 1, dryRun: false, message: "Sent" })) as never,
    },
  };
}

test("one episode: grabs the best acceptable release at once", async () => {
  const { d, grabbed } = deps((ids) => [r("[Good] Auto Show - 01", ids)]);
  const out = await autoSearchEpisodes(700500, [5001], d);
  assert.equal(out.results[0].outcome, "grabbed");
  assert.match(out.results[0].label, /S01E01 · Title 1/);
  assert.deepEqual(grabbed.map((g) => g.title), ["[Good] Auto Show - 01"]);
});

test("confidence gate: unsure identity or burned-in → needs a look, nothing grabbed", async () => {
  const { d, grabbed } = deps((ids) => [r("[Meh] Auto Show 2", ids, { confidence: 60 }), r("[Burn] Auto Show - 02", ids, { flags: ["burnIn"] })]);
  const out = await autoSearchEpisodes(700500, [5002], d);
  assert.equal(out.results[0].outcome, "needs-look");
  assert.match(out.results[0].why, /not sure it's the right episode/);
  assert.equal(grabbed.length, 0);
});

test("several episodes: a pack covering them is preferred (one grab); the rest one by one; in-flight skipped", async () => {
  db.prepare("INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, state, dry_run) VALUES (0, 0, 700500, 50, '[5005]', 'x', 'g', 'usenet', 'downloading', 0)").run();
  const { d, grabbed } = deps((ids) => (ids.length > 1 ? [r("[Pack] Auto Show 01-03", [5001, 5002, 5003], { coversTarget: false })] : [r(`[Single] ${ids[0]}`, ids)]));
  const out = await autoSearchEpisodes(700500, [5001, 5002, 5003, 5004, 5005], d);
  assert.deepEqual(grabbed, [{ title: "[Pack] Auto Show 01-03", ids: [5001, 5002, 5003] }, { title: "[Single] 5004", ids: [5004] }]);
  assert.equal(out.results.find((x) => x.episodeIds.includes(5005))!.outcome, "skipped");
});

test("an episode that has a file is never replaced by ⚡ (use Re-grab); a show in its own dry-run isn't grabbed for real", async () => {
  cache.prepare("UPDATE episodes SET has_file = 1 WHERE id = 5004").run();
  const { d, grabbed } = deps((ids) => [r("[Good] Auto Show - 04", ids)]);
  const out = await autoSearchEpisodes(700500, [5004], d);
  assert.equal(out.results[0].outcome, "skipped");
  assert.equal(grabbed.length, 0);
  const seen: { automatic?: boolean }[] = [];
  const d2 = { search: d.search, grab: (async (req: { automatic?: boolean }) => (seen.push(req), { id: 2, dryRun: true, message: "would grab" })) as never };
  await autoSearchEpisodes(700500, [5003], d2);
  assert.equal(seen[0].automatic, true, "⚡ asks startGrab to honour the show's own dry-run");
});

test("smart batch: a worse batch from another group waits while the season's group has singles for the gaps", async () => {
  db.prepare("UPDATE grabs SET state = 'done'").run();
  const { d, grabbed } = deps((ids) => (ids.length > 1 ? [r("[Erai] Auto Show 01-03", [5001, 5002, 5003], { coversTarget: false, group: "Erai" }), r("[Judas] Auto Show - 01", [5001], { coversTarget: false, group: "Judas" })] : [r(`[Judas] ${ids[0]}`, ids, { group: "Judas" })]));
  const asked: string[] = [];
  const out = await autoSearchEpisodes(700500, [5001, 5002, 5003], { ...d, preferSingles: async (_t: number, x: SR) => (asked.push(x.title), "Judas") });
  assert.deepEqual(asked, ["[Erai] Auto Show 01-03"]);
  assert.deepEqual(grabbed.map((g) => g.title), ["[Judas] 5001", "[Judas] 5002", "[Judas] 5003"]);
  assert.equal(out.results.length, 3);
  // No singles of the season's group: the batch is accepted (only the missing episodes; the season stays mixed).
  db.prepare("UPDATE grabs SET state = 'done'").run();
  const two = deps((ids) => (ids.length > 1 ? [r("[Erai] Auto Show 01-03", [5001, 5002, 5003], { coversTarget: false, group: "Erai" })] : []));
  await autoSearchEpisodes(700500, [5001, 5002, 5003], { ...two.d, preferSingles: async () => "Judas" });
  assert.deepEqual(two.grabbed.map((g) => g.title), ["[Erai] Auto Show 01-03"]);
});

test("more than 26 episodes: the first 26 are searched now, the rest queued (fill-in for a show that isn't managed)", async () => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (51, 700501, 'Long Show', '/media/AnimeArr/Long Show', 1, 0)").run();
  const ids = Array.from({ length: 30 }, (_, i) => 6000 + i);
  for (const [i, id] of ids.entries()) cache.prepare("INSERT INTO episodes (id, series_id, season, episode, title, monitored, has_file, air_utc, runtime) VALUES (?, 51, 1, ?, ?, 1, 0, 0, 24)").run(id, i + 1, `E${i + 1}`);
  const searched: number[] = [];
  const { d } = deps((t) => (searched.push(...t), []));
  const out = await autoSearchEpisodes(700501, ids, d);
  assert.deepEqual(out.queued, { n: 4, where: "fillin" });
  assert.ok(searched.every((id) => id < 6026), "only the first 26 are searched now");
  assert.ok(db.prepare("SELECT 1 FROM fill_queue WHERE tvdb_id = 700501").get(), "the show is in the fill-in queue");
});
