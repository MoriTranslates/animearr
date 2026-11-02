/**
 * Release rules (Sonarr's release profiles): terms a release name must or must not contain, and preferred terms with
 * a score. A term is a plain case-insensitive substring, or `/regex/` (always case-insensitive) when wrapped in slashes.
 * Pure: the rules a show falls under (tag scoping) are picked by server/search/releaseRules.ts before they get here.
 */
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
const MAX_TERM = 200;
const REGEX_FORM = /^\/(.+)\/[a-z]*$/s;

/** A term as a matcher, or an error message in plain words. */
export function compileTerm(raw: string): { test: (title: string) => boolean } | { error: string } {
  const term = raw.trim();
  if (!term) return { error: "A term can't be empty" };
  if (term.length > MAX_TERM) return { error: `A term can be at most ${MAX_TERM} characters` };
  const m = REGEX_FORM.exec(term);
  if (!m) {
    const needle = term.toLowerCase();
    return { test: (title) => title.toLowerCase().includes(needle) };
  }
  // Nested quantifiers like (a+)+ can make a regex take forever on a long title.
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(m[1])) return { error: `The regular expression ${term} is too complex (nested repeats); simplify it` };
  try {
    const re = new RegExp(m[1], "i");
    return { test: (title) => re.test(title) };
  } catch (e) {
    return { error: `${term} isn't a valid regular expression: ${(e as Error).message.replace(/^Invalid regular expression: /, "")}` };
  }
}

/** Trims, drops blanks and duplicates, and refuses invalid terms with a clear message. */
export function cleanTerms(v: unknown, what: string): string[] {
  const list = Array.isArray(v) ? v : String(v ?? "").split(/\r?\n/);
  const out: string[] = [];
  for (const x of list) {
    const term = String(x ?? "").trim();
    if (!term || out.some((o) => o.toLowerCase() === term.toLowerCase())) continue;
    const c = compileTerm(term);
    if ("error" in c) throw Object.assign(new Error(`${what}: ${c.error}`), { statusCode: 400 });
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
    let blocked: string | null = null;
    if (r.must.length) {
      const hit = r.must.some((t) => {
        const c = compileTerm(t);
        return "test" in c && c.test(title);
      });
      if (!hit) blocked = `lacks any of ${r.must.map((t) => `'${t}'`).join(", ")}`;
    }
    if (!blocked) {
      const bad = r.mustNot.find((t) => {
        const c = compileTerm(t);
        return "test" in c && c.test(title);
      });
      if (bad) blocked = `contains '${bad}'`;
    }
    const preferred = r.preferred.filter((p) => {
      const c = compileTerm(p.term);
      return "test" in c && c.test(title);
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
