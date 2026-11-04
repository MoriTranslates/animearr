/**
 * Platform-wide subtitle learning (Tower, 2026-11-04: Magical Explorer S01E03). An unknown group's CR WEB-DL stayed at
 * 35% "no language info in the name" although every CR file in the library has English subtitles. The platform's own
 * learned stat (every group's files from it, backfilled from the library and fed by verifications) now counts when the
 * group has none, and only then; the hard rejections (raw, JP market, foreign-only) still win.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-platsubs-"));
process.env.ANIMEARR_NO_LOCK = "1";

const { cache, db } = await import("../server/system/db.js");
const { parseRelease } = await import("../server/core/parser.js");
const { rankRelease, PLATFORM_MIN } = await import("../server/core/rank.js");
const { backfillLearning, learnedFor, learnedForPlatform, learnFromVerify } = await import("../server/library/library.js");

const ALANSARI = "Magical.Explorer.S01E03.Staples.of.Any.Eroge.1080p.CR.WEB-DL.AAC2.0.H.264-ALANSARI87";
const profile = {
  subLangs: ["en"],
  softOnly: true,
  preferUncensored: false,
  protocolOrder: ["usenet", "torrent"] as ("usenet" | "torrent")[],
  resolution: 1080,
};
const info = { protocol: "torrent" as const, size: 1.4e9, seeders: 20, episodeCount: 1 };

/** The rank of a name exactly as the search wires it: the group's stat, and the platform's. */
function rankOf(name: string) {
  const p = parseRelease(name);
  return rankRelease(p, info, profile, learnedFor(p.group, p.platform ?? "web"), { platformLearned: learnedForPlatform(p.platform) });
}

let fid = 1;
function files(n: number, scene: (i: number) => string, subs: string, group: string | null = null) {
  for (let i = 0; i < n; i++)
    cache
      .prepare(
        "INSERT INTO files (id, series_id, season, path, release_group, scene_name, quality, source, audio_langs, sub_langs) VALUES (?, 1, 1, ?, ?, ?, 'WEBDL-1080p', 'web', 'ja', ?)",
      )
      .run(fid++, `/x/${fid}.mkv`, group, scene(i), subs);
}

beforeEach(() => {
  cache.prepare("DELETE FROM files").run();
  db.prepare("DELETE FROM group_langs").run();
});

test("an unknown group on CR, with CR files in the library that have English: high P(English), labelled by the platform", () => {
  // Several groups' CR rips, and some without a group at all: all of them speak for the platform.
  files(8, (i) => `[SubsPlease] Show ${i} - 01 (1080p) [CR WEB-DL]`, "en", "SubsPlease");
  files(4, (i) => `Other.Show.${i}.S01E01.1080p.CR.WEB-DL.AAC2.0.H.264-VARYG`, "en/es/pt", "VARYG");
  files(3, (i) => `Third Show ${i} 01 1080p CR WEB-DL`, "en", null);
  backfillLearning();
  const r = rankOf(ALANSARI);
  assert.ok(r.accept);
  assert.ok(r.langProb >= 0.9, `P(en) ${r.langProb}`);
  assert.equal(r.langSource, "CR: 15/15 in your library");
});

test("the same release with no library history: unchanged at 35%, no platform guess", () => {
  const r = rankOf(ALANSARI);
  assert.equal(r.langProb, 0.35);
  assert.equal(r.langSource, "no language info in the name");
});

test(`a platform counts only from ${PLATFORM_MIN} files: a handful from one show doesn't speak for CR`, () => {
  files(PLATFORM_MIN - 1, (i) => `[SubsPlease] Show ${i} - 01 (1080p) [CR WEB-DL]`, "en", "SubsPlease");
  backfillLearning();
  assert.equal(rankOf(ALANSARI).langProb, 0.35);
});

