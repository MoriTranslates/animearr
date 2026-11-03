/**
 * HTML to plain text for NFO plots (AniList/TMDB/Sonarr descriptions), with a hand-written scanner instead of a regex.
 *
 * Why not a regex: the tag pattern with attributes backtracked exponentially on an unclosed tag such as
 * `<a x=aaaa=aaaa=...` (blind review misc H1: ~95 characters took 22 seconds and froze the server).
 *
 * Running time is linear in the input, whatever the input:
 * - Each tag attempt starts at a "<" and, when it fails, scanning resumes at the place it failed, never back at the
 *   "<". So every character outside a quoted value is looked at a constant number of times.
 * - A quoted value is skipped with indexOf. Those searches only move forward (a later attempt starts after the closing
 *   quote), and a search that found nothing is remembered, so the rest of the string is not searched again.
 * - Comments ("<!-- -->") use the same remembered forward search for "-->".
 *
 * What counts as a tag:
 * - A known element name (KNOWN below) with name=value attributes (quoted or unquoted, packed or spaced), the HTML
 *   boolean attributes, and ">" or "/>" (spaces allowed around the "/"). Always removed; <br> becomes a line break.
 * - Any other element name with the same syntax only when it clearly is a tag: self-closing ("<x/>"), or an opening
 *   tag with a matching closing tag later, or a closing tag with a matching opening tag earlier. "<spoiler>s</spoiler>"
 *   gives "s"; a lone "<foo>" stays text.
 * - <script> and <style> are always removed, and with a closing tag their contents go too.
 * - Anything else stays text: "a <b and c> d", "x<3", "1 <foo> 2".
 */

const KNOWN = new Set(
  (
    "a abbr b big blockquote br center cite code dd del details div dl dt em font h1 h2 h3 h4 h5 h6 hr i img ins kbd " +
    "li mark ol p pre q s small span strike strong sub summary sup table tbody td tfoot th thead tr tt u ul wbr"
  ).split(" "),
);
/** Valueless attributes are only the HTML boolean ones, so "a <b and c> d" stays text. */
const BOOL_ATTRS = new Set("noshade ismap hidden nowrap open compact disabled checked selected async controls loop".split(" "));
const RAW_CONTENT = new Set(["script", "style"]);

type Token = { text: string } | { tag: string; close: boolean; self: boolean; raw: string };

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c: number) => c >= 48 && c <= 57;
/** Element names: a letter, then letters, digits or "-". */
const isNameChar = (c: number) => isAlpha(c) || isDigit(c) || c === 45;
/** Attribute names: [A-Za-z_:] then [A-Za-z0-9_:.-]. */
const isAttrStart = (c: number) => isAlpha(c) || c === 95 || c === 58;
const isAttrChar = (c: number) => isAttrStart(c) || isDigit(c) || c === 46 || c === 45;
/** Unquoted attribute values: anything but space, quotes, "<", ">", "=" and backtick. */
const isUnquotedChar = (c: number) => !isSpace(c) && c !== 34 && c !== 39 && c !== 60 && c !== 62 && c !== 61 && c !== 96;

/** indexOf that only moves forward and remembers "not found", so repeated misses can't make the scan quadratic. */
function forwardFinder(s: string) {
  const missFrom = new Map<string, number>();
  return (needle: string, from: number) => {
    const miss = missFrom.get(needle);
    if (miss !== undefined && from >= miss) return -1;
    const at = s.indexOf(needle, from);
    if (at < 0) missFrom.set(needle, from);
    return at;
  };
}

/**
 * Try to read one tag starting at s[start] === "<". Returns the token and where scanning continues, or a failure with
 * the position where the tag stopped making sense (always after start, so the caller makes progress).
 */
