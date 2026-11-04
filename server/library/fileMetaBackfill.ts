/**
 * One-time (and harmless to repeat) repair: files AnimeArr's own importer placed for native shows before it kept
 * release details (file_meta) have an empty release group, scene name and quality, so group-trust counts and
 * quality-upgrade logic can't see them. This fills them from what is reliably known, and leaves the rest empty:
 *  1. the grab the import came from (the Activity log's import entry names the grab, the grab names the release);
 *  2. otherwise, only for a file AnimeArr never imported (so its name is the release's own), the group in its name.
 * AnimeArr's renamed file names are never parsed: they don't carry the release's group.
 */
import path from "node:path";
import { cache, db, dbState, tx } from "../system/db.js";
import { NATIVE_BASE } from "./nativeIds.js";
import { parseRelease } from "../core/parser.js";
import { qualityName, releaseMeta } from "../import/importer.js";
import { saveFileMeta } from "../import/pathRows.js";

/** Fills file_meta for native files that have none. Returns how many files got details. */
export function backfillFileMeta() {
  if (dbState.corrupt) return 0;
  const files = cache.prepare("SELECT path, resolution FROM files WHERE series_id >= ?").all(NATIVE_BASE) as {
    path: string;
    resolution: string | null;
  }[];
  const have = new Set((db.prepare("SELECT path FROM file_meta").all() as { path: string }[]).map((r) => r.path));
  const todo = files.filter((f) => !have.has(f.path));
  if (!todo.length) return 0;
  // dest → the release of the grab that was imported there (the newest import of a path wins) / every dest AnimeArr imported.
  const imported = new Set<string>();
  const grabRelease = new Map<string, string>();
  const rows = db
    .prepare(
      `SELECT json_extract(d.detail, '$.dest') AS dest, g.release AS release
         FROM decisions d LEFT JOIN grabs g ON g.id = json_extract(d.detail, '$.grabId')
        WHERE d.kind = 'import' AND d.why LIKE 'Imported%' AND json_extract(d.detail, '$.dest') IS NOT NULL
        ORDER BY d.id`,
    )
    .all() as { dest: string; release: string | null }[];
  for (const r of rows) {
    imported.add(r.dest);
    if (r.release) grabRelease.set(r.dest, r.release);
    else grabRelease.delete(r.dest); // the newest import had no grab: an older grab's release is not this file's
  }
  let n = 0;
  tx(db, () => {
    for (const f of todo) {
      const height = Number(/x(\d+)$/.exec(f.resolution ?? "")?.[1]) || null;
      const release = grabRelease.get(f.path);
      if (release) {
        saveFileMeta(f.path, releaseMeta(release, qualityName(release, height)));
        n++;
        continue;
      }
      if (imported.has(f.path)) continue; // imported without a known release; the name is AnimeArr's: can't tell
      const name = path.posix.basename(f.path.replace(/\\/g, "/")).replace(/\.[^.]+$/, "");
      if (!parseRelease(name).group) continue; // not recognisably a release name: leave it empty
      saveFileMeta(f.path, releaseMeta(name, qualityName(name, height)));
      n++;
    }
  });
  return n;
}
