/**
 * Release rules (Sonarr's release profiles), stored in the user database. Rules with tags apply only to shows and movies
 * carrying one of those tags; rules without tags apply to everything. The matching itself is core/rules.ts; ranking
 * (core/rank.ts) is the one place that applies them, so searches, automatic grabs and upgrades all obey the same rules.
 */
import crypto from "node:crypto";
import { logDecision } from "./activity.js";
import { applyRules, cleanTerms, type PreferredTerm, type ReleaseRule } from "./core/rules.js";
import { db, dbState, tx } from "./db.js";
import { tagRows, tagsOf, type TagKind } from "./tags.js";

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

interface Row { id: string; name: string; enabled: number; must: string; must_not: string; preferred: string }

const parse = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export function listRules(): ReleaseRule[] {
  const tags = db.prepare("SELECT rule_id, tag_id FROM release_rule_tags ORDER BY tag_id").all() as { rule_id: string; tag_id: number }[];
  return (db.prepare("SELECT id, name, enabled, must, must_not, preferred FROM release_rules ORDER BY position, rowid").all() as unknown as Row[]).map((r) => ({
    id: r.id,
    name: r.name,
    enabled: !!r.enabled,
    must: parse<string[]>(r.must, []),
    mustNot: parse<string[]>(r.must_not, []),
    preferred: parse<PreferredTerm[]>(r.preferred, []),
    tags: tags.filter((t) => t.rule_id === r.id).map((t) => t.tag_id),
  }));
}

function cleanPreferred(v: unknown): PreferredTerm[] {
  const list = Array.isArray(v) ? (v as Partial<PreferredTerm>[]) : [];
  const terms = cleanTerms(list.map((p) => p?.term), "Preferred");
  return terms.map((term) => {
    const p = list.find((x) => String(x?.term ?? "").trim().toLowerCase() === term.toLowerCase());
    const score = Math.round(Number(p?.score));
    if (!Number.isFinite(score)) throw fail(`Preferred: give "${term}" a score (a whole number; negative counts against it)`);
    return { term, score: Math.max(-100, Math.min(100, score)) };
  });
}

/** Validates an untrusted rule from the UI; an invalid regular expression is refused with a clear message. */
export function validateRule(input: Partial<ReleaseRule>, base: ReleaseRule): ReleaseRule {
  const name = String(input.name ?? base.name).trim().slice(0, 60);
  if (!name) throw fail("Give the rule a name");
  const known = new Set(tagRows().map((t) => t.id));
  return {
    id: base.id,
    name,
    enabled: typeof input.enabled === "boolean" ? input.enabled : base.enabled,
    must: input.must !== undefined ? cleanTerms(input.must, "Must contain") : base.must,
    mustNot: input.mustNot !== undefined ? cleanTerms(input.mustNot, "Must not contain") : base.mustNot,
    preferred: input.preferred !== undefined ? cleanPreferred(input.preferred) : base.preferred,
    tags: input.tags !== undefined ? [...new Set((Array.isArray(input.tags) ? input.tags : []).map(Number).filter((t) => known.has(t)))] : base.tags,
  };
}

export function saveRule(id: string | null, input: Partial<ReleaseRule>) {
  if (dbState.corrupt) throw fail("The database failed its integrity check; restore a backup first", 503);
  const all = listRules();
  const existing = id ? all.find((r) => r.id === id) : undefined;
  if (id && !existing) throw fail("Unknown release rule", 404);
  if (!existing && all.length >= 50) throw fail("Up to 50 release rules");
  const r = validateRule(input, existing ?? { id: crypto.randomUUID().slice(0, 8), name: "", enabled: true, must: [], mustNot: [], preferred: [], tags: [] });
  tx(db, () => {
    db.prepare(
      `INSERT INTO release_rules (id, name, enabled, must, must_not, preferred, position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, enabled = excluded.enabled, must = excluded.must, must_not = excluded.must_not, preferred = excluded.preferred, updated_at = excluded.updated_at`,
    ).run(r.id, r.name, r.enabled ? 1 : 0, JSON.stringify(r.must), JSON.stringify(r.mustNot), JSON.stringify(r.preferred), all.length, Date.now());
    db.prepare("DELETE FROM release_rule_tags WHERE rule_id = ?").run(r.id);
    for (const t of r.tags) db.prepare("INSERT INTO release_rule_tags (rule_id, tag_id) VALUES (?, ?)").run(r.id, t);
  });
  logDecision("info", { why: `${existing ? "Changed" : "Added"} release rule "${r.name}" (${r.must.length} must, ${r.mustNot.length} must-not, ${r.preferred.length} preferred; ${r.tags.length ? "tagged shows only" : "all shows"})` });
  return r;
}

export function deleteRule(id: string) {
  const r = listRules().find((x) => x.id === id);
  if (!r) throw fail("Unknown release rule", 404);
  tx(db, () => {
    db.prepare("DELETE FROM release_rule_tags WHERE rule_id = ?").run(id);
    db.prepare("DELETE FROM release_rules WHERE id = ?").run(id);
  });
  logDecision("info", { why: `Deleted release rule "${r.name}"` });
}

/** The enabled rules that fall under a show or movie: untagged rules, and ones sharing a tag with it. */
export function releaseRulesFor(kind: TagKind, ref: number): ReleaseRule[] {
  const rules = listRules().filter((r) => r.enabled);
  if (!rules.length) return rules;
  const mine = new Set(tagsOf(kind, ref));
  return rules.filter((r) => !r.tags.length || r.tags.some((t) => mine.has(t)));
}

/** "Test against a title": which rules match or block a sample release name (for one show or movie, else every enabled rule). */
export function testRules(title: string, scope?: { kind: TagKind; ref: number }) {
  const rules = scope ? releaseRulesFor(scope.kind, scope.ref) : listRules().filter((r) => r.enabled);
  const v = applyRules(title, rules);
  return { rejected: v.reject, score: v.score, why: v.why, matches: v.matches };
}
