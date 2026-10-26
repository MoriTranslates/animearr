/**
 * Fix buttons: every problem message maps to its fixes (server/fixes.ts), and the two new grab actions
 * ("Keep anyway", "Try next release") behave safely. All with mocks.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-fixes-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { fixesFor, liveFixesFor, linkFor } = await import("../server/fixes.js");
const { keepGrab, nextForGrab } = await import("../server/pipeline.js");
const { queueView } = await import("../server/queue.js");
const { listDecisions } = await import("../server/activity.js");

const actions = (why: string, ctx = {}) => fixesFor(why, ctx).map((f) => f.action);

test("manual import message → Import manually… with the file path and the matched episodes", () => {
  const f = fixesFor("/data/completed/other/Show - 01.mkv isn't in AnimeArr's own download folders; only a manual import can take it", { tvdbId: 7, episodeIds: [1, 2], grabId: 3 });
  assert.equal(f[0].action, "importManual");
  assert.deepEqual(f[0].params, { tvdbId: 7, episodeIds: [1, 2], path: "/data/completed/other/Show - 01.mkv", grabId: 3 });
});

test("episode mapping, language check, rules, importer, client and indexer problems each get their fix", () => {
  assert.ok(actions("couldn't map the episode for Show 13.mkv", { tvdbId: 1 }).includes("pickEpisode"));
  assert.deepEqual(actions("X failed verification: no full English subtitles", { kind: "verify-fail", tvdbId: 1, grabId: 9 }).slice(0, 2), ["regrab", "keepAnyway"]);
  // Without a grab there is nothing to keep.
  assert.ok(!actions("X failed verification: no full English subtitles", { kind: "verify-fail", tvdbId: 1 }).includes("keepAnyway"));
  assert.deepEqual(actions('Grabs are paused by the download-folder rule "Big folder"'), ["openRule", "resumeRule"]);
  assert.equal(fixesFor('Grabs are paused by the download-folder rule "Big folder"')[1].params?.name, "Big folder");
  // A free-space pause isn't switched off from a button (only opened).
  assert.deepEqual(actions('Grabs are paused by the download-folder rule "Free space" (free space below 50 GB)'), ["openRule"]);
  assert.ok(actions("real imports by AnimeArr's importer are switched off").includes("resumeImports"));
  assert.deepEqual(actions("SABnzbd: download failed (CRC error)", { grabId: 4, tvdbId: 1, episodeIds: [5] }), ["tryNext", "interactiveSearch"]);
  assert.deepEqual(fixesFor("qBittorrent is unreachable (ECONNREFUSED)").map((f) => [f.action, f.params?.service]), [["testConnection", "qbittorrent"]]);
  assert.ok(actions("Prowlarr search failed: HTTP 500").includes("indexerHealth"));
  // Plain information has no buttons.
  assert.deepEqual(actions("Imported Show S01E01"), []);
});

test("deep links point at the item", () => {
  assert.equal(linkFor({ movieId: 5 }, "https://aa.example/"), "https://aa.example/movie/5");
  assert.equal(linkFor({ tvdbId: 6 }, "https://aa.example"), "https://aa.example/show/6");
  assert.equal(linkFor({ grabId: 1 }, "https://aa.example"), "https://aa.example/queue");
  assert.equal(linkFor({ tvdbId: 6 }, ""), null);
});

const TVDB = 600001;
const grab = (state: string, release: string, eps: number[], error: string | null = null, ref: string | null = "nzo_1") =>
  Number(
    db
      .prepare("INSERT INTO grabs (at, updated_at, tvdb_id, episode_ids, release, guid, protocol, client, client_ref, state, dry_run, error) VALUES (?, ?, ?, ?, ?, ?, 'usenet', 'sabnzbd', ?, ?, 0, ?)")
      .run(Date.now(), Date.now(), TVDB, JSON.stringify(eps), release, `g-${release}`, ref, state, error).lastInsertRowid,
  );
before(() => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at) VALUES (1, ?, 'Fix Show', '/media/AnimeArr/Fix Show', 0, 0)").run(TVDB);
  for (const id of [201, 202, 203]) cache.prepare("INSERT INTO episodes (id, series_id, season, episode, monitored, has_file, runtime, air_utc) VALUES (?, 1, 1, ?, 0, 0, 24, 0)").run(id, id - 200);
});

test("Keep anyway: unblocks the release and resumes the grab with keep set; refuses while another grab runs for it", () => {
  const id = grab("failed", "Rel.A", [201], "no full English subtitles");
  db.prepare("INSERT INTO blocklist (guid, release, tvdb_id, reason, at) VALUES ('g', 'Rel.A', ?, 'x', 0)").run(TVDB);
  keepGrab(id);
  const row = db.prepare("SELECT state, keep, error FROM grabs WHERE id = ?").get(id) as { state: string; keep: number; error: string | null };
  assert.deepEqual({ ...row }, { state: "downloading", keep: 1, error: null });
  assert.equal((db.prepare("SELECT COUNT(*) n FROM blocklist WHERE release = 'Rel.A'").get() as { n: number }).n, 0);

  const other = grab("failed", "Rel.B", [202], "no full English subtitles");
  grab("downloading", "Rel.C", [202]);
  assert.throws(() => keepGrab(other), /already running/);
  // Never sent to a client → nothing to keep.
  assert.throws(() => keepGrab(grab("failed", "Rel.D", [203], "x", null)), /Only a finished download/);
  // A running grab isn't a problem.
  assert.throws(() => keepGrab(grab("downloading", "Rel.E", [203])), /Only a finished download/);
});

test("Try next release: needs-attention grab → failed and blocklisted; no candidates → logged, no crash", async () => {
  const id = grab("needs-attention", "Rel.F", [203], "SABnzbd: download failed");
  const r = await nextForGrab(id);
  assert.equal(r, null);
  assert.equal((db.prepare("SELECT state FROM grabs WHERE id = ?").get(id) as { state: string }).state, "failed");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM blocklist WHERE release = 'Rel.F'").get() as { n: number }).n, 1);
  await assert.rejects(nextForGrab(grab("downloading", "Rel.G", [203])), /Only a failed download/);
});

test("queue items and activity decisions carry their fixes", async () => {
  const id = grab("needs-attention", "Rel.H", [201], "SABnzbd: download failed (par2)");
  const { items } = await queueView();
  const it = items.find((x) => x.id === id);
  assert.ok(it, "grab is in the queue");
  assert.deepEqual(it!.fixes.map((f) => f.action), ["tryNext", "interactiveSearch"]);
  // "No more candidates" (from Try next release above) is a problem → it has buttons.
  const dec = (listDecisions({ tvdbId: TVDB }) as unknown as { kind: string; why: string; fixes: { action: string }[] }[]).find((d) => /No more candidates/.test(d.why));
  assert.ok(dec, "decision logged");
  assert.ok(dec!.fixes.some((f) => f.action === "interactiveSearch"));
});

test("a newer grab for the same episodes retires Keep anyway / Try next release (no overwrite, no double next)", async () => {
  const old = grab("failed", "Rel.I", [202], "Show 02.mkv: no full English subtitles");
  const why = "Rel.I failed verification: Show 02.mkv: no full English subtitles. Blocklisted it.";
  assert.ok(liveFixesFor(why, { kind: "verify-fail", grabId: old, tvdbId: TVDB, episodeIds: [202] }).some((f) => f.action === "keepAnyway"));
  db.prepare("UPDATE grabs SET state = 'failed' WHERE release = 'Rel.C'").run(); // the earlier clash is gone
  const newer = grab("done", "Rel.J", [202]);
  assert.deepEqual(liveFixesFor(why, { kind: "verify-fail", grabId: old, tvdbId: TVDB, episodeIds: [202] }).map((f) => f.action), ["regrab", "interactiveSearch"]);
  assert.throws(() => keepGrab(old), new RegExp(`grab ${newer}`));
  await assert.rejects(nextForGrab(old), new RegExp(`grab ${newer}`));
  // Checked after the import: nothing to keep.
  assert.ok(!fixesFor("X failed verification: no English subs (already imported; it will be replaced if a better release is found)", { kind: "verify-fail", grabId: 1 }).some((f) => f.action === "keepAnyway"));
  // The automatic next already ran out: no Try next.
  assert.ok(!actions("No more candidates to try after: SABnzbd: download failed", { grabId: 1, tvdbId: 1 }).includes("tryNext"));
  assert.ok(!actions("complex numbering is unreachable").includes("testConnection"));
});
