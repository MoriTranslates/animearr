/**
 * Release rules (Sonarr's release profiles): terms a release name must or must not contain, and preferred terms with
 * a score. A term is a plain case-insensitive substring, or `/regex/` (always case-insensitive) when wrapped in slashes.
 * Regex terms run on V8's linear-time engine (core/linearRegex.ts), so no pattern can hang AnimeArr; patterns that
 * engine can't run are refused on save, and a stored one fails closed with a warning.
 * Pure: the rules a show falls under (tag scoping) are picked by server/search/releaseRules.ts before they get here.
 */
import { linearCaseInsensitive, linearEngine } from "./linearRegex.js";

export interface PreferredTerm {
  term: string;
  score: number;
}
export interface ReleaseRule {
  id: string;
  name: string;
  enabled: boolean;
  /** At least one of these must appear in the name (empty = no requirement). */
  must: string[];
  /** None of these may appear. */
  mustNot: string[];
  /** Matching terms add their score (negative scores count against a release). */
  preferred: PreferredTerm[];
  /** Tag ids; empty = applies to every show and movie. */
  tags: number[];
}

/** The most the preferred terms can move a release's score, either way: a nudge inside a close race, never a verdict. */
export const PREFERRED_CAP = 8;
const MAX_TERM = 1024;
const REGEX_FORM = /^\/(.+)\/[a-z]*$/s;

/**
 * Told once per stored term that can't be run (a term saved before AnimeArr refused unsafe patterns, or the
 * linear-time engine missing); the search layer writes the warning. Such a term fails closed.
 */
let onUnusable: (rule: string, term: string, error: string) => void = () => {};
export function setUnusableTermReporter(fn: (rule: string, term: string, error: string) => void) {
  onUnusable = fn;
}
const reported = new Set<string>();

type Compiled = { test: (title: string) => boolean } | { error: string };
const compiled = new Map<string, Compiled>();
/** A term as a matcher, or an error message in plain words. */
export function compileTerm(raw: string): Compiled {
  let c = compiled.get(raw);
  if (!c) {
    if (compiled.size >= 1000) compiled.clear(); // terms come from the user's rules: a handful in practice
    c = compileUncached(raw);
    compiled.set(raw, c);
  }
  return c;
}
/** For tests: forget compiled terms and warnings (after switching the linear engine off or on). */
export function clearCompiledTerms() {
  compiled.clear();
  reported.clear();
}
/** True when the pattern has an inline modifier group: "(?" then a letter or "-" (outside escapes and classes). */
function hasModifierGroup(src: string): boolean {
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") i++;
    else if (inClass) inClass = ch !== "]";
    else if (ch === "[") inClass = true;
    else if (ch === "(" && src[i + 1] === "?" && /[a-zA-Z-]/.test(src[i + 2] ?? "")) return true;
  }
  return false;
}
function compileUncached(raw: string): Compiled {
  const term = raw.trim();
  if (!term) return { error: "A term can't be empty" };
  if (term.length > MAX_TERM) return { error: `A term can be at most ${MAX_TERM} characters` };
  const m = REGEX_FORM.exec(term);
  if (!m) {
    const needle = term.toLowerCase();
    return { test: (title) => title.toLowerCase().includes(needle) };
  }
  try {
    new RegExp(m[1]); // syntax check only (compiled, never run): gives the clearest message for a typo
  } catch (e) {
    return { error: `${term} isn't a valid regular expression: ${(e as Error).message.replace(/^Invalid regular expression: /, "")}` };
  }
  // Every user regex runs on the linear-time engine, never the backtracking one: see core/linearRegex.ts.
  if (!linearEngine())
    return {
      error: `${term} can't be used: AnimeArr's safe regular-expression engine isn't available in this Node.js, so regex terms are off`,
    };
  if (hasModifierGroup(m[1]))
    return {
      error: `${term}: this pattern uses features AnimeArr can't run safely (backreferences/lookarounds); rewrite it without them. Inline modifier groups such as (?i:...) and (?-i:...) aren't allowed: remove them (matching is already case-insensitive)`,
    };
  try {
    const re = linearCaseInsensitive(m[1]);
    return { test: (title) => re.test(title) };
  } catch {
    // The pattern is valid (checked above), so the linear engine refused it; the message says what to change.
    return {
      error: `${term}: this pattern uses features AnimeArr can't run safely (backreferences/lookarounds); rewrite it without them. Lookaheads, inline flags like (?i:...) and counted repeats over 16 such as {0,30} count too`,
    };
  }
}
/**
 * Trims, drops blanks and duplicates, and refuses invalid terms with a clear message. Terms in `stored` (already in
 * the saved rule, unchanged) pass through unchecked, so a rule holding an old refused term can still be edited or
 * switched off; they stay unusable and fail closed when applied.
 */
