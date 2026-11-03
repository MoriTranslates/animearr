/**
 * User regular expressions run on V8's linear-time engine (the `l` flag), never on the normal backtracking one.
 * Linear time is guaranteed by the engine, so no shape of pattern can freeze AnimeArr, and no timeout, worker or
 * "runaway" bookkeeping is needed. (A worker can't stop a running regex either: terminate() leaves the thread
 * spinning and process.exit() waits for it.)
 *
 * The engine is behind a V8 flag. Setting it here, when this module loads, is enough: it only has to be on before the
 * first `l` regex is compiled, and only core/rules.ts compiles user regexes (it imports this module). If the flag
 * can't be set, `linearEngine()` is false and user regexes fail closed instead of running on the backtracking engine.
 *
 * The linear engine refuses the `i` flag, so case-insensitivity is done by rewriting the pattern: each letter becomes
 * a class of its lower- and upper-case forms ("x265" becomes "[xX]265", "[a-f]" becomes "[a-fA-F]").
 * It also refuses backreferences, lookaheads, inline flag groups and counted repeats over 16 ("{17}", "{0,30}").
 */
import v8 from "node:v8";

v8.setFlagsFromString("--enable-experimental-regexp-engine");
/** V8's linear-time flag. A variable, not a literal: linters don't know the flag and call the regex invalid. */
export const LINEAR_FLAG: string = "l";
/**
 * Startup self-test: the flag must make a plain pattern compile AND make a backreference throw (the linear engine
 * has none). If the flag silently did nothing, `l` would be an ordinary backtracking regex, so report unavailable.
 */
export function checkLinearEngine(make: (source: string, flags: string) => RegExp): boolean {
  try {
    make("a", LINEAR_FLAG);
  } catch {
    // Harmless to lose: the only thing this tells us is "not available", which is exactly what false reports.
    return false;
  }
  try {
    make("(a)\\1", LINEAR_FLAG);
  } catch {
    return true; // refused, as the linear engine must
  }
  return false; // compiled: the backtracking engine is running, not the linear one
}
const available = checkLinearEngine((s, f) => new RegExp(s, f));
let forced: boolean | null = null;

/** Whether the linear-time engine works in this process. */
export const linearEngine = () => forced ?? available;
/** For tests only: pretend the engine is (un)available; null restores the real answer. */
export function forceLinearEngineForTests(v: boolean | null) {
  forced = v;
}

/** A case-insensitive linear-time regex for a user pattern. Throws when the engine refuses the pattern. */
export function linearCaseInsensitive(source: string): RegExp {
  if (!linearEngine()) throw new Error("the linear-time regular-expression engine isn't available");
  return new RegExp(foldCase(source), LINEAR_FLAG);
}

const isHex = (s: string) => /^[0-9a-fA-F]+$/.test(s);

/**
 * The other-case forms of one character (single UTF-16 units only), not including itself. Like the `i` flag, a
 * non-ASCII character never maps to an ASCII one (the long s and the Kelvin sign don't match "s" and "k").
 */
function variants(ch: string): string[] {
  const out = new Set<string>();
  const ascii = (s: string) => s.charCodeAt(0) < 128;
  for (const v of [ch.toLowerCase(), ch.toUpperCase()]) if (v.length === 1 && v !== ch && ascii(v) === ascii(ch)) out.add(v);
  return [...out];
}

/** A character inside a class, with its code unit when it stands for one character (else null: \d, \w, \p...). */
interface ClassItem {
  raw: string;
  code: number | null;
}

