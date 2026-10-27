/**
 * JSON for HTTP responses, ASCII only: every character outside printable ASCII becomes a \uXXXX escape (surrogate pairs
 * as two escapes, which is valid JSON). The parsed value is identical; only a client that guesses the wrong charset
 * can no longer garble it (UTF-8 "…" read as cp1252 is "â€¦").
 */
const NON_ASCII = /[\u007f-￿]/g;

export function asciiJson(value: unknown): string {
  const s = JSON.stringify(value);
  if (s === undefined) return "null";
  return s.replace(NON_ASCII, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
