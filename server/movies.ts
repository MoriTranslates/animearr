/**
 * Anime movies (the Radarr side). Companion mode, like episodes: Radarr stays the library; AnimeArr searches Prowlarr
 * with every title it knows, ranks by the language profile, sends the grab to its own download-client category, and
 * imports through Radarr's ManualImport with the explicit movie id, verifying before and after.
 *
 * Guard rails: only movies inside an allowed root folder (Settings → Safety lists Radarr's root folders too);
 * manual grabs need a confirmation and honour the global dry-run; never two downloads for one movie at once;
 * a pack or a series release is never taken for the movie.
 */
import path from "node:path";
import { logDecision } from "./activity.js";
import { prowlarrSearch, type ProwlarrRelease } from "./arr/prowlarr.js";
import { langList } from "./core/langs.js";
import { parseRelease, type ParsedRelease } from "./core/parser.js";
import { compareRanked, rankRelease } from "./core/rank.js";
import { cache, db, dbState } from "./db.js";
import { learnedFor, learnFromVerify, sourceKey } from "./library.js";
import { ACTIVE, blocklist, fetchOrNote, importModeFor, isBlocked, MAX_ATTEMPTS, realDeps, runTimeSec, setState, VIDEO, type Candidate, type GrabRow, type PipelineDeps } from "./pipeline.js";
import type { RadarrMovie } from "./arr/radarr.js";
import { clientToSonarr } from "./paths.js";
import { moviePrefs, profileForMovie } from "./profiles.js";
import { seriesForMovie } from "./franchise.js";
import type { SearchResult } from "./search.js";
import { getSettings, underAllowedRoot } from "./settings.js";
import { judge } from "./verify.js";
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
}
export interface MovieFile { path: string | null; sceneName: string | null; releaseGroup: string | null; quality: string | null; audio: string[]; subs: string[]; runTime: string | null; resolution: string | null }

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
      monitored: !!m.monitored,
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
    altTitles: JSON.parse(m.alt_titles) as string[],
    year: m.year,
    runtime: m.runtime,
    path: m.path,
    cover: m.poster,
    monitored: !!m.monitored,
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

const ROMAN: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
const MARKER = /\b(the movie|movie|gekijouban|gekijoban|film)\b|劇場版/gi;

/** Lower-case, accents and punctuation removed, "the movie"/"gekijouban" dropped, roman numerals as digits. */
export function normTitle(t: string) {
  return t
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(MARKER, " ")
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w === "part" ? "" : (ROMAN[w] ?? w)))
    .filter(Boolean)
    .join(" ");
}
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
export function matchMovie(p: ParsedRelease, m: { title: string; original_title: string | null; alt_titles: string[]; year: number | null }): { confidence: number; why: string } {
  const titles = [m.title, m.original_title ?? "", ...m.alt_titles].filter(Boolean);
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
export async function searchMovie(id: number, search: typeof prowlarrSearch = prowlarrSearch) {
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
  for (const r of raw.values()) {
    const p = parseRelease(r.title);
    const match = matchMovie(p, info);
    if (!match.confidence) {
      skipped[match.why] = (skipped[match.why] ?? 0) + 1;
      continue;
    }
    const learned = learnedFor(p.group, p.platform ?? sourceKey(r.title, null, p.source));
    const blocked = isBlocked({ guid: r.guid, title: r.title });
    // Size sanity: a movie is worth several episodes.
    const rank = rankRelease(p, { protocol: r.protocol, size: r.size, seeders: r.seeders ?? null, indexer: r.indexer, episodeCount: Math.max(1, Math.round((m.runtime || 100) / 24)), runtimeMin: (m.runtime || 100) / Math.max(1, Math.round((m.runtime || 100) / 24)) }, prof, learned, { inLibrary: !!fileScene && fileScene === r.title, blocklisted: blocked ? "blocklisted" : null, indexerHealth: indexerHealth(r.indexerId) });
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
      mappingWhy: [match.why],
      group: p.group,
      downloadUrl: r.downloadUrl,
      magnetUrl: r.magnetUrl,
    });
  }
  results.sort((a, b) => compareRanked(a, b) || b.confidence - a.confidence);
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
    const job = c.protocol === "usenet" ? await deps.clients.addNzb(file.data!, c.title) : await deps.clients.addTorrent(file, c.title);
    if (!db.prepare("UPDATE grabs SET state = 'downloading', error = NULL, updated_at = ?, client = ?, client_ref = ? WHERE id = ? AND state = 'sending'").run(Date.now(), job.client, job.ref, id).changes) {
      await deps.clients.remove(job).catch(() => undefined);
      return { id, dryRun: false, message: "Cancelled", failed: true };
    }
    logDecision("grab", { title: label, release: c.title, why: `Sent ${c.title} to ${job.client === "sabnzbd" ? "SABnzbd" : "qBittorrent"} for ${label}: ${c.why}`, detail: { grabId: id, movieId: m.id } });
    return { id, dryRun: false, message: `Sent to ${job.client}` };
  } catch (e) {
    setState(id, "failed", (e as Error).message);
    logDecision("fail", { title: label, release: c.title, why: `Couldn't send ${c.title}: ${(e as Error).message}`, detail: { grabId: id, movieId: m.id } });
    const next = await movieNext({ ...req, attempt: req.attempt ?? 1 }, deps, (e as Error).message);
    return next ?? { id, dryRun: false, message: (e as Error).message, failed: true };
  }
}

