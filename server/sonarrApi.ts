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
import { CATEGORY_NAME, CATEGORY_QUALITIES, goalCategory, goalLabel, LADDER, ladderRank, type Category } from "./core/quality.js";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { autoSearchEpisodes, searchMissingNow } from "./autosearch.js";
import { compactKey } from "./core/normalize.js";
import { fribb } from "./covers.js";
import { cache, db, dbState, tx } from "./db.js";
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
import { VERSION } from "./version.js";

/** What the API reaches outside the database (tests swap these). */
export interface SonarrApiDeps {
  media: typeof mediaByIds;
  fribb: typeof fribb;
  searchTitles: typeof searchAdd;
  queue: () => ReturnType<typeof queueView>;
  searchMissing: typeof searchMissingNow;
  searchEpisodes: typeof autoSearchEpisodes;
}
const realDeps: SonarrApiDeps = { media: mediaByIds, fribb, searchTitles: searchAdd, queue: () => queueView(), searchMissing: searchMissingNow, searchEpisodes: autoSearchEpisodes };

const fail = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const writable = () => {
  if (dbState.corrupt) throw fail("The database failed its integrity check, so AnimeArr is read-only", 503);
};
const int = (v: unknown, what = "id") => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw fail(`Bad ${what}`);
  return n;
};
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

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
const SONARR_QUALITY_IDS: Record<string, { id: number; source: string; resolution: number }> = {
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

const normLabel = (v: unknown) => String(v ?? "").trim().toLowerCase();
const tagRows = () => db.prepare("SELECT id, label FROM api_tags ORDER BY id").all() as { id: number; label: string }[];
const seriesTags = (tvdbId: number) => (db.prepare("SELECT tag_id FROM api_series_tags WHERE tvdb_id = ? ORDER BY tag_id").all(tvdbId) as { tag_id: number }[]).map((r) => r.tag_id);
function setSeriesTags(tvdbId: number, tags: unknown) {
  if (!Array.isArray(tags)) return;
  const known = new Set(tagRows().map((t) => t.id));
  tx(db, () => {
    db.prepare("DELETE FROM api_series_tags WHERE tvdb_id = ?").run(tvdbId);
    for (const t of new Set(tags.map(Number))) if (known.has(t)) db.prepare("INSERT INTO api_series_tags (tvdb_id, tag_id) VALUES (?, ?)").run(tvdbId, t);
  });
}

// ---------------------------------------------------------------- shows

interface SeriesRow { id: number; tvdb_id: number; imdb_id: string | null; title: string; sort_title: string | null; year: number | null; status: string | null; path: string | null; root_folder: string | null; network: string | null; runtime: number | null; first_aired: string | null; poster: string | null; added: string | null; overview: string | null; genres: string; previous_airing: string | null; next_airing: string | null }

const isManaged = (tvdbId: number) => !!db.prepare("SELECT 1 FROM managed WHERE tvdb_id = ?").get(tvdbId);

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
    status: s.status ?? "continuing",
    ended: s.status === "ended",
    overview: s.overview ?? "",
    network: s.network ?? "",
    images: images(poster),
    remotePoster: poster,
    seasons: st.map((x) => ({ seasonNumber: x.season, monitored: mon.has(x.season), statistics: { previousAiring: undefined, ...stats(x.files, x.aired, x.total, x.size) } })),
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
    firstAired: s.first_aired ?? undefined,
    previousAiring: s.previous_airing ?? undefined,
    nextAiring: s.next_airing ?? undefined,
    seriesType: "anime",
    cleanTitle: compactKey(s.title),
    imdbId: s.imdb_id ?? "",
    titleSlug: slug(s.title),
    certification: "",
    genres: JSON.parse(s.genres || "[]") as string[],
    tags: seriesTags(s.tvdb_id),
    added: s.added ?? new Date(0).toISOString(),
    ratings: { votes: 0, value: 0 },
    statistics: { seasonCount: st.filter((x) => x.season > 0).length, ...stats(sum.files, sum.aired, sum.total, sum.size), releaseGroups: [] as string[] },
  };
}

const SERIES_COLS = "id, tvdb_id, imdb_id, title, sort_title, year, status, path, root_folder, network, runtime, first_aired, poster, added, overview, genres, previous_airing, next_airing";
const seriesById = (id: number) => cache.prepare(`SELECT ${SERIES_COLS} FROM series WHERE id = ?`).get(id) as SeriesRow | undefined;
const seriesByTvdb = (tvdbId: number) => cache.prepare(`SELECT ${SERIES_COLS} FROM series WHERE tvdb_id = ? ORDER BY id LIMIT 1`).get(tvdbId) as SeriesRow | undefined;
const mustSeries = (id: number) => seriesById(id) ?? (() => { throw fail("Series not found", 404); })();

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

