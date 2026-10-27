/**
 * Migration / cutover (1.0 takeover, last step before "Sonarr and Radarr hold no anime").
 *
 * 1. Plan (read-only): for every Sonarr anime series and Radarr anime movie — can AnimeArr own it? Its catalog must
 *    know the show (AniList entries mapped to the TVDB series), every episode with a file must exist in AnimeArr's
 *    numbering, and AnimeArr's own scan must already know every file (so nothing gets searched again).
 * 2. Adopt (AnimeArr only, nothing written to Sonarr/Radarr): AnimeArr records the show/movie as its own, with each
 *    file's episodes linked exactly and its release info kept (from Sonarr's own records). While Sonarr/Radarr still
 *    have it, their copy is used ("parallel mode").
 * 3. Switch (the only write to Sonarr/Radarr; switched on separately): re-checks everything, refuses while anything
 *    is downloading or importing, removes it there (files kept, import-list exclusion added), moves every piece of
 *    AnimeArr state from Sonarr's/Radarr's ids to AnimeArr's (schedule, upgrades, grabs history, activity, movie
 *    settings, franchise links) and builds AnimeArr's copy at once.
 */
import { logDecision } from "./activity.js";
import * as radarr from "./arr/radarr.js";
import * as sonarr from "./arr/sonarr.js";
import { mediaByIds, searchMedia, type AniMedia } from "./anilist.js";
import { applyOverrides, remapNow, upsertMedia } from "./catalog.js";
import { compactKey } from "./core/normalize.js";
import { fribb } from "./covers.js";
import { cache, db, dbState, setJob, tx } from "./db.js";
import { buildEpisodes, materialize, materializeMovie, NATIVE_BASE } from "./native.js";
import { ACTIVE } from "./pipeline.js";
import { getSettings, patchSettings } from "./settings.js";

