/**
 * The files a season has now, set against SeaDex's picks (Details, the episode sheet). Files are judged by their
 * ORIGINAL release name: the scene name recorded at import, so a Tdarr re-encode still counts as what it came from.
 */
import { compareToSeadex, pickOfRelease, type SeadexComparison } from "./core/seadexCompare.js";
import { cache, db } from "./db.js";
import { profileFor } from "./profiles.js";
import { seadexForSeason } from "./seadex.js";

/** The original release name of a library file: its recorded scene name, else the file name. */
export const releaseOf = (f: { path: string; scene_name: string | null }) => {
  if (f.scene_name?.trim()) return f.scene_name.trim();
  const meta = db.prepare("SELECT scene_name FROM file_meta WHERE path = ?").get(f.path) as { scene_name: string | null } | undefined;
  return meta?.scene_name?.trim() || f.path.split("/").pop()!.replace(/\.[a-z0-9]{2,4}$/i, "");
};

/** How a season's files compare to SeaDex's picks (null: SeaDex has no picks for it, or the season has no files). */
export function seasonComparison(tvdbId: number, season: number): SeadexComparison | null {
  const series = cache.prepare("SELECT id FROM series WHERE tvdb_id = ?").get(tvdbId) as { id: number } | undefined;
  if (!series) return null;
  const entry = seadexForSeason(tvdbId, season);
  if (!entry) return null;
  const rows = cache.prepare("SELECT f.path, f.scene_name FROM episodes e JOIN files f ON f.id = e.file_id WHERE e.series_id = ? AND e.season = ? AND e.has_file = 1").all(series.id, season) as { path: string; scene_name: string | null }[];
  return compareToSeadex(rows.map(releaseOf), entry, profileFor(tvdbId).watchMode);
}

/** "best" / "alt" when one file is on a SeaDex pick (for the episode sheet's chip). */
export function filePick(tvdbId: number, season: number, f: { path: string; sceneName: string | null }) {
  return pickOfRelease(releaseOf({ path: f.path, scene_name: f.sceneName }), seadexForSeason(tvdbId, season), profileFor(tvdbId).watchMode);
}
