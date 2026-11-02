/**
 * Real-world release and file names, each checked for title, season, episodes, absolute numbers and group.
 * Rows marked "unchanged" pin today's behaviour so a parser fix can't silently move a name that already parses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRelease } from "../server/core/parser.js";
import { AliasIndex } from "../server/core/aliases.js";
import { identify } from "../server/core/identify.js";

interface Row {
  name: string;
  title: string;
  group: string | null;
  season?: number | null;
  episodes?: number[];
  absolute?: number[];
}

function check(rows: Row[]) {
  for (const r of rows) {
    const p = parseRelease(r.name);
    const got = { title: p.title, group: p.group, season: p.season, episodes: p.episodes, absolute: p.absolute };
    const want = { season: null, episodes: [], absolute: [], ...r };
    delete (want as Partial<Row>).name;
    assert.deepEqual(got, want, r.name);
  }
}

test("a '/' inside a title is part of the title, not a folder separator (Fate, 22/7)", () => {
  check([
    { name: "[SubsPlease] Fate/strange Fake - 01 (1080p) [A1B2C3D4].mkv", title: "Fate/strange Fake", group: "SubsPlease", absolute: [1] },
    { name: "[Group] 22/7 - 05", title: "22/7", group: "Group", absolute: [5] },
    { name: "[Erai-raws] Fate/Zero - 13 [1080p][Multiple Subtitle]", title: "Fate/Zero", group: "Erai-raws", absolute: [13] },
    {
      name: "Fate.stay.night.Unlimited.Blade.Works.S01E05.1080p.BluRay.x264-GRP",
      title: "Fate stay night Unlimited Blade Works",
      group: "GRP",
      season: 1,
      episodes: [5],
    },
    {
      name: "[Judas] Fate/kaleid liner Prisma Illya - S01E03.mkv",
      title: "Fate/kaleid liner Prisma Illya",
      group: "Judas",
      season: 1,
      episodes: [3],
    },
    {
      name: "Fate/Grand Order - Absolute Demonic Front Babylonia S01E10 1080p WEB H.264-GRP",
      title: "Fate/Grand Order - Absolute Demonic Front Babylonia",
      group: "GRP",
      season: 1,
      episodes: [10],
    },
    // A slash in a metadata bracket must not cut the name either.
    { name: "[Group] Show Name - 07 [1080p / HEVC]", title: "Show Name", group: "Group", absolute: [7] },
  ]);
});

test("slash titles identify the right show, not a show named after the part after the slash", () => {
  const lib = (tvdbId: number, title: string) => ({ seriesId: tvdbId, tvdbId, title, path: `/a/${tvdbId}`, altTitles: [] });
  const ep = (id: number) => ({
    id,
    season: 1,
    episode: id % 100,
    absolute: id % 100,
    sceneSeason: null,
    sceneEpisode: null,
    sceneAbsolute: null,
    airUtc: 0,
  });
  const index = new AliasIndex({ library: [lib(1, "Fate/Zero"), lib(2, "Zero"), lib(3, "22/7"), lib(4, "7")] });
  const eps = new Map([1, 2, 3, 4].map((t) => [t, Array.from({ length: 13 }, (_, i) => ep(t * 100 + i + 1))]));
  const ctx = { index, now: Date.parse("2026-11-02T00:00:00Z"), episodesFor: (t: number) => eps.get(t) ?? [] };
  assert.equal(identify("[Erai-raws] Fate/Zero - 13 [1080p]", ctx).candidate?.tvdbId, 1);
  assert.equal(identify("[Group] 22/7 - 05", ctx).candidate?.tvdbId, 3);
});

test("a spaced ' / ' between two titles keeps the last one as the title (as before) and keeps the group", () => {
  check([{ name: "[Group] Shingeki no Kyojin / Attack on Titan - 05 [1080p]", title: "Attack on Titan", group: "Group", absolute: [5] }]);
});

test("real paths still reduce to the file name (unchanged)", () => {
  check([
    { name: "/downloads/complete/[SubsPlease] Show Name - 03 (1080p).mkv", title: "Show Name", group: "SubsPlease", absolute: [3] },
    {
      name: "D:\\Anime\\Show Name\\Season 1\\[Group] Show Name - S01E02.mkv",
      title: "Show Name",
      group: "Group",
      season: 1,
      episodes: [2],
    },
    { name: "C:/Anime/Show Name/Show Name - 04.mkv", title: "Show Name", group: null, absolute: [4] },
    { name: "./Show Name - 04.mkv", title: "Show Name", group: null, absolute: [4] },
  ]);
});
