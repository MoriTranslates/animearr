import crypto from "node:crypto";
import { promisify } from "node:util";
import { db, dbState } from "./db.js";
import { open, seal } from "./secretbox.js";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export interface PathMapping {
  /** Path as Sonarr / the download client sees it, e.g. /media/Anime or /data. */
  from: string;
  /** Same place as the other side sees it, e.g. //NAS/Anime (Windows) or /srv/media/Anime. */
  to: string;
}

/**
 * How a viewer watches (PROPOSAL §5.4): sub = original audio + full subtitles in a profile language;
 * dub = audio in a profile dub language; dual = original + dub audio (a sub release is a placeholder until a dual
 * one appears); either = whichever arrives first that meets the profile.
 */
export type WatchMode = "sub" | "dub" | "dual" | "either";
export const WATCH_MODES: WatchMode[] = ["sub", "dub", "dual", "either"];

/** A language profile (PROPOSAL §5.4). Codes are BCP-47-style: en, es, pt, pt-br, fr, ar, ja ... */
export interface LanguageProfile {
  id: string;
  name: string;
  watchMode: WatchMode;
  /** Subtitle languages that make a file watchable, best first. Forced/signs-only tracks never count. */
  subLangs: string[];
  /** Audio languages that count as a dub (dub/dual/either modes), best first. */
  dubLangs: string[];
  /** Avoid burned-in subs when a soft-sub alternative exists (burn-ins stay a last resort). */
  softOnly: boolean;
  preferUncensored: boolean;
  /** Protocol order, e.g. usenet before torrent. */
  protocolOrder: ("usenet" | "torrent")[];
  /** "No preference": the best release wins whatever its protocol (protocolOrder only breaks ties). */
  noProtocolPreference?: boolean;
  /** Preferred resolution (lines). */
  resolution: number;
  /**
   * Size preset: "lean" (≤ ~2 GB per 24-min 1080p episode), "balanced" (WEB-DL preferred, no cap below the sanity
   * max) or "best" (best source for re-encoding yourself: REMUX > high-bitrate BD > WEB-DL, lossless audio preferred).
   */
  sizePreset?: SizePreset;
  /**
   * Keep the same release group within a season (subtitle wording, honorifics, typesetting, encode stay consistent):
   * "prefer" (default) gives the season's group a bonus, "strong" a bigger one and waits longer for it on airing shows.
   * Never overrides a hard requirement (language, burn-ins).
   */
  groupConsistency?: "off" | "prefer" | "strong";
}
export type SizePreset = "lean" | "balanced" | "best";

/** A download client added with "+ Add" (beyond the SABnzbd/qBittorrent slots). */
export interface ClientCfg {
  id: string;
  type: "nzbget" | "transmission";
  name: string;
  url: string;
  username: string;
  password: string;
  /** NZBGet category; Transmission label + sub-folder of its download folder. */
  category: string;
  /** 1 = tried first (per protocol). */
  priority: number;
  enabled: boolean;
  /** Remove finished jobs from the client after import (Usenet; torrents keep seeding by their rules). */
  removeCompleted: boolean;
  /** This client's path → AnimeArr's path. */
  pathMappings: PathMapping[];
}

/** An indexer AnimeArr searches directly (without Prowlarr). */
export interface IndexerCfg {
  id: string;
  /** newznab/torznab: the standard API; nyaa / rss / subsplease: built-in adapters for sites without one. */
  kind: "newznab" | "torznab" | "nyaa" | "rss" | "subsplease";
  protocol: "usenet" | "torrent";
  name: string;
  /** Base URL; for "rss" a search URL template with {q}. */
  url: string;
  apiPath: string;
  apiKey: string;
  categories: number[];
  priority: number;
  enabled: boolean;
  /** Private trackers: seed at least this ratio / this many minutes (null = the client's default). */
  seedRatio: number | null;
  seedTimeMin: number | null;
  tags: string[];
  /** The catalogue entry it was added from. */
  catalogId: string | null;
}
export const SIZE_PRESETS: SizePreset[] = ["lean", "balanced", "best"];

