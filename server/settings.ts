import crypto from "node:crypto";
import { promisify } from "node:util";
import { db, dbState } from "./db.js";
import { open, seal } from "./secretbox.js";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export interface PathMapping {
  /** Path as Sonarr / the download client sees it, e.g. /media/Anime or /data. */
  from: string;
  /** Same place as the other side sees it, e.g. //NAS/Anime (Windows) or /path/to/Anime. */
  to: string;
}

/** The one language profile of 1.0 (PROPOSAL §5.4). Codes are BCP-47-style: en, es, pt, fr, ja ... */
export interface LanguageProfile {
  name: string;
  /** "Sub only" is the 1.0 watch mode; dub/dual modes are 2.0 (BACKLOG.md). */
  watchMode: "sub";
  /** Subtitle languages that make a file watchable, best first. */
  subLangs: string[];
  /** Preferred audio languages, best first (the original language is usually first). */
  audioLangs: string[];
  /** Avoid burned-in subs when a soft-sub alternative exists. */
  softOnly: boolean;
  preferUncensored: boolean;
  /** Protocol order, e.g. usenet before torrent. */
  protocolOrder: ("usenet" | "torrent")[];
  /** Preferred resolution (lines). */
  resolution: number;
}

export interface Settings {
  sonarr: { url: string; apiKey: string; /** Optional: also import series with this Sonarr tag even when not seriesType=anime. */ animeTag: string };
  radarr: { url: string; apiKey: string; /** Movies under these root folders count as anime. */ animeRoots: string[]; animeProfileIds: number[] };
  prowlarr: { url: string; apiKey: string; /** Newznab categories searched. */ categories: number[]; indexerIds: number[] };
  sabnzbd: { url: string; apiKey: string; category: string };
  qbittorrent: { url: string; username: string; password: string; category: string };
  /** Download-client path → Sonarr path (like Sonarr's remote path mappings). */
  remotePathMappings: PathMapping[];
  /** Sonarr/client path → path on the machine running AnimeArr (for ffprobe and sidecar checks). */
  localPathMappings: PathMapping[];
  /**
   * Safety guard: AnimeArr only manages and imports series whose Sonarr path is under one of these root folders
   * (e.g. /media/AnimeArr). Empty = nothing can be managed or imported until the user picks one.
   */
  allowedRoots: string[];
  profile: LanguageProfile;
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
  sync: { intervalHours: number };
  /** Address phones reach AnimeArr at (reverse proxy URL). */
  externalUrl: string;
  ui: { language: string };
  auth: { username: string; passwordHash: string; bypassLocal: boolean };
  /** Admin API key, accepted only in the X-Api-Key header. */
  apiKey: string;
  secret: string;
}

export const DEFAULT_PROFILE: LanguageProfile = {
  name: "Anime: JP audio + EN subs",
  watchMode: "sub",
  subLangs: ["en"],
  audioLangs: ["ja"],
  softOnly: true,
  preferUncensored: true,
  protocolOrder: ["usenet", "torrent"],
  resolution: 1080,
};

const DEFAULTS: Settings = {
  sonarr: { url: "", apiKey: "", animeTag: "" },
  radarr: { url: "", apiKey: "", animeRoots: [], animeProfileIds: [] },
  prowlarr: { url: "", apiKey: "", categories: [5070, 5000, 2000], indexerIds: [] },
  sabnzbd: { url: "", apiKey: "", category: "animearr" },
  qbittorrent: { url: "", username: "", password: "", category: "animearr" },
  remotePathMappings: [],
  localPathMappings: [],
  allowedRoots: [],
  profile: DEFAULT_PROFILE,
  managed: { dryRun: true, searchDelayMin: 45, backoffMin: [30, 60, 120, 240, 480], maxAttempts: 12, rssMin: 15, minConfidence: 80 },
  sync: { intervalHours: 6 },
  externalUrl: "",
  ui: { language: "en" },
  auth: { username: "", passwordHash: "", bypassLocal: false },
  apiKey: "",
  secret: "",
};

const SECRET_PATHS = ["sonarr.apiKey", "radarr.apiKey", "prowlarr.apiKey", "sabnzbd.apiKey", "qbittorrent.password"] as const;
/** Settings the browser may change through PUT /api/settings. Everything else has its own endpoint. */
const EDITABLE = ["sonarr", "radarr", "prowlarr", "sabnzbd", "qbittorrent", "remotePathMappings", "localPathMappings", "allowedRoots", "profile", "managed", "sync", "externalUrl", "ui"];
/** Each secret is only valid for the address it was saved with: if the address changes, a masked secret is dropped. */
const SECRET_FOR_URL: [string, string][] = [
  ["sonarr.url", "sonarr.apiKey"],
  ["radarr.url", "radarr.apiKey"],
  ["prowlarr.url", "prowlarr.apiKey"],
  ["sabnzbd.url", "sabnzbd.apiKey"],
  ["qbittorrent.url", "qbittorrent.password"],
];
const NUMERIC_ARRAYS = new Set(["prowlarr.categories", "prowlarr.indexerIds", "radarr.animeProfileIds", "managed.backoffMin"]);
const ENUMS: Record<string, readonly string[]> = { "profile.watchMode": ["sub"] };
const RANGES: Record<string, [number, number]> = {
  "managed.searchDelayMin": [0, 1440],
  "managed.maxAttempts": [1, 100],
  "managed.rssMin": [0, 1440],
  "managed.minConfidence": [50, 100],
  "profile.resolution": [360, 2160],
  "sync.intervalHours": [1, 168],
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
  if (path === "remotePathMappings" || path === "localPathMappings") {
    if (!Array.isArray(patch)) return undefined;
    return patch
      .filter((x) => x && typeof x === "object")
      .map((x) => ({ from: String((x as PathMapping).from ?? "").trim(), to: String((x as PathMapping).to ?? "").trim() }))
      .filter((x) => x.from && x.to)
      .slice(0, 20);
  }
  if (path === "profile.protocolOrder") {
    if (!Array.isArray(patch)) return undefined;
    const v = [...new Set(patch.map(String).filter((x) => x === "usenet" || x === "torrent"))];
    return v.length ? v : undefined;
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
  const missing = !s.apiKey || !s.secret;
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
  for (const k of ["sonarr", "radarr", "prowlarr", "sabnzbd", "qbittorrent"] as const) next[k].url = trimUrl(next[k].url);
  next.allowedRoots = next.allowedRoots.map((r) => r.replace(/\/+$/, "")).filter(Boolean);
  if (!next.profile.subLangs.length) next.profile.subLangs = cur.profile.subLangs;
  next.profile.subLangs = next.profile.subLangs.map((x) => x.toLowerCase());
  next.profile.audioLangs = next.profile.audioLangs.map((x) => x.toLowerCase());
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
