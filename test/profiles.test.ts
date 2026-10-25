/** Language profiles and watch modes: ranking, verification, migration and per-show overrides. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRelease } from "../server/core/parser.js";
import { rankRelease, type Profile } from "../server/core/rank.js";
import { judge } from "../server/verify.js";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-prof-"));
process.env.ANIMEARR_NO_LOCK = "1";

const base: Profile = { subLangs: ["en"], dubLangs: ["en"], watchMode: "sub", originalLangs: ["ja"], softOnly: true, preferUncensored: true, protocolOrder: ["usenet", "torrent"], resolution: 1080 };
const info = { protocol: "usenet" as const, size: 1.2e9, episodeCount: 1 };
const rank = (name: string, p: Partial<Profile> = {}) => rankRelease(parseRelease(name), info, { ...base, ...p }, null);

test("sub mode (default): English dub-only is rejected; dual audio is a bonus, never a penalty", () => {
  assert.equal(rank("[Group] Show - 05 (English Dub) [1080p]").accept, false);
  const plain = rank("[SubsPlease] Show - 05 (1080p)");
  const dual = rank("[EMBER] Show S01E05 [1080p] [Dual Audio HEVC WEBRip]");
  assert.equal(dual.accept, true);
  assert.ok(dual.flags.some((f) => f.key === "dual"));
  assert.ok(dual.score >= plain.score - 5, "dual audio doesn't lose to a plain sub release");
});

test("sub mode for a donghua: Mandarin audio is the ORIGINAL audio, not a dub", () => {
  const r = rankRelease(parseRelease("[GM-Team] Quan Zhi Fa Shi S6 - 05 [Mandarin] [ENG SUB] [1080p]"), info, { ...base, originalLangs: ["zh"] }, null);
  assert.equal(r.accept, true, r.why);
});

test("dub mode: needs the dub; a sub-only release is rejected", () => {
  assert.equal(rank("[SubsPlease] Show - 05 (1080p)", { watchMode: "dub" }).accept, false);
  const d = rank("[Group] Show S01E05 1080p (English Dub)", { watchMode: "dub" });
  assert.equal(d.accept, true);
  assert.ok(d.flags.some((f) => /English dub/.test(f.label)));
});

test("dual mode: dual audio is wanted; a sub-only release is a placeholder", () => {
  const dual = rank("[EMBER] Show S01E05 [1080p] [Dual Audio HEVC WEBRip]", { watchMode: "dual" });
  const subOnly = rank("[SubsPlease] Show - 05 (1080p)", { watchMode: "dual" });
  assert.equal(subOnly.accept, true);
  assert.ok(subOnly.flags.some((f) => f.key === "placeholder"));
  assert.ok(dual.score > subOnly.score);
});

test("either mode: sub or dub, whichever", () => {
  assert.equal(rank("[SubsPlease] Show - 05 (1080p)", { watchMode: "either" }).accept, true);
  assert.equal(rank("[Group] Show S01E05 1080p (English Dub)", { watchMode: "either" }).accept, true);
  assert.equal(rank("[Ohys-Raws] Show - 05 (AT-X 1280x720)", { watchMode: "either" }).accept, false);
});

test("pt-br profile matches Portuguese hints", () => {
  const r = rank("[Group] Show - 05 [LEGENDADO] [1080p]", { subLangs: ["pt-br"] });
  assert.equal(r.accept, true, r.why);
});

const probe = (o: Partial<Parameters<typeof judge>[0]>) => ({ subs: [], audio: ["ja"], durationSec: 1400, sidecars: [], untagged: 0, ...o });

test("verify: a forced/signs-only English track is NOT English subtitles (Black Clover case)", () => {
  const v = judge(probe({ subs: [], forced: ["en"] }), base, 24, null);
  assert.equal(v.ok, false);
  assert.match(v.why, /forced\/signs en track/);
  assert.equal(judge(probe({ subs: ["en"], forced: [] }), base, 24, null).ok, true);
});

test("verify: sub mode rejects a dub without the original audio; und audio counts as unknown", () => {
  assert.equal(judge(probe({ subs: ["en"], audio: ["en"] }), base, 24, null).ok, false);
  assert.equal(judge(probe({ subs: ["en"], audio: ["und"] }), base, 24, null).ok, true);
});

test("verify: dub, dual and either modes", () => {
  assert.equal(judge(probe({ audio: ["ja", "en"] }), { ...base, watchMode: "dub" }, 24, null).ok, true);
  assert.equal(judge(probe({ subs: ["en"] }), { ...base, watchMode: "dub" }, 24, null).ok, false);
  assert.match(judge(probe({ subs: ["en"] }), { ...base, watchMode: "dual" }, 24, null).why, /placeholder|sub only/);
  assert.equal(judge(probe({ audio: ["en"] }), { ...base, watchMode: "either" }, 24, null).ok, true);
});

test("profiles: the old single profile migrates to the seeded default; per-show watch-mode override", async () => {
  const { db, cache } = await import("../server/db.js");
  const { seal } = await import("../server/secretbox.js");
  // An 0.1 settings row with the old single "profile".
  db.prepare("INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(seal(JSON.stringify({ profile: { subLangs: ["en"], audioLangs: ["ja"], softOnly: true, preferUncensored: true, protocolOrder: ["usenet", "torrent"], resolution: 1080 } })));
  const { getSettings } = await import("../server/settings.js");
  const s = getSettings();
  assert.equal(s.profiles.length, 1);
  assert.equal(s.profiles[0].name, "English subs (default)");
  assert.equal(s.profiles[0].watchMode, "sub");
  assert.equal(s.defaultProfileId, "default");
  const { profileFor, setSeriesPrefs, saveProfile, deleteProfile } = await import("../server/profiles.js");
  cache.prepare("INSERT INTO series (id, tvdb_id, title, path, monitored, original_language, synced_at) VALUES (1, 700001, 'Donghua', '/media/AnimeArr/Donghua', 0, 'Chinese', 0)").run();
  assert.deepEqual(profileFor(700001).originalLangs, ["zh"]);
  setSeriesPrefs(700001, null, "dual");
  assert.equal(profileFor(700001).watchMode, "dual");
  assert.equal(profileFor(700001).source, "show");
  const pt = saveProfile(null, { name: "Portuguese (Brazil)", subLangs: ["pt-BR"], dubLangs: ["pt-BR"], watchMode: "either" });
  assert.deepEqual(pt.subLangs, ["pt-br"]);
  setSeriesPrefs(700001, pt.id, null);
  assert.equal(profileFor(700001).name, "Portuguese (Brazil)");
  assert.throws(() => deleteProfile("default"), /default profile/);
  deleteProfile(pt.id);
  assert.equal(profileFor(700001).name, "English subs (default)", "shows using a deleted profile fall back to the default");
  assert.throws(() => saveProfile(null, { name: "No langs", subLangs: [], watchMode: "sub" }), /subtitle language/);
});

test("review fixes: forced sidecars, full-dialogue titles, cmn audio, either/dual edge cases", async () => {
  const { sidecarLang, toLang } = await import("../server/core/langs.js");
  const { PARTIAL_TRACK } = await import("../server/verify.js");
  assert.equal(sidecarLang("Show - S01E01.eng.forced.srt"), null);
  assert.equal(sidecarLang("Show - S01E01.en.signs.ass"), null);
  assert.equal(sidecarLang("Show - S01E01.en.ass"), "en");
  assert.equal(PARTIAL_TRACK.test("Signs & Songs"), true);
  assert.equal(PARTIAL_TRACK.test("English (Forced)"), true);
  assert.equal(PARTIAL_TRACK.test("English"), false);
  assert.equal(toLang("cmn"), "zh");
  // donghua whose audio is tagged cmn: not a "dub"
  assert.equal(judge(probe({ subs: ["en"], audio: [toLang("cmn")] }), { ...base, originalLangs: ["zh"] }, 24, null).ok, true);
  // unknown original language: no original-audio check
  assert.equal(judge(probe({ subs: ["en"], audio: ["th"] }), { ...base, originalLangs: [] }, 24, null).ok, true);
  // either: a German dub without the original audio and no wanted subs is not acceptable
  assert.equal(rank("[Group] Show S01E05 1080p German Dubbed", { watchMode: "either" }).accept, false);
  // dual with a Portuguese dub profile: an ja+en dual-audio title isn't the wanted dub
  const r = rank("[EMBER] Show S01E05 [1080p] [Dual Audio]", { watchMode: "dual", subLangs: ["pt"], dubLangs: ["pt"] });
  assert.ok(!r.flags.some((f) => /Portuguese dub/.test(f.label)), JSON.stringify(r.flags));
});
