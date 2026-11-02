/** RSS-style new-release watch: a new release for a wanted episode or movie brings its search forward; mocked Prowlarr. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { rssTick } = await import("../server/managed.js");

const FAR = Date.now() + 30 * 86_400_000;
const rel = (title: string, guid: string) =>
  ({
    guid,
    title,
    indexerId: 1,
    indexer: "X",
    protocol: "usenet" as const,
    size: 5e8,
    downloadUrl: "http://x",
    publishDate: new Date().toISOString(),
  }) as never;

before(() => {
  patchSettings((s) => ({ ...s, prowlarr: { ...s.prowlarr, url: "http://prowlarr", apiKey: "k" } }));
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, path, monitored, series_type, synced_at) VALUES (5, 424536, 'Frieren', '/media/Anime/Frieren', 1, 'anime', 0)",
    )
    .run();
  cache
    .prepare(
      "INSERT INTO episodes (id, series_id, season, episode, absolute, monitored, has_file, air_utc) VALUES (501, 5, 1, 5, 5, 1, 0, ?)",
    )
    .run(Date.now() - 86_400_000);
  db.prepare("INSERT INTO search_state (episode_id, tvdb_id, next_at, state, attempts) VALUES (501, 424536, ?, 'gave-up', 12)").run(
    Date.now() - 10 * 3_600_000,
  ); // gave up long ago
  cache
    .prepare(
      "INSERT INTO movies (id, tmdb_id, title, year, path, monitored, has_file, alt_titles, is_anime, synced_at) VALUES (9, 1, 'Suzume', 2022, '/media/Movies/Anime/Suzume (2022)', 1, 0, '[]', 1, 0)",
    )
    .run();
  db.prepare("INSERT INTO movie_search (movie_id, state, next_at) VALUES (9, 'waiting', ?)").run(FAR);
});

test("a new release for a wanted episode or movie brings its search forward (once per release)", async () => {
  const search = async () => [
    rel("[SubsPlease] Frieren - 05 (1080p) [ABCD1234].mkv", "g1"),
    rel("Suzume.2022.1080p.BluRay.x264-GRP", "g2"),
    rel("Other.Show.S01E01.1080p", "g3"),
  ];
  const r = await rssTick(Date.now(), { search } as never);
  assert.equal(r.checked, 3);
  const st = db.prepare("SELECT next_at, state FROM search_state WHERE episode_id = 501").get() as { next_at: number; state: string };
  assert.ok(st.next_at >= Date.now() - 60_000, "searched again now");
  assert.equal(st.state, "retry", "a given-up episode gets another search");
  assert.ok((db.prepare("SELECT next_at FROM movie_search WHERE movie_id = 9").get() as { next_at: number }).next_at < FAR);
  const again = await rssTick(Date.now(), { search } as never);
  assert.equal(again.checked, 0, "already seen");
});

// ---------------------------------------------------------------- files we already have

const { setLock } = await import("../server/qualityLocks.js");
const { searchAll } = await import("../server/indexers.js");
const { invalidateIndex } = await import("../server/metadata.js");

const DAY = 86_400_000;
const hintsOf = () =>
  Object.keys(
    JSON.parse(
      (db.prepare("SELECT value FROM kv WHERE key = 'qualityUpgrade.properHints'").get() as { value: string } | undefined)?.value ?? "{}",
    ),
  ).map(Number);
const seedRecheck = (tvdb: number, season = 1) =>
  db
    .prepare(
      "INSERT OR REPLACE INTO quality_upgrade (tvdb_id, season, state, last_at, attempts, why, updated_at) VALUES (?, ?, 'waiting', ?, 1, 'nothing better yet', 0)",
    )
    .run(tvdb, season, Date.now() - DAY);
const lastAt = (tvdb: number, season = 1) =>
  (db.prepare("SELECT last_at FROM quality_upgrade WHERE tvdb_id = ? AND season = ?").get(tvdb, season) as { last_at: number | null })
    .last_at;
const grabCount = () => (db.prepare("SELECT COUNT(*) AS n FROM grabs").get() as { n: number }).n;

before(() => {
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/AnimeArr"],
    managed: { ...s.managed, dryRun: false },
    media: { ...s.media, recycleBin: "/media/bin" },
    qualityUpgrade: { mode: "auto", paused: false, seasonsPerDay: 5, perHour: 10, recheckDays: 21 },
  }));
  // [series id, tvdb id, title, scene name of each file]
  const shows: [number, number, string, string[]][] = [
    [70, 810001, "Owned Show", ["[SubsPlease] Owned Show - 01 (1080p) [AAAA1111]", "[SubsPlease] Owned Show - 02 (1080p) [AAAA2222]"]],
    [71, 810002, "Locked Show", ["[SubsPlease] Locked Show - 01 (1080p) [BBBB1111]"]],
    [72, 810003, "Goal Show", ["Goal.Show.S01E01.1080p.BluRay.x264-Grp"]],
  ];
  for (const [sid, tvdb, title, scenes] of shows) {
    cache
      .prepare(
        "INSERT INTO series (id, tvdb_id, title, year, path, monitored, series_type, original_language, synced_at) VALUES (?, ?, ?, 2024, ?, 1, 'anime', 'Japanese', 0)",
      )
      .run(sid, tvdb, title, `/media/AnimeArr/${title}`);
    scenes.forEach((scene, i) => {
      const id = sid * 100 + i + 1;
      cache
        .prepare(
          "INSERT INTO files (id, series_id, season, path, scene_name, resolution, audio_langs, sub_langs) VALUES (?, ?, 1, ?, ?, '1920x1080', 'jpn', 'eng')",
        )
        .run(id + 50000, sid, `/media/AnimeArr/${title}/Season 01/${title} - S01E0${i + 1}.mkv`, scene);
      cache
        .prepare(
          "INSERT INTO episodes (id, series_id, season, episode, absolute, monitored, has_file, file_id, air_utc, runtime) VALUES (?, ?, 1, ?, ?, 1, 1, ?, ?, 24)",
        )
        .run(id, sid, i + 1, i + 1, id + 50000, Date.now() - 400 * DAY);
    });
    db.prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (?, ?, ?, 0, 0)").run(tvdb, sid, title);
  }
  setLock(810002, 1, true);
  invalidateIndex();
});

test("a v2 from the same group for a file we have makes that season's version check come now (nothing is grabbed)", async () => {
  seedRecheck(810001);
  const grabs = grabCount();
  const r = await rssTick(Date.now(), {
    search: async () => [rel("[SubsPlease] Owned Show - 01v2 (1080p) [CCCC1111].mkv", "o1")],
  } as never);
  assert.equal(r.upgradeHits, 1);
  assert.equal(lastAt(810001), null, "rechecked on the next pass");
  assert.deepEqual(hintsOf(), [7001], "episode 1 is checked for a newer version");
  assert.equal(grabCount(), grabs);
  const why =
    (db.prepare("SELECT why FROM decisions WHERE tvdb_id = 810001 ORDER BY id DESC LIMIT 1").get() as { why: string } | undefined)?.why ??
    "";
  assert.match(why, /New release seen: .*v2 of the episode you have from SubsPlease/);
});

test("a different group's v2, a locked show and a show with no recycling bin are left alone", async () => {
  seedRecheck(810001);
  seedRecheck(810002);
  const before = hintsOf();
  const r = await rssTick(Date.now(), {
    search: async () => [
      rel("[Erai-raws] Owned Show - 02v2 (1080p) [DDDD1111].mkv", "o2"),
      rel("[SubsPlease] Locked Show - 01v2 (1080p) [EEEE1111].mkv", "o3"),
    ],
  } as never);
  assert.equal(r.upgradeHits, 0);
  assert.notEqual(lastAt(810001), null);
  assert.notEqual(lastAt(810002), null);
  assert.deepEqual(hintsOf(), before);
  patchSettings((s) => ({ ...s, media: { ...s.media, recycleBin: "" } }));
  const none = await rssTick(Date.now(), {
    search: async () => [rel("[SubsPlease] Owned Show - 02v2 (1080p) [FFFF1111].mkv", "o4")],
  } as never);
  assert.equal(none.upgradeHits, 0, "a replacement needs the recycling bin");
  patchSettings((s) => ({ ...s, media: { ...s.media, recycleBin: "/media/bin" } }));
});

test("a Blu-ray for a season below its goal brings its recheck forward; one for a season at its goal does nothing", async () => {
  seedRecheck(810001);
  seedRecheck(810003);
  const grabs = grabCount();
  const r = await rssTick(Date.now(), {
    search: async () => [rel("Owned.Show.S01.1080p.BluRay.x264-Grp", "u1"), rel("Goal.Show.S01E01.1080p.BluRay.x264-Other", "u2")],
  } as never);
  assert.equal(r.upgradeHits, 1);
  assert.equal(lastAt(810001), null);
  assert.notEqual(lastAt(810003), null, "already at the goal");
  assert.equal(grabCount(), grabs, "nothing grabbed from the feed");
});

// ---------------------------------------------------------------- feed coverage

test("the poll asks every Prowlarr indexer for its own newest releases, so a busy one can't crowd out the others", async () => {
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (u: string | URL) => {
    const url = new URL(String(u));
    asked.push(url.pathname + url.search);
    if (url.pathname.endsWith("/indexer"))
      return Response.json([
        { id: 1, name: "Busy", protocol: "usenet", enable: true },
        { id: 2, name: "Quiet", protocol: "torrent", enable: true },
        { id: 3, name: "Off", protocol: "torrent", enable: false },
      ]);
    const id = Number(url.searchParams.get("indexerIds"));
    return Response.json(
      id === 1
        ? [{ guid: "b1", title: "Busy One", indexerId: 1, indexer: "Busy", protocol: "usenet", size: 1 }]
        : [{ guid: "q1", title: "Quiet One", indexerId: 2, indexer: "Quiet", protocol: "torrent", size: 1 }],
    );
  }) as typeof fetch;
  try {
    const rows = await searchAll("", { limit: 100, perIndexer: true });
    assert.deepEqual(rows.map((x) => x.guid).sort(), ["b1", "q1"]);
    const searches = asked.filter((a) => a.includes("/search"));
    assert.equal(searches.length, 2, "one request per enabled indexer");
    assert.ok(searches.every((s) => s.includes("limit=100") && (s.includes("indexerIds=1") || s.includes("indexerIds=2"))));
  } finally {
    globalThis.fetch = realFetch;
  }
  let opts: unknown;
  await rssTick(Date.now(), { search: async (_q: string, o: unknown) => ((opts = o), []) } as never);
  assert.deepEqual(opts, { limit: 100, perIndexer: true });
});
