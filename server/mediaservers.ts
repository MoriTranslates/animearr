/**
 * Jellyfin, Emby and Kodi notify, the same job as server/plex.ts: after AnimeArr's own importer or renamer changed a
 * folder, the server is told to look at just that folder. Read-only otherwise: AnimeArr never changes a server's
 * library settings, metadata or watch state.
 *
 * - Jellyfin: POST /Library/Media/Updated (Jellyfin.Api LibraryController), `Authorization: MediaBrowser Token="…"`.
 * - Emby: the same endpoint under /emby, `X-Emby-Token` (Emby's API-key authentication).
 * - Kodi: JSON-RPC `VideoLibrary.Scan` with the folder as `directory` (Kodi's json-rpc methods.json), basic auth.
 *
 * Keys and passwords are stored encrypted in the settings (never logged). Paths are mapped from AnimeArr's view to the
 * server's with each server's own path mappings (longest prefix wins).
 */
import { logDecision } from "./activity.js";
import { toPlexPath as mapPath } from "./plex.js";
import { getSettings, type MediaServerConn, type PathMapping } from "./settings.js";
import { VERSION as appVersion } from "./version.js";

export type NotifyKind = "jellyfin" | "emby" | "kodi";
export const SERVER_NAMES: Record<NotifyKind, string> = { jellyfin: "Jellyfin", emby: "Emby", kodi: "Kodi" };
export interface KodiConn { url: string; username: string; password: string }
type Fetch = typeof fetch;

/** Same address rules as Plex: http(s) only, no link-local or cloud-metadata hosts. */
function checkUrl(url: string, name: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`The ${name} address isn't a valid URL`);
  }
  if (!/^https?:$/.test(u.protocol) || /^(169\.254\.|0\.|\[?fe80:)/i.test(u.hostname) || u.hostname === "metadata.google.internal") throw new Error(`That ${name} address isn't allowed`);
  return url.replace(/\/+$/, "");
}

async function call<T>(name: string, url: string, init: RequestInit, f: Fetch): Promise<T | null> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new Error(`${name} unreachable (${(e as Error).message})`);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`${name} refused the ${name === "Kodi" ? "login" : "API key"} (${res.status})`);
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
  const text = await res.text();
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

