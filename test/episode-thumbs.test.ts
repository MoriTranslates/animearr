/** Episode descriptions and thumbnails: TMDB through the entry's season/offset mapping, Sonarr as the fallback, a video
 * frame only when asked for, a season fetched once, and only AnimeArr's own thumbnails ever replaced or removed
 * (mocked fetch, Sonarr, ffmpeg and image downloads). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { patchSettings } = await import("../server/system/settings.js");
const { cache, db } = await import("../server/system/db.js");
const { syncSeriesMetadata, syncSeriesFiles, realWriteDeps } = await import("../server/mediaout.js");
const { tmdbTarget } = await import("../server/metadata/metaoverride.js");

const THUMB = Buffer.from("tmdb-picture");
const old = Date.now() - 3600_000;
/** media_thumbs keeps the paths the way the library gives them (forward slashes). */
const row = (p: string) =>
  db.prepare("SELECT source FROM media_thumbs WHERE path = ?").get(p.split(String.fromCharCode(92)).join("/")) as
    { source: string } | undefined;

test("TMDB mapping: the entry's season and offset pick the TMDB episode; specials and unmapped entries get none", () => {
  const rows = [{ tvdb_season: "2", tvdb_offset: 0, episodes: 12, tmdb_tv: 100, tmdb_season: 1, tmdb_offset: 12 }];
  assert.deepEqual(tmdbTarget(rows, 2, 3, null), { tv: 100, season: 1, episode: 15 }, "S2E3 is TMDB season 1 episode 15 (split cour)");
  assert.equal(tmdbTarget(rows, 2, 13, null), null, "past the entry's episode count");
  assert.equal(tmdbTarget(rows, 3, 1, null), null, "another season");
  assert.equal(tmdbTarget(rows, 0, 1, null), null, "specials aren't guessed");
  assert.deepEqual(
    tmdbTarget([{ ...rows[0], tvdb_season: "a", tvdb_offset: 24 }], 1, 1, 27),
    { tv: 100, season: 1, episode: 15 },
    "absolute numbering",
  );
  assert.equal(tmdbTarget([{ ...rows[0], tmdb_tv: null }], 2, 3, null), null);
});

