/**
 * Franchise links between Sonarr series and Radarr movies ("rehomed ingestion-wise": the movie belongs to its show in
 * AnimeArr, while its files stay in Radarr's movie folder for Plex).
 *
 * Sources, in order:
 * 1. Anime-Lists: an AniDB entry mapped to the series' TVDB id and to a TMDB movie id (often with the TVDB S0
 *    episode it occupies, e.g. Bleach S0E3 = Memories of Nobody).
 * 2. Title: the movie's title starts with the series title ("Bleach: Hell Verse" → Bleach), whole words only.
 * 3. Your corrections: links added or removed by hand (franchise_links) always win.
 *
 * The S0 episodes that are really movies are flagged so they are never grabbed as episodes (Radarr handles them).
 */
import { animeListEntries } from "./metadata.js";
import { coverFor } from "./audit.js";
import { cache, db } from "./db.js";

export interface MovieLink { tvdbId: number; movieId: number | null; tmdbId: number | null; s0Episode: number | null; source: "anime-lists" | "title" | "manual"; name: string }

const norm = (t: string) =>
  t
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

interface MovieRow { id: number; tmdb_id: number | null; title: string; year: number | null; poster: string | null; has_file: number; is_anime: number }
interface SeriesRow { id: number; tvdb_id: number; title: string; poster: string | null; year: number | null }

let memo: { at: number; links: MovieLink[] } | null = null;
export const invalidateFranchise = () => void (memo = null);

/** All series ↔ movie links (cached for a minute; corrections invalidate it). */
export function allLinks(now = Date.now()): MovieLink[] {
  if (memo && now - memo.at < 60_000) return memo.links;
  const series = cache.prepare("SELECT id, tvdb_id, title, poster, year FROM series").all() as unknown as SeriesRow[];
  const seriesByTvdb = new Map(series.map((s) => [s.tvdb_id, s]));
  const movies = cache.prepare("SELECT id, tmdb_id, title, year, poster, has_file, is_anime FROM movies").all() as unknown as MovieRow[];
  const movieByTmdb = new Map(movies.filter((m) => m.tmdb_id).map((m) => [m.tmdb_id!, m]));
  const links = new Map<string, MovieLink>();
  const key = (tvdbId: number, movieId: number | null, tmdbId: number | null) => `${tvdbId}:${movieId ?? `tmdb${tmdbId}`}`;

  // 1. Anime-Lists.
  for (const e of animeListEntries().values()) {
    if (!e.tmdbMovie || !e.tvdbId || !seriesByTvdb.has(e.tvdbId)) continue;
    let s0: number | null = null;
    for (const m of e.mappings) if (m.anidbSeason === 1 && m.tvdbSeason === 0 && m.pairs.get(1)?.[0]) s0 = m.pairs.get(1)![0];
    if (s0 === null && e.defaultSeason === 0) s0 = 1 + (e.offset ?? 0);
    const mv = movieByTmdb.get(e.tmdbMovie) ?? null;
    links.set(key(e.tvdbId, mv?.id ?? null, e.tmdbMovie), { tvdbId: e.tvdbId, movieId: mv?.id ?? null, tmdbId: e.tmdbMovie, s0Episode: s0 || null, source: "anime-lists", name: mv ? mv.title : e.name });
  }
  // 2. Title prefix (anime movies only, series titles of 4+ characters, whole words, the longest series title wins).
  const linkedMovies = new Set([...links.values()].map((l) => l.movieId).filter(Boolean));
  // Series titles without a trailing "(2011)"; at least 6 characters or two words; the movie not older than the show.
  const titled = series
    .map((s) => ({ s, n: norm(s.title.replace(/\s*\((19|20)\d{2}\)\s*$/, "")) }))
    .filter((x) => x.n.length >= 6 || x.n.split(" ").length >= 2)
    .sort((a, b) => b.n.length - a.n.length);
  for (const m of movies) {
    if (!m.is_anime || linkedMovies.has(m.id)) continue;
    const mt = norm(m.title);
    const hit = titled.find((x) => (mt === x.n || mt.startsWith(`${x.n} `)) && !(x.s.year && m.year && m.year < x.s.year));
    if (hit) links.set(key(hit.s.tvdb_id, m.id, m.tmdb_id), { tvdbId: hit.s.tvdb_id, movieId: m.id, tmdbId: m.tmdb_id, s0Episode: null, source: "title", name: m.title });
  }
  // 3. Corrections.
  for (const c of db.prepare("SELECT tvdb_id, movie_id, action FROM franchise_links").all() as { tvdb_id: number; movie_id: number; action: "link" | "unlink" }[]) {
    const m = movies.find((x) => x.id === c.movie_id);
    const k = key(c.tvdb_id, c.movie_id, m?.tmdb_id ?? null);
    if (c.action === "unlink") {
      links.delete(k);
      // An Anime-Lists link stored before the movie was in Radarr has a tmdb key; drop that too.
      if (m?.tmdb_id) links.delete(key(c.tvdb_id, null, m.tmdb_id));
    } else if (m) {
      const prev = links.get(k);
      links.set(k, { tvdbId: c.tvdb_id, movieId: m.id, tmdbId: m.tmdb_id, s0Episode: prev?.s0Episode ?? null, source: "manual", name: m.title });
    }
  }
  memo = { at: now, links: [...links.values()] };
  return memo.links;
}

