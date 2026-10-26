import { getSettings } from "../settings.js";
import { jsonCall, type Conn } from "./http.js";

/**
 * Sonarr v3 API client. READ calls are used everywhere; the few WRITE calls (ManualImport, unmonitor) are grouped at the
 * bottom and are only reached from the grab/import pipeline and the "unmonitor in Sonarr" confirmation.
 */

export interface SonarrSeason { seasonNumber: number; monitored: boolean; statistics?: { episodeFileCount: number; totalEpisodeCount: number; episodeCount: number; previousAiring?: string; nextAiring?: string } }
export interface SonarrSeries {
  id: number;
  tvdbId: number;
  tmdbId?: number;
  imdbId?: string;
  title: string;
  sortTitle?: string;
  year?: number;
  status: string;
  seriesType: string;
  path: string;
  rootFolderPath?: string;
  monitored: boolean;
  qualityProfileId: number;
  tags: number[];
  network?: string;
  runtime?: number;
  originalLanguage?: { id: number; name: string };
  seasons: SonarrSeason[];
  firstAired?: string;
  nextAiring?: string;
  previousAiring?: string;
  added?: string;
  alternateTitles?: { title: string; seasonNumber?: number; sceneSeasonNumber?: number }[];
  images?: { coverType: string; remoteUrl?: string; url?: string }[];
  [k: string]: unknown;
}
export interface SonarrEpisode {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber?: number;
  sceneSeasonNumber?: number;
  sceneEpisodeNumber?: number;
  sceneAbsoluteEpisodeNumber?: number;
  title?: string;
  airDate?: string;
  airDateUtc?: string;
  runtime?: number;
  monitored: boolean;
  hasFile: boolean;
  episodeFileId?: number;
  series?: SonarrSeries;
}
export interface SonarrEpisodeFile {
  id: number;
  seriesId: number;
  seasonNumber: number;
  path: string;
  relativePath?: string;
  size: number;
  sceneName?: string;
  releaseGroup?: string;
  dateAdded?: string;
  quality: { quality: { name: string; source?: string; resolution?: number }; revision?: { version?: number; real?: number; isRepack?: boolean } };
  mediaInfo?: { audioLanguages?: string; subtitles?: string; runTime?: string; resolution?: string };
}
export interface ManualImportItem {
  path: string;
  relativePath?: string;
  folderName?: string;
  name?: string;
  size?: number;
  series?: SonarrSeries;
  seasonNumber?: number;
  episodes?: SonarrEpisode[];
  quality: unknown;
  languages?: unknown[];
  releaseGroup?: string;
  downloadId?: string;
  indexerFlags?: number;
  releaseType?: string;
  rejections?: { reason: string; type: string }[];
}

const conn = (): Conn => getSettings().sonarr;
const call = <T>(method: string, path: string, body?: unknown, c: Conn = conn(), timeout?: number) => jsonCall<T>("Sonarr", c, "/api/v3", method, path, body, timeout);

export const sonarrConfigured = () => !!(getSettings().sonarr.url && getSettings().sonarr.apiKey);

export async function testSonarr(c: Conn) {
  const s = await call<{ version: string; appName?: string }>("GET", "/system/status", undefined, c);
  if (s.appName && s.appName !== "Sonarr") throw new Error(`That's ${s.appName}, not Sonarr`);
  return { version: s.version };
}

export async function sonarrOptions(c: Conn = conn()) {
  const [profiles, roots, tags] = await Promise.all([
    call<{ id: number; name: string }[]>("GET", "/qualityprofile", undefined, c),
    call<{ id: number; path: string; freeSpace?: number; accessible?: boolean }[]>("GET", "/rootfolder", undefined, c),
    call<{ id: number; label: string }[]>("GET", "/tag", undefined, c),
  ]);
  return { profiles: profiles.map(({ id, name }) => ({ id, name })), roots: roots.map(({ id, path, freeSpace, accessible }) => ({ id, path, freeSpace, accessible })), tags };
}

export const getSeries = () => call<SonarrSeries[]>("GET", "/series", undefined, conn(), 120_000);
export const getOneSeries = (id: number) => call<SonarrSeries>("GET", `/series/${id}`);
export const getEpisodes = (seriesId: number) => call<SonarrEpisode[]>("GET", `/episode?seriesId=${seriesId}`);
export const getEpisode = (id: number) => call<SonarrEpisode>("GET", `/episode/${id}`);
export const getEpisodeFiles = (seriesId: number) => call<SonarrEpisodeFile[]>("GET", `/episodefile?seriesId=${seriesId}`);
export const getEpisodeFile = (id: number) => call<SonarrEpisodeFile>("GET", `/episodefile/${id}`);
export const getTags = () => call<{ id: number; label: string }[]>("GET", "/tag");
/** Air calendar (unmonitored included: managed shows are usually unmonitored in Sonarr). */
export const getCalendar = (start: Date, end: Date) =>
  call<SonarrEpisode[]>("GET", `/calendar?start=${start.toISOString()}&end=${end.toISOString()}&unmonitored=true&includeSeries=false`);
