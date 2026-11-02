/**
 * A Sonarr v3-compatible API (`/api/v3/...`), so request apps that only speak Sonarr (Jellyseerr, Overseerr) can use
 * AnimeArr as their Sonarr server. Only the endpoints those apps call, answered from AnimeArr's own library:
 *
 * - Shows are the library's series (native ones and, while Sonarr still owns some, Sonarr's). Ids are AnimeArr's own
 *   series ids; movies aren't served (there's no Radarr side).
 * - "Monitored" means managed by AnimeArr; a season is monitored when the show's monitoring scope covers it. Requested
 *   seasons become a "picked seasons" scope (Shows → scope shows them).
 * - Adding a show is a native Add (TVDB id → AniList entry through Anime-Lists), managed, live unless practice mode.
 * - Writes never touch Sonarr: a Sonarr-owned show's scope and tags can change, but it can't be deleted here.
 * - DELETE removes a native show from AnimeArr only. Files are never deleted, whatever deleteFiles says.
 * - Commands: MissingEpisodeSearch / SeriesSearch / EpisodeSearch run AnimeArr's own search (dry run and budgets
 *   apply); refresh and rescan commands are accepted and do nothing (AnimeArr refreshes on its own schedule).
 */
import { langName } from "./core/rank.js";
import { CATEGORY_NAME, CATEGORY_QUALITIES, goalCategory, sonarrQualityName, goalLabel, LADDER, ladderRank, type Category } from "./core/quality.js";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { autoSearchEpisodes, searchMissingNow } from "./autosearch.js";
import { deepSearch } from "./search.js";
import { removeGrab, startGrab } from "./pipeline.js";
import { backupNow } from "./db.js";
import { rssTick } from "./managed.js";
import { scanFolder } from "./mediafiles.js";
import { registerSonarrMore } from "./sonarrApiMore.js";
import { compactKey } from "./core/normalize.js";
import { fribb } from "./covers.js";
import { allRows, cache, db, dbState } from "./db.js";
import { refuseDropped } from "./dropped.js";
import { setManaged } from "./managed.js";
import { mediaByIds } from "./anilist.js";
import { animeListEntries } from "./metadata.js";
import { addShow, NATIVE_BASE, removeShow, searchAdd } from "./native.js";
import { mappedPath } from "./paths.js";
import { profileFor, setSeriesPrefs } from "./profiles.js";
import { queueView } from "./queue.js";
import { scopedEpisodeIds, scopeFor, setScope, type Scope } from "./scope.js";
import { getSettings, type LanguageProfile } from "./settings.js";
import { bulkTags, clearTags, createTag, deleteTag, renameTag, setTags, tagRows, tagsOf } from "./tags.js";
import { VERSION } from "./version.js";

/** What the API reaches outside the database (tests swap these). */
export interface SonarrApiDeps {
  media: typeof mediaByIds;
  fribb: typeof fribb;
  searchTitles: typeof searchAdd;
  queue: () => ReturnType<typeof queueView>;
  searchMissing: typeof searchMissingNow;
  searchEpisodes: typeof autoSearchEpisodes;
  /** Interactive search, the manual grab and the queue removal (tests swap them for fakes). */
  deepSearch: typeof deepSearch;
  startGrab: typeof startGrab;
  removeGrab: typeof removeGrab;
  /** Commands: rescan a show folder, check the RSS feeds now, take a backup. */
  rescan: (folder: string) => Promise<unknown>;
  rssSync: () => Promise<unknown>;
  backup: () => string | null;
}
const realDeps: SonarrApiDeps = { media: mediaByIds, fribb, searchTitles: searchAdd, queue: () => queueView(), searchMissing: searchMissingNow, searchEpisodes: autoSearchEpisodes, deepSearch, startGrab, removeGrab, rescan: (f) => scanFolder(f), rssSync: () => rssTick(), backup: () => backupNow("manual") };

export const fail = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
export const writable = () => {
  if (dbState.corrupt) throw fail("The database failed its integrity check, so AnimeArr is read-only", 503);
};
export const int = (v: unknown, what = "id") => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw fail(`Bad ${what}`);
  return n;
};
export const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
export const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---------------------------------------------------------------- stable numeric ids

/**
 * Numeric ids for things AnimeArr keys by name (profiles by their string id, root folders by path). Handed out once
 * and kept, so an id a request app stored keeps meaning the same thing (renames and reordering don't shift them).
 */
export function apiId(kind: "profile" | "root", key: string): number {
  const hit = db.prepare("SELECT id FROM api_ids WHERE kind = ? AND key = ?").get(kind, key) as { id: number } | undefined;
  if (hit) return hit.id;
  const next = ((db.prepare("SELECT MAX(id) AS m FROM api_ids WHERE kind = ?").get(kind) as { m: number | null }).m ?? 0) + 1;
  db.prepare("INSERT INTO api_ids (kind, key, id) VALUES (?, ?, ?)").run(kind, key, next);
  return next;
}
const keyOf = (kind: "profile" | "root", id: number) => (db.prepare("SELECT key FROM api_ids WHERE kind = ? AND id = ?").get(kind, id) as { key: string } | undefined)?.key ?? null;