test("sources: TMDB first, Sonarr when TMDB has nothing, one season fetch; the user's thumbnail stays; ours follows a rename and goes with its video", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-thumbs-"));
  const r = root.replace(/\\/g, "/");
  const season = path.join(root, "Show (2024)", "Season 02");
  fs.mkdirSync(season, { recursive: true });
  const vid = (n: number) => path.join(season, `Show - S02E0${n}.mkv`);
  for (const n of [3, 4, 5]) fs.writeFileSync(vid(n), "x");
  fs.writeFileSync(path.join(season, "Show - S02E05-thumb.jpg"), "users own picture");
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, tmdb_id, title, year, status, path, root_folder, monitored, synced_at) VALUES (88, 5001, 100, 'Show', 2024, 'continuing', ?, ?, 1, 0)",
    )
    .run(`${r}/Show (2024)`, r);
  for (const n of [3, 4, 5]) {
    cache
      .prepare("INSERT INTO files (id, series_id, season, path) VALUES (?, 88, 2, ?)")
      .run(880 + n, `${r}/Show (2024)/Season 02/Show - S02E0${n}.mkv`);
    cache
      .prepare(
        "INSERT INTO episodes (id, series_id, season, episode, absolute, title, air_date, monitored, has_file, file_id) VALUES (?, 88, 2, ?, ?, ?, '2024-01-01', 1, 1, ?)",
      )
      .run(8800 + n, n, n, `Ep ${n}`, 880 + n);
  }
  db.prepare(
    "INSERT INTO entries (anilist_id, tvdb_id, tvdb_season, tvdb_offset, tmdb_tv, tmdb_season, tmdb_offset, fetched_at) VALUES (9001, 5001, '2', 0, 100, 1, 12, 0)",
  ).run();
  patchSettings((s) => ({
    ...s,
    allowedRoots: [r],
    metadata: { ...s.metadata, tmdbKey: "test-tmdb-key" },
    sonarr: { ...s.sonarr, url: "http://sonarr:8989", apiKey: "k" },
    mediaOutput: { main: "jellyfin", nfo: true, plexmatch: false, artwork: true, episodeThumbs: true, episodeThumbsFromVideo: false },
  }));

  const images: string[] = [];
  const fetched: string[] = [];
  let sonarrCalls = 0;
  const deps = {
    ...realWriteDeps,
    image: async (u: string) => (images.push(u), { data: u.includes("tmdb") ? THUMB : Buffer.from("sonarr-picture"), ext: "jpg" }),
  };
  const meta = {
    fetch: (async (u: string) => {
      fetched.push(String(u));
      return new Response(
        JSON.stringify({
          episodes: [
            { episode_number: 15, overview: "Fifteen & more", still_path: "/s15.jpg" },
            { episode_number: 16, overview: "", still_path: null },
            { episode_number: 17, overview: "Seventeen", still_path: "/s17.jpg" },
          ],
        }),
      );
    }) as unknown as typeof fetch,
    sleep: async () => undefined,
    sonarrEpisodes: async () => (
      sonarrCalls++,
      [
        {
          id: 1,
          seriesId: 88,
          seasonNumber: 2,
          episodeNumber: 4,
          overview: "Sonarr four",
          images: [{ coverType: "screenshot", remoteUrl: "https://artworks.thetvdb.com/banners/ep4.jpg" }],
          monitored: true,
          hasFile: true,
        },
      ]
    ),
    now: () => Date.now(),
  };

  const c = await syncSeriesMetadata(5001, deps, meta);
  assert.ok(c);
  assert.equal(fetched.length, 1, "one TMDB request for the whole season");
  assert.match(fetched[0], /\/tv\/100\/season\/1\?/);
  assert.deepEqual(
    images.sort(),
    ["https://artworks.thetvdb.com/banners/ep4.jpg", "https://image.tmdb.org/t/p/w780/s15.jpg"].sort(),
    "TMDB w780 still, Sonarr for the one TMDB had no picture for; nothing downloaded for the user's own",
  );
  assert.equal(c.thumbs, 2, "E03 and E04; E05 has the user's own");
  assert.equal(c.thumbsSkipped, 1);
  assert.equal(fs.readFileSync(path.join(season, "Show - S02E03-thumb.jpg")).toString(), "tmdb-picture");
  assert.equal(fs.readFileSync(path.join(season, "Show - S02E04-thumb.jpg")).toString(), "sonarr-picture");
  assert.equal(
    fs.readFileSync(path.join(season, "Show - S02E05-thumb.jpg"), "utf8"),
    "users own picture",
    "a thumbnail AnimeArr didn't write is never touched",
  );
  assert.equal(row(path.join(season, "Show - S02E03-thumb.jpg"))?.source, "tmdb");
  assert.equal(row(path.join(season, "Show - S02E05-thumb.jpg")), undefined);
  // The plot is in the NFO (TMDB, then Sonarr's).
  assert.match(fs.readFileSync(vid(3).replace(/\.mkv$/, ".nfo"), "utf8"), /<plot>Fifteen &amp; more<\/plot>/);
  assert.match(fs.readFileSync(vid(4).replace(/\.mkv$/, ".nfo"), "utf8"), /<plot>Sonarr four<\/plot>/);
  assert.equal(sonarrCalls, 1);

  // Again: the season comes from the cache, nothing is downloaded or rewritten.
  const again = await syncSeriesMetadata(5001, deps, meta);
  assert.equal(fetched.length, 1, "the cached season isn't fetched again");
  assert.equal(images.length, 2);
  assert.equal(again?.thumbs, 0);
  assert.equal(again?.written, 0);

  // The video is renamed: our thumbnail moves with it, no download.
  const renamed = path.join(season, "Show - S02E03 - Fifteen.mkv");
  fs.renameSync(vid(3), renamed);
  cache.prepare("UPDATE files SET path = ? WHERE id = 883").run(`${r}/Show (2024)/Season 02/Show - S02E03 - Fifteen.mkv`);
  const moved = await syncSeriesMetadata(5001, deps, meta);
  assert.equal(fs.existsSync(path.join(season, "Show - S02E03-thumb.jpg")), false);
  assert.equal(fs.readFileSync(path.join(season, "Show - S02E03 - Fifteen-thumb.jpg")).toString(), "tmdb-picture");
  assert.equal(images.length, 2, "moved, not fetched again");
  assert.equal(moved?.thumbs, 1);
  assert.equal(row(path.join(season, "Show - S02E03-thumb.jpg")), undefined);

  // A video deleted: its thumbnail goes (the user's stays with its own video).
  fs.unlinkSync(vid(4));
  cache.prepare("DELETE FROM files WHERE id = 884").run();
  cache.prepare("DELETE FROM episodes WHERE id = 8804").run();
  await syncSeriesMetadata(5001, deps, meta);
  assert.equal(fs.existsSync(path.join(season, "Show - S02E04-thumb.jpg")), false);
  assert.equal(row(path.join(season, "Show - S02E04-thumb.jpg")), undefined);
  assert.ok(fs.existsSync(path.join(season, "Show - S02E05-thumb.jpg")));

  // Thumbnails off: nothing new is written, but AnimeArr's cleanup still runs for the ones it owns.
  patchSettings((s) => ({ ...s, mediaOutput: { ...s.mediaOutput, episodeThumbs: false } }));
  fs.unlinkSync(renamed);
  cache.prepare("DELETE FROM files WHERE id = 883").run();
  cache.prepare("DELETE FROM episodes WHERE id = 8803").run();
  await syncSeriesMetadata(5001, deps, meta);
  assert.equal(
    fs.existsSync(path.join(season, "Show - S02E03 - Fifteen-thumb.jpg")),
    false,
    "removed with its video even when the option is off",
  );
});

