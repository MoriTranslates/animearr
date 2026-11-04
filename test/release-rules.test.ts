/** Release rules: term matching, must / must-not semantics, tag scoping, preferred scores in ranking, validation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseRelease } from "../server/core/parser.js";
import { rankRelease, type Profile } from "../server/core/rank.js";
import { applyRules, clearCompiledTerms, compileTerm, PREFERRED_CAP, type ReleaseRule } from "../server/core/rules.js";
import { foldCase, forceLinearEngineForTests, LINEAR_FLAG } from "../server/core/linearRegex.js";

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

test("invalid regular expressions are refused with a clear message", () => {
  const bad = compileTerm("/(unclosed/");
  assert.ok("error" in bad && /isn't a valid regular expression/.test(bad.error), JSON.stringify(bad));
  assert.ok("error" in compileTerm("   "));
  assert.throws(() => saveRule(null, { name: "Bad", mustNot: ["/[/"] }), /Must not contain: .*valid regular expression/);
  assert.equal(listRules().length, 0, "nothing saved");
});

test("the review's exponential pattern (N=50) runs in linear time on a 100 KB name and can't hang anything (blind review misc round 3 High)", () => {
  const n = 50;
  const expo = compileTerm("/" + "a?".repeat(n) + "a".repeat(n) + "b/");
  assert.ok("test" in expo, "it compiles on the linear engine");
  for (const src of ["/((a+))+$/", "/(a|a)*b/", "/(a|aa)+$/", "/.*a.*b/", "/[a-z]*[a-z]*x/"]) {
    const c = compileTerm(src);
    assert.ok("test" in c, `${src} is accepted: on the linear engine it is harmless`);
  }
  const huge = "a".repeat(100_000);
  const t0 = Date.now();
  assert.equal(expo.test(huge), false);
  for (const src of ["/((a+))+$/", "/(a|a)*b/", "/(a|aa)+$/", "/.*a.*b/", "/[a-z]*[a-z]*x/"]) {
    const c = compileTerm(src);
    if ("test" in c) c.test(huge + "!");
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 1000 * 6, `6 runaway shapes on 100 KB took ${ms} ms`); // under 1 s each, loose for a loaded machine
  // Still a real matcher: the same term matches when it should.
  assert.equal(expo.test("a".repeat(n) + "b"), true);
});

test("patterns the linear engine can't run (backreferences, lookaheads, big counted repeats) are refused on save", () => {
  for (const src of ["/(a)\\1/", "/(?<g>x)\\k<g>/", "/x26(?=5)/", "/x26(?!4)/", "/.{0,30}/", "/(?i:hevc)/"]) {
    const c = compileTerm(src);
    assert.ok("error" in c, src);
    assert.match(c.error, /this pattern uses features AnimeArr can't run safely \(backreferences\/lookarounds\); rewrite it without them/);
    assert.throws(() => saveRule(null, { name: "Unsafe", mustNot: [src] }), /Must not contain: .*can't run safely/);
  }
  assert.equal(listRules().length, 0, "nothing saved");
  // The 1,024-character cap stays: 1,024 is accepted, 1,025 is refused with a clear message.
  assert.ok("test" in compileTerm("/" + "a".repeat(1022) + "/"), "1,024 characters is accepted");
  const long = compileTerm("/" + "a".repeat(1023) + "/");
  assert.ok("error" in long && /at most 1024 characters/.test(long.error), JSON.stringify(long));
  assert.throws(() => saveRule(null, { name: "Long", must: ["/" + "a".repeat(1100) + "/"] }), /at most 1024 characters/);
});

test("a stored term the linear engine refuses is skipped, fails closed, and is warned about once", () => {
  const term = "/(x26)\\1/";
  const saved = saveRule(null, { name: "Old rule", mustNot: ["x264"] });
  // As if saved by an older AnimeArr that didn't refuse it.
  db.prepare("UPDATE release_rules SET must_not = ?, must = ? WHERE id = ?").run(JSON.stringify([term]), JSON.stringify([]), saved.id);
  const before = (db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE kind = 'rule' AND why LIKE ?").get(`%${term}%`) as { n: number }).n;
  for (let i = 0; i < 3; i++) assert.match(testRules("Show - 01 [1080p]").rejected ?? "", /'Old rule': contains .*can't be run safely/);
  const rows = db.prepare("SELECT why FROM decisions WHERE kind = 'rule' AND why LIKE ?").all(`%${term}%`) as { why: string }[];
  assert.equal(rows.length - before, 1, JSON.stringify(rows));
  assert.match(rows.at(-1)!.why, /Old rule.*skipped.*can't run safely/);
  // Must contain: the term counts as missing. Preferred: it scores nothing.
  assert.match(applyRules("x26x26", [rule({ must: [term] })]).reject ?? "", /lacks any of/);
  assert.equal(applyRules("x26x26", [rule({ preferred: [{ term, score: 5 }] })]).score, 0);
  deleteRule(saved.id);
});

test("without the linear engine, regex terms fail closed and are refused on save; plain text still works", () => {
  forceLinearEngineForTests(false);
  clearCompiledTerms();
  try {
    const c = compileTerm("/x265/");
    assert.ok("error" in c && /safe regular-expression engine isn't available/.test(c.error), JSON.stringify(c));
    assert.throws(() => saveRule(null, { name: "No engine", mustNot: ["/x265/"] }), /isn't available/);
    assert.match(
      applyRules("Show 1080p x264", [rule({ mustNot: ["/x265/"] })]).reject ?? "",
      /contains '\/x265\/' \(this term can't be run safely/,
    );
    assert.match(applyRules("Show 1080p x265", [rule({ must: ["/x265/"] })]).reject ?? "", /lacks any of/);
    assert.equal(applyRules("Show 1080p x264", [rule({ mustNot: ["x265"] })]).reject, null, "plain text is unaffected");
  } finally {
    forceLinearEngineForTests(null);
    clearCompiledTerms();
  }
  assert.ok("test" in compileTerm("/x265/"));
});

test("ordinary patterns match exactly as the case-insensitive backtracking engine did", () => {
  const R = String.raw;
  const patterns = [
    R`S\d+E\d+`,
    R`\b(x265|hevc)\b`,
    R`^\[(SubsPlease|Erai-raws)\]`,
    "web-?dl",
    "(1080p|720p).*(x26[45])",
    "[a-f]+",
    "[^a-z0-9 ]",
    "[A-Z]{2,3}",
    R`[\w-]+\.mkv$`,
    R`\x4a\x55DAS`,
    "(?<group>judas)",
    R`(?<=\d)p`,
    R`(?<!x)264`,
    "[a-]z",
    "[--z]",
    R`[\d-z]`,
    R`\bBD\b|\bBluRay\b`,
    "dual.?audio",
    R`v\d`,
  ];
  const titles = [
    "[SubsPlease] Show - S01E05 (1080p) [HEVC]",
    "[Erai-raws] show s02e11 720p x264 WEB-DL",
    "[Judas] SHOW - 05 [BD 1080p][x265][Dual-Audio]",
    "show.web.dl.v2.mkv",
    "SHOW_name-01.MKV",
    "Show 264 X264 [jUdAs]",
    "abc DEF z Z - _ ! ~",
    "",
  ];
  for (const src of patterns) {
    const c = compileTerm(`/${src}/`);
    assert.ok("test" in c, src);
    const old = new RegExp(src, "i"); // small, safe patterns: fine to run the old way here, as the reference
    for (const t of titles) assert.equal(c.test(t), old.test(t), `${src} on ${JSON.stringify(t)}`);
  }
  // Trailing flags after the closing slash are accepted and ignored, as before (always case-insensitive).
  const flagged = compileTerm("/x265/gim");
  assert.ok("test" in flagged && flagged.test("X265"));
});

test("foldCase leaves escapes, group names and quantifiers alone and adds the other case to letters and ranges", () => {
  const R = String.raw;
  assert.equal(foldCase(R`S\d+E\d+`), R`[Ss]\d+[Ee]\d+`);
  assert.equal(foldCase("[a-f0-9]{2,4}"), "[a-fA-F0-9]{2,4}");
  assert.equal(foldCase("(?<name>x)"), "(?<name>[xX])");
  assert.equal(foldCase(R`\x41`), R`[\x41a]`);
  assert.equal(foldCase(R`\cJ\bB`), R`\cJ\b[Bb]`);
  assert.equal(foldCase("(?:ab)"), "(?:[aA][bB])");
});

test("foldCase fuzz: random short patterns match exactly like the i flag on random names, and stay valid", () => {
  // Odd inputs on purpose: brackets, dashes, escapes, group syntax, accented letters. Seeded, so a failure repeats.
  const atoms = [..."aBz-[]^\\dx41():<>=!*+.{},2|$cku0_", "é", "É"];
  const chars = [..."aAbBzZxXdD-[]^_09 \\{}<>.!:=,|$cCkK", "é", "É"];
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const names = Array.from({ length: 80 }, () => Array.from({ length: rnd(8) }, () => chars[rnd(chars.length)]).join(""));
  let tried = 0;
  for (let i = 0; i < 12000; i++) {
    const p = Array.from({ length: 1 + rnd(7) }, () => atoms[rnd(atoms.length)]).join("");
    let ref: RegExp;
    try {
      ref = new RegExp(p, "i"); // at most 7 atoms: fine to run on the backtracking engine as the reference
    } catch {
      continue; // not a valid pattern: compileTerm refuses it before folding
    }
    let lin: RegExp;
    try {
      lin = new RegExp(foldCase(p), LINEAR_FLAG);
    } catch (e) {
      assert.match((e as Error).message, /linear time/, `folding broke ${JSON.stringify(p)} -> ${JSON.stringify(foldCase(p))}`);
      continue;
    }
    tried++;
    for (const n of names)
      assert.equal(lin.test(n), ref.test(n), `${JSON.stringify(p)} -> ${JSON.stringify(foldCase(p))} on ${JSON.stringify(n)}`);
  }
  assert.ok(tried > 2000, `only ${tried} patterns compared`);
});

test("a realistic search (500 releases x 5 regex terms): results are right and the cost is printed", () => {
  const terms = ["/(1080p|720p).*(x26[45])/", "/\\bHEVC\\b/", "/S\\d+E\\d+/", "/^\\[(SubsPlease|Erai-raws)\\]/", "/web-?dl/"];
  const r = rule({ mustNot: terms.slice(0, 2), must: terms.slice(2, 4), preferred: [{ term: terms[4], score: 1 }] });
  const t0 = Date.now();
  for (let i = 0; i < 500; i++) applyRules(`[SubsPlease] Show S01E${i} 1080p WEB-DL x264 ${"pad ".repeat(10)}`, [r]);
  const ms = Date.now() - t0;
  console.log(`PERF: 500 releases x 5 linear regex terms took ${ms} ms`);
  assert.ok(ms < 20000, `took ${ms} ms`); // loose tolerance; the real number is printed above
  assert.equal(
    applyRules("[SubsPlease] Show S01E05 1080p x265", [r]).reject,
    "Blocked by release rule 'Rule': contains '/(1080p|720p).*(x26[45])/'",
  );
  assert.equal(applyRules("[SubsPlease] Show s01e05 web-dl", [r]).score, 1);
});

test("the worker-thread regex runner is gone: nothing can keep a thread spinning or hold up process exit", () => {
  for (const f of ["server/core/rules.ts", "server/core/linearRegex.ts", "server/search/releaseRules.ts"]) {
    const src = fs.readFileSync(path.join(import.meta.dirname, "..", f), "utf8");
    assert.doesNotMatch(src, /worker_threads|new Worker|Atomics\.|node:vm|runInContext/, f);
  }
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

test("a stored preferred term the engine refuses still penalises when its score is negative, and gives no bonus when positive (blind review round 4 Medium 1)", () => {
  const term = "/^(?!.*dub)/";
  const neg = applyRules("Show - 01 [1080p]", [rule({ name: "No dubs", preferred: [{ term, score: -100 }] })]);
  assert.equal(neg.score, -PREFERRED_CAP, "the penalty applies");
  assert.ok(
    neg.why.some((w) => w.includes("No dubs")),
    JSON.stringify(neg.why),
  );
  assert.equal(applyRules("Show - 01 [1080p]", [rule({ preferred: [{ term, score: 5 }] })]).score, 0, "a positive score gives no bonus");
});

test("a rule holding a stored refused term can still be toggled off, and only new or changed terms are validated (blind review round 4 Medium 2)", () => {
  const term = "/(x26)\\1/";
  const saved = saveRule(null, { name: "Stored bad", mustNot: ["x264"], preferred: [{ term: "dub", score: -3 }] });
  db.prepare("UPDATE release_rules SET must_not = ?, preferred = ? WHERE id = ?").run(
    JSON.stringify([term]),
    JSON.stringify([{ term, score: -3 }]),
    saved.id,
  );
  // The web UI sends the whole rule back.
  const off = saveRule(saved.id, { ...listRules().find((x) => x.id === saved.id)!, enabled: false });
  assert.equal(off.enabled, false);
  assert.deepEqual(listRules().find((x) => x.id === saved.id)!.mustNot, [term], "the stored term passes through unchanged");
  assert.equal(saveRule(saved.id, { enabled: true }).enabled, true);
  assert.throws(
    () => saveRule(saved.id, { mustNot: [term, "/(y)\\1/"] }),
    /Must not contain: .*can't run safely/,
    "a new bad term is refused",
  );
  assert.throws(() => saveRule(saved.id, { preferred: [{ term: "/(z)\\1/", score: 1 }] }), /Preferred: .*can't run safely/);
  deleteRule(saved.id);
});

test("inline modifier groups such as (?-i:DUB) and (?s:x) are refused on save, so they can't silently undo case folding (blind review round 4 Low)", () => {
  for (const src of ["/(?-i:DUB)/", "/(?s:x)/", "/a(?i:b)/", "/(?i-s:b)/"]) {
    const c = compileTerm(src);
    assert.ok("error" in c && /Inline modifier groups/.test(c.error), src + " " + JSON.stringify(c));
    assert.throws(() => saveRule(null, { name: "Mod", mustNot: [src] }), /Must not contain: .*Inline modifier groups/);
  }
  // Escaped parens, classes and ordinary groups are not modifier groups.
  for (const src of ["/\\(?a/", "/[(?i]/", "/(?:a|b)/", "/(?<n>a)/", "/(?<=a)b/"]) assert.ok("test" in compileTerm(src), src);
  assert.ok(!listRules().some((x) => x.name === "Mod"), "nothing saved");
});

test("the startup self-test marks the linear engine unavailable when the flag has no effect (blind review round 4 Informational)", async () => {
  const lin = await import("../server/core/linearRegex.js");
  assert.equal(typeof lin.checkLinearEngine, "function");
  assert.equal(
    lin.checkLinearEngine((src, flags) => new RegExp(src, flags === LINEAR_FLAG ? "" : flags)),
    false,
    "flag ignored: backreference compiles",
  );
  assert.equal(
    lin.checkLinearEngine(() => {
      throw new Error("no engine");
    }),
    false,
    "flag refused",
  );
  assert.equal(
    lin.checkLinearEngine((src, flags) => new RegExp(src, flags)),
    true,
    "real engine passes",
  );
});
