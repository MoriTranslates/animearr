/**
 * Blind review L12: undoing "this subtitle track is <lang>" puts back exactly what was there before (the user's
 * earlier correction), and touches only the rows that action really changed.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-tov-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { setTrackLanguage } = await import("../server/import/detection.js");
const { overridesFor } = await import("../server/import/trackOverrides.js");
const { registerActivityRoutes } = await import("../server/routes/activity.js");

const SEASON = "/media/Anime/Show/Season 01";
const A = `${SEASON}/Show - S01E01.mkv`;
const B = `${SEASON}/Show - S01E02.mkv`;
const C = `${SEASON}/Show - S01E03.mkv`;

const app = Fastify();
registerActivityRoutes(app);

before(() => {
  cache
    .prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (5, 555, 'Show', '/media/Anime/Show', 1, 0)")
    .run();
  for (const [i, p] of [A, B, C].entries()) {
    cache.prepare("INSERT INTO files (id, series_id, season, path) VALUES (?, 5, 1, ?)").run(60 + i, p);
    db.prepare("INSERT INTO media_files (path, root, size, mtime, probed_at, subs, seen_at) VALUES (?, '/media/Anime', 1, 1, 1, ?, 1)").run(
      p,
      JSON.stringify([{ index: 2, lang: null, title: null, codec: "ass", default: true, forced: false, partial: false }]),
    );
  }
});

/** Undoes the newest track-language decision, as the Activity page does. */
async function undoLast() {
  const d = db.prepare("SELECT id FROM decisions WHERE undo LIKE '%overrides%' ORDER BY id DESC LIMIT 1").get() as { id: number };
  const r = await app.inject({ method: "POST", url: `/api/activity/${d.id}/undo`, headers: { "x-animearr": "1" } });
  assert.equal(r.statusCode, 200, r.body);
}
const at = (p: string) => overridesFor(p).map((o) => ({ track: o.trackIndex, lang: o.lang, forced: o.forced }));

test("undo restores the earlier correction instead of deleting it", async () => {
  await setTrackLanguage({ path: A, trackIndex: 2, lang: "en", tvdbId: 555 });
  await setTrackLanguage({ path: A, trackIndex: 2, lang: "ja", forced: true, tvdbId: 555 });
  assert.deepEqual(at(A), [{ track: 2, lang: "ja", forced: true }]);
  await undoLast();
  assert.deepEqual(at(A), [{ track: 2, lang: "en", forced: false }], "back to the earlier correction");
});

test("a season-wide correction's undo leaves files it didn't change as they were", async () => {
  // B already says en (the user's own correction); the season-wide "en" changes only C.
  await setTrackLanguage({ path: B, trackIndex: 2, lang: "en", tvdbId: 555 });
  await setTrackLanguage({ path: C, trackIndex: 2, lang: "en", scope: "season", season: 1, tvdbId: 555 });
  assert.deepEqual(at(C), [{ track: 2, lang: "en", forced: false }]);
  await undoLast();
  assert.deepEqual(at(B), [{ track: 2, lang: "en", forced: false }], "B's own correction stays");
  assert.deepEqual(at(A), [{ track: 2, lang: "en", forced: false }], "A's earlier correction stays");
  assert.deepEqual(at(C), [], "C had none: it has none again");
});