/** Reads one escape starting at src[i] === "\\"; returns its raw text and the character it stands for, if any. */
function readEscape(src: string, i: number, inClass: boolean): { raw: string; code: number | null } {
  const c = src[i + 1];
  if (c === undefined) return { raw: "\\", code: null };
  const hex = (n: number) =>
    src.length >= i + 2 + n && isHex(src.slice(i + 2, i + 2 + n)) ? parseInt(src.slice(i + 2, i + 2 + n), 16) : null;
  if (c === "x" && hex(2) !== null) return { raw: src.slice(i, i + 4), code: hex(2) };
  if (c === "u" && hex(4) !== null) return { raw: src.slice(i, i + 6), code: hex(4) };
  if (c === "c" && /^[a-zA-Z]$/.test(src[i + 2] ?? "")) return { raw: src.slice(i, i + 3), code: src.charCodeAt(i + 2) % 32 };
  if (c === "k" && src[i + 2] === "<") {
    const end = src.indexOf(">", i + 3);
    if (end > 0) return { raw: src.slice(i, end + 1), code: null };
  }
  const simple: Record<string, number> = { t: 9, n: 10, v: 11, f: 12, r: 13 };
  if (c in simple) return { raw: "\\" + c, code: simple[c] };
  if (c === "b" && inClass) return { raw: "\\b", code: 8 };
  if (/[0-9]/.test(c)) {
    // Backreference or octal: keep every digit together so none is read as a literal.
    let j = i + 1;
    while (/[0-9]/.test(src[j] ?? "")) j++;
    return { raw: src.slice(i, j), code: null };
  }
  // A letter escape (\d, \w, \s, \b, \p...) is a class or an assertion; anything else (\. \[ \/) is that character.
  if (/[a-zA-Z]/.test(c)) return { raw: "\\" + c, code: null };
  return { raw: "\\" + c, code: c.charCodeAt(0) };
}

/** Rewrites a pattern so it matches case-insensitively without the `i` flag. Invalid patterns stay invalid. */
export function foldCase(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      const e = readEscape(src, i, false);
      const vs = e.code === null ? [] : variants(String.fromCharCode(e.code));
      out += vs.length ? `[${e.raw}${vs.join("")}]` : e.raw;
      i += e.raw.length;
    } else if (ch === "(" && src[i + 1] === "?") {
      // Group syntax: names ((?<name>), lookbehinds ((?<=, (?<!) and flag groups ((?i:) keep their letters.
      if (src[i + 2] === "<" && src[i + 3] !== "=" && src[i + 3] !== "!") {
        const end = src.indexOf(">", i + 3);
        const stop = end < 0 ? src.length : end + 1;
        out += src.slice(i, stop);
        i = stop;
      } else {
        let j = i + 2;
        if (src[j] === "<") j++;
        while (/[a-zA-Z-]/.test(src[j] ?? "")) j++;
        out += src.slice(i, j);
        i = j;
      }
    } else if (ch === "[") {
      const r = foldClass(src, i);
      out += r.text;
      i = r.end;
    } else {
      const vs = variants(ch);
      out += vs.length ? `[${ch}${vs.join("")}]` : ch;
      i++;
    }
  }
  return out;
}

/** Rewrites one character class starting at src[start] === "["; each character or range gets its other case added. */
function foldClass(src: string, start: number): { text: string; end: number } {
  let i = start + 1;
  let out = "[";
  if (src[i] === "^") {
    out += "^";
    i++;
  }
  // First "]" right after "[" or "[^" is a literal in some engines; in JavaScript it closes an empty class, as here.
  const items: ClassItem[] = [];
  while (i < src.length && src[i] !== "]") {
    if (src[i] === "\\") {
      const e = readEscape(src, i, true);
      items.push(e);
      i += e.raw.length;
    } else {
      items.push({ raw: src[i], code: src.charCodeAt(i) });
      i++;
    }
  }
  if (i >= src.length) return { text: src.slice(start), end: src.length }; // unclosed: stays invalid
  for (let k = 0; k < items.length; k++) {
    const a = items[k];
    const dash = items[k + 1];
    const b = items[k + 2];
    if (a.code !== null && dash?.raw === "-" && b && b.code !== null) {
      out += a.raw + "-" + b.raw + swappedRanges(a.code, b.code);
      k += 2;
    } else {
      out += a.raw;
      if (a.code !== null && a.raw !== "-") out += variants(String.fromCharCode(a.code)).join("");
    }
  }
  return { text: out + "]", end: i + 1 };
}

/** The ASCII-letter parts of the range lo..hi, in the other case ("a-f" gives "A-F"). Wider ranges stay as they are. */
function swappedRanges(lo: number, hi: number): string {
  let out = "";
  for (const [from, to, shift] of [
    [97, 122, -32],
    [65, 90, 32],
  ]) {
    const a = Math.max(lo, from);
    const b = Math.min(hi, to);
    if (a <= b) out += String.fromCharCode(a + shift) + "-" + String.fromCharCode(b + shift);
  }
  return out;
}
