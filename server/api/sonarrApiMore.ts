/**
 * The rest of the Sonarr v3-compatible API (see sonarrApi.ts), for dashboard and mobile clients (nzb360, LunaSea,
 * Homepage): health, disk space, calendar, queue (paged, details, status, remove/blocklist), history, wanted
 * (missing and cutoff unmet), episode files (read only), and interactive search with grabbing a release.
 *
 * - History comes from AnimeArr's own grabs (grabbed, imported, failed) and the delete lines in Activity. Renames
 *   aren't recorded as events, so there are no episodeFileRenamed records.
 * - Removing a queue item always removes it from the download client (AnimeArr only removes its own downloads).
 * - Episode files can't be deleted here (405): AnimeArr deletes files only from its own pages, with a confirm.
 * - Release search is AnimeArr's Deep Search; a grab goes through the normal grab path (safety checks, client
 *   choice, practice mode). Search results are kept for 30 minutes so the POST can find the release by its guid.
 */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { listDecisions } from "../system/activity.js";
import { langList } from "../core/langs.js";
import { cache, db, dbState } from "../system/db.js";
import { breakerList } from "../search/health.js";
import { recordFor } from "../import/mediafiles.js";
import { mappedPath } from "../system/paths.js";
import { type Candidate, type GrabRow } from "../grabs/pipelineState.js";
import { upgradeUnits } from "../search/qualityUpgrade.js";
import type { SearchResult } from "../search/search.js";
import { scopedEpisodeIds } from "../library/scope.js";
import { getSettings } from "../system/settings.js";
import {
  EP_COLS,
  episodeResources,
  fail,
  int,
  isManaged,
  iso,
  languageResource,
  mustSeries,
  qualityByName,
  qualityResource,
  queueRecords,
  SERIES_COLS,
  seriesById,
  seriesResource,
  writable,
  type EpRow,
  type SeriesRow,
  type SonarrApiDeps,
} from "./sonarrResources.js";

const qs = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? "") : v === undefined ? "" : String(v));
const flag = (v: unknown, dflt = false) => (v === undefined || v === "" ? dflt : String(v).toLowerCase() === "true");
const ids = (v: unknown) =>
  (Array.isArray(v) ? v : String(v ?? "").split(",")).filter((x) => x !== "" && x !== undefined).map((x) => int(x));

/** Sonarr's paging envelope: page and pageSize come from the client (Sonarr's default is 10 records). */
function paged<T>(q: Record<string, unknown>, all: T[], sortKey: string, sortDirection: string, dflt = 10) {
  const page = Math.max(1, Number(q.page) || 1);
  const size = Math.max(1, Math.min(1000, Number(q.pageSize) || dflt));
  return { page, pageSize: size, sortKey, sortDirection, totalRecords: all.length, records: all.slice((page - 1) * size, page * size) };
}
const dir = (q: Record<string, unknown>, dflt: "ascending" | "descending") =>
  /^desc/i.test(qs(q.sortDirection)) ? "descending" : /^asc/i.test(qs(q.sortDirection)) ? "ascending" : dflt;
const sorted = <T>(rows: T[], key: (r: T) => number | string, direction: string) =>
  [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * (direction === "ascending" ? 1 : -1));

// ---------------------------------------------------------------- episode files

interface FileRow {
  id: number;
  series_id: number;
  season: number | null;
  path: string;
  size: number | null;
  quality: string | null;
  release_group: string | null;
  scene_name: string | null;
  audio_langs: string;
  sub_langs: string;
  run_time: string | null;
  resolution: string | null;
  date_added: string | null;
  revision: string | null;
}
const FILE_COLS =
  "id, series_id, season, path, size, quality, release_group, scene_name, audio_langs, sub_langs, run_time, resolution, date_added, revision";
const ISO3: Record<string, string> = {
  en: "eng",
  ja: "jpn",
  zh: "chi",
  es: "spa",
  pt: "por",
  fr: "fre",
  de: "ger",
  it: "ita",
  ru: "rus",
  ar: "ara",
  ko: "kor",
  id: "ind",
  th: "tha",
  vi: "vie",
};
const iso3 = (codes: string[]) => codes.map((c) => ISO3[c] ?? c).join("/");

