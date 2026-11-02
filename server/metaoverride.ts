/**
 * "Episode info source": the user's per-season choice of which TMDB show/season/offset the episode plots and thumbnails
 * come from, for when the catalog mapping (Anime-Lists) is wrong for them. Metadata only: server/episodemeta.ts and the
 * routes are the only readers. Matching, numbering, search, import, the catalog and the Sonarr API never see it.
 */
import { tmdbFetch } from "./catalog.js";
import type { FastifyInstance } from "fastify";
import { db } from "./system/db.js";

export interface MetaOverride {
  tmdbTv: number;
  tmdbSeason: number;
  tmdbOffset: number;
  setAt: number;
}

interface Row {
  tmdb_tv: number;
  tmdb_season: number;
  tmdb_offset: number;
  set_at: number;
}
const fromRow = (r: Row): MetaOverride => ({ tmdbTv: r.tmdb_tv, tmdbSeason: r.tmdb_season, tmdbOffset: r.tmdb_offset, setAt: r.set_at });

/** season → override, for one show. */
export function metaOverrides(tvdbId: number): Map<number, MetaOverride> {
  const rows = db
    .prepare("SELECT season, tmdb_tv, tmdb_season, tmdb_offset, set_at FROM meta_overrides WHERE tvdb_id = ?")
    .all(tvdbId) as unknown as (Row & { season: number })[];
  return new Map(rows.map((r) => [r.season, fromRow(r)]));
}

export function getMetaOverride(tvdbId: number, season: number): MetaOverride | null {
  const r = db
    .prepare("SELECT tmdb_tv, tmdb_season, tmdb_offset, set_at FROM meta_overrides WHERE tvdb_id = ? AND season = ?")
    .get(tvdbId, season) as Row | undefined;
  return r ? fromRow(r) : null;
}

export function setMetaOverride(
  tvdbId: number,
  season: number,
  o: { tmdbTv: number; tmdbSeason: number; tmdbOffset: number },
  now = Date.now(),
) {
  db.prepare(
    `INSERT INTO meta_overrides (tvdb_id, season, tmdb_tv, tmdb_season, tmdb_offset, set_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tvdb_id, season) DO UPDATE SET tmdb_tv = excluded.tmdb_tv, tmdb_season = excluded.tmdb_season, tmdb_offset = excluded.tmdb_offset, set_at = excluded.set_at`,
  ).run(tvdbId, season, o.tmdbTv, o.tmdbSeason, o.tmdbOffset, now);
}

export function clearMetaOverride(tvdbId: number, season: number) {
  return db.prepare("DELETE FROM meta_overrides WHERE tvdb_id = ? AND season = ?").run(tvdbId, season).changes > 0;
}

/** Validates a PUT body: whole numbers, a TMDB id, a season, a sane offset. Throws a message fit for the user. */
export function parseOverride(body: unknown): { tmdbTv: number; tmdbSeason: number; tmdbOffset: number } {
  const b = (body ?? {}) as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN);
  const tmdbTv = int(b.tmdbTv);
  const tmdbSeason = int(b.tmdbSeason);
  const tmdbOffset = b.tmdbOffset === undefined || b.tmdbOffset === null || b.tmdbOffset === "" ? 0 : int(b.tmdbOffset);
  if (!Number.isInteger(tmdbTv) || tmdbTv <= 0) throw new Error("tmdbTv must be a TMDB show id (a positive whole number)");
  if (!Number.isInteger(tmdbSeason) || tmdbSeason < 0 || tmdbSeason > 1000)
    throw new Error("tmdbSeason must be a season number (0 or more)");
  if (!Number.isInteger(tmdbOffset) || Math.abs(tmdbOffset) > 10_000)
    throw new Error("tmdbOffset must be a whole number (TMDB episode = our episode + offset)");
  return { tmdbTv, tmdbSeason, tmdbOffset };
}

export interface TmdbShowHit {
  id: number;
  name: string;
  year: number | null;
  seasons: { season: number; episodes: number }[] | null;
}

