/**
 * Regression fixtures from the 2026-10-25 hand-hunts (PROPOSAL §2, §6.8). Each one was a real failure of the
 * Sonarr + XEM stack. Library/AniDB/Anime-Lists data is a snapshot in test/fixtures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { identify } from "../server/core/identify.js";
import { parseRelease } from "../server/core/parser.js";
import { rankRelease, type Profile } from "../server/core/rank.js";
import { fixtureContext } from "./helpers.js";

const ctx = fixtureContext();
const PROFILE: Profile = { subLangs: ["en"], audioLangs: ["ja"], softOnly: true, preferUncensored: true, protocolOrder: ["usenet", "torrent"], resolution: 1080 };
const rank = (name: string, protocol: "usenet" | "torrent" = "usenet", known = {}) => rankRelease(parseRelease(name), { protocol, size: 1.4e9, seeders: 10, episodeCount: 1 }, PROFILE, null, known);

function expectEpisode(name: string, tvdbId: number, season: number, episode: number) {
  const r = identify(name, ctx);
  assert.ok(r.resolution?.ok, `${name}: ${r.summary}`);
  assert.equal(r.candidate!.tvdbId, tvdbId, `${name}: wrong series (${r.summary})`);
  assert.deepEqual(
    r.resolution!.episodes.map((e) => [e.season, e.episode]),
    [[season, episode]],
    `${name}: ${r.summary} — ${r.resolution!.why.join(" | ")}`,
  );
  return r;
}

test("Quan.Zhi.Fa.Shi.S6.-.01 → Full-Time Magister S06E01 (not a multi-season pack)", () => {
  const p = parseRelease("Quan.Zhi.Fa.Shi.S6.-.01");
  assert.equal(p.season, 6);
  assert.deepEqual(p.episodes, [1]);
  assert.equal(p.fullSeason, false);
  assert.deepEqual(p.seasons, [6]);
  expectEpisode("Quan.Zhi.Fa.Shi.S6.-.01", 328670, 6, 1);
});

test("[SubsPlease] Quanzhi Fashi S7 - 05 (1080p) → Full-Time Magister S07E05", () => {
  const r = expectEpisode("[SubsPlease] Quanzhi Fashi S7 - 05 (1080p)", 328670, 7, 5);
  assert.ok(r.resolution!.confidence >= 80, `confidence ${r.resolution!.confidence}`);
});

test("[Erai-raws] Hitori no Shita: The Outcast 6th Season S6E26 → S06E26", () => {
  expectEpisode("[Erai-raws] Hitori no Shita: The Outcast 6th Season S6E26", 313488, 6, 26);
});

test("[geckyzz] Click Me All Over - S01E02v2 → Mouse Cursor S01E02 (AniDB English synonym), version 2", () => {
  const r = expectEpisode("[geckyzz] Click Me All Over - S01E02v2", 473125, 1, 2);
  assert.equal(r.parsed.version, 2);
  assert.equal(r.candidate!.aid, 19858);
});

test("[SubsPlease] Re Zero kara Hajimeru Isekai Seikatsu - 78 (1080p) → absolute 78 = S04E12", () => {
  expectEpisode("[SubsPlease] Re Zero kara Hajimeru Isekai Seikatsu - 78 (1080p)", 305089, 4, 12);
});

test("[ToonsHub] Dragon Ball Super Beerus S01E03 AMZN (Japanese Sub) → JP-market, no English, rejected", () => {
  const p = parseRelease("[ToonsHub] Dragon Ball Super Beerus S01E03 1080p AMZN WEB-DL (Japanese Sub)");
  assert.equal(p.hints.jpMarket, true);
  const r = rank("[ToonsHub] Dragon Ball Super Beerus S01E03 1080p AMZN WEB-DL (Japanese Sub)", "torrent");
  assert.equal(r.accept, false);
  assert.ok(r.flags.some((f) => f.key === "jpMarket"));
  expectEpisode("[ToonsHub] Dragon Ball Super Beerus S01E03 1080p AMZN WEB-DL (Japanese Sub)", 473154, 1, 3);
});

test("[7³ACG & ktnbytes] ... [BDRip 1080p AV1] → Chinese, rejected", () => {
  const r = rank("[7³ACG & ktnbytes] Sousou no Frieren S01 [BDRip 1080p AV1]", "torrent");
  assert.equal(r.accept, false);
  assert.ok(r.flags.some((f) => f.key === "chinese"));
});

test("VOSTFR → foreign-only, rejected for an English profile, preferred for a French one", () => {
  const name = "[Some-Team] Sousou no Frieren S2 - 05 VOSTFR [1080p]";
  const en = rank(name);
  assert.equal(en.accept, false);
  assert.ok(en.flags.some((f) => f.key === "foreign"));
  const fr = rankRelease(parseRelease(name), { protocol: "usenet", size: 1e9, episodeCount: 1 }, { ...PROFILE, subLangs: ["fr"] }, null);
  assert.equal(fr.accept, true);
  assert.ok(fr.langProb > 0.9);
});

test("(English-Sub) AMZN → burned-in English likely; ranks below a soft-sub release", () => {
  const burned = rank("[ToonsHub] Sousou no Frieren S02E05 1080p AMZN WEB-DL AAC2.0 H.264 (Sousou no Frieren 2nd Season, English-Sub)", "torrent");
  assert.ok(burned.flags.some((f) => f.key === "burnIn"), JSON.stringify(burned.flags));
  assert.equal(burned.accept, true); // last resort, not a rejection
  const soft = rank("[SubsPlease] Sousou no Frieren S2 - 05 (1080p) [ABCDEF12]", "torrent");
  assert.ok(soft.score > burned.score);
});

test("Usenet first, raws skipped, uncensored preferred", () => {
  const usenet = rank("[SubsPlease].Kyouran.Reijou.Nia.Liston.-.01.[1080p].[7F8BCA0B]-xpost", "usenet");
  const torrent = rank("[SubsPlease] Kyouran Reijou Nia Liston - 01 (1080p) [7F8BCA0B].mkv", "torrent");
  assert.ok(usenet.score > torrent.score);
  assert.equal(rank("[Ohys-Raws] Kyouran Reijou Nia Liston - 01 (AT-X 1280x720 x264 AAC).mp4", "torrent").accept, false);
  const unc = rank("[geckyzz] Click Me All Over - S01E03 (Mouse Cursor) [UNCENSORED, OVEIL]", "torrent");
  const cen = rank("[geckyzz] Click Me All Over - S01E03 (Mouse Cursor)", "torrent");
  assert.ok(unc.score > cen.score);
  assert.ok(unc.flags.some((f) => f.key === "uncensored"));
});

test("Learned table: a group's verified history drives the language estimate", () => {
  const p = parseRelease("[NewGroup] Some Show - 03 (1080p)");
  const info = { protocol: "usenet" as const, size: 1e9, episodeCount: 1 };
  const good = rankRelease(p, info, PROFILE, { total: 41, subs: { en: 41 }, origin: "verified" });
  const bad = rankRelease(p, info, PROFILE, { total: 20, subs: { en: 0, zh: 20 }, origin: "verified" });
  assert.ok(good.langProb > 0.95, String(good.langProb));
  assert.ok(good.why.includes("41/41"));
  assert.ok(bad.langProb < good.langProb);
});

test("Quanzhi Fashi VII - 05 → S07E05 via the unmapped AniDB entry 19920, inferred from its base title", () => {
  const r = expectEpisode("[NewGroup] Quanzhi Fashi VII - 05 (1080p)", 328670, 7, 5);
  assert.ok(r.resolution!.why.join(" ").length > 0);
});

/**
 * ACCEPTANCE (v0.1): "Full-Time Magister S6 is found by Deep Search."
 * Release names as Prowlarr returned them on 2026-10-25 (Nzb.su). Every one must map to the right S06Exx (the pack to
 * S06E01-E12), never to S01Exx or "whole season", and be flagged "English burned-in (720p)" once the user has confirmed
 * that season's only English source is hardsubbed. The live check is scripts/acceptance-magister.ts.
 */