/** An episode file as a Sonarr resource: AnimeArr's own scan fills the media info, the Sonarr-synced columns fill the rest. */
export function fileResource(f: FileRow) {
  const series = seriesById(f.series_id);
  const base = (series?.path ?? "").replace(/\/+$/, "");
  const rec = recordFor(f.path, f.size);
  const audio = langList(f.audio_langs);
  const subs = langList(f.sub_langs);
  const rev = (() => {
    try {
      return JSON.parse(f.revision ?? "{}") as { version?: number; real?: number; isRepack?: boolean };
    } catch {
      return {};
    }
  })();
  const height = rec?.video?.height ?? null;
  return {
    id: f.id,
    seriesId: f.series_id,
    seasonNumber: f.season ?? 0,
    relativePath: base && f.path.startsWith(`${base}/`) ? f.path.slice(base.length + 1) : path.posix.basename(f.path),
    path: f.path,
    size: f.size ?? 0,
    dateAdded: f.date_added ?? iso(0),
    sceneName: f.scene_name ?? undefined,
    releaseGroup: f.release_group ?? undefined,
    languages: (audio.length ? audio : ["ja"]).map(languageResource),
    quality: qualityByName(f.quality, rev),
    customFormats: [] as unknown[],
    customFormatScore: 0,
    indexerFlags: 0,
    releaseType: "unknown",
    mediaInfo: {
      id: f.id,
      audioBitrate: 0,
      audioChannels: rec?.audio[0]?.channels ?? 0,
      audioCodec: rec?.audio[0]?.codec ?? "",
      audioLanguages: iso3(audio),
      audioStreamCount: rec?.audio.length ?? audio.length,
      videoBitDepth: rec?.video?.bitDepth ?? 8,
      videoBitrate: 0,
      videoCodec: rec?.video?.codec ?? "",
      videoFps: 0,
      videoDynamicRange: rec?.video?.hdr ? "HDR" : "",
      videoDynamicRangeType: rec?.video?.hdr ? "HDR" : "",
      resolution: rec?.video?.width && height ? `${rec.video.width}x${height}` : (f.resolution ?? ""),
      runTime: f.run_time ?? "",
      scanType: "Progressive",
      subtitles: iso3(subs),
    },
    qualityCutoffNotMet: false,
  };
}
const fileRows = (where: string, ...args: unknown[]) =>
  cache.prepare(`SELECT ${FILE_COLS} FROM files WHERE ${where}`).all(...(args as never[])) as unknown as FileRow[];

// ---------------------------------------------------------------- history

const EVENT_TYPES: Record<string, number> = {
  grabbed: 1,
  seriesFolderImported: 2,
  downloadFolderImported: 3,
  downloadFailed: 4,
  episodeFileDeleted: 5,
  episodeFileRenamed: 6,
  downloadIgnored: 7,
};
interface HistEvent {
  id: number;
  type: string;
  at: number;
  seriesId: number;
  episodeId: number;
  release: string;
  downloadId: string | null;
  data: Record<string, string>;
}

