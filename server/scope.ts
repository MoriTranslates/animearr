/**
 * Per-show monitoring scope (Sonarr's "Monitor" options, plus "most recent N seasons"): which episodes of a managed
 * show AnimeArr searches for. Two parts:
 *   seasons:  all | first | latest | recent (N most recent seasons)
 *   episodes: all (aired) | missing | future | futureAndMissing | existing | none
 *   specials: S0 included or not
 * Defaults: ended shows "Missing only" (all seasons); continuing shows "Future + missing of the latest season".
 * (Long-runners: seasons are TVDB seasons for now; AniDB entries/cours come with the own metadata, step 4.)
 */
import { isCreditlessTitle } from "./core/resolver.js";
import { anidbSpecialKind } from "./anidb.js";
import { cache, db } from "./db.js";
import { getSettings } from "./settings.js";

export type SeasonScope = "all" | "first" | "latest" | "recent";
export type EpisodeScope = "all" | "missing" | "future" | "futureAndMissing" | "existing" | "none";
export interface Scope { seasons: SeasonScope; recentN: number; episodes: EpisodeScope; specials: boolean; /** Creditless OP/ED (NCOP/NCED) specials, even when other specials are off. */ creditless: boolean }
/** Default scopes (no own scope yet) keep honouring Sonarr's per-episode monitored flags, so upgrading never widens what an existing managed show searches. */
export const SEASON_SCOPES: SeasonScope[] = ["all", "first", "latest", "recent"];
export const EPISODE_SCOPES: EpisodeScope[] = ["all", "missing", "future", "futureAndMissing", "existing", "none"];

interface Row { tvdb_id: number; seasons: SeasonScope; recent_n: number; episodes: EpisodeScope; specials: number; creditless?: number; since: number }

/** When creditless OP/ED became part of the default scope (shows managed before keep their search set). */
const CREDITLESS_FROM = Date.parse("2026-10-26T20:00:00Z");

/** The scope a show has: its own, else the default for its status. */
export function scopeFor(tvdbId: number): Scope & { source: "show" | "default"; since: number; honourSonarr?: boolean } {
  const r = db.prepare("SELECT * FROM series_scope WHERE tvdb_id = ?").get(tvdbId) as Row | undefined;
  if (r) return { seasons: r.seasons, recentN: r.recent_n, episodes: r.episodes, specials: !!r.specials, creditless: r.creditless !== 0, source: "show", since: r.since };
  const status = (cache.prepare("SELECT status FROM series WHERE tvdb_id = ?").get(tvdbId) as { status: string } | undefined)?.status;
  const d = status === "ended" ? getSettings().scope.ended : getSettings().scope.continuing;
  const since = (db.prepare("SELECT since FROM managed WHERE tvdb_id = ?").get(tvdbId) as { since: number } | undefined)?.since ?? 0;
  // Creditless OP/ED on the default scope: for shows managed from now on, never widening what existing ones search.
  return { ...d, creditless: d.creditless !== false && since >= CREDITLESS_FROM, source: "default", since, honourSonarr: true };
}

export function validateScope(x: Partial<Scope>): Scope {
  if (!x.seasons || !SEASON_SCOPES.includes(x.seasons)) throw Object.assign(new Error("Unknown season scope"), { statusCode: 400 });
  if (!x.episodes || !EPISODE_SCOPES.includes(x.episodes)) throw Object.assign(new Error("Unknown episode scope"), { statusCode: 400 });
  const n = Math.round(Number(x.recentN ?? 1));
  if (!Number.isFinite(n) || n < 1 || n > 100) throw Object.assign(new Error("Most recent seasons: 1 to 100"), { statusCode: 400 });
  return { seasons: x.seasons, recentN: n, episodes: x.episodes, specials: x.specials === true, creditless: x.creditless !== false };
}

/** Sets (or clears, with null) a show's own scope. "Future" counts from when the episode mode was chosen. */
export function setScope(tvdbIds: number[], scope: Scope | null, now = Date.now()) {
  for (const id of tvdbIds) {
    if (!scope) db.prepare("DELETE FROM series_scope WHERE tvdb_id = ?").run(id);
    else
      db.prepare(
        "INSERT INTO series_scope (tvdb_id, seasons, recent_n, episodes, specials, creditless, since) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tvdb_id) DO UPDATE SET seasons = excluded.seasons, recent_n = excluded.recent_n, specials = excluded.specials, creditless = excluded.creditless, since = CASE WHEN series_scope.episodes = excluded.episodes THEN series_scope.since ELSE excluded.since END, episodes = excluded.episodes",
      ).run(id, scope.seasons, scope.recentN, scope.episodes, scope.specials ? 1 : 0, scope.creditless === false ? 0 : 1, now);
  }
}

export interface ScopeEp { id: number; season: number; air_utc: number | null; has_file: number; monitored?: number; creditless?: boolean }

