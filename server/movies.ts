/**
 * Anime movies (the Radarr side). Companion mode, like episodes: Radarr stays the library; AnimeArr searches Prowlarr
 * with every title it knows, ranks by the language profile, sends the grab to its own download-client category, and
 * imports through Radarr's ManualImport with the explicit movie id, verifying before and after.
 *
 * Guard rails: only movies inside an allowed root folder (Settings → Safety lists Radarr's root folders too);
 * manual grabs need a confirmation and honour the global dry-run; never two downloads for one movie at once;
 * a pack or a series release is never taken for the movie.
 */
import { seedLimitsFor } from "./indexers.js";
import { grabGate, GrabsPausedError } from "./downloads.js";
import { executeMovieImport, listVideos, planMovieImport } from "./importer.js";
import { isNativeMovieId } from "./native.js";
import fs from "node:fs";
import path from "node:path";
import { logDecision } from "./activity.js";
import { type ProwlarrRelease } from "./arr/prowlarr.js";
import { searchAll } from "./indexers.js";
import { langList } from "./core/langs.js";
import { parseRelease, type ParsedRelease } from "./core/parser.js";
import { compareRanked, rankRelease } from "./core/rank.js";
import { cache, db, dbState } from "./db.js";
import { learnedFor, learnFromVerify, sourceKey } from "./library.js";
import { ACTIVE, blocklist, fetchOrNote, importModeFor, isBlocked, isFetchFailure, MAX_ATTEMPTS, remainingFallbacks, realDeps, runTimeSec, setState, VIDEO, type Candidate, type GrabRow, type PipelineDeps } from "./pipeline.js";
import type { RadarrMovie } from "./arr/radarr.js";
import { clientToSonarr } from "./paths.js";
import { moviePrefs, profileForMovie } from "./profiles.js";
import { seriesForMovie } from "./franchise.js";
import type { SearchResult } from "./search.js";
import { getSettings, underAllowedRoot } from "./settings.js";
import { judge } from "./verify.js";
import { fileForMovie, looksLikeEpisodes, MARKER, movieSubtitles, namesSubtitle, normTitle } from "./core/movieTitle.js";
import { indexerHealth } from "./health.js";
import { ownFile, probeOf } from "./mediafiles.js";

export interface MovieRow {
  id: number;
  tmdb_id: number | null;
  imdb_id: string | null;
  title: string;
  original_title: string | null;
  year: number | null;
  path: string;
  monitored: number;
  has_file: number;
  runtime: number | null;
  alt_titles: string;
  file: string | null;
  poster: string | null;
  status?: string | null;
  is_available?: number;
  in_cinemas?: number | null;
  digital_release?: number | null;
  physical_release?: number | null;
  genres?: string;
}
export interface MovieFile { path: string | null; sceneName: string | null; releaseGroup: string | null; quality: string | null; audio: string[]; subs: string[]; runTime: string | null; resolution: string | null }

/**
 * A live-action film in the anime movie folder (e.g. "Grand Blue" 2020, the live-action adaptation): Radarr/TMDB list
 * genres but not Animation. Returns those genres (truthy) or null. Unknown genres (movies added in AnimeArr, which
 * come from AniList and are anime) never count.
 */
export function liveAction(m: Pick<MovieRow, "genres">): string | null {
  let g: string[] = [];
  try {
    g = JSON.parse(m.genres ?? "[]") as string[];
  } catch {
    return null;
  }
  return g.length && !g.some((x) => /^anim/i.test(x)) ? g.join(", ") : null;
}

/**
 * Whether AnimeArr wants this movie (searches for it while it has no file). AnimeArr's own flag; Radarr's monitored
 * flag doesn't count. Movies added in AnimeArr are wanted unless switched off.
 */
export function isWanted(movieId: number) {
  const r = db.prepare("SELECT wanted FROM movie_wanted WHERE movie_id = ?").get(movieId) as { wanted: number } | undefined;
  return r ? r.wanted === 1 : movieId >= 900_000_000;
}

export function setWanted(movieIds: number[], wanted: boolean, now = Date.now()) {
  let n = 0;
  for (const id of movieIds) {
    if (!cache.prepare("SELECT 1 FROM movies WHERE id = ? AND is_anime = 1").get(id)) continue;
    db.prepare("INSERT INTO movie_wanted (movie_id, wanted, at) VALUES (?, ?, ?) ON CONFLICT(movie_id) DO UPDATE SET wanted = excluded.wanted, at = excluded.at").run(id, wanted ? 1 : 0, now);
    n++;
  }
  if (n) logDecision("info", { why: `${n} movie(s) set to ${wanted ? "wanted" : "not wanted"} in AnimeArr` });
  return { changed: n };
}

