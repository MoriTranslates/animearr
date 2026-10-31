/**
 * Tags (Sonarr/Radarr's): free labels on shows and movies. A tag can scope a release rule (releaseRules.ts) and is what
 * request apps see at /api/v3/tag. Deleting a tag unlinks it everywhere it was used.
 */
import { logDecision } from "./activity.js";
import { db, dbState, tx } from "./db.js";

export type TagKind = "series" | "movie";
export interface Tag {
  id: number;
  label: string;
  series: number;
  movies: number;
  rules: number;
}

const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const guard = () => {
  if (dbState.corrupt) throw fail("The database failed its integrity check; restore a backup first", 503);
};

/** Sonarr keeps tag labels lower-case and trimmed. */
export const normLabel = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40);

export function listTags(): Tag[] {
  return db
    .prepare(
      `SELECT t.id, t.label,
        (SELECT COUNT(*) FROM tag_links l WHERE l.tag_id = t.id AND l.kind = 'series') AS series,
        (SELECT COUNT(*) FROM tag_links l WHERE l.tag_id = t.id AND l.kind = 'movie') AS movies,
        (SELECT COUNT(*) FROM release_rule_tags r WHERE r.tag_id = t.id) AS rules
       FROM tags t ORDER BY t.label`,
    )
    .all() as unknown as Tag[];
}
export const tagRows = () => db.prepare("SELECT id, label FROM tags ORDER BY id").all() as { id: number; label: string }[];

/** Creates the tag, or returns the existing one with that label. */
export function createTag(label: unknown) {
  guard();
  const l = normLabel(label);
  if (!l) throw fail("A tag needs a label");
  const have = db.prepare("SELECT id, label FROM tags WHERE label = ?").get(l) as { id: number; label: string } | undefined;
  if (have) return have;
  if ((db.prepare("SELECT COUNT(*) AS n FROM tags").get() as { n: number }).n >= 200) throw fail("Up to 200 tags");
  db.prepare("INSERT INTO tags (label) VALUES (?)").run(l);
  return db.prepare("SELECT id, label FROM tags WHERE label = ?").get(l) as { id: number; label: string };
}

export function renameTag(id: number, label: unknown) {
  guard();
  const l = normLabel(label);
  if (!l) throw fail("A tag needs a label");
  if (!db.prepare("SELECT 1 FROM tags WHERE id = ?").get(id)) throw fail("Tag not found", 404);
  if (db.prepare("SELECT 1 FROM tags WHERE label = ? AND id != ?").get(l, id)) throw fail(`There is already a tag called "${l}"`, 409);
  db.prepare("UPDATE tags SET label = ? WHERE id = ?").run(l, id);
  return { id, label: l };
}

/** Deletes the tag and unlinks it from every show, movie and release rule; returns how many it was on. */
export function deleteTag(id: number) {
  guard();
  const t = listTags().find((x) => x.id === id);
  if (!t) throw fail("Tag not found", 404);
  tx(db, () => {
    db.prepare("DELETE FROM tag_links WHERE tag_id = ?").run(id);
    db.prepare("DELETE FROM release_rule_tags WHERE tag_id = ?").run(id);
    db.prepare("DELETE FROM tags WHERE id = ?").run(id);
  });
  logDecision("info", { why: `Deleted tag "${t.label}"${t.series + t.movies + t.rules ? `; unlinked from ${t.series} show(s), ${t.movies} movie(s) and ${t.rules} release rule(s)` : ""}` });
  return { series: t.series, movies: t.movies, rules: t.rules };
}

export const tagsOf = (kind: TagKind, ref: number) => (db.prepare("SELECT tag_id FROM tag_links WHERE kind = ? AND ref = ? ORDER BY tag_id").all(kind, ref) as { tag_id: number }[]).map((r) => r.tag_id);

/** Replaces a show's or movie's tags (unknown ids are ignored). */
export function setTags(kind: TagKind, ref: number, ids: unknown) {
  guard();
  if (!Array.isArray(ids)) return tagsOf(kind, ref);
  const known = new Set(tagRows().map((t) => t.id));
  tx(db, () => {
    db.prepare("DELETE FROM tag_links WHERE kind = ? AND ref = ?").run(kind, ref);
    for (const t of new Set(ids.map(Number))) if (known.has(t)) db.prepare("INSERT INTO tag_links (kind, ref, tag_id) VALUES (?, ?, ?)").run(kind, ref, t);
  });
  return tagsOf(kind, ref);
}

/** Adds and/or removes tags on several shows or movies at once. */
export function bulkTags(kind: TagKind, refs: number[], add: number[], remove: number[]) {
  guard();
  const known = new Set(tagRows().map((t) => t.id));
  tx(db, () => {
    for (const ref of refs) {
      for (const t of add) if (known.has(t)) db.prepare("INSERT OR IGNORE INTO tag_links (kind, ref, tag_id) VALUES (?, ?, ?)").run(kind, ref, t);
      for (const t of remove) db.prepare("DELETE FROM tag_links WHERE kind = ? AND ref = ? AND tag_id = ?").run(kind, ref, t);
    }
  });
  return { changed: refs.length };
}

/** A removed show or movie keeps no tags. */
export const clearTags = (kind: TagKind, ref: number) => void db.prepare("DELETE FROM tag_links WHERE kind = ? AND ref = ?").run(kind, ref);
