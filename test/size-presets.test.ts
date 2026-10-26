/** Size presets in ranking: Lean caps, Balanced prefers WEB-DL, Best source prefers REMUX / big BD / lossless audio. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRelease } from "../server/core/parser.js";
import { compareRanked, rankRelease, type Profile } from "../server/core/rank.js";

const base: Profile = { subLangs: ["en"], softOnly: true, preferUncensored: true, protocolOrder: ["usenet", "torrent"], resolution: 1080 };
const learned = { total: 40, subs: { en: 40 }, origin: "verify" };
const rank = (title: string, gb: number, sizePreset: Profile["sizePreset"]) => ({ title, rank: rankRelease(parseRelease(title), { protocol: "usenet", size: gb * 1e9, episodeCount: 1, runtimeMin: 24 }, { ...base, sizePreset }, learned) });

const web = "[SubsPlease] Frieren - 05 (1080p) [WEB-DL]";
const bd = "[Group] Frieren - 05 (BD 1080p FLAC)";
const remux = "Frieren.S01E05.1080p.BluRay.REMUX.AVC.FLAC.2.0-GRP";
const mini = "[Judas] Frieren - 05 (1080p HEVC x265 10bit)";

test("Lean puts releases over ~2 GB per 24 min behind smaller ones and says why", () => {
  const big = rank(bd, 6, "lean");
  const small = rank(web, 1.4, "lean");
  assert.ok(small.rank.score > big.rank.score);
  assert.match(big.rank.why, /over the Lean size/);
  assert.ok(big.rank.accept, "a penalty, not a rejection (it is still the fallback)");
});

test("Balanced prefers WEB-DL and has no cap", () => {
  const w = rank(web, 1.4, "balanced");
  const b = rank(bd, 6, "balanced");
  assert.match(w.rank.why, /WEB-DL/);
  assert.doesNotMatch(b.rank.why, /over the Lean size/);
});

test("Best source: REMUX > high-bitrate BD > WEB-DL > mini re-encode", () => {
  const list = [rank(mini, 0.4, "best"), rank(web, 1.4, "best"), rank(bd, 6, "best"), rank(remux, 12, "best")].sort(compareRanked);
  assert.deepEqual(list.map((x) => x.title), [remux, bd, web, mini]);
  assert.match(list[0].rank.why, /REMUX/);
  assert.match(list[3].rank.why, /small re-encode/);
});
