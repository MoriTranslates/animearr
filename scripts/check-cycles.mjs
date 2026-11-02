/**
 * Import-cycle check. Builds the graph of static runtime imports between our own modules in server/ and web/src
 * (dynamic `import()` and type-only imports are ignored, because neither runs at load time) and finds every cycle
 * with Tarjan's strongly-connected-components algorithm.
 *
 * A cycle is allowed only if all of its modules are listed together in one entry of scripts/cycles-allow.json. The
 * target is an empty allowlist; an entry may only shrink. Exit code 1 when a cycle isn't covered, so CI fails.
 *
 *   node scripts/check-cycles.mjs          check
 *   node scripts/check-cycles.mjs --list   print every cycle (allowed or not)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["server", "web/src"];
const EXT = [".ts", ".tsx"];
const allowFile = path.join(root, "scripts", "cycles-allow.json");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.includes(path.extname(e.name)) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(root, p).split(path.sep).join("/");

/** Remove comments so commented-out imports don't count (strings are left alone; good enough for import lines). */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** Static, value-carrying relative imports/re-exports of one file. */
function importsOf(src) {
  const out = [];
  const text = stripComments(src);
  // import ... from "x" / export ... from "x" (statement starts a line; the clause can span lines but not a `;`).
  const re = /^[ \t]*(import|export)\s+([^;]*?)\s*from\s*["']([^"']+)["']/gm;
  for (let m; (m = re.exec(text));) {
    const [, kw, clause, spec] = m;
    if (/^type\b/.test(clause)) continue; // import type / export type
    const braces = clause.match(/\{([\s\S]*)\}/);
    const outside = clause.replace(/\{[\s\S]*\}/, "").replace(/[\s,]/g, "");
    if (braces && !outside) {
      const names = braces[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length && names.every((n) => /^type\s/.test(n))) continue; // { type A, type B }
    }
    if (kw === "export" && !braces && !/^\*/.test(clause.trim())) continue;
    out.push(spec);
  }
  const side = /^[ \t]*import\s*["']([^"']+)["']/gm; // import "./x.js" (side effects)
  for (let m; (m = side.exec(text));) out.push(m[1]);
  return out.filter((s) => s.startsWith("."));
}

function resolve(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  const noJs = base.replace(/\.(m?js|jsx)$/, "");
  for (const c of [base, ...EXT.map((e) => noJs + e), ...EXT.map((e) => path.join(base, "index" + e))]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile() && EXT.includes(path.extname(c))) return c;
  }
  return null;
}

const files = ROOTS.flatMap((r) => (fs.existsSync(path.join(root, r)) ? walk(path.join(root, r)) : []));
const graph = new Map();
for (const f of files) {
  const deps = new Set();
  for (const spec of importsOf(fs.readFileSync(f, "utf8"))) {
    const t = resolve(f, spec);
    if (t) deps.add(rel(t));
  }
  graph.set(rel(f), [...deps].sort());
}

// Tarjan SCC (iterative enough for our module counts; recursion depth = longest import chain).
let index = 0;
const idx = new Map(),
  low = new Map(),
  onStack = new Set(),
  stack = [],
  sccs = [];
function strong(v) {
  idx.set(v, index);
  low.set(v, index);
  index++;
  stack.push(v);
  onStack.add(v);
  for (const w of graph.get(v) ?? []) {
    if (!idx.has(w)) {
      strong(w);
      low.set(v, Math.min(low.get(v), low.get(w)));
    } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
  }
  if (low.get(v) === idx.get(v)) {
    const comp = [];
    let w;
    do {
      w = stack.pop();
      onStack.delete(w);
      comp.push(w);
    } while (w !== v);
    if (comp.length > 1 || (graph.get(v) ?? []).includes(v)) sccs.push(comp.sort());
  }
}
for (const v of [...graph.keys()].sort()) if (!idx.has(v)) strong(v);

const allow = fs.existsSync(allowFile) ? JSON.parse(fs.readFileSync(allowFile, "utf8")) : { cycles: [] };
const allowed = (allow.cycles ?? []).map((c) => new Set(c.modules));
const covered = (scc) => allowed.some((a) => scc.every((m) => a.has(m)));

/** A short concrete loop inside an SCC, to show where to cut. */
function sampleLoop(scc) {
  const set = new Set(scc);
  const start = scc[0];
  const prev = new Map([[start, null]]);
  const queue = [start];
  while (queue.length) {
    const v = queue.shift();
    for (const w of graph.get(v) ?? []) {
      if (!set.has(w)) continue;
      if (w === start) {
        const loop = [start];
        for (let x = v; x !== start; x = prev.get(x)) loop.splice(1, 0, x);
        return [...loop, start].join(" -> ");
      }
      if (!prev.has(w)) {
        prev.set(w, v);
        queue.push(w);
      }
    }
  }
  return scc.join(", ");
}

const list = process.argv.includes("--list");
const bad = sccs.filter((s) => !covered(s));
for (const s of sccs) {
  if (!list && covered(s)) continue;
  console.log(`${covered(s) ? "allowed" : "CYCLE"} (${s.length} modules): ${s.join(", ")}`);
  console.log(`  e.g. ${sampleLoop(s)}`);
}
const stale = (allow.cycles ?? []).filter((c) => !sccs.some((s) => s.some((m) => c.modules.includes(m))));
for (const c of stale) console.log(`note: allowlist entry no longer needed: ${c.modules.join(", ")}`);
console.log(`${files.length} modules, ${sccs.length} cycle(s), ${bad.length} not allowed.`);
process.exit(bad.length ? 1 : 0);
