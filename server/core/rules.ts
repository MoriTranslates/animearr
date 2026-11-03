/**
 * Release rules (Sonarr's release profiles): terms a release name must or must not contain, and preferred terms with
 * a score. A term is a plain case-insensitive substring, or `/regex/` (always case-insensitive) when wrapped in slashes.
 * Pure: the rules a show falls under (tag scoping) are picked by server/search/releaseRules.ts before they get here.
 */
import { Worker } from "node:worker_threads";

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
 * User regexes run with a time limit. Every user regex runs this way, with no "looks safe" shortcut: exponential ("((a+))+$", "a?a?aab") and
 * quadratic (".*a.*b") shapes can't be told apart from safe ones reliably, and JavaScript has no regex timeout.
 * A vm script timeout does NOT help: V8 only notices it after the regex returns (measured: "a?" x50 + "a" x50 + "b"
 * threw its "timeout" after 12 s). So the match runs on a worker thread while this thread waits on a shared flag for at
 * most REGEX_LIMIT_MS; on timeout the worker is terminated and a fresh one starts on the next check. (V8 can't stop
 * the regex inside the killed worker either, so that thread spins until the regex ends, but the server is not blocked.)
 * A check that hits the limit gives "couldn't check" (null), and applyRules fails closed on it: a must-not term
 * blocks, a must term is missing, a preferred term scores nothing. A term that keeps hitting it is marked as runaway
 * and not run again (still failing closed) until the term is edited (newly added to a rule)
 * or AnimeArr is restarted. Saving a rule unchanged does not clear it.
 */
const REGEX_LIMIT_MS = 50;
/** Starting a worker takes ~30 ms; this only bounds a broken start (a check that can't start one fails closed). */
const WORKER_START_MS = 10_000;
// ctl[0]: the answer (0 = pending, 1 = match, 2 = no match, 3 = the regex threw); ctl[1]: 1 once the worker listens.
const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const ctl = new Int32Array(workerData);
const cache = new Map();
parentPort.on("message", ({ source, flags, title }) => {
  const key = flags + "/" + source;
  let re = cache.get(key);
  if (!re) {
    if (cache.size >= 1000) cache.clear();
    re = new RegExp(source, flags);
    cache.set(key, re);
  }
  let r;
  try {
    re.lastIndex = 0;
    r = re.test(title) ? 1 : 2;
  } catch {
    r = 3;
  }
  Atomics.store(ctl, 0, r);
  Atomics.notify(ctl, 0);
});
Atomics.store(ctl, 1, 1);
Atomics.notify(ctl, 1);
`;
type RegexWorker = { w: Worker; ctl: Int32Array };
let regexWorker: RegexWorker | undefined;

function startRegexWorker(): RegexWorker | undefined {
  const ctl = new Int32Array(new SharedArrayBuffer(8));
  const w = new Worker(WORKER_SRC, { eval: true, workerData: ctl.buffer });
  w.unref(); // never keeps AnimeArr (or a test run) alive on its own
  const rw = { w, ctl };
  w.on("error", () => {
    if (regexWorker === rw) regexWorker = undefined; // the next check starts a fresh worker
  });
  if (Atomics.wait(ctl, 1, 0, WORKER_START_MS) === "timed-out") {
    void w.terminate();
    return undefined;
  }
  return rw;
}

const runaway = new Set<string>();
let guardedRuns = 0;
/** How many regex tests went through the time-limited path (for tests: plain-text terms must not). */
export const guardedRegexRuns = () => guardedRuns;

function guardedTest(term: string, re: RegExp, title: string): boolean | null {
  if (runaway.has(term)) return null;
  guardedRuns++;
  const rw = (regexWorker ??= startRegexWorker());
  if (!rw) return null; // couldn't start a worker: "couldn't check", fails closed; not the term's fault, so no strike
  Atomics.store(rw.ctl, 0, 0);
  rw.w.postMessage({ source: re.source, flags: re.flags, title });
  Atomics.wait(rw.ctl, 0, 0, REGEX_LIMIT_MS);
  const answer = Atomics.load(rw.ctl, 0); // read again: an answer that landed right at the limit still counts
  if (answer === 1 || answer === 2) return answer === 1;
  if (answer === 3) throw new Error(`The regular expression ${term} failed on "${title}"`);
  // Out of time: kill the worker (the next check starts a fresh one), fail closed and record a strike.
  void rw.w.terminate();
  if (regexWorker === rw) regexWorker = undefined;
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
