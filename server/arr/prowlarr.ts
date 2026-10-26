import { getSettings } from "../settings.js";
import { jsonCall, redactUrl, type Conn } from "./http.js";

/** Prowlarr v1 API client: searches (read-only) and fetching a release's NZB/torrent for the grab pipeline. */

export interface ProwlarrRelease {
  guid: string;
  title: string;
  size: number;
  indexerId: number;
  indexer: string;
  protocol: "usenet" | "torrent";
  publishDate?: string;
  downloadUrl?: string;
  magnetUrl?: string;
  infoUrl?: string;
  seeders?: number;
  leechers?: number;
  grabs?: number;
  categories?: { id: number; name: string }[];
  ageMinutes?: number;
}

const conn = (): Conn => getSettings().prowlarr;
const call = <T>(method: string, path: string, body?: unknown, c: Conn = conn(), timeout?: number) => jsonCall<T>("Prowlarr", c, "/api/v1", method, path, body, timeout);

export const prowlarrConfigured = () => !!(getSettings().prowlarr.url && getSettings().prowlarr.apiKey);

export async function testProwlarr(c: Conn) {
  const s = await call<{ version: string; appName?: string }>("GET", "/system/status", undefined, c);
  if (s.appName && s.appName !== "Prowlarr") throw new Error(`That's ${s.appName}, not Prowlarr`);
  const indexers = await call<{ id: number; name: string; protocol: string; enable: boolean }[]>("GET", "/indexer", undefined, c);
  return { version: s.version, indexers: indexers.map(({ id, name, protocol, enable }) => ({ id, name, protocol, enable })) };
}

export async function prowlarrIndexers() {
  return (await call<{ id: number; name: string; protocol: string; enable: boolean }[]>("GET", "/indexer")).map(({ id, name, protocol, enable }) => ({ id, name, protocol, enable }));
}

/** Results of recent identical queries (10 min), and queries in flight, so repeat searches are instant. */
const queryCache = new Map<string, { at: number; rows: Promise<ProwlarrRelease[]> }>();
const QUERY_TTL = 10 * 60_000;

/** Free-text search across the configured indexers and categories. An empty query returns each indexer's recent feed. */
export async function prowlarrSearch(query: string, opts: { limit?: number; categories?: number[]; fresh?: boolean } = {}): Promise<ProwlarrRelease[]> {
  const s = getSettings().prowlarr;
  const qs = new URLSearchParams({ query, type: "search", limit: String(opts.limit ?? 200) });
  for (const c of opts.categories ?? s.categories) qs.append("categories", String(c));
  for (const i of s.indexerIds) qs.append("indexerIds", String(i));
  const key = qs.toString();
  const now = Date.now();
  for (const [k, v] of queryCache) if (now - v.at > QUERY_TTL) queryCache.delete(k);
  // The empty "recent releases" query is never cached (the RSS-style poll needs fresh results).
  const hit = query && !opts.fresh ? queryCache.get(key) : undefined;
  if (hit) return hit.rows;
  const rows = call<ProwlarrRelease[]>("GET", `/search?${qs}`, undefined, conn(), 180_000).then((list) => list.map((r) => ({ ...r, protocol: r.protocol === "usenet" ? ("usenet" as const) : ("torrent" as const) })));
  if (query) {
    queryCache.set(key, { at: now, rows });
    rows.catch(() => queryCache.delete(key)); // failures are not cached
  }
  return rows;
}

/**
 * Downloads the NZB/torrent behind a release (through Prowlarr's proxy link, so indexer credentials stay in Prowlarr).
 * A torrent link may redirect to a magnet; that is returned as `magnet`.
 */
export async function fetchReleaseFile(r: ProwlarrRelease): Promise<{ data?: Buffer; magnet?: string; filename: string }> {
  if (r.magnetUrl?.startsWith("magnet:")) return { magnet: r.magnetUrl, filename: r.title };
  if (r.guid.startsWith("magnet:") && !r.downloadUrl) return { magnet: r.guid, filename: r.title };
  if (!r.downloadUrl) throw new Error("This release has no download link");
  let res = await fetch(r.downloadUrl, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
  // Prowlarr's download proxy can fail (HTTP 500) on a non-ASCII file name: retry once with an ASCII one.
  if (res.status === 500 && /[^\x20-\x7e]/.test(r.title)) {
    const u = new URL(r.downloadUrl);
    if (u.searchParams.has("file")) {
      await res.body?.cancel().catch(() => undefined);
      u.searchParams.set("file", r.title.normalize("NFKD").replace(/[^\x20-\x7e]/g, "_"));
      res = await fetch(u.toString(), { redirect: "manual", signal: AbortSignal.timeout(60_000) });
    }
  }
  const loc = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && loc) {
    if (loc.startsWith("magnet:")) return { magnet: loc, filename: r.title };
    const res2 = await fetch(loc, { signal: AbortSignal.timeout(60_000) });
    if (!res2.ok) throw new Error(`Download link failed (HTTP ${res2.status})`);
    return { data: Buffer.from(await res2.arrayBuffer()), filename: r.title };
  }
  if (!res.ok) throw new Error(`Download link failed (HTTP ${res.status}) for ${redactUrl(r.downloadUrl).split("?")[0]}`);
  return { data: Buffer.from(await res.arrayBuffer()), filename: r.title };
}