interface EpRow { id: number; series_id: number; season: number; episode: number; absolute: number | null; title: string | null; air_date: string | null; air_utc: number | null; has_file: number; file_id: number | null }
const EP_COLS = "id, series_id, season, episode, absolute, title, air_date, air_utc, has_file, file_id";
function episodeResources(rows: EpRow[], now = Date.now()) {
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
    airDateUtc: iso(r.air_utc) ?? undefined, overview: "", hasFile: !!r.has_file, monitored: inScope(r), absoluteEpisodeNumber: r.absolute ?? undefined, unverifiedSceneNumbering: false,
  }));
}

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
    const row = db.prepare("SELECT client_ref FROM grabs WHERE id = ?").get(g.id) as { client_ref: string | null } | undefined;
    const live = g.live as { state?: string; progress?: number; etaSec?: number | null; sizeBytes?: number | null } | null;
    const progress = live?.progress ?? g.progress ?? 0;
    const size = live?.sizeBytes ?? 0;
    const importing = g.state === "importing" || g.state === "needs-attention" || live?.state === "completed";
    const failed = live?.state === "failed" || live?.state === "error" || live?.state === "missing";
    const status = importing ? "completed" : g.state === "sending" || live?.state === "queued" ? "queued" : failed ? "warning" : "downloading";
    const trackedDownloadState = g.state === "needs-attention" ? "importPending" : importing ? "importing" : failed ? "failedPending" : "downloading";
    const trackedDownloadStatus = g.state === "needs-attention" || failed ? "warning" : "ok";
    const eps = g.episodeIds.length ? (cache.prepare(`SELECT ${EP_COLS} FROM episodes WHERE id IN (${g.episodeIds.map(() => "?").join(",")})`).all(...g.episodeIds) as unknown as EpRow[]) : [];
    const epRes = episodeResources(eps, now);
    for (const [i, e] of eps.entries()) {
      out.push({
        id: g.id * 1000 + i, seriesId: s.id, episodeId: e.id, seasonNumber: e.season, title: g.release, size, sizeleft: Math.max(0, size * (1 - progress)), timeleft: hms(live?.etaSec),
        estimatedCompletionTime: live?.etaSec ? iso(now + live.etaSec * 1000) : undefined, status, trackedDownloadStatus, trackedDownloadState,
        statusMessages: g.error ? [{ title: g.release, messages: [g.error] }] : [], errorMessage: g.error ?? undefined, downloadId: row?.client_ref ?? String(g.id), protocol: g.protocol,
        downloadClient: g.clientName, indexer: "", outputPath: undefined,
        ...(opts.includeEpisode ? { episode: epRes[i] } : {}),
        ...(opts.includeSeries ? { series: seriesResource(s, now) } : {}),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- commands

interface CommandRes { id: number; name: string; commandName: string; status: string; queued: string; started?: string; ended?: string; trigger: string; message?: string; body: Record<string, unknown> }
const commands = new Map<number, CommandRes>();
let nextCommand = 1;

async function runCommand(body: Record<string, unknown>, d: SonarrApiDeps): Promise<CommandRes> {
  const name = String(body.name ?? "");
  const now = new Date().toISOString();
  const c: CommandRes = { id: nextCommand++, name, commandName: name, status: "completed", queued: now, started: now, ended: now, trigger: "manual", body };
  if (name === "MissingEpisodeSearch" || name === "SeriesSearch") {
    const s = mustSeries(int(body.seriesId, "seriesId"));
    const r = d.searchMissing(s.tvdb_id, s.title);
    c.message = r.queued ? `${r.missing} missing episodes went to the fill-in queue` : `Searching ${r.searching} missing episodes`;
  } else if (name === "EpisodeSearch") {
    const ids = (Array.isArray(body.episodeIds) ? body.episodeIds : []).map((x) => int(x, "episode id"));
    const bySeries = new Map<number, number[]>();
    for (const e of ids.length ? (cache.prepare(`SELECT id, series_id FROM episodes WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as { id: number; series_id: number }[]) : []) bySeries.set(e.series_id, [...(bySeries.get(e.series_id) ?? []), e.id]);
    for (const [sid, eps] of bySeries) {
      const s = mustSeries(sid);
      void d.searchEpisodes(s.tvdb_id, eps.slice(0, 26)).catch(() => undefined); // outcomes land in Activity
    }
    c.status = "started";
    c.message = `Searching ${ids.length} episodes`;
  } else if (/^(Refresh|Rescan)(Series|Monitored)?/.test(name)) {
    c.message = "AnimeArr refreshes and rescans on its own schedule";
  } else {
    throw fail(`AnimeArr doesn't run the Sonarr command "${name}"`);
  }
  commands.set(c.id, c);
  if (commands.size > 100) commands.delete(commands.keys().next().value!);
  return c;
}

// ---------------------------------------------------------------- routes

export function registerSonarrApi(app: FastifyInstance, opts: { urlBase: string; deps?: Partial<SonarrApiDeps> }) {
  const d: SonarrApiDeps = { ...realDeps, ...opts.deps };
  const started = new Date().toISOString();
  const V = "/api/v3";

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
  app.get(`${V}/languageprofile`, async () => [{ id: 1, name: "AnimeArr profile languages", upgradeAllowed: false, cutoff: { id: 1, name: "Any" }, languages: [] }]);

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
    const label = normLabel(req.body?.label);
    if (!label) throw fail("A tag needs a label");
    db.prepare("INSERT OR IGNORE INTO api_tags (label) VALUES (?)").run(label);
    reply.code(201);
    return db.prepare("SELECT id, label FROM api_tags WHERE label = ?").get(label);
  });
  app.put<{ Params: { id: string }; Body: { label?: string } }>(`${V}/tag/:id`, async (req, reply) => {
    writable();
    const label = normLabel(req.body?.label);
    if (!label) throw fail("A tag needs a label");
    const r = db.prepare("UPDATE api_tags SET label = ? WHERE id = ?").run(label, int(req.params.id));
    if (!r.changes) throw fail("Tag not found", 404);
    reply.code(202);
    return { id: int(req.params.id), label };
  });
  app.delete<{ Params: { id: string } }>(`${V}/tag/:id`, async (req) => {
    writable();
    tx(db, () => {
      db.prepare("DELETE FROM api_series_tags WHERE tag_id = ?").run(int(req.params.id));
      db.prepare("DELETE FROM api_tags WHERE id = ?").run(int(req.params.id));
    });
    return {};
  });

  app.get<{ Querystring: { tvdbId?: string } }>(`${V}/series`, async (req) => {
    const rows = req.query.tvdbId ? (cache.prepare(`SELECT ${SERIES_COLS} FROM series WHERE tvdb_id = ?`).all(int(req.query.tvdbId, "tvdbId")) as unknown as SeriesRow[]) : (cache.prepare(`SELECT ${SERIES_COLS} FROM series ORDER BY sort_title`).all() as unknown as SeriesRow[]);
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
    db.prepare("DELETE FROM api_series_tags WHERE tvdb_id = ?").run(s.tvdb_id);
    return {};
  });

  app.get<{ Querystring: { seriesId?: string; episodeIds?: string | string[] } }>(`${V}/episode`, async (req) => {
    const q = req.query;
    if (q.seriesId) return episodeResources(cache.prepare(`SELECT ${EP_COLS} FROM episodes WHERE series_id = ? ORDER BY season, episode`).all(int(q.seriesId, "seriesId")) as unknown as EpRow[]);
    const ids = (Array.isArray(q.episodeIds) ? q.episodeIds : String(q.episodeIds ?? "").split(",")).filter(Boolean).map((x) => int(x, "episode id"));
    if (!ids.length) throw fail("Pass seriesId or episodeIds");
    return episodeResources(cache.prepare(`SELECT ${EP_COLS} FROM episodes WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY season, episode`).all(...ids) as unknown as EpRow[]);
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
    const rows = ids.length ? (cache.prepare(`SELECT ${EP_COLS} FROM episodes WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as unknown as EpRow[]) : [];
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

  app.get<{ Querystring: { page?: string; pageSize?: string; includeEpisode?: string; includeSeries?: string } }>(`${V}/queue`, async (req) => {
    const q = req.query;
    const all = await queueRecords(d, { includeEpisode: q.includeEpisode === "true", includeSeries: q.includeSeries === "true" });
    const page = Math.max(1, Number(q.page) || 1);
    // Sonarr's default page is 10 records; AnimeArr returns the whole queue unless a page size is asked for.
    const size = Math.max(1, Number(q.pageSize) || all.length || 1);
    return { page, pageSize: size, sortKey: "timeleft", sortDirection: "ascending", totalRecords: all.length, records: all.slice((page - 1) * size, page * size) };
  });

  app.post<{ Body: Record<string, unknown> }>(`${V}/command`, async (req, reply) => {
    writable();
    reply.code(201);
    return runCommand(req.body ?? {}, d);
  });
  app.get(`${V}/command`, async () => [...commands.values()]);
  app.get<{ Params: { id: string } }>(`${V}/command/:id`, async (req) => commands.get(int(req.params.id)) ?? (() => { throw fail("Command not found", 404); })());
}
