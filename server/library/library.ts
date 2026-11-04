import { fileSurelyGone } from "../system/paths.js";
/**
 * Import / sync of the existing Sonarr and Radarr libraries into cache.db (companion mode: Sonarr stays the source of
 * truth for files). Read-only towards Sonarr/Radarr: nothing here changes their settings or data.
 *
 * - Sonarr: anime series (seriesType=anime, or the optional anime tag) with episodes, files (mediaInfo languages) and
 *   alternate titles (which become aliases). Incremental: a series' episodes/files are re-read only when its statistics
 *   changed, or once a day.
 * - Each series is matched to AniDB through Anime-Lists; unmatched series are marked for review.
 * - Radarr: movies under the anime root folders/profiles (or Japanese animation).
 */
import { invalidateFranchise } from "./franchise.js";
import { getEpisodeFiles, getEpisodes, getSeries, getTags, sonarrConfigured, type SonarrSeries } from "../arr/sonarr.js";
import { getMovies, radarrConfigured } from "../arr/radarr.js";
import { logDecision } from "../system/activity.js";
import { langList } from "../core/langs.js";
import { compactKey } from "../core/normalize.js";
import { parseRelease } from "../core/parser.js";
import { cache, db, dbState, setJob, tx } from "../system/db.js";
import { animeListEntries, invalidateIndex } from "../metadata/metadata.js";
import { markListRead, materializeAll, rematerializeSeries, type ArrApp } from "./native.js";
import { isNativeSeriesId, NATIVE_BASE } from "./nativeIds.js";
import { getSettings } from "../system/settings.js";

let running: Promise<SyncResult> | null = null;

export interface SyncResult {
  series: number;
  refreshed: number;
  removed: number;
  movies: number;
  unmatched: number;
  errors: string[];
  at: number;
}

const sigOf = (s: SonarrSeries) => {
  const st = (s as { statistics?: Record<string, unknown> }).statistics ?? {};
  return JSON.stringify([
    s.path,
    st.episodeFileCount,
    st.episodeCount,
    st.totalEpisodeCount,
    st.sizeOnDisk,
    s.previousAiring,
    s.nextAiring,
    s.seasons.map((x) => [x.seasonNumber, x.monitored, x.statistics?.episodeFileCount]),
  ]);
};

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

/**
 * One sync at a time. A full sync (Rebuild cache) asked for while a plain one runs is queued behind it, not swallowed:
 * held removals are only applied by a full sync (review L2). Later callers share the queued run.
 */
let runningFull = false;
let queuedFull: Promise<SyncResult> | null = null;
export function syncLibrary(full = false): Promise<SyncResult> {
  if (queuedFull) return queuedFull;
  if (!running) {
    runningFull = full;
    running = doSync(full).finally(() => (running = null));
    return running;
  }
  if (!full || runningFull) return running;
  queuedFull = running
    .catch(() => undefined) // the plain run's own failure is its caller's to see; the full run goes ahead either way
    .then(() => {
      queuedFull = null;
      runningFull = true;
      running = doSync(true).finally(() => (running = null));
      return running;
    });
  return queuedFull;
}
export const syncRunning = () => !!running || !!queuedFull;

async function doSync(full: boolean): Promise<SyncResult> {
  const res: SyncResult = { series: 0, refreshed: 0, removed: 0, movies: 0, unmatched: 0, errors: [], at: Date.now() };
  setJob("sync", "running", "Reading Sonarr");
  try {
    if (sonarrConfigured()) await syncSonarr(full, res);
    if (radarrConfigured()) {
      setJob("sync", "running", "Reading Radarr");
      try {
        res.movies = await syncRadarr(full, res);
      } catch (e) {
        res.errors.push((e as Error).message);
      }
    }
    if (!dbState.corrupt) backfillLearning();
    materializeAll(); // native shows (added in AnimeArr) next to Sonarr's
    invalidateIndex();
    invalidateFranchise();
    const detail = `${res.series} anime series (${res.refreshed} refreshed), ${res.movies} anime movies, ${res.unmatched} need an AniDB match`;
    setJob(
      "sync",
      res.errors.length ? "error" : "done",
      res.errors.length ? `${detail}. Problems: ${res.errors.slice(0, 3).join("; ")}` : detail,
    );
    if (res.refreshed || res.removed)
      logDecision("sync", { why: `Synced from Sonarr/Radarr: ${detail}${res.removed ? `, ${res.removed} removed` : ""}` });
  } catch (e) {
    res.errors.push((e as Error).message);
    setJob("sync", "error", (e as Error).message);
  }
  return res;
}