function movieRequest(row: GrabRow): MovieGrabRequest {
  const fallbacks = JSON.parse(row.candidates) as Candidate[];
  return { movieId: row.movie_id!, candidate: fallbacks[0], fallbacks, origin: row.origin, attempt: row.attempt ?? 1, replace: !!row.replace_file, purpose: row.purpose ?? null };
}

/** Tries the next candidate of a failed movie grab (skipping blocklisted ones). */
export async function movieNext(req: MovieGrabRequest, deps: PipelineDeps, reason: string) {
  const attempt = (req.attempt ?? 1) + 1;
  const [next, ...rest] = req.fallbacks.filter((f) => !isBlocked(f));
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
  if (!m) return attention("the movie is no longer in the synced Radarr library");
  if (!deps.radarr) return attention("Radarr isn't available");
  // Live re-check (the cache can be stale): still inside an allowed root, and no file gained since the grab
  // unless replacing it was asked for.
  const live = await deps.radarr.movie(m.id);
  if (!underAllowedRoot(live.path)) return attention(`the movie is now in ${live.path}, outside the allowed root folders`);
  if (live.hasFile && !row.replace_file) return attention("the movie got a file in the meantime; AnimeArr won't replace it without your OK (remove this download, or search again and confirm replacing)");
  const p0 = clientToSonarr(clientPath);
  const single = VIDEO.test(p0);
  const folder = single ? path.posix.dirname(p0) : p0;
  const items = (await deps.radarr.preview(folder)).filter((x) => VIDEO.test(x.path) && !/\bsample\b/i.test(x.path) && (x.size ?? 1e9) > 100e6);
  const inThis = items.filter((x) => (single ? x.path === p0 : x.path.startsWith(`${folder}/`)));
  if (!inThis.length) return attention(`no video files found in ${single ? p0 : folder} (Radarr must see the download folder at the same path as Sonarr; archives aren't unpacked for movies yet)`);
  // The movie is the biggest file; extras stay out. Two big files = maybe two movies: let the user decide.
  const bySize = [...inThis].sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  const main = bySize[0];
  if (bySize[1] && (bySize[1].size ?? 0) > (main.size ?? 0) * 0.4) return attention(`the download has several large video files (${bySize.slice(0, 3).map((x) => path.posix.basename(x.path)).join(", ")}); import the right one by hand`);
  const prof = profileForMovie(m.id);
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
    if (!v.ok) return fail(`${path.posix.basename(main.path)}: ${v.why}`, false);
    preVerified = true;
    logDecision("verify-ok", { title: label, release: row.release, why: `Checked ${path.posix.basename(main.path)} before import: ${v.why}`, detail: { grabId: row.id, movieId: m.id } });
  }
  const started = Date.now();
  const cmd = await deps.radarr.importFiles([{ path: main.path, movieId: m.id, quality: main.quality, languages: main.languages, releaseGroup: main.releaseGroup ?? parsed.group ?? undefined, downloadId: row.client_ref ?? undefined, indexerFlags: main.indexerFlags ?? 0 }], importModeFor(row.client));
  logDecision("import", { title: label, release: row.release, why: `Asked Radarr to import ${path.posix.basename(main.path)} as ${label} (command ${cmd.id})`, detail: { grabId: row.id, movieId: m.id, commandId: cmd.id } });
  let status = "queued";
  for (let i = 0; i < 120 && !["completed", "failed", "aborted"].includes(status); i++) {
    await deps.sleep(5000);
    status = (await deps.radarr.command(cmd.id)).status;
  }
  if (status !== "completed") return attention(`Radarr import ${status}`);
  const after = await deps.radarr.movie(m.id);
  const mf = after.movieFile;
  if (!after.hasFile || !mf || !mf.dateAdded || Date.parse(mf.dateAdded) < started - 60_000) return attention("Radarr finished the import but the movie has no new file (Radarr may have rejected it; see Radarr's activity)");
  if (!preVerified) {
    const subs = langList(mf.mediaInfo?.subtitles);
    const audio = langList(mf.mediaInfo?.audioLanguages);
    if (!subs.length && !audio.length) return attention(`Radarr has no track information for ${path.posix.basename(mf.path ?? main.path)} yet, so the language couldn't be checked; check the file, then retry`);
    const v = strictMovie(judge({ subs, audio, durationSec: runTimeSec(mf.mediaInfo?.runTime), sidecars: [], untagged: 0 }, prof, after.runtime ?? m.runtime ?? null, null));
    learnFromVerify(parsed.group, learnKey, v.subs, v.audio);
    if (!v.ok) return fail(`${path.posix.basename(mf.path ?? main.path)}: ${v.why}`, true);
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
    if (wantedOnly && (!m.monitored || !underAllowedRoot(m.path))) continue;
    const g = activeGrab(m.id);
    const status = g ? (g.state === "needs-attention" ? "attention" : "downloading") : m.has_file ? "have" : isReleased(m) ? "missing" : "unreleased";
    for (const [kind, at] of [["cinema", m.in_cinemas], ["digital", m.digital_release], ["physical", m.physical_release]] as const)
      if (at && at >= fromMs - 86_400_000 && at <= toMs + 86_400_000) out.push({ movieId: m.id, title: m.title, year: m.year, cover: m.poster, kind, at, status, monitored: !!m.monitored });
  }
  return out.sort((a, b) => a.at - b.at);
}