/** Sonarr's own quality ids, so request apps show the qualities they know. */
export const SONARR_QUALITY_IDS: Record<string, { id: number; source: string; resolution: number }> = {
  Unknown: { id: 0, source: "unknown", resolution: 0 },
  SDTV: { id: 1, source: "television", resolution: 480 },
  DVD: { id: 2, source: "dvd", resolution: 480 },
  "WEBDL-1080p": { id: 3, source: "web", resolution: 1080 },
  "HDTV-720p": { id: 4, source: "television", resolution: 720 },
  "WEBDL-720p": { id: 5, source: "web", resolution: 720 },
  "Bluray-720p": { id: 6, source: "bluray", resolution: 720 },
  "Bluray-1080p": { id: 7, source: "bluray", resolution: 1080 },
  "WEBDL-480p": { id: 8, source: "web", resolution: 480 },
  "HDTV-1080p": { id: 9, source: "television", resolution: 1080 },
  "WEBRip-480p": { id: 12, source: "webRip", resolution: 480 },
  "Bluray-480p": { id: 13, source: "bluray", resolution: 480 },
  "WEBRip-720p": { id: 14, source: "webRip", resolution: 720 },
  "WEBRip-1080p": { id: 15, source: "webRip", resolution: 1080 },
  "HDTV-2160p": { id: 16, source: "television", resolution: 2160 },
  "WEBRip-2160p": { id: 17, source: "webRip", resolution: 2160 },
  "WEBDL-2160p": { id: 18, source: "web", resolution: 2160 },
  "Bluray-2160p": { id: 19, source: "bluray", resolution: 2160 },
  "Bluray-1080p Remux": { id: 20, source: "blurayRaw", resolution: 1080 },
  "Bluray-2160p Remux": { id: 21, source: "blurayRaw", resolution: 2160 },
};
/** A quality category as one of Sonarr's quality groups (ids from 1000, by ladder position). */
const categoryItem = (c: Category, allowed: boolean) => ({
  id: 1000 + ladderRank(c),
  name: CATEGORY_NAME[c],
  allowed,
  items: CATEGORY_QUALITIES[c].filter((n) => SONARR_QUALITY_IDS[n]).map((n) => ({ quality: { id: SONARR_QUALITY_IDS[n].id, name: n, source: SONARR_QUALITY_IDS[n].source, resolution: SONARR_QUALITY_IDS[n].resolution }, items: [], allowed })),
});

/**
 * A profile as Sonarr's quality profile. The one place a profile is described to request apps: its name carries the
 * quality goal ("English subs: Aim high (Bluray 1080p)"), the items are AnimeArr's quality categories (worst first,
 * like Sonarr) and the cutoff is the goal's category. The numeric id never changes.
 */
export function profileResource(p: LanguageProfile) {
  const goal = p.qualityGoal ?? "high";
  const target = goalCategory(goal, p.resolution);
  const items = LADDER.filter((c) => c !== "unknown").map((c) => categoryItem(c, !c.endsWith("2160") || p.resolution >= 2160));
  return { id: apiId("profile", p.id), name: `${p.name}: ${goalLabel(goal)}`, upgradeAllowed: (getSettings().qualityUpgrade?.mode ?? "auto") !== "off", cutoff: 1000 + ladderRank(target), items, minFormatScore: 0, cutoffFormatScore: 0, formatItems: [] };
}
const profileByApiId = (id: unknown) => {
  const key = Number.isInteger(Number(id)) ? keyOf("profile", Number(id)) : null;
  return key ? (getSettings().profiles.find((p) => p.id === key) ?? null) : null;
};

// ---------------------------------------------------------------- tags

// The real tags (server/tags.ts): the ones set in Settings → Tags are what request apps see.
const seriesTags = (tvdbId: number) => tagsOf("series", tvdbId);
const setSeriesTags = (tvdbId: number, tags: unknown) => void setTags("series", tvdbId, tags);

// ---------------------------------------------------------------- shows

export interface SeriesRow { id: number; tvdb_id: number; imdb_id: string | null; title: string; sort_title: string | null; year: number | null; status: string | null; path: string | null; root_folder: string | null; network: string | null; runtime: number | null; first_aired: string | null; poster: string | null; added: string | null; overview: string | null; genres: string; previous_airing: string | null; next_airing: string | null }

export const isManaged = (tvdbId: number) => !!db.prepare("SELECT 1 FROM managed WHERE tvdb_id = ?").get(tvdbId);

/** The seasons AnimeArr searches for a managed show (its scope); none for a show it doesn't manage. */
function monitoredSeasons(s: { id: number; tvdb_id: number }, now = Date.now()): Set<number> {
  if (!isManaged(s.tvdb_id)) return new Set();
  const ids = scopedEpisodeIds(s.tvdb_id, s.id, now);
  const eps = cache.prepare("SELECT id, season FROM episodes WHERE series_id = ?").all(s.id) as { id: number; season: number }[];
  return new Set(eps.filter((e) => ids.has(e.id)).map((e) => e.season));
}

interface SeasonStats { season: number; total: number; aired: number; files: number; size: number }
function seasonStats(seriesId: number, now = Date.now()): SeasonStats[] {
  const rows = cache
    .prepare("SELECT season, COUNT(*) AS total, SUM(CASE WHEN has_file = 1 OR (air_utc IS NOT NULL AND air_utc <= ?) THEN 1 ELSE 0 END) AS aired, SUM(has_file) AS files FROM episodes WHERE series_id = ? GROUP BY season ORDER BY season")
    .all(now, seriesId) as { season: number; total: number; aired: number; files: number }[];
  const sizes = new Map((cache.prepare("SELECT season, SUM(size) AS size FROM files WHERE series_id = ? GROUP BY season").all(seriesId) as { season: number; size: number | null }[]).map((r) => [r.season, r.size ?? 0]));
  return rows.map((r) => ({ ...r, files: r.files ?? 0, aired: r.aired ?? 0, size: sizes.get(r.season) ?? 0 }));
}

