/**
 * Real-world release and file names, each checked for title, season, episodes, absolute numbers and group.
 * Rows marked "unchanged" pin today's behaviour so a parser fix can't silently move a name that already parses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRelease } from "../server/core/parser.js";
import { AliasIndex } from "../server/core/aliases.js";
import { identify } from "../server/core/identify.js";
import { splitSeason } from "../server/core/normalize.js";

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

test("'Title ABS SxxEyy': an unknown numbered title falls back to the absolute number when the show confirms it (review #3)", () => {
  const lib = (tvdbId: number, title: string) => ({ seriesId: tvdbId, tvdbId, title, path: `/a/${tvdbId}`, altTitles: [] });
  // One Piece-like: season 21 holds absolute 892-1100 (TVDB numbers it 1-209); Sonarr's scene numbering (XEM) maps the
  // releases' S21E1050 to it.
  const onePiece = Array.from({ length: 1100 }, (_, i) => {
    const abs = i + 1;
    const s21 = abs >= 892;
    return {
      id: 10_000 + abs,
      season: s21 ? 21 : 20,
      episode: s21 ? abs - 891 : abs,
      absolute: abs,
      sceneSeason: s21 ? 21 : null,
      sceneEpisode: s21 ? abs : null,
      sceneAbsolute: null,
      airUtc: 0,
    };
  });
  const mobDecoy = [1, 2, 3].flatMap((season) =>
    Array.from({ length: 13 }, (_, i) => ({
      id: 20_000 + season * 100 + i + 1,
      season,
      episode: i + 1,
      absolute: (season - 1) * 13 + i + 1,
      sceneSeason: null,
      sceneEpisode: null,
      sceneAbsolute: null,
      airUtc: 0,
    })),
  );
  const ctx = {
    index: new AliasIndex({ library: [lib(1, "One Piece"), lib(2, "Mob Psycho")] }),
    now: Date.parse("2026-11-02T00:00:00Z"),
    episodesFor: (t: number) => (t === 1 ? onePiece : t === 2 ? mobDecoy : []),
  };
  // The reviewer's repro (was "One Piece 1050" is not a known title).
  const op = identify("One Piece 1050 S21E1050 [1080p]", ctx);
  assert.equal(op.candidate?.tvdbId, 1, op.summary);
  assert.deepEqual(
    op.resolution?.episodes.map((e) => e.absolute),
    [1050],
    op.summary,
  );
  assert.equal(op.parsed.title, "One Piece");
  // The decoy: only "Mob Psycho" is in the library. Absolute 100 isn't S03E05 of it (it has 39 episodes), so the
  // release is not attached to it.
  const mob = identify("Mob.Psycho.100.S03E05.1080p.WEB.H264-GRP", ctx);
  assert.equal(mob.candidate, null, mob.summary);
  assert.equal(mob.parsed.title, "Mob Psycho 100");
  // A number that doesn't agree with the SxxEyy episode's absolute number: not attached either.
  const off = identify("One Piece 1049 S21E1050 [1080p]", ctx);
  assert.equal(off.candidate, null, off.summary);
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

test("'Show 0 - 12' with no batch word: a batch from episode 0 when 'Show 0' is unknown and the show has 0-12 (review #4)", () => {
  const lib = (tvdbId: number, title: string) => ({ seriesId: tvdbId, tvdbId, title, path: `/a/${tvdbId}`, altTitles: [] });
  // "Show" has a prologue episode 0; "Steins;Gate" (the decoy for "Steins;Gate 0") starts at 1.
  const eps = (t: number) =>
    Array.from({ length: t === 1 ? 13 : 24 }, (_, i) => {
      const n = t === 1 ? i : i + 1;
      return {
        id: t * 100 + i + 1,
        season: 1,
        episode: n,
        absolute: n,
        sceneSeason: null,
        sceneEpisode: null,
        sceneAbsolute: null,
        airUtc: 0,
      };
    });
  const ctx = {
    index: new AliasIndex({ library: [lib(1, "Show"), lib(2, "Steins;Gate")] }),
    now: Date.parse("2026-11-02T00:00:00Z"),
    episodesFor: (t: number) => eps(t),
  };
  // The reviewer's repro (was episode 12 of the unknown "Show 0").
  const batch = identify("[Group] Show 0 - 12 [1080p]", ctx);
  assert.equal(batch.candidate?.tvdbId, 1, batch.summary);
  assert.deepEqual(
    batch.resolution?.episodes.map((e) => e.episode),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    batch.summary,
  );
  assert.equal(batch.parsed.batch, true);
  // ...but it is a guess from the library, so a human confirms it: never automatic.
  assert.ok(batch.resolution!.confidence < 80, batch.summary);
  // The decoy: "Steins;Gate 0 - 05" never becomes episodes 0-5 of Steins;Gate (it has no episode 0): still unknown.
  const sg0 = identify("[SubsPlease] Steins;Gate 0 - 05 (1080p) [ABCD1234].mkv", ctx);
  assert.equal(sg0.candidate, null, sg0.summary);
  assert.equal(sg0.parsed.title, "Steins;Gate 0");
  // Must not change: with a batch word the parser reads the range itself, at full confidence.
  const labelled = identify("[Group] Show 0 - 12 [Batch]", ctx);
  assert.equal(labelled.resolution?.episodes.length, 13, labelled.summary);
  assert.ok(labelled.resolution!.confidence >= 80, labelled.summary);
});

test("'Steins;Gate 0 - 05' with only a Steins;Gate that has an episode 0 stays below auto", () => {
  const eps = Array.from({ length: 25 }, (_, i) => ({
    id: 300 + i,
    season: 1,
    episode: i,
    absolute: i,
    sceneSeason: null,
    sceneEpisode: null,
    sceneAbsolute: null,
    airUtc: 0,
  }));
  const ctx = {
    index: new AliasIndex({ library: [{ seriesId: 3, tvdbId: 3, title: "Steins;Gate", path: "/a/3", altTitles: [] }] }),
    now: Date.parse("2026-11-02T00:00:00Z"),
    episodesFor: () => eps,
  };
  const r = identify("[SubsPlease] Steins;Gate 0 - 05 (1080p) [ABCD1234].mkv", ctx);
  assert.ok(!r.resolution?.ok || r.resolution.confidence < 80, r.summary);
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

test("remakes: a weak rival (a sequel reached only through the franchise) doesn't penalise the remake (review #1)", () => {
  const lib = (tvdbId: number, title: string, alts: string[] = []) => ({
    seriesId: tvdbId,
    tvdbId,
    title,
    path: `/a/${tvdbId}`,
    altTitles: alts.map((t) => ({ title: t, sceneSeason: null })),
  });
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
  // The reviewer's repro: Dororo (2019) and a separate "Dororo II", in both library orders.
  for (const library of [
    [lib(2, "Dororo (2019)"), lib(3, "Dororo II")],
    [lib(3, "Dororo II"), lib(2, "Dororo (2019)")],
  ]) {
    const r = identify("[Group] Dororo - 05 [1080p]", ctxOf(library));
    assert.equal(r.candidate?.tvdbId, 2, r.summary);
    assert.equal(r.resolution?.confidence, 86, r.summary);
  }
  // Must not change: a remake that also carries the name without the year as an alternate title. The show whose own
  // title is that name still wins, in both orders, and the remake isn't tied with it.
  for (const library of [
    [lib(2, "Hunter x Hunter (2011)", ["Hunter x Hunter"]), lib(1, "Hunter x Hunter")],
    [lib(1, "Hunter x Hunter"), lib(2, "Hunter x Hunter (2011)", ["Hunter x Hunter"])],
  ]) {
    const r = identify("[Group] Hunter x Hunter - 05 [1080p]", ctxOf(library));
    assert.equal(r.candidate?.tvdbId, 1, r.summary);
    const cands = ctxOf(library).index.lookup("Hunter x Hunter");
    assert.ok(cands[0].score > cands[1].score, JSON.stringify(cands.map((c) => [c.tvdbId, c.score])));
  }
  // An episode only the remake has ("- 120": the 1999 series has 62) goes to the remake, above the auto threshold.
  const sized = (t: number) =>
    Array.from({ length: t === 1 ? 62 : 148 }, (_, i) => ({
      id: t * 1000 + i + 1,
      season: 1,
      episode: i + 1,
      absolute: i + 1,
      sceneSeason: null,
      sceneEpisode: null,
      sceneAbsolute: null,
      airUtc: 0,
    }));
  for (const library of [
    [lib(2, "Hunter x Hunter (2011)", ["Hunter x Hunter"]), lib(1, "Hunter x Hunter")],
    [lib(1, "Hunter x Hunter"), lib(2, "Hunter x Hunter (2011)", ["Hunter x Hunter"])],
  ]) {
    const ctx = { index: new AliasIndex({ library }), now: Date.parse("2026-11-02T00:00:00Z"), episodesFor: sized };
    const late = identify("[Group] Hunter x Hunter - 120 [1080p]", ctx);
    assert.equal(late.candidate?.tvdbId, 2, late.summary);
    assert.equal(late.resolution?.confidence, 83, late.summary);
    assert.equal(identify("[Group] Hunter x Hunter - 05 [1080p]", ctx).candidate?.tvdbId, 1);
  }
});

test("multi-episode files keep every episode, not just the first two", () => {
  const ep = (season: number, episodes: number[]) => ({ season, episodes });
  check([
    { name: "Show.S01E01-02-03.1080p.WEB.x264-GRP", title: "Show", group: "GRP", ...ep(1, [1, 2, 3]) },
    { name: "Show.S01E01E02E03.1080p.WEB.x264-GRP", title: "Show", group: "GRP", ...ep(1, [1, 2, 3]) },
    { name: "Show - S01E01-02-03-04 [1080p]", title: "Show", group: null, ...ep(1, [1, 2, 3, 4]) },
    { name: "Show - S01E01E02E03E04 [1080p]", title: "Show", group: null, ...ep(1, [1, 2, 3, 4]) },
    { name: "Show S02E05E06E07E08E09 x265", title: "Show", group: null, ...ep(2, [5, 6, 7, 8, 9]) },
    { name: "Show S02E05-06-07-08-09 x265", title: "Show", group: null, ...ep(2, [5, 6, 7, 8, 9]) },
    { name: "Show (2020) S01E01-02-03 [ABCD1234]", title: "Show (2020)", group: null, ...ep(1, [1, 2, 3]) },
    // The "-E03" end of a range is part of the SxxEyy, not a separate absolute number.
    { name: "Show S01E01-E03 1080p", title: "Show", group: null, ...ep(1, [1, 2, 3]) },
    { name: "Show S01E01-E02-E03 1080p", title: "Show", group: null, ...ep(1, [1, 2, 3]) },
    { name: "[Group] Show - S01E01-E02 (1080p) [ABCD1234].mkv", title: "Show", group: "Group", ...ep(1, [1, 2]) },
    // Without a season.
    { name: "Show E01-E03", title: "Show", group: null, absolute: [1, 2, 3] },
    { name: "Show - E01-E03 [1080p]", title: "Show", group: null, absolute: [1, 2, 3] },
    { name: "Show - 01-03 [1080p]", title: "Show", group: null, absolute: [1, 2, 3] },
    { name: "Show Ep01-03", title: "Show", group: null, absolute: [1, 2, 3] },
  ]);
});

test("SxxEyy next to resolution, codec, year and hash: rows that must not change", () => {
  check([
    { name: "Show.S01E01-02.1080p.WEB.x264-GRP", title: "Show", group: "GRP", season: 1, episodes: [1, 2] },
    // Pins the episode list only; the "1080p" group is an old quirk of the scene "-GROUP" rule, left as it is.
    { name: "Show S01E05-1080p", title: "Show", group: "1080p", season: 1, episodes: [5] },
    { name: "Show S01E01 1080p x264", title: "Show", group: null, season: 1, episodes: [1] },
    { name: "Show.S01E05.2160p.WEB.x265-GRP", title: "Show", group: "GRP", season: 1, episodes: [5] },
    { name: "Show (2019) - S01E05 - 005 [1080p] [ABCD1234]", title: "Show (2019)", group: null, season: 1, episodes: [5], absolute: [5] },
    { name: "[Group] Show - S01E05 [E1A2B3C4]", title: "Show", group: "Group", season: 1, episodes: [5] },
    { name: "Show S01E05v2 720p", title: "Show", group: null, season: 1, episodes: [5] },
  ]);
});

test("a bit depth or bare resolution after SxxEyy is not the end of a range (review #9)", () => {
  const eps = (name: string) => parseRelease(name).episodes;
  // Was 5-10, 5-12, 5-10 and 5-720.
  assert.deepEqual(eps("Show S01E05-10bit [1080p]"), [5]);
  assert.deepEqual(eps("Show S01E05-12bit"), [5]);
  assert.deepEqual(eps("Show.S01E05-10bit.1080p.WEB-GRP"), [5]);
  assert.deepEqual(eps("Show S01E05-720 Group"), [5]);
  // Must not change.
  assert.deepEqual(eps("Show S01E05-06 [1080p]"), [5, 6]);
  assert.deepEqual(eps("Show S01E05-E06"), [5, 6]);
  assert.deepEqual(eps("Show S01E05-06-07"), [5, 6, 7]);
  assert.deepEqual(eps("Show S01E01E02E03"), [1, 2, 3]);
  assert.deepEqual(eps("Show S01E05-06v2"), [5, 6]);
  assert.deepEqual(eps("Show S01E05-1080p"), [5]);
  assert.deepEqual(eps("Show S01E01-E24 [Batch]").length, 24);
  assert.deepEqual(eps("One Piece S21E892-1085 [Batch]").length, 194);
});

test("a long SxxEyy range stays a range when it says E or Batch; only a bare unmarked number is capped (round-2 #5)", () => {
  const p = (name: string) => parseRelease(name);
  // Was [1] with batch=false.
  assert.equal(p("Pokemon S01E01-276 [Batch]").episodes.length, 276);
  assert.equal(p("Pokemon S01E01-276 [Batch]").batch, true);
  assert.equal(p("Show S01E01-E250 [Batch]").episodes.length, 250);
  assert.equal(p("Show S01E01-E250 [Batch]").batch, true);
  assert.equal(p("Show S01E01-E250").episodes.length, 250);
  // Must not change: a bare resolution-like number with no E and no batch word.
  assert.deepEqual(p("Show S01E05-720 Group").episodes, [5]);
  assert.deepEqual(p("Show S01E01-276").episodes, [1]);
});

test("an 'absolute' numbering rule respects the release's own SxxEyy", () => {
  const lib = (tvdbId: number, title: string) => ({ seriesId: tvdbId, tvdbId, title, path: `/a/${tvdbId}`, altTitles: [] });
  // Two seasons of 12: absolute 13 is S02E01.
  const eps = (t: number) =>
    Array.from({ length: 24 }, (_, i) => ({
      id: t * 100 + i + 1,
      season: i < 12 ? 1 : 2,
      episode: (i % 12) + 1,
      absolute: i + 1,
      sceneSeason: null,
      sceneEpisode: null,
      sceneAbsolute: null,
      airUtc: 0,
    }));
  const ctx = {
    index: new AliasIndex({ library: [lib(1, "Some Show"), lib(2, "Some Show Two")] }),
    now: Date.parse("2026-11-02T00:00:00Z"),
    episodesFor: (t: number) => eps(t),
    rulesFor: () => [{ group: null, mode: "absolute" as const, season: null, offset: 0 }],
  };
  const at = (name: string) => {
    const r = identify(name, ctx);
    assert.equal(r.candidate?.tvdbId, 1, `${name}: ${r.summary}`);
    return { label: r.resolution?.episodes.map((e) => `S${e.season}E${e.episode}`).join(","), conf: r.resolution?.confidence ?? 0 };
  };
  // SxxEyy and the absolute number agree: that episode, fully certain (was S1E1: the rule read the "01" as absolute).
  assert.deepEqual(at("[Group] Some Show - S02E01 - 013 [1080p]"), { label: "S2E1", conf: 96 });
  // They disagree: never auto-certain (below the 80% threshold); the explicit SxxEyy is shown first.
  const clash = at("[Group] Some Show - S02E03 - 013 [1080p]");
  assert.equal(clash.label, "S2E3");
  assert.ok(clash.conf < 80, String(clash.conf));
  // Only SxxEyy, and it exists: the explicit season and episode (was S1E1).
  assert.deepEqual(at("Some.Show.S02E01.1080p.WEB.x264-GRP"), { label: "S2E1", conf: 96 });
  // Unchanged: only an absolute number → the rule maps it.
  assert.deepEqual(at("[Group] Some Show - 13 [1080p]"), { label: "S2E1", conf: 96 });
  // Unchanged: an SxxEyy the show doesn't have is read as absolute by the rule (S01E13 → absolute 13).
  assert.deepEqual(at("[Group] Some Show S01E13 [1080p]"), { label: "S2E1", conf: 96 });
  // Unchanged: season 1, both readings agree.
  assert.deepEqual(at("[Group] Some Show - S01E05 - 005 [1080p]"), { label: "S1E5", conf: 96 });
});

test("an absolute-rule clash stays below auto even with a publish date or a grab's episodes (review #2)", () => {
  const lib = (tvdbId: number, title: string) => ({ seriesId: tvdbId, tvdbId, title, path: `/a/${tvdbId}`, altTitles: [] });
  const week = 7 * 86_400_000;
  const start = Date.parse("2026-01-04T15:00:00Z");
  // Two seasons of 12, one episode a week: S02E01 (absolute 13) aired 8 weeks before S02E09.
  const eps = (t: number) =>
    Array.from({ length: 24 }, (_, i) => ({
      id: t * 100 + i + 1,
      season: i < 12 ? 1 : 2,
      episode: (i % 12) + 1,
      absolute: i + 1,
      sceneSeason: null,
      sceneEpisode: null,
      sceneAbsolute: null,
      airUtc: start + i * week,
    }));
  const ctx = {
    index: new AliasIndex({ library: [lib(1, "Some Show")] }),
    now: start + 30 * week,
    episodesFor: (t: number) => eps(t),
    rulesFor: () => [{ group: null, mode: "absolute" as const, season: null, offset: 0 }],
  };
  const name = "[Group] Some Show - S02E09 - 013 [1080p]";
  const s2e9Aired = start + 20 * week;
  // The reviewer's repro: published just after S02E09 aired (was S02E09 at 86%).
  for (const publishDate of [s2e9Aired + 3_600_000, start + 12 * week + 3_600_000]) {
    const r = identify(name, ctx, { publishDate });
    assert.ok(r.resolution?.ok, r.summary);
    assert.ok(r.resolution!.confidence < 80, r.summary);
  }
  // A grab made for either reading doesn't settle it either.
  for (const expect of [[121], [113]]) {
    const r = identify(name, ctx, { expect });
    assert.ok(r.resolution!.confidence < 80, r.summary);
  }
  // Must not change: when the two agree, a publish date leaves it fully certain.
  const agree = identify("[Group] Some Show - S02E01 - 013 [1080p]", ctx, { publishDate: start + 12 * week + 3_600_000 });
  assert.equal(agree.resolution?.confidence, 96, agree.summary);
});

test("a trailing Roman numeral is a season, but a lone 'X' is part of the title (Gundam X)", () => {
  const split = (t: string) => {
    const s = splitSeason(t);
    return [s.base, s.season];
  };
  // Must not change.
  assert.deepEqual(split("Mob Psycho 100 III"), ["mob psycho 100", 3]);
  assert.deepEqual(split("Overlord IV"), ["overlord", 4]);
  assert.deepEqual(split("Show II"), ["show", 2]);
  assert.deepEqual(split("Quanzhi Fashi VII"), ["quanzhi fashi", 7]);
  assert.deepEqual(split("Quanzhi Fashi V"), ["quanzhi fashi", 5]);
  assert.deepEqual(split("Spy x Family"), ["spy x family", null]);
  assert.deepEqual(split("Hunter x Hunter"), ["hunter x hunter", null]);
  // Was season 10.
  assert.deepEqual(split("Gundam X"), ["gundam x", null]);
  assert.deepEqual(split("Mobile Suit Gundam X"), ["mobile suit gundam x", null]);
  assert.deepEqual(split("After War Gundam X"), ["after war gundam x", null]);
  check([
    { name: "[Group] After War Gundam X - 05 [DVD]", title: "After War Gundam X", group: "Group", absolute: [5] },
    { name: "[Group] Mob Psycho 100 III - 05 [1080p]", title: "Mob Psycho 100 III", group: "Group", absolute: [5] },
  ]);
});

test("a 1979 Gundam release never lands on Gundam X", () => {
  const lib = (tvdbId: number, title: string, alts: string[] = []) => ({
    seriesId: tvdbId,
    tvdbId,
    title,
    path: `/a/${tvdbId}`,
    altTitles: alts.map((a) => ({ title: a, sceneSeason: null })),
  });
  const eps = (t: number) =>
    Array.from({ length: 43 }, (_, i) => ({
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
  const gundamX = lib(2, "After War Gundam X", ["Mobile Suit Gundam X", "Kidou Shin Seiki Gundam X"]);
  const both = ctxOf([gundamX, lib(1, "Mobile Suit Gundam")]);
  assert.equal(identify("[Group] Mobile Suit Gundam - 05 [DVD]", both).candidate?.tvdbId, 1);
  assert.equal(identify("[Group] After War Gundam X - 05 [DVD]", both).candidate?.tvdbId, 2);
  assert.equal(identify("[Group] Mobile Suit Gundam X - 05 [DVD]", both).candidate?.tvdbId, 2);
  // Only Gundam X in the library: the 1979 show is not a known title (was Gundam X "season 10" at 77%).
  const onlyX = identify("[Group] Mobile Suit Gundam - 05 [DVD]", ctxOf([gundamX]));
  assert.equal(onlyX.candidate, null, onlyX.summary);
});

test("a bracketed title right after the group is the title ([Oshi no Ko])", () => {
  check([
    { name: "[Group] [Oshi no Ko] - 05", title: "Oshi no Ko", group: "Group", absolute: [5] },
    { name: "[SubsPlease] [Oshi no Ko] - 05 (1080p) [ABCD1234].mkv", title: "Oshi no Ko", group: "SubsPlease", absolute: [5] },
    { name: "[Erai-raws] [Oshi no Ko] 2nd Season - 05 [1080p]", title: "Oshi no Ko", group: "Erai-raws", season: 2, absolute: [5] },
    { name: "[Group][Oshi no Ko] - 05", title: "Oshi no Ko", group: "Group", absolute: [5] },
    { name: "[Group] [Oshi no Ko] S02E05 [1080p]", title: "Oshi no Ko", group: "Group", season: 2, episodes: [5] },
    { name: "[Group][Show] - 05", title: "Show", group: "Group", absolute: [5] },
  ]);
});

test("group, second group and metadata brackets: rows that must not change", () => {
  check([
    { name: "[Group] Show - 05 [1080p]", title: "Show", group: "Group", absolute: [5] },
    { name: "[Group] [1080p] Show - 05", title: "Show", group: "Group", absolute: [5] },
    { name: "[Group] [BD] Show - 05", title: "Show", group: "Group", absolute: [5] },
    { name: "[Group] Show - 05 [ABCD1234]", title: "Show", group: "Group", absolute: [5] },
    { name: "[Group] Show - 05 (1080p) [ABCD1234].mkv", title: "Show", group: "Group", absolute: [5] },
    { name: "[WtF-aNiMe][SCY] Show - 05", title: "Show", group: "WtF-aNiMe", absolute: [5] },
    { name: "[F-B] [SCY] Show - 05", title: "Show", group: "F-B", absolute: [5] },
    { name: "[Group] [F-B] Show - 05", title: "Show", group: "Group", absolute: [5] },
    // A second group tag before a digit-first title (86 Eighty-Six) is still dropped.
    { name: "[Group] [SCY] 86 - 05", title: "86", group: "Group", absolute: [5] },
    { name: "[Group] 86 - 05", title: "86", group: "Group", absolute: [5] },
    { name: "[Group][F-B] 86 - 05", title: "86", group: "Group", absolute: [5] },
    { name: "[Group] [SCY] 86 S01E05 [1080p]", title: "86", group: "Group", season: 1, episodes: [5] },
  ]);
});

test("a second bracket tag is not merged into a title that follows it (review #6)", () => {
  check([
    // The reviewer's repro (was "TV Series 2", "Fan Edit - Show", "TV").
    { name: "[Group] [TV Series] 2 - 05", title: "2", group: "Group", absolute: [5] },
    { name: "[Group] [Fan Edit] - Show - 05", title: "Show", group: "Group", absolute: [5] },
    { name: "[Group] [Big Five] 86 - 05 [1080p]", title: "86", group: "Group", absolute: [5] },
    // Must not change: a bracketed title with only an episode or season after it.
    { name: "[Group] [Oshi no Ko] - 05", title: "Oshi no Ko", group: "Group", absolute: [5] },
    { name: "[Erai-raws] [Oshi no Ko] 2nd Season - 05 [1080p]", title: "Oshi no Ko", group: "Erai-raws", season: 2, absolute: [5] },
    { name: "[Group] [Oshi no Ko] S02E05 [1080p]", title: "Oshi no Ko", group: "Group", season: 2, episodes: [5] },
    { name: "[Group][Show] - 05", title: "Show", group: "Group", absolute: [5] },
    { name: "[Group] [SCY] 86 - 05", title: "86", group: "Group", absolute: [5] },
  ]);
  // "[TV] E01 Show" was an empty title before the parser branch; it must not become "TV".
  assert.notEqual(parseRelease("[Group] [TV] E01 Show").title, "TV");
});

test("[Oshi no Ko] goes to its own show, not a show named after what follows the brackets", () => {
  const lib = (tvdbId: number, title: string) => ({ seriesId: tvdbId, tvdbId, title, path: `/a/${tvdbId}`, altTitles: [] });
  const eps = (t: number) =>
    Array.from({ length: 22 }, (_, i) => ({
      id: t * 100 + i + 1,
      season: i < 11 ? 1 : 2,
      episode: (i % 11) + 1,
      absolute: i + 1,
      sceneSeason: null,
      sceneEpisode: null,
      sceneAbsolute: null,
      airUtc: 0,
    }));
  const ctx = {
    index: new AliasIndex({ library: [lib(2, "05"), lib(1, "[Oshi no Ko]"), lib(3, "Oshi no Ko Movie")] }),
    now: Date.parse("2026-11-02T00:00:00Z"),
    episodesFor: (t: number) => eps(t),
  };
  const r = identify("[SubsPlease] [Oshi no Ko] - 05 (1080p) [ABCD1234].mkv", ctx);
  assert.equal(r.candidate?.tvdbId, 1, r.summary);
  const s2 = identify("[Erai-raws] [Oshi no Ko] 2nd Season - 05 [1080p]", ctx);
  assert.equal(s2.candidate?.tvdbId, 1, s2.summary);
  assert.deepEqual(
    s2.resolution?.episodes.map((e) => [e.season, e.episode]),
    [[2, 5]],
  );
});

test("a version after the episode, spaced or in brackets, is read (05 v2, 05 [v2])", () => {
  const v = (name: string) => [
    parseRelease(name).title,
    parseRelease(name).absolute,
    parseRelease(name).episodes,
    parseRelease(name).version,
  ];
  // Was version 1.
  assert.deepEqual(v("Show - 05 v2"), ["Show", [5], [], 2]);
  assert.deepEqual(v("Show - 05 [v2]"), ["Show", [5], [], 2]);
  assert.deepEqual(v("[Group] Show - 05 v2 [1080p]"), ["Show", [5], [], 2]);
  assert.deepEqual(v("[Group] Show - 05 [v2] [1080p]"), ["Show", [5], [], 2]);
  assert.deepEqual(v("[Group] Show - 05 [V3]"), ["Show", [5], [], 3]);
  assert.deepEqual(v("Show - 05 (v2)"), ["Show", [5], [], 2]);
  assert.deepEqual(v("Show S01E05 v2"), ["Show", [], [5], 2]);
  // Must not change.
  assert.deepEqual(v("Show - 05v2"), ["Show", [5], [], 2]);
  assert.deepEqual(v("[Group] Show - 05v3 (1080p)"), ["Show", [5], [], 3]);
  assert.deepEqual(v("Show S01E05v2"), ["Show", [], [5], 2]);
  assert.deepEqual(v("[Group] Show - 05 [1080p]"), ["Show", [5], [], 1]);
  // "v2" in the title is part of the title, not a version.
  assert.deepEqual(v("[Group] Love Live! Superstar!! v2 - 05"), ["Love Live! Superstar!! v2", [5], [], 1]);
  assert.deepEqual(v("[Group] Show V2 - 05 [1080p]"), ["Show V2", [5], [], 1]);
  // Words after the episode ("- Title v2") are an episode title, not a version.
  assert.deepEqual(v("[Group] Show - 05 - Title v2"), ["Show", [5], [], 1]);
});

test("a bracketed '(v2)' inside an episode title is not the version (review #8)", () => {
  const ver = (name: string) => parseRelease(name).version;
  // The reviewer's repro (was 2).
  assert.equal(ver("[Group] Show - 05 - The (v2) Mission [1080p]"), 1);
  assert.equal(ver("Show S01E05 - Plan [v2] Begins"), 1);
  // Must not change: right after the episode, or among the tags after it.
  assert.equal(ver("Show - 05 (v2)"), 2);
  assert.equal(ver("[Group] Show - 05 [v2] [1080p]"), 2);
  assert.equal(ver("[Group] Show - 05 [1080p][v2]"), 2);
  assert.equal(ver("[Group] Show - 05 (1080p) [v2] [ABCD1234].mkv"), 2);
  assert.equal(ver("Show S01E05 [v2]"), 2);
});

test("a trailing '[v2]' after an episode title or bare tags is still the version (review round 2 #4)", () => {
  const ver = (name: string) => parseRelease(name).version;
  assert.equal(ver("[Group] Show - 05 - Episode Title [1080p][v2]"), 2);
  assert.equal(ver("[Group] Show - 05 END [v2]"), 2);
  assert.equal(ver("[Group] Show - 05 1080p [v2]"), 2);
  assert.equal(ver("Show S01E05 1080p WEB x264 [v2]"), 2);
  assert.equal(ver("Show.S01E05.1080p.WEB.(v2)"), 2);
  assert.equal(ver("[Group] Show - S01E01-02 - 001-002 [v2]"), 2);
  assert.equal(ver("[Group] Show - 05 - Episode Title [v2].mkv"), 2);
  // Still not a version when plain words follow it.
  assert.equal(ver("[Group] Show - 05 - The (v2) Mission"), 1);
  assert.equal(ver("[Group] Show - 05 - The [v2] Mission [1080p]"), 1);
});

test("an 'Ep' marker is not left in the title (Show Ep 05)", () => {
  check([
    // Was title "Show Ep" / "Show Ep.05" / "Show - Ep".
    { name: "Show Ep 05", title: "Show", group: null, absolute: [5] },
    { name: "Show Ep.05", title: "Show", group: null, absolute: [5] },
    { name: "Show Ep. 05", title: "Show", group: null, absolute: [5] },
    { name: "Show - Ep 05", title: "Show", group: null, absolute: [5] },
    { name: "[Group] Show Ep 05 [1080p]", title: "Show", group: "Group", absolute: [5] },
    { name: "Show.Ep.05.1080p.WEB.x264-GRP", title: "Show", group: "GRP", absolute: [5] },
    // Must not change.
    { name: "Show EP05", title: "Show", group: null, absolute: [5] },
    { name: "Show Episode 05", title: "Show", group: null, absolute: [5] },
    { name: "Show E05", title: "Show", group: null, absolute: [5] },
    { name: "[Group] Deep Insanity The Lost Child - 05 [1080p]", title: "Deep Insanity The Lost Child", group: "Group", absolute: [5] },
    {
      name: "[Group] Sleepy Princess in the Demon Castle - 05",
      title: "Sleepy Princess in the Demon Castle",
      group: "Group",
      absolute: [5],
    },
    { name: "[Group] Keep Your Hands Off Eizouken! - 05", title: "Keep Your Hands Off Eizouken!", group: "Group", absolute: [5] },
    {
      name: "Keep.Your.Hands.Off.Eizouken.S01E05.1080p.WEB.x264-GRP",
      title: "Keep Your Hands Off Eizouken",
      group: "GRP",
      season: 1,
      episodes: [5],
    },
  ]);
  assert.equal(parseRelease("Show Ep 05 v2").version, 2);
});

test("a '#N' in the title before the episode is part of the title (Show #1 - 05)", () => {
  check([
    // Was absolute 1 / 2 / 12 / 1 (with the SxxEyy).
    { name: "Show #1 - 05", title: "Show #1", group: null, absolute: [5] },
    { name: "[Group] Show #2 - 05 [1080p]", title: "Show #2", group: "Group", absolute: [5] },
    { name: "[Group] Show #12 - 05", title: "Show #12", group: "Group", absolute: [5] },
    { name: "[Group] Show #1 S01E05", title: "Show #1", group: "Group", season: 1, episodes: [5] },
    // Must not change.
    { name: "[Group] #DRCL midnight children - 05 [1080p]", title: "#DRCL midnight children", group: "Group", absolute: [5] },
    { name: "[Shark-Raws] Series Title #957 (NBN 1280x720 x264 AAC).mp4", title: "Series Title", group: "Shark-Raws", absolute: [957] },
    { name: "Show #957", title: "Show", group: null, absolute: [957] },
    { name: "[Group] Show - #05", title: "Show", group: "Group", absolute: [5] },
  ]);
  assert.equal(parseRelease("Show #1 - 05v2").version, 2);
});

test("'#N - 1080p': a resolution after the dash is not the episode, so '#N' is (review #5)", () => {
  check([
    // The reviewer's repro (was title "Show #12 - 1080p" / "One Piece #957 - 1080p", no episode).
    { name: "[Group] Show #12 - 1080p [HEVC]", title: "Show", group: "Group", absolute: [12] },
    { name: "One Piece #957 - 1080p.mkv", title: "One Piece", group: null, absolute: [957] },
    { name: "[Group] Show #12 - 720p", title: "Show", group: "Group", absolute: [12] },
    { name: "[Group] Show #12 - 10bit [1080p]", title: "Show", group: "Group", absolute: [12] },
    // Must not change: a real episode after the dash.
    { name: "[Group] Show #12 - 05 [1080p]", title: "Show #12", group: "Group", absolute: [5] },
    { name: "[Group] Show #1 - 1080 [1080p]", title: "Show #1", group: "Group", absolute: [1080] },
  ]);
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

test("a relative path is reduced to the file name when it clearly is one (review #7)", () => {
  check([
    // The reviewer's repro (was title "Show Batch/ Show", no group): the part after the "/" starts a new [Group] name.
    { name: "Show Batch/[Group] Show - 05 [1080p].mkv", title: "Show", group: "Group", absolute: [5] },
    { name: "[Group] Show Batch/[Group] Show - 05 [1080p]", title: "Show", group: "Group", absolute: [5] },
    // Two or more "/" between words: folders.
    { name: "Anime/Show Name/Show Name - 04.mkv", title: "Show Name", group: null, absolute: [4] },
    { name: "Show/Season 1/Show.S01E05.1080p.WEB.x264-GRP.mkv", title: "Show", group: "GRP", season: 1, episodes: [5] },
    // Must not change: one "/" inside a title.
    { name: "[SubsPlease] Fate/strange Fake - 01 (1080p) [A1B2C3D4].mkv", title: "Fate/strange Fake", group: "SubsPlease", absolute: [1] },
    { name: "[Group] 22/7 - 05", title: "22/7", group: "Group", absolute: [5] },
    { name: "[Group] Show Name - 07 [1080p / HEVC]", title: "Show Name", group: "Group", absolute: [7] },
    // Two "/" titles split by a spaced " / " are not folders.
    { name: "[Group] Fate/Zero / Fate/stay night - 05", title: "Fate/stay night", group: "Group", absolute: [5] },
  ]);
});

test("slashes inside tags or a title are not folders (round-2 review #1, real names)", () => {
  check([
    // Real names from the library (were cut at the last "/": "SPA]- AF", "Deutsch, English Dubs) | ...").
    {
      name: "Frieren Beyond Journeys End S02 1080p BD Remux FLAC [JAP/ENG/SPA]- AF",
      title: "Frieren Beyond Journeys End",
      group: null,
      season: 2,
    },
    {
      name: "[Fuchs] Mushoku Tensei - S00E02 (BD 1080p HEVC Opus 2.0) [Dual-Audio] [Multi-Audio] (Japanese, German/Deutsch, English Dubs) [OV] [OmU] [OmeU] [DF] [S",
      title: "Mushoku Tensei",
      group: "Fuchs",
      season: 0,
      episodes: [2],
    },
    // The reviewer's probes.
    { name: "[SubsPlease] Fate/Zero - 01 [1080p/HEVC]", title: "Fate/Zero", group: "SubsPlease", absolute: [1] },
    { name: "[Group] Show - 01 [1080p/x265/10bit]", title: "Show", group: "Group", absolute: [1] },
    { name: "[Group] Show - 01 (BD 1080p/HEVC/FLAC)", title: "Show", group: "Group", absolute: [1] },
    { name: "[Group] 22/7 - 05 [1080p/AAC]", title: "22/7", group: "Group", absolute: [5] },
    { name: "[Group] Fate/kaleid liner Prisma/Illya - 05 [1080p]", title: "Fate/kaleid liner Prisma/Illya", group: "Group", absolute: [5] },
    { name: "Show S01E05 - Yes/No/Maybe [1080p]", title: "Show", group: null, season: 1, episodes: [5] },
    { name: "[Group] Show - 05 [1080p]/[v2]", title: "Show", group: "Group", absolute: [5] },
    // Must not change: real paths, including a "/" inside a tag of the file name.
    { name: "/downloads/[Group] Show - 05 [1080p/HEVC].mkv", title: "Show", group: "Group", absolute: [5] },
    { name: "Show Batch/[Group] Show - 05 [1080p].mkv", title: "Show", group: "Group", absolute: [5] },
    { name: "Anime/Show Name/Show Name - 04.mkv", title: "Show Name", group: null, absolute: [4] },
    {
      name: "[Ioroid] お兄ちゃんはおしまい！/ Onii-chan / Oniichan wa Oshimai! - 01 [Uncensored][ABEMA WEB-DL 1080p AVC AAC]",
      title: "Oniichan wa Oshimai!",
      group: "Ioroid",
      absolute: [1],
    },
  ]);
});

test("a title left with a bare '/' by a stripped CJK name, or in an unclosed or all-bracket name (corpus regressions 1-3)", () => {
  check([
    // Regression 1: the CJK title before " / " was stripped upstream; the slash must not stay in the title.
    { name: "[&LoliHouse]  / Gleipnir - 03 [WebRip 1080p HEVC-10bit AAC][]", title: "Gleipnir", group: "&LoliHouse", absolute: [3] },
    {
      name: "[Lilith-Raws]  / No Guns Life - 13 [Baha][WEB-DL][1080p][AVC AAC][CHT][MKV]",
      title: "No Guns Life",
      group: "Lilith-Raws",
      absolute: [13],
    },
    {
      name: "[&LoliHouse]   / Mahouka Koukou no Rettousei S2 - 01 [WebRip 1080p HEVC-10bit AAC][]",
      title: "Mahouka Koukou no Rettousei",
      group: "&LoliHouse",
      season: 2,
      episodes: [1],
    },
    {
      name: "[&LoliHouse] /Kouya no Kotobuki Hikoutai - 01 [WebRip 1080p HEVC-10bit AAC][]",
      title: "Kouya no Kotobuki Hikoutai",
      group: "&LoliHouse",
      absolute: [1],
    },
    {
      name: "[U3-Web] Carole & Tuesday /  - 13 [NFLX WEB-DL 1080p AVC AAC E-AC-3] (Carole and Tuesday)",
      title: "Carole & Tuesday",
      group: "U3-Web",
      absolute: [13],
    },
    // Regression 2: an unclosed leading "[" (the CJK name inside it was stripped) must not swallow the whole name.
    { name: "[ /Shinchou Yuusha 01 [WebRip 1920x1080 HEVC YUV420P10 1080p AAC][]", title: "Shinchou Yuusha", group: null, absolute: [1] },
    { name: "[ /Shinchou Yuusha 02 [WebRip 1920x1080 HEVC YUV420P10 1080p AAC][]", title: "Shinchou Yuusha", group: null, absolute: [2] },
    // Regression 3: an all-bracket name: the bracket right after the group is the title ("CJK / Romaji").
    {
      name: "【喵萌奶茶屋】[工作細胞BLACK / Hataraku Saibou Black][01-13][BDRip][1080p][繁體][v2][招募翻譯]",
      title: "Hataraku Saibou Black",
      group: "喵萌奶茶屋",
      absolute: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    },
    // Must not change: the same shows from other groups, and a title that really has a "/" in it.
    {
      name: "[Nekomoe kissaten&LoliHouse] Gleipnir - 03 [WebRip 1080p HEVC-10bit AAC ASSx2]",
      title: "Gleipnir",
      group: "Nekomoe kissaten&LoliHouse",
      absolute: [3],
    },
    {
      name: "[Lilith-Raws] No Guns Life - 13 [Baha][WEB-DL][1080p][AVC AAC][CHT][MKV]",
      title: "No Guns Life",
      group: "Lilith-Raws",
      absolute: [13],
    },
    { name: "[Group] 22/7 - 05", title: "22/7", group: "Group", absolute: [5] },
  ]);
});

test("a trailing [Group] tag is never promoted to the title when the name starts with 'Ep.NN' (KaiDubs)", () => {
  check([
    {
      name: "Ep.78 - Even the Universes' Gods are Appalled! The Lose-and-Perish Tournament of Power [Dual Audio] [KaiDubs] [1080p] v2",
      title: "",
      group: "KaiDubs",
      absolute: [78],
    },
    {
      name: "Ep.97 - Survive! The ''Tournament of Power'' Begins At Last!! [Dual Audio] [KaiDubs] [1080p]",
      title: "",
      group: "KaiDubs",
      absolute: [97],
    },
    // Must not change: the same group on a name that has a real title.
    {
      name: "Hunter x Hunter (2011) - 126 - Zero x and x Rose [KaiDubs] [1080p]",
      title: "Hunter x Hunter (2011)",
      group: "KaiDubs",
      absolute: [126],
    },
  ]);
});

test("'Title N SxxEyy' fallback: a sequel whose N equals the episode number is not season 1 of the shorter title (Kaiju No 8, Macross 7)", () => {
  const lib = (tvdbId: number, title: string) => ({ seriesId: tvdbId, tvdbId, title, path: `/a/${tvdbId}`, altTitles: [] });
  const eps = Array.from({ length: 13 }, (_, i) => ({
    id: i + 1,
    season: 1,
    episode: i + 1,
    absolute: i + 1,
    sceneSeason: null,
    sceneEpisode: null,
    sceneAbsolute: null,
    airUtc: 0,
  }));
  const ctx = {
    index: new AliasIndex({ library: [lib(1, "Kaiju No"), lib(2, "Macross")] }),
    now: Date.parse("2026-11-02T00:00:00Z"),
    episodesFor: () => eps,
  };
  // Real corpus names: the number is the sequel's own, and it just happens to equal the episode.
  for (const name of [
    "Kaiju.No.8.S01E08.1080p.BluRay.EAC3.AV1-TiZU",
    "Macross.7.S01E07.Summer.Accident.1080p.DSNP.WEB-DL.AAC2.0.H.264-NTb",
  ]) {
    const r = identify(name, ctx);
    assert.equal(r.candidate, null, `${name}: ${r.summary}`);
  }
});

test("a one-word or all-caps second bracket is the title when only an episode or season marker follows it", () => {
  check([
    { name: "[Group][Frieren] S01E05 [1080p]", title: "Frieren", group: "Group", season: 1, episodes: [5] },
    { name: "[Group] [Naruto] E05", title: "Naruto", group: "Group", absolute: [5] },
    { name: "[Group][BOCCHI THE ROCK] S01E05", title: "BOCCHI THE ROCK", group: "Group", season: 1, episodes: [5] },
    { name: "[Group][Frieren] Season 2 - 05", title: "Frieren", group: "Group", season: 2, episodes: [5] },
    { name: "[Group][Frieren] - S01E05", title: "Frieren", group: "Group", season: 1, episodes: [5] },
    { name: "[Group][Frieren] 2nd Season - 05", title: "Frieren", group: "Group", season: 2, absolute: [5] },
    // Must not change: a tag followed by a real title is still dropped.
    { name: "[Group][SCY] Show Name S01E05", title: "Show Name", group: "Group", season: 1, episodes: [5] },
  ]);
});