export interface Settings {
  sonarr: { url: string; apiKey: string; /** Optional: also import series with this Sonarr tag even when not seriesType=anime. */ animeTag: string };
  radarr: { url: string; apiKey: string; /** Movies under these root folders count as anime. */ animeRoots: string[]; animeProfileIds: number[] };
  prowlarr: { url: string; apiKey: string; /** Newznab categories searched. */ categories: number[]; /** Indexers AnimeArr asks (empty = all). */ indexerIds: number[]; /** Prowlarr indexers seen (defaults applied). */ knownIds: number[]; /** New ones to review (badge). */ newIds: number[] };
  sabnzbd: { url: string; apiKey: string; category: string };
  qbittorrent: { url: string; username: string; password: string; category: string };
  /** Priority / enabled for the SABnzbd and qBittorrent slots (by id "sabnzbd" / "qbittorrent"). */
  clientPrefs: Record<string, { priority: number; enabled: boolean }>;
  /** Clients added with "+ Add" (NZBGet, Transmission). */
  extraClients: ClientCfg[];
  /** Indexers searched directly (in addition to Prowlarr's, or instead of them). */
  indexers: IndexerCfg[];
  /** Sonarr-style delays: a release of a protocol is only taken automatically once it is this old (minutes). */
  protocol: { usenetDelayMin: number; torrentDelayMin: number };
  /** Download-client path → Sonarr path (like Sonarr's remote path mappings). */
  remotePathMappings: PathMapping[];
  /** Sonarr/client path → path on the machine running AnimeArr (for ffprobe and sidecar checks). */
  localPathMappings: PathMapping[];
  /**
   * Safety guard: AnimeArr only manages and imports series whose Sonarr path is under one of these root folders
   * (e.g. /media/AnimeArr). Empty = nothing can be managed or imported until the user picks one.
   */
  allowedRoots: string[];
  /** Language profiles; the default applies to every show without its own choice. */
  profiles: LanguageProfile[];
  defaultProfileId: string;
  managed: {
    /** Global DRY-RUN: when on, nothing is ever sent to a download client. Real grabs need this off AND the show's dry-run off. */
    dryRun: boolean;
    /** Minutes after air before the first search. */
    searchDelayMin: number;
    /** Retry delays in minutes; the last one repeats until maxAttempts. */
    backoffMin: number[];
    maxAttempts: number;
    /** Check Prowlarr's recent releases for managed shows (RSS-like) every N minutes; 0 = off. */
    rssMin: number;
    /** Automatic grabs only above this identification confidence (0-100). */
    minConfidence: number;
  };
  /**
   * After-import check of files that arrive in the allowed root folders (Sonarr's own imports included):
   * off, log (report only; the default), or auto (blocklist + re-search when two signals agree), capped per day.
   */
  repair: { mode: "off" | "log" | "auto"; maxPerDay: number };
  /**
   * Missing-episode search for managed shows (Sonarr's "Wanted > Missing", Huntarr-style): older aired, monitored
   * episodes without a file are searched a few per hour; ones not found are tried again every retryDays.
   * Off by default: turning it on can grab many episodes for shows that aren't in dry-run.
   */
  backlog: { enabled: boolean; perHour: number; retryDays: number };
  /**
   * Queue health for AnimeArr's own downloads (Cleanuparr-style): a download with no progress for stallHours, or a
   * torrent still without metadata after metadataMin, counts as failed (blocklist + next candidate). removeFailed
   * also takes failed downloads out of the download client (AnimeArr's own category only; never library files).
   */
  queueHealth: { stallHours: number; metadataMin: number; removeFailed: boolean };
  /**
   * Unpack torrents that arrive as RAR/7z/ZIP archives (Unpackerr-style). Needs write access to the download folder
   * (the container's /data mount) and 7-Zip; off by default.
   */
  extraction: { enabled: boolean };
  /**
   * Dual-audio upgrades for shows watched in "dual" mode: an episode whose file is sub-only (the placeholder) is
   * searched now and then for a dual-audio release, which replaces it. off / log (report only; default) / auto.
   */
  dualUpgrade: { mode: "off" | "log" | "auto"; perHour: number; recheckDays: number; maxAgeDays: number };
  /**
   * Automatic movie search (Radarr side): monitored anime movies in the allowed roots without a file are searched
   * delayHours after their digital/physical release, then again with backoff and every retryDays (missing-movie
   * search), within perHour. Off by default: it grabs for real.
   */
  movieSearch: { enabled: boolean; delayHours: number; perHour: number; retryDays: number };
  /** AnimeArr's own file records: scan the library roots and ffprobe every file (read-only). */
  /** scanConcurrency: ffprobe processes at once while scanning the library (0 = automatic: 1 below 4 CPU cores, else 2). */
  library: { scan: boolean; scanConcurrency: number };
  /** Media management (mirrors Sonarr/Radarr; defaults read from their config). */
  media: {
    renameEpisodes: boolean;
    replaceIllegalCharacters: boolean;
    colonReplacement: "delete" | "dash" | "spaceDash" | "spaceDashSpace" | "smart";
    multiEpisodeStyle: "extend" | "duplicate" | "repeat" | "scene" | "range" | "prefixedRange";
    standardEpisodeFormat: string;
    dailyEpisodeFormat: string;
    animeEpisodeFormat: string;
    seriesFolderFormat: string;
    seasonFolderFormat: string;
    specialsFolderFormat: string;
    /** Creditless OP/ED: as season-0 episodes ("s00") or as Plex extras in the show's "Other" folder ("extras"). */
    creditlessAs?: "s00" | "extras";
    renameMovies: boolean;
    /** Radarr has its own colon setting; movies use it. */
    movieColonReplacement: "delete" | "dash" | "spaceDash" | "spaceDashSpace" | "smart";
    movieFormat: string;
    movieFolderFormat: string;
    createEmptyFolders: boolean;
    deleteEmptyFolders: boolean;
    episodeTitleRequired: "always" | "bulkSeasonReleases" | "never";
    skipFreeSpaceCheck: boolean;
    minimumFreeSpaceMb: number;
    useHardlinks: boolean;
    importExtraFiles: boolean;
    extraFileExtensions: string;
    propers: "preferAndUpgrade" | "doNotUpgrade" | "doNotPrefer";
    unmonitorDeleted: boolean;
    fileDate: "none" | "localAirDate" | "utcAirDate";
    recycleBin: string;
    recycleBinCleanupDays: number;
    rescanAfterRefresh: "always" | "afterManual" | "never";
    analyseVideoFiles: boolean;
    setPermissions: boolean;
    chmodFolder: string;
    chownGroup: string;
    renameAfterReencode: boolean;
    /** Set once the defaults were read from Sonarr/Radarr. */
    importedFromArr: boolean;
  };
  /**
   * Who imports finished downloads: "sonarr" (ManualImport through Sonarr/Radarr; today) or "animearr" (AnimeArr's own
   * importer). allowReal stays false until the first real import plan was reviewed; renames likewise.
   */
  importer: {
    engine: "sonarr" | "animearr";
    allowReal: boolean;
    allowRename: boolean;
    /** Real imports left before AnimeArr's importer pauses for a review (-1 = no limit). Imports beyond it go through Sonarr. */
    realBudget: number;
    /** Movies through AnimeArr's own importer (off until the first movie import plan is reviewed; Radarr imports meanwhile). */
    movies: boolean;
    /**
     * AnimeArr's own download category folders (as Sonarr/AnimeArr see them). Automatic imports only ever take files
     * from inside these; anything else needs the user's explicit manual import.
     */
    sourceRoots: string[];
  };
  /** Notifications (minimal): Discord webhook and/or ntfy, per event. Webhook URL and ntfy token are stored encrypted. */
  notify: { discordWebhook: string; ntfyUrl: string; ntfyToken: string; events: { grabbed: boolean; imported: boolean; failed: boolean; paused: boolean; indexer: boolean } };
  /** Cutover: removing adopted shows/movies from Sonarr/Radarr (the only writes to them; off until reviewed). */
  cutover: { allowArrWrites: boolean };
  /** Plex: partial scans after AnimeArr's own imports/renames. The token is stored encrypted. */
  plex: { url: string; token: string; enabled: boolean; pathMappings: PathMapping[] };
  /** Download-folder rules and clean-up (AnimeArr's own category folders only). */
  downloads: {
    rules: import("./downloads.js").FolderRule[];
    /** Always on: under this many GB free on the download disk, every grab pauses. */
    freeSpaceGb: number;
    /** Where to measure free space ("" = automatic: Unraid's cache pool at /unraid/cache when downloads are on the FUSE union). */
    freeSpacePath: string;
    /** Imported payloads that are still seeding don't count toward the size/items rules. */
    excludeSeeding: boolean;
    /** off: never; plan: show what it would do; auto: a pause-and-clean rule runs it. */
    cleanup: "off" | "plan" | "auto";
    /** Real deletions by the clean-up (off until the first clean-up plan was reviewed). */
    allowDelete: boolean;
    /** A torrent's seeding is done at this ratio after minSeedDays, or after maxSeedDays regardless. */
    minRatio: number;
    minSeedDays: number;
    maxSeedDays: number;
  };
  /** Optional metadata providers (AniList, Anime-Lists and the AniDB dump need nothing). */
  metadata: { anidbClient: string; anidbClientVer: number; tmdbKey: string; tvdbKey: string };
  /** Default monitoring scope for managed shows without their own (see scope.ts). */
  scope: {
    ended: { seasons: "all" | "first" | "latest" | "recent"; recentN: number; episodes: "all" | "missing" | "future" | "futureAndMissing" | "existing" | "none"; specials: boolean; creditless?: boolean };
    continuing: { seasons: "all" | "first" | "latest" | "recent"; recentN: number; episodes: "all" | "missing" | "future" | "futureAndMissing" | "existing" | "none"; specials: boolean; creditless?: boolean };
  };
  /** Staged fill-in queue (see fillin.ts). */
  fillIn: { paused: boolean; waveSize: number; advancePct: number; stallDays: number };
  sync: { intervalHours: number };
  /** Address phones reach AnimeArr at (reverse proxy URL). */
  externalUrl: string;
  /** URL base for a reverse proxy on a sub-path ("/animearr"); the URL_BASE env wins; needs a restart. */
  urlBase: string;
  ui: { language: string; /** Text size for devices that haven't picked their own (sm/md/lg/xl). */ textScale?: string };
  auth: { username: string; passwordHash: string; bypassLocal: boolean };
  /** Admin API key, accepted only in the X-Api-Key header. */
  apiKey: string;
  secret: string;
}

