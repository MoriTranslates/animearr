/** RSS-style new-release watch: a new release for a wanted episode or movie brings its search forward; mocked Prowlarr. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { rssTick } = await import("../server/managed.js");

const FAR = Date.now() + 30 * 86_400_000;
const rel = (title: string, guid: string) => ({ guid, title, indexerId: 1, indexer: "X", protocol: "usenet" as const, size: 5e8, downloadUrl: "http://x", publishDate: new Date().toISOString() }) as never;

before(() => {
  patchSettings((s) => ({ ...s, prowlarr: { ...s.prowlarr, url: "http://prowlarr", apiKey: "k" } }));
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, series_type, synced_at) VALUES (5, 424536, 'Frieren', '/media/Anime/Frieren', 1, 'anime', 0)").run();
  cache.prepare("INSERT INTO episodes (id, series_id, season, episode, absolute, monitored, has_file, air_utc) VALUES (501, 5, 1, 5, 5, 1, 0, ?)").run(Date.now() - 86_400_000);
  db.prepare("INSERT INTO search_state (episode_id, tvdb_id, next_at, state, attempts) VALUES (501, 424536, ?, 'gave-up', 12)").run(Date.now() - 10 * 3_600_000); // gave up long ago
  cache.prepare("INSERT INTO movies (id, tmdb_id, title, year, path, monitored, has_file, alt_titles, is_anime, synced_at) VALUES (9, 1, 'Suzume', 2022, '/media/Movies/Anime/Suzume (2022)', 1, 0, '[]', 1, 0)").run();
  db.prepare("INSERT INTO movie_search (movie_id, state, next_at) VALUES (9, 'waiting', ?)").run(FAR);
});

test("a new release for a wanted episode or movie brings its search forward (once per release)", async () => {
  const search = async () => [rel("[SubsPlease] Frieren - 05 (1080p) [ABCD1234].mkv", "g1"), rel("Suzume.2022.1080p.BluRay.x264-GRP", "g2"), rel("Other.Show.S01E01.1080p", "g3")];
  const r = await rssTick(Date.now(), { search } as never);
  assert.equal(r.checked, 3);
  const st = db.prepare("SELECT next_at, state FROM search_state WHERE episode_id = 501").get() as { next_at: number; state: string };
  assert.ok(st.next_at >= Date.now() - 60_000, "searched again now");
  assert.equal(st.state, "retry", "a given-up episode gets another search");
  assert.ok((db.prepare("SELECT next_at FROM movie_search WHERE movie_id = 9").get() as { next_at: number }).next_at < FAR);
  const again = await rssTick(Date.now(), { search } as never);
  assert.equal(again.checked, 0, "already seen");
});