const stats = (files: number, aired: number, total: number, size: number) => ({ episodeFileCount: files, episodeCount: aired, totalEpisodeCount: total, sizeOnDisk: size, percentOfEpisodes: aired ? (files / aired) * 100 : 0 });
const images = (poster: string | null) => (poster && /^https?:\/\//.test(poster) ? [{ coverType: "poster", url: poster, remoteUrl: poster }] : []);

/** A library show as a Sonarr series resource. */
export function seriesResource(s: SeriesRow, now = Date.now()) {
  const st = seasonStats(s.id, now);
  const mon = monitoredSeasons(s, now);
  const sum = st.filter((x) => x.season > 0).reduce((a, x) => ({ files: a.files + x.files, aired: a.aired + x.aired, total: a.total + x.total, size: a.size + x.size }), { files: 0, aired: 0, total: 0, size: 0 });
  const poster = s.poster && /^https?:\/\//.test(s.poster) ? s.poster : null;
  return {
    id: s.id,
    title: s.title,
    sortTitle: s.sort_title ?? s.title.toLowerCase(),
    alternateTitles: [] as unknown[],
    status: s.status ?? "continuing",
    ended: s.status === "ended",
    overview: s.overview ?? "",
    network: s.network ?? "",
    airTime: undefined,
    originalLanguage: { id: 8, name: "Japanese" },
    images: images(poster),
    remotePoster: poster,
    seasons: st.map((x) => ({ seasonNumber: x.season, monitored: mon.has(x.season), images: [] as unknown[], statistics: { previousAiring: undefined, ...stats(x.files, x.aired, x.total, x.size) } })),
    year: s.year ?? 0,
    path: s.path ?? "",
    rootFolderPath: s.root_folder ?? "",
    qualityProfileId: apiId("profile", profileFor(s.tvdb_id).id),
    languageProfileId: 1,
    seasonFolder: true,
    monitored: isManaged(s.tvdb_id),
    monitorNewItems: "all",
    useSceneNumbering: false,
    runtime: s.runtime ?? 0,
    tvdbId: s.tvdb_id >= NATIVE_BASE ? 0 : s.tvdb_id, // a synthetic id isn't a TVDB id
    tvRageId: 0,
    tvMazeId: 0,
    tmdbId: 0,
    firstAired: s.first_aired ?? undefined,
    lastAired: s.previous_airing ?? undefined,
    previousAiring: s.previous_airing ?? undefined,
    nextAiring: s.next_airing ?? undefined,
    seriesType: "anime",
    cleanTitle: compactKey(s.title),
    imdbId: s.imdb_id ?? "",
    titleSlug: slug(s.title),
    folder: (s.path ?? "").split("/").filter(Boolean).pop() ?? "",
    certification: "",
    genres: JSON.parse(s.genres || "[]") as string[],
    tags: seriesTags(s.tvdb_id),
    added: s.added ?? new Date(0).toISOString(),
    ratings: { votes: 0, value: 0 },
    episodesChanged: false,
    statistics: { seasonCount: st.filter((x) => x.season > 0).length, ...stats(sum.files, sum.aired, sum.total, sum.size), releaseGroups: [] as string[] },
  };
}

export const SERIES_COLS = "id, tvdb_id, imdb_id, title, sort_title, year, status, path, root_folder, network, runtime, first_aired, poster, added, overview, genres, previous_airing, next_airing";
export const seriesById = (id: number) => cache.prepare(`SELECT ${SERIES_COLS} FROM series WHERE id = ?`).get(id) as SeriesRow | undefined;
export const seriesByTvdb = (tvdbId: number) => cache.prepare(`SELECT ${SERIES_COLS} FROM series WHERE tvdb_id = ? ORDER BY id LIMIT 1`).get(tvdbId) as SeriesRow | undefined;
export const mustSeries = (id: number) => seriesById(id) ?? (() => { throw fail("Series not found", 404); })();

/** The AniList entry that stands for a TVDB series (its first numbered season), from the catalog or Anime-Lists. */
export async function anilistForTvdb(tvdbId: number, d: Pick<SonarrApiDeps, "fribb"> = realDeps): Promise<number | null> {
  const e = db.prepare("SELECT anilist_id FROM entries WHERE tvdb_id = ? AND tvdb_season IS NOT NULL AND tvdb_season != '0' ORDER BY start_date IS NULL, start_date LIMIT 1").get(tvdbId) as { anilist_id: number } | undefined;
  if (e) return e.anilist_id;
  const f = await d.fribb();
  const rank = (s: number | "a" | null) => (s === "a" ? 1 : (s ?? 999));
  const hit = [...animeListEntries().values()].filter((x) => x.tvdbId === tvdbId && x.defaultSeason !== 0 && f.anidbToAnilist.has(x.aid)).sort((a, b) => rank(a.defaultSeason) - rank(b.defaultSeason) || a.aid - b.aid)[0];
  return hit ? f.anidbToAnilist.get(hit.aid)! : null;
}

/** The seasons Anime-Lists numbers a TVDB series in (what a request app may ask for before the show is added). */
function mappedSeasons(tvdbId: number): number[] {
  const s = new Set<number>();
  for (const x of animeListEntries().values()) if (x.tvdbId === tvdbId && x.defaultSeason !== null && x.defaultSeason !== 0) s.add(x.defaultSeason === "a" ? 1 : x.defaultSeason);
  for (const r of db.prepare("SELECT DISTINCT tvdb_season FROM entries WHERE tvdb_id = ? AND tvdb_season IS NOT NULL AND tvdb_season != '0'").all(tvdbId) as { tvdb_season: string }[]) s.add(r.tvdb_season === "a" ? 1 : Number(r.tvdb_season));
  return s.size ? [...s].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b) : [1];
}