export const DEFAULT_PROFILE: LanguageProfile = {
  id: "default",
  name: "English subs (default)",
  watchMode: "sub",
  subLangs: ["en"],
  dubLangs: ["en"],
  softOnly: true,
  preferUncensored: true,
  protocolOrder: ["usenet", "torrent"],
  resolution: 1080,
};

const DEFAULTS: Settings = {
  sonarr: { url: "", apiKey: "", animeTag: "" },
  radarr: { url: "", apiKey: "", animeRoots: [], animeProfileIds: [] },
  prowlarr: { url: "", apiKey: "", categories: [5070, 5000, 2000], indexerIds: [], knownIds: [], newIds: [] },
  sabnzbd: { url: "", apiKey: "", category: "animearr" },
  qbittorrent: { url: "", username: "", password: "", category: "animearr" },
  clientPrefs: {},
  extraClients: [],
  indexers: [],
  protocol: { usenetDelayMin: 0, torrentDelayMin: 0 },
  remotePathMappings: [],
  localPathMappings: [],
  allowedRoots: [],
  profiles: [DEFAULT_PROFILE],
  defaultProfileId: "default",
  managed: { dryRun: true, searchDelayMin: 45, backoffMin: [30, 60, 120, 240, 480], maxAttempts: 12, rssMin: 15, minConfidence: 80 },
  repair: { mode: "log", maxPerDay: 10 },
  backlog: { enabled: false, perHour: 4, retryDays: 7 },
  queueHealth: { stallHours: 6, metadataMin: 60, removeFailed: true },
  extraction: { enabled: false },
  dualUpgrade: { mode: "log", perHour: 4, recheckDays: 3, maxAgeDays: 365 },
  movieSearch: { enabled: false, delayHours: 6, perHour: 2, retryDays: 7 },
  library: { scan: true, scanConcurrency: 0 },
  metadata: { anidbClient: "", anidbClientVer: 1, tmdbKey: "", tvdbKey: "" },
  plex: { url: "", token: "", enabled: false, pathMappings: [] },
  cutover: { allowArrWrites: false },
  notify: { discordWebhook: "", ntfyUrl: "", ntfyToken: "", events: { grabbed: true, imported: true, failed: true, paused: true, indexer: true } },
  downloads: { rules: [], freeSpaceGb: 50, freeSpacePath: "", excludeSeeding: true, cleanup: "plan", allowDelete: false, minRatio: 1, minSeedDays: 7, maxSeedDays: 30 },
  media: {
    renameEpisodes: true,
    replaceIllegalCharacters: true,
    colonReplacement: "smart",
    multiEpisodeStyle: "prefixedRange",
    standardEpisodeFormat: "{Series TitleYear} - S{season:00}E{episode:00} - {Episode CleanTitle} [{Quality Full}]{[MediaInfo VideoDynamicRangeType]}{[Mediainfo AudioCodec}{ Mediainfo AudioChannels]}{[MediaInfo VideoCodec]}{-Release Group}",
    dailyEpisodeFormat: "{Series TitleYear} - {Air-Date} - {Episode CleanTitle} [{Quality Full}]{-Release Group}",
    animeEpisodeFormat: "{Series TitleYear} - S{season:00}E{episode:00} - {absolute:000} - {Episode CleanTitle} [{Quality Full}]{[MediaInfo VideoDynamicRangeType]}[{MediaInfo VideoBitDepth}bit]{[MediaInfo VideoCodec]}[{Mediainfo AudioCodec} { Mediainfo AudioChannels}]{MediaInfo AudioLanguages}{-Release Group}",
    seriesFolderFormat: "{Series TitleYear}",
    seasonFolderFormat: "Season {season:00}",
    specialsFolderFormat: "Specials",
    creditlessAs: "s00",
    renameMovies: true,
    movieColonReplacement: "smart",
    movieFormat: "{Movie CleanTitle} {(Release Year)} {imdb-{ImdbId}} {edition-{Edition Tags}} {[Quality Full]}{[MediaInfo 3D]}{[MediaInfo VideoDynamicRangeType]}{[Mediainfo AudioCodec}{ Mediainfo AudioChannels]}{[MediaInfo VideoCodec]}{-Release Group}",
    movieFolderFormat: "{Movie CleanTitle} ({Release Year})",
    createEmptyFolders: false,
    deleteEmptyFolders: false,
    episodeTitleRequired: "always",
    skipFreeSpaceCheck: false,
    minimumFreeSpaceMb: 100,
    useHardlinks: true,
    importExtraFiles: true,
    extraFileExtensions: "srt,ass,ssa,sub,idx,sup",
    propers: "preferAndUpgrade",
    unmonitorDeleted: false,
    fileDate: "none",
    recycleBin: "/media/Recycle/animearr/",
    recycleBinCleanupDays: 14,
    rescanAfterRefresh: "always",
    analyseVideoFiles: true,
    setPermissions: false,
    chmodFolder: "775",
    chownGroup: "",
    renameAfterReencode: false,
    importedFromArr: false,
  },
  importer: { engine: "animearr", allowReal: true, allowRename: false, realBudget: -1, movies: true, sourceRoots: ["/data/completed/animearr", "/data/qbittorrent/completed/animearr"] },
  scope: { ended: { seasons: "all", recentN: 3, episodes: "missing", specials: false, creditless: true }, continuing: { seasons: "latest", recentN: 1, episodes: "futureAndMissing", specials: false, creditless: true } },
  fillIn: { paused: false, waveSize: 5, advancePct: 90, stallDays: 7 },
  sync: { intervalHours: 6 },
  externalUrl: "",
  urlBase: "",
  ui: { language: "en", textScale: "md" },
  auth: { username: "", passwordHash: "", bypassLocal: false },
  apiKey: "",
  secret: "",
};