/** The franchise's movies, for the series page. */
export function moviesForSeries(tvdbId: number) {
  return allLinks()
    .filter((l) => l.tvdbId === tvdbId)
    .map((l) => {
      const m = l.movieId ? (cache.prepare("SELECT id, title, year, poster, has_file, monitored FROM movies WHERE id = ?").get(l.movieId) as { id: number; title: string; year: number | null; poster: string | null; has_file: number; monitored: number } | undefined) : undefined;
      return { movieId: m?.id ?? null, tmdbId: l.tmdbId, title: m ? m.title : l.name, year: m?.year ?? null, cover: m?.poster ?? null, inRadarr: !!m, hasFile: !!m?.has_file, s0Episode: l.s0Episode, source: l.source };
    })
    .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));
}

/** The series a movie belongs to, for the movie page. */
export function seriesForMovie(movieId: number) {
  return allLinks()
    .filter((l) => l.movieId === movieId)
    .map((l) => {
      const s = cache.prepare("SELECT tvdb_id, title, poster FROM series WHERE tvdb_id = ?").get(l.tvdbId) as { tvdb_id: number; title: string; poster: string | null } | undefined;
      return s ? { tvdbId: s.tvdb_id, title: s.title, cover: coverFor(s), source: l.source } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
}

/**
 * S0 episodes that are really movies: episode id → the movie (Radarr's, when it has it). Matched by Anime-Lists'
 * S0 episode number, or by title for the other links.
 */
export function movieSpecials(seriesId?: number): Map<number, { movieId: number | null; title: string }> {
  const out = new Map<number, { movieId: number | null; title: string }>();
  const series = (seriesId ? cache.prepare("SELECT id, tvdb_id FROM series WHERE id = ?").all(seriesId) : cache.prepare("SELECT id, tvdb_id FROM series").all()) as { id: number; tvdb_id: number }[];
  const byTvdb = new Map<number, MovieLink[]>();
  for (const l of allLinks()) byTvdb.set(l.tvdbId, [...(byTvdb.get(l.tvdbId) ?? []), l]);
  for (const s of series) {
    const links = byTvdb.get(s.tvdb_id);
    if (!links) continue;
    const s0 = cache.prepare("SELECT id, episode, title FROM episodes WHERE series_id = ? AND season = 0").all(s.id) as { id: number; episode: number; title: string | null }[];
    for (const l of links) {
      const movieTitle = l.movieId ? ((cache.prepare("SELECT title FROM movies WHERE id = ?").get(l.movieId) as { title: string } | undefined)?.title ?? l.name) : l.name;
      let ep = l.s0Episode ? s0.find((e) => e.episode === l.s0Episode) : undefined;
      if (!ep) {
        // Title fallback: the S0 title is the movie title without the series prefix (or the whole thing).
        const mt = norm(movieTitle);
        ep = s0.find((e) => e.title && (mt === norm(e.title) || (norm(e.title).length >= 8 && mt.endsWith(` ${norm(e.title)}`))));
      }
      if (ep) out.set(ep.id, { movieId: l.movieId, title: movieTitle });
    }
  }
  return out;
}

/** Hand corrections. */
export function setLink(tvdbId: number, movieId: number, on: boolean) {
  if (!cache.prepare("SELECT 1 FROM series WHERE tvdb_id = ?").get(tvdbId)) throw Object.assign(new Error("Unknown series"), { statusCode: 404 });
  if (!cache.prepare("SELECT 1 FROM movies WHERE id = ?").get(movieId)) throw Object.assign(new Error("Unknown movie"), { statusCode: 404 });
  db.prepare("INSERT INTO franchise_links (tvdb_id, movie_id, action, at) VALUES (?, ?, ?, ?) ON CONFLICT(tvdb_id, movie_id) DO UPDATE SET action = excluded.action, at = excluded.at").run(tvdbId, movieId, on ? "link" : "unlink", Date.now());
  invalidateFranchise();
}

/**
 * S0 specials that are movies Radarr has (only then: without Radarr, or for a movie Radarr doesn't have, the special
 * stays grabbable as an episode).
 */
export function radarrMovieSpecials(seriesId: number) {
  const out = new Map<number, { movieId: number; title: string }>();
  for (const [ep, m] of movieSpecials(seriesId)) if (m.movieId !== null) out.set(ep, { movieId: m.movieId, title: m.title });
  return out;
}

/** Throws when any of these episodes is an S0 special that is really a movie Radarr handles. */
export function refuseMovieSpecials(seriesId: number, episodeIds: number[]) {
  const asMovie = radarrMovieSpecials(seriesId);
  const hit = episodeIds.map((e) => asMovie.get(e)).find(Boolean);
  if (hit) throw Object.assign(new Error(`This is a movie (${hit.title}): handled by Radarr, not grabbed as an episode`), { statusCode: 409 });
}
