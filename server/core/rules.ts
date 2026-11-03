/**
 * Release rules (Sonarr's release profiles): terms a release name must or must not contain, and preferred terms with
 * a score. A term is a plain case-insensitive substring, or `/regex/` (always case-insensitive) when wrapped in slashes.
 * Pure: the rules a show falls under (tag scoping) are picked by server/search/releaseRules.ts before they get here.
 */
import vm from "node:vm";

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
 * User regexes run with a time limit. The static check above can't catch every runaway pattern ("((a+))+$",
 * "(a|a)*b" backtrack exponentially), and JavaScript has no regex timeout, so the match runs as a vm script with one.
 * A check that hits the limit gives "couldn't check" (null), and applyRules fails closed on it: a must-not term
 * blocks, a must term is missing, a preferred term scores nothing. A term that keeps hitting it is marked as runaway
 * and not run again (still failing closed) until its rule is saved.
 */
const REGEX_LIMIT_MS = 50;
const regexRun = new vm.Script("re.test(title)");
const regexCtx = vm.createContext({ re: /$^/, title: "" }) as { re: RegExp; title: string };
const runaway = new Set<string>();
let guardedRuns = 0;
/** How many regex tests went through the time-limited path (for tests: safe terms must not). */
export const guardedRegexRuns = () => guardedRuns;

/**
 * The vm watchdog costs far more than the match itself (a thread per call), so a term that clearly can't run away is
 * tested directly. "Clearly safe": no backreference, no repeated group that holds a repeat or an alternation
 * ("(a+)+", "(a|a)*", "(a?)+"), and at most two unbounded repeats in all (".*.*.*a" is polynomial). Anything else, or
 * anything this small scanner doesn't understand, stays on the guarded path.
 */
export function isClearlySafeRegex(src: string): boolean {
  const frames: { quant: boolean; alt: boolean }[] = [{ quant: false, alt: false }];
  let closed: { quant: boolean; alt: boolean } | null = null; // the group that just ended, if the last token was ")"
  let unbounded = 0;
  // The atom being repeated, and the atom just before it when that one was itself repeated without limit: two
  // neighbouring repeats that can match the same characters ("[a-z]*[a-z]*x") are quadratic.
  let cur = "";
  let curBefore: string | null = null;
  let lastUnb: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const top = frames[frames.length - 1];
    let quant: "bounded" | "unbounded" | null = null;
    const isQuant = c === "*" || c === "+" || c === "?" || (c === "{" && /^\{\d+(,\d*)?\}/.test(src.slice(i)));
    if (!isQuant && c !== "(" && c !== "|" && c !== ")") {
      curBefore = lastUnb;
      lastUnb = null;
      cur = c === "\\" ? src.slice(i, i + 2) : c;
      if (c === "[") {
        let j = i + 1;
        for (; j < src.length && src[j] !== "]"; j++) if (src[j] === "\\") j++;
        cur = src.slice(i, j + 1);
      }
    }
    if (c === "(" && src[i + 1] === "?") {
      const p = /^\?(?:<[=!]|[:=!]|<[^>]*>)/.exec(src.slice(i + 1));
      if (p) i += p[0].length; // the group's own prefix is not an atom
    }
    if (c === ")") {
      curBefore = null;
      cur = "(";
    }
    if (c === "\\") {
      if (/[1-9k]/.test(src[i + 1] ?? "")) return false; // backreference
      i++;
    } else if (c === "[") {
      for (i++; i < src.length && src[i] !== "]"; i++) if (src[i] === "\\") i++;
    } else if (c === "(") {
      frames.push({ quant: false, alt: false });
    } else if (c === ")") {
      if (frames.length < 2) return false;
      closed = frames.pop()!;
      const parent = frames[frames.length - 1];
      parent.quant ||= closed.quant;
      parent.alt ||= closed.alt;
      continue;
    } else if (c === "|") {
      top.alt = true;
    } else if (c === "*" || c === "+") {
      quant = "unbounded";
    } else if (c === "?") {
      // "(?:", "(?=" and a lazy "*?" are not repeats of their own.
      if (src[i - 1] !== "(" && !/[*+?}]/.test(src[i - 1] ?? "")) quant = "bounded";
    } else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
      if (m) {
        quant = (m[2] && !m[3]) || Number(m[3] ?? m[1]) >= 100 ? "unbounded" : "bounded"; // a big max is as bad as none
        i += m[0].length - 1;
      }
    }
    if (quant) {
      if (closed && (closed.quant || closed.alt)) return false; // a repeated group holding a repeat or an alternation
      top.quant = true;
      if (quant === "unbounded") {
        if (++unbounded > 2) return false;
        if (curBefore !== null && overlaps(curBefore, cur)) return false;
        lastUnb = cur;
      }
    }
    closed = null;
  }
  return frames.length === 1;
}

