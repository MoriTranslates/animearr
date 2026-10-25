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
    throw new ApiError((data?.error as string) ?? res.statusText, res.status, data);
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
  allowedRoots?: string[];
  lastSync?: number | null;
  syncing?: boolean;
  managed?: number;
  librarySeries?: number;
  warnings?: string[];
  uiLanguage?: string;
  defaultPassword?: boolean;
  bypassLocal?: boolean;
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