const SECRET_PATHS = ["sonarr.apiKey", "radarr.apiKey", "prowlarr.apiKey", "sabnzbd.apiKey", "qbittorrent.password", "metadata.tmdbKey", "metadata.tvdbKey", "plex.token", "notify.discordWebhook", "notify.ntfyToken"] as const; // (an ntfy topic on ntfy.sh is guessable-by-name only; kept visible so it can be shared)
/** Settings the browser may change through PUT /api/settings. Everything else has its own endpoint. */
const EDITABLE = ["sonarr", "radarr", "prowlarr", "sabnzbd", "qbittorrent", "protocol", "remotePathMappings", "localPathMappings", "allowedRoots", "managed", "repair", "backlog", "queueHealth", "extraction", "dualUpgrade", "movieSearch", "library", "metadata", "media", "downloads", "plex", "notify", "scope", "fillIn", "sync", "externalUrl", "urlBase", "ui"];
/** Each secret is only valid for the address it was saved with: if the address changes, a masked secret is dropped. */
const SECRET_FOR_URL: [string, string][] = [
  ["sonarr.url", "sonarr.apiKey"],
  ["radarr.url", "radarr.apiKey"],
  ["prowlarr.url", "prowlarr.apiKey"],
  ["sabnzbd.url", "sabnzbd.apiKey"],
  ["qbittorrent.url", "qbittorrent.password"],
  ["plex.url", "plex.token"],
  ["notify.ntfyUrl", "notify.ntfyToken"],
];
const NUMERIC_ARRAYS = new Set(["prowlarr.categories", "prowlarr.indexerIds", "prowlarr.knownIds", "prowlarr.newIds", "radarr.animeProfileIds", "managed.backoffMin"]);
const SEASONS = ["all", "first", "latest", "recent"];
const EPISODES = ["all", "missing", "future", "futureAndMissing", "existing", "none"];
const ENUMS: Record<string, readonly string[]> = {
  "ui.textScale": ["sm", "md", "lg", "xl"],
  "repair.mode": ["off", "log", "auto"],
  "dualUpgrade.mode": ["off", "log", "auto"],
  "media.colonReplacement": ["delete", "dash", "spaceDash", "spaceDashSpace", "smart"],
  "media.creditlessAs": ["s00", "extras"],
  "downloads.cleanup": ["off", "plan", "auto"],
  "media.movieColonReplacement": ["delete", "dash", "spaceDash", "spaceDashSpace", "smart"],
  "media.multiEpisodeStyle": ["extend", "duplicate", "repeat", "scene", "range", "prefixedRange"],
  "media.episodeTitleRequired": ["always", "bulkSeasonReleases", "never"],
  "media.propers": ["preferAndUpgrade", "doNotUpgrade", "doNotPrefer"],
  "media.fileDate": ["none", "localAirDate", "utcAirDate"],
  "media.rescanAfterRefresh": ["always", "afterManual", "never"],
  "scope.ended.seasons": SEASONS,
  "scope.ended.episodes": EPISODES,
  "scope.continuing.seasons": SEASONS,
  "scope.continuing.episodes": EPISODES,
};
const RANGES: Record<string, [number, number]> = {
  "managed.searchDelayMin": [0, 1440],
  "protocol.usenetDelayMin": [0, 10080],
  "protocol.torrentDelayMin": [0, 10080],
  "managed.maxAttempts": [1, 100],
  "managed.rssMin": [0, 1440],
  "managed.minConfidence": [50, 100],
  "sync.intervalHours": [1, 168],
  "repair.maxPerDay": [1, 100],
  "backlog.perHour": [1, 24],
  "backlog.retryDays": [1, 60],
  "queueHealth.stallHours": [1, 72],
  "dualUpgrade.perHour": [1, 24],
  "movieSearch.delayHours": [0, 168],
  "scope.ended.recentN": [1, 100],
  "scope.continuing.recentN": [1, 100],
  "fillIn.waveSize": [1, 50],
  "metadata.anidbClientVer": [1, 99],
  "media.minimumFreeSpaceMb": [0, 1_000_000],
  "downloads.freeSpaceGb": [1, 100_000],
  "downloads.minRatio": [0, 100],
  "downloads.minSeedDays": [0, 365],
  "downloads.maxSeedDays": [1, 3650],
  "media.recycleBinCleanupDays": [0, 365],
  "fillIn.advancePct": [50, 100],
  "fillIn.stallDays": [1, 60],
  "movieSearch.perHour": [1, 12],
  "library.scanConcurrency": [0, 8],
  "movieSearch.retryDays": [1, 60],
  "dualUpgrade.recheckDays": [1, 60],
  "dualUpgrade.maxAgeDays": [7, 3650],
  "queueHealth.metadataMin": [10, 1440],
};