/** A movie row's alt_titles JSON (never throws). */
export function parseTitles(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function movieById(id: number): MovieRow | null {
  return (cache.prepare("SELECT * FROM movies WHERE id = ? AND is_anime = 1").get(id) as MovieRow | undefined) ?? null;
}

/** Profile verdict for a movie file (the movie's profile; anime movies are Japanese originals). */
function verdictOf(f: MovieFile | null, movieId: number) {
  if (!f) return null;
  if (!f.subs.length && !f.audio.length) return { ok: null as boolean | null, why: "no track languages recorded" };
  const v = judge({ subs: f.subs, audio: f.audio, durationSec: null, sidecars: [], untagged: 0 }, profileForMovie(movieId), null, null);
  return { ok: v.ok as boolean | null, why: v.why };
}

/** When a movie can be downloaded: its digital or physical release (the earlier known one), or "available" in Radarr. */
export function releaseAt(m: Pick<MovieRow, "digital_release" | "physical_release" | "is_available" | "in_cinemas">): number | null {
  const d = [m.digital_release, m.physical_release].filter((x): x is number => !!x);
  if (d.length) return Math.min(...d);
  // No home-release date: only count it as released long after the cinema date (Radarr's "available" can mean
  // "in cinemas", when only cams exist).
  return m.is_available && m.in_cinemas && m.in_cinemas < Date.now() - 90 * 86_400_000 ? m.in_cinemas + 90 * 86_400_000 : null;
}
export const isReleased = (m: Parameters<typeof releaseAt>[0], now = Date.now()) => {
  const r = releaseAt(m);
  return r !== null && r <= now;
};

const activeGrab = (movieId: number) =>
  db.prepare(`SELECT id, state, progress, release FROM grabs WHERE movie_id = ? AND state IN ('sending', 'downloading', 'importing', 'needs-attention') ORDER BY id DESC LIMIT 1`).get(movieId) as { id: number; state: string; progress: number | null; release: string } | undefined;

/** Anime movies from the last Radarr sync, with status and language verdict. */
export function listMovies() {
  const rows = cache.prepare("SELECT * FROM movies WHERE is_anime = 1 ORDER BY title").all() as unknown as MovieRow[];
  return rows.map((m) => {
    const f = movieFileOf(m);
    const g = activeGrab(m.id);
    return {
      id: m.id,
      tmdbId: m.tmdb_id,
      title: m.title,
      year: m.year,
      cover: m.poster,
      monitored: isWanted(m.id),
      status: g ? (g.state === "needs-attention" ? "attention" : "downloading") : m.has_file ? "have" : isReleased(m) ? "missing" : "unreleased",
      releaseAt: releaseAt(m),
      allowed: underAllowedRoot(m.path),
      verdict: verdictOf(f, m.id),
      quality: f?.quality ?? null,
    };
  });
}

/** The movie's file, from AnimeArr's own scan when there is one (Radarr's data otherwise). */
function movieFileOf(m: MovieRow): (MovieFile & { size?: number | null; codec?: string | null; scanned?: boolean }) | null {
  const f = m.file ? (JSON.parse(m.file) as MovieFile) : null;
  if (!f?.path) return f;
  const own = ownFile(f.path);
  if (!own) return f;
  const p = probeOf(own);
  return { ...f, audio: p.audio, subs: [...new Set([...p.subs, ...p.sidecars])], resolution: own.video?.width ? `${own.video.width}x${own.video.height}` : f.resolution, size: own.size, codec: own.video?.codec ?? null, scanned: true };
}

export function movieDetail(id: number) {
  const m = movieById(id);
  if (!m) throw Object.assign(new Error("That movie isn't in the synced Radarr library (or isn't anime)"), { statusCode: 404 });
  const f = movieFileOf(m);
  const grabs = db.prepare("SELECT id, at, release, state, error, progress FROM grabs WHERE movie_id = ? ORDER BY id DESC LIMIT 10").all(id);
  return {
    id: m.id,
    tmdbId: m.tmdb_id,
    imdbId: m.imdb_id,
    title: m.title,
    originalTitle: m.original_title,
    genres: (() => {
      try {
        return JSON.parse(m.genres ?? "[]") as string[];
      } catch {
        return [];
      }
    })(),
    altTitles: JSON.parse(m.alt_titles) as string[],
    year: m.year,
    runtime: m.runtime,
    path: m.path,
    cover: m.poster,
    monitored: isWanted(m.id),
    allowed: underAllowedRoot(m.path),
    file: f,
    verdict: verdictOf(f, m.id),
    active: activeGrab(m.id) ?? null,
    grabs,
    released: isReleased(m),
    dates: { inCinemas: m.in_cinemas ?? null, digital: m.digital_release ?? null, physical: m.physical_release ?? null },
    series: seriesForMovie(m.id),
    prefs: moviePrefs(m.id),
    profile: (({ name, watchMode, profileMode }) => ({ name, watchMode, profileMode }))(profileForMovie(m.id)),
    search: db.prepare("SELECT state, next_at AS nextAt, last_at AS lastAt, attempts, last_why AS why FROM movie_search WHERE movie_id = ?").get(m.id) ?? null,
    upgrade: db.prepare("SELECT state, last_at AS lastAt, why, release FROM movie_upgrade WHERE movie_id = ?").get(m.id) ?? null,
  };
}

// ---------------------------------------------------------------- search

/** Symbols that tell sequels/specials apart ("五等分の花嫁∽" vs "五等分の花嫁＊" vs the movie); punctuation otherwise. */
const SYMBOLS = /[∽∾∞*]/gu;
const symbolsOf = (t: string) => [...new Set(t.normalize("NFKC").replace(/\[[^\]]*\]|\([^)]*\)/g, " ").match(SYMBOLS) ?? [])].sort().join("");
export { normTitle };

const tokens = (t: string) => normTitle(t).split(" ").filter(Boolean);
const numbers = (t: string) => tokens(t).filter((w) => /^\d+(\.\d+)?$/.test(w));
function titleScore(a: string, b: string) {
  const x = normTitle(a);
  const y = normTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // Sequels: any differing number (2 vs 3, "1.0" vs "3.0+1.0", III vs II) is a different movie.
  if (numbers(a).join(" ") !== numbers(b).join(" ")) return 0;
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  const inter = [...ta].filter((w) => tb.has(w)).length;
  return inter / new Set([...ta, ...tb]).size;
}