const err = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const label = (s: number, e: number) => `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;
const PENDING = [...ACTIVE, "needs-attention"];

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
  filesScanned: number;
  specialsWithFiles: number;
  blockers: string[];
  warnings: string[];
  adopted: boolean;
}
export interface MovieCut { movieId: number; title: string; year: number | null; path: string; anilistId: number | null; hasFile: boolean; blockers: string[]; warnings: string[]; adopted: boolean }

function firstEntry(tvdbId: number) {
  return db.prepare("SELECT anilist_id FROM entries WHERE tvdb_id = ? AND tvdb_season IS NOT NULL AND tvdb_season != '0' AND kind IN ('TV', 'TV_SHORT', 'ONA', 'OVA', 'SPECIAL') ORDER BY start_date IS NULL, start_date, anilist_id LIMIT 1").get(tvdbId) as { anilist_id: number } | undefined;
}

/** One Sonarr series: what AnimeArr would make of it. */
/** Statements prepared once (preparing per file made the plan take over a minute on a big library). */
let stScanned: ReturnType<typeof db.prepare> | null = null;

export function showCut(s: { id: number; tvdb_id: number; title: string; path: string }, opts: { acceptSpecials?: boolean; scanned?: Set<string> } = {}): ShowCut {
  if (!opts.acceptSpecials && db.prepare("SELECT 1 FROM cutover_acks WHERE tvdb_id = ? AND specials = 1").get(s.tvdb_id)) opts = { ...opts, acceptSpecials: true };
  const blockers: string[] = [];
  const warnings: string[] = [];
  const first = firstEntry(s.tvdb_id);
  const adopted = !!db.prepare("SELECT 1 FROM native_series WHERE tvdb_id = ?").get(s.tvdb_id);
  const sonarrEps = cache.prepare("SELECT id, season, episode, file_id, monitored FROM episodes WHERE series_id = ?").all(s.id) as { id: number; season: number; episode: number; file_id: number | null; monitored: number }[];
  const withFile = sonarrEps.filter((e) => e.file_id);
  const fileRows = cache.prepare("SELECT id, path FROM files WHERE series_id = ?").all(s.id) as { id: number; path: string }[];
  stScanned ??= db.prepare("SELECT 1 FROM media_files WHERE path = ?");
  const scanned = fileRows.filter((f) => (opts.scanned ? opts.scanned.has(f.path) : !!stScanned!.get(f.path))).length;
  const specials = withFile.filter((e) => e.season === 0); // refined below: specials AniDB places on S0 are tracked
  const base = { tvdbId: s.tvdb_id, sonarrId: s.id, title: s.title, path: s.path, sonarrEpisodes: sonarrEps.length, files: fileRows.length, filesScanned: scanned, specialsWithFiles: specials.length, adopted };
  if (!first) {
    blockers.push("AnimeArr's catalog has no AniList entry for this TVDB series yet (Settings → Metadata refresh, or it isn't on AniList)");
    return { ...base, entries: 0, animearrEpisodes: 0, filesCovered: 0, blockers, warnings };
  }
  const built = buildEpisodes({ id: 0, tvdb_id: s.tvdb_id, anilist_id: first.anilist_id, synthetic: 0 });
  const missing = withFile.filter((e) => e.season > 0 && !built.byKey.has(`${e.season}x${e.episode}`));
  // Specials AniDB places on TVDB season 0 are tracked like any episode; only the rest need a confirmation.
  const untracked = specials.filter((e) => !built.byKey.has(`0x${e.episode}`));
  const coveredFiles = new Set(withFile.filter((e) => built.byKey.has(`${e.season}x${e.episode}`)).map((e) => e.file_id)).size;
  if (missing.length) blockers.push(`${missing.length} episode(s) with files don't exist in AnimeArr's numbering (${missing.slice(0, 4).map((e) => label(e.season, e.episode)).join(", ")}${missing.length > 4 ? "…" : ""}); they would be left untracked`);
  if (scanned < fileRows.length) blockers.push(`${fileRows.length - scanned} of Sonarr's ${fileRows.length} files aren't in AnimeArr's own file records yet (Library files scan); without them AnimeArr would search those episodes again`);
  if (untracked.length && !opts.acceptSpecials) blockers.push(`${untracked.length} special(s) with files (season 0) wouldn't be tracked by AnimeArr (${untracked.slice(0, 4).map((e) => label(0, e.episode)).join(", ")}${untracked.length > 4 ? "…" : ""}; AniDB doesn't place them yet); the files stay — confirm to go ahead anyway`);
  // Numbering differences, season by season (both ways).
  const seasons = new Set([...sonarrEps.filter((e) => e.season > 0).map((e) => e.season), ...built.eps.map((e) => e.season)]);
  const diffs: string[] = [];
  for (const sn of [...seasons].sort((a, b) => a - b)) {
    const a = sonarrEps.filter((e) => e.season === sn).length;
    const b = built.eps.filter((e) => e.season === sn).length;
    if (a !== b) diffs.push(`S${sn}: Sonarr ${a}, AnimeArr ${b}`);
  }
  if (diffs.length) warnings.push(`episode counts differ (${diffs.slice(0, 4).join("; ")}${diffs.length > 4 ? "…" : ""})`);
  const lost = sonarrEps.filter((e) => e.season > 0 && !e.file_id && e.monitored && !built.byKey.has(`${e.season}x${e.episode}`));
  if (lost.length) warnings.push(`${lost.length} monitored episode(s) without a file aren't in AnimeArr's numbering and wouldn't be searched (${lost.slice(0, 3).map((e) => label(e.season, e.episode)).join(", ")}${lost.length > 3 ? "…" : ""})`);
  if (built.entries.some((e) => e.tvdb_season === "a")) warnings.push("an AniList entry is mapped by absolute numbering and is numbered as season 1 in AnimeArr");
  return { ...base, specialsWithFiles: untracked.length, entries: built.entries.length, animearrEpisodes: built.eps.filter((e) => e.season > 0).length, filesCovered: coveredFiles, blockers, warnings };
}

/** AniList candidates for a TMDB movie (catalog first, then the Fribb mapping). */
function movieCandidates(tmdbId: number | null, map: Map<number, number[]>) {
  if (!tmdbId) return [];
  // A user's pick wins outright; then the catalog, the Fribb mapping and title+year matches.
  const user = db.prepare("SELECT anilist_id FROM catalog_overrides WHERE tmdb_movie = ? AND source = 'user' ORDER BY at DESC LIMIT 1").get(tmdbId) as { anilist_id: number } | undefined;
  if (user) return [user.anilist_id];
  const fromCatalog = (db.prepare("SELECT anilist_id FROM entries WHERE tmdb_movie = ? AND kind = 'MOVIE' ORDER BY anilist_id").all(tmdbId) as { anilist_id: number }[]).map((r) => r.anilist_id);
  const real = [...new Set([...fromCatalog, ...(map.get(tmdbId) ?? [])])].sort((a, b) => a - b);
  if (real.length) return real; // a title+year match is only used when no mapping knows the movie
  return (db.prepare("SELECT anilist_id FROM catalog_overrides WHERE tmdb_movie = ? AND source = 'auto' ORDER BY anilist_id").all(tmdbId) as { anilist_id: number }[]).map((r) => r.anilist_id);
}

