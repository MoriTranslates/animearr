/**
 * Unmonitored = quiet (Sonarr's rule; playtest: Bleach was managed with scope "none" and unmonitored in Sonarr, yet the
 * show page asked to "Find missing (370)", every empty season was a gap, and old seasons looked broken). What's wanted
 * is one definition (scope.ts wantedEpisodeIds); nothing unwanted counts as missing, raises a language or
 * wrong-language warning, shows up in Gaps/Wanted, or pushes a notification.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-quiet-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { setScope, wantedEpisodeIds, quietShow } = await import("../server/library/scope.js");
const { calendar, episodeRows, seriesHeader, wrongLanguageEpisodes } = await import("../server/library/episodes.js");
const { gaps, missingLanguage } = await import("../server/library/audit.js");
const { bell } = await import("../server/notify/notify.js");
const { logDecision } = await import("../server/system/activity.js");

const H = 3_600_000;
const DAY = 24 * H;
const now = Date.now();
// Managed, scope "none", unmonitored in Sonarr except its latest season's episodes (a real library's Bleach, 2026-11-02).
const BLEACH = 720001;
// Not managed; Sonarr monitors the show, season 1 unmonitored, season 2 monitored.
const PLAIN = 720002;
// Not managed; the show is unmonitored in Sonarr (its episode flags still say monitored).
const OFF = 720003;
// Managed, scope "latest season, missing": season 1 is out of scope, season 2 in.
const SCOPED = 720004;
// Dropped.
const DROPPED = 720005;

const ep = (id: number, sid: number, season: number, n: number, air: number, monitored: 0 | 1, fileId: number | null) =>
  cache
    .prepare(
      "INSERT INTO episodes (id, series_id, season, episode, title, air_utc, monitored, has_file, file_id, runtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 24)",
    )
    .run(id, sid, season, n, `Ep ${n}`, air, monitored, fileId ? 1 : 0, fileId);
/** A file AnimeArr scanned itself: subtitle languages as given (ja audio). */
const file = (id: number, sid: number, season: number, p: string, subs: string[]) => {
  cache
    .prepare(
      "INSERT INTO files (id, series_id, season, path, size, quality, audio_langs, sub_langs) VALUES (?, ?, ?, ?, 1000, 'WEBDL-1080p', 'ja', ?)",
    )
    .run(id, sid, season, p, subs.join("/"));
  db.prepare(
    "INSERT INTO media_files (path, root, size, mtime, probed_at, audio, subs, seen_at) VALUES (?, '/media/Anime', 1000, 1, 1, ?, ?, 1)",
  ).run(p, JSON.stringify([{ lang: "ja" }]), JSON.stringify(subs.map((lang) => ({ lang }))));
};
const series = (id: number, tvdb: number, title: string, monitored: 0 | 1) =>
  cache
    .prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, status, synced_at) VALUES (?, ?, ?, ?, ?, 'continuing', 0)")
    .run(id, tvdb, title, `/media/Anime/${title}`, monitored);