/** Does a release name look like this movie? Returns a confidence (0 = no) and why. */
export function matchMovie(p: ParsedRelease, m: { title: string; original_title: string | null; alt_titles: string[]; year: number | null }, series: string[] = []): { confidence: number; why: string } {
  const all = [m.title, m.original_title ?? "", ...m.alt_titles].filter(Boolean);
  // A title with a distinctive symbol only matches a release that has the same symbol (and the other way round).
  const relSyms = symbolsOf(p.raw);
  // Same for "Specials"/"OVA" titles: a release that doesn't say so is the movie or the series, not the special.
  const kindWord = /\b(specials?|ova|oad)\b/i;
  const titles = all.filter((t) => symbolsOf(t) === relSyms && (!kindWord.test(t) || kindWord.test(p.raw)));
  if (!titles.length) return { confidence: 0, why: "other title" };
  const ownYears = new Set(titles.flatMap((t) => t.match(/\b(?:19|20)\d{2}\b/g) ?? []));
  // Movie-style names keep the year and tech tags in the parsed title: also try the part before them (but not at a
  // year that is part of the movie's own title, e.g. "Pokémon: The Movie 2000").
  const cut = (t: string) => {
    const clean = t.replace(/[._]/g, " ").replace(/\[[^\]]*\]|\([^)]*\)/g, " ");
    const re = /\b(?:19|20)\d{2}\b|\b\d{3,4}p\b|\b(?:bluray|blu-ray|bd|bdrip|web|webrip|web-dl|hevc|x264|x265|dual audio|remux)\b/gi;
    for (const mm of clean.matchAll(re)) if (!ownYears.has(mm[0])) return clean.slice(0, mm.index).trim();
    return clean.trim();
  };
  const names = [...new Set([p.title, ...p.altTitles, ...[p.title, ...p.altTitles].map(cut)].filter(Boolean))];
  if (p.batch || /\b(collection|trilogy|movies|complete|\d+\s*-\s*\d+)\b/i.test(p.raw.replace(/\b\d{3,4}p\b|\b(?:19|20)\d{2}\s*-\s*(?:19|20)\d{2}\b/gi, ""))) return { confidence: 0, why: "a pack or collection" };
  let best = 0;
  for (const n of names) for (const t of titles) best = Math.max(best, titleScore(n, t));
  if (best < 0.75) return { confidence: 0, why: "other title" };
  if (p.episodes.length) return { confidence: 0, why: "a series release" };
  // A bare number that isn't part of the movie's own title (e.g. "Kizumonogatari 2") is an episode or another movie.
  const own = new Set(titles.flatMap((t) => tokens(t)));
  const nums = [...p.absolute, ...(p.specialNumber !== null ? [p.specialNumber] : [])];
  if (nums.length && !nums.every((n) => own.has(String(n)))) return { confidence: 0, why: "an episode release (or another movie of the series)" };
  const exact = best === 1;
  if (p.year && m.year && Math.abs(p.year - m.year) > (exact ? 1 : 0)) return { confidence: 0, why: `other year (${p.year})` };
  // "X The Movie" in Radarr vs a release that's just "X": could be the TV series, unless it says movie or has the year.
  const markerInTitle = titles.some((t) => new RegExp(MARKER.source, "i").test(t));
  const markerInRelease = p.special === "movie" || new RegExp(MARKER.source, "i").test(p.raw);
  // Neither a year nor "movie": a release that fits a TV series of the library as well is that series (a BD batch
  // of "Grand Blue Dreaming" isn't the film "Grand Blue").
  if (!p.year && !markerInRelease && series.length) {
    let tv = 0;
    for (const n of names) for (const s of series) tv = Math.max(tv, titleScore(n, s));
    if (tv >= 0.75 && tv >= best) return { confidence: 0, why: "the TV series" };
  }
  let confidence = exact ? (p.year && m.year ? 97 : 88) : p.year && m.year ? 82 : 70;
  if (markerInTitle && !markerInRelease && !(p.year && m.year)) confidence = Math.min(confidence, 70);
  return { confidence, why: `${exact ? "title matches" : `title ${Math.round(best * 100)}% similar`}${p.year ? `, year ${p.year}` : ""}` };
}

/** Prowlarr queries for a movie: its titles, the main one with the year (also across all categories). */
export function movieQueries(m: { title: string; original_title: string | null; alt_titles: string[]; year: number | null }) {
  const latin = (t: string) => /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}]+$/u.test(t);
  const titles = [...new Set([m.title, m.original_title ?? "", ...m.alt_titles].map((t) => t.trim()).filter(Boolean))];
  const main = titles.filter(latin).slice(0, 3);
  const q = new Set<string>();
  for (const t of main) q.add(t);
  if (m.year) q.add(`${m.title} ${m.year}`);
  for (const t of titles.filter((t) => !latin(t)).slice(0, 1)) q.add(t);
  return [...q].slice(0, 6);
}

export interface MovieSearchResult extends Omit<SearchResult, "episodeIds" | "coversTarget" | "extra"> { episodeIds: number[] }

