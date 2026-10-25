import { getSettings } from "../settings.js";
import { jsonCall, type Conn } from "./http.js";

/** Radarr v3 API client: read-only in 1.0. */

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