before(() => {
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/Anime"], managed: { ...s.managed, dryRun: false } }));
  // Bleach: S1 aired and empty (unmonitored), S2 has files with no English subs (monitored in Sonarr).
  series(71, BLEACH, "Bleachy", 0);
  ep(7101, 71, 1, 1, now - 900 * DAY, 0, null);
  ep(7102, 71, 1, 2, now - 899 * DAY, 0, null);
  ep(7201, 71, 2, 1, now - 3 * DAY, 1, 97201);
  ep(7202, 71, 2, 2, now - 2 * DAY, 1, null);
  file(97201, 71, 2, "/media/Anime/Bleachy/Season 02/Bleachy - S02E01.mkv", ["fr"]);
  db.prepare(
    "INSERT INTO managed (tvdb_id, series_id, title, dry_run, since, unmonitored_in_sonarr) VALUES (?, 71, 'Bleachy', 0, 0, 1)",
  ).run(BLEACH);
  setScope([BLEACH], { seasons: "latest", recentN: 1, episodes: "none", specials: false, creditless: false });

  series(72, PLAIN, "Plain", 1);
  ep(7301, 72, 1, 1, now - 400 * DAY, 0, null);
  ep(7302, 72, 1, 2, now - 399 * DAY, 0, 97302);
  ep(7401, 72, 2, 1, now - 5 * DAY, 1, null);
  ep(7402, 72, 2, 2, now - 4 * DAY, 1, 97402);
  file(97302, 72, 1, "/media/Anime/Plain/Season 01/Plain - S01E02.mkv", ["fr"]);
  file(97402, 72, 2, "/media/Anime/Plain/Season 02/Plain - S02E02.mkv", ["fr"]);

  series(73, OFF, "Off", 0);
  ep(7501, 73, 1, 1, now - 6 * DAY, 1, null);

  series(74, SCOPED, "Scoped", 1);
  ep(7601, 74, 1, 1, now - 300 * DAY, 1, 97601);
  ep(7602, 74, 1, 2, now - 299 * DAY, 1, null);
  ep(7701, 74, 2, 1, now - 9 * DAY, 1, 97701);
  ep(7702, 74, 2, 2, now - 8 * DAY, 1, null);
  file(97601, 74, 1, "/media/Anime/Scoped/Season 01/Scoped - S01E01.mkv", ["fr"]);
  file(97701, 74, 2, "/media/Anime/Scoped/Season 02/Scoped - S02E01.mkv", ["fr"]);
  db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (?, 74, 'Scoped', 0, 0)").run(SCOPED);
  setScope([SCOPED], { seasons: "latest", recentN: 1, episodes: "missing", specials: false, creditless: false });

  series(75, DROPPED, "Dropped", 1);
  ep(7801, 75, 1, 1, now - 7 * DAY, 1, null);
  db.prepare("INSERT INTO dropped (tvdb_id, title, at, why) VALUES (?, 'Dropped', 0, '')").run(DROPPED);
});

test("wanted: the scope for managed shows, Sonarr's series + episode flags otherwise; dropped wants nothing", () => {
  assert.deepEqual([...wantedEpisodeIds(BLEACH, 71, now)], [], "scope 'none' wants nothing, whatever Sonarr's flags say");
  assert.deepEqual([...wantedEpisodeIds(PLAIN, 72, now)].sort(), [7401, 7402], "only Sonarr-monitored episodes");
  assert.deepEqual([...wantedEpisodeIds(OFF, 73, now)], [], "an unmonitored show wants none of its episodes");
  assert.deepEqual(
    [...wantedEpisodeIds(SCOPED, 74, now)].sort(),
    [7701, 7702],
    "the latest season, its file included (a wrong-language file there is still wanted)",
  );
  assert.deepEqual([...wantedEpisodeIds(DROPPED, 75, now)], []);
});

test("Bleach: no missing, no language warning, the count is what you have", () => {
  const rows = episodeRows(71);
  assert.ok(rows.every((r) => !r.wanted));
  assert.equal(rows.find((r) => r.id === 7101)!.status, "missing", "still a fact on the row (shown greyed)");
  const h = seriesHeader(BLEACH)!;
  assert.equal(h.counts.missing, 0);
  assert.equal(h.counts.aired, 1, "aired = wanted aired + what you have");
  assert.equal(h.counts.have, 1);
  assert.equal(h.language.noLang, 0, "a file of an unmonitored season raises no language warning");
});

test("a managed show's out-of-scope file in the wrong language stays 'have' and is never replaced", () => {
  const by = new Map(episodeRows(74).map((r) => [r.id, r]));
  assert.equal(by.get(7601)!.status, "have", "season 1 is out of scope");
  assert.equal(by.get(7701)!.status, "wrong-lang", "season 2 is in scope");
  assert.deepEqual([...wrongLanguageEpisodes(SCOPED).keys()], [7701]);
  const h = seriesHeader(SCOPED)!;
  assert.equal(h.counts.missing, 2, "S02E02 missing + S02E01 wrong language; S01E02 is out of scope");
  assert.equal(h.language.noLang, 1);
});

