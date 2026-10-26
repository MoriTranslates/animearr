/**
 * Migration / cutover (1.0 takeover, last step before "Sonarr and Radarr hold no anime").
 *
 * 1. Plan (read-only): for every Sonarr anime series and Radarr anime movie — can AnimeArr own it? Its catalog must
 *    know the show (AniList entries mapped to the TVDB series) and every episode that has a file must exist in
 *    AnimeArr's numbering, so no file is orphaned.
 * 2. Adopt (AnimeArr only, nothing written to Sonarr/Radarr): AnimeArr records the show/movie as its own, with each
 *    file's episodes linked exactly (from Sonarr's own file ↔ episode mapping). While Sonarr/Radarr still have it,
 *    their copy is used ("parallel mode").
 * 3. Remove from Sonarr/Radarr (the only write to them; switched on separately, never deletes files, adds an import
 *    list exclusion). The next sync drops their copy and AnimeArr's takes over with the same folder and files.
 * The final checklist lists what to look at in Sonarr/Radarr before they're retired.
 */
import { logDecision } from "./activity.js";
import * as radarr from "./arr/radarr.js";
import * as sonarr from "./arr/sonarr.js";
import { fribb } from "./covers.js";
import { cache, db, dbState, tx } from "./db.js";
import { buildEpisodes, NATIVE_BASE } from "./native.js";
import { getSettings, patchSettings } from "./settings.js";

const err = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const label = (s: number, e: number) => `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;

export interface ShowCut {
  tvdbId: number;
  sonarrId: number;
  title: string;
  path: string;
  entries: number;
  sonarrEpisodes: number;
  animearrEpisodes: number;
  files: number;
  filesCovered: number;
  blockers: string[];
  warnings: string[];
  adopted: boolean;
}
export interface MovieCut { movieId: number; title: string; year: number | null; path: string; anilistId: number | null; hasFile: boolean; blockers: string[]; adopted: boolean }

function firstEntry(tvdbId: number) {
  return db.prepare("SELECT anilist_id FROM entries WHERE tvdb_id = ? AND tvdb_season IS NOT NULL AND tvdb_season != '0' AND kind IN ('TV', 'TV_SHORT', 'ONA', 'OVA', 'SPECIAL') ORDER BY start_date IS NULL, start_date LIMIT 1").get(tvdbId) as { anilist_id: number } | undefined;
}

/** One Sonarr series: what AnimeArr would make of it. */
export function showCut(s: { id: number; tvdb_id: number; title: string; path: string }): ShowCut {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const first = firstEntry(s.tvdb_id);
  const adopted = !!db.prepare("SELECT 1 FROM native_series WHERE tvdb_id = ?").get(s.tvdb_id);
  const sonarrEps = cache.prepare("SELECT id, season, episode, file_id FROM episodes WHERE series_id = ?").all(s.id) as { id: number; season: number; episode: number; file_id: number | null }[];
  const withFile = sonarrEps.filter((e) => e.file_id);
  const files = new Set(withFile.map((e) => e.file_id)).size;
  if (!first) {
    blockers.push("AnimeArr's catalog has no AniList entry for this TVDB series yet (Settings → Metadata refresh, or it isn't on AniList)");
    return { tvdbId: s.tvdb_id, sonarrId: s.id, title: s.title, path: s.path, entries: 0, sonarrEpisodes: sonarrEps.length, animearrEpisodes: 0, files, filesCovered: 0, blockers, warnings, adopted };
  }
  const built = buildEpisodes({ id: 0, tvdb_id: s.tvdb_id, anilist_id: first.anilist_id, synthetic: 0 });
  const missing = withFile.filter((e) => e.season > 0 && !built.byKey.has(`${e.season}x${e.episode}`));
  const specials = withFile.filter((e) => e.season === 0);
  const coveredFiles = new Set(withFile.filter((e) => e.season > 0 && built.byKey.has(`${e.season}x${e.episode}`)).map((e) => e.file_id)).size;
  if (missing.length) blockers.push(`${missing.length} episode(s) with files don't exist in AnimeArr's numbering (${missing.slice(0, 4).map((e) => label(e.season, e.episode)).join(", ")}${missing.length > 4 ? "…" : ""}); they would be left untracked`);
  if (specials.length) warnings.push(`${specials.length} special(s) with files (season 0) aren't tracked by AnimeArr yet; the files stay where they are`);
  const regular = sonarrEps.filter((e) => e.season > 0).length;
  if (built.eps.length < regular) warnings.push(`AnimeArr knows ${built.eps.length} regular episodes, Sonarr ${regular}`);
  return { tvdbId: s.tvdb_id, sonarrId: s.id, title: s.title, path: s.path, entries: built.entries.length, sonarrEpisodes: sonarrEps.length, animearrEpisodes: built.eps.length, files, filesCovered: coveredFiles, blockers, warnings, adopted };
}