test("CR raw, JP-market and foreign-only names are still rejected, whatever the platform's stat says", () => {
  files(20, (i) => `[SubsPlease] Show ${i} - 01 (1080p) [CR WEB-DL]`, "en", "SubsPlease");
  backfillLearning();
  for (const [name, reject] of [
    ["[Ohys-Raws] Magical Explorer - 03 (CR 1920x1080 x264 AAC).mp4", /raw/],
    ["Magical.Explorer.S01E03.1080p.CR.WEB-DL.JPN-Subs.AAC2.0.H.264-NEWGRP", /Japanese-market/],
    ["Magical.Explorer.S01E03.1080p.CR.WEB-DL.VOSTFR.AAC2.0.H.264-NEWGRP", /foreign subtitles only/],
    ["[NewGrp] Magical Explorer - 03 [CR WEB-DL 1080p][Español Castellano]", /foreign subtitles only/],
  ] as const) {
    assert.equal(parseRelease(name).platform, "CR", name);
    const r = rankOf(name);
    assert.equal(r.accept, false, name);
    assert.match(r.reject ?? "", reject, name);
    assert.ok(r.langProb <= 0.05, `${name}: ${r.langProb}`);
  }
});

test("a group's own stat (no English on CR) wins over the platform's (English): the closer evidence", () => {
  files(20, (i) => `[SubsPlease] Show ${i} - 01 (1080p) [CR WEB-DL]`, "en", "SubsPlease");
  files(6, (i) => `Show.${i}.S01E01.1080p.CR.WEB-DL.AAC2.0.H.264-ALANSARI87`, "es", "ALANSARI87");
  backfillLearning();
  const r = rankOf(ALANSARI);
  assert.ok(r.langProb < 0.2, `P(en) ${r.langProb}`);
  assert.match(r.langSource, /^ALANSARI87 CR: 0\/6/);
});

test("ADN (a French platform) with French-only files in the library: no English boost", () => {
  files(15, (i) => `Show.${i}.S01E01.1080p.ADN.WEB-DL.AAC2.0.H.264-FRGRP${i}`, "fr", null);
  backfillLearning();
  const name = "Magical.Explorer.S01E03.1080p.ADN.WEB-DL.AAC2.0.H.264-NEWGRP";
  assert.equal(parseRelease(name).platform, "ADN");
  const r = rankOf(name);
  // Below the "nothing known" 35%: the library says ADN files had no English (so it isn't a last-resort grab either).
  assert.ok(r.langProb < 0.35, `P(en) ${r.langProb}`);
  assert.equal(r.langSource, "ADN: 0/15 in your library");
});

test("a group's stat saying no English lowers P(sub) below the unknown 35%; the name's own hints still raise it", () => {
  files(6, (i) => `[NoEng] Show ${i} - 01 [1080p]`, "es", "NoEng");
  backfillLearning();
  assert.ok(rankOf("[NoEng] Magical Explorer - 03 [1080p]").langProb < 0.2);
  const named = rankOf("[NoEng] Magical Explorer - 03 [1080p][English Subs]");
  assert.equal(named.langProb, 0.97);
  assert.equal(named.langSource, "named in the title");
});

test("verifications feed the platform stat too, also for releases without a group; generic sources never make one", () => {
  for (let i = 0; i < PLATFORM_MIN; i++) learnFromVerify(null, "HIDIVE", ["en"], ["ja"]);
  learnFromVerify("Grp", "web", ["en"], ["ja"]);
  const l = learnedForPlatform("HIDIVE");
  assert.equal(l?.total, PLATFORM_MIN);
  assert.equal(l?.origin, "verified");
  assert.equal(learnedForPlatform("web"), null);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM group_langs WHERE grp = '*' AND source = 'web'").get() as { n: number }).n, 0);
});

test("a rebuild keeps the per-group rows exactly as before (same keys and counts)", () => {
  files(3, (i) => `[SubsPlease] Show ${i} - 01 (1080p) [CR WEB-DL]`, "en", "SubsPlease");
  files(2, () => `[Judas] Show - 01 [BD 1080p]`, "en", null);
  backfillLearning();
  const rows = db.prepare("SELECT grp, source, total FROM group_langs WHERE grp != '*' ORDER BY grp, source").all();
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [
      { grp: "judas", source: "*", total: 2 },
      // "WEBDL-1080p" reads as "bluray" (the /bd/ in "webdl"): an old quirk of sourceKey, kept as it was.
      { grp: "judas", source: "bluray", total: 2 },
      { grp: "subsplease", source: "*", total: 3 },
      { grp: "subsplease", source: "CR", total: 3 },
    ],
  );
});
