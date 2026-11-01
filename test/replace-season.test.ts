/**
 * Replace season, with mocks and throwaway folders only: the pack replaces each episode only after its new file
 * passed the check; an episode whose new file fails (or is missing from the pack) keeps its old file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-replace-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings } = await import("../server/settings.js");
const { importAndVerify } = await import("../server/pipeline.js");
type Deps = import("../server/pipeline.js").PipelineDeps;
type Row = import("../server/pipeline.js").GrabRow;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-rs-"));
const LIB = path.join(tmp, "lib");
const DL = path.join(tmp, "dl");
const BIN = path.join(tmp, "recycle");
const write = (p: string, s = "x") => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s));
/** A sparse 31 MB file (big enough to count as an episode, no real disk use). */
const big = (p: string) => (write(p), fs.truncateSync(p, 31e6));
const TVDB = 283963;

test("Replace season: verified episodes swap (old file → recycle bin), a failing or missing one keeps its old file", async () => {
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/Anime"],
    importer: { ...s.importer, engine: "animearr", allowReal: true, realBudget: -1, sourceRoots: ["/data/completed/animearr"] },
    localPathMappings: [
      { from: "/media/Anime", to: LIB },
      { from: "/data", to: DL },
      { from: "/media/Recycle", to: BIN },
    ],
    media: { ...s.media, recycleBin: "/media/Recycle/animearr/", renameEpisodes: true, animeEpisodeFormat: "{Series Title} - S{season:00}E{episode:00}" },
    managed: { ...s.managed, dryRun: false },
  }));
  cache.prepare("INSERT INTO series (id, tvdb_id, title, year, series_type, path, monitored, synced_at) VALUES (77, ?, 'Absolute Duo', 2015, 'anime', '/media/Anime/Absolute Duo', 1, 0)").run(TVDB);
  for (const e of [1, 2, 3]) {
    const old = `/media/Anime/Absolute Duo/Season 01/old dub E0${e}.mkv`;
    write(path.join(LIB, "Absolute Duo", "Season 01", `old dub E0${e}.mkv`), `old${e}`);
    cache.prepare("INSERT INTO files (id, series_id, season, path, size) VALUES (?, 77, 1, ?, 4)").run(500 + e, old);
    cache.prepare("INSERT INTO episodes (id, series_id, season, episode, absolute, title, monitored, has_file, file_id, runtime) VALUES (?, 77, 1, ?, ?, ?, 1, 1, ?, 24)").run(700 + e, e, e, `Episode ${e}`, 500 + e);
  }
  // The pack: E01 good, E02 without subtitles (fails), E03 missing.
  const pack = "/data/completed/animearr/[Judas] Absolute Duo (Season 01) (Batch)";
  big(path.join(DL, "completed", "animearr", "[Judas] Absolute Duo (Season 01) (Batch)", "[Judas] Absolute Duo - S01E01.mkv"));
  big(path.join(DL, "completed", "animearr", "[Judas] Absolute Duo (Season 01) (Batch)", "[Judas] Absolute Duo - S01E02.mkv"));
  const now = Date.now();
  const id = Number(
    db
      .prepare("INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, indexer_id, protocol, client, client_ref, state, dry_run, origin, why, candidates, purpose) VALUES (?, ?, ?, 77, ?, ?, 'g', 9, 'torrent', 'qbittorrent', 'h', 'importing', 0, 'manual', 'test', '[]', 'replace')")
      .run(now, now, TVDB, JSON.stringify([701, 702, 703]), "[Judas] Absolute Duo (Season 01) [BD 1080p][Dual-Audio][Eng-Subs] (Batch)").lastInsertRowid,
  );
  const row = db.prepare("SELECT * FROM grabs WHERE id = ?").get(id) as unknown as Row;
  let cleanups = 0;
  const probe = async (p: string) => ({
    durationSec: 1440,
    audio: ["ja", "en"],
    subs: /S01E02/.test(p) ? [] : ["en"],
    sidecars: [],
    untagged: 0,
    forced: [],
  });
  const deps = {
    clients: { addNzb: async () => ({ client: "sabnzbd", ref: "x" }), addTorrent: async () => ({ client: "qbittorrent", ref: "h" }), remove: async () => undefined, status: async () => ({ state: "completed", progress: 1, path: pack }) },
    fetchRelease: async () => ({ data: Buffer.from(""), filename: "x" }),
    sonarr: {
      preview: async (folder: string) => [1, 2].map((e) => ({ path: `${folder}/[Judas] Absolute Duo - S01E0${e}.mkv`, size: 5e8, quality: {}, languages: [] })),
      importFiles: async () => ({ id: 1 }),
      command: async () => ({ id: 1, status: "completed" }),
      episode: async () => ({}),
      episodeFile: async () => ({}),
    },
    probe,
    localPath: (p: string) => p.replace("/data", DL).replace("/media/Anime", LIB),
    sleep: async () => undefined,
    refreshSeries: async () => undefined,
    cleanup: async () => (cleanups++, null),
  } as unknown as Deps;
  await importAndVerify(row, pack, deps);
  const after = db.prepare("SELECT state, error FROM grabs WHERE id = ?").get(id) as { state: string; error: string | null };
  // Episodes kept their old file: the grab waits in "needs attention" (Retry import finishes them once fixed).
  assert.equal(after.state, "needs-attention", after.error ?? "");
  assert.match(after.error ?? "", /2 episodes kept their old file/);
  // E01 swapped: the new file is in the library, the old one is in the recycle bin.
  const season = fs.readdirSync(path.join(LIB, "Absolute Duo", "Season 01"));
  assert.ok(season.includes("Absolute Duo - S01E01.mkv"), season.join(", "));
  assert.ok(!season.includes("old dub E01.mkv"), "E01's old file left the library");
  const binned = fs.readdirSync(BIN, { recursive: true }).map(String);
  assert.ok(binned.some((f) => f.includes("old dub E01.mkv")), `old E01 in the bin: ${binned.join(", ")}`);
  // E02 (failed the check) and E03 (not in the pack) keep their old files.
  assert.ok(season.includes("old dub E02.mkv"));
  assert.ok(season.includes("old dub E03.mkv"));
  const kept = db.prepare("SELECT why FROM decisions WHERE why LIKE 'Replace season: kept the old file%'").get() as { why: string };
  assert.match(kept.why, /S01E02 \(.*no .*subtitles.*\)/);
  assert.match(kept.why, /S01E03 \(not in the pack\)/);
  assert.equal(cleanups, 0, "episodes kept their old file: the download stays for a retry");
});

