/**
 * Creditless openings/endings and extras folders in a season download (seen live: "[IK] Toaru Kagaku no Railgun S",
 * a Replace season that stopped on "two files look like the same episode"): "NCED Ep11" is never episode 11, files in
 * "NCED & NCOP/" are never regular episodes, and the hand import's checks only count the files the user picked.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-ncx-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache } = await import("../server/system/db.js");
const { patchSettings } = await import("../server/system/settings.js");
const { planImport } = await import("../server/importer.js");
const { identify } = await import("../server/core/identify.js");
const { identifyContext } = await import("../server/search.js");
const { inExtrasFolder } = await import("../server/core/resolver.js");
const { fixesFor } = await import("../server/system/fixes.js");
const { attentionSummary } = await import("../server/system/summary.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-ncx-"));
const LIB = path.join(tmp, "lib");
const DL = path.join(tmp, "dl");
const TVDB = 700100;
const PACK = "[IK] Toaru Kagaku no Railgun S (BD 1920x1080 Hi10 FLAC)";
const ROOT = path.join(DL, "completed", "animearr", PACK);
const NC = "NCED & NCOP";
const ep = (n: number) => `[IK] Toaru Kagaku no Railgun S - ${String(n).padStart(2, "0")} (BD 1920x1080 Hi10 FLAC).mkv`;
const NCED11 = "[IK] Toaru Kagaku no Railgun S - NCED Ep11 (BD 1920x1080 Hi10 FLAC).mkv";
const NCED01 = "[IK] Toaru Kagaku no Railgun S - NCED 01 (BD 1920x1080 Hi10 FLAC).mkv";
const NCOP02 = "[IK] Toaru Kagaku no Railgun S - NCOP 02 (BD 1920x1080 Hi10 FLAC).mkv";
const probe = async () =>
  ({
    duration: 1440,
    container: "matroska",
    video: { codec: "h264", width: 1920, height: 1080, hdr: false },
    audio: [{ lang: "ja", title: null, codec: "flac", channels: 2, default: true, forced: false }],
    subs: [{ lang: "en", title: null, codec: "ass", default: true, forced: false, partial: false }],
  }) as never;
const write = (p: string) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, "x"));

before(() => {
  cache
    .prepare(
      "INSERT INTO series (id, tvdb_id, title, year, series_type, path, monitored, synced_at) VALUES (40, ?, 'Toaru Kagaku no Railgun S', 2013, 'anime', '/media/AnimeArr/Toaru Kagaku no Railgun S', 1, 0)",
    )
    .run(TVDB);
  for (let n = 1; n <= 24; n++)
    cache
      .prepare(
        "INSERT INTO episodes (id, series_id, season, episode, absolute, title, monitored, has_file, air_utc) VALUES (?, 40, 1, ?, ?, ?, 1, 0, 0)",
      )
      .run(4000 + n, n, n, `Episode ${n}`);
  for (const n of [1, 11, 12]) write(path.join(ROOT, ep(n)));
  for (const f of [NCED11, NCED01, NCOP02]) write(path.join(ROOT, NC, f));
  patchSettings((s) => ({
    ...s,
    allowedRoots: ["/media/AnimeArr"],
    localPathMappings: [
      { from: "/media/AnimeArr", to: LIB },
      { from: "/data", to: DL },
    ],
    media: { ...s.media, animeEpisodeFormat: "{Series Title} - S{season:00}E{episode:00}" },
  }));
});

test("'NCED Ep11' is the ending as it ran in episode 11, never episode 11 itself", () => {
  const ctx = identifyContext();
  const r = identify(NCED11, ctx, { tvdbId: TVDB });
  assert.ok(!r.resolution?.ok || !r.resolution.episodes.some((e) => e.season > 0), JSON.stringify(r.resolution));
  const plain = identify(ep(11), ctx, { tvdbId: TVDB });
  assert.deepEqual(
    plain.resolution?.episodes.map((e) => e.id),
    [4011],
  );
});

test("files in an extras folder ('NCED & NCOP', 'Extras', 'Menus', …) are never regular episodes", () => {
  assert.equal(inExtrasFolder(`${NC}/${NCED01}`), true);
  for (const d of ["Extras", "Specials", "Menus", "Bonus", "NC", "Creditless"]) assert.equal(inExtrasFolder(`${d}/x.mkv`), true, d);
  assert.equal(inExtrasFolder(ep(11)), false);
  assert.equal(inExtrasFolder(`Season 2/${ep(11)}`), false);
});

test("the season download plans without a clash: episodes mapped, creditless files left out", async () => {
  const plan = await planImport(
    { tvdbId: TVDB, path: `/data/completed/animearr/${PACK}`, release: PACK, client: "qbittorrent" },
    { probe, minBytes: 0 },
  );
  const by = new Map(plan.items.map((i) => [path.basename(i.source), i]));
  assert.equal(by.get(ep(11))!.problem, null);
  assert.deepEqual(by.get(ep(11))!.episodeIds, [4011]);
  for (const f of [NCED11, NCED01, NCOP02]) {
    assert.deepEqual(by.get(f)!.episodeIds, [], f);
    assert.notEqual(by.get(f)!.problem, null, f);
  }
  assert.ok(!plan.items.some((i) => i.problem === "two files would get the same name"));
});

test("hand import: a file given the same episode only clashes with files the user picked", async () => {
  const src11 = fs.realpathSync(path.join(ROOT, ep(11)));
  const nc11 = fs.realpathSync(path.join(ROOT, NC, NCED11));
  // The user (wrongly) gives NCED Ep11 episode 11 too: both picked → one of them clashes.
  const both = await planImport(
    { tvdbId: TVDB, path: `/data/completed/animearr/${PACK}`, release: PACK, assign: { [nc11]: [4011] }, only: [src11, nc11] },
    { probe, minBytes: 0 },
  );
  assert.ok(both.items.some((i) => i.problem === "two files would get the same name"));
  // Only the real episode picked: the unpicked NCED file doesn't block it, whatever order the folder lists them in.
  const one = await planImport(
    { tvdbId: TVDB, path: `/data/completed/animearr/${PACK}`, release: PACK, assign: { [nc11]: [4011] }, only: [src11] },
    { probe, minBytes: 0 },
  );
  assert.equal(one.items.find((i) => i.source === src11)!.problem, null);
});

test("two files that look like one episode: plain words, and the fix opens the whole download for review", () => {
  const why = "two files in this download look like episode 11 (one is a creditless ending); review the files to import";
  assert.equal(
    attentionSummary(why),
    "Two files in this download look like episode 11 (one is a creditless ending); review the files to import.",
  );
  const fixes = fixesFor(why, { grabId: 5, tvdbId: TVDB, episodeIds: [4011, 4012], kind: "attention" });
  const review = fixes.find((f) => f.action === "importManual");
  assert.ok(review, JSON.stringify(fixes));
  assert.equal(review!.params?.review, true);
  assert.equal(review!.params?.grabId, 5);
  assert.ok(!fixes.some((f) => f.action === "pickEpisode"), "not a one-episode picker");
});