export function cleanTerms(v: unknown, what: string, stored: string[] = []): string[] {
  const list = Array.isArray(v) ? v : String(v ?? "").split(/\r?\n/);
  const out: string[] = [];
  for (const x of list) {
    const term = String(x ?? "").trim();
    if (!term || out.some((o) => o.toLowerCase() === term.toLowerCase())) continue;
    const c = stored.includes(term) ? null : compileTerm(term);
    if (c && "error" in c) throw Object.assign(new Error(`${what}: ${c.error}`), { statusCode: 400 });
    out.push(term);
  }
  if (out.length > 100) throw Object.assign(new Error(`${what}: up to 100 terms per rule`), { statusCode: 400 });
  return out;
}

export interface RuleVerdict {
  /** Why the release is blocked, in plain words; null = no rule blocks it. */
  reject: string | null;
  /** Preferred-term points, already capped. */
  score: number;
  /** Reasons for the "why" line. */
  why: string[];
  /** Per rule, for the test box. */
  matches: { rule: string; blocked: string | null; preferred: { term: string; score: number }[] }[];
}

/** Applies the rules (already filtered to the ones that fall under the show) to a release name. */
export function applyRules(title: string, rules: ReleaseRule[]): RuleVerdict {
  let reject: string | null = null;
  let total = 0;
  const why: string[] = [];
  const matches: RuleVerdict["matches"] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    // true / false, or null for a stored term that can't be run (reported once per term; it fails closed).
    const check = (t: string): boolean | null => {
      const c = compileTerm(t);
      if ("test" in c) return c.test(title);
      if (!reported.has(t)) {
        reported.add(t);
        onUnusable(r.name, t, c.error);
      }
      return null;
    };
    let blocked: string | null = null;
    if (r.must.length) {
      const hit = r.must.some((t) => check(t) === true);
      if (!hit) blocked = `lacks any of ${r.must.map((t) => `'${t}'`).join(", ")}`;
    }
    if (!blocked) {
      // Fails closed: a term that couldn't be checked counts as present.
      let unusable = false;
      const bad = r.mustNot.find((t) => {
        const v = check(t);
        unusable = v === null;
        return v !== false;
      });
      if (bad) blocked = `contains '${bad}'${unusable ? " (this term can't be run safely, so it counts as present)" : ""}`;
    }
    // An unusable preferred term (null) fails safe: with a negative score it counts as matching, so the penalty
    // still applies; with a positive score it gives no bonus.
    const preferred = r.preferred.filter((p) => {
      const v = check(p.term);
      return v === null ? p.score < 0 : v;
    });
    matches.push({ rule: r.name, blocked, preferred: preferred.map((p) => ({ term: p.term, score: p.score })) });
    if (blocked) reject ??= `Blocked by release rule '${r.name}': ${blocked}`;
    else
      for (const p of preferred) {
        total += p.score;
        why.push(`release rule '${r.name}': ${p.term} (${p.score > 0 ? "+" : ""}${p.score})`);
      }
  }
  return { reject, score: Math.max(-PREFERRED_CAP, Math.min(PREFERRED_CAP, total)), why, matches };
}
