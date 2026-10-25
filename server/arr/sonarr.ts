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
  quality: { quality: { name: string; source?: string; resolution?: number } };
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

// ---------------------------------------------------------------- WRITE calls (pipeline only)

/** Import specific files as specific episodes (explicit episode IDs: works even if the series is unmonitored). */
export async function manualImport(files: { path: string; seriesId: number; episodeIds: number[]; quality: unknown; languages?: unknown[]; releaseGroup?: string; downloadId?: string; indexerFlags?: number; releaseType?: string }[], importMode: "auto" | "move" | "copy") {
  return call<{ id: number }>("POST", "/command", { name: "ManualImport", files, importMode });
}

/** Sets a series' monitored flag (only after the user confirms in the Managed screen). */
export async function setSeriesMonitored(id: number, monitored: boolean) {
  const s = await getOneSeries(id);
  return call<SonarrSeries>("PUT", `/series/${id}`, { ...s, monitored });
}
