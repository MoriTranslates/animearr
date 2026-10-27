import { test } from "node:test";
import assert from "node:assert/strict";
import { comboQueries, queryGrid, shortTitle, tier1Queries } from "../server/search.js";
import type { LibEpisode } from "../server/core/resolver.js";

const ep = (season: number, episode: number, id = season * 100 + episode): LibEpisode => ({ id, season, episode, absolute: null, sceneSeason: null, sceneEpisode: null, sceneAbsolute: null, airUtc: null });

test("long titles are shortened for indexer search", () => {
  assert.equal(shortTitle("Magic Repo Man: Dumped by My Party, I'll Cash In with a Cute Support Fairy to Become the Strongest!"), "Magic Repo Man");
  assert.equal(shortTitle("Full-Time Magister"), "Full-Time Magister");
  assert.equal(shortTitle("Re: ZERO, Starting Life in Another World"), "Re ZERO, Starting Life in Another World");
});

test("tier 1 is 2-4 queries: canonical + romaji, with S01E01 and ' 01' forms", () => {
  const q = tier1Queries("Magic Repo Man: Dumped by My Party, I'll Cash In with a Cute Support Fairy to Become the Strongest!", "Tsuihou Sareta Fuyo Majutsushi", [ep(1, 1)]);
  assert.deepEqual(q, ["Magic Repo Man S01E01", "Magic Repo Man 01", "Tsuihou Sareta Fuyo Majutsushi S01E01", "Tsuihou Sareta Fuyo Majutsushi 01"]);
  assert.ok(q.length <= 4);
});

test("tier 1 for several episodes uses the season form; the wide grid is much larger (fallback only)", () => {
  const targets = Array.from({ length: 12 }, (_, i) => ep(6, i + 1));
  // A few episodes of a long season: the season form only.
  assert.deepEqual(tier1Queries("Full-Time Magister", "Quanzhi Fashi VI", targets.slice(0, 3), new Map([[6, 24]])), ["Full-Time Magister S6", "Quanzhi Fashi VI S6"]);
  // Most of the season: season packs ("(Season 01)", "- Season 1", "(01-12)", "Batch") often lack "S6", so the plain title and pack words too.
  const t1 = tier1Queries("Full-Time Magister", "Quanzhi Fashi VI", targets, new Map([[6, 12]]));
  assert.deepEqual(t1, ["Full-Time Magister S6", "Full-Time Magister", "Full-Time Magister batch", "Full-Time Magister Season 06", "Quanzhi Fashi VI S6", "Quanzhi Fashi VI", "Quanzhi Fashi VI batch", "Quanzhi Fashi VI Season 06"]);
  const titles = ["Full-Time Magister", "Quanzhi Fashi", "Quan Zhi Fa Shi", "Versatile Mage"];
  const grid = queryGrid(titles, targets);
  assert.ok(grid.includes("Quan Zhi Fa Shi"), "the spaced pinyin title (needed for the Magister S6 releases) is in the fallback grid");
  assert.ok(comboQueries(titles, "Full-Time Magister").includes("Quan Zhi Fa Shi Full-Time Magister"));
});

test("season packs without 'S1' parse as the whole season (Absolute Duo batches)", async () => {
  const { parseRelease } = await import("../server/core/parser.js");
  for (const n of ["[AkihitoSubs] Absolute Duo - Season 1 [Dual-Audio][1080p BD x265]", "[Judas] Absolute Duo (Season 01) [BD 1080p][HEVC x265 10bit][Dual-Audio][Eng-Subs] (Batch)"]) {
    const p = parseRelease(n);
    assert.equal(p.title, "Absolute Duo", n);
    assert.equal(p.season, 1, n);
    assert.deepEqual(p.absolute, [], `${n}: not "episode 1"`);
    assert.equal(p.batch, true, n);
  }
  const c = parseRelease("[RUBaDUB] Absolute Duo (Complete)");
  assert.equal(c.title, "Absolute Duo");
  assert.equal(c.batch, true);
  assert.deepEqual(parseRelease("[HorribleSubs] Absolute Duo (01 - 12) [1080p]").absolute, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});
