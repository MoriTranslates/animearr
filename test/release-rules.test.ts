/** Release rules: term matching, must / must-not semantics, tag scoping, preferred scores in ranking, validation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRelease } from "../server/core/parser.js";
import { rankRelease, type Profile } from "../server/core/rank.js";
import { applyRules, compileTerm, guardedRegexRuns, PREFERRED_CAP, type ReleaseRule } from "../server/core/rules.js";

process.env.ANIMEARR_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-rules-"));
process.env.ANIMEARR_NO_LOCK = "1";
const { db } = await import("../server/system/db.js");
const { createTag, setTags, deleteTag } = await import("../server/library/tags.js");
const { deleteRule, listRules, releaseRulesFor, saveRule, testRules } = await import("../server/search/releaseRules.js");

const rule = (p: Partial<ReleaseRule>): ReleaseRule => ({
  id: "r",
  name: "Rule",
  enabled: true,
  must: [],
  mustNot: [],
  preferred: [],
  tags: [],
  ...p,
});
const base: Profile = {
  subLangs: ["en"],
  dubLangs: ["en"],
  watchMode: "sub",
  originalLangs: ["ja"],
  softOnly: true,
  preferUncensored: true,
  protocolOrder: ["usenet", "torrent"],
  resolution: 1080,
};
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

test("a runaway regex the static check misses can't hang the server, and it fails closed", () => {
  // Both pass the nested-repeat check, and both backtrack exponentially (30 characters: seconds; a long title: forever).
  const runaway = ["/((a+))+$/", "/(a|a)*b/"];
  for (const t of runaway) assert.ok("test" in compileTerm(t), `${t} passes the static check`);
  const title = "a".repeat(30) + "!";
  const r = rule({ mustNot: runaway, preferred: [{ term: "/(a|aa)+$/", score: 5 }] });
  const t0 = Date.now();
  const first = applyRules(title, [r]);
  for (let i = 0; i < 20; i++) applyRules(title, [r]); // later calls skip the term at once
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, `took ${ms} ms`);
  // Must not contain: a term that couldn't be checked counts as present, so the release stays blocked.
  assert.match(first.reject ?? "", /Blocked by release rule 'Rule': contains '\/\(\(a\+\)\)\+\$\/' \(took too long to check\)/);
  // Must contain: it counts as absent, so the release is blocked too.
  assert.match(applyRules(title, [rule({ must: ["/((a+))+$/"] })]).reject ?? "", /lacks any of/);
  // Preferred: it scores nothing; other preferred terms still count.
  const pref = applyRules(title, [
    rule({
      preferred: [
        { term: "/(a|aa)+$/", score: 5 },
        { term: "aaa", score: 2 },
      ],
    }),
  ]);
  assert.equal(pref.reject, null);
  assert.equal(pref.score, 2);
  // Ordinary regexes keep working, also after a runaway one was cut off.
  assert.notEqual(applyRules("Show 1080p x265", [rule({ mustNot: ["/x26[45]/"] })]).reject, null);
  assert.equal(applyRules("Show 1080p x264", [rule({ mustNot: ["/x265/"] })]).reject, null);
});

test("adjacent overlapping repeats run guarded, and terms over 1,024 characters are refused on save (review misc round 2 #1)", () => {
  // The quadratic shape now goes through the time-limited path, so a long title can't freeze the event loop for long.
  const quad = compileTerm("/[a-z]*[a-z]*x/");
  assert.ok("test" in quad);
  const before = guardedRegexRuns();
  const t0 = Date.now();
  quad.test("a".repeat(20000));
  assert.ok(guardedRegexRuns() > before, "ran through the guarded path");
  assert.ok(Date.now() - t0 < 1500, `quadratic term took ${Date.now() - t0} ms`);
  // Length cap: 1,024 characters is allowed, 1,025 is refused with a clear message.
  assert.ok("test" in compileTerm("/" + "a".repeat(1022) + "/"), "1,024 characters is accepted");
  const long = compileTerm("/" + "a".repeat(1023) + "/");
  assert.ok("error" in long && /at most 1024 characters/.test(long.error), JSON.stringify(long));
  assert.throws(() => saveRule(null, { name: "Long", must: ["/" + "a".repeat(1100) + "/"] }), /at most 1024 characters/);
});

test("a realistic search (500 releases x 5 regex terms) with every regex guarded: results are right and the cost is printed", () => {
  const terms = ["/(1080p|720p).*(x26[45])/", "/\\bHEVC\\b/", "/S\\d+E\\d+/", "/^\\[(SubsPlease|Erai-raws)\\]/", "/web-?dl/"];
  const r = rule({ mustNot: terms.slice(0, 2), must: terms.slice(2, 4), preferred: [{ term: terms[4], score: 1 }] });
  const before = guardedRegexRuns();
  const t0 = Date.now();
  for (let i = 0; i < 500; i++) applyRules(`[SubsPlease] Show S01E${i} 1080p WEB-DL x264 ${"pad ".repeat(10)}`, [r]);
  const ms = Date.now() - t0;
  console.log(`PERF: 500 releases x 5 guarded regex terms took ${ms} ms (${guardedRegexRuns() - before} guarded runs)`);
  assert.ok(guardedRegexRuns() > before, "regex terms go through the guarded runner");
  assert.ok(ms < 20000, `took ${ms} ms`); // loose tolerance; the real number is printed above
  assert.equal(
    applyRules("[SubsPlease] Show S01E05 1080p x265", [r]).reject,
    "Blocked by release rule 'Rule': contains '/(1080p|720p).*(x26[45])/'",
  );
  // A runaway term is cut off and fails closed.
  const t1 = Date.now();
  const slow = applyRules("c".repeat(30) + "!", [rule({ mustNot: ["/((c+))+$/"] })]);
  assert.ok(Date.now() - t1 < 1500, `runaway took ${Date.now() - t1} ms`);
  assert.match(slow.reject ?? "", /took too long to check/);
});

test("the first time a rule's term takes too long, one warning names the rule and the term", () => {
  const term = "/((b+))+$/";
  const saved = saveRule(null, { name: "Slow rule", mustNot: [term] });
  const before = (db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE kind = 'rule' AND why LIKE ?").get(`%${term}%`) as { n: number }).n;
  for (let i = 0; i < 3; i++) assert.ok(testRules("b".repeat(30) + "!").rejected);
  const rows = db.prepare("SELECT why FROM decisions WHERE kind = 'rule' AND why LIKE ?").all(`%${term}%`) as { why: string }[];
  assert.equal(rows.length - before, 1, JSON.stringify(rows));
  assert.match(rows.at(-1)!.why, /Slow rule/);
  // The advice must be what actually works: saving an unchanged rule no longer clears the mark.
  assert.match(rows.at(-1)!.why, /edit the term, or restart AnimeArr/i);
  assert.doesNotMatch(rows.at(-1)!.why, /re-?save/i);
  deleteRule(saved.id);
});

test("one timeout doesn't disable a term for good; repeated ones do, until the term is edited in (review misc #2)", () => {
  // "/(d|d)*e/" is fine on ordinary names but runs away on a long run of "d": one heavy name stands in for a
  // timeout under CPU load.
  const term = "/(d|d)*e/";
  const r = rule({ mustNot: [term] });
  const heavy = "d".repeat(30) + "!";
  // That one check fails closed...
  assert.match(applyRules(heavy, [r]).reject ?? "", /took too long to check/);
  // ...but the term keeps working for the next names (it used to be skipped, i.e. blocking, until a restart).
  assert.equal(applyRules("Show - 05 [1080p]", [r]).reject, null);
  assert.match(applyRules("Show - 05 [de]", [r]).reject ?? "", /contains '\/\(d\|d\)\*e\/'$/);
  // Three timeouts in a short window: the term is marked, and every name is blocked (fail closed) without running it.
  applyRules(heavy, [r]);
  applyRules(heavy, [r]);
  // Counted, not timed: a wall-clock bound like 20 ms flakes on a loaded machine (a GC pause or a busy disk).
  const runsBefore = guardedRegexRuns();
  assert.match(applyRules("Show - 06 [1080p]", [r]).reject ?? "", /took too long to check/);
  assert.equal(guardedRegexRuns(), runsBefore, "a marked term isn't run again");
  // Adding the term to a rule afresh (an edit) clears the mark.
  const saved = saveRule(null, { name: "Marked rule", mustNot: [term] });
  assert.equal(testRules("Show - 07 [1080p]").rejected, null);
  deleteRule(saved.id);
});

test("saving a rule only gives its newly added terms a fresh start (review misc round 2 #3)", () => {
  const term = "/(f|f)*g/";
  const heavy = "f".repeat(30) + "!";
  const a = saveRule(null, { name: "Keep marked", mustNot: [term] });
  for (let i = 0; i < 3; i++) applyRules(heavy, [rule({ mustNot: [term] })]);
  assert.ok(testRules("Show - 08 [1080p]").rejected, "the term is marked as runaway");
  // Renaming the rule leaves its unchanged term marked.
  saveRule(a.id, { name: "Keep marked (renamed)" });
  assert.ok(testRules("Show - 08 [1080p]").rejected, "an unchanged term stays marked");
  // Another rule that uses the same term text doesn't un-mark it.
  const b = saveRule(null, { name: "Other rule", mustNot: [term] });
  assert.ok(testRules("Show - 08 [1080p]").rejected, "saving another rule doesn't clear a shared term");
  deleteRule(b.id);
  deleteRule(a.id);
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
  const rules = [
    rule({
      preferred: [
        { term: "Judas", score: 5 },
        { term: "/\\bweb\\b/", score: -3 },
        { term: "huge", score: 100 },
      ],
    }),
  ];
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
  const blocked = rank("[SubsPlease] Show - 05 (1080p) x265", [
    rule({ mustNot: ["x265"], preferred: [{ term: "SubsPlease", score: 100 }] }),
  ]);
  assert.equal(blocked.accept, false);
});

test("tag scoping: a tagged rule applies only to shows carrying the tag; an untagged rule applies to all", () => {
  const dubs = createTag("dubs only");
  setTags("series", 1, [dubs.id]);
  setTags("movie", 9, [dubs.id]);
  saveRule(null, { name: "Everyone", mustNot: ["sample"] });
  saveRule(null, { name: "Dub shows", mustNot: ["/\\bjpn\\b/"], tags: [dubs.id] });
  assert.deepEqual(
    releaseRulesFor("series", 1).map((r) => r.name),
    ["Everyone", "Dub shows"],
  );
  assert.deepEqual(
    releaseRulesFor("series", 2).map((r) => r.name),
    ["Everyone"],
  );
  assert.deepEqual(
    releaseRulesFor("movie", 9).map((r) => r.name),
    ["Everyone", "Dub shows"],
  );
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
  assert.equal(
    listRules().some((x) => x.id === r.id),
    false,
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM release_rule_tags WHERE rule_id = ?").get(r.id) as { n: number }).n, 0);
});

test("every user regex goes through the guarded runner: exponential and quadratic shapes are never run directly (blind review misc final High)", () => {
  // The review's shape: "a?" N times, "a" N times, then "b". Small N here so even unguarded code can't hang the run.
  const n = 18;
  const expo = "/" + "a?".repeat(n) + "a".repeat(n) + "b/";
  for (const src of [expo, "/.*a.*b/", "/S\\d+E\\d+/", "/web-?dl/"]) {
    const c = compileTerm(src);
    assert.ok("test" in c, src);
    const before = guardedRegexRuns();
    c.test("a".repeat(n));
    assert.equal(guardedRegexRuns() - before, 1, `${src} went through the guarded runner`);
  }
  // Plain-text terms stay direct: no guard needed.
  const plain = compileTerm("1080p");
  assert.ok("test" in plain);
  const before = guardedRegexRuns();
  assert.equal(plain.test("Show 1080p"), true);
  assert.equal(guardedRegexRuns(), before);
});

test("the time limit really interrupts a runaway regex: the review's N=50 shape fails closed fast, with a strike (blind review misc final High)", () => {
  // Unguarded (or with a vm timeout, which V8 only checks after the regex returns) this one match blocks ~9-12 s.
  const n = 50;
  const term = "/" + "a?".repeat(n) + "a".repeat(n) + "b/";
  const r = rule({ mustNot: [term] });
  const t0 = Date.now();
  assert.match(applyRules("a".repeat(n), [r]).reject ?? "", /took too long to check/);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `took ${ms} ms`); // limit is 50 ms; the tolerance covers starting a worker on a loaded machine
  // That timeout was a strike: two more (shorter heavy names, so the killed workers finish sooner) mark the term.
  applyRules("a".repeat(40), [r]);
  applyRules("a".repeat(40), [r]);
  const before = guardedRegexRuns();
  assert.match(applyRules("Show - 09 [1080p]", [r]).reject ?? "", /took too long to check/);
  assert.equal(guardedRegexRuns(), before, "three strikes marked the term, so it isn't run again");
  // The guard is still good for other terms after its worker was killed.
  const ok = compileTerm("/S[0-9]+E[0-9]+/");
  assert.ok("test" in ok);
  assert.equal(ok.test("Show S01E02"), true);
  assert.equal(ok.test("Show 1080p"), false);
});
