/**
 * Source files must not hold invisible or invalid characters. An editor or a shell can turn an escape such as
 * "\b" or "\u2028" into the real character: a backspace byte once made a regex fail silently, and a literal U+2028
 * broke the build. Code points are written as numbers here so this file can't carry the characters it looks for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["server", "web/src", "test", "scripts"];
const EXT = /\.(ts|tsx|mts|mjs|js|cjs|css|html)$/;

/** Problem characters in a text, as "U+XXXX at offset N". */
export function invisibleChars(text: string): string[] {
  const out: string[] = [];
  const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    // A surrogate pair (an emoji) is fine; a lone half is not.
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      out.push(`lone surrogate ${hex(cp)} at offset ${i}`);
      continue;
    }
    const bad =
      (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || // C0 controls other than tab, newline, CR
      (cp >= 0xdc00 && cp <= 0xdfff) || // a low surrogate with no high one before it
      cp === 0xfffe ||
      cp === 0xffff ||
      cp === 0x2028 || // line separator
      cp === 0x2029 || // paragraph separator
      (cp === 0xfeff && i !== 0) || // zero-width no-break space; allowed only as a BOM at the start
      cp === 0x200b || // zero-width space
      cp === 0xfffd; // replacement character: what a lone surrogate or a broken encoding becomes in a UTF-8 file
    if (bad) out.push(`${hex(cp)} at offset ${i}`);
  }
  return out;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "fixtures") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sourceFiles(p);
    else if (EXT.test(e.name)) yield p;
  }
}

test("the checker finds each invisible or invalid character injected into a copy of a real source file", () => {
  const original = fs.readFileSync(path.join(root, "server", "core", "rules.ts"), "utf8");
  assert.deepEqual(invisibleChars(original), [], "the clean file passes");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "animearr-chars-"));
  const at = original.indexOf("export");
  const inject = [0x00, 0x08, 0x0b, 0x1b, 0xfffe, 0xffff, 0x2028, 0x2029, 0xfeff, 0x200b, 0xd800, 0xdc00];
  for (const cp of inject) {
    const file = path.join(dir, `with-${cp.toString(16)}.ts`);
    fs.writeFileSync(file, original.slice(0, at) + String.fromCharCode(cp) + original.slice(at));
    // Read back from disk: a lone surrogate is stored as U+FFFD, which the checker also refuses.
    const found = invisibleChars(fs.readFileSync(file, "utf8"));
    assert.equal(found.length, 1, `U+${cp.toString(16)}: ${found.join("; ")}`);
  }
  // In memory, a lone surrogate is named as such.
  assert.match(invisibleChars("a" + String.fromCharCode(0xd800) + "b")[0], /lone surrogate U\+D800/);
  // A BOM at the very start, tabs, CR/LF, CJK and emoji (a surrogate pair) are fine.
  const ok = String.fromCharCode(0xfeff) + "a\tb\r\nc " + String.fromCodePoint(0x846c, 0x1f389) + "\n";
  assert.deepEqual(invisibleChars(ok), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("no source file holds invisible or invalid characters", () => {
  const problems: string[] = [];
  let files = 0;
  for (const d of DIRS) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of sourceFiles(abs)) {
      files++;
      const found = invisibleChars(fs.readFileSync(f, "utf8"));
      if (found.length) problems.push(`${path.relative(root, f)}: ${found.slice(0, 3).join("; ")}`);
    }
  }
  assert.ok(files > 100, `scanned ${files} files`);
  assert.deepEqual(problems, []);
});
