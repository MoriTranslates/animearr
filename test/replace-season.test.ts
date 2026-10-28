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

