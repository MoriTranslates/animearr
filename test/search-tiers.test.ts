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
  const t1 = tier1Queries("Full-Time Magister", "Quanzhi Fashi VI", targets);
  assert.deepEqual(t1, ["Full-Time Magister S6", "Quanzhi Fashi VI S6"]);
  const titles = ["Full-Time Magister", "Quanzhi Fashi", "Quan Zhi Fa Shi", "Versatile Mage"];
  const grid = queryGrid(titles, targets);
  assert.ok(grid.includes("Quan Zhi Fa Shi"), "the spaced pinyin title (needed for the Magister S6 releases) is in the fallback grid");
  assert.ok(comboQueries(titles, "Full-Time Magister").includes("Quan Zhi Fa Shi Full-Time Magister"));
});