/**
 * Whether a plain sync must hold back dropping what Sonarr/Radarr no longer lists, and the message why (null = apply).
 * An empty or half answer (starting up, a restored or wrong instance, the anime tag renamed) looks the same as a mass
 * removal, and acting on it would close managed searches and let Add and import lists add the same shows and movies
 * again as native duplicates (review 2026-11-02, H10). So a plain sync only drops a few; all of them, more than half,
 * or anything while `suspect` names a problem waits for a full sync, which the user starts on purpose.
 */
function heldRemoval(app: ArrApp, what: string, had: number, gone: number, full: boolean, suspect: string | null): string | null {
  if (full || !gone || !(suspect || gone === had || (gone >= 2 && gone * 2 > had))) return null;
  return `${suspect ? `${suspect}; ` : ""}${app}'s answer lacks ${gone} of the ${had} ${what} AnimeArr knows, so they were kept in case ${app} only half-answered. If you really removed them from ${app}, apply it with Settings → System → Rebuild cache`;
}

async function syncSonarr(full: boolean, res: SyncResult) {
  const s = getSettings();
  const all = await getSeries();
  // A malformed answer (a proxy's HTML page, an error object, records without fields) fails the sync: the cache stays.
  if (!Array.isArray(all) || all.some((x) => !x || typeof x.id !== "number" || !Array.isArray(x.seasons)))
    throw new Error("Sonarr's series list came back malformed; kept the shows AnimeArr already had");
  let animeTagId: number | null = null;
  let tagMissing = false;
  if (s.sonarr.animeTag) {
    const tags = await getTags();
    if (!Array.isArray(tags)) throw new Error("Sonarr's tag list came back malformed; kept the shows AnimeArr already had");
    animeTagId = tags.find((t) => t.label?.toLowerCase() === s.sonarr.animeTag.toLowerCase())?.id ?? null;
    tagMissing = animeTagId === null;
  }
  const anime = all.filter((x) => x.seriesType === "anime" || (animeTagId !== null && (x.tags ?? []).includes(animeTagId)));
  res.series = anime.length;
  const prev = new Map(
    (
      cache.prepare(`SELECT id, sig, synced_at FROM series WHERE id < ${NATIVE_BASE}`).all() as {
        id: number;
        sig: string | null;
        synced_at: number;
      }[]
    ).map((r) => [r.id, r]),
  );
  const byTvdb = new Map<number, { aid: number; season: number | "a" | null; offset: number }[]>();
  for (const e of animeListEntries().values())
    if (e.tvdbId !== null)
      byTvdb.set(e.tvdbId, [...(byTvdb.get(e.tvdbId) ?? []), { aid: e.aid, season: e.defaultSeason, offset: e.offset }]);

  const upsertSeries =
    cache.prepare(`INSERT INTO series (id, tvdb_id, tmdb_id, imdb_id, title, sort_title, year, status, series_type, path, root_folder, monitored, quality_profile_id, tags, network, runtime,
      original_language, seasons, first_aired, next_airing, previous_airing, anidb_ids, anidb_status, poster, added, sig, overview, genres, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET tvdb_id = excluded.tvdb_id, tmdb_id = excluded.tmdb_id, imdb_id = excluded.imdb_id, title = excluded.title, sort_title = excluded.sort_title,
      year = excluded.year, status = excluded.status, series_type = excluded.series_type, path = excluded.path, root_folder = excluded.root_folder, monitored = excluded.monitored,
      quality_profile_id = excluded.quality_profile_id, tags = excluded.tags, network = excluded.network, runtime = excluded.runtime, original_language = excluded.original_language,
      seasons = excluded.seasons, first_aired = excluded.first_aired, next_airing = excluded.next_airing, previous_airing = excluded.previous_airing, anidb_ids = excluded.anidb_ids,
      anidb_status = excluded.anidb_status, poster = excluded.poster, added = excluded.added, overview = excluded.overview, genres = excluded.genres, sig = CASE WHEN excluded.sig IS NULL THEN series.sig ELSE excluded.sig END, synced_at = excluded.synced_at`);
  const now = Date.now();
  const stale: SonarrSeries[] = [];
  tx(cache, () => {
    for (const x of anime) {
      const p = prev.get(x.id);
      const sig = sigOf(x);
      const needs = full || !p || p.sig !== sig || now - p.synced_at > 86_400_000;
      if (needs) stale.push(x);
      const aids = byTvdb.get(x.tvdbId) ?? [];
      if (!aids.length) res.unmatched++;
      const poster = x.images?.find((i) => i.coverType === "poster")?.remoteUrl ?? null;
      upsertSeries.run(
        x.id,
        x.tvdbId,
        x.tmdbId ?? null,
        x.imdbId ?? null,
        x.title,
        x.sortTitle ?? null,
        x.year ?? null,
        x.status,
        x.seriesType,
        x.path,
        x.rootFolderPath ?? null,
        x.monitored ? 1 : 0,
        x.qualityProfileId,
        JSON.stringify(x.tags),
        x.network ?? null,
        x.runtime ?? null,
        x.originalLanguage?.name ?? null,
        JSON.stringify(
          x.seasons.map((z) => ({
            season: z.seasonNumber,
            monitored: z.monitored,
            files: z.statistics?.episodeFileCount ?? 0,
            episodes: z.statistics?.episodeCount ?? 0,
            total: z.statistics?.totalEpisodeCount ?? 0,
          })),
        ),
        x.firstAired ?? null,
        x.nextAiring ?? null,
        x.previousAiring ?? null,
        JSON.stringify(aids),
        aids.length ? "matched" : "review",
        poster,
        x.added ?? null,
        needs ? null : sig,
        (x as { overview?: string }).overview ?? null,
        JSON.stringify((x as { genres?: string[] }).genres ?? []),
        needs ? (p?.synced_at ?? 0) : p!.synced_at,
      );
      const sf = (x as { seasonFolder?: boolean }).seasonFolder;
      cache.prepare("UPDATE series SET season_folder = ? WHERE id = ?").run(typeof sf === "boolean" ? (sf ? 1 : 0) : null, x.id);
      cache.prepare("DELETE FROM alt_titles WHERE series_id = ?").run(x.id);
      for (const a of x.alternateTitles ?? []) {
        const season =
          a.sceneSeasonNumber !== undefined && a.sceneSeasonNumber !== null && a.sceneSeasonNumber >= 1 ? a.sceneSeasonNumber : null;
        cache
          .prepare("INSERT INTO alt_titles (series_id, title, key, season, scene_season) VALUES (?, ?, ?, ?, ?)")
          .run(x.id, a.title, compactKey(a.title), a.seasonNumber ?? null, season);
      }
    }
    // Series no longer in Sonarr (or no longer anime): see heldRemoval.
    const keep = new Set(anime.map((x) => x.id));
    const gone = [...prev.keys()].filter((id) => !keep.has(id));
    const held = heldRemoval(
      "Sonarr",
      "anime shows",
      prev.size,
      gone.length,
      full,
      tagMissing ? `Sonarr has no tag named "${s.sonarr.animeTag}" (Settings → Sonarr → anime tag)` : null,
    );
    if (held) res.errors.push(held);
    else {
      for (const id of gone) {
        res.removed++;
        for (const t of ["series WHERE id", "episodes WHERE series_id", "files WHERE series_id", "alt_titles WHERE series_id"])
          cache.prepare(`DELETE FROM ${t} = ?`).run(id);
      }
      markListRead("Sonarr", anime.length);
    }
  });

  let done = 0;
  await pool(stale, 4, async (x) => {
    try {
      await refreshSeriesEpisodes(x.id, sigOf(x));
      res.refreshed++;
    } catch (e) {
      res.errors.push(`${x.title}: ${(e as Error).message}`);
    }
    if (++done % 25 === 0) setJob("sync", "running", `Reading episodes ${done}/${stale.length}`);
  });
}

