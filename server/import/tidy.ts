/**
 * Small clean-ups after AnimeArr's own importer or renamer touched a file (Settings → Media management):
 * - "Change file date": the file's modified time becomes the episode's air date (Sonarr's semantics);
 * - "Delete empty folders": a season or show folder that AnimeArr just emptied is removed. Only truly empty folders
 *   (no files at all, hidden ones included), only the show's own folder or below, never a library root folder.
 */
import fs from "node:fs";
import path from "node:path";
import { cache } from "../system/db.js";
import { libraryRoots } from "./mediafiles.js";
import { mappedPath } from "../system/paths.js";
import { getSettings, underAllowedRoot } from "../system/settings.js";

/** The mtime a file should get for these episodes, or null (setting off, no air date, a future or pre-1970 date). */
export function airDateMtime(
  episodeIds: number[],
  mode: "none" | "localAirDate" | "utcAirDate" = getSettings().media.fileDate,
  now = Date.now(),
): Date | null {
  if (mode === "none" || !episodeIds.length) return null;
  const rows = cache
    .prepare(`SELECT air_utc FROM episodes WHERE id IN (${episodeIds.map(() => "?").join(",")}) AND air_utc IS NOT NULL`)
    .all(...episodeIds) as { air_utc: number }[];
  if (!rows.length) return null;
  const first = new Date(Math.min(...rows.map((r) => r.air_utc))); // a multi-episode file takes its first episode's date
  // UTC: the exact air time. Local: that day's date at midnight in the server's time zone.
  const t = mode === "utcAirDate" ? first : new Date(first.getFullYear(), first.getMonth(), first.getDate());
  return t.getTime() < Date.UTC(1970, 0, 2) || t.getTime() > now ? null : t;
}

/** Sets a file's modified time to the episodes' air date when "Change file date" asks for it. Never fails an import. */
export function applyFileDate(localFile: string, episodeIds: number[]): boolean {
  try {
    const t = airDateMtime(episodeIds);
    if (!t) return false;
    fs.utimesSync(localFile, t, t);
    return true;
  } catch {
    return false;
  }
}

const norm = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * Removes the given folders when empty, then their parents, up to and including the show's own folder, when
 * "Delete empty folders" is on. Returns the folders removed. A folder with anything in it (hidden files too), a
 * symlink, a library root folder or anything outside the show's folder is left alone.
 */
export function pruneEmptyFolders(dirs: string[], showFolder: string, enabled = getSettings().media.deleteEmptyFolders): string[] {
  const removed: string[] = [];
  if (!enabled) return removed;
  const show = norm(showFolder);
  const roots = [...getSettings().allowedRoots, ...libraryRoots()].map((r) => norm(mappedPath(r.replace(/\/+$/, ""))));
  // The show folder has to sit below a root folder (never the root itself).
  if (roots.includes(show) || !roots.some((r) => within(show, r))) return removed;
  for (const start of dirs) {
    let d = norm(start);
    while (within(d, show) && !roots.includes(d)) {
      try {
        if (fs.lstatSync(d).isSymbolicLink() || fs.readdirSync(d).length) break;
        fs.rmdirSync(d); // only ever succeeds on an empty folder
        removed.push(d);
      } catch {
        break;
      }
      d = path.dirname(d);
    }
  }
  return removed;
}

/** For the importer: prune after a series' file moved away, only for shows inside the allowed roots. */
export function tidyAfterMove(oldFiles: string[], seriesPath: string): string[] {
  if (!getSettings().media.deleteEmptyFolders || !underAllowedRoot(seriesPath)) return [];
  return pruneEmptyFolders(
    oldFiles.map((f) => path.dirname(f)),
    mappedPath(seriesPath),
  );
}
