/** The list of managed shows (a leaf: SeaDex, quality upgrades, episodes and home read it without importing managed.ts). */
import { db } from "../system/db.js";
import { NATIVE_BASE } from "./nativeIds.js";

export interface ManagedRow {
  tvdbId: number;
  seriesId: number;
  title: string;
  dryRun: boolean;
  since: number;
  unmonitoredInSonarr: boolean;
  /** Sonarr's copy is the one AnimeArr uses (false for shows AnimeArr owns: it never touches Sonarr about those). */
  sonarrShow: boolean;
}

export function listManaged(): ManagedRow[] {
  return (
    db.prepare("SELECT tvdb_id, series_id, title, dry_run, since, unmonitored_in_sonarr FROM managed ORDER BY title").all() as {
      tvdb_id: number;
      series_id: number;
      title: string;
      dry_run: number;
      since: number;
      unmonitored_in_sonarr: number;
    }[]
  ).map((r) => ({
    tvdbId: r.tvdb_id,
    seriesId: r.series_id,
    title: r.title,
    dryRun: !!r.dry_run,
    since: r.since,
    unmonitoredInSonarr: !!r.unmonitored_in_sonarr,
    sonarrShow: r.series_id < NATIVE_BASE,
  }));
}
