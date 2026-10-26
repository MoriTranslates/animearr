/**
 * First-run setup wizard (generic framework + the two paths: "I'm new" and "I already use Sonarr/Radarr").
 * Server side: its saved progress (resumable), a folder browser over the container's mounts, creating AnimeArr's
 * category in SABnzbd/qBittorrent, and a read-only preview of what an existing Sonarr/Radarr setup has.
 */
import fs from "node:fs";
import path from "node:path";
import { getSettings, patchSettings } from "./settings.js";
import { jsonCall } from "./arr/http.js";
import { logDecision } from "./activity.js";
import { cache } from "./db.js";

export interface WizardState { done: boolean; path: "new" | "migrate" | null; step: string; completed: string[]; updatedAt: number }
const EMPTY: WizardState = { done: false, path: null, step: "welcome", completed: [], updatedAt: 0 };

export const wizardState = (): WizardState => ({ ...EMPTY, ...((getSettings() as unknown as { wizard?: Partial<WizardState> }).wizard ?? {}) });

export function saveWizard(input: Record<string, unknown>) {
  const cur = wizardState();
  const next: WizardState = {
    done: typeof input.done === "boolean" ? input.done : cur.done,
    path: input.path === "new" || input.path === "migrate" ? input.path : input.path === null ? null : cur.path,
    step: typeof input.step === "string" && /^[\w-]{1,40}$/.test(input.step) ? input.step : cur.step,
    completed: Array.isArray(input.completed) ? [...new Set(input.completed.map(String).filter((x) => /^[\w-]{1,40}$/.test(x)))].slice(0, 40) : cur.completed,
    updatedAt: Date.now(),
  };
  patchSettings((s) => ({ ...s, wizard: next }) as typeof s);
  if (next.done && !cur.done) logDecision("info", { why: `Setup finished (${next.path === "migrate" ? "coming from Sonarr/Radarr" : "new setup"})` });
  return next;
}

