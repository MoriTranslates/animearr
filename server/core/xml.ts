/**
 * Text for XML 1.0 documents (NFO files, rTorrent XML-RPC). XML 1.0 can't carry some characters at all, even escaped:
 * the C0 controls other than tab, newline and carriage return, U+FFFE, U+FFFF, and unpaired surrogates. One of them
 * makes the whole document unparseable, so they are dropped. Code points are written as numbers on purpose (an editor
 * can turn an escape into the invisible character itself).
 */

/** True for a UTF-16 code unit XML 1.0 never allows (surrogates are handled separately, as pairs). */
const forbidden = (c: number) => (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0xfffe || c === 0xffff;

/** The text without the characters XML 1.0 forbids. Valid surrogate pairs (emoji, rare CJK) are kept. */
export function stripXmlIllegal(s: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
    } else if (!(c >= 0xdc00 && c <= 0xdfff) && !forbidden(c)) continue;
    // c is forbidden, or a lone surrogate: drop it.
    out += s.slice(from, i);
    from = i + 1;
  }
  return from === 0 ? s : out + s.slice(from);
}
