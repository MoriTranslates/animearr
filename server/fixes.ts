import { db } from "./db.js";

/**
 * Every problem carries its fix (the user's rule): a structured list of actions, rendered as buttons right where the
 * problem shows (Queue, Activity, the bell, toasts, the show/movie/episode sheets) and linked from Discord/ntfy.
 * One place maps a problem to its fixes, so new errors get actions consistently.
 */
export type FixAction =
  | "importManual" // open the import dialog pre-filled with the file and the matched episode/movie
  | "pickEpisode" // same dialog, choosing the episode
  | "regrab" // search again (the bad release stays blocklisted)
  | "keepAnyway" // import this download despite the failed language check
  | "openRule" // Settings → Downloads
  | "resumeRule" // switch the pausing rule off
  | "resumeImports" // AnimeArr's importer on, no review pause
  | "tryNext" // the next candidate of this grab
  | "interactiveSearch" // the interactive search for the episode/movie
  | "testConnection" // test a download client / service
  | "indexerHealth"; // where indexer failures are shown

export interface Fix { action: FixAction; label: string; params?: Record<string, unknown> }

export interface FixContext { grabId?: number | null; tvdbId?: number | null; movieId?: number | null; episodeIds?: number[]; kind?: string }

const SERVICES: [RegExp, string, string][] = [
  [/SABnzbd/i, "sabnzbd", "SABnzbd"],
  [/qBittorrent/i, "qbittorrent", "qBittorrent"],
  [/Prowlarr/i, "prowlarr", "Prowlarr"],
  [/Sonarr/i, "sonarr", "Sonarr"],
  [/Radarr/i, "radarr", "Radarr"],
  [/\bPlex\b/i, "plex", "Plex"],
];

/** The fixes for a problem message (and what it's about). */
export function fixesFor(why: string, ctx: FixContext = {}): Fix[] {
  const out: Fix[] = [];
  const add = (f: Fix) => !out.some((x) => x.action === f.action) && out.push(f);
  const target = ctx.movieId ? { movieId: ctx.movieId } : ctx.tvdbId ? { tvdbId: ctx.tvdbId, episodeIds: ctx.episodeIds ?? [] } : {};
  if (/only a manual import can take it|isn't in AnimeArr's own download folders/i.test(why)) {
    const path = /(\/data\/\S[^]*?) isn't in AnimeArr's own/i.exec(why)?.[1] ?? null;
    add({ action: "importManual", label: "Import manually…", params: { ...target, path, grabId: ctx.grabId ?? null } });
  }
  if (/couldn't tell which (?:file is which )?episode|couldn't map the episode|two files look like the same episode|import (?:it|them|this one) by hand/i.test(why)) add({ action: "pickEpisode", label: "Pick episode…", params: { ...target, grabId: ctx.grabId ?? null } });
  if ((ctx.kind === "verify-fail" || /failed verification/i.test(why)) && /sub|English|dialogue|audio|dub/i.test(why)) {
    add({ action: "regrab", label: "Re-grab", params: target });
    // Already imported (checked after the import): there's nothing left to keep; the file stays until a better one.
    if (ctx.grabId && !/already imported/i.test(why)) add({ action: "keepAnyway", label: "Keep anyway", params: { grabId: ctx.grabId } });
  }
  if (/download-folder rule|Grabs are paused|grabs paused/i.test(why)) {
    add({ action: "openRule", label: "Open rule" });
    const rule = /rule "([^"]+)"/.exec(why)?.[1];
    if (rule && !/free/i.test(why)) add({ action: "resumeRule", label: "Turn rule off", params: { name: rule } });
  }
  if (/importer is paused|real (?:movie )?imports by AnimeArr's importer are switched off|aren't switched on yet/i.test(why)) add({ action: "resumeImports", label: "Resume imports", params: { movies: !!ctx.movieId || /\bmovie/i.test(why) } });
  // "No more candidates" means the automatic next already ran out: only the interactive search helps then.
  if (ctx.grabId && /fail|couldn't send|SABnzbd:|download (?:failed|error)|stalled|missing from/i.test(why) && !/verification|no more candidates/i.test(why)) add({ action: "tryNext", label: "Try next release", params: { grabId: ctx.grabId } });
  if ((ctx.tvdbId || ctx.movieId) && /fail|nothing found|needs a look|no result|no more candidates|couldn't|wrong/i.test(why)) add({ action: "interactiveSearch", label: "Interactive search", params: target });
  if (/unreachable|ECONNREFUSED|ETIMEDOUT|timed out|not configured|refused the (?:token|key)|HTTP 401/i.test(why))
    for (const [re, service, name] of SERVICES) if (re.test(why)) {
      add({ action: "testConnection", label: `Test ${name}`, params: { service } });
      break;
    }
  if (/indexer|Prowlarr/i.test(why) && /fail|error|HTTP|unreachable/i.test(why)) add({ action: "indexerHealth", label: "Indexer health" });
  return out;
}

/**
 * A newer real grab for the same episodes/movie (the automatic next candidate, or one the user started): once it
 * exists, "Keep anyway" / "Try next release" on the old grab would fight it (or overwrite what it imported).
 */
export function supersededBy(grabId: number): number | null {
  const row = db.prepare("SELECT id, episode_ids, movie_id FROM grabs WHERE id = ?").get(grabId) as { id: number; episode_ids: string; movie_id: number | null } | undefined;
  if (!row) return null;
  const eps = JSON.parse(row.episode_ids) as number[];
  const newer = db.prepare("SELECT id, episode_ids, movie_id FROM grabs WHERE id > ? AND dry_run = 0 AND state IN ('sending', 'downloading', 'importing', 'needs-attention', 'done')").all(grabId) as { id: number; episode_ids: string; movie_id: number | null }[];
  const hit = newer.find((o) => (row.movie_id ? o.movie_id === row.movie_id : !o.movie_id && (JSON.parse(o.episode_ids) as number[]).some((e) => eps.includes(e))));
  return hit?.id ?? null;
}

/** fixesFor, minus the grab actions that no longer apply (the grab moved on, or something newer replaced it). */
export function liveFixesFor(why: string, ctx: FixContext = {}): Fix[] {
  const fixes = fixesFor(why, ctx);
  if (!ctx.grabId || !fixes.some((f) => f.action === "keepAnyway" || f.action === "tryNext")) return fixes;
  const st = (db.prepare("SELECT state FROM grabs WHERE id = ?").get(ctx.grabId) as { state: string } | undefined)?.state;
  const stale = !st || !["failed", "needs-attention"].includes(st) || supersededBy(ctx.grabId) !== null;
  return stale ? fixes.filter((f) => f.action !== "keepAnyway" && f.action !== "tryNext") : fixes;
}

/** Where an item lives in the UI (for Discord/ntfy links). */
export function linkFor(ctx: FixContext, externalUrl: string) {
  const base = externalUrl.replace(/\/+$/, "");
  if (!base) return null;
  if (ctx.movieId) return `${base}/movie/${ctx.movieId}`;
  if (ctx.tvdbId) return `${base}/show/${ctx.tvdbId}`;
  if (ctx.grabId) return `${base}/queue`;
  return `${base}/activity`;
}