test("ACCEPTANCE: Magister S6 Usenet releases map to S06Exx and are flagged English burned-in (720p)", () => {
  for (let n = 1; n <= 12; n++) {
    const name = `Quan.Zhi.Fa.Shi.S6.-.${String(n).padStart(2, "0")}`;
    const r = identify(name, ctx, { tvdbId: 328670 });
    assert.ok(r.resolution?.ok, `${name}: ${r.summary}`);
    assert.deepEqual(r.resolution!.episodes.map((e) => [e.season, e.episode]), [[6, n]], name);
    const rk = rankRelease(r.parsed, { protocol: "usenet", size: 450e6, episodeCount: 1 }, PROFILE, null, { burnedIn: { lang: "en", resolution: "720p", note: "you confirmed: Season 6 only exists with burned-in English" } });
    assert.equal(rk.accept, true, `${name}: ${rk.why}`);
    assert.ok(rk.flags.some((f) => f.label === "English burned-in (720p)"), `${name}: ${JSON.stringify(rk.flags)}`);
  }
  const pack = identify("Quan.Zhi.Fa.Shi.S6.-.1-12.-.Full-Time.Magister-xpost", ctx, { tvdbId: 328670 });
  assert.ok(pack.resolution?.ok, pack.summary);
  assert.deepEqual(pack.resolution!.episodes.map((e) => [e.season, e.episode]), Array.from({ length: 12 }, (_, i) => [6, i + 1]));
  assert.equal(pack.resolution!.label, "S06E01-E12");
});

test("Chinese 內嵌 (embedded) releases are flagged burned-in Chinese and rejected for an English profile", () => {
  const r = rank("【今晚月色真美】[女友的朋友 / 彼女の友達 / Kanojo no Tomodachi][04][WebRip][1080P][AVC-8bit][AAC][繁日內嵌][無修正]", "torrent");
  const p = parseRelease("【今晚月色真美】[女友的朋友 / 彼女の友達 / Kanojo no Tomodachi][04][WebRip][1080P][AVC-8bit][AAC][繁日內嵌][無修正]");
  assert.equal(p.hints.hardsub, true);
  assert.equal(p.hints.hardsubLang, "zh");
  assert.deepEqual(p.absolute, [4]);
  assert.equal(r.accept, false);
});

test("'2nd Season - 08' is one episode, not a batch (seen live on 2026-10-25)", () => {
  const p = parseRelease("[Erai-raws].Seirei.Gensouki.2nd.Season.-.08.[1080p.CR.WEBRip.HEVC.EAC3][MultiSub][792FACFC].mkv-[N-Z-B]-xpost");
  assert.equal(p.season, 2);
  assert.deepEqual(p.absolute, [8]);
  assert.equal(p.batch, false);
  assert.equal(p.fullSeason, false);
});
