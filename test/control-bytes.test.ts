/**
 * No source or documentation file carries an invisible control character. They creep in when text with escapes (a
 * regex's \b, a "\x08") is written through a shell or a script string: a backspace byte inside a regex fails
 * silently, and in docs it hides part of an example. Tab, newline and carriage return are allowed. Test fixtures
 * (real data) are skipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["server", "web", "test", "scripts", "docs", ".github"];
const EXT = /\.(ts|tsx|mts|js|mjs|cjs|md|ya?ml|json|css|html)$/i;
const SKIP = new Set(["node_modules", "dist", "fixtures", ".git"]);
const BAD = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

function walk(dir: string, out: string[]) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.test(e.name)) out.push(p);
  }
}

test("no source or Markdown file contains a control character", () => {
  const files: string[] = [];
  for (const d of DIRS) walk(path.join(ROOT, d), files);
  for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) if (e.isFile() && EXT.test(e.name)) files.push(path.join(ROOT, e.name));
  assert.ok(
    files.some((f) => f.endsWith("CHANGELOG.md")) && files.some((f) => f.endsWith(path.join("system", "auth.ts"))),
    "covers the repo",
  );
  const bad: string[] = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((l, i) => {
      const m = BAD.exec(l);
      if (m) bad.push(`${path.relative(ROOT, f)}:${i + 1} (byte 0x${m[0].charCodeAt(0).toString(16).padStart(2, "0")})`);
    });
  }
  assert.deepEqual(bad, []);
});