/** A TMDB show's seasons with episode counts (null when TMDB can't say right now). */
export async function tmdbSeasons(
  tv: number,
  key: string,
  fetcher: typeof fetch = fetch,
): Promise<{ season: number; episodes: number }[] | null> {
  try {
    const res = await tmdbFetch(`/tv/${tv}?language=en-US`, key, fetcher);
    if (!res.ok) return null;
    const j = (await res.json()) as { seasons?: { season_number: number; episode_count?: number }[] };
    return (j.seasons ?? []).map((s) => ({ season: s.season_number, episodes: s.episode_count ?? 0 }));
  } catch {
    return null;
  }
}

/** TMDB TV search for the picker. The top few hits also get their season list (episode counts); the rest load it when picked. */
export async function searchTmdbShows(q: string, key: string, fetcher: typeof fetch = fetch): Promise<TmdbShowHit[]> {
  const res = await tmdbFetch(`/search/tv?query=${encodeURIComponent(q)}&language=en-US&include_adult=false`, key, fetcher);
  if (res.status === 401) throw new Error("TMDB refused the key: check it in Settings → Metadata");
  if (!res.ok) throw new Error(`TMDB answered ${res.status}`);
  const j = (await res.json()) as { results?: { id: number; name?: string; original_name?: string; first_air_date?: string }[] };
  const hits: TmdbShowHit[] = (j.results ?? []).slice(0, 8).map((r) => ({
    id: r.id,
    name: r.name || r.original_name || String(r.id),
    year: Number(r.first_air_date?.slice(0, 4)) || null,
    seasons: null,
  }));
  for (const h of hits.slice(0, 3)) h.seasons = await tmdbSeasons(h.id, key, fetcher);
  return hits;
}

/** The episodes' titles of one TMDB season, for the "does this look right?" preview. */
export async function tmdbSeasonTitles(
  tv: number,
  season: number,
  key: string,
  fetcher: typeof fetch = fetch,
): Promise<{ episode: number; name: string }[]> {
  const res = await tmdbFetch(`/tv/${tv}/season/${season}?language=en-US`, key, fetcher);
  if (res.status === 404) return [];
  if (res.status === 401) throw new Error("TMDB refused the key: check it in Settings → Metadata");
  if (!res.ok) throw new Error(`TMDB answered ${res.status}`);
  const j = (await res.json()) as { episodes?: { episode_number: number; name?: string }[] };
  return (j.episodes ?? []).map((e) => ({ episode: e.episode_number, name: e.name ?? "" }));
}

export interface MetaRouteDeps {
  fetch: typeof fetch;
  key: () => string;
  writable: () => void;
}

/** The catalog mapping for one season as the metadata sees it (first of its first episodes the catalog covers). */
function catalogSource(tvdbId: number, season: number) {
  const rows = db
    .prepare(
      "SELECT tvdb_season, tvdb_offset, episodes, tmdb_tv, tmdb_season, tmdb_offset FROM entries WHERE tvdb_id = ? AND tvdb_season IS NOT NULL AND tvdb_season != '0' ORDER BY tvdb_offset DESC",
    )
    .all(tvdbId) as unknown as Parameters<typeof tmdbTarget>[0];
  for (let ep = 1; ep <= 3; ep++) {
    const t = tmdbTarget(rows, season, ep, null);
    if (t) return { tmdbTv: t.tv, tmdbSeason: t.season, tmdbOffset: t.episode - ep };
  }
  return null;
}