test("not managed: Sonarr's season-level unmonitoring keeps that season quiet", () => {
  const h = seriesHeader(PLAIN)!;
  assert.equal(h.counts.missing, 1, "only S02E01");
  assert.equal(h.language.noLang, 1, "only the S02 file");
});

test("Gaps / Wanted list only what you want: no unmonitored or dropped show, no unmonitored season", () => {
  const g = new Map(gaps().series.map((s) => [s.tvdbId, s]));
  assert.ok(!g.has(BLEACH), "Bleach has empty unmonitored seasons, yet no gaps");
  assert.ok(!g.has(OFF));
  assert.ok(!g.has(DROPPED));
  assert.deepEqual(
    g.get(PLAIN)!.missing.map((e) => e.id),
    [7401],
  );
  assert.deepEqual(g.get(PLAIN)!.missingSeasons, []);
  assert.deepEqual(
    g.get(SCOPED)!.missing.map((e) => e.id),
    [7702],
  );
});

test("Audit → language: files of unwanted episodes aren't listed", () => {
  const r = missingLanguage();
  const files = r.series.flatMap((g) => g.files.map((f) => f.id));
  assert.ok(!files.includes(97201), "Bleach's unmonitored file");
  assert.ok(!files.includes(97302), "Plain's unmonitored season");
  assert.ok(!files.includes(97601), "Scoped's out-of-scope season");
  assert.ok(files.includes(97402) && files.includes(97701), "wanted files still are");
});

test("calendar entries say whether they're wanted (Home's 'needs you' only counts wanted ones)", () => {
  const c = new Map(calendar(now - 30 * DAY, now + DAY, false).map((e) => [e.episodeId, e]));
  assert.equal(c.get(7202)!.status, "missing");
  assert.equal(c.get(7202)!.wanted, false);
  assert.equal(c.get(7401)!.wanted, true);
  assert.equal(c.get(7501)!.wanted, false);
});

test("an unmonitored show sends no notification; the bell keeps it read and out of 'Needs action'", async () => {
  assert.equal(quietShow(BLEACH, [7202]), true);
  assert.equal(quietShow(PLAIN, [7401]), false);
  assert.equal(quietShow(PLAIN, [7301]), true, "an unmonitored season of a monitored show");
  assert.equal(quietShow(999999, []), false, "a show that isn't in the library is never quiet");
  patchSettings((s) => ({ ...s, notify: { ...s.notify, ntfyUrl: "http://192.168.1.50/animearr", discordWebhook: "", channels: [] } }));
  const sent: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => (
    sent.push(String(init.body)),
    new Response("", { status: 200 })
  )) as unknown as typeof fetch;
  const settle = () => new Promise((res) => setTimeout(res, 100));
  try {
    logDecision("grab", { tvdbId: BLEACH, title: "Bleachy", episodeIds: [7202], why: "Sent Bleachy S02E02 to SABnzbd" });
    logDecision("fail", { tvdbId: BLEACH, title: "Bleachy", episodeIds: [7202], why: "Bleachy S02E02: the download failed" });
    await settle();
    assert.deepEqual(sent, [], "nothing pushed for an unmonitored show");
    const items = bell().items.filter((i) => i.tvdbId === BLEACH);
    assert.equal(items.length, 2, "the bell still records it (and Activity has the full entry)");
    assert.ok(
      items.every((i) => i.read && !i.action),
      "already read, never 'Needs action'",
    );

    logDecision("grab", { tvdbId: PLAIN, title: "Plain", episodeIds: [7401], why: "Sent Plain S02E01 to SABnzbd" });
    await settle();
    assert.equal(sent.length, 1, "a monitored episode still notifies");
    assert.ok(bell().items.some((i) => i.tvdbId === PLAIN && !i.read));
  } finally {
    globalThis.fetch = real;
    patchSettings((s) => ({ ...s, notify: { ...s.notify, ntfyUrl: "" } }));
  }
});
