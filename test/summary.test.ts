/**
 * Plain summaries (bell, Activity, Queue history), a problem settled by a later import, the "Retry import" fix that
 * the message promises, and dismissing bell items one by one. Throwaway database only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-summary-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { db } = await import("../server/db.js");
const { summarize, plainReason, queueSummary } = await import("../server/summary.js");
const { logDecision, listDecisions } = await import("../server/activity.js");
const { fixesFor, liveFixesFor } = await import("../server/fixes.js");
const { bell, markRead } = await import("../server/notify.js");

const noJargon = (s: string | null) => {
  assert.ok(s, "a summary");
  assert.doesNotMatch(s!, /\.nzb|DNS|https?:|\/data\/|sabnzbd\.org|\[|\bfetch failed\b|\ben\b/, s!);
};

test("failures read as one plain sentence; release names, hosts and URLs stay in the detail", () => {
  const dns = summarize({ kind: "fail", title: "Fate/Grand Order: Moonlight/Lostroom (2017)", why: "Couldn't send [Arid] Fate Grand Order - Moonlight Lostroom [BD 1080p x264 FLAC]: Couldn't download the .nzb from AnimeTosho (Usenet): host storage.animetosho.org not found (DNS)" });
  assert.equal(dns, "Couldn't download Fate/Grand Order: Moonlight/Lostroom (2017): a download source is offline.");
  const sab = summarize({ kind: "fail", title: "Grand Blue (2020)", why: "download failed: Aborted, cannot be completed - https://sabnzbd.org/not-complete; blocklisted [Anime Land] Grand Blue  2020 [7C09FA46].mkv-xpost; removed it from SABnzbd" });
  noJargon(sab);
  assert.match(sab!, /parts of it are missing/);
  const signs = summarize({ kind: "verify-fail", title: "Backflip", label: "S01E01", why: "Backflip.S01E01.1080p.WEB.H264-SENPAI failed verification: Backflip.S01E01.mkv: only a forced/signs en track (not full dialogue subtitles). Blocklisted it; looking for the next release." });
  assert.equal(signs, "Turned down a download of Backflip S01E01: it only has English signs, not full English subtitles. Looking for another version.");
  const importer = summarize({ kind: "fail", title: "The Quintessential Quintuplets＊ (2024)", why: 'Downloaded [RUDY] The Quintessential Quintuplets Movie [REPACK] but couldn\'t import it: AnimeArr\'s importer: /data/qbittorrent/completed/[RUDY] x.mkv: EACCES. The download is kept; fix the cause and press "Retry import".' });
  noJargon(importer);
  assert.match(importer!, /^Downloaded The Quintessential Quintuplets＊ \(2024\), but couldn't import it: .*\. The download is kept\.$/);
});

test("the cut-off 'No more candidates to try after' becomes a whole sentence", () => {
  const s = summarize({ kind: "skip", title: "Date A Bullet", why: "No more candidates to try after: fetch failed (3 attempts used)" });
  assert.equal(s, "No other versions of Date A Bullet left to try (the last one failed: a download source didn't answer). AnimeArr searches again later.");
  assert.equal(summarize({ kind: "skip", why: "No more candidates to try after: something odd" }), "No other versions of it left to try. AnimeArr searches again later.");
});

test("everyday steps, plurals and language names", () => {
  assert.equal(summarize({ kind: "grab", title: "PSYREN", label: "S01E04", why: "Sent [Erai-raws] Psyren - 04 [1080p] to qBittorrent (category animearr) for PSYREN S01E04: 99% English (x), torrent, 121 seeders" }), "Started downloading PSYREN S01E04.");
  assert.equal(summarize({ kind: "import", title: "Nia Liston", label: "S01E04", why: "Imported ✓ as S01E04: has full en subtitles" }), "Imported Nia Liston S01E04 with English subtitles.");
  assert.equal(summarize({ kind: "import", why: "Imported ✓ KanColle Movie (2016) by hand from KanColle.Movie.2016.1080p" }), "Imported KanColle Movie (2016).");
  assert.equal(summarize({ kind: "info", why: "Download clean-up: 1 step(s) — leftover X (0.0 GB)" }), "Cleaned up 1 leftover download.");
  assert.equal(summarize({ kind: "info", why: "Download clean-up: 8 step(s) — leftover X" }), "Cleaned up 8 leftover downloads.");
  assert.equal(summarize({ kind: "fact", why: "You marked subtitle track 2 as signs-only en in 13 files (season 1); the tag was also written into 13 files" }), "You marked subtitle track 2 as English signs only in 13 files.");
  assert.equal(summarize({ kind: "sync", why: "Synced from Sonarr/Radarr: 641 anime series (3 refreshed), 176 anime movies, 22 need an AniDB match" }), "Synced the library: 641 shows and 176 movies; 22 need matching by hand.");
  assert.equal(summarize({ kind: "would-grab", title: "Bleach", label: "S17E50", why: "Dry-run: would send X" }), "Practice mode: would have downloaded Bleach S17E50.");
  assert.equal(plainReason("something nobody has seen"), null);
});

test("queue history rows get a reason line, never the raw error", () => {
  assert.equal(queueSummary("failed", "Couldn't download the .nzb from AnimeTosho (Usenet): host storage.animetosho.org not found (DNS)", false), "Failed: a download source is offline.");
  assert.equal(queueSummary("failed", "X.mp4: no subtitles at all", true), "Turned down: it has no subtitles.");
  assert.equal(queueSummary("done", null, false), null);
  assert.equal(queueSummary("failed", "removed by you", false), "You removed it.");
});

test("a rejected release is resolved once a later import of the same episode succeeds (no fix buttons left)", () => {
  const ins = (tvdb: number, eps: number[], grabId: number, release: string) => db.prepare("INSERT INTO grabs (at, tvdb_id, episode_ids, release, guid, protocol, state, why, dry_run, updated_at, candidates) VALUES (?, ?, ?, ?, ?, 'torrent', 'failed', 'x', 0, ?, '[]')").run(Date.now(), tvdb, JSON.stringify(eps), release, `g${grabId}`, Date.now());
  ins(500, [51], 1, "Bad.S01E01");
  const bad = logDecision("verify-fail", { tvdbId: 500, title: "Show", episodeIds: [51], release: "Bad.S01E01", why: "Bad.S01E01 failed verification: no full en subtitles. Blocklisted it.", detail: { grabId: 1 }, undo: { action: "unblock", args: { release: "Bad.S01E01" } } });
  const other = logDecision("verify-fail", { tvdbId: 500, title: "Show", episodeIds: [52], release: "Bad.S01E02", why: "Bad.S01E02 failed verification: no full en subtitles. Blocklisted it.", detail: { grabId: 1 } });
  let rows = listDecisions({ tvdbId: 500 });
  assert.equal(rows.find((r) => r.id === bad)!.resolved, false);
  assert.ok(rows.find((r) => r.id === bad)!.fixes.length > 0);
  logDecision("import", { tvdbId: 500, title: "Show", episodeIds: [51], why: "Imported ✓ as S01E01: has full en subtitles", detail: { grabId: 2, final: true } });
  rows = listDecisions({ tvdbId: 500 });
  const r = rows.find((x) => x.id === bad)!;
  assert.equal(r.resolved, true);
  assert.deepEqual(r.fixes, []);
  assert.equal(rows.find((x) => x.id === other)!.resolved, false, "another episode is still open");
  // Movies: settled by a later movie import.
  const mv = logDecision("fail", { title: "Movie (2000)", why: "Couldn't send X: fetch failed", detail: { movieId: 77 } });
  logDecision("import", { title: "Movie (2000)", why: "Imported ✓ Movie (2000) (AnimeArr's importer)", detail: { movieId: 77, final: true } });
  assert.equal(listDecisions({ limit: 50 }).find((x) => x.id === mv)!.resolved, true);
});

test('a message that says press "Retry import" carries that button, only while the grab waits for it', () => {
  const why = 'Downloaded X but couldn\'t import it: AnimeArr\'s importer: boom. The download is kept; fix the cause and press "Retry import".';
  assert.ok(fixesFor(why, { grabId: 9, movieId: 3 }).some((f) => f.action === "retryImport" && f.params?.grabId === 9));
  assert.ok(!fixesFor(why, {}).some((f) => f.action === "retryImport"), "no grab, no retry");
  const g = db.prepare("INSERT INTO grabs (at, tvdb_id, episode_ids, release, guid, protocol, state, why, dry_run, updated_at, candidates, movie_id) VALUES (?, 0, '[]', 'X', 'gx', 'torrent', 'needs-attention', 'x', 0, ?, '[]', 3)").run(Date.now(), Date.now());
  const id = Number(g.lastInsertRowid);
  assert.ok(liveFixesFor(why, { grabId: id, movieId: 3 }).some((f) => f.action === "retryImport"));
  db.prepare("UPDATE grabs SET state = 'done' WHERE id = ?").run(id);
  assert.ok(!liveFixesFor(why, { grabId: id, movieId: 3 }).some((f) => f.action === "retryImport"));
  // The vocabulary the UI uses.
  assert.ok(fixesFor("X failed verification: no full English subtitles", { kind: "verify-fail", tvdbId: 1 }).some((f) => f.label === "Download again"));
});

test("bell: items carry a plain summary; opening doesn't read them, dismissing one does", () => {
  logDecision("fail", { title: "Bell Show", why: "Couldn't send [G] Bell Show - 01: fetch failed", detail: { movieId: 999 } });
  const b = bell();
  const item = b.items.find((i) => i.title === "Bell Show")!;
  assert.equal(item.summary, "Couldn't download Bell Show: a download source didn't answer.");
  assert.match(item.body, /\[G\]/, "the raw message stays as the detail");
  assert.equal(item.read, false);
  const before = bell().unread;
  markRead(0, [item.id]);
  assert.equal(bell().items.find((i) => i.id === item.id)!.read, true);
  assert.equal(bell().unread, before - 1);
});