function movieAnilist(tmdbId: number | null, map: Map<number, number>) {
  if (!tmdbId) return null;
  const e = db.prepare("SELECT anilist_id FROM entries WHERE tmdb_movie = ? AND kind = 'MOVIE' LIMIT 1").get(tmdbId) as { anilist_id: number } | undefined;
  return e?.anilist_id ?? map.get(tmdbId) ?? null;
}

/** The whole plan (read-only), plus the checklist of what to look at in Sonarr/Radarr. */
export async function cutoverPlan(deps = { sonarrLists: sonarr.getImportLists, sonarrNotifications: sonarr.getNotifications, radarrLists: radarr.getRadarrImportLists, fribb }) {
  const series = cache.prepare(`SELECT id, tvdb_id, title, path FROM series WHERE id < ${NATIVE_BASE} ORDER BY sort_title`).all() as { id: number; tvdb_id: number; title: string; path: string }[];
  const shows = series.map(showCut);
  const f = await deps.fribb();
  const tmdbToAnilist = new Map([...f.anilistToTmdb].map(([a, t]) => [t, a]));
  const movieRows = cache.prepare(`SELECT id, tmdb_id, title, year, path, has_file FROM movies WHERE id < ${NATIVE_BASE} AND is_anime = 1 ORDER BY title`).all() as { id: number; tmdb_id: number | null; title: string; year: number | null; path: string; has_file: number }[];
  const movies: MovieCut[] = movieRows.map((m) => {
    const al = movieAnilist(m.tmdb_id, tmdbToAnilist);
    return { movieId: m.id, title: m.title, year: m.year, path: m.path, anilistId: al, hasFile: !!m.has_file, blockers: al ? [] : ["no AniList match for this TMDB movie"], adopted: !!(al && db.prepare("SELECT 1 FROM native_movies WHERE anilist_id = ?").get(al)) };
  });
  const s = getSettings();
  const checklist: { item: string; ok: boolean; detail: string }[] = [];
  checklist.push({ item: "AnimeArr imports by itself", ok: s.importer.engine === "animearr" && s.importer.allowReal && s.importer.movies, detail: "Settings → Media management → Importer: AnimeArr's own importer, real imports and movie imports on" });
  checklist.push({ item: "No review pause on imports", ok: s.importer.realBudget < 0, detail: `real-import budget is ${s.importer.realBudget < 0 ? "unlimited" : s.importer.realBudget}; shows that only AnimeArr has wait in "needs attention" while it's paused` });
  checklist.push({ item: "Plex scans after AnimeArr's imports", ok: s.plex.enabled && !!s.plex.url, detail: "Settings → Connections → Plex (Sonarr's/Radarr's Plex connection won't see AnimeArr's imports)" });
  try {
    const lists = (await deps.sonarrLists()).filter((l) => l.enabled !== false && l.enableAutomaticAdd !== false);
    checklist.push({ item: "Sonarr import lists", ok: !lists.length, detail: lists.length ? `${lists.map((l) => l.name).join(", ")} could add anime back (removed shows get an import-list exclusion)` : "none adding automatically" });
  } catch (e) {
    checklist.push({ item: "Sonarr import lists", ok: false, detail: `couldn't read them (${(e as Error).message})` });
  }
  try {
    const plexInSonarr = (await deps.sonarrNotifications()).filter((n) => /plex/i.test(n.implementation));
    checklist.push({ item: "Sonarr's Plex connection", ok: true, detail: plexInSonarr.length ? `${plexInSonarr.map((n) => n.name).join(", ")}: fine to keep for Sonarr's other shows` : "none" });
  } catch {
    /* optional */
  }
  try {
    const lists = (await deps.radarrLists()).filter((l) => l.enabled !== false && l.enableAuto !== false);
    checklist.push({ item: "Radarr import lists", ok: !lists.length, detail: lists.length ? `${lists.map((l) => l.name).join(", ")} could add anime movies back (removed movies get an import exclusion)` : "none adding automatically" });
  } catch {
    /* Radarr optional */
  }
  return {
    shows,
    movies,
    checklist,
    summary: {
      shows: shows.length,
      ready: shows.filter((x) => !x.blockers.length).length,
      adopted: shows.filter((x) => x.adopted).length,
      movies: movies.length,
      moviesReady: movies.filter((x) => !x.blockers.length).length,
      moviesAdopted: movies.filter((x) => x.adopted).length,
    },
    allowArrWrites: s.cutover.allowArrWrites,
  };
}

