/**
 * Release details (file_meta) of files AnimeArr imports itself for native shows: written at import, kept through a
 * rename, overwritten by an upgrade, counted for group trust, and backfilled once for older imports.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-test-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { addShow, NATIVE_BASE, rematerializeSeries } = await import("../server/library/native.js");
const { planImport, executeImport, applyRename } = await import("../server/import/importer.js");
const { backfillFileMeta } = await import("../server/library/fileMetaBackfill.js");
const { backfillLearning, learnedFor } = await import("../server/library/library.js");
type AniMedia = import("../server/metadata/anilist.js").AniMedia;

const media = (id: number): AniMedia =>
  ({
    id,
    idMal: null,
    title: { romaji: "Mynoghra", english: "Mynoghra", native: null },
    synonyms: [],
    format: "TV",
    status: "FINISHED",
    episodes: 3,
    duration: 24,
    season: null,
    seasonYear: 2025,
    startDate: { year: 2025, month: 1, day: 1 },
    endDate: { year: 2025, month: 3, day: 1 },
    countryOfOrigin: "JP",
    coverImage: { large: null, color: null },
    bannerImage: null,
    description: "",
    genres: [],
    isAdult: false,
    relations: { edges: [] },
    airingSchedule: {
      nodes: [
        { episode: 1, airingAt: 1735700000 },
        { episode: 2, airingAt: 1736300000 },
        { episode: 3, airingAt: 1736900000 },
      ],
    },
    nextAiringEpisode: null,
    streamingEpisodes: [],
  }) as unknown as AniMedia;
const fribb = async () => ({
  mtime: 0,
  anidbToAnilist: new Map<number, number>(),
  anilistToAnidb: new Map<number, number>(),
  anilistToAnidbAll: new Map<number, number[]>(),
  anilistToTmdb: new Map<number, number>(),
});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-fmeta-"));
const LIB = path.join(tmp, "lib");
const DL = path.join(tmp, "dl");
const probe = async () =>
  ({
    duration: 1440,
    container: "matroska",
    video: { codec: "h264", width: 1920, height: 1080, hdr: false },
    audio: [{ lang: "ja", title: null, codec: "aac", channels: 2, default: true, forced: false }],
    subs: [{ lang: "en", title: null, codec: "ass", default: true, forced: false, partial: false }],
  }) as never;
const write = (p: string, s = "x") => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, s));
const TVDB = NATIVE_BASE + 700;
let sid = 0;
const epId = (n: number) => (cache.prepare("SELECT id FROM episodes WHERE series_id = ? AND episode = ?").get(sid, n) as { id: number }).id;
interface Meta {
  scene_name: string | null;
  release_group: string | null;
  quality: string | null;
  revision: string | null;
}
const meta = (p: string) =>
  db.prepare("SELECT scene_name, release_group, quality, revision FROM file_meta WHERE path = ?").get(p) as Meta | undefined;
const fileRow = (p: string) =>
  cache.prepare("SELECT release_group, scene_name, quality FROM files WHERE path = ?").get(p) as
    { release_group: string | null; scene_name: string | null; quality: string | null } | undefined;
const importOne = async (n: number, srcName: string, release: string, client = "sabnzbd") => {
  write(path.join(DL, "c", srcName));
  const plan = await planImport(
    { tvdbId: TVDB, path: `/data/c/${srcName}`, episodeIds: [epId(n)], release, client },
    { probe, minBytes: 0 },
  );
  const res = await executeImport(plan);
  assert.equal(res[0].done, true, res[0].why);
  rematerializeSeries(sid);
  return plan.items[0].destArr;
};

before(async () => {
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/Anime"],
    localPathMappings: [
      { from: "/media/Anime", to: LIB },
      { from: "/data", to: DL },
      { from: "/media/Recycle", to: path.join(tmp, "bin") },
    ],
    importer: { ...s.importer, allowReal: true, allowRename: true, realBudget: -1 },
    media: {
      ...s.media,
      recycleBin: "/media/Recycle/animearr/",
      episodeTitleRequired: "never",
      animeEpisodeFormat: "{Series TitleYear} - S{season:00}E{episode:00} [{Quality Full}]",
    },
  }));
  await addShow({ anilistId: 700, rootFolder: "/media/Anime" }, { media: async (ids) => ids.map((i) => media(i)), fribb });
  sid = (cache.prepare("SELECT id FROM series WHERE tvdb_id = ?").get(TVDB) as { id: number }).id;
});

test("an import by AnimeArr itself keeps the release details, and the files row shows the group", async () => {
  const release = "[Erai-raws] Mynoghra - 01 [1080p][Multiple Subtitle]";
  const dest = await importOne(1, "m1.mkv", release);
  const m = meta(dest);
  assert.equal(m?.release_group, "Erai-raws");
  assert.equal(m?.scene_name, release);
  assert.match(m?.quality ?? "", /1080p/);
  assert.equal(JSON.parse(m?.revision ?? "{}").version, 1);
  assert.equal(fileRow(dest)?.release_group, "Erai-raws");
  assert.match(fileRow(dest)?.quality ?? "", /1080p/);
});

test("a rename keeps the details with the file; an upgrade at the same path overwrites them", async () => {
  const before = (cache.prepare("SELECT path FROM files WHERE series_id = ?").get(sid) as { path: string }).path;
  patchSettings((s) => ({
    ...s,
    media: { ...s.media, animeEpisodeFormat: "{Series TitleYear} - S{season:00}E{episode:00} - {Quality Full}" },
  }));
  const fid = (cache.prepare("SELECT id FROM files WHERE path = ?").get(before) as { id: number }).id;
  const r = await applyRename(TVDB, [fid]);
  assert.equal(r[0]?.done, true, r[0]?.why);
  rematerializeSeries(sid);
  const after = (cache.prepare("SELECT path FROM files WHERE series_id = ?").get(sid) as { path: string }).path;
  assert.notEqual(after, before);
  assert.equal(meta(before), undefined, "nothing left at the old path");
  assert.equal(meta(after)?.release_group, "Erai-raws");
  assert.equal(fileRow(after)?.release_group, "Erai-raws");
  // An upgrade of episode 1 from another group lands on the same name and replaces the row.
  const dest = await importOne(1, "m1b.mkv", "[VARYG] Mynoghra - 01 (CR WEB-DL 1080p AVC AAC) [AB12CD34]");
  assert.equal(dest, after);
  assert.equal(meta(dest)?.release_group, "VARYG");
  assert.equal(fileRow(dest)?.release_group, "VARYG");
});

test("group counts include AnimeArr's own imports", async () => {
  for (const n of [2, 3]) await importOne(n, `v${n}.mkv`, `[VARYG] Mynoghra - 0${n} (CR WEB-DL 1080p AVC AAC) [AB12CD3${n}]`);
  backfillLearning();
  assert.equal(learnedFor("VARYG", null)?.total, 3, "VARYG: the upgraded episode 1 and episodes 2 and 3");
});

test("the backfill fills older imports from their grab, parses only an unrenamed release name, and leaves the rest empty", () => {
  const dir = "/media/Anime/Mynoghra (2025)/Season 1/";
  const mk = (id: number, name: string) => {
    cache
      .prepare("INSERT INTO files (id, series_id, season, path, size, resolution) VALUES (?, ?, 1, ?, 5, '1920x1080')")
      .run(id, sid, dir + name);
    return dir + name;
  };
  const viaGrab = mk(880_000_001, "AnimeArr renamed name.mkv");
  const noGrab = mk(880_000_002, "Another renamed name.mkv");
  const original = mk(880_000_003, "[ToonsHub] Mynoghra - 01 (1080p WEB-DL).mkv");
  const odd = mk(880_000_004, "something.mkv");
  const grab = db
    .prepare(
      "INSERT INTO grabs (at, updated_at, tvdb_id, episode_ids, release, guid, protocol, state, dry_run) VALUES (1, 1, ?, '[]', ?, 'g', 'torrent', 'imported', 0)",
    )
    .run(TVDB, "[VARYG] Mynoghra - 05 (CR WEB-DL 1080p AVC AAC) [ZZ]").lastInsertRowid;
  const logImport = (dest: string, g: number | null) =>
    db
      .prepare("INSERT INTO decisions (at, kind, tvdb_id, title, why, detail) VALUES (1, 'import', ?, 'Mynoghra', 'Imported x', ?)")
      .run(TVDB, JSON.stringify({ dest, ...(g ? { grabId: g } : {}) }));
  logImport(viaGrab, Number(grab));
  logImport(noGrab, null);
  backfillFileMeta();
  assert.equal(meta(viaGrab)?.release_group, "VARYG");
  assert.match(meta(viaGrab)?.scene_name ?? "", /^\[VARYG\]/);
  assert.equal(meta(noGrab), undefined, "renamed by AnimeArr and no grab: unknown stays empty");
  assert.equal(meta(original)?.release_group, "ToonsHub");
  assert.equal(meta(odd), undefined, "no recognisable group: unknown stays empty");
  assert.equal(backfillFileMeta(), 0, "a second run changes nothing");
});