function movieCut(m: { id: number; tmdb_id: number | null; title: string; year: number | null; path: string; has_file: number }, map: Map<number, number[]>): MovieCut {
  const cands = movieCandidates(m.tmdb_id, map);
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (!cands.length) blockers.push("no AniList match for this TMDB movie");
  if (cands.length > 1) warnings.push(`several AniList entries share this TMDB id (${cands.join(", ")}); the first is used`);
  const base = m.path.replace(/\/+$/, "");
  if (m.has_file && !db.prepare("SELECT 1 FROM media_files WHERE substr(path, 1, ?) = ? LIMIT 1").get(base.length + 1, `${base}/`)) blockers.push("its file isn't in AnimeArr's own file records yet (Library files scan)");
  const adopted = !!db.prepare("SELECT 1 FROM native_movies WHERE tmdb_id = ?").get(m.tmdb_id);
  return { movieId: m.id, title: m.title, year: m.year, path: m.path, anilistId: cands[0] ?? null, hasFile: !!m.has_file, blockers, warnings, adopted };
}

async function tmdbMap(deps: { fribb: typeof fribb }) {
  const f = await deps.fribb();
  const map = new Map<number, number[]>();
  for (const [a, t] of f.anilistToTmdb) map.set(t, [...(map.get(t) ?? []), a]);
  return map;
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/**
 * Every show's cut, built in slices (the event loop breathes between them, so the rest of the app stays responsive)
 * and cached for 15 minutes; changes (adopt, match, switch) invalidate it. One build at a time.
 */
let cuts: { at: number; byTvdb: Map<number, ShowCut> } | null = null;
let building: Promise<Map<number, ShowCut>> | null = null;
export const invalidateCutover = () => void (cuts = null);
export const cutoverCachedAt = () => cuts?.at ?? null;
export function allShowCuts(fresh = false): Promise<Map<number, ShowCut>> {
  if (!fresh && cuts && Date.now() - cuts.at < 15 * 60_000) return Promise.resolve(cuts.byTvdb);
  if (building) return building;
  building = (async () => {
    const series = cache.prepare(`SELECT id, tvdb_id, title, path FROM series WHERE id < ${NATIVE_BASE} ORDER BY sort_title`).all() as { id: number; tvdb_id: number; title: string; path: string }[];
    const scanned = new Set((db.prepare("SELECT path FROM media_files").all() as { path: string }[]).map((r) => r.path));
    const out = new Map<number, ShowCut>();
    let i = 0;
    for (const s of series) {
      out.set(s.tvdb_id, showCut(s, { scanned }));
      if (++i % 2 === 0) await yieldNow();
    }
    cuts = { at: Date.now(), byTvdb: out };
    return out;
  })().finally(() => {
    building = null;
  });
  return building;
}

/** The whole plan (read-only), plus the checklist of what to look at in Sonarr/Radarr. */
export async function cutoverPlan(deps = { sonarrLists: sonarr.getImportLists, sonarrNotifications: sonarr.getNotifications, radarrLists: radarr.getRadarrImportLists, fribb }, opts: { cached?: boolean } = {}) {
  // Callers (tests, the switch) get a fresh plan; the API asks for the cached one.
  const shows = [...(await allShowCuts(!opts.cached)).values()];
  const map = await tmdbMap(deps);
  const movieRows = cache.prepare(`SELECT id, tmdb_id, title, year, path, has_file FROM movies WHERE id < ${NATIVE_BASE} AND is_anime = 1 ORDER BY title`).all() as { id: number; tmdb_id: number | null; title: string; year: number | null; path: string; has_file: number }[];
  const movies: MovieCut[] = [];
  for (const [i, m] of movieRows.entries()) {
    movies.push(movieCut(m, map));
    if (i % 25 === 24) await yieldNow();
  }
  const s = getSettings();
  const checklist: { item: string; ok: boolean; detail: string }[] = [];
  checklist.push({ item: "AnimeArr imports by itself", ok: s.importer.engine === "animearr" && s.importer.allowReal && s.importer.movies, detail: "required for the switch: Settings → Media management → Importer (own importer, real imports, movie imports)" });
  checklist.push({ item: "No review pause on imports", ok: s.importer.realBudget < 0, detail: `real-import budget is ${s.importer.realBudget < 0 ? "unlimited" : s.importer.realBudget}; shows only AnimeArr has wait in "needs attention" while it's paused` });
  checklist.push({ item: "AnimeArr scans its library files", ok: s.library.scan, detail: "Settings → Safety → Library files: needed so AnimeArr knows every file" });
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
    summary: { shows: shows.length, ready: shows.filter((x) => !x.blockers.length).length, adopted: shows.filter((x) => x.adopted).length, movies: movies.length, moviesReady: movies.filter((x) => !x.blockers.length).length, moviesAdopted: movies.filter((x) => x.adopted).length },
    allowArrWrites: s.cutover.allowArrWrites,
    builtAt: cuts?.at ?? Date.now(),
  };
}