/** Which of a show's episodes are in scope (aired ones to search, plus future ones to watch for). */
export function inScope(scope: Scope & { since?: number; honourSonarr?: boolean }, eps: ScopeEp[], now = Date.now()) {
  const regular = [...new Set(eps.filter((e) => e.season > 0).map((e) => e.season))].sort((a, b) => a - b);
  // "Latest"/"recent N" count seasons that have started airing; later placeholder seasons (all TBA/future) come along.
  const started = regular.filter((n) => eps.some((e) => e.season === n && e.air_utc !== null && e.air_utc <= now));
  const lastStarted = started.at(-1) ?? 0;
  const later = regular.filter((n) => n > lastStarted);
  const seasons = new Set<number>(
    scope.seasons === "all" ? regular : scope.seasons === "first" ? regular.slice(0, 1) : [...(scope.seasons === "latest" ? started.slice(-1) : started.slice(-scope.recentN)), ...later],
  );
  if (scope.specials) seasons.add(0);
  const since = scope.since ?? 0;
  const aired = (e: ScopeEp) => e.air_utc !== null && e.air_utc <= now;
  const future = (e: ScopeEp) => e.air_utc === null || e.air_utc > since;
  return eps.filter((e) => {
    // Creditless OP/ED join on their own toggle (whatever the season scope); the episode rules below still apply.
    const creditlessIn = e.season === 0 && !!e.creditless && scope.creditless !== false;
    if (!seasons.has(e.season) && !creditlessIn) return false;
    if (scope.honourSonarr && e.monitored === 0) return false;
    switch (scope.episodes) {
      case "none":
        return false;
      case "existing":
        return !!e.has_file;
      case "future":
        return future(e);
      case "missing":
        return !e.has_file && aired(e);
      case "futureAndMissing":
        return future(e) || (!e.has_file && aired(e));
      default:
        return true;
    }
  });
}

let epsStmt: ReturnType<typeof cache.prepare> | null = null;
/** AniDB special kinds per show, cached for 10 minutes (the managed tick asks for every show). */
const kindsMemo = new Map<number, { at: number; v: Map<number, { type: string }> }>();
function kindsFor(tvdbId: number) {
  const hit = kindsMemo.get(tvdbId);
  if (hit && Date.now() - hit.at < 600_000) return hit.v;
  const v = anidbSpecialKind(tvdbId);
  kindsMemo.set(tvdbId, { at: Date.now(), v });
  return v;
}
/** A show's episodes for scoping, with season-0 creditless OP/EDs marked (by title or AniDB's "credit" type). */
function scopeEps(tvdbId: number, seriesId: number): ScopeEp[] {
  epsStmt ??= cache.prepare("SELECT id, season, episode, title, air_utc, has_file, monitored FROM episodes WHERE series_id = ?");
  const rows = epsStmt.all(seriesId) as unknown as (ScopeEp & { episode: number; title: string | null })[];
  // Creditless OP/EDs AnimeArr imported as Plex extras: they're there (Sonarr doesn't see extras).
  const extras = new Set<number>();
  for (const r of db.prepare("SELECT episode_ids FROM file_links WHERE tvdb_id = ? AND path LIKE '%/Other/%'").all(tvdbId) as { episode_ids: string }[]) for (const id of JSON.parse(r.episode_ids) as number[]) extras.add(id);
  let kinds: Map<number, { type: string }> | null = null;
  return rows.map((e) => {
    if (e.season !== 0) return e;
    if (!isCreditlessTitle(e.title)) kinds ??= kindsFor(tvdbId);
    const creditless = isCreditlessTitle(e.title) || kinds?.get(e.episode)?.type === "credit";
    return { ...e, creditless, has_file: e.has_file || (creditless && extras.has(e.id) ? 1 : 0) };
  });
}

/** The episode ids a managed show's searches may cover (cached per call site by the caller). */
export function scopedEpisodeIds(tvdbId: number, seriesId: number, now = Date.now()): Set<number> {
  const eps = scopeEps(tvdbId, seriesId);
  return new Set(inScope(scopeFor(tvdbId), eps, now).map((e) => e.id));
}

/** Live preview for the UI: "Will monitor 3 seasons · 52 episodes · 6 missing". */
export function scopePreview(tvdbId: number, scope: Scope & { since?: number; honourSonarr?: boolean }, now = Date.now()) {
  const s = cache.prepare("SELECT id FROM series WHERE tvdb_id = ?").get(tvdbId) as { id: number } | undefined;
  if (!s) throw Object.assign(new Error("Unknown series"), { statusCode: 404 });
  const eps = scopeEps(tvdbId, s.id);
  const list = inScope({ ...scope, since: scope.since ?? now }, eps, now);
  return { seasons: new Set(list.map((e) => e.season)).size, episodes: list.length, missing: list.filter((e) => !e.has_file && e.air_utc !== null && e.air_utc <= now).length, upcoming: list.filter((e) => e.air_utc === null || e.air_utc > now).length };
}
