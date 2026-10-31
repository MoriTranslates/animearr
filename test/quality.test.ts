/** Quality categories (the anime rebase), group tiers, SeaDex scoring, the no-churn rule, goals and the {Keep Tag}. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { beatsCurrent, compileTiers, goalCategory, goalLabel, isCategoryBest, LOCK_TAG, meetsGoal, qualityOf, qualityScore, seadexPick, sonarrQualityName, tierOf, type SeadexEntry, type TierTable } from "../server/core/quality.js";
import { rankRelease } from "../server/core/rank.js";
import { parseRelease } from "../server/core/parser.js";
import { renderEpisode } from "../server/naming.js";

const tiers = compileTiers(JSON.parse(fs.readFileSync(path.join(process.cwd(), "catalog", "anime-tiers.json"), "utf8")) as TierTable);

test("the shipped TRaSH tier patterns all compile in JavaScript", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), "catalog", "anime-tiers.json"), "utf8")) as TierTable;
  const n = (o: Record<string, string[]>) => Object.values(o).flat().length;
  assert.equal(tiers.bd.flatMap((t) => t.re).length, n(raw.bd));
  assert.equal(tiers.web.flatMap((t) => t.re).length, n(raw.web));
  assert.equal(tiers.lq.length, raw.lq.length);
  assert.deepEqual(tiers.bd.map((t) => t.tier), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("categories: Sonarr names, TRaSH anime grouping", () => {
  assert.equal(qualityOf("[Group] Show - S01 (BD 1080p HEVC)").category, "bluray-1080");
  assert.equal(qualityOf("Show.S01.1080p.BluRay.REMUX.AVC.FLAC-Grp").category, "bluray-1080", "remux sits in the Bluray 1080p category");
  assert.equal(qualityOf("Show.S01.1080p.BluRay.REMUX.AVC.FLAC-Grp").name, "Bluray-1080p Remux");
  assert.equal(qualityOf("Show.S01E01.720p.BluRay.x264-Grp").category, "bluray-720");
  assert.equal(qualityOf("Old Show - 01 [DVD 480p]").category, "dvd");
  assert.equal(sonarrQualityName("Show.S01E01.1080p.WEBRip.x265-Grp", null), "WEBRip-1080p");
});

test("anime rebase: WEB-DL and WEBRip are one category; a bare resolution is WEB; HDTV is a penalised TV capture", () => {
  assert.equal(qualityOf("Show.S01E01.1080p.WEB-DL.AAC-Grp").category, "web-1080");
  assert.equal(qualityOf("Show.S01E01.1080p.WEBRip.x264-Grp").category, "web-1080");
  assert.equal(qualityOf("[SubsPlease] Show - 01 (1080p) [ABCD1234]").category, "web-1080", "no source named, a 1080p fansub/WEB rip");
  const tv = qualityOf("Show.S01E01.1080p.HDTV.x264-Grp");
  assert.equal(tv.category, "web-1080");
  assert.ok(tv.hdtv);
  assert.ok(qualityScore("Show.S01E01.1080p.HDTV.x264-Grp", {}).points < qualityScore("Show.S01E01.1080p.WEB-DL.x264-Grp", {}).points);
  assert.equal(qualityOf("Show.S01E01.480p.HDTV.x264-Grp").category, "sdtv");
});

test("anime rebase: 4K is an upscale (counted as 1080p) unless it's a real UHD Blu-ray", () => {
  const up = qualityOf("[Grp] Show - 01 [2160p][AI Upscale]");
  assert.equal(up.category, "web-1080");
  assert.ok(up.upscale);
  assert.equal(qualityOf("Show.S01.2160p.UHD.BluRay.REMUX.HDR.HEVC-Grp").category, "bluray-2160");
  assert.equal(qualityOf("Show.S01.2160p.BluRay.x265-Grp").category, "bluray-1080", "a 2160p BD encode that isn't UHD/Remux");
});

test("goals: labels, the profile's resolution, and the no-Blu-ray (DVD) cap", () => {
  assert.equal(goalLabel("high"), "Aim high (Bluray 1080p)");
  assert.equal(goalLabel("collector"), "Collector (SeaDex best)");
  assert.equal(goalCategory("good"), "web-1080");
  assert.equal(goalCategory("high", 720), "bluray-720");
  assert.equal(goalCategory("high", 1080, "dvd"), "dvd", "a DVD-era show aims for the DVD");
  const dvd = qualityScore("Old Show - 01 [DVD 480p]", {});
  assert.ok(!meetsGoal(dvd, "high"));
  assert.ok(meetsGoal(dvd, "high", { cap: "dvd" }));
});

test("tiers: BD tiers for Blu-ray, Web tiers for WEB, low-quality groups anywhere", () => {
  assert.deepEqual(tierOf("[SubsPlease] Show - 01 (1080p)", "web-1080", tiers), { kind: "web", tier: 5 });
  assert.equal(tierOf("[SubsPlease] Show - 01 (1080p)", "bluray-1080", tiers), null, "a WEB group isn't a BD tier");
  const bd1 = tiers.bd[0].re[0].source.replace(/\\b|[()]/g, "");
  assert.deepEqual(tierOf(`[${bd1}] Show (BD 1080p)`, "bluray-1080", tiers), { kind: "bd", tier: 1 });
  const lq = "0neshot"; // on TRaSH's anime LQ list
  assert.equal(tierOf(`[${lq}] Show - 01 (1080p)`, "web-1080", tiers)?.kind, "lq");
  assert.ok(qualityScore(`[${lq}] Show - 01 (1080p)`, { tiers }).points < 0);
});

const SEADEX: SeadexEntry = {
  incomplete: false,
  torrents: [
    { group: "SubGroup", tracker: "Nyaa", best: true, dualAudio: false, tags: [] },
    { group: "DualGroup", tracker: "Nyaa", best: false, dualAudio: true, tags: [] },
    { group: "AltGroup", tracker: "AB", best: false, dualAudio: false, tags: [] },
  ],
};

test("SeaDex: best is the top score, alt next; dual and either modes prefer the dual-audio pick", () => {
  assert.equal(seadexPick("SubGroup", SEADEX, "sub")?.level, "best");
  assert.equal(seadexPick("AltGroup", SEADEX, "sub")?.level, "alt");
  assert.equal(seadexPick("DualGroup", SEADEX, "sub")?.level, "alt", "sub mode ignores the dual-audio flag");
  assert.equal(seadexPick("DualGroup", SEADEX, "dual")?.level, "best");
  assert.equal(seadexPick("SubGroup", SEADEX, "either")?.level, "alt");
  assert.equal(seadexPick("Nobody", SEADEX, "sub"), null);
  const best = qualityScore("[SubGroup] Show - S01 (BD 1080p)", { seadex: SEADEX, tiers });
  const alt = qualityScore("[AltGroup] Show - S01 (BD 1080p)", { seadex: SEADEX, tiers });
  assert.ok(best.points > alt.points);
  assert.equal(best.why[0], "SeaDex best release (SubGroup)");
  assert.equal(qualityScore("[DualGroup] Show - S01 (BD 1080p)", { seadex: SEADEX, mode: "dual" }).why[0], "SeaDex best release (DualGroup, dual audio)");
});

test("SeaDex ranks above tiers and size in rankRelease, after the language fit", () => {
  const prof = { subLangs: ["en"], softOnly: true, preferUncensored: false, protocolOrder: ["usenet", "torrent"] as ("usenet" | "torrent")[], resolution: 1080, sizePreset: "lean" as const };
  const info = { protocol: "torrent" as const, size: 12e9, seeders: 20, episodeCount: 12 };
  const seadexBig = rankRelease(parseRelease("[SubGroup] Show (BD 1080p) [Eng Subs]"), info, prof, null, { seadex: SEADEX, tiers });
  const plain = rankRelease(parseRelease("[SomeGroup] Show (BD 1080p) [Eng Subs]"), { ...info, size: 6e9 }, prof, null, { seadex: SEADEX, tiers });
  assert.ok(seadexBig.score > plain.score, "the SeaDex pick wins even when it's over the Lean size");
  assert.match(seadexBig.why, /SeaDex best release/);
  const raw = rankRelease(parseRelease("[SubGroup] Show - 01 (1080p) [RAW]"), info, prof, null, { seadex: SEADEX, tiers });
  assert.ok(!raw.accept, "the language fit still comes first");
});

test("no churn: a higher category always beats; the same category only when the file isn't its category's best", () => {
  const web = qualityScore("[SubsPlease] Show - 01 (1080p)", { tiers, seadex: SEADEX });
  const bd = qualityScore("[SomeGroup] Show - 01 (BD 1080p)", { tiers, seadex: SEADEX });
  assert.deepEqual(beatsCurrent(bd, web), { ok: true, why: "Bluray 1080p beats your WEB 1080p" });
  assert.equal(beatsCurrent(web, bd).ok, false);
  // The file is a SeaDex pick (category best): a pick moving to another release in the same category doesn't re-grab.
  const curPick = qualityScore("[AltGroup] Show - 01 (BD 1080p)", { tiers, seadex: SEADEX });
  assert.ok(isCategoryBest(curPick));
  const newPick = qualityScore("[SubGroup] Show - 01 (BD 1080p)", { tiers, seadex: SEADEX });
  assert.equal(beatsCurrent(newPick, curPick).ok, false);
  // A plain BD file in the same category: SeaDex's pick does qualify.
  assert.equal(beatsCurrent(newPick, bd).ok, true);
  assert.equal(beatsCurrent(bd, qualityScore("[OtherGroup] Show - 01 (BD 1080p)", { tiers, seadex: SEADEX })).ok, false, "equal releases don't swap");
});

test("collector goal: met by SeaDex's best when SeaDex knows the show, else by a category best", () => {
  const pick = qualityScore("[SubGroup] Show (BD 1080p)", { seadex: SEADEX, tiers });
  const alt = qualityScore("[AltGroup] Show (BD 1080p)", { seadex: SEADEX, tiers });
  assert.ok(meetsGoal(pick, "collector", { seadexKnown: true }));
  assert.ok(!meetsGoal(alt, "collector", { seadexKnown: true }));
  assert.ok(meetsGoal(alt, "high"));
});

test("lock tags: [Keep] and [Remaster] both lock; {Keep Tag} renders [Keep] only when asked", () => {
  assert.ok(LOCK_TAG.test("Genesis Survivor Gaiarth - S01E01 - Stage 1 [Remaster].mkv"));
  assert.ok(LOCK_TAG.test("Show - S01E01 - Title [Keep].mkv"));
  assert.ok(!LOCK_TAG.test("Keeper - S01E01.mkv"));
  const opts = { replaceIllegalCharacters: true, colonReplacement: "smart" as const, multiEpisodeStyle: "prefixedRange" as const };
  const ctx = { seriesTitle: "Show", season: 1, episodes: [{ episode: 1, title: "Start" }] };
  const fmt = "{Series Title} - S{season:00}E{episode:00} - {Episode Title} {Keep Tag}";
  assert.equal(renderEpisode(fmt, { ...ctx, keepTag: true }, opts), "Show - S01E01 - Start [Keep]");
  assert.equal(renderEpisode(fmt, ctx, opts), "Show - S01E01 - Start");
});