/** Sonarr history events from AnimeArr's grabs and deletes, newest first. Ids are stable: grab id x type, or Activity id x episode. */
function historyEvents(opts: { seriesId?: number; seasonNumber?: number; episodeId?: number; eventType?: number } = {}): HistEvent[] {
  const out: HistEvent[] = [];
  const grabs = db
    .prepare("SELECT * FROM grabs WHERE dry_run = 0 AND movie_id IS NULL AND series_id IS NOT NULL ORDER BY id DESC LIMIT 2000")
    .all() as unknown as GrabRow[];
  const add = (g: GrabRow, kind: number, type: string, at: number, extra: Record<string, string> = {}) => {
    (JSON.parse(g.episode_ids) as number[]).slice(0, 255).forEach((episodeId, i) => {
      out.push({
        id: (g.id * 3 + kind) * 2 * 256 + i,
        type,
        at,
        seriesId: g.series_id,
        episodeId,
        release: g.release,
        downloadId: g.client_ref,
        data: { indexer: g.indexer ?? "", downloadClient: g.client ?? "", ...extra },
      });
    });
  };
  for (const g of grabs) {
    add(g, 0, "grabbed", g.at);
    if (g.state === "done") add(g, 1, "downloadFolderImported", g.updated_at);
    else if (g.state === "failed") add(g, 2, "downloadFailed", g.updated_at, { message: g.error ?? "" });
  }
  for (const d of listDecisions({ kinds: ["info"], limit: 500 })) {
    const det = d.detail as { kind?: string; path?: string };
    if (det?.kind !== "delete" || !d.tvdbId) continue;
    const s = cache.prepare("SELECT id FROM series WHERE tvdb_id = ?").get(d.tvdbId) as { id: number } | undefined;
    if (!s) continue;
    d.episodeIds.slice(0, 255).forEach((episodeId, i) =>
      out.push({
        id: (d.id * 2 + 1) * 256 + i,
        type: "episodeFileDeleted",
        at: d.at,
        seriesId: s.id,
        episodeId,
        release: d.release ?? path.posix.basename(det.path ?? ""),
        downloadId: null,
        data: { reason: "Manual" },
      }),
    );
  }
  const season = opts.seasonNumber;
  const seasonOf = new Map<number, number>();
  const seasonFor = (e: number) =>
    seasonOf.has(e)
      ? seasonOf.get(e)!
      : (seasonOf.set(
          e,
          (cache.prepare("SELECT season FROM episodes WHERE id = ?").get(e) as { season: number } | undefined)?.season ?? -1,
        ),
        seasonOf.get(e)!);
  return out
    .filter(
      (e) =>
        (!opts.seriesId || e.seriesId === opts.seriesId) &&
        (!opts.episodeId || e.episodeId === opts.episodeId) &&
        (!opts.eventType || EVENT_TYPES[e.type] === opts.eventType) &&
        (season === undefined || seasonFor(e.episodeId) === season),
    )
    .sort((a, b) => b.at - a.at || b.id - a.id);
}

function historyRecord(e: HistEvent, inc: { series: boolean; episode: boolean }, now: number) {
  const ep = cache.prepare(`SELECT ${EP_COLS} FROM episodes WHERE id = ?`).get(e.episodeId) as EpRow | undefined;
  const s = inc.series ? seriesById(e.seriesId) : undefined;
  return {
    id: e.id,
    episodeId: e.episodeId,
    seriesId: e.seriesId,
    sourceTitle: e.release,
    languages: [languageResource("ja")],
    quality: qualityResource(e.release),
    customFormats: [] as unknown[],
    customFormatScore: 0,
    qualityCutoffNotMet: false,
    date: iso(e.at),
    downloadId: e.downloadId ?? undefined,
    eventType: e.type,
    data: e.data,
    ...(inc.episode && ep ? { episode: episodeResources([ep], now)[0] } : {}),
    ...(s ? { series: seriesResource(s, now) } : {}),
  };
}

// ---------------------------------------------------------------- wanted

/** Episodes aired, without a file, that AnimeArr searches for (the show's monitoring scope). `monitored=false` lists every aired one. */
function missingRows(monitoredOnly: boolean, now: number): EpRow[] {
  const out: EpRow[] = [];
  for (const s of cache.prepare(`SELECT ${SERIES_COLS} FROM series`).all() as unknown as SeriesRow[]) {
    const scope = monitoredOnly ? (isManaged(s.tvdb_id) ? scopedEpisodeIds(s.tvdb_id, s.id, now) : new Set<number>()) : null;
    for (const e of cache
      .prepare(
        `SELECT ${EP_COLS} FROM episodes WHERE series_id = ? AND has_file = 0 AND air_utc IS NOT NULL AND air_utc <= ? AND season > 0`,
      )
      .all(s.id, now) as unknown as EpRow[])
      if (!scope || scope.has(e.id)) out.push(e);
  }
  return out;
}

/** Episodes whose file is below the quality goal of the show's profile (what the quality upgrade would replace). */
async function cutoffRows(now: number): Promise<EpRow[]> {
  const want = new Set<number>();
  for (const u of await upgradeUnits(now)) for (const f of u.files) if (!f.proper) want.add(f.episodeId);
  if (!want.size) return [];
  return cache
    .prepare(`SELECT ${EP_COLS} FROM episodes WHERE id IN (${[...want].map(() => "?").join(",")})`)
    .all(...want) as unknown as EpRow[];
}

