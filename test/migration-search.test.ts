/** Migration's AniList picker is pre-filled with Sonarr's title, year included: the year must not break the search. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-migsearch-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { searchAdd, splitYear } = await import("../server/native.js");
type AniMedia = import("../server/anilist.js").AniMedia;

const media = (id: number, title: string, year: number): AniMedia =>
  ({ id, idMal: null, title: { romaji: title, english: null, native: null }, synonyms: [], format: "OVA", status: "FINISHED", episodes: 6, duration: 30, season: null, seasonYear: year, startDate: { year, month: 1, day: 1 }, endDate: null, countryOfOrigin: "JP", coverImage: { large: null, color: null }, bannerImage: null, description: "", genres: [], isAdult: false, relations: { edges: [] }, airingSchedule: { nodes: [] }, nextAiringEpisode: null, streamingEpisodes: [] }) as unknown as AniMedia;
const fribb = async () => ({ mtime: 0, anidbToAnilist: new Map<number, number>(), anilistToAnidb: new Map<number, number>(), anilistToAnidbAll: new Map<number, number[]>(), anilistToTmdb: new Map<number, number>() });

test("splitYear takes a trailing (1998) / [1998] off", () => {
  assert.deepEqual(splitYear("Nuku Nuku (1998)"), { title: "Nuku Nuku", year: 1998 });
  assert.deepEqual(splitYear("Nuku Nuku [2004] "), { title: "Nuku Nuku", year: 2004 });
  assert.deepEqual(splitYear("2001 Nights"), { title: "2001 Nights", year: null });
  assert.deepEqual(splitYear("Steins;Gate 0"), { title: "Steins;Gate 0", year: null });
});

test("searching 'Title (1998)' asks AniList for the title only, and puts the 1998 entry first", async () => {
  const asked: string[] = [];
  const search = async (q: string) => (asked.push(q), [media(1, "Nuku Nuku", 1992), media(2, "Nuku Nuku Dash!", 1998)]);
  const r = await searchAdd("Nuku Nuku (1998)", { search: search as never, fribb, timeoutMs: 1000 });
  assert.deepEqual(asked, ["Nuku Nuku"]);
  assert.equal(r.results[0].anilistId, 2);
  assert.equal(r.results.length, 2);
});