function readTag(
  s: string,
  start: number,
  find: (needle: string, from: number) => number,
): { ok: true; token: Token; end: number } | { ok: false; at: number } {
  const n = s.length;
  let i = start + 1;
  let close = false;
  if (s.charCodeAt(i) === 47) {
    close = true;
    i++;
  }
  if (i >= n || !isAlpha(s.charCodeAt(i))) return { ok: false, at: i };
  const nameStart = i;
  while (i < n && isNameChar(s.charCodeAt(i))) i++;
  const name = s.slice(nameStart, i).toLowerCase();
  // The name must end at a space, "/" or ">": "<b2b" is not "<b" plus something.
  if (i < n && !isSpace(s.charCodeAt(i)) && s.charCodeAt(i) !== 47 && s.charCodeAt(i) !== 62) return { ok: false, at: i };
  // Attributes. "spaced" says whether at least one space came before the current position.
  for (;;) {
    let spaced = false;
    while (i < n && isSpace(s.charCodeAt(i))) {
      i++;
      spaced = true;
    }
    if (i >= n) return { ok: false, at: n };
    const c = s.charCodeAt(i);
    if (c === 62 || c === 47) break;
    if (!isAttrStart(c)) return { ok: false, at: i };
    const attrStart = i;
    while (i < n && isAttrChar(s.charCodeAt(i))) i++;
    const attr = s.slice(attrStart, i).toLowerCase();
    let j = i;
    while (j < n && isSpace(s.charCodeAt(j))) j++;
    if (j < n && s.charCodeAt(j) === 61) {
      // name = value
      j++;
      while (j < n && isSpace(s.charCodeAt(j))) j++;
      if (j >= n) return { ok: false, at: n };
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) {
        const endQuote = find(q === 34 ? '"' : "'", j + 1);
        if (endQuote < 0) return { ok: false, at: j + 1 };
        i = endQuote + 1;
      } else {
        if (!isUnquotedChar(q)) return { ok: false, at: j };
        while (j < n && isUnquotedChar(s.charCodeAt(j))) j++;
        i = j;
      }
    } else {
      // A valueless attribute: only the HTML boolean ones, and only after a space.
      if (!spaced || !BOOL_ATTRS.has(attr)) return { ok: false, at: i };
    }
    // An unquoted value or a boolean name must be followed by a space, "/" or ">" (checked by the next round), and a
    // quoted value may be packed against the next attribute ('href="u"class="c"').
  }
  // Optional "/", spaces allowed around it, then ">".
  let self = false;
  if (s.charCodeAt(i) === 47) {
    self = true;
    i++;
    while (i < n && isSpace(s.charCodeAt(i))) i++;
  }
  if (i >= n || s.charCodeAt(i) !== 62) return { ok: false, at: Math.min(i, n) };
  return { ok: true, token: { tag: name, close, self, raw: s.slice(start, i + 1) }, end: i + 1 };
}

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  const find = forwardFinder(s);
  let text = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      text += s.slice(i);
      break;
    }
    text += s.slice(i, lt);
    if (s.startsWith("<!--", lt)) {
      const endComment = find("-->", lt + 4);
      if (endComment >= 0) {
        i = endComment + 3;
        continue;
      }
      // An unclosed comment stays text.
      text += "<!--";
      i = lt + 4;
      continue;
    }
    const r = readTag(s, lt, find);
    if (r.ok) {
      if (text) out.push({ text });
      text = "";
      out.push(r.token);
      i = r.end;
    } else {
      text += s.slice(lt, r.at);
      i = r.at;
    }
  }
  if (text) out.push({ text });
  return out;
}

/** Remove HTML tags and comments, <br> as a line break. Entities are left for the caller to decode. */
export function stripTags(html: string): string {
  const tokens = tokenize(html);
  // For unknown names: the first opening and the last closing tag of each name, to tell real tags from "<foo>" text.
  const firstOpen = new Map<string, number>();
  const lastClose = new Map<string, number>();
  tokens.forEach((t, k) => {
    if (!("tag" in t)) return;
    if (t.close) lastClose.set(t.tag, k);
    else if (!t.self && !firstOpen.has(t.tag)) firstOpen.set(t.tag, k);
  });
  let out = "";
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (!("tag" in t)) {
      out += t.text;
      continue;
    }
    if (KNOWN.has(t.tag)) {
      if (t.tag === "br") out += "\n";
      continue;
    }
    if (RAW_CONTENT.has(t.tag)) {
      // With a closing tag later, drop everything up to it; otherwise only the tag itself goes.
      if (!t.close && !t.self && (lastClose.get(t.tag) ?? -1) > k) {
        while (k + 1 < tokens.length) {
          k++;
          const u = tokens[k];
          if ("tag" in u && u.close && u.tag === t.tag) break;
        }
      }
      continue;
    }
    const paired = t.self || (t.close ? (firstOpen.get(t.tag) ?? Infinity) < k : (lastClose.get(t.tag) ?? -1) > k);
    if (!paired) out += t.raw;
  }
  return out;
}