/** Folders under a path (directories only), with whether AnimeArr can write there. Never file contents. */
export function listFolders(p: string) {
  const dir = path.posix.normalize(p && p.startsWith("/") ? p : "/").replace(/\/+$/, "") || "/";
  const real = process.platform === "win32" ? dir : dir;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(real, { withFileTypes: true });
  } catch (e) {
    throw Object.assign(new Error(`Can't open ${dir} (${(e as NodeJS.ErrnoException).code ?? "error"})`), { statusCode: 400 });
  }
  const writable = (d: string) => {
    try {
      fs.accessSync(d, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  const skip = /^(proc|sys|dev|run|etc|usr|bin|sbin|lib|lib64|boot|var|tmp|opt|srv|root|home|app)$/;
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !(dir === "/" && skip.test(e.name)))
    .map((e) => ({ name: e.name, path: path.posix.join(dir, e.name), writable: writable(path.posix.join(dir, e.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 500);
  return { path: dir, parent: dir === "/" ? null : path.posix.dirname(dir), writable: writable(dir), dirs };
}

/** Creates AnimeArr's category in SABnzbd or qBittorrent (so its downloads stay apart from Sonarr's/Radarr's). */
export async function createCategory(client: "sabnzbd" | "qbittorrent") {
  const s = getSettings();
  if (client === "sabnzbd") {
    const c = s.sabnzbd;
    if (!c.url || !c.apiKey) throw Object.assign(new Error("Connect SABnzbd first"), { statusCode: 400 });
    const qs = new URLSearchParams({ mode: "set_config", section: "categories", keyword: c.category, name: c.category, dir: c.category, output: "json", apikey: c.apiKey });
    const res = await fetch(`${c.url}/api?${qs}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw Object.assign(new Error(`SABnzbd answered HTTP ${res.status}`), { statusCode: 502 });
    logDecision("info", { why: `Created the "${c.category}" category in SABnzbd` });
    return { ok: true, category: c.category };
  }
  const c = s.qbittorrent;
  if (!c.url) throw Object.assign(new Error("Connect qBittorrent first"), { statusCode: 400 });
  const login = await fetch(`${c.url}/api/v2/auth/login`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: c.url }, body: new URLSearchParams({ username: c.username, password: c.password }), signal: AbortSignal.timeout(20_000) });
  const sid = /SID=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
  const res = await fetch(`${c.url}/api/v2/torrents/createCategory`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: c.url, ...(sid ? { Cookie: `SID=${sid}` } : {}) }, body: new URLSearchParams({ category: c.category, savePath: "" }), signal: AbortSignal.timeout(20_000) });
  if (res.status === 409) return { ok: true, category: c.category, existed: true };
  if (!res.ok) throw Object.assign(new Error(`qBittorrent answered HTTP ${res.status}`), { statusCode: 502 });
  logDecision("info", { why: `Created the "${c.category}" category in qBittorrent` });
  return { ok: true, category: c.category };
}

interface ArrField { name: string; value?: unknown }
const field = (fs_: ArrField[] | undefined, n: string) => fs_?.find((f) => f.name === n)?.value;

/** What an existing Sonarr/Radarr has (read-only): anime counts, root folders, download clients, indexers, Plex, tags. */
export async function arrPreview() {
  const s = getSettings();
  const out: Record<string, unknown> = {};
  if (s.sonarr.url && s.sonarr.apiKey) {
    const call = <T>(p: string) => jsonCall<T>("Sonarr", s.sonarr, "/api/v3", "GET", p).catch(() => null);
    const [roots, clients, indexers, notes, tags] = await Promise.all([
      call<{ path: string; freeSpace?: number }[]>("/rootfolder"),
      call<{ name: string; implementation: string; enable: boolean; protocol: string; fields: ArrField[] }[]>("/downloadclient"),
      call<{ name: string; implementation: string; enableRss: boolean; protocol: string; fields: ArrField[] }[]>("/indexer"),
      call<{ name: string; implementation: string }[]>("/notification"),
      call<{ id: number; label: string }[]>("/tag"),
    ]);
    const animeSeries = (cache.prepare("SELECT COUNT(*) AS n FROM series").get() as { n: number }).n;
    out.sonarr = {
      animeSeries,
      roots: (roots ?? []).map((r) => r.path),
      clients: (clients ?? []).map((c) => ({ name: c.name, type: c.implementation, enabled: c.enable, protocol: c.protocol, host: field(c.fields, "host") ?? null, port: field(c.fields, "port") ?? null, category: field(c.fields, "tvCategory") ?? field(c.fields, "category") ?? null })),
      indexers: (indexers ?? []).map((i) => ({ name: i.name, type: i.implementation, protocol: i.protocol, viaProwlarr: /\/\d+\/api$|prowlarr/i.test(String(field(i.fields, "baseUrl") ?? "")) })),
      plex: (notes ?? []).some((n) => /plex/i.test(n.implementation)),
      tags: (tags ?? []).map((t) => t.label),
    };
  }
  if (s.radarr.url && s.radarr.apiKey) {
    const call = <T>(p: string) => jsonCall<T>("Radarr", s.radarr, "/api/v3", "GET", p).catch(() => null);
    const roots = await call<{ path: string }[]>("/rootfolder");
    const animeMovies = (cache.prepare("SELECT COUNT(*) AS n FROM movies").get() as { n: number }).n;
    out.radarr = { animeMovies, roots: (roots ?? []).map((r) => r.path) };
  }
  return out;
}

/** Applies the chosen pieces of an existing setup (roots → allowed roots; clients → SAB/qBit address and category). */
export function applyArrPreview(input: { roots?: string[]; sab?: { url: string; category: string } | null; qbit?: { url: string; category: string } | null }) {
  patchSettings((s) => ({
    ...s,
    allowedRoots: [...new Set([...s.allowedRoots, ...(input.roots ?? []).map((r) => String(r).replace(/\/+$/, "")).filter((r) => r.startsWith("/"))])],
    sabnzbd: input.sab && !s.sabnzbd.url ? { ...s.sabnzbd, url: String(input.sab.url).replace(/\/+$/, ""), category: s.sabnzbd.category } : s.sabnzbd,
    qbittorrent: input.qbit && !s.qbittorrent.url ? { ...s.qbittorrent, url: String(input.qbit.url).replace(/\/+$/, ""), category: s.qbittorrent.category } : s.qbittorrent,
  }));
  logDecision("info", { why: "Setup: settings taken over from Sonarr/Radarr (root folders and download client addresses)" });
  return { ok: true };
}