export const MASK = "••••••••";
/** True for the mask (or a mangled copy of it); real keys are printable ASCII. */
export const isMasked = (v: unknown) => typeof v === "string" && (v === MASK || /^[^ -~]+$/.test(v));

const rand = (n: number) => crypto.randomBytes(n).toString("hex");

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== "object" || Array.isArray(over) || base === null || typeof base !== "object" || Array.isArray(base)) {
    return (over === undefined ? base : over) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = merge((base as Record<string, unknown>)[k], v);
  return out as T;
}

/** Coerces an untrusted patch into the shape of `shape`, dropping unknown keys and wrong types. */
function sanitize(shape: unknown, patch: unknown, path = ""): unknown {
  if (path === "remotePathMappings" || path === "localPathMappings" || path === "plex.pathMappings") {
    if (!Array.isArray(patch)) return undefined;
    return patch
      .filter((x) => x && typeof x === "object")
      .map((x) => ({ from: String((x as PathMapping).from ?? "").trim(), to: String((x as PathMapping).to ?? "").trim() }))
      .filter((x) => x.from && x.to)
      .slice(0, 20);
  }
  if (path === "profiles") return undefined; // edited through /api/profiles only
  if (path === "downloads.allowDelete" || path === "cutover.allowArrWrites") return undefined; // own confirmed endpoints only
  if (path === "notify.discordWebhook") {
    const v = String(patch ?? "").trim();
    if (v === "" || v === MASK || /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+(?:\?[\w=&-]*)?$/.test(v)) return v;
    throw Object.assign(new Error("That isn't a Discord webhook URL (https://discord.com/api/webhooks/…)"), { statusCode: 400 });
  }
  if (path === "notify.ntfyUrl") {
    const v = String(patch ?? "").trim().replace(/\/+$/, "");
    if (v === "") return v;
    let u: URL | null = null;
    try {
      u = new URL(v);
    } catch {
      u = null;
    }
    if (u && /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash && u.pathname.length > 1 && !/^(169\.254\.|0\.|\[?fe80:|\[::ffff:169\.254)/i.test(u.hostname)) return v;
    throw Object.assign(new Error("That isn't an ntfy topic URL (e.g. https://ntfy.sh/my-topic)"), { statusCode: 400 });
  }
  if (path === "downloads.rules") {
    if (!Array.isArray(patch)) return undefined;
    const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
    return patch
      .filter((x) => x && typeof x === "object")
      .slice(0, 20)
      .map((x, i) => {
        const r = x as Record<string, unknown>;
        const n = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.min(1_000_000, Math.round(Number(v))) : d);
        return {
          id: /^[\w-]{1,40}$/.test(String(r.id ?? "")) ? String(r.id) : `rule-${Date.now().toString(36)}-${i}`,
          name: String(r.name ?? "Rule").trim().slice(0, 60) || "Rule",
          metric: pick(r.metric, ["sizeGb", "items"] as const, "sizeGb"),
          threshold: n(r.threshold, 100),
          action: pick(r.action, ["pauseUntilUnder", "pauseUntilCleared", "pauseAndClean"] as const, "pauseUntilUnder"),
          resumeAt: r.resumeAt === null || r.resumeAt === undefined || r.resumeAt === "" ? null : n(r.resumeAt, 0),
          scope: pick(r.scope, ["shows", "movies", "both"] as const, "both"),
          applies: pick(r.applies, ["all", "backlog"] as const, "all"),
          enabled: r.enabled !== false,
        };
      });
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(patch)) return undefined;
    if (NUMERIC_ARRAYS.has(path)) return patch.map(Number).filter((x) => Number.isFinite(x) && x >= 0).slice(0, 50);
    return patch.map((x) => String(x).trim()).filter((x) => x !== "" && x.length < 300).slice(0, 50);
  }
  if (shape !== null && typeof shape === "object") {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (!(k in (shape as object))) continue;
      const clean = sanitize((shape as Record<string, unknown>)[k], v, path ? `${path}.${k}` : k);
      if (clean !== undefined) out[k] = clean;
    }
    return out;
  }
  if (typeof shape === "boolean") return typeof patch === "boolean" ? patch : undefined;
  if (typeof shape === "number") {
    const n = Number(patch);
    if (!Number.isFinite(n)) return undefined;
    const r = RANGES[path];
    return r ? Math.min(r[1], Math.max(r[0], Math.round(n))) : n;
  }
  if (typeof shape === "string") {
    if (patch === null || patch === undefined) return undefined;
    const s = String(patch).trim();
    if (ENUMS[path] && !ENUMS[path].includes(s)) return undefined;
    return s.slice(0, 500);
  }
  return undefined;
}