/** Could two repeated atoms match some of the same characters? (Two different plain characters can't.) */
function overlaps(a: string, b: string): boolean {
  const wide = (x: string) => x === "." || x === "(" || x[0] === "[" || /^\\[dDwWsS]$/.test(x);
  return a === b || wide(a) || wide(b);
}

function guardedTest(term: string, re: RegExp, title: string): boolean | null {
  if (runaway.has(term)) return null;
  guardedRuns++;
  regexCtx.re = re;
  regexCtx.title = title;
  try {
    return regexRun.runInContext(regexCtx, { timeout: REGEX_LIMIT_MS }) === true;
  } catch (e) {
    if ((e as { code?: string }).code !== "ERR_SCRIPT_EXECUTION_TIMEOUT") throw e;
    // One timeout can be load (GC, ffmpeg, a busy NAS): that check fails closed, but the term stays in use. Only
    // STRIKES timeouts within STRIKE_WINDOW_MS mark it as runaway.
    const now = Date.now();
    const recent = (strikes.get(term) ?? []).filter((t) => now - t < STRIKE_WINDOW_MS);
    recent.push(now);
    if (recent.length >= STRIKES) {
      runaway.add(term);
      strikes.delete(term);
    } else strikes.set(term, recent);
    return null;
  } finally {
    regexCtx.title = "";
  }
}
const STRIKES = 3;
const STRIKE_WINDOW_MS = 10 * 60_000;
const strikes = new Map<string, number[]>();

/** Told once per term, when a rule's term is marked as runaway (the search layer writes the warning). */
let onRunaway: (rule: string, term: string) => void = () => {};
export function setRunawayReporter(fn: (rule: string, term: string) => void) {
  onRunaway = fn;
}
const reported = new Set<string>();

/** A rule was saved (edited): its terms get a fresh start, and a warning again if they still run away. */
export function forgetRegexTimeouts(terms: string[]) {
  for (const raw of terms)
    for (const t of new Set([raw, raw.trim()])) {
      runaway.delete(t);
      strikes.delete(t);
      reported.delete(t);
    }
}

type Compiled = { test: (title: string) => boolean | null } | { error: string };
const compiled = new Map<string, Compiled>();
/** A term as a matcher (true / false, or null when it took too long to check), or an error message in plain words. */
export function compileTerm(raw: string): Compiled {
  let c = compiled.get(raw);
  if (!c) {
    if (compiled.size >= 1000) compiled.clear(); // terms come from the user's rules: a handful in practice
    c = compileUncached(raw);
    compiled.set(raw, c);
  }
  return c;
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
  // Nested quantifiers like (a+)+ can make a regex take forever on a long title.
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(m[1])) return { error: `The regular expression ${term} is too complex (nested repeats); simplify it` };
  try {
    const re = new RegExp(m[1], "i");
    if (isClearlySafeRegex(m[1])) return { test: (title) => re.test(title) };
    return { test: (title) => guardedTest(term, re, title) };
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
    // true / false, or null when a regex took too long to check (reported once, when the term is marked).
    const check = (t: string) => {
      const c = compileTerm(t);
      const v = "test" in c ? c.test(title) : false;
      if (v === null && runaway.has(t.trim()) && !reported.has(t)) {
        reported.add(t);
        onRunaway(r.name, t);
      }
      return v;
    };
    let blocked: string | null = null;
    if (r.must.length) {
      const hit = r.must.some((t) => check(t) === true);
      if (!hit) blocked = `lacks any of ${r.must.map((t) => `'${t}'`).join(", ")}`;
    }
    if (!blocked) {
      // Fails closed: a term that couldn't be checked counts as present.
      let slow = false;
      const bad = r.mustNot.find((t) => {
        const v = check(t);
        slow = v === null;
        return v !== false;
      });
      if (bad) blocked = `contains '${bad}'${slow ? " (took too long to check)" : ""}`;
    }
    const preferred = r.preferred.filter((p) => check(p.term) === true);
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