test("fallback order: no picture anywhere -> a video frame only when switched on, never for a file that is still settling", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-frame-")).split(String.fromCharCode(92)).join("/");
  const v1 = `${dir}/Other - S01E01.mkv`;
  const v2 = `${dir}/Other - S01E02.mkv`;
  fs.writeFileSync(v1, "x");
  fs.writeFileSync(v2, "x");
  const frames: [string, number][] = [];
  let mtime = old;
  const deps = {
    ...realWriteDeps,
    image: async () => null,
    frame: async (p: string, at: number) => (frames.push([p, at]), Buffer.from("frame")),
    mtime: () => mtime,
  };
  const out = (importing = false) => ({
    show: { title: "Other", ids: { tvdb: 1 } },
    folder: dir,
    importing,
    files: [
      { path: v1, durationSec: 1200, episodes: [{ season: 1, episode: 1 }] },
      { path: v2, episodes: [{ season: 1, episode: 2, runtime: 24 }] },
    ],
  });
  const off = await syncSeriesFiles(out(), { nfo: false, plexmatch: false, artwork: true, thumbs: true, thumbsFromVideo: false }, deps);
  assert.equal(off.thumbs, 0);
  assert.equal(off.thumbsMissing, 2);
  assert.equal(frames.length, 0, "no frames unless asked for");
  mtime = Date.now();
  const fresh = await syncSeriesFiles(out(), { nfo: false, plexmatch: false, artwork: true, thumbs: true, thumbsFromVideo: true }, deps);
  assert.equal(fresh.thumbs, 0, "a file written minutes ago may still be importing");
  mtime = old;
  const busy = await syncSeriesFiles(out(true), { nfo: false, plexmatch: false, artwork: true, thumbs: true, thumbsFromVideo: true }, deps);
  assert.equal(busy.thumbs, 0, "a show being imported right now is left alone");
  assert.equal(frames.length, 0);
  const on = await syncSeriesFiles(out(), { nfo: false, plexmatch: false, artwork: true, thumbs: true, thumbsFromVideo: true }, deps);
  assert.equal(on.thumbs, 2);
  assert.deepEqual(
    frames,
    [
      [v1, 400],
      [v2, 480],
    ],
    "a third of the way in (the scanned length, else the runtime)",
  );
  assert.equal(fs.readFileSync(v1.replace(/\.mkv$/, "-thumb.jpg"), "utf8"), "frame");
  assert.equal(row(v1.replace(/\.mkv$/, "-thumb.jpg"))?.source, "video");
  // A later real picture replaces a frame of ours (and only ours).
  const better = out();
  better.files[0].episodes[0] = { season: 1, episode: 1, still: "https://image.tmdb.org/t/p/w780/a.jpg", stillSource: "tmdb" } as never;
  const up = await syncSeriesFiles(
    better,
    { nfo: false, plexmatch: false, artwork: true, thumbs: true },
    { ...deps, image: async () => ({ data: Buffer.from("real"), ext: "jpg" }) },
  );
  assert.equal(up.thumbs, 1);
  assert.equal(fs.readFileSync(v1.replace(/\.mkv$/, "-thumb.jpg"), "utf8"), "real");
});
