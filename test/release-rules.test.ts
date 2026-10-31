/** Release rules: term matching, must / must-not semantics, tag scoping, preferred scores in ranking, validation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRelease } from "../server/core/parser.js";
import { rankRelease, type Profile } from "../server/core/rank.js";
import { applyRules, compileTerm, PREFERRED_CAP, type ReleaseRule } from "../server/core/rules.js";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-rules-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { db } = await import("../server/db.js");
const { createTag, setTags, deleteTag } = await import("../server/tags.js");
const { deleteRule, listRules, releaseRulesFor, saveRule, testRules } = await import("../server/releaseRules.js");

const rule = (p: Partial<ReleaseRule>): ReleaseRule => ({ id: "r", name: "Rule", enabled: true, must: [], mustNot: [], preferred: [], tags: [], ...p });
const base: Profile = { subLangs: ["en"], dubLangs: ["en"], watchMode: "sub", originalLangs: ["ja"], softOnly: true, preferUncensored: true, protocolOrder: ["usenet", "torrent"], resolution: 1080 };
const info = { protocol: "usenet" as const, size: 1.2e9, episodeCount: 1 };
const rank = (name: string, rules: ReleaseRule[]) => rankRelease(parseRelease(name), info, base, null, { rules });

test("terms: plain text is a case-insensitive substring; /regex/ is a case-insensitive regular expression", () => {
  const plain = compileTerm("HEVC");
  assert.ok("test" in plain && plain.test("[Grp] Show - 01 [1080p][hevc]") && !plain.test("[Grp] Show - 01 [1080p][x264]"));
  const re = compileTerm("/\\b(x265|hevc)\\b/i");
  assert.ok("test" in re && re.test("Show 1080p X265-GRP") && re.test("Show hevc") && !re.test("Show x2650"));
});

test("invalid regular expressions are refused with a clear message, and runaway ones too", () => {
  const bad = compileTerm("/(unclosed/");
  assert.ok("error" in bad && /isn't a valid regular expression/.test(bad.error), JSON.stringify(bad));
  assert.ok("error" in compileTerm("/(a+)+$/"));
  assert.ok("error" in compileTerm("   "));
  assert.throws(() => saveRule(null, { name: "Bad", mustNot: ["/[/"] }), /Must not contain: .*valid regular expression/);
  assert.equal(listRules().length, 0, "nothing saved");
});

test("must: the name needs at least one of the terms; mustNot: none may appear", () => {
  const r = rule({ must: ["1080p", "/2160p/"], mustNot: ["x265"] });
  assert.equal(applyRules("Show 1080p WEB", [r]).reject, null);
  assert.equal(applyRules("Show 2160p WEB", [r]).reject, null);
  assert.match(applyRules("Show 720p WEB", [r]).reject!, /Blocked by release rule 'Rule': lacks any of '1080p', '\/2160p\/'/);
  assert.equal(applyRules("Show 1080p x265", [r]).reject, "Blocked by release rule 'Rule': contains 'x265'");
  assert.equal(applyRules("anything", [rule({ enabled: false, mustNot: ["anything"] })]).reject, null, "a disabled rule does nothing");
  assert.equal(applyRules("anything", [rule({})]).reject, null, "an empty rule blocks nothing");
});

test("ranking: a blocking rule rejects the release with its reason in plain words, and the flag shows", () => {
  const ok = rank("[SubsPlease] Show - 05 (1080p) [x264]", [rule({ name: "No HEVC", mustNot: ["x265", "hevc"] })]);
  assert.equal(ok.accept, true);
  const blocked = rank("[SubsPlease] Show - 05 (1080p) [x265]", [rule({ name: "No HEVC", mustNot: ["x265", "hevc"] })]);
  assert.equal(blocked.accept, false);
  assert.equal(blocked.reject, "Blocked by release rule 'No HEVC': contains 'x265'");
  assert.match(blocked.why, /skipped: Blocked by release rule 'No HEVC'/);
  assert.ok(blocked.flags.some((f) => f.key === "rule"));
});

test("preferred terms add their score (negative counts against) but only as a capped nudge", () => {
  const rules = [rule({ preferred: [{ term: "Judas", score: 5 }, { term: "/\\bweb\\b/", score: -3 }, { term: "huge", score: 100 }] })];
  const plain = rank("[Judas] Show - 05 (1080p) WEB", []);
  const nudged = rank("[Judas] Show - 05 (1080p) WEB", rules);
  assert.equal(nudged.score - plain.score, 2, "5 - 3");
  assert.match(nudged.why, /release rule 'Rule': Judas \(\+5\)/);
  assert.equal(applyRules("huge", rules).score, PREFERRED_CAP, "capped");
});

test("preferred scores never override the language fit or rescue a blocked release", () => {
  const rules = [rule({ preferred: [{ term: "Spanish", score: 100 }] })];
  const en = rank("[SubsPlease] Show - 05 (1080p)", rules);
  const es = rank("[Group] Show - 05 (1080p) Spanish", rules);
  const none = rank("[Group] Show - 05 (1080p) Spanish", []);
  assert.ok(es.score - none.score <= PREFERRED_CAP);
  assert.ok(en.score > es.score, "the named-English release still wins");
  const blocked = rank("[SubsPlease] Show - 05 (1080p) x265", [rule({ mustNot: ["x265"], preferred: [{ term: "SubsPlease", score: 100 }] })]);
  assert.equal(blocked.accept, false);
});

test("tag scoping: a tagged rule applies only to shows carrying the tag; an untagged rule applies to all", () => {
  const dubs = createTag("dubs only");
  setTags("series", 1, [dubs.id]);
  setTags("movie", 9, [dubs.id]);
  saveRule(null, { name: "Everyone", mustNot: ["sample"] });
  saveRule(null, { name: "Dub shows", mustNot: ["/\\bjpn\\b/"], tags: [dubs.id] });
  assert.deepEqual(releaseRulesFor("series", 1).map((r) => r.name), ["Everyone", "Dub shows"]);
  assert.deepEqual(releaseRulesFor("series", 2).map((r) => r.name), ["Everyone"]);
  assert.deepEqual(releaseRulesFor("movie", 9).map((r) => r.name), ["Everyone", "Dub shows"]);
  assert.equal(testRules("Show 1080p JPN", { kind: "series", ref: 2 }).rejected, null);
  assert.match(testRules("Show 1080p JPN", { kind: "series", ref: 1 }).rejected!, /'Dub shows'/);
  assert.equal(testRules("Show sample", undefined).matches.length, 2, "without a show, every enabled rule is tested");
});

test("rules are saved with trimmed, de-duplicated terms and survive a reload; deleting a tag unscopes the rule", () => {
  const r = saveRule(null, { name: " Mixed ", must: [" 1080p ", "1080P", ""], preferred: [{ term: "Judas", score: 3.4 }] });
  assert.equal(r.name, "Mixed");
  assert.deepEqual(r.must, ["1080p"]);
  assert.deepEqual(listRules().find((x) => x.id === r.id)!.preferred, [{ term: "Judas", score: 3 }]);
  assert.throws(() => saveRule(null, { name: "No score", preferred: [{ term: "x", score: NaN }] }), /give "x" a score/);
  const tag = createTag("temp");
  const scoped = saveRule(r.id, { tags: [tag.id] });
  assert.deepEqual(scoped.tags, [tag.id]);
  deleteTag(tag.id);
  assert.deepEqual(listRules().find((x) => x.id === r.id)!.tags, [], "the rule now applies to everyone again");
  deleteRule(r.id);
  assert.equal(listRules().some((x) => x.id === r.id), false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM release_rule_tags WHERE rule_id = ?").get(r.id) as { n: number }).n, 0);
});
