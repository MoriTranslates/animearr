/** Missing-episode (backlog) search: planning, hourly budget, give-up re-entry, dry-run release. No Prowlarr. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-backlog-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { planBacklog, backlogPass, backlogSummary, releaseDryRunDecisions } = await import("../server/managed.js");

const DAY = 86_400_000;
const now = Date.now();
const state = (id: number) => db.prepare("SELECT state, kind, attempts, next_at, last_at FROM search_state WHERE episode_id = ?").get(id) as { state: string; kind: string; attempts: number; next_at: number; last_at: number | null } | undefined;

before(() => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, original_language, synced_at) VALUES (20, 900001, 'Old Show', '/media/AnimeArr/Old Show', 1, 'Japanese', 0)").run();
  // [id, episode, monitored, has_file, aired days ago]
  for (const [id, ep, mon, file, ago] of [[2001, 1, 1, 0, 400], [2002, 2, 1, 0, 393], [2003, 3, 1, 0, 386], [2004, 4, 0, 0, 379], [2005, 5, 1, 1, 372], [2006, 6, 1, 0, 3]])
    cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, air_utc, runtime) VALUES (?, 20, 1, ?, ?, ?, ?, 24)").run(id, ep, mon, file, now - ago * DAY);
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (900001, 20, 'Old Show', 1, 0)").run();
});

test("off by default: nothing is planned", () => {
  assert.equal(planBacklog(now), 0);
  assert.equal(state(2001), undefined);
});

test("plans old missing episodes in scope (the default scope still honours Sonarr's unmonitored episodes); hourly budget, newest first", async () => {
  patchSettings((s) => ({ ...s, backlog: { enabled: true, perHour: 2, retryDays: 7 } }));
  assert.equal(planBacklog(now), 3);
  assert.equal(state(2004), undefined, "unmonitored in Sonarr, no own scope yet");
  assert.equal(state(2005), undefined, "has a file");
  assert.equal(state(2006), undefined, "recent: the normal schedule's job");
  assert.equal(backlogSummary(now).missing, 3);
  // No Prowlarr in tests: each search fails, which still uses the budget and pushes the episode back.
  assert.equal(await backlogPass(now), 2);
  assert.equal(state(2003)!.last_at, now, "newest first");
  assert.equal(state(2002)!.last_at, now);
  assert.equal(state(2001)!.last_at, null);
  assert.ok(state(2003)!.next_at > now);
  assert.equal(await backlogPass(now + 60_000), 0, "hourly budget used up");
  assert.equal(await backlogPass(now + 2 * 3_600_000), 2);
});

test("an episode that got a file in the meantime is closed without a search", async () => {
  db.prepare("UPDATE search_state SET next_at = 0").run();
  cache.prepare("UPDATE episodes SET has_file = 1 WHERE id = 2001").run();
  planBacklog(now + 5 * 3_600_000);
  assert.equal(state(2001)!.state, "done");
});

test("give-ups from the normal schedule join the backlog after retryDays; dry-run release keeps them rate-limited", () => {
  db.prepare("INSERT INTO search_state (episode_id, tvdb_id, air_utc, next_at, state, last_at) VALUES (2006, 900001, ?, 0, 'gave-up', ?)").run(now - 3 * DAY, now - 8 * DAY);
  planBacklog(now);
  assert.equal(state(2006)!.state, "backlog");
  assert.equal(state(2006)!.kind, "backlog");
  db.prepare("UPDATE search_state SET state = 'would-grab' WHERE episode_id IN (2002, 2006)").run();
  releaseDryRunDecisions();
  assert.equal(state(2002)!.state, "backlog");
  assert.equal(state(2006)!.state, "backlog");
});

test("the hourly budget counts searches, not rows: an RSS bring-forward can't exceed it", async () => {
  const t0 = now + 30 * DAY;
  patchSettings((s) => ({ ...s, backlog: { enabled: true, perHour: 3, retryDays: 7 } }));
  db.prepare("UPDATE search_state SET next_at = 0, state = 'backlog' WHERE episode_id IN (2002, 2003)").run();
  assert.equal(await backlogPass(t0, { plan: false }), 2);
  db.prepare("UPDATE search_state SET next_at = 0, last_why = 'New release seen: x' WHERE episode_id = 2002").run();
  assert.equal(await backlogPass(t0 + 60_000, { plan: false }), 1, "3rd search");
  db.prepare("UPDATE search_state SET next_at = 0 WHERE episode_id IN (2002, 2003)").run();
  assert.equal(await backlogPass(t0 + 120_000, { plan: false }), 0, "budget used up even though rows repeat");
});

test("an episode AnimeArr just imported isn't reopened while the cache lags behind", () => {
  const t0 = now + 60 * DAY;
  cache.prepare("UPDATE episodes SET has_file = 0 WHERE id = 2001").run();
  const g = db.prepare("INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, state, dry_run) VALUES (?, ?, 900001, 20, '[2001]', 'r', 'g', 'usenet', 'done', 0)").run(t0, t0);
  db.prepare("UPDATE search_state SET state = 'done', last_at = 0, grab_id = ? WHERE episode_id = 2001").run(Number(g.lastInsertRowid));
  planBacklog(t0);
  assert.equal(state(2001)!.state, "done");
  planBacklog(t0 + 30 * DAY);
  assert.equal(state(2001)!.state, "backlog", "missing again long after the import");
});