/** Sonarr's file → episode mapping and release info, as AnimeArr's own records (re-run safely before the switch). */
function linkFiles(sonarrSeriesId: number, tvdbId: number, nativeRow: number, anilistId: number) {
  const built = buildEpisodes({ id: nativeRow, tvdb_id: tvdbId, anilist_id: anilistId, synthetic: 0 });
  const files = cache.prepare("SELECT id, path, scene_name, release_group, quality, revision FROM files WHERE series_id = ?").all(sonarrSeriesId) as { id: number; path: string; scene_name: string | null; release_group: string | null; quality: string | null; revision: string | null }[];
  for (const f of files) {
    const eps = cache.prepare("SELECT season, episode FROM episodes WHERE file_id = ?").all(f.id) as { season: number; episode: number }[];
    const ids = eps.map((e) => built.byKey.get(`${e.season}x${e.episode}`)?.id).filter((x): x is number => !!x);
    if (ids.length) db.prepare("INSERT OR REPLACE INTO file_links (path, tvdb_id, episode_ids, at) VALUES (?, ?, ?, ?)").run(f.path, tvdbId, JSON.stringify(ids), Date.now());
    db.prepare("INSERT OR REPLACE INTO file_meta (path, scene_name, release_group, quality, revision) VALUES (?, ?, ?, ?, ?)").run(f.path, f.scene_name, f.release_group, f.quality, f.revision);
  }
  return built;
}

/** Adopts shows (AnimeArr side only). While Sonarr still has a show, Sonarr's copy is the one used. */
export function adoptShows(tvdbIds: number[], opts: { acceptSpecials?: boolean } = {}) {
  if (dbState.corrupt) throw err("The database failed its integrity check", 503);
  const done: { tvdbId: number; ok: boolean; why: string }[] = [];
  for (const tvdbId of tvdbIds) {
    const s = cache.prepare(`SELECT id, tvdb_id, title, year, path, root_folder FROM series WHERE tvdb_id = ? AND id < ${NATIVE_BASE}`).get(tvdbId) as { id: number; tvdb_id: number; title: string; year: number | null; path: string; root_folder: string | null } | undefined;
    if (!s) {
      done.push({ tvdbId, ok: false, why: "not a Sonarr series" });
      continue;
    }
    const cut = showCut(s, opts);
    if (cut.blockers.length) {
      done.push({ tvdbId, ok: false, why: cut.blockers[0] });
      continue;
    }
    const first = firstEntry(tvdbId)!;
    tx(db, () => {
      const existing = db.prepare("SELECT id FROM native_series WHERE tvdb_id = ?").get(tvdbId) as { id: number } | undefined;
      const row = existing?.id ?? Number(db.prepare("INSERT INTO native_series (tvdb_id, anilist_id, synthetic, title, year, path, root_folder, added_at) VALUES (?, ?, 0, ?, ?, ?, ?, ?)").run(tvdbId, first.anilist_id, s.title, s.year, s.path, s.root_folder ?? s.path.replace(/\/[^/]+$/, ""), Date.now()).lastInsertRowid);
      const built = linkFiles(s.id, tvdbId, row, first.anilist_id);
      for (const e of built.entries) db.prepare("INSERT OR IGNORE INTO catalog_pins (anilist_id, at) VALUES (?, ?)").run(e.anilist_id, Date.now());
    });
    done.push({ tvdbId, ok: true, why: `${cut.adopted ? "links refreshed" : "adopted"} (${cut.filesCovered} file(s) linked); Sonarr's copy is used until it's switched` });
  }
  const n = done.filter((d) => d.ok).length;
  if (n) logDecision("info", { why: `Cutover: AnimeArr adopted ${n} show(s) (nothing changed in Sonarr)` });
  return done;
}