/**
 * Is this episode list shorter than Sonarr itself says the show is (review 2026-11-02, H11)? Sonarr's series record
 * counts every season's episodes (statistics.totalEpisodeCount, cached from the last series read); its episode list
 * should hold at least that many per season. When Sonarr really removes episodes those counts drop too, so a real
 * removal still applies. Without counts (an old Sonarr) a list shorter than the cached one can't be told from a half
 * answer, so it counts as short too. Returns what's missing, or null.
 * Checked against a live Sonarr (2026-11-02, read-only): over 772 series and 1,824 seasons, every season's
 * totalEpisodeCount equalled its /episode?seriesId rows exactly, specials included.
 */
function shortEpisodeList(seriesId: number, eps: { seasonNumber: number }[]): string | null {
  const row = cache.prepare("SELECT seasons FROM series WHERE id = ?").get(seriesId) as { seasons: string } | undefined;
  const seasons = (row ? (JSON.parse(row.seasons) as { season: number; total?: number }[]) : []).filter((s) => (s.total ?? 0) > 0);
  if (seasons.length) {
    repeatedShort.delete(seriesId);
    const got = new Map<number, number>();
    for (const e of eps) got.set(e.seasonNumber, (got.get(e.seasonNumber) ?? 0) + 1);
    const lacking = seasons.filter((s) => (got.get(s.season) ?? 0) < s.total!);
    return lacking.length ? lacking.map((s) => `season ${s.season}: ${got.get(s.season) ?? 0} of ${s.total}`).join(", ") : null;
  }
  const cached = (cache.prepare("SELECT COUNT(*) AS n FROM episodes WHERE series_id = ?").get(seriesId) as { n: number }).n;
  if (eps.length >= cached) {
    repeatedShort.delete(seriesId);
    return null;
  }
  // Review L4: with no counts, the same shorter list on several reads in a row is a real removal, not a half answer.
  const seen = repeatedShort.get(seriesId);
  const count = seen && seen.length === eps.length ? seen.count + 1 : 1;
  if (count >= SHORT_REPEATS_APPLY) {
    repeatedShort.delete(seriesId);
    return null;
  }
  repeatedShort.set(seriesId, { length: eps.length, count });
  return `${eps.length} episodes, ${cached} known`;
}