/** Searches Prowlarr for a movie and ranks what matches. */
export async function searchMovie(id: number, search: typeof searchAll = searchAll) {
  const m = movieById(id);
  if (!m) throw Object.assign(new Error("That movie isn't in the synced Radarr library (or isn't anime)"), { statusCode: 404 });
  const info = { title: m.title, original_title: m.original_title, alt_titles: JSON.parse(m.alt_titles) as string[], year: m.year };
  const queries = movieQueries(info);
  const prof = profileForMovie(id);
  const raw = new Map<string, ProwlarrRelease>();
  const errors: string[] = [];
  const skipped: Record<string, number> = {};
  const results: MovieSearchResult[] = [];
  const started = Date.now();
  const yearQ = m.year ? `${m.title} ${m.year}` : null;
  await Promise.all(
    queries.map(async (q) => {
      try {
        for (const r of await search(q, q === yearQ ? { categories: [] } : {})) if (!raw.has(r.guid)) raw.set(r.guid, r);
      } catch (e) {
        errors.push(`${q}: ${(e as Error).message}`);
      }
    }),
  );
  const fileScene = m.file ? (JSON.parse(m.file) as MovieFile).sceneName : null;
  // The other anime movies of the library: a release that fits one of them at least as well isn't this movie
  // (e.g. "The Quintessential Quintuplets Movie" vs the later "The Quintessential Quintuplets*" special).
  const others = (cache.prepare("SELECT id, title, original_title, alt_titles, year FROM movies WHERE is_anime = 1 AND id != ?").all(id) as { id: number; title: string; original_title: string | null; alt_titles: string; year: number | null }[]).map((o) => ({
    id: o.id,
    label: o.year ? `${o.title} (${o.year})` : o.title,
    info: { title: o.title, original_title: o.original_title, alt_titles: (() => {
      try {
        return JSON.parse(o.alt_titles) as string[];
      } catch {
        return [];
      }
    })(), year: o.year },
  }));
  const seriesTitles = [...new Set([...(cache.prepare("SELECT title FROM series").all() as { title: string }[]).map((x) => x.title), ...(cache.prepare("SELECT DISTINCT title FROM alt_titles").all() as { title: string }[]).map((x) => x.title)])];
  // A franchise movie/special ("Date A Live: Date to Date"): a release that doesn't name its subtitle is most likely the
  // TV season (which may bundle the special): still a candidate, but ranked below releases that name it.
  const subtitles = movieSubtitles([info.title, info.original_title ?? "", ...info.alt_titles], seriesForMovie(id).map((x) => x.title));
  const unnamed = new Set<string>();
  for (const r of raw.values()) {
    const p = parseRelease(r.title);
    const match = matchMovie(p, info, seriesTitles);
    if (!match.confidence) {
      skipped[match.why] = (skipped[match.why] ?? 0) + 1;
      continue;
    }
    // On a tie, the movie whose own title shares more words with the release's title wins ("… Movie" vs "…*").
    const words = (t: string) => new Set(t.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    const overlap = (t: string) => {
      const a = words(p.title);
      const b = words(t);
      return [...a].filter((x) => b.has(x)).length / Math.max(1, new Set([...a, ...b]).size);
    };
    const mine = Math.max(overlap(info.title), ...info.alt_titles.map(overlap));
    const rival = others.find((o) => {
      const c = matchMovie(p, o.info).confidence;
      return c > match.confidence || (c === match.confidence && c > 0 && Math.max(overlap(o.info.title), ...o.info.alt_titles.map(overlap)) >= mine);
    });
    if (rival) {
      const why = `fits ${rival.label} at least as well`;
      skipped[why] = (skipped[why] ?? 0) + 1;
      continue;
    }
    const learned = learnedFor(p.group, p.platform ?? sourceKey(r.title, null, p.source));
    const blocked = isBlocked({ guid: r.guid, title: r.title });
    // Size sanity: a movie is worth several episodes.
    const rank = rankRelease(p, { protocol: r.protocol, size: r.size, seeders: r.seeders ?? null, indexer: r.indexer, episodeCount: Math.max(1, Math.round((m.runtime || 100) / 24)), runtimeMin: (m.runtime || 100) / Math.max(1, Math.round((m.runtime || 100) / 24)) }, prof, learned, { inLibrary: !!fileScene && fileScene === r.title, blocklisted: blocked ? "blocklisted" : null, indexerHealth: indexerHealth(r.indexerId) });
    if (subtitles.length && !namesSubtitle(r.title, subtitles)) unnamed.add(r.guid);
    const pub = r.publishDate ? Date.parse(r.publishDate) : null;
    results.push({
      guid: r.guid,
      title: r.title,
      indexer: r.indexer,
      indexerId: r.indexerId,
      protocol: r.protocol,
      size: r.size,
      seeders: r.protocol === "torrent" ? (r.seeders ?? null) : null,
      publishDate: r.publishDate ?? null,
      ageHours: pub ? Math.round((Date.now() - pub) / 3_600_000) : null,
      episodeIds: [],
      label: m.year ? `${m.title} (${m.year})` : m.title,
      confidence: match.confidence,
      rank,
      mappingWhy: unnamed.has(r.guid) ? [match.why, `doesn't name "${subtitles[0]}" (likely the series' batch); ranked below releases that do`] : [match.why],
      group: p.group,
      downloadUrl: r.downloadUrl,
      magnetUrl: r.magnetUrl,
    });
  }
  results.sort((a, b) => Number(b.rank.accept) - Number(a.rank.accept) || Number(unnamed.has(a.guid)) - Number(unnamed.has(b.guid)) || compareRanked(a, b) || b.confidence - a.confidence);
  return { movie: { id: m.id, title: m.title, year: m.year, cover: m.poster }, queries, found: raw.size, matched: results.length, skipped, errors, tookMs: Date.now() - started, results };
}

// ---------------------------------------------------------------- grab

export interface MovieGrabRequest {
  movieId: number;
  candidate: Candidate;
  fallbacks: Candidate[];
  origin: "manual" | "managed";
  attempt?: number;
  /** The movie has a file and the user confirmed replacing it (it goes to Radarr's recycle bin, if one is set). */
  replace?: boolean;
  purpose?: "dual-upgrade" | null;
}

/** Sends a movie release to the download client (or logs it in dry-run). */
export async function startMovieGrab(req: MovieGrabRequest, deps: PipelineDeps = realDeps): Promise<{ id: number; dryRun: boolean; message: string; failed?: boolean }> {
  if (dbState.corrupt) throw Object.assign(new Error("The database failed its integrity check; restore a backup first"), { statusCode: 503 });
  const m = movieById(req.movieId);
  if (!m) throw Object.assign(new Error("Unknown movie; sync the library first"), { statusCode: 404 });
  if (!underAllowedRoot(m.path)) {
    throw Object.assign(new Error(`${m.title} is in ${path.posix.dirname(m.path)}, which is not an allowed root folder. AnimeArr only grabs and imports movies inside the root folders you allowed in Settings → Safety.`), { statusCode: 403 });
  }
  // Never replace a library file unless the user asked for exactly that.
  if (m.has_file && !req.replace) throw Object.assign(new Error(`${m.title} already has a file; confirm replacing it`), { statusCode: 409 });
  const c = req.candidate;
  const dryRun = getSettings().managed.dryRun;
  if (!dryRun) {
    const mv = movieById(req.movieId);
    const rel = mv ? releaseAt(mv) : null;
    const gate = grabGate("movie", rel !== null && Date.now() - rel < 30 * 86_400_000, { manual: req.origin === "manual" && !(req as { automatic?: boolean }).automatic });
    if (gate.paused && ((req.attempt ?? 1) === 1 || /free/.test(gate.why))) throw new GrabsPausedError(`Grabs are paused: ${gate.why}`);
  }
  if (!dryRun) {
    const busy = db.prepare(`SELECT id, release FROM grabs WHERE movie_id = ? AND state IN (${[...ACTIVE, "needs-attention"].map(() => "?").join(",")})`).get(req.movieId, ...ACTIVE, "needs-attention") as { id: number; release: string } | undefined;
    if (busy) throw Object.assign(new Error(`There's already a download for this movie (${busy.release}, grab ${busy.id}); remove it from the queue first`), { statusCode: 409 });
  }
  const now = Date.now();
  const id = Number(
    db
      .prepare("INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, indexer_id, protocol, state, dry_run, origin, why, candidates, attempt, progress_at, movie_id, replace_file, purpose) VALUES (?, ?, NULL, NULL, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(now, now, c.title, c.guid, c.indexerId, c.protocol, dryRun ? "dry-run" : "sending", dryRun ? 1 : 0, req.origin, c.why, JSON.stringify(req.fallbacks.slice(0, 5)), req.attempt ?? 1, now, req.movieId, req.replace ? 1 : 0, req.purpose ?? null).lastInsertRowid,
  );
  const label = m.year ? `${m.title} (${m.year})` : m.title;
  if (dryRun) {
    const msg = `would grab ${c.title} (${c.protocol}, ${c.indexer}) for ${label}: ${c.why}. Would import into Radarr.`;
    logDecision("would-grab", { title: label, release: c.title, why: `Dry-run: ${msg}`, detail: { grabId: id, movieId: m.id } });
    return { id, dryRun: true, message: msg };
  }
  try {
    const file = await fetchOrNote(deps, c);
    if (c.protocol === "usenet" && !file.data) throw new Error("No NZB data");
    const job = c.protocol === "usenet" ? await deps.clients.addNzb(file.data!, c.title) : await deps.clients.addTorrent(file, c.title, seedLimitsFor(c.indexerId));
    if (!db.prepare("UPDATE grabs SET state = 'downloading', error = NULL, updated_at = ?, client = ?, client_ref = ? WHERE id = ? AND state = 'sending'").run(Date.now(), job.client, job.ref, id).changes) {
      await deps.clients.remove(job).catch(() => undefined);
      return { id, dryRun: false, message: "Cancelled", failed: true };
    }
    logDecision("grab", { title: label, release: c.title, why: `Sent ${c.title} to ${job.client === "sabnzbd" ? "SABnzbd" : "qBittorrent"} for ${label}: ${c.why}`, detail: { grabId: id, movieId: m.id } });
    return { id, dryRun: false, message: `Sent to ${job.client}` };
  } catch (e) {
    setState(id, "failed", (e as Error).message);
    logDecision("fail", { title: label, release: c.title, why: `Couldn't send ${c.title}: ${(e as Error).message}`, detail: { grabId: id, movieId: m.id } });
    const next = await movieNext({ ...req, attempt: (req.attempt ?? 1) - (isFetchFailure(e) ? 1 : 0) }, deps, (e as Error).message, e);
    return next ?? { id, dryRun: false, message: (e as Error).message, failed: true };
  }
}

function movieRequest(row: GrabRow): MovieGrabRequest {
  const fallbacks = JSON.parse(row.candidates) as Candidate[];
  return { movieId: row.movie_id!, candidate: fallbacks[0], fallbacks, origin: row.origin, attempt: row.attempt ?? 1, replace: !!row.replace_file, purpose: row.purpose === "dual-upgrade" ? "dual-upgrade" : null };
}

/** Tries the next candidate of a failed movie grab (skipping blocklisted ones). */
export async function movieNext(req: MovieGrabRequest, deps: PipelineDeps, reason: string, cause?: unknown) {
  const attempt = (req.attempt ?? 1) + 1;
  const [next, ...rest] = remainingFallbacks(req.fallbacks, cause);
  if (!next || attempt > MAX_ATTEMPTS) {
    logDecision("skip", { title: movieById(req.movieId)?.title, why: `No more candidates to try after: ${reason}${attempt > MAX_ATTEMPTS ? ` (${MAX_ATTEMPTS} attempts used)` : ""}`, detail: { movieId: req.movieId } });
    return null;
  }
  try {
    return await startMovieGrab({ ...req, candidate: next, fallbacks: rest, attempt }, deps);
  } catch (e) {
    logDecision("skip", { title: movieById(req.movieId)?.title, why: `Couldn't try the next candidate: ${(e as Error).message}`, detail: { movieId: req.movieId } });
    return null;
  }
}
export const movieNextForRow = (row: GrabRow, deps: PipelineDeps, reason: string) => movieNext(movieRequest(row), deps, reason);

const toLangsFile = (f: NonNullable<RadarrMovie["movieFile"]>) => ({ path: f.path ?? null, sceneName: f.sceneName ?? null, releaseGroup: f.releaseGroup ?? null, quality: f.quality?.quality?.name ?? null, audio: langList(f.mediaInfo?.audioLanguages), subs: langList(f.mediaInfo?.subtitles), runTime: f.mediaInfo?.runTime ?? null, resolution: f.mediaInfo?.resolution ?? null });

// ---------------------------------------------------------------- import

/** Imports a finished movie download through Radarr's ManualImport (explicit movie id), verifying before and after. */
/**
 * The parts of a multi-part movie in a download: 2-6 big files of similar size (within 40 % of the biggest), each
 * with its own order number (S00E02/S00E03, "- 01"/"- 02", "Part 1"/"Part 2", "pt1"), all different. Null = not parts.
 */
export function multiPart<T extends { path: string; size?: number }>(files: T[]): T[] | null {
  const big = [...files].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  const top = big[0]?.size ?? 0;
  const parts = big.filter((f) => (f.size ?? 0) > top * 0.6);
  if (parts.length < 2 || parts.length > 6 || big.some((f) => (f.size ?? 0) > top * 0.4 && (f.size ?? 0) <= top * 0.6)) return null;
  const order = (f: T) => {
    const name = path.posix.basename(f.path);
    const pt = /\b(?:pt|part)[ ._-]?(\d{1,2})\b/i.exec(name)?.[1];
    if (pt) return Number(pt);
    const p = parseRelease(name);
    return p.episodes[0] ?? p.absolute[0] ?? p.specialNumber ?? null;
  };
  const keyed = parts.map((f) => ({ f, n: order(f) }));
  if (keyed.some((k) => k.n === null) || new Set(keyed.map((k) => k.n)).size !== keyed.length) return null;
  return keyed.sort((a, b) => a.n! - b.n!).map((k) => k.f);
}

/** Imports a multi-part movie as Plex-stacked parts (pt1, pt2, …), each verified first; runtimes must add up. */
async function importParts(
  row: GrabRow,
  m: MovieRow,
  live: { path: string; hasFile: boolean; runtime?: number | null },
  parts: { path: string; size?: number }[],
  prof: ReturnType<typeof profileForMovie>,
  deps: PipelineDeps,
  attention: (why: string) => void,
  fail: (why: string, imported: boolean) => Promise<void>,
  label: string,
  trusted: string,
) {
  const native = isNativeMovieId(m.id);
  const runtime = live.runtime ?? m.runtime ?? null;
  // Without the movie's runtime nothing proves these are its parts (they could be two episodes).
  if (!runtime) return attention(`the download has ${parts.length} numbered parts, but the movie's runtime isn't known to check them against; import them by hand`);
  let total = 0;
  for (const [i, p] of parts.entries()) {
    const local = deps.localPath(p.path);
    if (!local) return attention(`can't reach ${p.path} from AnimeArr (check Settings → Paths)`);
    const probe = await deps.probe(local);
    total += probe.durationSec ?? 0;
    const v = judge(probe, prof, runtime ? Math.round(runtime / parts.length) : null, null);
    if (!v.ok && !row.keep) return fail(`part ${i + 1} (${path.posix.basename(p.path)}): ${v.why}`, false);
    logDecision("verify-ok", { title: label, release: row.release, why: `Checked part ${i + 1} of ${parts.length} (${path.posix.basename(p.path)}) before import: ${v.why}`, detail: { grabId: row.id, movieId: m.id } });
  }
  // The parts must add up to the movie (TMDB runtime), or it's something else (e.g. a batch of episodes).
  if (runtime && total && (total / 60 < runtime * 0.75 || total / 60 > runtime * 1.35)) return attention(`the download has ${parts.length} parts adding up to ${Math.round(total / 60)} min, but the movie is ${runtime} min; import the right file by hand`);
  const imp = getSettings().importer;
  if (!native && imp.engine === "sonarr") return attention(`a ${parts.length}-part movie is imported by AnimeArr's own importer (Settings → Media management → Importer)`);
  if (!imp.allowReal || !imp.movies) return attention("real movie imports by AnimeArr's importer are switched off (Settings → Media management → Importer)");
  if (!((imp.realBudget ?? 0) < 0 || (imp.realBudget ?? 0) >= parts.length)) return attention("AnimeArr's importer is paused for a review (Settings → Media management → Importer)");
  try {
    const liveFile = native ? null : ((live as { movieFile?: { path?: string } }).movieFile?.path ?? null);
    const plans = [];
    for (const [i, p] of parts.entries()) plans.push(await planMovieImport({ movieId: m.id, path: p.path, release: row.release, client: row.client, automatic: true, trusted, part: i + 1, live: native ? undefined : { path: live.path, currentFile: liveFile } }));
    const items = plans.flatMap((x) => x.items);
    // A retry after the parts were already placed (e.g. Radarr didn't pick them up): same name and size = done.
    const placed = (it: (typeof items)[number]) => {
      try {
        return fs.existsSync(it.dest) && fs.statSync(it.dest).size === fs.statSync(it.source).size;
      } catch {
        return false;
      }
    };
    if (!items.every(placed)) {
      const res = await executeMovieImport({ ...plans[0], items }, { grabId: row.id });
      const bad = res.find((r) => !r.done);
      if (bad || res.length !== parts.length) return attention(`AnimeArr's importer: ${bad?.why ?? "not every part was imported"}`);
    }
    if (!native) {
      const wants = new Set(items.map((x) => x.destArr));
      let after: Awaited<ReturnType<NonNullable<PipelineDeps["radarr"]>["movie"]>> | null = null;
      for (let i = 0; i < 24; i++) {
        after = await deps.radarr!.movie(m.id);
        if (after.movieFile?.path && wants.has(after.movieFile.path)) break;
        await deps.sleep(5000);
      }
      // Radarr (v3+) doesn't track stacked parts: AnimeArr remembers the file itself, so neither its own movie search
      // nor the next sync treats the movie as missing.
      if (!after?.movieFile?.path || !wants.has(after.movieFile.path)) {
        const first = await deps.probe(deps.localPath(items[0].destArr) ?? items[0].dest).catch(() => null);
        const file = JSON.stringify({ path: items[0].destArr, parts: items.map((x) => x.destArr), sceneName: row.release, releaseGroup: parseRelease(row.release).group, quality: null, audio: first?.audio ?? [], subs: first?.subs ?? [], runTime: null, resolution: null });
        db.prepare("INSERT OR REPLACE INTO movie_parts (movie_id, file, at) VALUES (?, ?, ?)").run(m.id, file, Date.now());
        cache.prepare("UPDATE movies SET has_file = 1, file = ? WHERE id = ?").run(file, m.id);
        logDecision("info", { title: label, why: `Radarr doesn't track multi-part movies, so it still lists ${label} as missing; AnimeArr counts it as there. Unmonitor it in Radarr so Radarr doesn't search for it again.`, detail: { grabId: row.id, movieId: m.id } });
      } else cache.prepare("UPDATE movies SET has_file = 1, file = ? WHERE id = ?").run(JSON.stringify(toLangsFile(after.movieFile)), m.id);
    }
  } catch (e) {
    return attention(`AnimeArr's importer: ${(e as Error).message}`);
  }
  setState(row.id, "done");
  void deps.cleanup?.(row.id, "imported");
  logDecision("import", { title: label, release: row.release, why: `Imported ✓ ${label}: a ${parts.length}-part release, imported as pt1…pt${parts.length} (Plex plays them as one movie)`, detail: { grabId: row.id, movieId: m.id, final: true } });
}

export async function importMovie(row: GrabRow, clientPath: string, deps: PipelineDeps = realDeps) {
  const m = movieById(row.movie_id!);
  const label = m ? (m.year ? `${m.title} (${m.year})` : m.title) : `movie ${row.movie_id}`;
  const attention = (why: string) => {
    setState(row.id, "needs-attention", why);
    logDecision("fail", { title: label, release: row.release, why: `Downloaded ${row.release} but couldn't import it: ${why}. The download is kept; fix the cause and press "Retry import".`, detail: { grabId: row.id, movieId: row.movie_id } });
  };
  const fail = async (why: string, imported: boolean) => {
    setState(row.id, "failed", why);
    blocklist(row, why);
    logDecision("verify-fail", { title: label, release: row.release, why: `${row.release} failed verification: ${why}${imported ? " (already imported; it will be replaced if a better release is found)" : ""}. Blocklisted it.`, detail: { grabId: row.id, movieId: row.movie_id }, undo: { action: "unblock", args: { release: row.release } } });
    // A bad file that was already imported may be replaced by the next candidate.
    await movieNext({ ...movieRequest(row), replace: imported || !!row.replace_file }, deps, why);
  };
  if (!m) return attention("the movie is no longer in the library");
  // A movie added in AnimeArr has no Radarr: AnimeArr lists, checks and imports it itself.
  const native = isNativeMovieId(m.id);
  if (!native && !deps.radarr) return attention("Radarr isn't available");
  // Live re-check (the cache can be stale): still inside an allowed root, and no file gained since the grab
  // unless replacing it was asked for.
  const live = native ? { path: m.path, hasFile: !!m.has_file, runtime: m.runtime } : await deps.radarr!.movie(m.id);
  if (!underAllowedRoot(live.path)) return attention(`the movie is now in ${live.path}, outside the allowed root folders`);
  if (live.hasFile && !row.replace_file) return attention("the movie got a file in the meantime; AnimeArr won't replace it without your OK (remove this download, or search again and confirm replacing)");
  const p0 = clientToSonarr(clientPath);
  const single = VIDEO.test(p0);
  const folder = single ? path.posix.dirname(p0) : p0;
  let listed: { path: string; size?: number; quality?: unknown; languages?: unknown; releaseGroup?: string; indexerFlags?: number }[];
  if (native) {
    const lf = deps.localPath(single ? p0 : folder);
    if (!lf) return attention(`can't reach ${single ? p0 : folder} from AnimeArr (check Settings → Paths)`);
    listed = single ? [{ path: p0, size: fs.statSync(lf).size }] : listVideos(lf).map((f) => ({ path: `${folder}/${path.relative(lf, f.path).split(path.sep).join("/")}`, size: f.size }));
  } else listed = await deps.radarr!.preview(folder);
  const items = listed.filter((x) => VIDEO.test(x.path) && !/\bsample\b/i.test(x.path) && (x.size ?? 1e9) > 100e6) as Awaited<ReturnType<NonNullable<PipelineDeps["radarr"]>["preview"]>>;
  const inThis = items.filter((x) => (single ? x.path === p0 : x.path.startsWith(`${folder}/`)));
  if (!inThis.length) return attention(`no video files found in ${single ? p0 : folder} (Radarr must see the download folder at the same path as Sonarr; archives aren't unpacked for movies yet)`);
  // The movie is the biggest file; extras stay out. Two big files = maybe two movies: let the user decide.
  const bySize = [...inThis].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  let main = bySize[0];
  const prof = profileForMovie(m.id);
  // A season batch that bundles the special (e.g. Specials/"… - OVA - Date to Date.mkv"): the file whose name carries
  // the movie's subtitle is the movie, whatever its size.
  const subtitles = movieSubtitles([m.title, m.original_title ?? "", ...parseTitles(m.alt_titles)], seriesForMovie(m.id).map((x) => x.title));
  const named = inThis.length > 1 ? fileForMovie(inThis, subtitles) : null;
  if (named && named !== main) {
    main = named;
    logDecision("info", { title: label, release: row.release, why: `${row.release} has several videos; picked ${path.posix.basename(named.path)}, the one whose name says "${subtitles.find((x) => namesSubtitle(path.posix.basename(named.path), [x])) ?? subtitles[0]}"`, detail: { grabId: row.id, movieId: m.id } });
  }
  // Several big files: a multi-part movie (a 2-part special filed as one movie) when they're numbered parts of similar
  // size whose runtimes add up to the movie's; numbered episodes of a series are the wrong release; anything else is for
  // the user to decide.
  let parts: typeof inThis | null = null;
  if (!named && bySize[1] && (bySize[1].size ?? 0) > (main.size ?? 0) * 0.4) {
    parts = multiPart(inThis);
    const big = bySize.filter((x) => (x.size ?? 0) > (main.size ?? 0) * 0.4);
    if (!parts && looksLikeEpisodes(big)) return fail(`wrong release: this is a series batch (${big.length} numbered episodes${subtitles.length ? `, none of them named "${subtitles[0]}"` : ""}), not the movie`, false);
    if (!parts) return attention(`the download has several large video files (${bySize.slice(0, 3).map((x) => path.posix.basename(x.path)).join(", ")}); import the right one by hand`);
  }
  if (parts) return importParts(row, m, live, parts, prof, deps, attention, fail, label, p0);
  const parsed = parseRelease(row.release);
  const learnKey = parsed.platform ?? sourceKey(row.release, null, parsed.source);
  // A dual-audio upgrade replaces a placeholder: only a file with the original audio AND the dub counts.
  const strictMovie = (v: ReturnType<typeof judge>): ReturnType<typeof judge> => {
    if (row.purpose !== "dual-upgrade" || !v.ok) return v;
    const original = prof.originalLangs ?? ["ja"];
    const dub = (prof.dubLangs ?? []).filter((l) => !original.includes(l));
    const base = v.audio.map((a) => a.split("-")[0]);
    const hasDub = dub.find((l) => base.includes(l));
    const hasOriginal = !original.length || base.some((a) => original.includes(a));
    return hasDub && hasOriginal ? v : { ...v, ok: false, why: `no ${hasDub ? "original" : dub.join("/")} audio (audio: ${v.audio.join("/") || "unknown"}): not the dual-audio release it claimed to be` };
  };
  let preVerified = false;
  const local = deps.localPath(main.path);
  if (local) {
    const probe = await deps.probe(local);
    const v = strictMovie(judge(probe, prof, live.runtime ?? m.runtime ?? null, null));
    learnFromVerify(parsed.group, learnKey, v.subs, v.audio);
    if (!v.ok && !row.keep) return fail(`${path.posix.basename(main.path)}: ${v.why}`, false);
    preVerified = true;
    if (v.ok) logDecision("verify-ok", { title: label, release: row.release, why: `Checked ${path.posix.basename(main.path)} before import: ${v.why}`, detail: { grabId: row.id, movieId: m.id } });
    else logDecision("info", { title: label, release: row.release, why: `Kept ${path.posix.basename(main.path)} as you asked, although: ${v.why}`, detail: { grabId: row.id, movieId: m.id } });
  }
  // AnimeArr imports by itself (the user's decision): nothing goes through Radarr's import any more; whatever can't go
  // through AnimeArr's importer waits in "needs attention".
  const imp = getSettings().importer;
  const budgetOk = (imp.realBudget ?? 0) < 0 || (imp.realBudget ?? 0) >= 1;
  if (native || imp.engine !== "sonarr") {
    if (!imp.allowReal || !imp.movies) return attention("real movie imports by AnimeArr's importer are switched off (Settings → Media management → Importer)");
    if (!budgetOk) return attention("AnimeArr's importer is paused for a review (Settings → Media management → Importer)");
    if (!preVerified) return attention("AnimeArr couldn't check the file before importing (check Settings → Paths)");
    try {
      const liveFile = native ? null : ((live as { movieFile?: { path?: string } }).movieFile?.path ?? null);
      const plan = await planMovieImport({ movieId: m.id, path: main.path, release: row.release, client: row.client, automatic: true, trusted: p0, live: native ? undefined : { path: live.path, currentFile: liveFile } });
      const res = await executeMovieImport(plan, { grabId: row.id });
      const bad = res.find((r) => !r.done);
      if (bad || !res.length) return attention(`AnimeArr's importer: ${bad?.why ?? "nothing to import"}`);
      if (!native) {
        // Radarr must see the new file (it re-reads the folder); otherwise it would search for the movie again.
        const want = plan.items[0].destArr;
        let after: Awaited<ReturnType<NonNullable<PipelineDeps["radarr"]>["movie"]>> | null = null;
        for (let i = 0; i < 24; i++) {
          after = await deps.radarr!.movie(m.id);
          if (after.movieFile?.path === want) break;
          await deps.sleep(5000);
        }
        if (after?.movieFile?.path !== want) return attention(`AnimeArr imported ${path.posix.basename(want)}, but Radarr hasn't picked it up yet (check Radarr; a Rescan there fixes it)`);
        cache.prepare("UPDATE movies SET has_file = 1, file = ? WHERE id = ?").run(JSON.stringify(toLangsFile(after.movieFile)), m.id);
      }
    } catch (e) {
      return attention(`AnimeArr's importer: ${(e as Error).message}`);
    }
    setState(row.id, "done");
    logDecision("import", { title: label, release: row.release, why: `Imported ✓ ${label} (AnimeArr's importer)`, detail: { grabId: row.id, movieId: m.id, final: true } });
    await deps.cleanup?.(row.id, "imported");
    return;
  }
  const started = Date.now();
  const cmd = await deps.radarr!.importFiles([{ path: main.path, movieId: m.id, quality: main.quality, languages: main.languages, releaseGroup: main.releaseGroup ?? parsed.group ?? undefined, downloadId: row.client_ref ?? undefined, indexerFlags: main.indexerFlags ?? 0 }], importModeFor(row.client));
  logDecision("import", { title: label, release: row.release, why: `Asked Radarr to import ${path.posix.basename(main.path)} as ${label} (command ${cmd.id})`, detail: { grabId: row.id, movieId: m.id, commandId: cmd.id } });
  let status = "queued";
  for (let i = 0; i < 120 && !["completed", "failed", "aborted"].includes(status); i++) {
    await deps.sleep(5000);
    status = (await deps.radarr!.command(cmd.id)).status;
  }
  if (status !== "completed") return attention(`Radarr import ${status}`);
  const after = await deps.radarr!.movie(m.id);
  const mf = after.movieFile;
  if (!after.hasFile || !mf || !mf.dateAdded || Date.parse(mf.dateAdded) < started - 60_000) return attention("Radarr finished the import but the movie has no new file (Radarr may have rejected it; see Radarr's activity)");
  if (!preVerified) {
    const subs = langList(mf.mediaInfo?.subtitles);
    const audio = langList(mf.mediaInfo?.audioLanguages);
    if (!subs.length && !audio.length) return attention(`Radarr has no track information for ${path.posix.basename(mf.path ?? main.path)} yet, so the language couldn't be checked; check the file, then retry`);
    const v = strictMovie(judge({ subs, audio, durationSec: runTimeSec(mf.mediaInfo?.runTime), sidecars: [], untagged: 0 }, prof, after.runtime ?? m.runtime ?? null, null));
    learnFromVerify(parsed.group, learnKey, v.subs, v.audio);
    if (!v.ok && !row.keep) return fail(`${path.posix.basename(mf.path ?? main.path)}: ${v.why}`, true);
  }
  setState(row.id, "done");
  cache.prepare("UPDATE movies SET has_file = 1, file = ? WHERE id = ?").run(JSON.stringify(toLangsFile(mf)), m.id);
  logDecision("import", { title: label, release: row.release, why: `Imported ✓ ${label}`, detail: { grabId: row.id, movieId: m.id, final: true } });
}

/** Movie release dates in a range, for the calendar (in cinemas, digital, physical). */
export function movieCalendar(fromMs: number, toMs: number, wantedOnly: boolean) {
  const rows = cache
    .prepare("SELECT * FROM movies WHERE is_anime = 1 AND ((in_cinemas BETWEEN ? AND ?) OR (digital_release BETWEEN ? AND ?) OR (physical_release BETWEEN ? AND ?))")
    .all(fromMs - 86_400_000, toMs + 86_400_000, fromMs - 86_400_000, toMs + 86_400_000, fromMs - 86_400_000, toMs + 86_400_000) as unknown as MovieRow[];
  const out: { movieId: number; title: string; year: number | null; cover: string | null; kind: "cinema" | "digital" | "physical"; at: number; status: string; monitored: boolean }[] = [];
  for (const m of rows) {
    if (wantedOnly && (!isWanted(m.id) || !underAllowedRoot(m.path))) continue;
    const g = activeGrab(m.id);
    const status = g ? (g.state === "needs-attention" ? "attention" : "downloading") : m.has_file ? "have" : isReleased(m) ? "missing" : "unreleased";
    for (const [kind, at] of [["cinema", m.in_cinemas], ["digital", m.digital_release], ["physical", m.physical_release]] as const)
      if (at && at >= fromMs - 86_400_000 && at <= toMs + 86_400_000) out.push({ movieId: m.id, title: m.title, year: m.year, cover: m.poster, kind, at, status, monitored: isWanted(m.id) });
  }
  return out.sort((a, b) => a.at - b.at);
}