/** A show that isn't in the library yet, as a lookup result (no id: request apps then POST it). */
function lookupResource(tvdbId: number, info: { title: string; year: number | null; cover: string | null; status: string | null; overview?: string | null }) {
  const status = info.status === "FINISHED" || info.status === "CANCELLED" ? "ended" : info.status === "NOT_YET_RELEASED" ? "upcoming" : "continuing";
  return {
    title: info.title, sortTitle: info.title.toLowerCase(), status, ended: status === "ended", overview: info.overview ?? "", network: "", images: images(info.cover), remotePoster: info.cover,
    seasons: mappedSeasons(tvdbId).map((n) => ({ seasonNumber: n, monitored: false })), year: info.year ?? 0, qualityProfileId: 0, languageProfileId: 0, seasonFolder: true, monitored: false,
    monitorNewItems: "all", useSceneNumbering: false, runtime: 0, tvdbId, tvRageId: 0, tvMazeId: 0, seriesType: "anime", cleanTitle: compactKey(info.title), imdbId: "", titleSlug: slug(info.title),
    certification: "", genres: [] as string[], tags: [] as number[], added: "0001-01-01T00:00:00Z", ratings: { votes: 0, value: 0 },
    statistics: { seasonCount: 0, episodeFileCount: 0, episodeCount: 0, totalEpisodeCount: 0, sizeOnDisk: 0, percentOfEpisodes: 0, releaseGroups: [] as string[] },
  };
}

/** Lookup by "tvdb:123" or by title. */
async function lookup(term: string, d: SonarrApiDeps) {
  const m = /^tvdb:\s*(\d+)$/i.exec(term.trim());
  if (m) {
    const tvdbId = Number(m[1]);
    const lib = seriesByTvdb(tvdbId);
    if (lib) return [seriesResource(lib)];
    const al = await anilistForTvdb(tvdbId, d);
    if (!al) return [];
    const e = db.prepare("SELECT title_english, title_romaji, season_year, cover, status, description FROM entries WHERE anilist_id = ?").get(al) as { title_english: string | null; title_romaji: string | null; season_year: number | null; cover: string | null; status: string | null; description: string | null } | undefined;
    const name = [...animeListEntries().values()].find((x) => x.tvdbId === tvdbId)?.name ?? `TVDB ${tvdbId}`;
    return [lookupResource(tvdbId, { title: e?.title_english ?? e?.title_romaji ?? name, year: e?.season_year ?? null, cover: e?.cover ?? null, status: e?.status ?? null, overview: e?.description })];
  }
  const { results } = await d.searchTitles(term);
  const out: unknown[] = [];
  const seen = new Set<number>();
  for (const r of results) {
    if (!r.tvdbId || r.kind === "MOVIE" || seen.has(r.tvdbId)) continue;
    seen.add(r.tvdbId);
    const lib = seriesByTvdb(r.tvdbId);
    out.push(lib ? seriesResource(lib) : lookupResource(r.tvdbId, { title: r.title, year: r.year, cover: r.cover, status: r.status }));
  }
  return out;
}

/** Monitors exactly these seasons (a "picked seasons" scope); none = nothing searched. Keeps the episode mode. */
function applySeasons(tvdbId: number, seasons: number[]) {
  const cur = scopeFor(tvdbId);
  const status = (cache.prepare("SELECT status FROM series WHERE tvdb_id = ?").get(tvdbId) as { status: string | null } | undefined)?.status;
  const fallback = (status === "ended" ? getSettings().scope.ended : getSettings().scope.continuing).episodes;
  const episodes = cur.episodes === "none" ? fallback : cur.episodes;
  const picked = [...new Set(seasons)].sort((a, b) => a - b);
  const next: Scope = picked.length
    ? { seasons: "picked", picked, recentN: cur.recentN, episodes, specials: picked.includes(0) || cur.specials, creditless: cur.creditless }
    : { seasons: "all", recentN: cur.recentN, episodes: "none", specials: false, creditless: cur.creditless };
  setScope([tvdbId], next);
}

const monitoredOf = (seasons: unknown) => (Array.isArray(seasons) ? seasons.filter((x) => x && (x as { monitored?: unknown }).monitored === true).map((x) => Number((x as { seasonNumber: unknown }).seasonNumber)).filter((n) => Number.isInteger(n) && n >= 0) : null);

// ---------------------------------------------------------------- episodes

export interface EpRow { id: number; series_id: number; season: number; episode: number; absolute: number | null; title: string | null; air_date: string | null; air_utc: number | null; has_file: number; file_id: number | null; runtime: number | null }
export const EP_COLS = "id, series_id, season, episode, absolute, title, air_date, air_utc, has_file, file_id, runtime";
export function episodeResources(rows: EpRow[], now = Date.now()) {
  const scoped = new Map<number, Set<number>>();
  const inScope = (r: EpRow) => {
    if (!scoped.has(r.series_id)) {
      const s = seriesById(r.series_id);
      scoped.set(r.series_id, s && isManaged(s.tvdb_id) ? scopedEpisodeIds(s.tvdb_id, s.id, now) : new Set());
    }
    return scoped.get(r.series_id)!.has(r.id);
  };
  return rows.map((r) => ({
    id: r.id, seriesId: r.series_id, tvdbId: 0, episodeFileId: r.file_id ?? 0, seasonNumber: r.season, episodeNumber: r.episode, title: r.title ?? "TBA", airDate: r.air_date ?? undefined,
    airDateUtc: iso(r.air_utc) ?? undefined, overview: "", hasFile: !!r.has_file, runtime: r.runtime ?? 0, grabbed: false, monitored: inScope(r), absoluteEpisodeNumber: r.absolute ?? undefined, unverifiedSceneNumbering: false,
  }));
}

// ---------------------------------------------------------------- qualities and languages