let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  let stored: Record<string, unknown> = {};
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | undefined;
    if (row) stored = JSON.parse(open(row.value)) as Record<string, unknown>;
  } catch (e) {
    if (!dbState.corrupt) throw new Error(`Can't read settings (${(e as Error).message}). Was secret.key replaced? Put the original back, or restore a backup together with its key.`);
  }
  let s = merge(DEFAULTS, stored);
  // Migration: the single 0.1 "profile" becomes the seeded default profile.
  const old = stored.profile as { subLangs?: string[]; softOnly?: boolean; preferUncensored?: boolean; protocolOrder?: ("usenet" | "torrent")[]; resolution?: number } | undefined;
  let migrated = false;
  if (old && !stored.profiles) {
    const langs = (old.subLangs ?? []).map((x) => String(x).trim().toLowerCase()).filter((x) => /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(x));
    s = { ...s, profiles: [{ ...DEFAULT_PROFILE, subLangs: langs.length ? langs : DEFAULT_PROFILE.subLangs, softOnly: old.softOnly ?? true, preferUncensored: old.preferUncensored ?? true, protocolOrder: old.protocolOrder ?? DEFAULT_PROFILE.protocolOrder, resolution: old.resolution ?? 1080 }], defaultProfileId: "default" };
    delete (s as unknown as Record<string, unknown>).profile;
    migrated = true;
  }
  if (!s.profiles.length) s = { ...s, profiles: [DEFAULT_PROFILE], defaultProfileId: "default" };
  if (!s.profiles.some((p) => p.id === s.defaultProfileId)) s = { ...s, defaultProfileId: s.profiles[0].id };
  const missing = !s.apiKey || !s.secret || migrated;
  if (missing) s = { ...s, apiKey: s.apiKey || rand(16), secret: s.secret || rand(32) };
  if (missing && !dbState.corrupt) write(s);
  cache = s;
  return s;
}

