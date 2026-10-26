/** Creditless OP/ED (NCOP/NCED): parsed, mapped to the show's specials, never junk, scoped, importable as extras. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-cl-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { cache } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { parseRelease } = await import("../server/core/parser.js");
const { resolveRelease, isCreditlessTitle } = await import("../server/core/resolver.js");
const { classifySpecial, specialType } = await import("../server/audit.js");
const { inScope } = await import("../server/scope.js");
const { episodeDestination } = await import("../server/importer.js");

test("parser: NCOP/NCED, creditless/clean/non-credit OP/ED, with or without a number", () => {
  const p = (s: string) => parseRelease(s).creditless;
  assert.deepEqual(p("[Moozzi2] Sousou no Frieren - NCOP1 (BD 1080p).mkv"), { kind: "op", n: 1 });
  assert.deepEqual(p("[G] Show - NCED 02 [1080p].mkv"), { kind: "ed", n: 2 });
  assert.deepEqual(p("Show Creditless Opening 2 [BD].mkv"), { kind: "op", n: 2 });
  assert.deepEqual(p("[G] Show - Clean ED [BD].mkv"), { kind: "ed", n: null });
  assert.equal(p("[G] Show - 05 [1080p].mkv"), null);
  assert.equal(parseRelease("[Moozzi2] Sousou no Frieren - NCOP1 (BD 1080p).mkv").title, "Sousou no Frieren");
});

const lib = [
  { id: 1, season: 1, episode: 1, absolute: 1, sceneSeason: null, sceneEpisode: null, sceneAbsolute: null, airUtc: 0, title: "Ep 1" },
  { id: 10, season: 0, episode: 1, absolute: null, sceneSeason: null, sceneEpisode: null, sceneAbsolute: null, airUtc: 0, title: "OVA" },
  { id: 11, season: 0, episode: 2, absolute: null, sceneSeason: null, sceneEpisode: null, sceneAbsolute: null, airUtc: 0, title: "Creditless Opening 1" },
  { id: 12, season: 0, episode: 3, absolute: null, sceneSeason: null, sceneEpisode: null, sceneAbsolute: null, airUtc: 0, title: "Creditless Opening 2" },
  { id: 13, season: 0, episode: 4, absolute: null, sceneSeason: null, sceneEpisode: null, sceneAbsolute: null, airUtc: 0, title: "Creditless Ending" },
];
const cand = { tvdbId: 1, seriesId: 1, aid: null, impliedSeason: null, entry: null, score: 1, inLibrary: true, matchedTitle: "Show", source: "library", inferred: false, why: [] } as never;

test("resolver: OP2 → the second creditless opening, ED → the ending; unknown → asks", () => {
  const r = (s: string) => resolveRelease(parseRelease(s), cand, lib);
  assert.deepEqual(r("[G] Show - NCOP2 [BD].mkv").episodes.map((e) => e.id), [12]);
  assert.deepEqual(r("[G] Show - NCED [BD].mkv").episodes.map((e) => e.id), [13]);
  assert.equal(r("[G] Show - NCED3 [BD].mkv").ok, false);
  // A batch that also has the OP/ED isn't taken for a single special.
  assert.notEqual(r("Show 01-12 (BD 1080p) + NCOP NCED").method, "creditless");
  assert.ok(isCreditlessTitle("NCOP1") && isCreditlessTitle("Opening 2: Yuusha") && isCreditlessTitle("Opening 1a"));
});

test("never junk: classified as creditless (title or AniDB credit type)", () => {
  assert.equal(classifySpecial("Creditless Opening 1", 2).cls, "creditless");
  assert.equal(classifySpecial("NCED", 2).cls, "creditless");
  assert.equal(specialType("Clean Ending", 2).type, "creditless");
  assert.equal(classifySpecial("Music Video", 4).cls, "junk");
  assert.ok(isCreditlessTitle("Non-Credit OP") && !isCreditlessTitle("The Opening Night"));
});

test("scope: creditless specials wanted on their own toggle; off keeps them out", () => {
  const eps = [
    { id: 1, season: 1, air_utc: 0, has_file: 1 },
    { id: 11, season: 0, air_utc: 0, has_file: 0, creditless: true },
    { id: 10, season: 0, air_utc: 0, has_file: 0 },
  ];
  const base = { seasons: "all" as const, recentN: 1, episodes: "missing" as const, specials: false };
  assert.deepEqual(inScope({ ...base, creditless: true }, eps).map((e) => e.id), [11]);
  assert.deepEqual(inScope({ ...base, creditless: false }, eps).map((e) => e.id), []);
});

test("import as Plex extras: the show's Other folder with -other", () => {
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, synced_at, series_type) VALUES (1, 900, 'Show', '/media/AnimeArr/Show', 1, 0, 'anime')").run();
  const ep = { id: 11, season: 0, episode: 2, absolute: null, title: "Creditless Opening 1", air_date: null, file_id: null };
  patchSettings((s) => ({ ...s, media: { ...s.media, creditlessAs: "extras" } }));
  assert.equal(episodeDestination(900, [ep], { release: "x", ext: ".mkv", probe: null }), "/media/AnimeArr/Show/Other/Creditless Opening 1 (S00E02)-other.mkv");
  patchSettings((s) => ({ ...s, media: { ...s.media, creditlessAs: "s00" } }));
  assert.match(episodeDestination(900, [ep], { release: "x", ext: ".mkv", probe: null }), /Specials\/.*S00E02/);
});
