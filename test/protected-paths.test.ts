/**
 * Blind review H3 + L11: an import source, and a clean-up delete, may never be a protected folder (library or allowed
 * root, the recycling bin, AnimeArr's own folder), be inside one, or CONTAIN one; compared by real path, so a ".." or a
 * link that escapes is caught too.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-prot-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { planImport } = await import("../server/import/importer.js");
const { runCleanup } = await import("../server/grabs/downloads.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-prot-f-"));
const MEDIA = path.join(tmp, "media");
const LIB = path.join(MEDIA, "AnimeArr");
const DL = path.join(tmp, "dl");
const OWN = path.join(DL, "completed", "animearr");
const write = (p: string, s = "x") => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s));
const OTHER = path.join(LIB, "Other Show", "Season 01", "Other Show - S01E01.mkv");
const probe = async () =>
  ({
    duration: 1440,
    container: "matroska",
    video: { codec: "h264", width: 1920, height: 1080, hdr: false },
    audio: [{ lang: "ja", title: null, codec: "aac", channels: 2, default: true, forced: false }],
    subs: [{ lang: "en", title: null, codec: "ass", default: true, forced: false, partial: false }],
  }) as never;

before(() => {
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, year, series_type, path, root_folder, monitored, synced_at) VALUES (10, 424536, 'Frieren', 2023, 'anime', '/media/AnimeArr/Frieren (2023)', '/media/AnimeArr', 1, 0)",
    )
    .run();
  cache
    .prepare(
      "INSERT INTO episodes (id, series_id, season, episode, absolute, title, monitored, has_file) VALUES (105, 10, 1, 5, 5, 'Five', 1, 0)",
    )
    .run();
  write(OTHER, "another show's episode");
  fs.mkdirSync(path.join(LIB, "Frieren (2023)"), { recursive: true });
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/AnimeArr"],
    localPathMappings: [
      { from: "/media", to: MEDIA },
      { from: "/data", to: DL },
    ],
    importer: { ...s.importer, sourceRoots: ["/data/completed/animearr"] },
    sabnzbd: { ...s.sabnzbd, category: "animearr" },
    downloads: { ...s.downloads, allowDelete: true },
    media: { ...s.media, recycleBin: "/media/Recycle/animearr", skipFreeSpaceCheck: true },
  }));
});

const refused = (p: string) =>
  assert.rejects(
    planImport({ tvdbId: 424536, path: p, episodeIds: [105] }, { probe, minBytes: 0 }),
    /not from the library, the recycling bin or AnimeArr's own folder/,
    p,
  );

test("an import from a folder that holds the library (its parent) is refused; no library file is touched", async () => {
  await refused("/media");
  assert.equal(fs.readFileSync(OTHER, "utf8"), "another show's episode");
});

test("an import from the library itself, or from inside it, is refused", async () => {
  await refused("/media/AnimeArr");
  await refused("/media/AnimeArr/Other Show/Season 01/Other Show - S01E01.mkv");
});

test("a '..' path or a link that escapes into the library's parent is refused (real paths compared)", async () => {
  await refused("/data/../media");
  fs.mkdirSync(OWN, { recursive: true });
  fs.symlinkSync(MEDIA, path.join(OWN, "escape"), "junction");
  await refused("/data/completed/animearr/escape");
});

test("a folder that holds the recycling bin or AnimeArr's own folder is refused", async () => {
  patchSettings((s) => ({ ...s, media: { ...s.media, recycleBin: "/data/completed/animearr/old-bin" } }));
  write(path.join(OWN, "Frieren.S01E05.1080p.WEB-DL-GRP.mkv"), "new 5");
  await refused("/data/completed/animearr");
  patchSettings((s) => ({ ...s, media: { ...s.media, recycleBin: "/media/Recycle/animearr" } }));
  const conf = process.env.ANIMEARR_CONFIG!;
  patchSettings((s) => ({ ...s, localPathMappings: [...s.localPathMappings, { from: "/cfgparent", to: path.dirname(conf) }] }));
  await refused("/cfgparent");
});

test("a normal import from AnimeArr's download folder still plans", async () => {
  const plan = await planImport(
    { tvdbId: 424536, path: "/data/completed/animearr/Frieren.S01E05.1080p.WEB-DL-GRP.mkv", episodeIds: [105] },
    { probe, minBytes: 0 },
  );
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].problem, null);
});

test("L11: a clean-up delete aimed at a protected folder is refused, and the folder stays", async () => {
  // A library folder that sits inside AnimeArr's download folder, reported by SABnzbd as a finished download.
  const libInDl = path.join(OWN, "Shows");
  write(path.join(libInDl, "keep.txt"), "the user's file");
  patchSettings((s) => ({ ...s, allowedRoots: ["/media/AnimeArr", "/data/completed/animearr/Shows"] }));
  db.prepare(
    "INSERT INTO grabs (at, updated_at, tvdb_id, episode_ids, release, guid, protocol, client, client_ref, state, dry_run) VALUES (1, 1, 1, '[]', 'Shows', 'g9', 'usenet', 'sabnzbd', 'SAB_9', 'done', 0)",
  ).run();
  const res = await runCleanup({}, {
    torrents: async () => [],
    sab: async () => [{ nzoId: "SAB_9", storage: "/data/completed/animearr/Shows", status: "Completed" }],
    remove: async () => undefined,
  } as never);
  const step = res.find((r) => r.action.target === "/data/completed/animearr/Shows");
  assert.ok(step, `the clean-up planned it: ${JSON.stringify(res.map((r) => r.action.target))}`);
  assert.equal(step!.ok, false);
  assert.match(step!.why, /protected|library/);
  assert.equal(fs.readFileSync(path.join(libInDl, "keep.txt"), "utf8"), "the user's file");
});
