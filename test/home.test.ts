/** Home summary: runs on an empty library and with a few rows (no SQL errors, sane shapes). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-home-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { cache, db } = await import("../server/db.js");
const { homeSummary, airingShowCount } = await import("../server/home.js");

test("empty library", () => {
  const h = homeSummary();
  assert.deepEqual([h.airingToday.length, h.downloading.length, h.justArrived.length, h.readyToBinge.length], [0, 0, 0, 0]);
  assert.equal(airingShowCount(), 0);
});

test("airing today, downloading (show and movie), just arrived", () => {
  const now = Date.now();
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (1, 700001, 'Home Show', '/media/AnimeArr/Home Show', 1, 0)").run();
  cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, runtime, air_utc) VALUES (301, 1, 1, 1, 1, 0, 24, ?)").run(new Date(new Date(now).setHours(12, 0, 0, 0)).getTime());
  cache.prepare("INSERT INTO movies (id, title, year, monitored, has_file, synced_at) VALUES (55, 'Home Movie', 2024, 1, 0, 0)").run();
  const g = (state: string, eps: number[], movie: number | null) =>
    db.prepare("INSERT INTO grabs (at, updated_at, tvdb_id, episode_ids, release, guid, protocol, client, client_ref, state, dry_run, movie_id, progress) VALUES (?, ?, ?, ?, 'R', 'g', 'torrent', 'qbittorrent', 'x', ?, 0, ?, 0.5)").run(now, now, movie ? null : 700001, JSON.stringify(eps), state, movie);
  g("downloading", [301], null);
  g("downloading", [], 55);
  g("done", [301], null);
  const h = homeSummary(now);
  assert.equal(h.airingToday.length, 1);
  assert.deepEqual(h.downloading.map((x) => x.title).sort(), ["Home Movie (2024)", "Home Show"]);
  assert.equal(h.justArrived[0].label, "S01E01");
});