function wantedPage(q: Record<string, unknown>, rows: EpRow[], now: number) {
  const direction = dir(q, "descending");
  const key = qs(q.sortKey) || "episodes.airDateUtc";
  const titleOf = new Map<number, string>();
  const title = (r: EpRow) =>
    titleOf.get(r.series_id) ??
    (titleOf.set(r.series_id, (seriesById(r.series_id)?.sort_title ?? seriesById(r.series_id)?.title ?? "").toLowerCase()),
    titleOf.get(r.series_id)!);
  const order = /series/i.test(key)
    ? sorted(rows, (r) => `${title(r)}${String(r.season).padStart(4, "0")}${String(r.episode).padStart(4, "0")}`, direction)
    : sorted(rows, (r) => r.air_utc ?? 0, direction);
  const page = paged(q, order, key, direction);
  const withSeries = flag(q.includeSeries);
  const res = episodeResources(page.records, now);
  const files = new Map(fileRows(`id IN (${page.records.map((r) => r.file_id ?? 0).join(",") || "0"})`).map((f) => [f.id, f]));
  return {
    ...page,
    records: page.records.map((r, i) => ({
      ...res[i],
      ...(withSeries ? { series: seriesResource(mustSeries(r.series_id), now) } : {}),
      ...(flag(q.includeEpisodeFile) && r.file_id && files.has(r.file_id) ? { episodeFile: fileResource(files.get(r.file_id)!) } : {}),
    })),
  };
}

// ---------------------------------------------------------------- releases (interactive search)

interface Searched {
  at: number;
  tvdbId: number;
  episodeIds: number[];
  results: SearchResult[];
}
const searched = new Map<string, Searched>();
const KEEP_MS = 30 * 60_000;

/** A Deep Search result as Sonarr's release resource. Rejections are AnimeArr's own plain-words reasons. */
export function releaseResource(r: SearchResult, s: { tvdbId: number; seriesId: number; seriesTitle: string }, now = Date.now()) {
  const approved = r.rank.accept && r.coversTarget;
  const rejections = [
    ...(r.rank.reject ? [r.rank.reject] : []),
    ...r.rank.flags.filter((f) => f.tone === "bad").map((f) => f.label),
    ...(!r.coversTarget ? ["Doesn't cover the episodes asked for"] : []),
  ];
  const eps = r.episodeIds
    .map(
      (id) =>
        cache.prepare("SELECT id, season, episode, title, absolute FROM episodes WHERE id = ?").get(id) as
          { id: number; season: number; episode: number; title: string | null; absolute: number | null } | undefined,
    )
    .filter((e) => !!e);
  const published = r.publishDate ?? iso(now - (r.ageHours ?? 0) * 3_600_000)!;
  const lang = r.rank.lang ? r.rank.lang.toLowerCase() : "ja";
  return {
    guid: r.guid,
    quality: qualityResource(r.title),
    qualityWeight: 0,
    age: Math.floor((r.ageHours ?? 0) / 24),
    ageHours: r.ageHours ?? 0,
    ageMinutes: (r.ageHours ?? 0) * 60,
    size: r.size,
    indexerId: r.indexerId,
    indexer: r.indexer,
    releaseGroup: r.group ?? undefined,
    releaseHash: "",
    title: r.title,
    fullSeason: r.episodeIds.length > 1 && !!eps[0] && eps.length > 3,
    sceneSource: false,
    seasonNumber: eps[0]?.season ?? 0,
    languages: [languageResource(lang === "en" || lang === "ja" ? lang : "ja")],
    languageWeight: 0,
    seriesTitle: s.seriesTitle,
    episodeNumbers: eps.map((e) => e!.episode),
    absoluteEpisodeNumbers: eps.flatMap((e) => (e!.absolute ? [e!.absolute] : [])),
    mappedSeasonNumber: eps[0]?.season ?? 0,
    mappedEpisodeNumbers: eps.map((e) => e!.episode),
    mappedAbsoluteEpisodeNumbers: eps.flatMap((e) => (e!.absolute ? [e!.absolute] : [])),
    mappedSeriesId: s.seriesId,
    mappedEpisodeInfo: eps.map((e) => ({ id: e!.id, seasonNumber: e!.season, episodeNumber: e!.episode, title: e!.title ?? "TBA" })),
    approved,
    temporarilyRejected: false,
    rejected: !approved,
    tvdbId: s.tvdbId,
    tvRageId: 0,
    rejections,
    publishDate: published,
    commentUrl: undefined,
    downloadUrl: undefined, // never handed out: it can carry the indexer's key
    infoUrl: undefined,
    episodeRequested: r.coversTarget,
    downloadAllowed: true,
    releaseWeight: 0,
    customFormats: [] as unknown[],
    customFormatScore: Math.round(r.rank.score),
    sceneMapping: undefined,
    magnetUrl: undefined,
    infoHash: undefined,
    seeders: r.seeders ?? undefined,
    leechers: undefined,
    protocol: r.protocol,
    indexerFlags: 0,
    isDaily: false,
    isAbsoluteNumbering: false,
    isPossibleSpecialEpisode: false,
    special: false,
    // AnimeArr extras, harmless to clients that don't know them:
    animeArrWhy: r.rank.why,
  };
}

