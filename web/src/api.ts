/** A problem's fix, as the server describes it (rendered as a button; see server/fixes.ts). */
export interface Fix { action: string; label: string; params?: Record<string, unknown> }

/** The fixes the server sent with recent error messages (so a toast of that message can offer its fix). */
const errorFixes = new Map<string, Fix[]>();
export const fixesForMessage = (msg: string) => errorFixes.get(msg) ?? null;
/** Runs a fix (handled by FixHost in the app shell). */
export const runFix = (f: Fix) => window.dispatchEvent(new CustomEvent("animearr:fix", { detail: f }));

export class ApiError extends Error {
  constructor(message: string, public status: number, public data?: Record<string, unknown>) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["X-AnimeArr"] = "1"; // CSRF guard: cross-site forms can't set custom headers
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`/api${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), credentials: "same-origin", signal: opts.signal });
  const text = await res.text();
  let data: Record<string, unknown> | undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event("animearr:auth"));
    const msg = (data?.error as string) ?? res.statusText;
    if (Array.isArray(data?.fixes) && (data!.fixes as Fix[]).length) {
      errorFixes.set(msg, data!.fixes as Fix[]);
      if (errorFixes.size > 50) errorFixes.delete(errorFixes.keys().next().value!);
    }
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

export interface Status {
  version: string;
  setupRequired: boolean;
  loggedIn: boolean;
  via?: "session" | "local" | "apikey";
  connected?: { sonarr: boolean; radarr: boolean; prowlarr: boolean; sabnzbd: boolean; qbittorrent: boolean };
  dryRun?: boolean;
  grabsPaused?: { why: string; disk: { freeGb: number; animearrGb: number; otherGb: number; label: string; shareFreeGb: number | null } | null; diskRule: boolean } | null;
  dryRunShows?: { tvdbId: number; title: string }[];
  allowedRoots?: string[];
  lastSync?: number | null;
  syncing?: boolean;
  managed?: number;
  librarySeries?: number;
  warnings?: string[];
  uiLanguage?: string;
  defaultPassword?: boolean;
  bypassLocal?: boolean;
  queue?: { active: number; attention: number };
}

export type Tone = "good" | "bad" | "warn" | "info";
export interface Flag { key: string; label: string; tone: Tone }

export interface Decision {
  id: number;
  at: number;
  kind: string;
  tvdbId: number | null;
  title: string;
  episodeIds: number[];
  release: string | null;
  why: string;
  undo: { action: string } | null;
  undoneAt: number | null;
  fixes?: Fix[];
  detail?: Record<string, unknown>;
}

export interface LibraryShow {
  seriesId: number;
  tvdbId: number;
  title: string;
  path: string;
  status: string;
  monitored: boolean;
  tags: (string | number)[];
  cover: string | null;
  network: string | null;
  airingThisSeason: boolean;
  episodesThisSeason: number;
  nextAiring: string | null;
  anidb: string;
  allowed: boolean;
  managed: boolean;
  dryRun: boolean;
}

export interface Episode { id: number; season: number; episode: number; absolute: number | null; title?: string | null; airUtc: number | null; hasFile?: boolean; monitored?: boolean }

export interface ScheduleRow { episodeId: number; season: number | null; episode: number | null; title: string | null; airUtc: number | null; nextAt: number; attempts: number; state: string; why: string }

export interface ManagedShow { tvdbId: number; seriesId: number; title: string; dryRun: boolean; since: number; unmonitoredInSonarr: boolean; cover: string | null; schedule: ScheduleRow[] }

export interface Grab { id: number; at: number; tvdb_id: number; release: string; protocol: string; state: string; dry_run: number; why: string; error: string | null; episode_ids: number[] }

export interface SearchResult {
  guid: string;
  title: string;
  indexer: string;
  protocol: "usenet" | "torrent";
  size: number;
  seeders: number | null;
  ageHours: number | null;
  episodeIds: number[];
  label: string;
  confidence: number;
  coversTarget: boolean;
  extra: number;
  rank: { accept: boolean; score: number; langProb: number; flags: Flag[]; why: string; reject: string | null };
  mappingWhy: string[];
  group: string | null;
}

export interface SearchResponse {
  series: { tvdbId: number; title: string; cover: string | null };
  targets: { id: number; season: number; episode: number; title: string | null; hasFile: boolean }[];
  queries: string[];
  found: number;
  matched: number;
  skipped: Record<string, number>;
  errors: string[];
  tookMs: number;
  results: SearchResult[];
  dryRun: boolean;
  tier: 1 | 2;
  complete: boolean;
}

export interface PathMapping { from: string; to: string }
export interface MediaSettings {
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
  renameMovies: boolean;
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
  importedFromArr: boolean;
}
export interface Settings {
  sonarr: { url: string; apiKey: string; animeTag: string };
  radarr: { url: string; apiKey: string; animeRoots: string[]; animeProfileIds: number[] };
  prowlarr: { url: string; apiKey: string; categories: number[]; indexerIds: number[] };
  sabnzbd: { url: string; apiKey: string; category: string };
  qbittorrent: { url: string; username: string; password: string; category: string };
  remotePathMappings: PathMapping[];
  localPathMappings: PathMapping[];
  allowedRoots: string[];
  defaultProfileId: string;
  managed: { dryRun: boolean; searchDelayMin: number; backoffMin: number[]; maxAttempts: number; rssMin: number; minConfidence: number };
  repair: { mode: "off" | "log" | "auto"; maxPerDay: number };
  backlog: { enabled: boolean; perHour: number; retryDays: number };
  queueHealth: { stallHours: number; metadataMin: number; removeFailed: boolean };
  extraction: { enabled: boolean };
  dualUpgrade: { mode: "off" | "log" | "auto"; perHour: number; recheckDays: number; maxAgeDays: number };
  movieSearch: { enabled: boolean; delayHours: number; perHour: number; retryDays: number };
  scope: { ended: import("./scope").Scope; continuing: import("./scope").Scope };
  metadata: { anidbClient: string; anidbClientVer: number; tmdbKey: string; tvdbKey: string };
  fillIn: { paused: boolean; waveSize: number; advancePct: number; stallDays: number };
  media: MediaSettings;
  plex: { url: string; token: string; enabled: boolean; pathMappings: PathMapping[] };
  notify: { discordWebhook: string; ntfyUrl: string; ntfyToken: string; events: { grabbed: boolean; imported: boolean; failed: boolean; paused: boolean } };
  downloads: { rules: import("./downloads").FolderRule[]; freeSpaceGb: number; freeSpacePath: string; excludeSeeding: boolean; cleanup: "off" | "plan" | "auto"; allowDelete: boolean; minRatio: number; minSeedDays: number; maxSeedDays: number };
  importer: { engine: "sonarr" | "animearr"; allowReal: boolean; allowRename: boolean; realBudget: number; movies: boolean; sourceRoots: string[] };
  sync: { intervalHours: number };
  externalUrl: string;
  ui: { language: string };
  auth: { username: string; hasPassword: boolean; bypassLocal: boolean };
}

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`animearr.${key}`);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(`animearr.${key}`, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
};

export const fmtSize = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.round(b / 1e6)} MB`);
export const sxe = (s: number | null, e: number | null) => (s === null || e === null ? "" : `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`);