/**
 * Adopts shows (AnimeArr side only): native_series rows with exact file ↔ episode links from Sonarr's mapping.
 * While Sonarr still has a show, Sonarr's copy is the one used.
 */
export function adoptShows(tvdbIds: number[]) {
  if (dbState.corrupt) throw err("The database failed its integrity check", 503);
  const done: { tvdbId: number; ok: boolean; why: string }[] = [];
  for (const tvdbId of tvdbIds) {
    const s = cache.prepare(`SELECT id, tvdb_id, title, year, path, root_folder FROM series WHERE tvdb_id = ? AND id < ${NATIVE_BASE}`).get(tvdbId) as { id: number; tvdb_id: number; title: string; year: number | null; path: string; root_folder: string | null } | undefined;
    if (!s) {
      done.push({ tvdbId, ok: false, why: "not a Sonarr series" });
      continue;
    }
    const cut = showCut(s);
    if (cut.blockers.length) {
      done.push({ tvdbId, ok: false, why: cut.blockers[0] });
      continue;
    }
    if (cut.adopted) {
      done.push({ tvdbId, ok: true, why: "already adopted" });
      continue;
    }
    const first = firstEntry(tvdbId)!;
    tx(db, () => {
      const row = Number(db.prepare("INSERT INTO native_series (tvdb_id, anilist_id, synthetic, title, year, path, root_folder, added_at) VALUES (?, ?, 0, ?, ?, ?, ?, ?)").run(tvdbId, first.anilist_id, s.title, s.year, s.path, s.root_folder ?? s.path.replace(/\/[^/]+$/, ""), Date.now()).lastInsertRowid);
      const built = buildEpisodes({ id: row, tvdb_id: tvdbId, anilist_id: first.anilist_id, synthetic: 0 });
      // Each Sonarr file → AnimeArr's episode ids for the same S/E (exact, no name guessing later).
      const files = cache.prepare("SELECT f.id, f.path FROM files f WHERE f.series_id = ?").all(s.id) as { id: number; path: string }[];
      for (const f of files) {
        const eps = cache.prepare("SELECT season, episode FROM episodes WHERE file_id = ? AND season > 0").all(f.id) as { season: number; episode: number }[];
        const ids = eps.map((e) => built.byKey.get(`${e.season}x${e.episode}`)?.id).filter((x): x is number => !!x);
        if (ids.length) db.prepare("INSERT OR REPLACE INTO file_links (path, tvdb_id, episode_ids, at) VALUES (?, ?, ?, ?)").run(f.path, tvdbId, JSON.stringify(ids), Date.now());
      }
      for (const e of built.entries) db.prepare("INSERT OR IGNORE INTO catalog_pins (anilist_id, at) VALUES (?, ?)").run(e.anilist_id, Date.now());
    });
    done.push({ tvdbId, ok: true, why: `adopted (${cut.filesCovered} file(s) linked); Sonarr's copy is used until it's removed there` });
  }
  const n = done.filter((d) => d.ok).length;
  if (n) logDecision("info", { why: `Cutover: AnimeArr adopted ${n} show(s) (nothing changed in Sonarr)` });
  return done;
}