test("clean-up right after the outcome: an imported torrent goes once seeding is done; nothing when switched off", async () => {
  const { cleanupGrab } = await import("../server/downloads.js");
  const gid = Number(db.prepare("INSERT INTO grabs (at, updated_at, tvdb_id, episode_ids, release, guid, protocol, client, client_ref, state, dry_run, origin) VALUES (0, 0, 1, '[]', 'R', 'g2', 'torrent', 'qbittorrent', 'ABC', 'done', 0, 'manual')").run().lastInsertRowid);
  const removed: string[] = [];
  const torrent = (state: string) => ({ hash: "abc", name: "R", contentPath: "/x", savePath: "/x", size: 1, state, ratio: 0.1, seedingTimeSec: 60, completedOn: Date.now(), ratioLimit: -2, seedingTimeLimitMin: -2 });
  const deps = (state: string) => ({ torrents: async () => [torrent(state)], sab: async () => [], remove: async (j: { ref: string }) => void removed.push(j.ref) });
  patchSettings((s) => ({ ...s, downloads: { ...s.downloads, cleanup: "plan", allowDelete: false } }));
  assert.equal(await cleanupGrab(gid, "imported", deps("stoppedUP") as never), null, "off: nothing");
  patchSettings((s) => ({ ...s, downloads: { ...s.downloads, cleanup: "auto", allowDelete: true } }));
  assert.equal(await cleanupGrab(gid, "imported", deps("uploading") as never), null, "still seeding: left for the sweep");
  assert.match((await cleanupGrab(gid, "imported", deps("stoppedUP") as never)) ?? "", /removed the torrent/);
  assert.deepEqual(removed, ["abc"]);
});


test("Replace season moves on to another season pack only, never to a single episode under the season's ids", async () => {
  const { startGrab } = await import("../server/pipeline.js");
  const sent: string[] = [];
  const deps = {
    clients: {
      addNzb: async () => ({ client: "sabnzbd", ref: "x" }),
      addTorrent: async (_f: unknown, title: string) => {
        sent.push(title);
        if (/BadPack/.test(title)) throw new Error("the client refused it");
        return { client: "qbittorrent", ref: `h-${sent.length}` };
      },
      remove: async () => undefined,
      status: async () => ({ state: "downloading", progress: 0 }),
    },
    fetchRelease: async () => ({ data: Buffer.from(""), filename: "x" }),
    sleep: async () => undefined,
  } as unknown as Deps;
  const c = (title: string, guid: string, episodeIds: number[]) => ({ guid, title, indexerId: 9, indexer: "Nyaa", protocol: "torrent" as const, size: 5e9, downloadUrl: "http://x", label: "S01", group: null, why: "test", episodeIds });
  const all = [701, 702, 703];
  const single = c("[Erai-raws].Absolute.Duo.2nd.Season.02.[1080p][Multiple.Subtitle].mkv", "s1", all); // misread as a pack once
  const single2 = c("[SubsPlease] Absolute Duo - 03 (1080p)", "s2", [703]);
  const r = await startGrab({ tvdbId: TVDB, episodeIds: all, candidate: c("[BadPack] Absolute Duo (Season 01) (Batch)", "p1", all), fallbacks: [single, single2, c("[GoodPack] Absolute Duo (Season 01) [BD] (Batch)", "p2", all)], origin: "manual", purpose: "replace" }, deps);
  assert.equal(r.failed, undefined, r.message);
  assert.deepEqual(sent, ["[BadPack] Absolute Duo (Season 01) (Batch)", "[GoodPack] Absolute Duo (Season 01) [BD] (Batch)"]);
  const stored = db.prepare("SELECT candidates FROM grabs WHERE guid = 'p1'").get() as { candidates: string };
  assert.deepEqual((JSON.parse(stored.candidates) as { guid: string }[]).map((x) => x.guid), ["p2"], "only season packs are kept as fallbacks");
  db.prepare("UPDATE grabs SET state = 'done' WHERE guid IN ('p1', 'p2')").run();

  // Only single episodes left: it stops (and says so) instead of grabbing one episode for the whole season.
  sent.length = 0;
  const r2 = await startGrab({ tvdbId: TVDB, episodeIds: all, candidate: c("[BadPack] Absolute Duo S01 (Batch)", "p3", all), fallbacks: [single, single2], origin: "manual", purpose: "replace" }, deps);
  assert.equal(r2.failed, true);
  assert.deepEqual(sent, ["[BadPack] Absolute Duo S01 (Batch)"]);
  const skip = db.prepare("SELECT why FROM decisions WHERE kind = 'skip' ORDER BY id DESC LIMIT 1").get() as { why: string };
  assert.match(skip.why, /no other season pack to try/);
  // ...and a single episode is refused outright as a whole-season replace.
  await assert.rejects(startGrab({ tvdbId: TVDB, episodeIds: all, candidate: single2, fallbacks: [], origin: "manual", purpose: "replace" }, deps), /needs a season pack/);
});

