/**
 * The per-file rows keyed by a file's library path: the episodes it holds (file_links), its release details
 * (file_meta), the user's subtitle-track corrections (track_overrides) and burned-in marks (file_marks). When AnimeArr
 * renames or moves a file they go with it, in one transaction: all of them or none.
 */
import { db, tx } from "../system/db.js";
import { keyOf } from "../system/paths.js";
import { invalidateOverrides } from "./trackOverrides.js";

const TABLES = ["file_links", "file_meta", "track_overrides", "file_marks"] as const;

/**
 * Moves every per-file row from one path to another (arr or local path; compared as record keys). Rows already at the
 * new path belong to a file that isn't there any more (nothing is ever moved onto an existing file): they are removed
 * first, all of them, so none merges into the moved file's (a stale correction for another track would). Returns how
 * many rows moved.
 */
export function movePathRows(from: string, to: string) {
  const a = keyOf(from);
  const b = keyOf(to);
  if (a === b) return 0;
  let moved = 0;
  tx(db, () => {
    for (const t of TABLES) {
      db.prepare(`DELETE FROM ${t} WHERE path = ?`).run(b);
      moved += Number(db.prepare(`UPDATE ${t} SET path = ? WHERE path = ?`).run(b, a).changes);
    }
  });
  invalidateOverrides();
  return moved;
}

/**
 * Drops every per-file row of a file that is gone for good (deleted without a bin): they describe that file only, and
 * a new file that later gets the same name must start clean. Returns how many rows went.
 */
export function deletePathRows(p: string) {
  const a = keyOf(p);
  let dropped = 0;
  tx(db, () => {
    for (const t of TABLES) dropped += Number(db.prepare(`DELETE FROM ${t} WHERE path = ?`).run(a).changes);
  });
  invalidateOverrides();
  return dropped;
}