/** Sonarr language ids for the languages AnimeArr names (others are 0, "Unknown"). */
const SONARR_LANGUAGES: Record<string, number> = { en: 1, fr: 2, es: 3, de: 4, it: 5, nl: 7, ja: 8, zh: 10, ru: 11, pl: 12, vi: 13, sv: 14, no: 15, fi: 16, tr: 17, pt: 18, el: 20, ko: 21, hu: 22, he: 23, cs: 25, hi: 26, ro: 27, th: 28, "pt-br": 30, ar: 31, uk: 32, id: 44 };
export const languageResource = (code: string) => ({ id: SONARR_LANGUAGES[code.toLowerCase()] ?? 0, name: SONARR_LANGUAGES[code.toLowerCase()] ? langName(code.toLowerCase()) : "Unknown" });
export const allLanguages = () => Object.keys(SONARR_LANGUAGES).map(languageResource);
/** A quality as Sonarr writes it, from its name ("WEBDL-1080p") or, for a release title, what AnimeArr reads from it. */
export function qualityByName(name: string | null | undefined, revision: { version?: number; real?: number; isRepack?: boolean } = {}) {
  const q = SONARR_QUALITY_IDS[name ?? ""] ?? SONARR_QUALITY_IDS.Unknown;
  const n = SONARR_QUALITY_IDS[name ?? ""] ? name! : "Unknown";
  return { quality: { id: q.id, name: n, source: q.source, resolution: q.resolution }, revision: { version: revision.version ?? 1, real: revision.real ?? 0, isRepack: !!revision.isRepack } };
}
export const qualityResource = (release: string) => qualityByName(sonarrQualityName(release, null), { isRepack: /\brepack\b/i.test(release), version: /\bv(\d)\b/i.test(release) ? Number(/\bv(\d)\b/i.exec(release)![1]) : 1 });

// ---------------------------------------------------------------- queue