test("Replace season whose download is one episode stops before touching the library, in plain words", async () => {
  const now = Date.now();
  const rel = "[Erai-raws].Absolute.Duo.2nd.Season.02.[1080p][Multiple.Subtitle].mkv";
  const file = "/data/completed/animearr/[Erai-raws] Absolute Duo - S01E02 [1080p].mkv";
  big(path.join(DL, "completed", "animearr", "[Erai-raws] Absolute Duo - S01E02 [1080p].mkv"));
  const id = Number(
    db
      .prepare("INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, indexer_id, protocol, client, client_ref, state, dry_run, origin, why, candidates, purpose) VALUES (?, ?, ?, 77, ?, ?, 'g-one', 9, 'torrent', 'qbittorrent', 'h1', 'importing', 0, 'manual', 'test', '[]', 'replace')")
      .run(now, now, TVDB, JSON.stringify([701, 702, 703]), rel).lastInsertRowid,
  );
  const row = db.prepare("SELECT * FROM grabs WHERE id = ?").get(id) as unknown as Row;
  const before = fs.readdirSync(path.join(LIB, "Absolute Duo", "Season 01")).sort();
  const deps = {
    clients: { remove: async () => undefined },
    sonarr: { preview: async () => [{ path: file, size: 5e8, quality: {}, languages: [] }] },
    probe: async () => ({ durationSec: 1440, audio: ["ja"], subs: ["en"], sidecars: [], untagged: 0, forced: [] }),
    localPath: (p: string) => p.replace("/data", DL).replace("/media/Anime", LIB),
    sleep: async () => undefined,
  } as unknown as Deps;
  await importAndVerify(row, file, deps);
  const after = db.prepare("SELECT state, error FROM grabs WHERE id = ?").get(id) as { state: string; error: string | null };
  assert.equal(after.state, "needs-attention");
  assert.equal(after.error, "Season 1 replace stopped: the download was only episode 2, not the whole season. Nothing in your library changed.");
  assert.deepEqual(fs.readdirSync(path.join(LIB, "Absolute Duo", "Season 01")).sort(), before);
});

test("two files of a download that look like one episode: a plain message whose fix reviews the whole download", async () => {
  const now = Date.now();
  const folder = "/data/completed/animearr/Absolute Duo dupes";
  const id = Number(
    db
      .prepare("INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, indexer_id, protocol, client, client_ref, state, dry_run, origin, why, candidates) VALUES (?, ?, ?, 77, ?, 'Absolute Duo dupes', 'g-dup', 9, 'torrent', 'qbittorrent', 'h2', 'importing', 0, 'manual', 'test', '[]')")
      .run(now, now, TVDB, JSON.stringify([701, 702])).lastInsertRowid,
  );
  const row = db.prepare("SELECT * FROM grabs WHERE id = ?").get(id) as unknown as Row;
  const deps = {
    clients: { remove: async () => undefined },
    sonarr: { preview: async () => ["[Judas] Absolute Duo - S01E01.mkv", "[Judas] Absolute Duo - S01E01 (alt).mkv", "[Judas] Absolute Duo - S01E02.mkv"].map((n) => ({ path: `${folder}/${n}`, size: 5e8, quality: {}, languages: [] })) },
    localPath: () => null,
    sleep: async () => undefined,
  } as unknown as Deps;
  await importAndVerify(row, folder, deps);
  const after = db.prepare("SELECT state, error FROM grabs WHERE id = ?").get(id) as { state: string; error: string | null };
  assert.equal(after.state, "needs-attention");
  assert.equal(after.error, "two files in this download look like episode 1; review the files to import");
});
