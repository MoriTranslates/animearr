/**
 * Plex notify (1.0 takeover): after AnimeArr's own importer or renamer changed a folder, Plex scans just that folder
 * (a partial scan, like Sonarr/Radarr's Plex connection). Imports through Sonarr/Radarr are left to their own Plex
 * connection. Read-only otherwise: AnimeArr never changes Plex's library settings, metadata or watch state.
 *
 * The token is stored encrypted in the settings (entered in the UI; never logged). Paths are mapped from AnimeArr's
 * view to Plex's with Plex path mappings (longest prefix wins); unmapped paths are used as they are.
 */
import { logDecision } from "./activity.js";
import { getSettings, type PathMapping } from "./settings.js";

interface Conn { url: string; token: string }
export interface PlexSection { key: string; title: string; type: string; locations: string[] }

async function plexCall<T>(p: string, conn: Conn = getSettings().plex, method = "GET"): Promise<T | null> {
  if (!conn.url || !conn.token) throw new Error("Plex is not configured");
  if (!/^https?:\/\//i.test(conn.url)) throw new Error("The Plex address must start with http:// or https://");
  const url = `${conn.url.replace(/\/+$/, "")}${p}`;
  let res: Response;
  try {
    res = await fetch(url, { method, headers: { Accept: "application/json", "X-Plex-Token": conn.token, "X-Plex-Product": "AnimeArr", "X-Plex-Client-Identifier": "animearr" }, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new Error(`Plex unreachable (${(e as Error).message})`);
  }
  if (res.status === 401) throw new Error("Plex refused the token (401)");
  if (!res.ok) throw new Error(`Plex HTTP ${res.status}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : null;
}

export async function plexSections(conn?: Conn): Promise<PlexSection[]> {
  const d = await plexCall<{ MediaContainer: { Directory?: { key: string; title: string; type: string; Location?: { path: string }[] }[] } }>("/library/sections", conn);
  return (d?.MediaContainer.Directory ?? []).map((x) => ({ key: x.key, title: x.title, type: x.type, locations: (x.Location ?? []).map((l) => l.path.replace(/\/+$/, "")) }));
}

/** Connection test: server name/version and its libraries (read-only). */
export async function testPlex(conn: Conn) {
  const id = await plexCall<{ MediaContainer: { friendlyName?: string; version?: string } }>("/", conn);
  return { version: id?.MediaContainer.version ?? "?", name: id?.MediaContainer.friendlyName ?? "Plex", sections: await plexSections(conn) };
}

/** AnimeArr path → Plex path (longest mapping prefix wins). */
export function toPlexPath(p: string, maps: PathMapping[] = getSettings().plex.pathMappings) {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const m = [...maps].sort((a, b) => b.from.length - a.from.length).find((x) => {
    const f = x.from.replace(/\/+$/, "");
    return norm === f || norm.startsWith(`${f}/`);
  });
  return m ? m.to.replace(/\/+$/, "") + norm.slice(m.from.replace(/\/+$/, "").length) : norm;
}

/** The library section whose folder holds this Plex path. */
export function sectionFor(plexPath: string, sections: PlexSection[]) {
  return sections.filter((s) => s.locations.some((l) => plexPath === l || plexPath.startsWith(`${l}/`))).sort((a, b) => Math.max(...b.locations.map((l) => l.length)) - Math.max(...a.locations.map((l) => l.length)))[0] ?? null;
}

const pending = new Set<string>();
let timer: NodeJS.Timeout | null = null;
let sectionsCache: { at: number; v: PlexSection[] } | null = null;

/** Queues partial scans of these folders (AnimeArr paths); they go out together a few seconds later. */
export function notifyPlex(folders: string[], deps = { sections: plexSections, refresh: (key: string, p: string) => plexCall(`/library/sections/${key}/refresh?path=${encodeURIComponent(p)}`) }, delayMs = 15_000) {
  const s = getSettings().plex;
  if (!s.enabled || !s.url || !s.token) return;
  for (const f of folders) if (f) pending.add(f.replace(/\/+$/, ""));
  if (timer) return;
  timer = setTimeout(() => void flush(deps).catch(() => undefined), delayMs);
  timer.unref?.();
}

export async function flush(deps = { sections: plexSections, refresh: (key: string, p: string) => plexCall(`/library/sections/${key}/refresh?path=${encodeURIComponent(p)}`) }) {
  if (timer) clearTimeout(timer);
  timer = null;
  const folders = [...pending];
  pending.clear();
  if (!folders.length) return [];
  if (!sectionsCache || Date.now() - sectionsCache.at > 10 * 60_000) sectionsCache = { at: Date.now(), v: await deps.sections() };
  const out: { folder: string; plexPath: string; section: string | null; ok: boolean; why: string }[] = [];
  for (const f of folders) {
    const pp = toPlexPath(f);
    const sec = sectionFor(pp, sectionsCache.v);
    if (!sec) {
      out.push({ folder: f, plexPath: pp, section: null, ok: false, why: "no Plex library has this folder (check the Plex path mappings)" });
      continue;
    }
    try {
      await deps.refresh(sec.key, pp);
      out.push({ folder: f, plexPath: pp, section: sec.title, ok: true, why: "scan asked" });
    } catch (e) {
      out.push({ folder: f, plexPath: pp, section: sec.title, ok: false, why: (e as Error).message });
    }
  }
  const ok = out.filter((x) => x.ok);
  logDecision(ok.length === out.length ? "info" : "fail", { why: `Plex: ${ok.length ? `asked to scan ${ok.map((x) => `${x.plexPath} (${x.section})`).slice(0, 3).join(", ")}${ok.length > 3 ? "…" : ""}` : ""}${ok.length < out.length ? `${ok.length ? "; " : ""}couldn't scan ${out.filter((x) => !x.ok).map((x) => `${x.plexPath}: ${x.why}`).slice(0, 2).join("; ")}` : ""}` });
  return out;
}