/** Without season counts: how many reads in a row came back with the same shorter list, per series (in memory). */
const repeatedShort = new Map<number, { length: number; count: number }>();
const SHORT_REPEATS_APPLY = 3;

/** Re-reads one series' episodes and files from Sonarr into the cache (after an import or a delete). */
export async function refreshSeriesEpisodes(seriesId: number, sig?: string) {
  if (isNativeSeriesId(seriesId)) return rematerializeSeries(seriesId);
  const [eps, files] = await Promise.all([getEpisodes(seriesId), getEpisodeFiles(seriesId)]);
  // Keep the cached episodes over a malformed or short answer: a dropped episode closes its managed search. A record
  // without an id would even become a made-up episode (SQLite numbers a NULL key itself). The files list may be empty.
  if (
    !Array.isArray(eps) ||
    !Array.isArray(files) ||
    eps.some((e) => !e || typeof e.id !== "number" || typeof e.seasonNumber !== "number" || typeof e.episodeNumber !== "number")
  )
    throw new Error("Sonarr's episode list came back malformed; kept the cached episodes");
  const short = shortEpisodeList(seriesId, eps);
  if (short) throw new Error(`Sonarr's episode list is short (${short}); kept the cached episodes, read again on the next sync`);
  tx(cache, () => {
    cache.prepare("DELETE FROM episodes WHERE series_id = ?").run(seriesId);
    cache.prepare("DELETE FROM files WHERE series_id = ?").run(seriesId);
    const ins =
      cache.prepare(`INSERT INTO episodes (id, series_id, season, episode, absolute, scene_season, scene_episode, scene_absolute, title, air_date, air_utc, runtime, monitored, has_file, file_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const e of eps)
      ins.run(
        e.id,
        seriesId,
        e.seasonNumber,
        e.episodeNumber,
        e.absoluteEpisodeNumber ?? null,
        e.sceneSeasonNumber ?? null,
        e.sceneEpisodeNumber ?? null,
        e.sceneAbsoluteEpisodeNumber ?? null,
        e.title ?? null,
        e.airDate ?? null,
        e.airDateUtc ? Date.parse(e.airDateUtc) : null,
        e.runtime ?? null,
        e.monitored ? 1 : 0,
        e.hasFile ? 1 : 0,
        e.episodeFileId || null,
      );
    const insF =
      cache.prepare(`INSERT INTO files (id, series_id, season, path, size, quality, source, release_group, scene_name, audio_langs, sub_langs, run_time, resolution, date_added, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const f of files)
      insF.run(
        f.id,
        seriesId,
        f.seasonNumber,
        f.path,
        f.size,
        f.quality?.quality?.name ?? null,
        f.quality?.quality?.source ?? null,
        f.releaseGroup ?? null,
        f.sceneName ?? null,
        langList(f.mediaInfo?.audioLanguages).join("/"),
        langList(f.mediaInfo?.subtitles).join("/"),
        f.mediaInfo?.runTime ?? null,
        f.mediaInfo?.resolution ?? null,
        f.dateAdded ?? null,
        JSON.stringify({
          version: f.quality?.revision?.version ?? 1,
          real: f.quality?.revision?.real ?? 0,
          isRepack: !!f.quality?.revision?.isRepack,
        }),
      );
    if (sig !== undefined) cache.prepare("UPDATE series SET sig = ?, synced_at = ? WHERE id = ?").run(sig, Date.now(), seriesId);
  });
}

async function syncRadarr(full: boolean, res: SyncResult) {
  const s = getSettings().radarr;
  const movies = await getMovies();
  // A malformed answer fails the sync and the cache stays, as for Sonarr.
  if (!Array.isArray(movies) || movies.some((m) => !m || typeof m.id !== "number" || typeof m.path !== "string"))
    throw new Error("Radarr's movie list came back malformed; kept the movies AnimeArr already had");
  const roots = s.animeRoots.map((r) => r.replace(/\/+$/, ""));
  const isAnime = (m: (typeof movies)[number]) =>
    roots.some((r) => m.rootFolderPath?.replace(/\/+$/, "") === r || m.path.startsWith(`${r}/`)) ||
    s.animeProfileIds.includes(m.qualityProfileId) ||
    (!roots.length && !s.animeProfileIds.length && (m.genres ?? []).includes("Animation") && m.originalLanguage?.name === "Japanese");
  let n = 0;
  let held: string | null = null;
  tx(cache, () => {
    // Movies no longer in Radarr go (native movies, added in AnimeArr, always stay); a mass removal waits, see heldRemoval.
    const keep = new Set(movies.map((m) => m.id));
    const prev = (cache.prepare(`SELECT id FROM movies WHERE id < ${NATIVE_BASE}`).all() as { id: number }[]).map((r) => r.id);
    const gone = prev.filter((id) => !keep.has(id));
    held = heldRemoval("Radarr", "movies", prev.length, gone.length, full, null);
    if (held) res.errors.push(held);
    else {
      for (const id of gone) cache.prepare("DELETE FROM movies WHERE id = ?").run(id);
      markListRead("Radarr", movies.length);
    }
    const ins =
      cache.prepare(`INSERT OR REPLACE INTO movies (id, tmdb_id, imdb_id, title, original_title, year, path, root_folder, monitored, has_file, runtime, quality_profile_id, tags, alt_titles, file, is_anime, poster, synced_at, status, is_available, in_cinemas, digital_release, physical_release, genres)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const ms = (d?: string) => (d && Number.isFinite(Date.parse(d)) ? Date.parse(d) : null);
    for (const m of movies) {
      const anime = isAnime(m);
      if (anime) n++;
      const mf = m.movieFile;
      const file = mf
        ? {
            path: mf.path ?? null,
            sceneName: mf.sceneName ?? null,
            releaseGroup: mf.releaseGroup ?? null,
            quality: mf.quality?.quality?.name ?? null,
            audio: langList(mf.mediaInfo?.audioLanguages),
            subs: langList(mf.mediaInfo?.subtitles),
            runTime: mf.mediaInfo?.runTime ?? null,
            resolution: mf.mediaInfo?.resolution ?? null,
          }
        : null;
      const poster =
        (m as { images?: { coverType: string; remoteUrl?: string }[] }).images?.find((i) => i.coverType === "poster")?.remoteUrl ?? null;
      ins.run(
        m.id,
        m.tmdbId ?? null,
        m.imdbId ?? null,
        m.title,
        m.originalTitle ?? null,
        m.year ?? null,
        m.path,
        m.rootFolderPath ?? null,
        m.monitored ? 1 : 0,
        m.hasFile ? 1 : 0,
        m.runtime ?? null,
        m.qualityProfileId,
        JSON.stringify(m.tags ?? []),
        JSON.stringify((m.alternateTitles ?? []).map((a) => a.title)),
        file ? JSON.stringify(file) : null,
        anime ? 1 : 0,
        poster,
        Date.now(),
        m.status ?? null,
        m.isAvailable ? 1 : 0,
        ms(m.inCinemas),
        ms(m.digitalRelease),
        ms(m.physicalRelease),
        JSON.stringify(m.genres ?? []),
      );
    }
  });
  // Multi-part movies AnimeArr imported: Radarr doesn't see stacked parts, so its "no file" doesn't count.
  for (const r of db.prepare("SELECT movie_id, file FROM movie_parts").all() as { movie_id: number; file: string }[]) {
    const parts = (JSON.parse(r.file) as { parts?: string[] }).parts ?? [];
    // Parts deleted or replaced (or Radarr has its own file now): the record goes, but only after an answer the sync
    // accepted. A held (suspect) answer never deletes it: the record is AnimeArr's own and can't be rebuilt. A part
    // counts as deleted only when that's certain: an unmounted or unreadable share keeps the record (and the file).
    const has = cache.prepare("SELECT has_file FROM movies WHERE id = ?").get(r.movie_id) as { has_file: number } | undefined;
    if (has?.has_file || !parts.length || parts.some((p) => fileSurelyGone(p))) {
      if (!held) db.prepare("DELETE FROM movie_parts WHERE movie_id = ?").run(r.movie_id);
      continue;
    }
    cache.prepare("UPDATE movies SET has_file = 1, file = ? WHERE id = ? AND has_file = 0").run(r.file, r.movie_id);
  }
  return n;
}

// ---------------------------------------------------------------- learning backfill (stage-1 language table)

/** Source key for the learned table: streaming service when named, else the quality source. */
export function sourceKey(sceneName: string | null, quality: string | null, qualitySource: string | null): string {
  const p = sceneName ? parseRelease(sceneName) : null;
  if (p?.platform) return p.platform;
  const q = `${qualitySource ?? ""} ${quality ?? ""}`.toLowerCase();
  if (/blu|bd/.test(q)) return "bluray";
  if (/web/.test(q)) return "web";
  if (/tv|hdtv/.test(q)) return "hdtv";
  if (/dvd/.test(q)) return "dvd";
  return "any";
}

/**
 * Rebuilds the "library" rows of group_langs from the files Sonarr already has: per (release group, source), how many
 * files carried each subtitle/audio language. Rows learned from verifications are kept separately and never replaced.
 */
export function backfillLearning() {
  const rows = cache.prepare("SELECT release_group, scene_name, quality, source, audio_langs, sub_langs FROM files").all() as {
    release_group: string | null;
    scene_name: string | null;
    quality: string | null;
    source: string | null;
    audio_langs: string;
    sub_langs: string;
  }[];
  const agg = new Map<string, { total: number; subs: Record<string, number>; audio: Record<string, number> }>();
  for (const r of rows) {
    const grp = (r.release_group || (r.scene_name ? parseRelease(r.scene_name).group : null) || "").toLowerCase();
    if (!grp) continue;
    const src = sourceKey(r.scene_name, r.quality, r.source);
    for (const key of [`${grp}\u0000${src}`, `${grp}\u0000*`]) {
      const a = agg.get(key) ?? { total: 0, subs: {}, audio: {} };
      a.total++;
      for (const l of r.sub_langs.split("/").filter(Boolean)) a.subs[l] = (a.subs[l] ?? 0) + 1;
      for (const l of r.audio_langs.split("/").filter(Boolean)) a.audio[l] = (a.audio[l] ?? 0) + 1;
      agg.set(key, a);
    }
  }
  tx(db, () => {
    db.prepare("DELETE FROM group_langs WHERE origin = 'library'").run();
    const ins = db.prepare(
      "INSERT INTO group_langs (grp, source, origin, total, subs, audio, updated_at) VALUES (?, ?, 'library', ?, ?, ?, ?)",
    );
    for (const [k, v] of agg) {
      const [grp, src] = k.split("\u0000");
      ins.run(grp, src, v.total, JSON.stringify(v.subs), JSON.stringify(v.audio), Date.now());
    }
  });
  return agg.size;
}

/** Records one verification result (stage 2 feedback into stage 1). */
export function learnFromVerify(group: string | null, source: string, subs: string[], audio: string[]) {
  const grp = (group ?? "").toLowerCase();
  if (!grp || dbState.corrupt) return;
  for (const src of [source, "*"]) {
    const row = db
      .prepare("SELECT total, subs, audio FROM group_langs WHERE grp = ? AND source = ? AND origin = 'verify'")
      .get(grp, src) as { total: number; subs: string; audio: string } | undefined;
    const s = JSON.parse(row?.subs ?? "{}") as Record<string, number>;
    const a = JSON.parse(row?.audio ?? "{}") as Record<string, number>;
    for (const l of new Set(subs)) s[l] = (s[l] ?? 0) + 1;
    for (const l of new Set(audio)) a[l] = (a[l] ?? 0) + 1;
    db.prepare(
      `INSERT INTO group_langs (grp, source, origin, total, subs, audio, updated_at) VALUES (?, ?, 'verify', ?, ?, ?, ?)
      ON CONFLICT(grp, source, origin) DO UPDATE SET total = excluded.total, subs = excluded.subs, audio = excluded.audio, updated_at = excluded.updated_at`,
    ).run(grp, src, (row?.total ?? 0) + 1, JSON.stringify(s), JSON.stringify(a), Date.now());
  }
}

/** Learned languages for a (group, source), combining library and verification counts; falls back to the group overall. */
export function learnedFor(
  group: string | null,
  source: string | null,
): { total: number; subs: Record<string, number>; audio: Record<string, number>; origin: string } | null {
  const grp = (group ?? "").toLowerCase();
  if (!grp) return null;
  for (const src of [source ?? "any", "*"]) {
    const rows = db.prepare("SELECT origin, total, subs, audio FROM group_langs WHERE grp = ? AND source = ?").all(grp, src) as {
      origin: string;
      total: number;
      subs: string;
      audio: string;
    }[];
    if (!rows.length) continue;
    const subs: Record<string, number> = {};
    const audio: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      total += r.total;
      for (const [l, n] of Object.entries(JSON.parse(r.subs) as Record<string, number>)) subs[l] = (subs[l] ?? 0) + n;
      for (const [l, n] of Object.entries(JSON.parse(r.audio) as Record<string, number>)) audio[l] = (audio[l] ?? 0) + n;
    }
    if (total >= 3)
      return { total, subs, audio, origin: rows.map((r) => (r.origin === "verify" ? "verified" : "in your library")).join(" + ") };
  }
  return null;
}

export function lastSync() {
  return (cache.prepare("SELECT MAX(synced_at) AS at FROM series").get() as { at: number | null }).at;
}