function write(s: Settings) {
  if (dbState.corrupt) throw Object.assign(new Error("The database failed its integrity check; restore a backup first"), { statusCode: 503 });
  db.prepare("INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(seal(JSON.stringify(s)));
  cache = s;
}

function getPath(o: unknown, p: string): unknown {
  return p.split(".").reduce<unknown>((a, k) => (a as Record<string, unknown> | undefined)?.[k], o);
}

function setPath(o: Record<string, unknown>, p: string, v: unknown) {
  const keys = p.split(".");
  let cur = o;
  for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  cur[keys.at(-1)!] = v;
}

/** Settings as sent to the browser: every secret masked, hashes and signing keys removed. */
export function publicSettings() {
  const s = structuredClone(getSettings()) as unknown as Record<string, unknown>;
  for (const p of SECRET_PATHS) if (getPath(s, p)) setPath(s, p, MASK);
  // Added clients and direct indexers: their passwords/keys never leave masked either.
  s.extraClients = ((s.extraClients as ClientCfg[] | undefined) ?? []).map((c) => ({ ...c, password: c.password ? MASK : "" }));
  s.indexers = ((s.indexers as IndexerCfg[] | undefined) ?? []).map((x) => ({ ...x, apiKey: x.apiKey ? MASK : "" }));
  const auth = s.auth as Record<string, unknown>;
  auth.hasPassword = !!auth.passwordHash;
  delete auth.passwordHash;
  delete s.secret;
  delete s.apiKey;
  return s;
}

const trimUrl = (u: string) => u.trim().replace(/\/+$/, "");

/** Applies an untrusted partial update from the browser. Masked secrets mean "unchanged". */
export function updateSettings(patch: unknown) {
  const cur = getSettings();
  const clean = (sanitize(DEFAULTS, patch) ?? {}) as Record<string, unknown>;
  const allowed: Record<string, unknown> = {};
  for (const p of EDITABLE) if (clean[p] !== undefined) allowed[p] = clean[p];
  const next = merge(cur, allowed) as Settings;
  // Arrays replace rather than merge (merge() already replaces arrays; this keeps it explicit).
  for (const p of ["remotePathMappings", "localPathMappings", "allowedRoots"] as const) if (allowed[p]) (next as unknown as Record<string, unknown>)[p] = allowed[p];
  for (const p of SECRET_PATHS) if (isMasked(getPath(next, p))) setPath(next as unknown as Record<string, unknown>, p, getPath(cur, p));
  for (const k of ["sonarr", "radarr", "prowlarr", "sabnzbd", "qbittorrent", "plex"] as const) next[k].url = trimUrl(next[k].url);
  next.allowedRoots = next.allowedRoots.map((r) => r.replace(/\/+$/, "")).filter(Boolean);
  if (!next.managed.backoffMin.length) next.managed.backoffMin = DEFAULTS.managed.backoffMin;
  for (const [u, k] of SECRET_FOR_URL) {
    const [svc, field] = k.split(".");
    const sv = (allowed[svc] as Record<string, unknown> | undefined)?.[field];
    const keptOld = sv === undefined || isMasked(sv);
    if (keptOld && trimUrl(String(getPath(next, u) ?? "")) !== trimUrl(String(getPath(cur, u) ?? ""))) setPath(next as unknown as Record<string, unknown>, k, "");
  }
  next.externalUrl = trimUrl(next.externalUrl);
  write(next);
  return next;
}

export function setBypassLocal(on: boolean) {
  write({ ...getSettings(), auth: { ...getSettings().auth, bypassLocal: on } });
}

/** Internal update that skips sanitising. */
export function patchSettings(fn: (s: Settings) => Settings) {
  write(fn(structuredClone(getSettings())));
}

export function regenerateApiKey() {
  const s = { ...getSettings(), apiKey: rand(16) };
  write(s);
  return s.apiKey;
}

export async function setAccount(username: string, password: string) {
  const salt = crypto.randomBytes(16);
  const hash = `${salt.toString("hex")}:${(await scrypt(password, salt, 32)).toString("hex")}`;
  const s = getSettings();
  // A new secret invalidates every existing session.
  write({ ...s, auth: { ...s.auth, username, passwordHash: hash }, secret: rand(32) });
}

export async function checkPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const want = Buffer.from(hash, "hex");
  const got = await scrypt(pw, Buffer.from(salt, "hex"), 32);
  return want.length === got.length && crypto.timingSafeEqual(got, want);
}

