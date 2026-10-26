/** Monitoring scope (Sonarr-style + most recent N seasons) and the staged fill-in queue. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-scope-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { inScope, scopeFor, scopePreview, setScope } = await import("../server/scope.js");
const { addToQueue, fillInTick, fillInView, editQueue } = await import("../server/fillin.js");

const DAY = 86_400_000;
const now = Date.now();
before(() => {
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Anime"], managed: { ...s.managed, dryRun: false }, backlog: { ...s.backlog, enabled: true }, fillIn: { paused: false, waveSize: 2, advancePct: 90, stallDays: 7 } }));
  // Long-runner: 5 seasons x 4 eps; S0 has 2; 6 missing in S4-S5; one future ep in S5.
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, status, synced_at) VALUES (1, 100, 'Long Runner', '/media/Anime/Long Runner', 1, 'continuing', 0)").run();
  let id = 1000;
  for (let s = 0; s <= 5; s++)
    for (let e = 1; e <= (s === 0 ? 2 : 4); e++) {
      const missing = (s === 4 && e > 2) || (s === 5 && e < 4);
      const future = s === 5 && e === 4;
      cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, air_utc) VALUES (?, 1, ?, ?, 1, ?, ?)").run(++id, s, e, missing || future ? 0 : 1, future ? now + 3 * DAY : now - (100 - s * 10 - e) * DAY);
    }
  // Ended shows for the fill-in queue.
  for (const [sid, tvdb, n] of [[2, 201, 10], [3, 202, 4], [4, 203, 6]] as const) {
    cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, status, synced_at) VALUES (?, ?, ?, ?, 0, 'ended', 0)").run(sid, tvdb, `Ended ${tvdb}`, `/media/Anime/Ended ${tvdb}`);
    for (let e = 1; e <= n; e++) cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, air_utc) VALUES (?, ?, 1, ?, 0, 0, ?)").run(sid * 10_000 + e, sid, e, now - 400 * DAY);
  }
});

const eps = () => cache.prepare("SELECT id, season, air_utc, has_file FROM episodes WHERE series_id = 1").all() as { id: number; season: number; air_utc: number; has_file: number }[];

test("scope: most recent N seasons, missing only, specials on/off, future only, none", () => {
  const ids = (sc: Parameters<typeof inScope>[0]) => inScope({ ...sc, since: now }, eps(), now).length;
  assert.equal(ids({ seasons: "recent", recentN: 2, episodes: "all", specials: false }), 8);
  assert.equal(ids({ seasons: "recent", recentN: 2, episodes: "missing", specials: false }), 5);
  assert.equal(ids({ seasons: "all", recentN: 1, episodes: "all", specials: true }), 22);
  assert.equal(ids({ seasons: "latest", recentN: 1, episodes: "future", specials: false }), 1);
  assert.equal(ids({ seasons: "all", recentN: 1, episodes: "none", specials: true }), 0);
  assert.deepEqual(scopePreview(100, { seasons: "recent", recentN: 3, episodes: "all", specials: false }), { seasons: 3, episodes: 12, missing: 5, upcoming: 1 });
});

test("defaults: continuing = future + missing of the latest season; a show's own scope wins", () => {
  assert.equal(scopeFor(100).episodes, "futureAndMissing");
  assert.equal(scopeFor(100).seasons, "latest");
  assert.equal(scopeFor(201).episodes, "missing");
  setScope([100], { seasons: "recent", recentN: 3, episodes: "missing", specials: false });
  assert.equal(scopeFor(100).source, "show");
  setScope([100], null);
  assert.equal(scopeFor(100).source, "default");
});

test("fill-in: waves of N, the next wave when the previous is ≥90% done; reorder and skip", () => {
  addToQueue([201, 202, 203]);
  editQueue(203, "up");
  fillInTick(now);
  const v = fillInView(now);
  assert.deepEqual(v.items.filter((i) => i.state === "active").map((i) => i.tvdbId).sort(), [201, 203]);
  assert.ok(db.prepare("SELECT 1 FROM managed WHERE tvdb_id = 201 AND dry_run = 0").get(), "activated shows are managed and live (global dry-run off)");
  // 201 gets 9 of 10, 203 all 6 → wave done → next wave starts with 202.
  cache.prepare("UPDATE episodes SET has_file = 1 WHERE series_id = 2 AND episode <= 9").run();
  cache.prepare("UPDATE episodes SET has_file = 1 WHERE series_id = 4").run();
  fillInTick(now + DAY);
  assert.deepEqual(fillInView(now).items.filter((i) => i.state === "active").map((i) => i.tvdbId), [202]);
  editQueue(202, "skip");
  assert.equal(fillInView(now).items.find((i) => i.tvdbId === 202)!.state, "skipped");
});

test("fill-in: a show without progress for stallDays makes room for the next wave", () => {
  editQueue(202, "requeue");
  db.prepare("UPDATE fill_queue SET state = 'done' WHERE state = 'active'").run();
  fillInTick(now);
  assert.equal(fillInView(now).items.find((i) => i.tvdbId === 202)!.state, "active");
  fillInTick(now + 8 * DAY);
  assert.equal(fillInView(now).items.find((i) => i.tvdbId === 202)!.state, "done");
});