export const getCommand = (id: number) => call<{ id: number; status: string; result?: string; message?: string }>("GET", `/command/${id}`);
/** Files Sonarr would import from a folder (read-only preview; nothing is imported). */
export const manualImportPreview = (folder: string, downloadId?: string, seriesId?: number) =>
  call<ManualImportItem[]>(
    "GET",
    `/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=false${downloadId ? `&downloadId=${encodeURIComponent(downloadId)}` : ""}${seriesId ? `&seriesId=${seriesId}` : ""}`,
    undefined,
    conn(),
    180_000,
  );

export interface HistoryItem {
  id: number;
  episodeId: number;
  seriesId: number;
  sourceTitle: string;
  date: string;
  downloadId?: string;
  eventType: string;
  data: Record<string, string | undefined>;
}
/** Import (and other) history since a date (read-only). */
export const getHistorySince = (date: Date, eventType: "downloadFolderImported" | "grabbed") =>
  call<HistoryItem[]>("GET", `/history/since?date=${encodeURIComponent(date.toISOString())}&eventType=${eventType}`, undefined, conn(), 120_000);
/** The grab history of one episode, newest first (to find the grab behind an import). */
export const getEpisodeGrabs = async (episodeId: number) =>
  (await call<{ records: HistoryItem[] }>("GET", `/history?episodeId=${episodeId}&eventType=1&sortKey=date&sortDirection=descending&pageSize=20`)).records;

export interface SonarrQueueItem {
  id: number;
  seriesId?: number;
  episodeId?: number;
  title: string;
  status: string;
  trackedDownloadStatus?: "ok" | "warning" | "error";
  trackedDownloadState?: string;
  statusMessages?: { title?: string; messages?: string[] }[];
  errorMessage?: string;
  downloadId?: string;
  protocol?: string;
  downloadClient?: string;
  size?: number;
  sizeleft?: number;
  timeleft?: string;
  added?: string;
  series?: { title: string; tvdbId: number; path: string };
  episode?: { seasonNumber: number; episodeNumber: number };
}
/** Media management settings (read-only): where Sonarr's recycle bin is and how long it keeps files. */
export const getMediaManagement = () => call<{ recycleBin?: string; recycleBinCleanupDays?: number }>("GET", "/config/mediamanagement");

/** Naming and media-management settings (read-only), to start AnimeArr's media management from the same values. */
export const getNamingConfig = () => call<Record<string, unknown>>("GET", "/config/naming");
export const getMediaManagementFull = () => call<Record<string, unknown>>("GET", "/config/mediamanagement");
/** Asks Sonarr to re-read a series folder (after AnimeArr's own importer or renamer touched it). */
/** Sonarr's own rename preview for a series (files whose names differ from Sonarr's naming). */
export const renamePreview = (seriesId: number) =>
  call<{ seriesId: number; seasonNumber: number; episodeNumbers: number[]; episodeFileId: number; existingPath: string; newPath: string }[]>("GET", `/rename?seriesId=${seriesId}`);
/** Asks Sonarr to rename these files itself (its file records and history stay intact). */
export async function renameFiles(seriesId: number, files: number[]) {
  return call<{ id: number }>("POST", "/command", { name: "RenameFiles", seriesId, files });
}
export async function rescanSeries(seriesId: number) {
  return call<{ id: number }>("POST", "/command", { name: "RescanSeries", seriesId });
}

/** Sonarr's download queue, with series and episode (read-only). */
export async function getQueue() {
  const out: SonarrQueueItem[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await call<{ records: SonarrQueueItem[]; totalRecords: number }>("GET", `/queue?page=${page}&pageSize=500&includeSeries=true&includeEpisode=true&includeUnknownSeriesItems=false`);
    out.push(...r.records);
    if (!r.records.length || out.length >= r.totalRecords) break;
  }
  return out;
}

// ---------------------------------------------------------------- WRITE calls (pipeline only)

/** Import specific files as specific episodes (explicit episode IDs: works even if the series is unmonitored). */
export async function manualImport(files: { path: string; seriesId: number; episodeIds: number[]; quality: unknown; languages?: unknown[]; releaseGroup?: string; downloadId?: string; indexerFlags?: number; releaseType?: string }[], importMode: "auto" | "move" | "copy") {
  return call<{ id: number }>("POST", "/command", { name: "ManualImport", files, importMode });
}

/** Deletes an episode file through Sonarr (Sonarr's recycle bin applies if one is set). User-confirmed only. */
export async function deleteEpisodeFile(id: number) {
  await call<void>("DELETE", `/episodefile/${id}`);
}

/** Removes an item from Sonarr's queue and its download client, optionally blocklisting it (user-confirmed only). */
export async function removeQueueItem(id: number, blocklist: boolean) {
  await call<void>("DELETE", `/queue/${id}?removeFromClient=true&blocklist=${blocklist}&skipRedownload=false`);
}

/** Marks a grab as failed in Sonarr (Sonarr blocklists it and, if the episode is monitored, searches again). */
export async function markHistoryFailed(historyId: number) {
  await call<void>("POST", `/history/failed/${historyId}`);
}

/** Sets a series' monitored flag (only after the user confirms in the Managed screen). */
export async function setSeriesMonitored(id: number, monitored: boolean) {
  const s = await getOneSeries(id);
  return call<SonarrSeries>("PUT", `/series/${id}`, { ...s, monitored });
}
