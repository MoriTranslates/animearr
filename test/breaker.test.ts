/** Movie-search incident of 2026-10-26: wrong movie matches, the indexer circuit breaker, fetch failures, dropped shows. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-breaker-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { db, cache } = await import("../server/db.js");
const { parseRelease } = await import("../server/core/parser.js");
const { matchMovie, liveAction } = await import("../server/movies.js");
const health = await import("../server/health.js");
const { remainingFallbacks, FetchFailedError, fetchOrNote } = await import("../server/pipeline.js");
const { dropShow, isDropped, undropShow, refuseDropped } = await import("../server/dropped.js");
const { setManaged } = await import("../server/managed.js");
const { addToQueue } = await import("../server/fillin.js");

const QQ_MOVIE = { title: "The Quintessential Quintuplets Movie", original_title: "映画 五等分の花嫁", alt_titles: ["Eiga Gotoubun no Hanayome", "5-toubun no Hanayome Movie", "Go-Toubun no Hanayome Movie"], year: 2022 };
const QQ_SIM = { title: "The Quintessential Quintuplets∽", original_title: "五等分の花嫁∽", alt_titles: ["Gotoubun no Hanayome∽", "The Quintessential Quintuplets Specials", "The Quintessential Quintuplets: No Coincidences in This Summer Break"], year: 2023 };
const QQ_AST = { title: "The Quintessential Quintuplets＊", original_title: "五等分の花嫁＊", alt_titles: ["The Quintessential Quintuplets Specials 2", "The Quintessential Quintuplets: Operation Quintuplets"], year: 2024 };
const conf = (name: string, m: typeof QQ_MOVIE, series: string[] = []) => matchMovie(parseRelease(name), m, series).confidence;

test("the 2022 movie's releases don't match the ∽ / ＊ specials (grabs 51–59)", () => {
  for (const n of ["[RUDY] Gotoubun no Hanayome - The Movie - 1080p WEB", "Gotoubun No Hanayome Movie (English Subs) 1080p", "[ASW] Gotoubun no Hanayome Movie [1080p HEVC x265 10Bit][AAC]", "[RUDY] The Quintessential Quintuplets Movie [REPACK] (BD 1080p HEVC x265 10-bit Opus)"]) {
    // Never good enough to grab automatically (minConfidence 80); a loose partial match may still be listed for a manual pick.
    assert.ok(conf(n, QQ_SIM) < 80, `∽ ← ${n}`);
    assert.ok(conf(n, QQ_AST) < 80, `＊ ← ${n}`);
    assert.ok(conf(n, QQ_MOVIE) > 0, `movie ← ${n}`);
  }
  assert.ok(conf("[Grp] Gotoubun no Hanayome∽ [1080p]", QQ_SIM) > 0, "the ∽ release itself");
  assert.equal(conf("[Grp] Gotoubun no Hanayome∽ [1080p]", QQ_MOVIE), 0);
  assert.ok(conf("[Grp] The Quintessential Quintuplets＊ [1080p]", QQ_AST) > 0);
});

test("a TV-series batch isn't the film of the same name; live-action films aren't auto-searched (grabs 61–65)", () => {
  const gb = { title: "Grand Blue", original_title: "ぐらんぶる", alt_titles: ["Granblue", "Grand Blue Dreaming", "Guranburu"], year: 2020 };
  const series = ["Grand Blue Dreaming", "Grand Blue"];
  assert.equal(conf("[DB] Grand Blue | Grand Blue Dreaming [10bit BD1080p][HEVC-x265]", gb, series), 0);
  assert.ok(conf("[Grp] Grand Blue (2020) [BD 1080p]", gb, series) > 0, "with the film's year it's still a candidate");
  assert.equal(liveAction({ genres: JSON.stringify(["Comedy"]) }), "Comedy");
  assert.equal(liveAction({ genres: JSON.stringify(["Animation", "Comedy"]) }), null);
  assert.equal(liveAction({ genres: "[]" }), null, "unknown genres never count");
});

test("circuit breaker: 3 failed downloads in a row turn an indexer off; a good re-test turns it back on", async () => {
  const id = 4242;
  const t0 = 1_800_000_000_000;
  health.recordIndexerFailure(id, "host storage.animetosho.org not found (DNS)", t0, { name: "AnimeTosho (Usenet)" });
  health.recordIndexerFailure(id, "host storage.animetosho.org not found (DNS)", t0 + 1, { name: "AnimeTosho (Usenet)" });
  assert.equal(health.indexerOff(id), false);
  health.recordIndexerFailure(id, "host storage.animetosho.org not found (DNS)", t0 + 2, { name: "AnimeTosho (Usenet)" });
  assert.equal(health.indexerOff(id), true);
  assert.equal(health.indexerHealth(id, t0 + 3)?.off, true);
  const row = health.breakerList().find((b) => b.indexerId === id)!;
  assert.equal(row.state, "off");
  assert.equal(row.nextCheck, t0 + 2 + 6 * 3_600_000);
  // A search that works doesn't turn a download-tripped indexer back on.
  health.recordIndexerSuccess(id, "search", t0 + 4);
  assert.equal(health.indexerOff(id), true);
  // A magnet proves nothing (no network call); a real .nzb link is what a re-test fetches.
  health.noteSeen(id, { guid: "m", title: "m", protocol: "torrent", magnetUrl: "magnet:?xt=urn:btih:x" });
  assert.equal((await health.testIndexer(id, { fetch: async () => ({}) }, t0 + 5)).ok, false, "nothing to test with yet");
  health.noteSeen(id, { guid: "g", title: "x", protocol: "usenet", downloadUrl: "http://h/x.nzb" });
  // Re-test fails: next in 12 h, then daily.
  const fail = async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", hostname: "storage.animetosho.org" } });
  };
  assert.equal(await health.breakerTick({ fetch: fail }, t0 + 7 * 3_600_000), 1);
  let b = health.breakerList().find((x) => x.indexerId === id)!;
  assert.equal(b.nextCheck, t0 + 7 * 3_600_000 + 12 * 3_600_000);
  assert.match(b.lastError ?? "", /storage\.animetosho\.org not found/);
  await health.breakerTick({ fetch: fail }, t0 + 20 * 3_600_000);
  b = health.breakerList().find((x) => x.indexerId === id)!;
  assert.equal(b.nextCheck, t0 + 20 * 3_600_000 + 24 * 3_600_000);
  // Works again: back on, logged (and notified as an "indexer" event).
  await health.breakerTick({ fetch: async () => ({}) }, t0 + 45 * 3_600_000);
  assert.equal(health.indexerOff(id), false);
  const log = db.prepare("SELECT why FROM decisions WHERE why LIKE '%working again%' ORDER BY id DESC").get() as { why: string };
  assert.match(log.why, /AnimeTosho \(Usenet\) is working again/);
  // Keep off: automatic re-tests never turn it on.
  health.setBreaker(id, "keep-off");
  await health.breakerTick({ fetch: async () => ({}) }, t0 + 100 * 3_600_000);
  assert.equal(health.indexerOff(id), true);
  health.setBreaker(id, "on");
  assert.equal(health.indexerOff(id), false);
});

test("a fetch failure names the host, skips the rest of that indexer's candidates and doesn't use up an attempt", async () => {
  const cand = (indexerId: number, title: string) => ({ guid: title, title, indexerId, indexer: `ix${indexerId}`, protocol: "usenet" as const, size: 1, downloadUrl: "http://storage.example/x", label: "", group: null, why: "", episodeIds: [] });
  const deps = { fetchRelease: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND", hostname: "storage.example" } }); } } as unknown as Parameters<typeof fetchOrNote>[0];
  const err = await fetchOrNote(deps, cand(77, "A")).catch((e: unknown) => e);
  assert.ok(err instanceof FetchFailedError);
  assert.match((err as Error).message, /^Couldn't download the \.nzb from ix77: host storage\.example not found/);
  const left = remainingFallbacks([cand(77, "B"), cand(78, "C")], err);
  assert.deepEqual(left.map((c) => c.title), ["C"]);
});

test("a dropped show is never managed, grabbed, queued or re-added", async () => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, seasons, synced_at) VALUES (725, 463051, 'Even the Student Council Has Its Holes!', '/media/Anime/x', 0, '[]', 0)").run();
  await dropShow(463051, { why: "test" });
  assert.equal(isDropped(463051), true);
  assert.throws(() => refuseDropped(463051), /You dropped Even the Student Council/);
  assert.equal(setManaged([463051], true).refused[0]?.reason.startsWith("you dropped it"), true);
  assert.equal(addToQueue([463051]).added, 0);
  undropShow(463051);
  assert.equal(isDropped(463051), false);
});

test("Prowlarr indexer selection: anime-fit hints and defaults for new indexers", async () => {
  const { animeFit, syncProwlarrSelection } = await import("../server/indexerPick.js");
  const { getSettings, patchSettings } = await import("../server/settings.js");
  assert.equal(animeFit("Nyaa.si"), "great");
  assert.equal(animeFit("Sukebei (Nyaa)"), "not", "Sukebei is checked before Nyaa");
  assert.equal(animeFit("EZTV"), "not");
  assert.equal(animeFit("NZBgeek"), "general");
  assert.equal(animeFit("Some New Site"), null);
  const ix = (id: number, name: string, anime: boolean) => ({ id, name, definitionName: null, protocol: "torrent", enable: true, animeCategories: anime });
  // First time, nothing chosen: anime indexers ticked, the rest not (no review badges).
  let r = await syncProwlarrSelection([ix(1, "Nyaa.si", true), ix(2, "EZTV", false), ix(3, "NZBgeek", true)]);
  assert.deepEqual(getSettings().prowlarr.indexerIds.sort(), [1, 3]);
  assert.equal(r.some((x) => x.isNew), false);
  // A new indexer later: anime → ticked + badge; non-anime → unticked + badge.
  r = await syncProwlarrSelection([ix(1, "Nyaa.si", true), ix(2, "EZTV", false), ix(3, "NZBgeek", true), ix(4, "AniDex", true), ix(5, "YTS", true)]);
  assert.deepEqual(getSettings().prowlarr.indexerIds.sort(), [1, 3, 4]);
  assert.deepEqual(r.filter((x) => x.isNew).map((x) => x.id), [4, 5]);
  patchSettings((s) => ({ ...s, prowlarr: { ...s.prowlarr, indexerIds: [], knownIds: [], newIds: [] } }));
});

test("a movie download with several large files offers Import manually…", async () => {
  const { fixesFor } = await import("../server/fixes.js");
  const f = fixesFor("Downloaded X but couldn't import it: the download has several large video files (a.mkv, b.mkv); import the right one by hand. The download is kept", { movieId: 1351, grabId: 74, kind: "fail" });
  assert.equal(f[0]?.action, "importManual");
});

test("multi-part movies: numbered parts of similar size are imported as pt1/pt2 in order", async () => {
  const { multiPart } = await import("../server/movies.js");
  const GB = 1e9;
  const qq = [
    { path: "/d/x/[Itsuki Gang] The Quintessential Quintuplets~ Specials - S00E03 [BD 1080p x265 Opus].mkv", size: 1.1 * GB },
    { path: "/d/x/[Itsuki Gang] The Quintessential Quintuplets~ Specials - S00E02 [BD 1080p x265 Opus].mkv", size: 1.0 * GB },
  ];
  assert.deepEqual(multiPart(qq)?.map((f) => f.path.includes("S00E02")), [true, false], "ordered by part number");
  assert.equal(multiPart([{ path: "/d/Movie A.mkv", size: 4 * GB }, { path: "/d/Movie B.mkv", size: 3.8 * GB }]), null, "two unnumbered movies: ask");
  assert.equal(multiPart([{ path: "/d/x - 01.mkv", size: 4 * GB }, { path: "/d/x - 01v2.mkv", size: 3.9 * GB }]), null, "same number twice: ask");
});