export function registerMetaOverrideApi(app: FastifyInstance, deps: MetaRouteDeps) {
  const bad = (msg: string, code = 400) => Object.assign(new Error(msg), { statusCode: code });
  const whole = (v: unknown, min: number, what: string) => {
    const n = Number(v);
    if (typeof v !== "string" || v.trim() === "" || !Number.isInteger(n) || n < min) throw bad(`Bad ${what}`);
    return n;
  };
  const key = () => {
    const k = deps.key();
    if (!k) throw bad("Add a TMDB API key in Settings → Metadata first", 409);
    return k;
  };
  const upstream = async <T>(f: () => Promise<T>) => {
    try {
      return await f();
    } catch (e) {
      throw bad((e as Error).message || "TMDB can't be reached right now", 502);
    }
  };

  app.get<{ Params: { tvdbId: string; season: string } }>("/api/series/:tvdbId/meta-override/:season", async (req) => {
    const tvdbId = whole(req.params.tvdbId, 1, "id");
    const season = whole(req.params.season, 0, "season");
    return { override: getMetaOverride(tvdbId, season), catalog: catalogSource(tvdbId, season) };
  });
  app.put<{ Params: { tvdbId: string; season: string }; Body: unknown }>("/api/series/:tvdbId/meta-override/:season", async (req) => {
    deps.writable();
    const tvdbId = whole(req.params.tvdbId, 1, "id");
    const season = whole(req.params.season, 0, "season");
    let o;
    try {
      o = parseOverride(req.body);
    } catch (e) {
      throw bad((e as Error).message);
    }
    setMetaOverride(tvdbId, season, o);
    return { override: getMetaOverride(tvdbId, season), catalog: catalogSource(tvdbId, season) };
  });
  app.delete<{ Params: { tvdbId: string; season: string } }>("/api/series/:tvdbId/meta-override/:season", async (req) => {
    deps.writable();
    const tvdbId = whole(req.params.tvdbId, 1, "id");
    const season = whole(req.params.season, 0, "season");
    clearMetaOverride(tvdbId, season);
    return { override: null, catalog: catalogSource(tvdbId, season) };
  });
  /** The picker: TMDB TV search, with the top hits' season lists. */
  app.get<{ Querystring: { q?: string } }>("/api/tmdb/search", async (req) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) throw bad("Type a title to search for");
    const k = key();
    return upstream(() => searchTmdbShows(q, k, deps.fetch));
  });
  /** A picked show's seasons (for hits the search didn't expand) and, with ?season=, that season's episode titles. */
  app.get<{ Params: { id: string }; Querystring: { season?: string } }>("/api/tmdb/tv/:id", async (req) => {
    const id = whole(req.params.id, 1, "id");
    const k = key();
    const seasons = await tmdbSeasons(id, k, deps.fetch);
    const season = req.query.season === undefined ? null : whole(req.query.season, 0, "season");
    return { id, seasons, titles: season === null ? null : await upstream(() => tmdbSeasonTitles(id, season, k, deps.fetch)) };
  });
}

// ---------------------------------------------------------------- TMDB episode mapping (used by episodemeta.ts)

export interface MapRow {
  tvdb_season: string;
  tvdb_offset: number;
  episodes: number | null;
  tmdb_tv: number | null;
  tmdb_season: number | null;
  tmdb_offset: number;
}

/** The TMDB episode (show, season, number) for one AnimeArr episode, through the entry that covers it. Specials aren't guessed. */
export function tmdbTarget(
  rows: MapRow[],
  season: number,
  episode: number,
  absolute: number | null,
  overrides?: Map<number, MetaOverride>,
) {
  // The user's choice for this season replaces the catalog mapping (and is the only way specials get a TMDB episode).
  const o = overrides?.get(season);
  if (o) return { tv: o.tmdbTv, season: o.tmdbSeason, episode: episode + o.tmdbOffset };
  if (season === 0) return null;
  for (const r of rows) {
    // AnimeArr/TVDB numbering → the entry's own episode number (as catalogLookup), then → TMDB numbering with tmdb_offset.
    const n =
      r.tvdb_season === "a"
        ? absolute
          ? absolute - r.tvdb_offset
          : null
        : Number(r.tvdb_season) === season
          ? episode - r.tvdb_offset
          : null;
    if (!n || n < 1 || (r.episodes && n > r.episodes)) continue;
    if (!r.tmdb_tv || r.tmdb_season === null) return null;
    return { tv: r.tmdb_tv, season: r.tmdb_season, episode: n + (r.tmdb_offset ?? 0) };
  }
  return null;
}