/** Fresh installs start with this login; the app nags until the password is changed. */
export const DEFAULT_LOGIN = { username: "admin", password: "animearr" } as const;

/** Creates the default account on a fresh install (no account yet). */
export async function ensureDefaultAccount() {
  if (dbState.corrupt || getSettings().auth.passwordHash) return false;
  await setAccount(DEFAULT_LOGIN.username, DEFAULT_LOGIN.password);
  return true;
}

let defaultCheck: { hash: string; result: boolean } | null = null;
/** True while the account password is still the default one (cached per stored hash, so it costs one scrypt). */
export async function usingDefaultPassword() {
  const hash = getSettings().auth.passwordHash;
  if (!hash) return false;
  if (defaultCheck?.hash !== hash) defaultCheck = { hash, result: await checkPassword(DEFAULT_LOGIN.password, hash) };
  return defaultCheck.result;
}

export function safeEqual(a: string | undefined, b: string) {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Effective dry-run: real actions need BOTH the global switch and the show's own switch off. */
export function isDryRun(showDryRun: boolean | null) {
  return getSettings().managed.dryRun || showDryRun !== false;
}

/** The allowed-root-folders guard: true when the Sonarr path is inside one of the allowed roots. */
export function underAllowedRoot(seriesPath: string | null | undefined) {
  if (!seriesPath) return false;
  const p = seriesPath.replace(/\\/g, "/");
  return getSettings().allowedRoots.some((r) => {
    const root = r.replace(/\\/g, "/").replace(/\/+$/, "");
    return p === root || p.startsWith(`${root}/`);
  });
}
