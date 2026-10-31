/**
 * Starts AnimeArr's media management from the values Sonarr and Radarr already use (naming formats, folders,
 * importing, permissions), so the takeover doesn't rename anything just because the defaults differ.
 * The recycle bin stays AnimeArr's own (/media/Recycle/animearr/): Sonarr's path is from Sonarr's container.
 */
import { logDecision } from "./activity.js";
import * as radarr from "./arr/radarr.js";
import * as sonarr from "./arr/sonarr.js";
import { renderEpisode, renderMovie, renderSeasonFolder, renderSeriesFolder } from "./naming.js";
import { getSettings, patchSettings, type Settings } from "./settings.js";

const COLON = ["delete", "dash", "spaceDash", "spaceDashSpace", "smart"] as const;
const MULTI = ["extend", "duplicate", "repeat", "scene", "range", "prefixedRange"] as const;

/** Sonarr sends these enums as ints (v3) or strings (v4); either maps to ours, anything else keeps our value. */
export function enumOf<T extends string>(v: unknown, list: readonly T[], fallback: T): T {
  if (typeof v === "number" && list[v]) return list[v];
  if (typeof v === "string" && (list as readonly string[]).includes(v)) return v as T;
  return fallback;
}

const str = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback);

/** Maps Sonarr's /config/naming + /config/mediamanagement and Radarr's /config/naming onto settings.media. */
export function mapArrMedia(cur: Settings["media"], naming: Record<string, unknown> | null, mm: Record<string, unknown> | null, radarrNaming: Record<string, unknown> | null): Settings["media"] {
  const m = { ...cur };
  if (naming) {
    m.renameEpisodes = bool(naming.renameEpisodes, m.renameEpisodes);
    m.replaceIllegalCharacters = bool(naming.replaceIllegalCharacters, m.replaceIllegalCharacters);
    m.colonReplacement = enumOf(naming.colonReplacementFormat, COLON, m.colonReplacement);
    m.multiEpisodeStyle = enumOf(naming.multiEpisodeStyle, MULTI, m.multiEpisodeStyle);
    m.standardEpisodeFormat = str(naming.standardEpisodeFormat, m.standardEpisodeFormat);
    m.dailyEpisodeFormat = str(naming.dailyEpisodeFormat, m.dailyEpisodeFormat);
    m.animeEpisodeFormat = str(naming.animeEpisodeFormat, m.animeEpisodeFormat);
    m.seriesFolderFormat = str(naming.seriesFolderFormat, m.seriesFolderFormat);
    m.seasonFolderFormat = str(naming.seasonFolderFormat, m.seasonFolderFormat);
    m.specialsFolderFormat = str(naming.specialsFolderFormat, m.specialsFolderFormat);
  }
  if (mm) {
    m.createEmptyFolders = bool(mm.createEmptySeriesFolders, m.createEmptyFolders);
    m.deleteEmptyFolders = bool(mm.deleteEmptyFolders, m.deleteEmptyFolders);
    m.episodeTitleRequired = enumOf(mm.episodeTitleRequired, ["always", "bulkSeasonReleases", "never"] as const, m.episodeTitleRequired);
    m.skipFreeSpaceCheck = bool(mm.skipFreeSpaceCheckWhenImporting, m.skipFreeSpaceCheck);
    m.minimumFreeSpaceMb = num(mm.minimumFreeSpaceWhenImporting, m.minimumFreeSpaceMb);
    m.useHardlinks = bool(mm.copyUsingHardlinks, m.useHardlinks);
    m.importExtraFiles = bool(mm.importExtraFiles, m.importExtraFiles);
    m.extraFileExtensions = str(mm.extraFileExtensions, m.extraFileExtensions);
    m.propers = enumOf(mm.downloadPropersAndRepacks, ["preferAndUpgrade", "doNotUpgrade", "doNotPrefer"] as const, m.propers);
    m.unmonitorDeleted = bool(mm.autoUnmonitorPreviouslyDownloadedEpisodes, m.unmonitorDeleted);
    m.fileDate = enumOf(mm.fileDate, ["none", "localAirDate", "utcAirDate"] as const, m.fileDate);
    m.rescanAfterRefresh = enumOf(mm.rescanAfterRefresh, ["always", "afterManual", "never"] as const, m.rescanAfterRefresh);
    m.analyseVideoFiles = bool(mm.enableMediaInfo, m.analyseVideoFiles);
    m.setPermissions = bool(mm.setPermissionsLinux, m.setPermissions);
    m.chmodFolder = /^[0-7]{3,4}$/.test(String(mm.chmodFolder ?? "")) ? String(mm.chmodFolder) : m.chmodFolder;
    m.chownGroup = typeof mm.chownGroup === "string" ? mm.chownGroup : m.chownGroup;
  }
  if (radarrNaming) {
    m.renameMovies = bool(radarrNaming.renameMovies, m.renameMovies);
    m.movieColonReplacement = enumOf(radarrNaming.colonReplacementFormat, COLON, m.movieColonReplacement);
    m.movieFormat = str(radarrNaming.standardMovieFormat, m.movieFormat);
    m.movieFolderFormat = str(radarrNaming.movieFolderFormat, m.movieFolderFormat);
  }
  return m;
}