const hms = (sec: number | null | undefined) => {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return undefined;
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** AnimeArr's active downloads as Sonarr queue records: one per episode, like Sonarr's queue. */
export async function queueRecords(d: Pick<SonarrApiDeps, "queue"> = realDeps, opts: { includeEpisode?: boolean; includeSeries?: boolean } = {}, now = Date.now()) {
  const { items } = await d.queue();
  const out: Record<string, unknown>[] = [];
  for (const g of items) {
    if (g.movieId || !g.tvdbId) continue; // movies have no Sonarr side
    const s = seriesByTvdb(g.tvdbId);
    if (!s) continue;
    const row = db.prepare("SELECT client_ref, indexer, at FROM grabs WHERE id = ?").get(g.id) as { client_ref: string | null; indexer: string | null; at: number } | undefined;
    const quality = qualityResource(g.release);
    const live = g.live as { state?: string; progress?: number; etaSec?: number | null; sizeBytes?: number | null } | null;
    const progress = live?.progress ?? g.progress ?? 0;
    const size = live?.sizeBytes ?? 0;
    const importing = g.state === "importing" || g.state === "needs-attention" || live?.state === "completed";
    const failed = live?.state === "failed" || live?.state === "error" || live?.state === "missing";
    const status = importing ? "completed" : g.state === "sending" || live?.state === "queued" ? "queued" : failed ? "warning" : "downloading";
    const trackedDownloadState = g.state === "needs-attention" ? "importPending" : importing ? "importing" : failed ? "failedPending" : "downloading";
    const trackedDownloadStatus = g.state === "needs-attention" || failed ? "warning" : "ok";
    const eps = g.episodeIds.length ? allRows<EpRow>(cache.prepare(`SELECT ${EP_COLS} FROM episodes WHERE id IN (${g.episodeIds.map(() => "?").join(",")})`), ...g.episodeIds) : [];
    const epRes = episodeResources(eps, now);
    for (const [i, e] of eps.entries()) {
      out.push({
        id: g.id * 1000 + i, seriesId: s.id, episodeId: e.id, seasonNumber: e.season, title: g.release, size, sizeleft: Math.max(0, size * (1 - progress)), timeleft: hms(live?.etaSec),
        estimatedCompletionTime: live?.etaSec ? iso(now + live.etaSec * 1000) : undefined, status, trackedDownloadStatus, trackedDownloadState,
        statusMessages: g.error ? [{ title: g.release, messages: [g.error] }] : [], errorMessage: g.error ?? undefined, downloadId: row?.client_ref ?? String(g.id), protocol: g.protocol,
        downloadClient: g.clientName, downloadClientHasPostImportCategory: false, indexer: row?.indexer ?? "", outputPath: undefined, quality, languages: [languageResource("ja")], customFormats: [] as unknown[], customFormatScore: 0, added: iso(row?.at) ?? undefined, episodeHasFile: !!e.has_file,
        ...(opts.includeEpisode ? { episode: epRes[i] } : {}),
        ...(opts.includeSeries ? { series: seriesResource(s, now) } : {}),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- commands

interface CommandRes { id: number; name: string; commandName: string; status: string; result: string; queued: string; started?: string; ended?: string; trigger: string; priority: string; message?: string; body: Record<string, unknown>; sendUpdatesToClient: boolean; updateScheduledTask: boolean }
const commands = new Map<number, CommandRes>();
let nextCommand = 1;

/** Marks a command that is still running as finished (or failed) when its work settles, so clients polling it see it end. */
function settle(c: CommandRes, work: Promise<unknown>) {
  c.status = "started";
  c.result = "unknown";
  c.ended = undefined;
  void work.then(
    () => Object.assign(c, { status: "completed", result: "successful", ended: new Date().toISOString() }),
    (e: Error) => Object.assign(c, { status: "failed", result: "unsuccessful", message: e.message, ended: new Date().toISOString() }),
  );
}
const seasonEpisodeIds = (seriesId: number, season: number, now: number) => {
  const rows = cache.prepare("SELECT id, has_file, air_utc FROM episodes WHERE series_id = ? AND season = ?").all(seriesId, season) as { id: number; has_file: number; air_utc: number | null }[];
  const missing = rows.filter((r) => !r.has_file && r.air_utc !== null && r.air_utc <= now);
  return (missing.length ? missing : rows.filter((r) => !r.has_file)).map((r) => r.id);
};

async function runCommand(body: Record<string, unknown>, d: SonarrApiDeps): Promise<CommandRes> {
  const name = String(body.name ?? "");
  const now = new Date().toISOString();
  const c: CommandRes = { id: nextCommand++, name, commandName: name, status: "completed", result: "successful", queued: now, started: now, ended: now, trigger: "manual", priority: "normal", body, sendUpdatesToClient: true, updateScheduledTask: true };
  if (name === "MissingEpisodeSearch" || (name === "SeriesSearch" && body.seriesId)) {
    const s = mustSeries(int(body.seriesId, "seriesId"));
    const r = d.searchMissing(s.tvdb_id, s.title);
    c.message = r.queued ? `${r.missing} missing episodes went to the fill-in queue` : `Searching ${r.searching} missing episodes`;
  } else if (name === "SeasonSearch") {
    const s = mustSeries(int(body.seriesId, "seriesId"));
    const season = Number(body.seasonNumber);
    if (!Number.isInteger(season) || season < 0) throw fail("Bad seasonNumber");
    const ids = seasonEpisodeIds(s.id, season, Date.now());
    if (ids.length) settle(c, d.searchEpisodes(s.tvdb_id, ids));
    c.message = `Searching ${ids.length} episodes of season ${season}`;
  } else if (name === "EpisodeSearch") {
    const ids = (Array.isArray(body.episodeIds) ? body.episodeIds : []).map((x) => int(x, "episode id"));
    const bySeries = new Map<number, number[]>();
    for (const e of ids.length ? (cache.prepare(`SELECT id, series_id FROM episodes WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as { id: number; series_id: number }[]) : []) bySeries.set(e.series_id, [...(bySeries.get(e.series_id) ?? []), e.id]);
    const jobs: Promise<unknown>[] = [];
    for (const [sid, eps] of bySeries) {
      const s = mustSeries(sid);
      jobs.push(d.searchEpisodes(s.tvdb_id, eps.slice(0, 26))); // outcomes land in Activity
    }
    settle(c, Promise.all(jobs));
    c.message = `Searching ${ids.length} episodes`;
  } else if (name === "RescanSeries" || name === "RefreshSeries") {
    // A rescan re-reads the show folder; AnimeArr refreshes metadata on its own schedule.
    if (body.seriesId && name === "RescanSeries") {
      const s = mustSeries(int(body.seriesId, "seriesId"));
      if (s.path) settle(c, d.rescan(s.path));
    }
    c.message = name === "RescanSeries" ? "Rescanning the show folder" : "AnimeArr refreshes metadata on its own schedule";
  } else if (/^(Refresh|Rescan)Monitored/.test(name)) {
    c.message = "AnimeArr refreshes and rescans on its own schedule";
  } else if (name === "RssSync") {
    settle(c, d.rssSync());
    c.message = "Checking the indexers' newest releases";
  } else if (name === "Backup") {
    const file = d.backup();
    c.message = file ? `Backup saved as ${file}` : "The backup could not be made";
    if (!file) Object.assign(c, { status: "failed", result: "unsuccessful" });
  } else if (name === "RenameSeries" || name === "RenameFiles") {
    c.message = "AnimeArr renames only when you confirm it on the show's page (Rename)";
  } else {
    throw fail(`AnimeArr doesn't run the Sonarr command "${name}"`);
  }
  commands.set(c.id, c);
  if (commands.size > 100) commands.delete(commands.keys().next().value!);
  return c;
}

// ---------------------------------------------------------------- routes

/** A view of a query object whose keys are found in any case (an exact match wins). */
export function caseInsensitive<T extends Record<string, unknown>>(q: T): T {
  const lower = new Map(Object.keys(q).map((k) => [k.toLowerCase(), k]));
  return new Proxy(q, {
    get: (t, k) => (typeof k !== "string" || k in t ? Reflect.get(t, k) : Reflect.get(t, lower.get(k.toLowerCase()) ?? k)),
    has: (t, k) => (typeof k !== "string" ? Reflect.has(t, k) : k in t || lower.has(k.toLowerCase())),
  });
}

export function registerSonarrApi(app: FastifyInstance, opts: { urlBase: string; deps?: Partial<SonarrApiDeps> }) {
  const d: SonarrApiDeps = { ...realDeps, ...opts.deps };
  const started = new Date().toISOString();
  const V = "/api/v3";

  // Sonarr (ASP.NET) binds query names in any case: seriesID, SeriesId and seriesId are the same parameter. Every
  // handler here reads the camelCase name, so the query is looked up case-insensitively on these routes.
  app.addHook("preHandler", async (req) => {
    if (!req.routeOptions.url?.startsWith(`${V}/`)) return;
    const q = req.query as Record<string, unknown> | undefined;
    if (q && typeof q === "object") req.query = caseInsensitive(q);
  });

  // Sonarr 4 on the wire (no language profiles asked for); AnimeArr's own version rides along.
  app.get(`${V}/system/status`, async () => ({
    appName: "AnimeArr", instanceName: "AnimeArr", version: "4.0.0.0", animeArrVersion: VERSION, buildTime: started, isDebug: false, isProduction: true, isAdmin: false, isUserInteractive: false,
    startupPath: "/app", appData: "/config", osName: process.platform, osVersion: "", isNetCore: false, isMono: false, isLinux: process.platform === "linux", isOsx: process.platform === "darwin",
    isWindows: process.platform === "win32", isDocker: fs.existsSync("/.dockerenv"), mode: "console", branch: "main", authentication: "forms", sqliteVersion: "", migrationVersion: 0,
    urlBase: opts.urlBase, runtimeVersion: process.versions.node, runtimeName: "node", startTime: started, packageUpdateMechanism: "docker",
  }));

  app.get(`${V}/qualityprofile`, async () => getSettings().profiles.map(profileResource));
  app.get<{ Params: { id: string } }>(`${V}/qualityprofile/:id`, async (req) => {
    const p = profileByApiId(req.params.id);
    if (!p) throw fail("Profile not found", 404);
    return profileResource(p);
  });
  // Sonarr 3's language profiles: AnimeArr's languages live in its profiles, so there's one catch-all.
  app.get(`${V}/languageprofile`, async () => [{ id: 1, name: "AnimeArr profile languages", upgradeAllowed: false, cutoff: { id: 1, name: "English" }, languages: allLanguages().map((l) => ({ language: l, allowed: true })) }]);
  app.get(`${V}/language`, async () => allLanguages());
  app.get<{ Params: { id: string } }>(`${V}/language/:id`, async (req) => allLanguages().find((l) => l.id === Number(req.params.id)) ?? (() => { throw fail("Language not found", 404); })());

  app.get(`${V}/rootfolder`, async () =>
    getSettings().allowedRoots.map((p) => {
      let freeSpace = 0;
      let totalSpace = 0;
      try {
        const st = fs.statfsSync(mappedPath(p));
        freeSpace = st.bavail * st.bsize;
        totalSpace = st.blocks * st.bsize;
      } catch {
        /* unmounted: reported as 0 */
      }
      return { id: apiId("root", p), path: p, accessible: totalSpace > 0, freeSpace, totalSpace, unmappedFolders: [] };
    }),
  );

  app.get(`${V}/tag`, async () => tagRows());
  app.get<{ Params: { id: string } }>(`${V}/tag/:id`, async (req) => tagRows().find((t) => t.id === int(req.params.id)) ?? (() => { throw fail("Tag not found", 404); })());
  app.post<{ Body: { label?: string } }>(`${V}/tag`, async (req, reply) => {
    writable();
    reply.code(201);
    return createTag(req.body?.label);
  });
  app.put<{ Params: { id: string }; Body: { label?: string } }>(`${V}/tag/:id`, async (req, reply) => {
    writable();
    reply.code(202);
    return renameTag(int(req.params.id), req.body?.label);
  });
  app.delete<{ Params: { id: string } }>(`${V}/tag/:id`, async (req) => {
    writable();
    if (tagRows().some((t) => t.id === int(req.params.id))) deleteTag(int(req.params.id));
    return {};
  });

  app.get<{ Querystring: { tvdbId?: string } }>(`${V}/series`, async (req) => {
    const rows = req.query.tvdbId ? allRows<SeriesRow>(cache.prepare(`SELECT ${SERIES_COLS} FROM series WHERE tvdb_id = ?`), int(req.query.tvdbId, "tvdbId")) : allRows<SeriesRow>(cache.prepare(`SELECT ${SERIES_COLS} FROM series ORDER BY sort_title`));
    const now = Date.now();
    return rows.map((s) => seriesResource(s, now));
  });
  app.get<{ Querystring: { term?: string } }>(`${V}/series/lookup`, async (req) => lookup(String(req.query.term ?? ""), d));
  app.get<{ Params: { id: string } }>(`${V}/series/:id`, async (req) => seriesResource(mustSeries(int(req.params.id))));

  // Add: a native show, managed (live unless practice mode), with the requested seasons and profile.
  app.post<{ Body: Record<string, unknown> }>(`${V}/series`, async (req, reply) => {
    writable();
    const b = req.body ?? {};
    const tvdbId = int(b.tvdbId, "tvdbId");
    refuseDropped(tvdbId);
    if (seriesByTvdb(tvdbId)) throw fail("This series has already been added", 400);
    const anilistId = await anilistForTvdb(tvdbId, d);
    if (!anilistId) throw fail(`AnimeArr's anime mappings (Anime-Lists) don't know TVDB ${tvdbId}; AnimeArr only adds anime`, 404);
    const added = await addShow({ anilistId, rootFolder: String(b.rootFolderPath ?? "") }, { media: d.media, fribb: d.fribb });
    const profile = profileByApiId(b.qualityProfileId);
    if (profile) setSeriesPrefs(added.tvdbId, profile.id, null);
    const seasons = monitoredOf(b.seasons);
    if (seasons) applySeasons(added.tvdbId, seasons);
    setSeriesTags(added.tvdbId, b.tags);
    if (b.monitored !== false) setManaged([added.tvdbId], true, { live: true });
    const opt = (b.addOptions ?? {}) as { searchForMissingEpisodes?: boolean };
    if (opt.searchForMissingEpisodes && b.monitored !== false) d.searchMissing(added.tvdbId, added.title);
    reply.code(201);
    return seriesResource(seriesByTvdb(added.tvdbId)!);
  });

  // Edit: season monitoring (the scope), tags, and managing a show that wasn't. Never written to Sonarr.
  const edit = async (idParam: unknown, b: Record<string, unknown>) => {
    writable();
    const s = mustSeries(int(idParam));
    const seasons = monitoredOf(b.seasons);
    if (seasons) applySeasons(s.tvdb_id, seasons);
    if (b.tags !== undefined) setSeriesTags(s.tvdb_id, b.tags);
    if (b.monitored === true && !isManaged(s.tvdb_id)) setManaged([s.tvdb_id], true, { live: true });
    const profile = b.qualityProfileId !== undefined ? profileByApiId(b.qualityProfileId) : null;
    if (profile && profile.id !== profileFor(s.tvdb_id).id) setSeriesPrefs(s.tvdb_id, profile.id, null);
    return seriesResource(mustSeries(s.id));
  };
  // Bulk edit (nzb360 / LunaSea "series editor"): monitoring, profile and tags, mapped onto AnimeArr's own. Nothing
  // that moves or deletes files: deleteFiles and moveFiles are refused, and so is a different root folder.
  app.put<{ Body: Record<string, unknown> }>(`${V}/series/editor`, async (req, reply) => {
    writable();
    const b = req.body ?? {};
    if (b.deleteFiles === true) throw fail("AnimeArr never deletes files through the API", 400);
    if (b.moveFiles === true) throw fail("AnimeArr doesn't move shows' files through the API; do it in AnimeArr", 400);
    if (!Array.isArray(b.seriesIds) || !b.seriesIds.length) throw fail("Pass seriesIds", 400);
    const rows = b.seriesIds.map((x) => mustSeries(int(x, "series id")));
    const root = typeof b.rootFolderPath === "string" && b.rootFolderPath.trim() ? b.rootFolderPath.trim().replace(/\/+$/, "") : null;
    if (root && rows.some((s) => (s.root_folder ?? "").replace(/\/+$/, "") !== root)) throw fail("AnimeArr doesn't change a show's root folder through the API (that would move its files); do it in AnimeArr", 400);
    const profile = b.qualityProfileId !== undefined ? profileByApiId(b.qualityProfileId) : null;
    if (b.qualityProfileId !== undefined && !profile) throw fail("Profile not found", 404);
    const tags = Array.isArray(b.tags) ? b.tags.map((x) => int(x, "tag id")) : null;
    const how = String(b.applyTags ?? "add").toLowerCase();
    if (tags && !["add", "remove", "replace"].includes(how)) throw fail("applyTags is add, remove or replace", 400);
    const tvdbIds = rows.map((s) => s.tvdb_id);
    if (b.monitored === true || b.monitored === false) setManaged(tvdbIds, b.monitored, { live: true }); // "unmonitored" = not managed; files stay
    for (const s of rows) {
      if (profile && profile.id !== profileFor(s.tvdb_id).id) setSeriesPrefs(s.tvdb_id, profile.id, null);
      if (tags && how === "replace") setSeriesTags(s.tvdb_id, tags);
    }
    if (tags && how !== "replace") bulkTags("series", tvdbIds, how === "add" ? tags : [], how === "remove" ? tags : []);
    reply.code(202);
    return rows.map((s) => seriesResource(mustSeries(s.id)));
  });
  app.put<{ Body: Record<string, unknown> }>(`${V}/series`, async (req, reply) => {
    reply.code(202);
    return edit(req.body?.id, req.body ?? {});
  });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(`${V}/series/:id`, async (req, reply) => {
    reply.code(202);
    return edit(req.params.id, req.body ?? {});
  });

  // Remove: native shows only, and never their files (deleteFiles is ignored on purpose).
  app.delete<{ Params: { id: string } }>(`${V}/series/:id`, async (req) => {
    writable();
    const s = mustSeries(int(req.params.id));
    if (s.id < NATIVE_BASE) throw fail("This show still belongs to Sonarr (AnimeArr runs next to it); remove it in Sonarr", 409);
    removeShow(s.tvdb_id);
    clearTags("series", s.tvdb_id);
    return {};
  });

  app.get<{ Querystring: { seriesId?: string; episodeIds?: string | string[] } }>(`${V}/episode`, async (req) => {
    const q = req.query;
    if (q.seriesId) return episodeResources(allRows<EpRow>(cache.prepare(`SELECT ${EP_COLS} FROM episodes WHERE series_id = ? ORDER BY season, episode`), int(q.seriesId, "seriesId")));
    const ids = (Array.isArray(q.episodeIds) ? q.episodeIds : String(q.episodeIds ?? "").split(",")).filter(Boolean).map((x) => int(x, "episode id"));
    if (!ids.length) throw fail("Pass seriesId or episodeIds");
    return episodeResources(allRows<EpRow>(cache.prepare(`SELECT ${EP_COLS} FROM episodes WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY season, episode`), ...ids));
  });
  app.get<{ Params: { id: string } }>(`${V}/episode/:id`, async (req) => {
    const r = cache.prepare(`SELECT ${EP_COLS} FROM episodes WHERE id = ?`).get(int(req.params.id)) as EpRow | undefined;
    if (!r) throw fail("Episode not found", 404);
    return episodeResources([r])[0];
  });
  // Monitoring works per season in AnimeArr: monitoring an episode monitors its season; a season is unmonitored
  // when all of its episodes are.
  app.put<{ Body: { episodeIds?: unknown[]; monitored?: boolean } }>(`${V}/episode/monitor`, async (req, reply) => {
    writable();
    const ids = (req.body?.episodeIds ?? []).map((x) => int(x, "episode id"));
    const want = req.body?.monitored !== false;
    const rows = ids.length ? allRows<EpRow>(cache.prepare(`SELECT ${EP_COLS} FROM episodes WHERE id IN (${ids.map(() => "?").join(",")})`), ...ids) : [];
    for (const sid of new Set(rows.map((r) => r.series_id))) {
      const s = mustSeries(sid);
      const mine = rows.filter((r) => r.series_id === sid);
      const seasons = monitoredSeasons(s);
      if (want) for (const r of mine) seasons.add(r.season);
      else
        for (const season of new Set(mine.map((r) => r.season))) {
          const all = (cache.prepare("SELECT id FROM episodes WHERE series_id = ? AND season = ?").all(sid, season) as { id: number }[]).map((r) => r.id);
          if (all.every((x) => ids.includes(x))) seasons.delete(season);
        }
      applySeasons(s.tvdb_id, [...seasons]);
      if (want && !isManaged(s.tvdb_id)) setManaged([s.tvdb_id], true, { live: true });
    }
    reply.code(202);
    return episodeResources(rows);
  });

  registerSonarrMore(app, d);

  app.post<{ Body: Record<string, unknown> }>(`${V}/command`, async (req, reply) => {
    writable();
    reply.code(201);
    return runCommand(req.body ?? {}, d);
  });
  app.get(`${V}/command`, async () => [...commands.values()]);
  app.get<{ Params: { id: string } }>(`${V}/command/:id`, async (req) => commands.get(int(req.params.id)) ?? (() => { throw fail("Command not found", 404); })());
}