/** Adopts Radarr movies (AnimeArr side only). */
export async function adoptMovies(movieIds: number[], deps = { fribb }) {
  const f = await deps.fribb();
  const tmdbToAnilist = new Map([...f.anilistToTmdb].map(([a, t]) => [t, a]));
  const done: { movieId: number; ok: boolean; why: string }[] = [];
  for (const id of movieIds) {
    const m = cache.prepare(`SELECT id, tmdb_id, title, year, path, root_folder FROM movies WHERE id = ? AND id < ${NATIVE_BASE}`).get(id) as { id: number; tmdb_id: number | null; title: string; year: number | null; path: string; root_folder: string | null } | undefined;
    if (!m) {
      done.push({ movieId: id, ok: false, why: "not a Radarr movie" });
      continue;
    }
    const al = movieAnilist(m.tmdb_id, tmdbToAnilist);
    if (!al) {
      done.push({ movieId: id, ok: false, why: "no AniList match" });
      continue;
    }
    try {
      db.prepare("INSERT INTO native_movies (anilist_id, tmdb_id, title, year, path, root_folder, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(al, m.tmdb_id, m.title, m.year, m.path, m.root_folder ?? m.path.replace(/\/[^/]+$/, ""), Date.now());
      db.prepare("INSERT OR IGNORE INTO catalog_pins (anilist_id, at) VALUES (?, ?)").run(al, Date.now());
      done.push({ movieId: id, ok: true, why: "adopted; Radarr's copy is used until it's removed there" });
    } catch {
      done.push({ movieId: id, ok: true, why: "already adopted" });
    }
  }
  const n = done.filter((d) => d.ok).length;
  if (n) logDecision("info", { why: `Cutover: AnimeArr adopted ${n} movie(s) (nothing changed in Radarr)` });
  return done;
}

/**
 * The only write to Sonarr/Radarr: removes adopted shows/movies there (files kept, import-list exclusion added).
 * Refused unless switched on (cutover.allowArrWrites) — the first one waits for a reviewed plan.
 */
export async function removeFromArrs(input: { tvdbIds?: number[]; movieIds?: number[] }, deps = { removeSeries: sonarr.removeSeriesKeepFiles, removeMovie: radarr.removeMovieKeepFiles }) {
  if (!getSettings().cutover.allowArrWrites) throw err("Removing shows/movies from Sonarr/Radarr isn't switched on (the first cutover is being reviewed)", 409);
  const out: { id: number; kind: "show" | "movie"; ok: boolean; why: string }[] = [];
  for (const tvdbId of input.tvdbIds ?? []) {
    const s = cache.prepare(`SELECT id, title FROM series WHERE tvdb_id = ? AND id < ${NATIVE_BASE}`).get(tvdbId) as { id: number; title: string } | undefined;
    if (!s || !db.prepare("SELECT 1 FROM native_series WHERE tvdb_id = ?").get(tvdbId)) {
      out.push({ id: tvdbId, kind: "show", ok: false, why: "adopt it in AnimeArr first" });
      continue;
    }
    try {
      await deps.removeSeries(s.id);
      out.push({ id: tvdbId, kind: "show", ok: true, why: `${s.title} removed from Sonarr (files kept)` });
    } catch (e) {
      out.push({ id: tvdbId, kind: "show", ok: false, why: (e as Error).message });
    }
  }
  for (const movieId of input.movieIds ?? []) {
    const m = cache.prepare(`SELECT id, title, tmdb_id FROM movies WHERE id = ? AND id < ${NATIVE_BASE}`).get(movieId) as { id: number; title: string; tmdb_id: number | null } | undefined;
    if (!m || !db.prepare("SELECT 1 FROM native_movies WHERE tmdb_id = ?").get(m.tmdb_id)) {
      out.push({ id: movieId, kind: "movie", ok: false, why: "adopt it in AnimeArr first" });
      continue;
    }
    try {
      await deps.removeMovie(m.id);
      // The movie's settings follow it to AnimeArr's id; its Radarr-era search row is re-planned.
      const nm = db.prepare("SELECT id FROM native_movies WHERE tmdb_id = ?").get(m.tmdb_id) as { id: number };
      db.prepare("UPDATE OR REPLACE movie_prefs SET movie_id = ? WHERE movie_id = ?").run(NATIVE_BASE + nm.id, m.id);
      db.prepare("DELETE FROM movie_search WHERE movie_id = ?").run(m.id);
      out.push({ id: movieId, kind: "movie", ok: true, why: `${m.title} removed from Radarr (files kept)` });
    } catch (e) {
      out.push({ id: movieId, kind: "movie", ok: false, why: (e as Error).message });
    }
  }
  const ok = out.filter((x) => x.ok);
  if (ok.length) logDecision("info", { why: `Cutover: ${ok.map((x) => x.why).slice(0, 5).join("; ")}${ok.length > 5 ? "…" : ""}` });
  return out;
}

export function setArrWrites(on: boolean) {
  patchSettings((x) => ({ ...x, cutover: { ...x.cutover, allowArrWrites: on } }));
  logDecision("info", { why: on ? "Cutover: removing adopted shows/movies from Sonarr/Radarr is switched on" : "Cutover: writes to Sonarr/Radarr switched off" });
}
