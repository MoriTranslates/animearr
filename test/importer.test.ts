/**
 * AnimeArr's own importer and renamer, on throwaway folders only (never a real library): plans, gates, collisions,
 * hardlink vs move, sidecars, the recycle bin, renames with undo, and Sonarr/Radarr settings mapping.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/db.js");
const { patchSettings, getSettings } = await import("../server/settings.js");
const { planImport, executeImport, planRename, applyRename, renameBack } = await import("../server/importer.js");
const { mapArrMedia } = await import("../server/mediadefaults.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-imp-"));
const LIB = path.join(tmp, "lib");
const DL = path.join(tmp, "dl");
const BIN = path.join(tmp, "recycle");
const probe = async () => ({ duration: 1440, container: "matroska", video: { codec: "h264", width: 1920, height: 1080, hdr: false }, audio: [{ lang: "ja", title: null, codec: "aac", channels: 2, default: true, forced: false }], subs: [{ lang: "en", title: null, codec: "ass", default: true, forced: false, partial: false }] }) as never;
const write = (p: string, s = "x") => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s));

before(() => {
  fs.mkdirSync(path.join(LIB, "Frieren (2023)"), { recursive: true });
  cache.prepare("INSERT INTO series (id, tvdb_id, title, year, series_type, path, monitored, synced_at) VALUES (10, 424536, 'Frieren: Beyond Journey''s End', 2023, 'anime', '/media/AnimeArr/Frieren (2023)', 1, 0)").run();
  for (const [id, e, t] of [[101, 1, "The Journey's End"], [102, 2, "It Didn't Have to Be Magic..."], [103, 3, "Killing Magic"]] as const)
    cache.prepare("INSERT INTO episodes (id, series_id, season, episode, absolute, title, monitored, has_file) VALUES (?, 10, 1, ?, ?, ?, 1, 0)").run(id, e, e, t);
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/AnimeArr"],
    localPathMappings: [
      { from: "/media/AnimeArr", to: LIB },
      { from: "/data", to: DL },
      { from: "/media/Recycle", to: BIN },
    ],
    media: { ...s.media, recycleBin: "/media/Recycle/animearr/", animeEpisodeFormat: "{Series TitleYear} - S{season:00}E{episode:00} - {absolute:000} - {Episode CleanTitle} [{Quality Full}]{-Release Group}" },
  }));
});

test("plans an import: name from the naming settings, hardlink for torrents, sidecars along, nothing changed", async () => {
  write(path.join(DL, "completed", "[SubsPlease] Sousou no Frieren - 01 (1080p).mkv"));
  write(path.join(DL, "completed", "[SubsPlease] Sousou no Frieren - 01 (1080p).en.ass"));
  const plan = await planImport({ tvdbId: 424536, path: "/data/completed/[SubsPlease] Sousou no Frieren - 01 (1080p).mkv", episodeIds: [101], release: "[SubsPlease] Sousou no Frieren - 01 (1080p) [WEB]", client: "qbittorrent" }, { probe, minBytes: 0 });
  assert.equal(plan.items.length, 1);
  const it = plan.items[0];
  assert.equal(it.problem, null);
  assert.equal(it.action, "hardlink");
  assert.equal(it.destArr, "/media/AnimeArr/Frieren (2023)/Season 01/Frieren - Beyond Journey's End (2023) - S01E01 - 001 - The Journeys End [WEBDL-1080p]-SubsPlease.mkv");
  assert.equal(it.sidecars.length, 1);
  assert.match(it.sidecars[0].dest, /\[WEBDL-1080p\]-SubsPlease\.en\.ass$/);
  assert.equal(fs.existsSync(it.dest), false);
  // Dry run reports only; a real run is refused until switched on.
  const dry = await executeImport(plan, { dryRun: true });
  assert.match(dry[0].why, /^would hardlink/);
  await assert.rejects(executeImport(plan), /aren't switched on/);
  assert.equal(fs.existsSync(it.dest), false);
});

test("a real import hardlinks (torrent keeps seeding), brings the sidecar, and never overwrites another file", async () => {
  patchSettings((s) => ({ ...s, importer: { ...s.importer, allowReal: true } }));
  const src = path.join(DL, "completed", "[SubsPlease] Sousou no Frieren - 01 (1080p).mkv");
  const plan = await planImport({ tvdbId: 424536, path: "/data/completed/[SubsPlease] Sousou no Frieren - 01 (1080p).mkv", episodeIds: [101], release: "[SubsPlease] Sousou no Frieren - 01 (1080p) [WEB]", client: "qbittorrent" }, { probe, minBytes: 0 });
  const res = await executeImport(plan);
  assert.equal(res[0].done, true, res[0].why);
  assert.ok(fs.existsSync(src), "the torrent's file stays");
  assert.ok(fs.existsSync(plan.items[0].dest));
  assert.ok(fs.existsSync(plan.items[0].sidecars[0].dest));
  // Same target again, but it isn't the episode's recorded file: a collision, skipped.
  const again = await planImport({ tvdbId: 424536, path: "/data/completed/[SubsPlease] Sousou no Frieren - 01 (1080p).mkv", episodeIds: [101], release: "[SubsPlease] Sousou no Frieren - 01 (1080p) [WEB]", client: "qbittorrent" }, { probe, minBytes: 0 });
  assert.match(again.items[0].problem ?? "", /never overwritten/);
  patchSettings((s) => ({ ...s, importer: { ...s.importer, allowReal: false } }));
});

test("an upgrade sends the old file to the recycle bin; Usenet moves", async () => {
  patchSettings((s) => ({ ...s, importer: { ...s.importer, allowReal: true } }));
  const old = path.join(LIB, "Frieren (2023)", "Season 01", "old ep2.mkv");
  write(old, "old");
  cache.prepare("INSERT INTO files (id, series_id, season, path) VALUES (502, 10, 1, '/media/AnimeArr/Frieren (2023)/Season 01/old ep2.mkv')").run();
  cache.prepare("UPDATE episodes SET file_id = 502, has_file = 1 WHERE id = 102").run();
  write(path.join(DL, "usenet", "Frieren.S01E02.1080p.WEB-DL-GRP.mkv"), "new");
  const plan = await planImport({ tvdbId: 424536, path: "/data/usenet/Frieren.S01E02.1080p.WEB-DL-GRP.mkv", episodeIds: [102], release: "Frieren.S01E02.1080p.WEB-DL-GRP", client: "sabnzbd" }, { probe, minBytes: 0 });
  assert.equal(plan.items[0].action, "move");
  assert.equal(plan.items[0].replaces && path.resolve(plan.items[0].replaces), path.resolve(old));
  const res = await executeImport(plan);
  assert.equal(res[0].done, true, res[0].why);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.readFileSync(path.join(BIN, "animearr", "Frieren (2023)", "Season 01", "old ep2.mkv"), "utf8"), "old");
  assert.equal(fs.existsSync(path.join(DL, "usenet", "Frieren.S01E02.1080p.WEB-DL-GRP.mkv")), false, "moved");
  patchSettings((s) => ({ ...s, importer: { ...s.importer, allowReal: false } }));
});

test("a file that also holds other episodes isn't replaced automatically", async () => {
  cache.prepare("INSERT INTO files (id, series_id, season, path) VALUES (503, 10, 1, '/media/AnimeArr/Frieren (2023)/Season 01/ep3-4.mkv')").run();
  cache.prepare("INSERT INTO episodes (id, series_id, season, episode, absolute, title, monitored, has_file, file_id) VALUES (104, 10, 1, 4, 4, 'The Land Where Souls Rest', 1, 1, 503)").run();
  cache.prepare("UPDATE episodes SET file_id = 503, has_file = 1 WHERE id = 103").run();
  write(path.join(DL, "x", "Frieren.S01E03.mkv"));
  const plan = await planImport({ tvdbId: 424536, path: "/data/x/Frieren.S01E03.mkv", episodeIds: [103], client: "sabnzbd" }, { probe, minBytes: 0 });
  assert.match(plan.items[0].problem ?? "", /other episodes/);
});

test("rename: plans old → new, is gated, renames with sidecars, and undo puts it back", async () => {
  const dir = path.join(LIB, "Frieren (2023)", "Season 01");
  write(path.join(dir, "frieren 4.mkv"));
  write(path.join(dir, "frieren 4.en.srt"));
  cache.prepare("INSERT INTO files (id, series_id, season, path, scene_name, quality, revision) VALUES (504, 10, 1, '/media/AnimeArr/Frieren (2023)/Season 01/frieren 4.mkv', '[Erai-raws] Sousou no Frieren - 04 [1080p][WEB]', 'WEBDL-1080p', ?)").run(JSON.stringify({ version: 2 }));
  cache.prepare("UPDATE episodes SET file_id = 504 WHERE id = 104").run();
  db.prepare("INSERT INTO media_files (path, root, size, mtime, video, audio, subs, seen_at) VALUES (?, '/media/AnimeArr', 1, 1, ?, '[]', '[]', 1)").run("/media/AnimeArr/Frieren (2023)/Season 01/frieren 4.mkv", JSON.stringify({ codec: "h264", width: 1920, height: 1080, hdr: false, bitDepth: 8 }));
  const items = planRename(424536).items.filter((i) => i.fileId === 504);
  assert.equal(items.length, 1);
  assert.equal(items[0].to, "/media/AnimeArr/Frieren (2023)/Season 01/Frieren - Beyond Journey's End (2023) - S01E04 - 004 - The Land Where Souls Rest [WEBDL-1080p v2]-Erai-raws.mkv");
  await assert.rejects(applyRename(424536, [504]), /isn't switched on/);
  patchSettings((s) => ({ ...s, importer: { ...s.importer, allowRename: true } }));
  const res = await applyRename(424536, [504]);
  assert.equal(res[0].done, true, res[0].why);
  const newer = path.join(dir, "Frieren - Beyond Journey's End (2023) - S01E04 - 004 - The Land Where Souls Rest [WEBDL-1080p v2]-Erai-raws.mkv");
  assert.ok(fs.existsSync(newer));
  assert.ok(fs.existsSync(newer.replace(/\.mkv$/, ".en.srt")));
  await renameBack({ tvdbId: 424536, from: newer, to: path.join(dir, "frieren 4.mkv"), sidecars: [{ from: newer.replace(/\.mkv$/, ".en.srt"), to: path.join(dir, "frieren 4.en.srt") }] });
  assert.ok(fs.existsSync(path.join(dir, "frieren 4.mkv")));
  assert.ok(fs.existsSync(path.join(dir, "frieren 4.en.srt")));
  patchSettings((s) => ({ ...s, importer: { ...s.importer, allowRename: false } }));
});

test("imports never come from the library or AnimeArr's own folder; no bin = no replacing", async () => {
  await assert.rejects(planImport({ tvdbId: 424536, path: "/media/AnimeArr/Frieren (2023)/Season 01/frieren 4.mkv", episodeIds: [104] }, { probe, minBytes: 0 }), /not from the library/);
  write(path.join(DL, "x", "notes.txt"));
  await assert.rejects(planImport({ tvdbId: 424536, path: "/data/x/notes.txt", episodeIds: [101] }, { probe, minBytes: 0 }), /isn't a video/);
  patchSettings((s) => ({ ...s, media: { ...s.media, recycleBin: "" } }));
  write(path.join(LIB, "Frieren (2023)", "Season 01", "ep1 old.mkv"));
  cache.prepare("INSERT INTO files (id, series_id, season, path) VALUES (505, 10, 1, '/media/AnimeArr/Frieren (2023)/Season 01/ep1 old.mkv')").run();
  cache.prepare("UPDATE episodes SET file_id = 505 WHERE id = 101").run();
  write(path.join(DL, "y", "Frieren.S01E01.v2.mkv"));
  const plan = await planImport({ tvdbId: 424536, path: "/data/y/Frieren.S01E01.v2.mkv", episodeIds: [101], client: "sabnzbd" }, { probe, minBytes: 0 });
  assert.match(plan.items[0].problem ?? "", /no recycling bin/);
  patchSettings((s) => ({ ...s, media: { ...s.media, recycleBin: "/media/Recycle/animearr/" } }));
});

test("Sonarr/Radarr settings map onto media management (int or string enums)", () => {
  const m = mapArrMedia(getSettings().media, { colonReplacementFormat: 1, multiEpisodeStyle: 0, animeEpisodeFormat: "{Series Title} - {absolute:000}", renameEpisodes: true }, { copyUsingHardlinks: false, downloadPropersAndRepacks: "doNotPrefer", chmodFolder: "755", minimumFreeSpaceWhenImporting: 200 }, { standardMovieFormat: "{Movie Title} ({Release Year})" });
  assert.equal(m.colonReplacement, "dash");
  assert.equal(m.multiEpisodeStyle, "extend");
  assert.equal(m.animeEpisodeFormat, "{Series Title} - {absolute:000}");
  assert.equal(m.useHardlinks, false);
  assert.equal(m.propers, "doNotPrefer");
  assert.equal(m.chmodFolder, "755");
  assert.equal(m.minimumFreeSpaceMb, 200);
  assert.equal(m.movieFormat, "{Movie Title} ({Release Year})");
  assert.equal(mapArrMedia(m, { colonReplacementFormat: "smart" }, null, null).colonReplacement, "smart");
});
