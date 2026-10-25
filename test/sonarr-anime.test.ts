/**
 * A subset of Sonarr's anime parser tests, ported from
 * Sonarr/src/NzbDrone.Core.Test/ParserTests/AbsoluteEpisodeNumberParserFixture.cs (develop, 2026-10-25), GPL-3.0.
 *
 * Deliberate deviations from Sonarr (documented, not bugs):
 * 1. A season token is split off the title: Sonarr gives title "Some Anime Show S3" + absolute 12 for
 *    "[SFW-sage] Some Anime Show S3 - 12"; AnimeArr gives title "Some Anime Show", season 3, episode 12 (fan numbering).
 *    The alias index then needs no separate "Title S3" alias, and the resolver maps fan seasons explicitly.
 * 2. Season packs keep "?" in the title ("Anime, Title?"); Sonarr strips it. Normalised alias keys ignore it anyway.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRelease } from "../server/core/parser.js";

// [release, title, absolute, season, episode]  (season/episode 0 = none, as in Sonarr's fixture)
const ABSOLUTE: [string, string, number, number, number][] = [
  ["[SubDESU]_Show_One_07_(1280x720_x264-AAC)_[6B7FD717]", "Show One", 7, 0, 0],
  ["[Chihiro]_Show!!_-_06_[848x480_H.264_AAC][859EEAFA]", "Show!!", 6, 0, 0],
  ["[Commie]_Some_Anime_Show_-_11_[65F220B4]", "Some Anime Show", 11, 0, 0],
  ["[Underwater]_Some_Anime_Show_-_12_(720p)_[5C7BC4F9]", "Some Anime Show", 12, 0, 0],
  ["[HorribleSubs]_Some_Anime_Show_-_145_[720p]", "Some Anime Show", 145, 0, 0],
  ["[HorribleSubs] Some Anime Show - 13 [1080p].mkv", "Some Anime Show", 13, 0, 0],
  ["[K-F] Some Anime Show 214", "Some Anime Show", 214, 0, 0],
  ["[K-F] Some Anime Show S10E14 214", "Some Anime Show", 214, 10, 14],
  ["[K-F] Some Anime Show 10x14 214", "Some Anime Show", 214, 10, 14],
  ["Some Anime Show - 031 - The Resolution to Kill [Lunar].avi", "Some Anime Show", 31, 0, 0],
  ["[Underwater-FFF] No Series Title No Life - 01 (720p) [27AAA0A0].mkv", "No Series Title No Life", 1, 0, 0],
  ["[FroZen] Series Title - 23 [DVD][7F6170E6]", "Series Title", 23, 0, 0],
  ["[Doki]Series Title - 07 (1280x720 Hi10P AAC) [80AF7DDE]", "Series Title", 7, 0, 0],
  ["[CR] Series Title - 004 [480p][48CE2D0F]", "Series Title", 4, 0, 0],
  ["[Chibiki] Series Title!! - 42 [360p][7A4FC77B]", "Series Title!!", 42, 0, 0],
  ["[DeadFish] Series Title - 09v2 [720p][AAC]", "Series Title", 9, 0, 0],
  ["[S-T-D] Series Title! - 06 (1280x720 10bit AAC) [59B3F2EA].mkv", "Series Title!", 6, 0, 0],
  ["Series Title - 010 (720p) [27AAA0A0].mkv", "Series Title", 10, 0, 0],
  ["Initial_Series_Title_-_01(DVD)_-_(Central_Anime)[5AF6F1E4].mkv", "Initial Series Title", 1, 0, 0],
  ["[ChihiroDesuYo].Series.Title.-.09.1280x720.10bit.AAC.[24CCE81D]", "Series Title", 9, 0, 0],
  ["Series Title - 100 - Mest", "Series Title", 100, 0, 0],
  ["[Exiled-Destiny] Series Title Ep01 (D2201EC5).mkv", "Series Title", 1, 0, 0],
  ["[Hatsuyuki]Series_Title-01[1280x720][122E6EF8]", "Series Title", 1, 0, 0],
  ["[CBM]_Series_Title_-_11_-_511_Kinderheim_[6C70C4E4].mkv", "Series Title", 11, 0, 0],
  ["[HorribleSubs] Series Title 2 - 05 [720p].mkv", "Series Title 2", 5, 0, 0],
  ["[DRONE]Series.Title.100", "Series Title", 100, 0, 0],
  ["[Jumonji-Giri]_[F-B]_Series_Title_Ep04_(0b0e2c10).mkv", "Series Title", 4, 0, 0],
  ["Knights Series Title - 01 [1080p 10b DTSHD-MA eng sub].mkv", "Knights Series Title", 1, 0, 0],
  ["[Hatsuyuki] Series Title (2014) - 017 (115) [1280x720][B2CFBC0F]", "Series Title (2014)", 17, 0, 0],
  ["[HorribleSubs] Series Title 21 - 101 [480p].mkv", "Series Title 21", 101, 0, 0],
  ["Series Title Episode 56 [VOSTFR V2][720p][AAC]-Mystic Z-Team", "Series Title", 56, 0, 0],
  ["[Shark-Raws] Series Title #957 (NBN 1280x720 x264 AAC).mp4", "Series Title", 957, 0, 0],
  ["Series Title EP06 720p x265 AOZ.mp4", "Series Title", 6, 0, 0],
  ["[Glenn] Series! 3 - 11 (1080p AAC)[C34B2B3B].mkv", "Series! 3", 11, 0, 0],
  ["SeriesTitle.E1135.Lasst.den.Mond.am.Himmel.stehen.GERMAN.1080p.WEBRip.x264-Group", "SeriesTitle", 1135, 0, 0],
  ["[HorribleSubs] Series 100 - 07 [1080p].mkv", "Series 100", 7, 0, 0],
  ["[Cheetah-Raws] Super Long Anime - 1000 (YTV 1280x720 x264 AAC)", "Super Long Anime", 1000, 0, 0],
  ["[SubsPlease] Anime Title 300-nen, With Even More Title - 01 (1080p) [8DE44442]", "Anime Title 300-nen, With Even More Title", 1, 0, 0],
  ["[BakeSubs] 86 - 01 [1080p][D40A9E55].mkv", "86", 1, 0, 0],
  ["Anime Title the Final - 09 (2021) [SubsPlease] [WEBRip] [HD 1080p]", "Anime Title the Final", 9, 0, 0],
  ["[HatSubs] Anime Title 1004 [E63F2984].mkv", "Anime Title", 1004, 0, 0],
  ["[SubsPlease] Another Anime 100 - Another 100 Anime - 01 (1080p) [4E6B4518].mkv", "Another Anime 100 - Another 100 Anime", 1, 0, 0],
  ["[SubsPlease] Series Title - 100 Years Quest - 01 (1080p) [1107F3A9].mkv", "Series Title - 100 Years Quest", 1, 0, 0],
  ["Series_Title_2_[01]_[AniLibria_TV]_[WEBRip_1080p]", "Series Title 2", 1, 0, 0],
  ["[Dae-P9] Anime Series - 05 - S01E05 - Marrying by Contesting (BD 1080p HEVC FLAC AAC) [Dual Audio] [5BCD56B8]", "Anime Series", 5, 1, 5],
  ["[Kaleido-subs] Animation - 12 (S01E12) - (WEB 1080p HEVC x265 10-bit E-AC3 2.0) [1ADD8F6D]", "Animation", 12, 1, 12],
];

// Deviation 1: season token split off the title. [release, title, season, episode]
const FAN_SEASON: [string, string, number, number][] = [
  ["[SFW-sage] Some Anime Show S3 - 12 [720p][D07C91FC]", "Some Anime Show", 3, 12],
  ["[HorribleSubs] Series Title! S2 - 07 [720p]", "Series Title!", 2, 7],
  ["Series Title S3 -  15 VOSTFR [720p]", "Series Title", 3, 15],
  ["Series Title S03 - EP14 VOSTFR [1080p] [HardSub] Yass'Kun", "Series Title", 3, 14],
  ["[SubsPlease] Title de Series S2 - 03 (540p) [63501322]", "Title de Series", 2, 3],
  ["[SubsPlease] Anime Title 100 S3 - 01 (1080p) [5A493522]", "Anime Title 100", 3, 1],
  ["[DameDesuYo] Another Anime With Special Naming (Season 2) - 33 (1280x720 10bit EAC3) [42A12A76].mkv", "Another Anime With Special Naming", 2, 33],
];

const MULTI: [string, string, number, number][] = [
  ["[Doutei] Some Good, Anime Show - 01-12 [BD][720p-AAC]", "Some Good, Anime Show", 1, 12],
  ["[HorribleSubs] Some Anime Show!! (01-25) [1080p] (Batch)", "Some Anime Show!!", 1, 25],
  ["[Judas] Some Anime Show - 091-123 [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs]", "Some Anime Show", 91, 123],
  ["[HorribleSubs] Some Anime Show 01 - 119 [1080p] [Batch]", "Some Anime Show", 1, 119],
  ["[Erai-raws] Series Title! - 01~10 [1080p][Multiple Subtitle]", "Series Title!", 1, 10],
  ["[Erai-raws] Series Title! - 01 ~ 10 [1080p][Multiple Subtitle]", "Series Title!", 1, 10],
  ["[HatSubs] One Series (1017-1088) (WEB 1080p)", "One Series", 1017, 1088],
  ["[HatSubs] One Series 1017-1088 (WEB 1080p)", "One Series", 1017, 1088],
  ["Series.Title.Ep01-12.Complete.English.AC3.DL.1080p.BluRay.x264", "Series Title", 1, 12],
];

const PACKS: [string, string, number][] = [
  ["[Vivid] Some Anime Show S01 [Web][MKV][h264 10-bit][1080p][AAC 2.0]", "Some Anime Show", 1],
  ["[Judas] Japanse Anime, Title (Anime, Title?) (Season 1) [1080p][HEVC x265 10bit][Multi-Subs] (Batch)", "Japanse Anime, Title (Anime, Title?)", 1],
];

const RECAP: [string, string, number][] = [
  ["[Anime Time] Series no Mayo - 12.5.mkv", "Series no Mayo", 12.5],
  ["[SubsPlease] Series Title - 26.5.1 (1080p) [29AF1C23].mkv", "Series Title", 26.5],
  ["[HorribleSubs] Show Slayer - 10.5 [1080p].mkv", "Show Slayer", 10.5],
];

const SPECIALS: [string, string][] = [
  ["[Underwater] Another OVA - The Other -Karma- (BD 1080p) [3A561D0E].mkv", "Another"],
  ["[sam] Long Series - NCOP [BD 1080p FLAC] [BBC3BC68].mkv", "Long Series"],
  ["[sam] Long Series - NCED [BD 1080p FLAC] [BBC3BC68].mkv", "Long Series"],
];

for (const [name, title, abs, season, ep] of ABSOLUTE)
  test(`absolute: ${name}`, () => {
    const p = parseRelease(name);
    assert.equal(p.title, title);
    assert.deepEqual(p.absolute, [abs]);
    if (season) assert.equal(p.season, season);
    else assert.equal(p.episodes.length, 0, "no season episode");
    if (ep) assert.deepEqual(p.episodes, [ep]);
    assert.equal(p.fullSeason, false);
  });

for (const [name, title, season, ep] of FAN_SEASON)
  test(`fan season (deviation): ${name}`, () => {
    const p = parseRelease(name);
    assert.equal(p.title, title);
    assert.equal(p.season, season);
    assert.deepEqual(p.episodes, [ep]);
    assert.equal(p.fullSeason, false);
  });

for (const [name, title, a, b] of MULTI)
  test(`multi-episode: ${name}`, () => {
    const p = parseRelease(name);
    assert.equal(p.title, title);
    assert.deepEqual(p.absolute, Array.from({ length: b - a + 1 }, (_, i) => a + i));
    assert.equal(p.batch, true);
  });

for (const [name, title, season] of PACKS)
  test(`season pack: ${name}`, () => {
    const p = parseRelease(name);
    assert.equal(p.title, title);
    assert.equal(p.season, season);
    assert.equal(p.fullSeason, true);
    assert.deepEqual(p.absolute, []);
  });

for (const [name, title, n] of RECAP)
  test(`recap numbering: ${name}`, () => {
    const p = parseRelease(name);
    assert.equal(p.title, title);
    assert.equal(p.specialNumber, n);
    assert.deepEqual(p.absolute, []);
  });

for (const [name, title] of SPECIALS)
  test(`special without number: ${name}`, () => {
    const p = parseRelease(name);
    assert.equal(p.title, title);
    assert.notEqual(p.special, null);
    assert.deepEqual(p.absolute, []);
    assert.deepEqual(p.episodes, []);
  });
