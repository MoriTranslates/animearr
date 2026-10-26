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
  let u: URL;
  try {
    u = new URL(conn.url);
  } catch {
    throw new Error("The Plex address isn't a valid URL");
  }
  if (!/^https?:$/.test(u.protocol) || /^(169\.254\.|0\.|\[?fe80:)/i.test(u.hostname) || u.hostname === "metadata.google.internal") throw new Error("That Plex address isn't allowed");
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
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null; // e.g. an XML answer to a refresh: the request itself worked
  }
}

export async function plexSections(conn?: Conn): Promise<PlexSection[]> {
  const d = await plexCall<{ MediaContainer: { Directory?: { key: string; title: string; type: string; Location?: { path: string }[] }[] } }>("/library/sections", conn);
  return (d?.MediaContainer.Directory ?? []).map((x) => ({ key: x.key, title: x.title, type: x.type, locations: (x.Location ?? []).map((l) => l.path.replace(/\\/g, "/").replace(/\/+$/, "")) }));
}

/** Connection test: server name/version and its libraries (read-only). */
export async function testPlex(conn: Conn) {
  const id = await plexCall<{ MediaContainer: { friendlyName?: string; version?: string } }>("/", conn);
  return { version: id?.MediaContainer.version ?? "?", name: id?.MediaContainer.friendlyName ?? "Plex", sections: await plexSections(conn) };
}

/** Sonarr/Radarr path (as the library rows have it) → Plex path (longest mapping prefix wins). */
export function toPlexPath(p: string, maps: PathMapping[] = getSettings().plex.pathMappings) {
  const n = (x: string) => x.replace(/\\/g, "/").replace(/\/+$/, "");
  const norm = n(p);
  const m = [...maps].sort((a, b) => b.from.length - a.from.length).find((x) => norm === n(x.from) || norm.startsWith(`${n(x.from)}/`));
  return m ? n(m.to) + norm.slice(n(m.from).length) : norm;
}

/** The library section whose folder holds this Plex path. */
export function sectionFor(plexPath: string, sections: PlexSection[]) {
  return sections.filter((s) => s.locations.some((l) => plexPath === l || plexPath.startsWith(`${l}/`))).sort((a, b) => Math.max(...b.locations.map((l) => l.length)) - Math.max(...a.locations.map((l) => l.length)))[0] ?? null;
}

const pending = new Set<string>();
let timer: NodeJS.Timeout | null = null;
let sectionsCache: { at: number; url: string; v: PlexSection[] } | null = null;
let retries = 0;

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
  const s = getSettings().plex;
  if (!s.enabled) {
    pending.clear();
    return [];
  }
  const folders = [...pending];
  if (!folders.length) return [];
  const loadSections = async () => (sectionsCache = { at: Date.now(), url: s.url, v: await deps.sections() });
  try {
    if (!sectionsCache || sectionsCache.url !== s.url || Date.now() - sectionsCache.at > 10 * 60_000) await loadSections();
  } catch (e) {
    // Plex down or the token refused: keep the folders and try again later (a few times).
    if (++retries <= 5) {
      timer = setTimeout(() => void flush(deps).catch(() => undefined), 5 * 60_000);
      timer.unref?.();
    } else {
      pending.clear();
      retries = 0;
    }
    logDecision("fail", { why: `Plex: couldn't list the libraries (${(e as Error).message})${retries ? "; trying again in 5 minutes" : "; gave up on these scans"}` });
    return [];
  }
  retries = 0;
  pending.clear();
  const out: { folder: string; plexPath: string; section: string | null; ok: boolean; why: string }[] = [];
  for (const f of folders) {
    const pp = toPlexPath(f);
    let sec = sectionFor(pp, sectionsCache!.v);
    if (!sec && Date.now() - sectionsCache!.at > 30_000) {
      try {
        await loadSections(); // a library added since: look once more
        sec = sectionFor(pp, sectionsCache!.v);
      } catch {
        /* reported below */
      }
    }
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