/** Jellyfin/Emby request: Jellyfin takes the MediaBrowser Authorization header, Emby its X-Emby-Token header. */
export function embyRequest(kind: "jellyfin" | "emby", conn: { url: string; apiKey: string }, p: string, body?: unknown) {
  const name = SERVER_NAMES[kind];
  if (!conn.url || !conn.apiKey) throw new Error(`${name} is not configured`);
  const base = checkUrl(conn.url, name);
  const auth: Record<string, string> =
    kind === "jellyfin"
      ? { Authorization: `MediaBrowser Client="AnimeArr", Device="AnimeArr", DeviceId="animearr", Version="${appVersion}", Token="${conn.apiKey}"` }
      : { "X-Emby-Token": conn.apiKey };
  const url = `${base}${kind === "emby" && !/\/emby$/i.test(base) ? "/emby" : ""}${p}`;
  const init: RequestInit = { method: body === undefined ? "GET" : "POST", headers: { Accept: "application/json", ...auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  return { name, url, init };
}

/** Connection test: server name and version (GET /System/Info, needs a valid key). */
export async function testEmbyLike(kind: "jellyfin" | "emby", conn: { url: string; apiKey: string }, f: Fetch = fetch) {
  const r = embyRequest(kind, conn, "/System/Info");
  const info = await call<{ ServerName?: string; Version?: string }>(r.name, r.url, r.init, f);
  return { version: info?.Version ?? "?", name: info?.ServerName ?? r.name };
}

/** Kodi JSON-RPC request (basic auth when a username is set). */
export function kodiRequest(conn: KodiConn, method: string, params: Record<string, unknown> = {}) {
  if (!conn.url) throw new Error("Kodi is not configured");
  const base = checkUrl(conn.url, "Kodi");
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (conn.username) headers.Authorization = `Basic ${Buffer.from(`${conn.username}:${conn.password}`).toString("base64")}`;
  return { url: `${base.replace(/\/jsonrpc$/i, "")}/jsonrpc`, init: { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) } as RequestInit };
}

async function kodiCall<T>(conn: KodiConn, method: string, params: Record<string, unknown>, f: Fetch) {
  const r = kodiRequest(conn, method, params);
  const out = await call<{ result?: T; error?: { message?: string } }>("Kodi", r.url, r.init, f);
  if (out?.error) throw new Error(`Kodi: ${out.error.message ?? "JSON-RPC error"}`);
  return out?.result ?? null;
}

export async function testKodi(conn: KodiConn, f: Fetch = fetch) {
  const app = await kodiCall<{ name?: string; version?: { major: number; minor: number } }>(conn, "Application.GetProperties", { properties: ["name", "version"] }, f);
  return { version: app?.version ? `${app.version.major}.${app.version.minor}` : "?", name: app?.name ?? "Kodi" };
}

/** Tells one server about these folders (its own paths). */
export async function scanFolders(kind: NotifyKind, folders: string[], f: Fetch = fetch) {
  const s = getSettings();
  if (kind === "kodi") {
    // One scan per folder; Kodi wants a trailing slash on a directory.
    for (const p of folders) await kodiCall(s.kodi, "VideoLibrary.Scan", { directory: p.endsWith("/") ? p : `${p}/`, showdialogs: false }, f);
    return;
  }
  const r = embyRequest(kind, s[kind], "/Library/Media/Updated", { Updates: folders.map((p) => ({ Path: p, UpdateType: "Modified" })) });
  await call(r.name, r.url, r.init, f);
}

const configured = (kind: NotifyKind, s = getSettings()) => {
  const c = s[kind] as MediaServerConn | (KodiConn & { enabled: boolean });
  return c.enabled && !!c.url && (kind === "kodi" || !!(c as MediaServerConn).apiKey);
};
const mappingsOf = (kind: NotifyKind): PathMapping[] => (getSettings()[kind] as { pathMappings: PathMapping[] }).pathMappings ?? [];

const pending: Record<NotifyKind, Set<string>> = { jellyfin: new Set(), emby: new Set(), kodi: new Set() };
let timer: NodeJS.Timeout | null = null;

/** Queues a look at these folders (AnimeArr paths) on every enabled server; they go out together a few seconds later. */
export function notifyMediaServers(folders: string[], deps: { scan: typeof scanFolders } = { scan: scanFolders }, delayMs = 15_000) {
  const kinds = (Object.keys(pending) as NotifyKind[]).filter((k) => configured(k));
  if (!kinds.length) return;
  for (const k of kinds) for (const f of folders) if (f) pending[k].add(f.replace(/\/+$/, ""));
  if (timer) return;
  timer = setTimeout(() => void flushMediaServers(deps).catch(() => undefined), delayMs);
  timer.unref?.();
}

export async function flushMediaServers(deps: { scan: typeof scanFolders } = { scan: scanFolders }) {
  if (timer) clearTimeout(timer);
  timer = null;
  const out: { server: NotifyKind; folders: string[]; ok: boolean; why: string }[] = [];
  for (const kind of Object.keys(pending) as NotifyKind[]) {
    const folders = [...pending[kind]].map((f) => mapPath(f, mappingsOf(kind)));
    pending[kind].clear();
    if (!folders.length || !configured(kind)) continue;
    try {
      await deps.scan(kind, folders);
      out.push({ server: kind, folders, ok: true, why: "scan asked" });
    } catch (e) {
      out.push({ server: kind, folders, ok: false, why: (e as Error).message });
    }
  }
  for (const r of out)
    logDecision(r.ok ? "info" : "fail", { why: `${SERVER_NAMES[r.server]}: ${r.ok ? `asked to scan ${r.folders.slice(0, 3).join(", ")}${r.folders.length > 3 ? "…" : ""}` : `couldn't scan ${r.folders.slice(0, 2).join(", ")}: ${r.why}`}` });
  return out;
}