// ---------------------------------------------------------------- routes

export function registerSonarrMore(app: FastifyInstance, d: SonarrApiDeps) {
  const V = "/api/v3";

  // Health: what AnimeArr itself would flag, in Sonarr's shape (an empty list means all is well).
  app.get(`${V}/health`, async () => {
    const out: { source: string; type: string; message: string; wikiUrl: string }[] = [];
    const add = (source: string, type: "warning" | "error", message: string) => out.push({ source, type, message, wikiUrl: "" });
    if (dbState.corrupt) add("DatabaseCheck", "error", "The database failed its integrity check, so AnimeArr is read-only");
    if (!getSettings().allowedRoots.length) add("RootFolderCheck", "warning", "No root folders are set up yet");
    for (const b of breakerList().filter((x) => x.state === "off"))
      add(
        "IndexerStatusCheck",
        "warning",
        `Indexer ${b.name} is switched off after repeated failures${b.lastError ? `: ${b.lastError}` : ""}`,
      );
    return out;
  });

  // Disk space: the library roots and the download folders, each with free and total space.
  app.get(`${V}/diskspace`, async () => {
    const seen = new Set<string>();
    const out: { id: number; path: string; label: string; freeSpace: number; totalSpace: number }[] = [];
    const s = getSettings();
    for (const p of [...s.allowedRoots, ...s.importer.sourceRoots].map((x) => x.replace(/\/+$/, "") || "/")) {
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        const st = fs.statfsSync(mappedPath(p));
        out.push({
          id: out.length + 1,
          path: p,
          label: path.posix.basename(p) || p,
          freeSpace: st.bavail * st.bsize,
          totalSpace: st.blocks * st.bsize,
        });
      } catch {
        /* not mounted here: left out */
      }
    }
    return out;
  });

  // Calendar: episodes airing in the window (default today and the next two days).
  const calendar = (q: Record<string, unknown>) => {
    const now = Date.now();
    const day = 86_400_000;
    const from = Date.parse(qs(q.start)) || new Date(new Date().toDateString()).getTime();
    const to = Date.parse(qs(q.end)) || from + 2 * day;
    if (to - from > 366 * day) throw fail("Pick a shorter range");
    const rows = cache
      .prepare(`SELECT ${EP_COLS} FROM episodes WHERE air_utc BETWEEN ? AND ? ORDER BY air_utc, series_id, episode`)
      .all(from, to) as unknown as EpRow[];
    let res = episodeResources(rows, now);
    if (!flag(q.unmonitored)) res = res.filter((e) => e.monitored);
    const files = flag(q.includeEpisodeFile)
      ? new Map(fileRows(`id IN (${rows.map((r) => r.file_id ?? 0).join(",") || "0"})`).map((f) => [f.id, f]))
      : null;
    const series = new Map<number, ReturnType<typeof seriesResource>>();
    return res.map((e) => ({
      ...e,
      ...(flag(q.includeSeries)
        ? {
            series:
              series.get(e.seriesId) ?? (series.set(e.seriesId, seriesResource(mustSeries(e.seriesId), now)), series.get(e.seriesId)!),
          }
        : {}),
      ...(files && e.episodeFileId && files.has(e.episodeFileId) ? { episodeFile: fileResource(files.get(e.episodeFileId)!) } : {}),
    }));
  };
  app.get<{ Querystring: Record<string, string> }>(`${V}/calendar`, async (req) => calendar(req.query));
  app.get<{ Params: { id: string } }>(`${V}/calendar/:id`, async (req) => {
    const r = cache.prepare(`SELECT ${EP_COLS} FROM episodes WHERE id = ?`).get(int(req.params.id)) as EpRow | undefined;
    if (!r) throw fail("Episode not found", 404);
    return episodeResources([r])[0];
  });

  // Queue.
  const queueSort = (rows: Record<string, unknown>[], key: string, direction: string) => {
    const k = key.replace(/^.*\./, "");
    const val = (r: Record<string, unknown>) =>
      k === "timeleft" || k === "estimatedCompletionTime"
        ? String(r[k] ?? "")
        : typeof r[k] === "number"
          ? (r[k] as number)
          : String(r[k] ?? "");
    return sorted(rows, val, direction);
  };
  app.get<{ Querystring: Record<string, string> }>(`${V}/queue`, async (req) => {
    const q = req.query;
    const all = queueSort(
      await queueRecords(d, { includeEpisode: flag(q.includeEpisode), includeSeries: flag(q.includeSeries) }),
      qs(q.sortKey) || "timeleft",
      dir(q, "ascending"),
    );
    const page = Math.max(1, Number(q.page) || 1);
    // Sonarr's default page is 10 records; AnimeArr returns the whole queue unless a page size is asked for.
    const size = Math.max(1, Number(q.pageSize) || all.length || 1);
    return {
      page,
      pageSize: size,
      sortKey: qs(q.sortKey) || "timeleft",
      sortDirection: dir(q, "ascending"),
      totalRecords: all.length,
      records: all.slice((page - 1) * size, page * size),
    };
  });
  app.get<{ Querystring: Record<string, string> }>(`${V}/queue/details`, async (req) => {
    const q = req.query;
    const sid = q.seriesId ? int(q.seriesId, "seriesId") : null;
    const eps = q.episodeIds ? new Set(ids(q.episodeIds)) : null;
    return (await queueRecords(d, { includeEpisode: flag(q.includeEpisode), includeSeries: flag(q.includeSeries) })).filter(
      (r) => (!sid || r.seriesId === sid) && (!eps || eps.has(r.episodeId as number)),
    );
  });
  app.get(`${V}/queue/status`, async () => {
    const all = await queueRecords(d);
    const warnings = all.filter((r) => r.trackedDownloadStatus === "warning").length;
    const errors = all.filter((r) => r.trackedDownloadStatus === "error").length;
    return {
      totalCount: all.length,
      count: all.length,
      unknownCount: 0,
      errors: errors > 0,
      warnings: warnings > 0,
      unknownErrors: false,
      unknownWarnings: false,
    };
  });
  /** Removes a download (a queue record's id is the grab id x 1000 + the episode's position); blocklisting may pick the next release. */
  const removeQueue = async (queueIds: number[], q: Record<string, unknown>) => {
    writable();
    const blocklist = flag(q.blocklist);
    const searchNext = blocklist && !flag(q.skipRedownload);
    for (const grabId of new Set(queueIds.map((x) => Math.floor(x / 1000)))) await d.removeGrab(grabId, { blocklist, searchNext });
  };
  app.delete<{ Querystring: Record<string, string> }>(`${V}/queue/bulk`, async (req) => {
    await removeQueue(
      ((req.body as { ids?: unknown[] } | undefined)?.ids ?? []).map((x) => int(x)),
      req.query,
    );
    return {};
  });
  app.delete<{ Params: { id: string }; Querystring: Record<string, string> }>(`${V}/queue/:id`, async (req) => {
    await removeQueue([int(req.params.id)], req.query);
    return {};
  });

  // History.
  const inc = (q: Record<string, unknown>) => ({ series: flag(q.includeSeries), episode: flag(q.includeEpisode) });
  app.get<{ Querystring: Record<string, string> }>(`${V}/history`, async (req) => {
    const q = req.query;
    const direction = dir(q, "descending");
    const ev = historyEvents({
      eventType: q.eventType ? int(q.eventType, "eventType") : undefined,
      episodeId: q.episodeId ? int(q.episodeId, "episodeId") : undefined,
    });
    const want = q.seriesIds ? new Set(ids(q.seriesIds)) : null;
    const rows = (want ? ev.filter((e) => want.has(e.seriesId)) : ev).filter((e) => !q.downloadId || e.downloadId === q.downloadId);
    const page = paged(q, direction === "descending" ? rows : [...rows].reverse(), qs(q.sortKey) || "date", direction);
    const now = Date.now();
    return { ...page, records: page.records.map((e) => historyRecord(e, inc(q), now)) };
  });
  app.get<{ Querystring: Record<string, string> }>(`${V}/history/since`, async (req) => {
    const since = Date.parse(qs(req.query.date)) || 0;
    const now = Date.now();
    return historyEvents({ eventType: req.query.eventType ? int(req.query.eventType, "eventType") : undefined })
      .filter((e) => e.at > since)
      .map((e) => historyRecord(e, inc(req.query), now));
  });
  app.get<{ Querystring: Record<string, string> }>(`${V}/history/series`, async (req) => {
    const q = req.query;
    const now = Date.now();
    return historyEvents({
      seriesId: int(q.seriesId, "seriesId"),
      seasonNumber: q.seasonNumber !== undefined ? Number(q.seasonNumber) : undefined,
      eventType: q.eventType ? int(q.eventType, "eventType") : undefined,
    }).map((e) => historyRecord(e, inc(q), now));
  });
  app.post<{ Params: { id: string } }>(`${V}/history/failed/:id`, async () => {
    throw fail("AnimeArr retries failed downloads on its own (Activity shows the fixes)", 405);
  });

  // Wanted.
  app.get<{ Querystring: Record<string, string> }>(`${V}/wanted/missing`, async (req) => {
    const now = Date.now();
    return wantedPage(req.query, missingRows(flag(req.query.monitored, true), now), now);
  });
  app.get<{ Querystring: Record<string, string> }>(`${V}/wanted/cutoff`, async (req) => {
    const now = Date.now();
    return wantedPage(req.query, await cutoffRows(now), now);
  });

  // Episode files (read only).
  app.get<{ Querystring: Record<string, string> }>(`${V}/episodefile`, async (req) => {
    // Parameter names in any case (clients differ: seriesId / seriesID, episodeFileIds / episodeFileId).
    const q = Object.fromEntries(Object.entries(req.query ?? {}).map(([k, v]) => [k.toLowerCase(), v])) as Record<string, string>;
    if (q.seriesid) return fileRows("series_id = ? ORDER BY season, path", int(q.seriesid, "seriesId")).map(fileResource);
    const want = ids(q.episodefileids ?? q.episodefileid);
    // Sonarr answers 400 here, but nzb360 crashes on that: an empty list is the safer answer.
    if (!want.length) {
      req.log.warn({ params: Object.keys(req.query ?? {}) }, "episodefile without seriesId or episodeFileIds");
      return [];
    }
    return fileRows(`id IN (${want.map(() => "?").join(",")}) ORDER BY season, path`, ...want).map(fileResource);
  });
  app.get<{ Params: { id: string } }>(`${V}/episodefile/:id`, async (req) => {
    const f = fileRows("id = ?", int(req.params.id))[0];
    if (!f) throw fail("Episode file not found", 404);
    return fileResource(f);
  });
  const noDelete = async () => {
    throw fail(
      "AnimeArr doesn't delete files through this API; delete a file from the episode's page in AnimeArr, where it asks first",
      405,
    );
  };
  app.delete(`${V}/episodefile/:id`, noDelete);
  app.delete(`${V}/episodefile/bulk`, noDelete);

  // Cover art: the client asks for the relative url; send it to the poster.
  app.get<{ Params: { id: string } }>(`${V}/mediacover/:id/:file`, async (req, reply) => {
    const poster = seriesById(int(req.params.id))?.poster;
    if (!poster || !/^https?:\/\//.test(poster)) throw fail("No cover", 404);
    return reply.redirect(poster);
  });

  // Quality definitions: the sizes AnimeArr's ranking calls lean, per quality (MB per minute).
  app.get(`${V}/qualitydefinition`, async () =>
    Object.entries(SIZES).map(([name, v], i) => ({
      id: i + 1,
      quality: qualityByName(name).quality,
      title: name,
      weight: i + 1,
      minSize: v[0],
      maxSize: v[1],
      preferredSize: v[2],
    })),
  );

  // Interactive search.
  app.get<{ Querystring: Record<string, string> }>(`${V}/release`, async (req) => {
    const q = req.query;
    let seriesId = q.seriesId ? int(q.seriesId, "seriesId") : 0;
    let episodeIds: number[] = [];
    if (q.episodeId) {
      const e = cache.prepare("SELECT id, series_id FROM episodes WHERE id = ?").get(int(q.episodeId, "episodeId")) as
        { id: number; series_id: number } | undefined;
      if (!e) throw fail("Episode not found", 404);
      seriesId = e.series_id;
      episodeIds = [e.id];
    } else if (seriesId && q.seasonNumber !== undefined) {
      episodeIds = (
        cache
          .prepare("SELECT id FROM episodes WHERE series_id = ? AND season = ? ORDER BY episode LIMIT 50")
          .all(seriesId, Number(q.seasonNumber)) as { id: number }[]
      ).map((r) => r.id);
    }
    if (!seriesId || !episodeIds.length) throw fail("Pass episodeId, or seriesId with seasonNumber");
    const s = mustSeries(seriesId);
    const r = await d.deepSearch(s.tvdb_id, episodeIds, {});
    for (const [k, v] of searched) if (Date.now() - v.at > KEEP_MS) searched.delete(k);
    searched.set(`${s.tvdb_id}:${episodeIds.join(",")}`, { at: Date.now(), tvdbId: s.tvdb_id, episodeIds, results: r.results });
    return r.results.map((x) => releaseResource(x, { tvdbId: s.tvdb_id, seriesId: s.id, seriesTitle: s.title }));
  });
  // Grab one release found by GET /release (matched by guid, and the indexer when given).
  app.post<{ Body: { guid?: string; indexerId?: number } }>(`${V}/release`, async (req) => {
    writable();
    const guid = String(req.body?.guid ?? "");
    let hit: { run: Searched; pick: SearchResult } | null = null;
    for (const run of searched.values()) {
      if (Date.now() - run.at > KEEP_MS) continue;
      const pick = run.results.find((r) => r.guid === guid && (!req.body?.indexerId || r.indexerId === req.body.indexerId));
      if (pick && (!hit || run.at > hit.run.at)) hit = { run, pick };
    }
    if (!hit) throw fail("Search for releases again first (results are kept for 30 minutes)", 404);
    const toCand = (r: SearchResult): Candidate => ({
      guid: r.guid,
      title: r.title,
      indexerId: r.indexerId,
      indexer: r.indexer,
      protocol: r.protocol,
      size: r.size,
      downloadUrl: r.downloadUrl,
      magnetUrl: r.magnetUrl,
      label: r.label,
      group: r.group,
      why: r.rank.why,
      episodeIds: r.episodeIds,
    });
    const { run, pick } = hit;
    const fallbacks = run.results.filter((r) => r !== pick && r.rank.accept && r.coversTarget).map(toCand);
    await d.startGrab({ tvdbId: run.tvdbId, episodeIds: run.episodeIds, candidate: toCand(pick), fallbacks, origin: "manual" });
    const s = cache.prepare("SELECT id, title FROM series WHERE tvdb_id = ?").get(run.tvdbId) as { id: number; title: string };
    return releaseResource(pick, { tvdbId: run.tvdbId, seriesId: s.id, seriesTitle: s.title });
  });
}

/** MB per minute (min, max, preferred) per quality, from AnimeArr's lean sizes; max 0 = no limit. */
const SIZES: Record<string, [number, number, number]> = {
  SDTV: [0, 0, 25],
  DVD: [0, 0, 25],
  "WEBDL-480p": [0, 0, 25],
  "WEBRip-480p": [0, 0, 25],
  "Bluray-480p": [0, 0, 25],
  "HDTV-720p": [0, 0, 45],
  "WEBDL-720p": [0, 0, 45],
  "WEBRip-720p": [0, 0, 45],
  "Bluray-720p": [0, 0, 45],
  "HDTV-1080p": [0, 0, 85],
  "WEBDL-1080p": [0, 0, 85],
  "WEBRip-1080p": [0, 0, 85],
  "Bluray-1080p": [0, 0, 85],
  "Bluray-1080p Remux": [0, 0, 85],
  "HDTV-2160p": [0, 0, 170],
  "WEBDL-2160p": [0, 0, 170],
  "WEBRip-2160p": [0, 0, 170],
  "Bluray-2160p": [0, 0, 170],
  "Bluray-2160p Remux": [0, 0, 170],
};
