import { getSettings } from "../settings.js";
import { jsonCall, type Conn } from "./http.js";

/** Radarr v3 API client: reads everywhere; the only write is ManualImport for AnimeArr's own movie grabs. */

export interface RadarrMovie {
  id: number;
  tmdbId: number;
  imdbId?: string;
  title: string;
  originalTitle?: string;
  year: number;
  path: string;
  rootFolderPath?: string;
  monitored: boolean;
  hasFile: boolean;
  runtime?: number;
  qualityProfileId: number;
  tags: number[];
  originalLanguage?: { name: string };
  genres?: string[];
  status?: string;
  isAvailable?: boolean;
  inCinemas?: string;
  digitalRelease?: string;
  physicalRelease?: string;
  alternateTitles?: { title: string }[];
  movieFile?: { relativePath?: string; path?: string; sceneName?: string; releaseGroup?: string; quality?: { quality: { name: string } }; mediaInfo?: { audioLanguages?: string; subtitles?: string; runTime?: string; resolution?: string } };
}

const conn = (): Conn => getSettings().radarr;
const call = <T>(method: string, path: string, body?: unknown, c: Conn = conn(), timeout?: number) => jsonCall<T>("Radarr", c, "/api/v3", method, path, body, timeout);

export const radarrConfigured = () => !!(getSettings().radarr.url && getSettings().radarr.apiKey);

export async function testRadarr(c: Conn) {
  const s = await call<{ version: string; appName?: string }>("GET", "/system/status", undefined, c);
  if (s.appName && s.appName !== "Radarr") throw new Error(`That's ${s.appName}, not Radarr`);
  return { version: s.version };
}

export async function radarrOptions(c: Conn = conn()) {
  const [profiles, roots] = await Promise.all([call<{ id: number; name: string }[]>("GET", "/qualityprofile", undefined, c), call<{ id: number; path: string }[]>("GET", "/rootfolder", undefined, c)]);
  return { profiles: profiles.map(({ id, name }) => ({ id, name })), roots: roots.map(({ id, path }) => ({ id, path })) };
}

export const getMovies = () => call<RadarrMovie[]>("GET", "/movie", undefined, conn(), 120_000);
export const getMovie = (id: number) => call<RadarrMovie & { movieFile?: RadarrMovie["movieFile"] & { id?: number; dateAdded?: string } }>("GET", `/movie/${id}`);
export const radarrRootFolders = () => call<{ id: number; path: string; freeSpace?: number }[]>("GET", "/rootfolder");
export const getRadarrCommand = (id: number) => call<{ id: number; status: string; result?: string; message?: string }>("GET", `/command/${id}`);

export interface RadarrImportItem {
  path: string;
  relativePath?: string;
  name?: string;
  size?: number;
  movie?: { id: number; title: string };
  quality: unknown;
  languages?: unknown[];
  releaseGroup?: string;
  downloadId?: string;
  indexerFlags?: number;
  rejections?: { reason: string; type: string }[];
}
/** Files Radarr would import from a folder (read-only preview; nothing is imported). */
export const radarrImportPreview = (folder: string) =>
  call<RadarrImportItem[]>("GET", `/manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=false`, undefined, conn(), 180_000);

// ---------------------------------------------------------------- WRITE calls (pipeline only)

/** Imports files for a movie through Radarr's ManualImport command (explicit movie id). */
export async function radarrManualImport(files: { path: string; movieId: number; quality: unknown; languages?: unknown[]; releaseGroup?: string; downloadId?: string; indexerFlags?: number }[], importMode: "auto" | "move" | "copy") {
  return call<{ id: number }>("POST", "/command", { name: "ManualImport", files, importMode });
}

/** Radarr's own queue for one movie (to avoid a second download when Radarr is already getting it). */
export const radarrQueueFor = async (movieId: number) =>
  ((await call<{ records: { id: number; movieId?: number; title: string; status: string }[] }>("GET", `/queue?movieIds=${movieId}&pageSize=200`)).records ?? []).filter((r) => r.movieId === movieId);

export const getRadarrNaming = () => call<Record<string, unknown>>("GET", "/config/naming");
/** Asks Radarr to re-read a movie folder (after AnimeArr's importer or renamer touched it). */
export async function rescanMovie(movieId: number) {
  return call<{ id: number }>("POST", "/command", { name: "RescanMovie", movieId });
}

export const getRadarrImportLists = () => call<{ id: number; name: string; enabled?: boolean; enableAuto?: boolean }[]>("GET", "/importlist");
/** Cutover only (confirmed by the user): removes a movie from Radarr, never its files; excluded from import lists. */
export async function removeMovieKeepFiles(movieId: number) {
  return call<unknown>("DELETE", `/movie/${movieId}?deleteFiles=false&addImportExclusion=true`);
}