/** Reads Sonarr/Radarr's settings and copies them into AnimeArr's media management. */
export async function importMediaDefaults() {
  const [naming, mm, rn] = await Promise.all([
    sonarr.getNamingConfig().catch(() => null),
    sonarr.getMediaManagementFull().catch(() => null),
    radarr.radarrConfigured() ? radarr.getRadarrNaming().catch(() => null) : Promise.resolve(null),
  ]);
  if (!naming && !mm && !rn) throw Object.assign(new Error("Couldn't read Sonarr's or Radarr's settings"), { statusCode: 502 });
  const next = mapArrMedia(getSettings().media, naming, mm, rn);
  patchSettings((s) => ({ ...s, media: { ...next, importedFromArr: true } }));
  logDecision("info", { why: `Media management settings copied from ${[naming || mm ? "Sonarr" : null, rn ? "Radarr" : null].filter(Boolean).join(" and ")}` });
  return { sonarr: !!(naming || mm), radarr: !!rn, media: getSettings().media };
}

/** Once, at startup: copies them if that never happened. */
export async function importMediaDefaultsOnce() {
  if (getSettings().media.importedFromArr) return;
  await importMediaDefaults().catch(() => undefined);
}

/** Live examples for the Media management page (from the unsaved values on screen). */
export function previewNaming(media: Partial<Settings["media"]>) {
  const m = { ...getSettings().media, ...media };
  const opts = { replaceIllegalCharacters: !!m.replaceIllegalCharacters, colonReplacement: m.colonReplacement, multiEpisodeStyle: m.multiEpisodeStyle };
  const mi = { videoCodec: "h264", videoBitDepth: 8, audioCodec: "aac", audioChannels: 2, audioLanguages: ["ja"], subtitleLanguages: ["en"] };
  const ep = { seriesTitle: "Frieren: Beyond Journey's End", seriesYear: 2023, season: 1, episodes: [{ episode: 5, absolute: 5, title: "Phantoms of the Dead", airDate: "2023-10-06" }], quality: "WEBDL-1080p", mediaInfo: mi, releaseGroup: "SubsPlease", anidbTitle: "Sousou no Frieren" };
  const multi = { ...ep, episodes: [ep.episodes[0], { episode: 6, absolute: 6, title: "A Hero of the Village", airDate: "2023-10-13" }] };
  const safe = (f: () => string) => {
    try {
      return f();
    } catch (e) {
      return `⚠ ${(e as Error).message}`;
    }
  };
  return {
    standard: safe(() => renderEpisode(m.standardEpisodeFormat, ep, opts) + ".mkv"),
    daily: safe(() => renderEpisode(m.dailyEpisodeFormat, { ...ep, seriesTitle: "Anime Daily News" }, opts) + ".mkv"),
    anime: safe(() => renderEpisode(m.animeEpisodeFormat, ep, opts) + ".mkv"),
    multi: safe(() => renderEpisode(m.animeEpisodeFormat, multi, opts) + ".mkv"),
    seriesFolder: safe(() => renderSeriesFolder(m.seriesFolderFormat, { seriesTitle: ep.seriesTitle, seriesYear: 2023, tvdbId: 424536, anidbTitle: ep.anidbTitle, server: getSettings().mediaOutput?.main }, opts)),
    seasonFolder: safe(() => renderSeasonFolder(m.seasonFolderFormat, 1, opts)),
    specialsFolder: safe(() => renderSeasonFolder(m.specialsFolderFormat, 0, opts)),
    movie: safe(() => renderMovie(m.movieFormat, { movieTitle: "Suzume: The Door", year: 2022, quality: "Bluray-1080p", mediaInfo: mi, releaseGroup: "GRP", imdbId: "tt16428256", tmdbId: 916224 }, { ...opts, colonReplacement: m.movieColonReplacement }) + ".mkv"),
    movieFolder: safe(() => renderMovie(m.movieFolderFormat, { movieTitle: "Suzume: The Door", year: 2022, imdbId: "tt16428256", tmdbId: 916224 }, { ...opts, colonReplacement: m.movieColonReplacement })),
  };
}
