/**
 * What a download that needs you does to the episode list, and files in the wrong language: only episodes left
 * without a usable file show "attention" (with the reason and the fixes); a managed show's file in the wrong language
 * is wanted again unless it is kept as is or marked as having burned-in subtitles.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-attn-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { calendar, episodeRows, planWrongLanguage, seriesHeader, wrongLanguageEpisodes } = await import("../server/episodes.js");
const { markBurnedIn } = await import("../server/import/fileMarks.js");
const { attentionSummary, queueSummary } = await import("../server/system/summary.js");
const { setLock } = await import("../server/search/qualityLocks.js");

const TVDB = 610001;
const H = 3_600_000;
const DIR = "/media/AnimeArr/Clover/Season 02";
const file = (id: number, name: string, subs: string[]) => {
  const p = `${DIR}/${name}`;
  cache
    .prepare(
      "INSERT INTO files (id, series_id, season, path, size, quality, audio_langs, sub_langs) VALUES (?, 7, 2, ?, 1000, 'WEBDL-1080p', 'ja', ?)",
    )
    .run(id, p, subs.join("/"));
  db.prepare(
    "INSERT INTO media_files (path, root, size, mtime, probed_at, audio, subs, seen_at) VALUES (?, '/media/AnimeArr', 1000, 1, 1, ?, ?, 1)",
  ).run(p, JSON.stringify([{ lang: "ja" }]), JSON.stringify(subs.map((lang) => ({ lang }))));
  return p;
};
let grabId = 0;

before(() => {
  const now = Date.now();
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, monitored, status, synced_at) VALUES (7, ?, 'Clover', '/media/AnimeArr/Clover', 1, 'continuing', 0)",
    )
    .run(TVDB);
  const ep = cache.prepare(
    "INSERT INTO episodes (id, series_id, season, episode, title, air_utc, monitored, has_file, file_id, runtime) VALUES (?, 7, 2, ?, ?, ?, 1, ?, ?, 24)",
  );
  ep.run(801, 1, "Good file", now - 96 * H, 1, 9801);
  ep.run(802, 2, "Not out yet", now + 96 * H, 0, null);
  ep.run(803, 3, "No file", now - 48 * H, 0, null);
  ep.run(804, 4, "French only", now - 120 * H, 1, 9804);
  ep.run(805, 5, "French, kept", now - 144 * H, 1, 9805);
  ep.run(806, 6, "Hardsubbed", now - 168 * H, 1, 9806);
  file(9801, "Clover - S02E01.mkv", ["en"]);
  file(9804, "Clover - S02E04.mkv", ["fr", "de"]);
  file(9805, "Clover - S02E05 [Keep].mkv", ["fr"]);
  file(9806, "[geckyzz] Clover - S02E06.mkv", []);
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (?, 7, 'Clover', 0, ?)").run(TVDB, now);
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/AnimeArr"],
    managed: { ...s.managed, dryRun: false },
    media: { ...s.media, recycleBin: "/media/Recycle/" },
  }));
  // A whole-season replace that stopped: it lists every episode of the season.
  grabId = Number(
    db
      .prepare(
        "INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, protocol, client, client_ref, state, dry_run, error, purpose) VALUES (?, ?, ?, 7, '[801, 802, 803]', 'R', 'g', 'torrent', 'qbittorrent', 'h', 'needs-attention', 0, ?, 'replace')",
      )
      .run(
        now,
        now,
        TVDB,
        "Season 2 replace stopped: the download was only episode 3, not the whole season. Nothing in your library changed.",
      ).lastInsertRowid,
  );
});

test("a grab that needs you marks only the episode left without a file; good files stay 'have', unaired stays 'unaired'", () => {
  const by = new Map(episodeRows(7).map((r) => [r.episode, r]));
  assert.equal(by.get(1)!.status, "have");
  assert.equal(by.get(2)!.status, "unaired");
  assert.equal(by.get(3)!.status, "attention");
  // Each says why, in plain words, with what can be done; the good file carries the note too.
  assert.equal(by.get(3)!.attention!.summary, "The download was only episode 3, not the whole season; nothing in your library changed.");
  assert.ok(
    by.get(3)!.attention!.fixes.some((f) => f.action === "tryNext"),
    JSON.stringify(by.get(3)!.attention!.fixes),
  );
  assert.equal(by.get(1)!.attention!.grabId, grabId);
  // The calendar follows the same rule.
  const cal = new Map(calendar(Date.now() - 200 * H, Date.now() + 200 * H, false).map((c) => [c.episodeId, c.status]));
  assert.equal(cal.get(801), "have");
  assert.equal(cal.get(802), "unaired");
  assert.equal(cal.get(803), "attention");
});

test("plain words for a download that needs you (episode rows and the Queue)", () => {
  assert.equal(
    queueSummary(
      "needs-attention",
      "Season 2 replace stopped: the download was only episode 3, not the whole season. Nothing in your library changed.",
      false,
    ),
    "Needs you: the download was only episode 3, not the whole season; nothing in your library changed.",
  );
  assert.equal(
    attentionSummary(
      "Season 1 replace: 2 episodes kept their old file (no en subtitles). The others were replaced. Fix the cause, then press Retry import",
    ),
    "2 episodes kept the old file, the others were replaced.",
  );
  assert.equal(attentionSummary("the download disappeared from the download client"), "The download disappeared from the download client.");
  assert.match(attentionSummary(null), /Open the Queue/);
});

test("a managed show's file in the wrong language is wanted again, unless kept as is; it counts as missing", () => {
  const by = new Map(episodeRows(7).map((r) => [r.episode, r]));
  assert.equal(by.get(4)!.status, "wrong-lang");
  assert.equal(by.get(4)!.file!.lang!.state, "no");
  assert.equal(by.get(5)!.status, "have", "[Keep] in the name: never replaced automatically");
  assert.match(by.get(5)!.keptWhy ?? "", /\[Keep\]/);
  assert.equal(by.get(6)!.status, "wrong-lang", "no subtitle tracks at all");
  const h = seriesHeader(TVDB)!;
  // E03 is the one without a file (its grab needs you), E04 and E06 are in the wrong language.
  assert.equal(h.counts.wrongLang, 2);
  assert.equal(h.counts.missing, 2);
  assert.deepEqual([...wrongLanguageEpisodes(TVDB).keys()].sort(), [804, 806]);
  // A locked season keeps its files too.
  setLock(TVDB, 2, true);
  assert.equal(wrongLanguageEpisodes(TVDB).size, 0);
  setLock(TVDB, 2, false);
});

test("a file marked as having burned-in subtitles counts as having the language", () => {
  markBurnedIn(`${DIR}/[geckyzz] Clover - S02E06.mkv`, "en");
  const e6 = episodeRows(7).find((r) => r.episode === 6)!;
  assert.equal(e6.status, "have");
  assert.equal(e6.file!.burnedIn, "en");
  assert.match(e6.file!.lang!.why, /you marked this file as having burned-in en subtitles/);
  assert.throws(() => markBurnedIn("/media/AnimeArr/Clover/not-there.mkv", "en"), /isn't in the library/);
});

test("wrong-language files join the search as replacements, once per retry period, and leave it when fixed", () => {
  const now = Date.now();
  assert.equal(planWrongLanguage(now), 1);
  const st = db.prepare("SELECT state, last_why FROM search_state WHERE episode_id = 804").get() as { state: string; last_why: string };
  assert.equal(st.state, "replace");
  assert.match(st.last_why, /wrong language \(subtitles fr\/de only\)/);
  assert.equal(planWrongLanguage(now), 0, "already queued");
  // A failed replacement closed the row just now: not searched again before the retry days are up.
  db.prepare("UPDATE search_state SET state = 'done', last_at = ? WHERE episode_id = 804").run(now);
  assert.equal(planWrongLanguage(now + H), 0);
  assert.equal(planWrongLanguage(now + 400 * 24 * H), 1);
  // Kept meanwhile: the replacement search stops.
  markBurnedIn(`${DIR}/Clover - S02E04.mkv`, "en");
  planWrongLanguage(now + 400 * 24 * H);
  assert.equal((db.prepare("SELECT state FROM search_state WHERE episode_id = 804").get() as { state: string }).state, "done");
});
