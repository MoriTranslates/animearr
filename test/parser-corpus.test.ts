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
  /** Checked only when given. */
  batch?: boolean;
}

function check(rows: Row[]) {
  for (const r of rows) {
    const p = parseRelease(r.name);
    const got = {
      title: p.title,
      group: p.group,
      season: p.season,
      episodes: p.episodes,
      absolute: p.absolute,
      ...(r.batch === undefined ? {} : { batch: p.batch }),
    };
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

test("a number ending the title before SxxEyy stays in the title (Mob Psycho 100, Kaiju No. 8)", () => {
  check([
    { name: "Mob.Psycho.100.S03E05.1080p.WEB.H264-GRP", title: "Mob Psycho 100", group: "GRP", season: 3, episodes: [5] },
    { name: "Mob Psycho 100 S03E01", title: "Mob Psycho 100", group: null, season: 3, episodes: [1] },
    { name: "[Group] Mob Psycho 100 S03E05 [1080p]", title: "Mob Psycho 100", group: "Group", season: 3, episodes: [5] },
    { name: "Kaiju.No.8.S01E05.1080p.WEB.H264-GRP", title: "Kaiju No 8", group: "GRP", season: 1, episodes: [5] },
    { name: "Kaiju No. 8 S01E05", title: "Kaiju No. 8", group: null, season: 1, episodes: [5] },
    { name: "Golgo.13.S01E05.720p.HDTV.x264-GRP", title: "Golgo 13", group: "GRP", season: 1, episodes: [5] },
    { name: "Cyborg 009 S01E03 1080p WEB", title: "Cyborg 009", group: null, season: 1, episodes: [3] },
    {
      name: "Space Battleship Yamato 2199 S01E10 1080p BluRay x264-GRP",
      title: "Space Battleship Yamato 2199",
      group: "GRP",
      season: 1,
      episodes: [10],
    },
  ]);
});

test("numbers at the end of a title: rows that must not change", () => {
  check([
    { name: "Mob Psycho 100 III - 01", title: "Mob Psycho 100 III", group: null, absolute: [1] },
    { name: "[Erai-raws] Mob Psycho 100 III - 01 [1080p]", title: "Mob Psycho 100 III", group: "Erai-raws", absolute: [1] },
    { name: "[SubsPlease] Kaiju No. 8 - 05 (1080p) [ABCD1234].mkv", title: "Kaiju No. 8", group: "SubsPlease", absolute: [5] },
    { name: "86 S01E05 1080p WEB H264-GRP", title: "86", group: "GRP", season: 1, episodes: [5] },
    { name: "Show - 100", title: "Show", group: null, absolute: [100] },
    { name: "Show 100", title: "Show", group: null, absolute: [100] },
    { name: "[Group] Show 100 [1080p]", title: "Show", group: "Group", absolute: [100] },
    { name: "[SubsPlease] One Piece - 1080 (1080p) [ABCD1234].mkv", title: "One Piece", group: "SubsPlease", absolute: [1080] },
    { name: "[Erai-raws] One Piece - 1080 [1080p][Multiple Subtitle]", title: "One Piece", group: "Erai-raws", absolute: [1080] },
    // The anime "absolute then SxE" form (Sonarr's K-F fixture) and SxxEyy with a trailing absolute keep both numbers.
    { name: "[K-F] Some Anime Show 214 10x14", title: "Some Anime Show", group: "K-F", season: 10, episodes: [14], absolute: [214] },
    { name: "[K-F] Some Anime Show S10E14 214", title: "Some Anime Show", group: "K-F", season: 10, episodes: [14], absolute: [214] },
    {
      name: "[Dae-P9] Anime Series - 05 - S01E05 - Title",
      title: "Anime Series",
      group: "Dae-P9",
      season: 1,
      episodes: [5],
      absolute: [5],
    },
  ]);
});

test("a trailing-number title identifies its own show, not the show named by the shorter title", () => {
  const lib = (tvdbId: number, title: string) => ({ seriesId: tvdbId, tvdbId, title, path: `/a/${tvdbId}`, altTitles: [] });
  const eps = (t: number) =>
    [1, 2, 3].flatMap((season) =>
      Array.from({ length: 13 }, (_, i) => ({
        id: t * 1000 + season * 100 + i + 1,
        season,
        episode: i + 1,
        absolute: (season - 1) * 13 + i + 1,
        sceneSeason: null,
        sceneEpisode: null,
        sceneAbsolute: null,
        airUtc: 0,
      })),
    );
  const index = new AliasIndex({ library: [lib(1, "Mob Psycho 100"), lib(2, "Mob Psycho"), lib(3, "Kaiju No. 8"), lib(4, "Kaiju No")] });
  const ctx = { index, now: Date.parse("2026-11-02T00:00:00Z"), episodesFor: (t: number) => eps(t) };
  const mob = identify("Mob.Psycho.100.S03E05.1080p.WEB.H264-GRP", ctx);
  assert.equal(mob.candidate?.tvdbId, 1, mob.summary);
  assert.deepEqual(
    mob.resolution?.episodes.map((e) => [e.season, e.episode]),
    [[3, 5]],
  );
  assert.equal(identify("Kaiju.No.8.S01E05.1080p.WEB.H264-GRP", ctx).candidate?.tvdbId, 3);
});

test("a title ending in 0 before ' - NN' is one episode, not a batch from 0 (Steins;Gate 0)", () => {
  check([
    { name: "Steins;Gate 0 - 05", title: "Steins;Gate 0", group: null, absolute: [5], batch: false },
    {
      name: "[SubsPlease] Steins;Gate 0 - 05 (1080p) [ABCD1234].mkv",
      title: "Steins;Gate 0",
      group: "SubsPlease",
      absolute: [5],
      batch: false,
    },
    {
      name: "[Group] Steins;Gate 0 - 01 - 23 [Batch]",
      title: "Steins;Gate 0",
      group: "Group",
      absolute: Array.from({ length: 23 }, (_, i) => i + 1),
      batch: true,
    },
  ]);
});

test("titles ending in a number or ';:_' before ' - NN', and real batches: rows that must not change", () => {
  const r12 = Array.from({ length: 12 }, (_, i) => i + 1);
  check([
    { name: "[Group] Zoku Owarimonogatari - 03 [1080p]", title: "Zoku Owarimonogatari", group: "Group", absolute: [3], batch: false },
    { name: "[SubsPlease] Re:Zero - 05 (1080p)", title: "Re:Zero", group: "SubsPlease", absolute: [5], batch: false },
    {
      name: "[Group] Ghost in the Shell: SAC_2045 - 03 [1080p]",
      title: "Ghost in the Shell: SAC_2045",
      group: "Group",
      absolute: [3],
      batch: false,
    },
    { name: "Show - 01-12", title: "Show", group: null, absolute: r12, batch: true },
    { name: "Show - 01 ~ 12", title: "Show", group: null, absolute: r12, batch: true },
    { name: "Show (01-12)", title: "Show", group: null, absolute: r12, batch: true },
    {
      name: "[Group] Show 01-24 [Batch]",
      title: "Show",
      group: "Group",
      absolute: Array.from({ length: 24 }, (_, i) => i + 1),
      batch: true,
    },
    { name: "[Group] Show - 01 - 12 [Batch]", title: "Show", group: "Group", absolute: r12, batch: true },
    { name: "[Group] Show 01 - 12", title: "Show", group: "Group", absolute: r12, batch: true },
    { name: "[Group] Show - 00 - 12", title: "Show", group: "Group", absolute: [0, ...r12], batch: true },
    { name: "[Group] Show - 0 - 12 (Complete)", title: "Show", group: "Group", absolute: [0, ...r12], batch: true },
    { name: "[Group] Show 0 - 12 [Batch]", title: "Show", group: "Group", absolute: [0, ...r12], batch: true },
  ]);
});

test("Steins;Gate 0 identifies Steins;Gate 0, not the decoy Steins;Gate", () => {
  const lib = (tvdbId: number, title: string) => ({ seriesId: tvdbId, tvdbId, title, path: `/a/${tvdbId}`, altTitles: [] });
  const eps = (t: number) =>
    Array.from({ length: 24 }, (_, i) => ({
      id: t * 100 + i + 1,
      season: 1,
      episode: i + 1,
      absolute: i + 1,
      sceneSeason: null,
      sceneEpisode: null,
      sceneAbsolute: null,
      airUtc: 0,
    }));
  const index = new AliasIndex({ library: [lib(1, "Steins;Gate 0"), lib(2, "Steins;Gate")] });
  const ctx = { index, now: Date.parse("2026-11-02T00:00:00Z"), episodesFor: (t: number) => eps(t) };
  const r = identify("[SubsPlease] Steins;Gate 0 - 05 (1080p) [ABCD1234].mkv", ctx);
  assert.equal(r.candidate?.tvdbId, 1, r.summary);
  assert.deepEqual(
    r.resolution?.episodes.map((e) => [e.season, e.episode]),
    [[1, 5]],
  );
});

test("a year in the title stays in the title (remakes)", () => {
  check([
    { name: "[Group] Hunter x Hunter (2011) - 05 [1080p]", title: "Hunter x Hunter (2011)", group: "Group", absolute: [5] },
    { name: "[Group] Hunter x Hunter - 05 [1080p]", title: "Hunter x Hunter", group: "Group", absolute: [5] },
    { name: "Hunter.x.Hunter.2011.S01E05.1080p.BluRay.x264-GRP", title: "Hunter x Hunter 2011", group: "GRP", season: 1, episodes: [5] },
  ]);
});

test("remakes: a title with no year goes to the show with that exact title, not the first remake in library order", () => {
  const lib = (tvdbId: number, title: string) => ({ seriesId: tvdbId, tvdbId, title, path: `/a/${tvdbId}`, altTitles: [] });
  const eps = (t: number) =>
    Array.from({ length: 24 }, (_, i) => ({
      id: t * 100 + i + 1,
      season: 1,
      episode: i + 1,
      absolute: i + 1,
      sceneSeason: null,
      sceneEpisode: null,
      sceneAbsolute: null,
      airUtc: 0,
    }));
  const ctxOf = (library: ReturnType<typeof lib>[]) => ({
    index: new AliasIndex({ library }),
    now: Date.parse("2026-11-02T00:00:00Z"),
    episodesFor: (t: number) => eps(t),
  });
  // The remake comes first in library order on purpose: before the fix it won the tie.
  for (const library of [
    [lib(2, "Hunter x Hunter (2011)"), lib(1, "Hunter x Hunter")],
    [lib(1, "Hunter x Hunter"), lib(2, "Hunter x Hunter (2011)")],
  ]) {
    const ctx = ctxOf(library);
    const plain = identify("[Group] Hunter x Hunter - 05 [1080p]", ctx);
    assert.equal(plain.candidate?.tvdbId, 1, plain.summary);
    const remake = identify("[Group] Hunter x Hunter (2011) - 05 [1080p]", ctx);
    assert.equal(remake.candidate?.tvdbId, 2, remake.summary);
    assert.equal(identify("Hunter.x.Hunter.2011.S01E05.1080p.BluRay.x264-GRP", ctx).candidate?.tvdbId, 2);
  }
  // Unchanged: with only the remake in the library, a release without the year still maps to it at the same confidence.
  const only = identify("[Group] Hunter x Hunter - 05 [1080p]", ctxOf([lib(2, "Hunter x Hunter (2011)")]));
  assert.equal(only.candidate?.tvdbId, 2, only.summary);
  assert.equal(only.resolution?.confidence, 86, only.summary);
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