/** Adopts Radarr movies (AnimeArr side only). */
export async function adoptMovies(movieIds: number[], deps = { fribb }) {
  if (dbState.corrupt) throw err("The database failed its integrity check", 503);
  const map = await tmdbMap(deps);
  const done: { movieId: number; ok: boolean; why: string }[] = [];
  for (const id of movieIds) {
    const m = cache.prepare(`SELECT id, tmdb_id, title, year, path, root_folder, has_file FROM movies WHERE id = ? AND id < ${NATIVE_BASE} AND is_anime = 1`).get(id) as { id: number; tmdb_id: number | null; title: string; year: number | null; path: string; root_folder: string | null; has_file: number } | undefined;
    if (!m) {
      done.push({ movieId: id, ok: false, why: "not a Radarr anime movie" });
      continue;
    }
    const cut = movieCut(m, map);
    if (cut.blockers.length) {
      done.push({ movieId: id, ok: false, why: cut.blockers[0] });
      continue;
    }
    if (cut.adopted) {
      done.push({ movieId: id, ok: true, why: "already adopted" });
      continue;
    }
    const clash = db.prepare("SELECT tmdb_id FROM native_movies WHERE anilist_id = ?").get(cut.anilistId) as { tmdb_id: number | null } | undefined;
    if (clash) {
      done.push({ movieId: id, ok: false, why: `AniList entry ${cut.anilistId} already belongs to another movie in AnimeArr` });
      continue;
    }
    db.prepare("INSERT INTO native_movies (anilist_id, tmdb_id, title, year, path, root_folder, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(cut.anilistId, m.tmdb_id, m.title, m.year, m.path, m.root_folder ?? m.path.replace(/\/[^/]+$/, ""), Date.now());
    db.prepare("INSERT OR IGNORE INTO catalog_pins (anilist_id, at) VALUES (?, ?)").run(cut.anilistId, Date.now());
    done.push({ movieId: id, ok: true, why: "adopted; Radarr's copy is used until it's switched" });
  }
  const n = done.filter((d) => d.ok).length;
  if (n) logDecision("info", { why: `Cutover: AnimeArr adopted ${n} movie(s) (nothing changed in Radarr)` });
  return done;
}

export interface SwitchDeps {
  removeSeries: typeof sonarr.removeSeriesKeepFiles;
  removeMovie: typeof radarr.removeMovieKeepFiles;
  sonarrQueue: typeof sonarr.getQueue;
  radarrQueue: typeof radarr.radarrQueueFor;
}
const realSwitch: SwitchDeps = { removeSeries: sonarr.removeSeriesKeepFiles, removeMovie: radarr.removeMovieKeepFiles, sonarrQueue: sonarr.getQueue, radarrQueue: radarr.radarrQueueFor };

/** Rewrites every id-keyed piece of AnimeArr state from a Sonarr show's episode ids to AnimeArr's (one transaction). */
function moveShowState(tvdbId: number, sonarrSeriesId: number, nativeSeriesId: number, idMap: Map<number, number>) {
  const remapList = (json: string) => JSON.stringify((JSON.parse(json) as number[]).map((x) => idMap.get(x) ?? x));
  for (const [from, to] of idMap) {
    db.prepare("UPDATE OR REPLACE search_state SET episode_id = ? WHERE episode_id = ?").run(to, from);
    db.prepare("UPDATE OR REPLACE upgrade_state SET episode_id = ?, file_id = NULL WHERE episode_id = ?").run(to, from);
  }
  // Sonarr episodes AnimeArr doesn't have: their schedule rows go (nothing left to search for).
  db.prepare(`DELETE FROM search_state WHERE tvdb_id = ? AND episode_id < ${NATIVE_BASE}`).run(tvdbId);
  for (const g of db.prepare("SELECT id, episode_ids FROM grabs WHERE tvdb_id = ?").all(tvdbId) as { id: number; episode_ids: string }[]) db.prepare("UPDATE grabs SET episode_ids = ?, series_id = ? WHERE id = ?").run(remapList(g.episode_ids), nativeSeriesId, g.id);
  for (const d of db.prepare("SELECT id, episode_ids FROM decisions WHERE tvdb_id = ? AND episode_ids != '[]'").all(tvdbId) as { id: number; episode_ids: string }[]) db.prepare("UPDATE decisions SET episode_ids = ? WHERE id = ?").run(remapList(d.episode_ids), d.id);
  void sonarrSeriesId;
}

function moveMovieState(from: number, to: number) {
  for (const t of ["movie_prefs", "movie_search", "movie_upgrade", "movie_wanted"]) db.prepare(`UPDATE OR REPLACE ${t} SET movie_id = ? WHERE movie_id = ?`).run(to, from);
  db.prepare("UPDATE grabs SET movie_id = ? WHERE movie_id = ?").run(to, from);
  db.prepare("UPDATE blocklist SET movie_id = ? WHERE movie_id = ?").run(to, from);
  db.prepare("UPDATE OR REPLACE franchise_links SET movie_id = ? WHERE movie_id = ?").run(to, from);
}

/**
 * The switch: the only write to Sonarr/Radarr. Refused unless switched on (cutover.allowArrWrites), unless AnimeArr
 * imports by itself, and while anything for that show/movie is downloading or importing (AnimeArr's or Sonarr's).
 * Re-checks the plan, refreshes the file links, removes it there (files kept), moves AnimeArr's state to its own ids
 * and builds AnimeArr's copy at once.
 */
export async function switchToAnimeArr(input: { tvdbIds?: number[]; movieIds?: number[]; acceptSpecials?: boolean }, deps: SwitchDeps = realSwitch) {
  const s = getSettings();
  if (!s.cutover.allowArrWrites) throw err("Removing shows/movies from Sonarr/Radarr isn't switched on (the first cutover is being reviewed)", 409);
  if (!(s.importer.engine === "animearr" && s.importer.allowReal)) throw err("Switch AnimeArr's own importer on first (Settings → Media management → Importer); after the switch only AnimeArr imports these", 409);
  const out: { id: number; kind: "show" | "movie"; ok: boolean; why: string }[] = [];
  let sQueue: Awaited<ReturnType<typeof sonarr.getQueue>> | null = null;
  for (const tvdbId of input.tvdbIds ?? []) {
    const sr = cache.prepare(`SELECT id, tvdb_id, title, path FROM series WHERE tvdb_id = ? AND id < ${NATIVE_BASE}`).get(tvdbId) as { id: number; tvdb_id: number; title: string; path: string } | undefined;
    const nr = db.prepare("SELECT * FROM native_series WHERE tvdb_id = ?").get(tvdbId) as { id: number; anilist_id: number } | undefined;
    const fail = (why: string) => out.push({ id: tvdbId, kind: "show", ok: false, why });
    if (!sr || !nr) {
      fail("adopt it in AnimeArr first");
      continue;
    }
    const cut = showCut(sr, { acceptSpecials: input.acceptSpecials });
    if (cut.blockers.length) {
      fail(cut.blockers[0]);
      continue;
    }
    if (db.prepare(`SELECT 1 FROM grabs WHERE tvdb_id = ? AND dry_run = 0 AND state IN (${PENDING.map(() => "?").join(",")})`).get(tvdbId, ...PENDING)) {
      fail("AnimeArr is still downloading or importing something for it; switch it when that's done");
      continue;
    }
    try {
      sQueue ??= await deps.sonarrQueue();
    } catch (e) {
      fail(`couldn't check Sonarr's queue (${(e as Error).message})`);
      continue;
    }
    if (sQueue.some((q) => q.seriesId === sr.id)) {
      fail("Sonarr is still downloading something for it; switch it when that's done");
      continue;
    }
    // Fresh links, then the id map (Sonarr episode → AnimeArr episode by season/episode), while Sonarr's rows are here.
    const built = linkFiles(sr.id, tvdbId, nr.id, nr.anilist_id);
    const idMap = new Map<number, number>();
    for (const e of cache.prepare("SELECT id, season, episode FROM episodes WHERE series_id = ?").all(sr.id) as { id: number; season: number; episode: number }[]) {
      const n = built.byKey.get(`${e.season}x${e.episode}`);
      if (n) idMap.set(e.id, n.id);
    }
    try {
      await deps.removeSeries(sr.id);
    } catch (e) {
      fail((e as Error).message);
      continue;
    }
    tx(db, () => moveShowState(tvdbId, sr.id, NATIVE_BASE + nr.id, idMap));
    tx(cache, () => {
      for (const t of ["series WHERE id", "episodes WHERE series_id", "files WHERE series_id", "alt_titles WHERE series_id"]) cache.prepare(`DELETE FROM ${t} = ?`).run(sr.id);
    });
    materialize(db.prepare("SELECT * FROM native_series WHERE id = ?").get(nr.id) as never);
    out.push({ id: tvdbId, kind: "show", ok: true, why: `${sr.title}: removed from Sonarr (files kept); AnimeArr's copy is live` });
  }
  if ((input.movieIds ?? []).length && !s.importer.movies) throw err("Switch movie imports by AnimeArr's own importer on first", 409);
  for (const movieId of input.movieIds ?? []) {
    const m = cache.prepare(`SELECT id, title, tmdb_id FROM movies WHERE id = ? AND id < ${NATIVE_BASE}`).get(movieId) as { id: number; title: string; tmdb_id: number | null } | undefined;
    const nm = m?.tmdb_id ? (db.prepare("SELECT * FROM native_movies WHERE tmdb_id = ?").get(m.tmdb_id) as { id: number } | undefined) : undefined;
    const fail = (why: string) => out.push({ id: movieId, kind: "movie", ok: false, why });
    if (!m || !nm) {
      fail("adopt it in AnimeArr first");
      continue;
    }
    if (db.prepare(`SELECT 1 FROM grabs WHERE movie_id = ? AND dry_run = 0 AND state IN (${PENDING.map(() => "?").join(",")})`).get(movieId, ...PENDING)) {
      fail("AnimeArr is still downloading or importing it; switch it when that's done");
      continue;
    }
    try {
      if ((await deps.radarrQueue(movieId)).length) {
        fail("Radarr is still downloading it; switch it when that's done");
        continue;
      }
      await deps.removeMovie(m.id);
    } catch (e) {
      fail((e as Error).message);
      continue;
    }
    tx(db, () => moveMovieState(m.id, NATIVE_BASE + nm.id));
    cache.prepare("DELETE FROM movies WHERE id = ?").run(m.id);
    materializeMovie(db.prepare("SELECT * FROM native_movies WHERE id = ?").get(nm.id) as never);
    out.push({ id: movieId, kind: "movie", ok: true, why: `${m.title}: removed from Radarr (files kept); AnimeArr's copy is live` });
  }
  const ok = out.filter((x) => x.ok);
  if (ok.length) logDecision("info", { why: `Cutover: ${ok.map((x) => x.why).slice(0, 5).join("; ")}${ok.length > 5 ? "…" : ""}` });
  return out;
}

export function setArrWrites(on: boolean) {
  patchSettings((x) => ({ ...x, cutover: { ...x.cutover, allowArrWrites: on } }));
  logDecision("info", { why: on ? "Cutover: removing adopted shows/movies from Sonarr/Radarr is switched on" : "Cutover: writes to Sonarr/Radarr switched off" });
}

// ---------------------------------------------------------------- resolving blocked items (user picks, auto matches)

/** The user's pick: this AniList entry is (a season of) this TVDB show. Fetched into the catalog if needed. */
export async function matchShow(tvdbId: number, anilistId: number, season = 1, offset = 0, deps = { media: mediaByIds, fribb }, opts: { force?: boolean } = {}) {
  const s = cache.prepare(`SELECT title FROM series WHERE tvdb_id = ? AND id < ${NATIVE_BASE}`).get(tvdbId) as { title: string } | undefined;
  if (!s) throw err("Not a Sonarr series", 404);
  if (!Number.isInteger(season) || season < 1 || season > 99 || !Number.isInteger(offset) || offset < 0 || offset > 5000) throw err("Season 1–99, offset 0–5000");
  if (db.prepare("SELECT 1 FROM native_series WHERE tvdb_id = ?").get(tvdbId)) throw err("This show is already adopted; change its match before adopting", 409);
  if (!db.prepare("SELECT 1 FROM entries WHERE anilist_id = ?").get(anilistId)) {
    const f = await deps.fribb();
    const got = await deps.media([anilistId], undefined, { priority: true });
    if (!got.length) throw err("AniList didn't return that entry", 404);
    tx(db, () => upsertMedia(got[0], f.anilistToAnidb.get(anilistId) ?? null));
  }
  const e = db.prepare("SELECT kind, tvdb_id, title_english, title_romaji FROM entries WHERE anilist_id = ?").get(anilistId) as { kind: string | null; tvdb_id: number | null; title_english: string | null; title_romaji: string | null };
  if (e.kind === "MOVIE") throw err("That's a movie; pick the series entry", 400);
  if (!opts.force && e.tvdb_id && e.tvdb_id !== tvdbId) {
    const other = cache.prepare("SELECT title FROM series WHERE tvdb_id = ?").get(e.tvdb_id) as { title: string } | undefined;
    throw err(`That AniList entry belongs to ${other?.title ?? `TVDB ${e.tvdb_id}`}; pick it anyway only if that mapping is wrong`, 409);
  }
  const taken = db.prepare("SELECT anilist_id FROM entries WHERE tvdb_id = ? AND tvdb_season = ? AND tvdb_offset = ? AND anilist_id != ?").get(tvdbId, String(season), offset, anilistId) as { anilist_id: number } | undefined;
  if (!opts.force && taken) throw err(`Season ${season}${offset ? ` from episode ${offset + 1}` : ""} already has AniList entry ${taken.anilist_id}`, 409);
  db.prepare("INSERT OR REPLACE INTO catalog_overrides (anilist_id, tvdb_id, tvdb_season, tvdb_offset, tmdb_movie, source, at) VALUES (?, ?, ?, ?, NULL, 'user', ?)").run(anilistId, tvdbId, String(season), offset, Date.now());
  db.prepare("INSERT OR IGNORE INTO catalog_pins (anilist_id, at) VALUES (?, ?)").run(anilistId, Date.now());
  applyOverrides();
  logDecision("info", { tvdbId, title: s.title, why: `Cutover: AniList entry ${anilistId} set as season ${season}${offset ? ` (from episode ${offset + 1})` : ""} of ${s.title}` });
  return showCut(cache.prepare("SELECT id, tvdb_id, title, path FROM series WHERE tvdb_id = ? AND id < ?").get(tvdbId, NATIVE_BASE) as never);
}

export async function unmatch(anilistId: number) {
  const o = db.prepare("SELECT tvdb_id, tmdb_movie FROM catalog_overrides WHERE anilist_id = ?").get(anilistId) as { tvdb_id: number | null; tmdb_movie: number | null } | undefined;
  if (!o) return;
  db.prepare("DELETE FROM catalog_overrides WHERE anilist_id = ?").run(anilistId);
  const owned = db.prepare("SELECT 1 FROM native_series WHERE anilist_id = ? UNION SELECT 1 FROM native_movies WHERE anilist_id = ?").get(anilistId, anilistId);
  if (!owned) db.prepare("DELETE FROM catalog_pins WHERE anilist_id = ?").run(anilistId);
  await remapNow(); // back to what Anime-Lists/Fribb say
  logDecision("info", { why: `Cutover: removed the manual match of AniList entry ${anilistId}${o.tvdb_id ? ` (TVDB ${o.tvdb_id})` : o.tmdb_movie ? ` (TMDB ${o.tmdb_movie})` : ""}` });
}

/** The user confirms: specials (season 0) with files may stay untracked by AnimeArr for this show. */
export function ackSpecials(tvdbId: number, on: boolean) {
  if (!cache.prepare("SELECT 1 FROM series WHERE tvdb_id = ?").get(tvdbId)) throw err("Unknown show", 404);
  if (on) db.prepare("INSERT OR REPLACE INTO cutover_acks (tvdb_id, specials, at) VALUES (?, 1, ?)").run(tvdbId, Date.now());
  else db.prepare("DELETE FROM cutover_acks WHERE tvdb_id = ?").run(tvdbId);
}

/** The user's pick for a Radarr movie. */
export async function matchMovieManual(movieId: number, anilistId: number, deps = { media: mediaByIds }) {
  const m = cache.prepare(`SELECT tmdb_id, title FROM movies WHERE id = ? AND id < ${NATIVE_BASE}`).get(movieId) as { tmdb_id: number | null; title: string } | undefined;
  if (!m?.tmdb_id) throw err("Not a Radarr movie with a TMDB id", 404);
  const known = db.prepare("SELECT kind FROM entries WHERE anilist_id = ?").get(anilistId) as { kind: string | null } | undefined;
  const kind = known ? known.kind : ((await deps.media([anilistId], undefined, { priority: true }))[0]?.format ?? null);
  if (kind !== "MOVIE") throw err("That AniList entry isn't a movie", 400);
  db.prepare("DELETE FROM catalog_overrides WHERE tmdb_movie = ? AND source = 'user'").run(m.tmdb_id);
  db.prepare("INSERT OR REPLACE INTO catalog_overrides (anilist_id, tvdb_id, tvdb_season, tvdb_offset, tmdb_movie, source, at) VALUES (?, NULL, NULL, 0, ?, 'user', ?)").run(anilistId, m.tmdb_id, Date.now());
  logDecision("info", { title: m.title, why: `Cutover: ${m.title} matched to AniList entry ${anilistId}` });
}

let matchRunning = false;

/**
 * Title + year matching for Radarr movies that no mapping knows: an AniList MOVIE whose English/romaji/native title
 * or synonym equals one of Radarr's titles, released within a year. Only unambiguous matches are kept (source "auto");
 * the rest are listed for a manual pick. Runs in the background (AniList allows ~30 requests a minute).
 */
export function autoMatchMovies(deps = { search: searchMedia, fribb }) {
  if (matchRunning) return { started: false };
  matchRunning = true;
  void (async () => {
    const map = await tmdbMap(deps);
    const rows = cache.prepare(`SELECT id, tmdb_id, title, original_title, alt_titles, year FROM movies WHERE id < ${NATIVE_BASE} AND is_anime = 1 AND tmdb_id IS NOT NULL`).all() as { id: number; tmdb_id: number; title: string; original_title: string | null; alt_titles: string; year: number | null }[];
    const todo = rows.filter((m) => !movieCandidates(m.tmdb_id, map).length);
    let matched = 0;
    let n = 0;
    for (const m of todo) {
      setJob("movie-match", "running", `Matching ${++n} of ${todo.length} movies with AniList (${matched} found)`);
      let alts: string[] = [];
      try {
        alts = JSON.parse(m.alt_titles) as string[];
      } catch {
        alts = [];
      }
      const names = new Set([m.title, m.original_title ?? "", ...alts].filter(Boolean).map((t) => compactKey(t)).filter(Boolean));
      let found: AniMedia[] = [];
      try {
        found = await deps.search(m.title, 10, undefined, { interactive: false }); // background: never jumps ahead of someone typing
      } catch {
        continue;
      }
      const year = (a: AniMedia) => a.seasonYear ?? a.startDate?.year ?? null;
      const hits = found.filter((a) => a.format === "MOVIE" && (m.year ? year(a) !== null && Math.abs(year(a)! - m.year) <= 1 : true) && [a.title.english, a.title.romaji, a.title.native, ...(a.synonyms ?? [])].some((t) => !!t && names.has(compactKey(t))));
      if (hits.length !== 1) continue;
      matched += Number(db.prepare("INSERT OR IGNORE INTO catalog_overrides (anilist_id, tvdb_id, tvdb_season, tvdb_offset, tmdb_movie, source, at) VALUES (?, NULL, NULL, 0, ?, 'auto', ?)").run(hits[0].id, m.tmdb_id, Date.now()).changes);
    }
    setJob("movie-match", "done", `${matched} of ${todo.length} movies matched with AniList by title and year`);
    logDecision("info", { why: `Cutover: ${matched} of ${todo.length} movies matched with AniList by title and year (the rest can be picked by hand)` });
  })()
    .catch((e) => setJob("movie-match", "error", (e as Error).message))
    .finally(() => (matchRunning = false));
  return { started: true };
}
