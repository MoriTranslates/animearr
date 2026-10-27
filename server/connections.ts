/**
 * Settings → Indexers / Download clients / Media servers / Migration: one overview of every connection with a live
 * status ("Connected · v4.3.2" / "Can't reach: …"), what it's used for (grabs), and indexer health. Read-only.
 */
import { syncProwlarrSelection, type AnimeFit } from "./indexerPick.js";
import { breakerList } from "./health.js";
import { db } from "./db.js";
import { getSettings } from "./settings.js";
import { testProwlarr } from "./arr/prowlarr.js";
import { testQbit, testSab } from "./arr/clients.js";
import { testSonarr } from "./arr/sonarr.js";
import { testRadarr } from "./arr/radarr.js";
import { testPlex } from "./plex.js";
import { redactUrl } from "./arr/http.js";
import { getSettings as settingsNow } from "./settings.js";
import { clientConfigured, testClient } from "./arr/clients.js";
import { indexerDuplicates, listIndexers } from "./connectionsAdmin.js";

export interface ConnStatus { key: string; configured: boolean; ok: boolean | null; version: string | null; error: string | null; grabs: number; lastGrabAt: number | null }
export interface IndexerRow { id: number; key?: string; name: string; protocol: "usenet" | "torrent"; enabled: boolean; priority: number | null; source: "prowlarr" | "direct"; kind?: string; grabs: number; failures: number; lastError: string | null; breaker?: ReturnType<typeof breakerList>[number] | null; pick?: { use: boolean; fit: AnimeFit | null; animeCategories: boolean; isNew: boolean } | null }

const TIMEOUT = 6000;
async function probe<T>(fn: () => Promise<T>): Promise<{ ok: boolean; v: T | null; error: string | null }> {
  try {
    const v = await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no answer within 6 seconds")), TIMEOUT))]);
    return { ok: true, v, error: null };
  } catch (e) {
    return { ok: false, v: null, error: redactUrl((e as Error).message) };
  }
}

const usage = (where: string, ...args: (string | number)[]) =>
  db.prepare(`SELECT COUNT(*) AS n, MAX(at) AS last FROM grabs WHERE dry_run = 0 AND client_ref IS NOT NULL AND ${where}`).get(...args) as { n: number; last: number | null };

let cache: { at: number; v: Promise<Awaited<ReturnType<typeof build>>> } | null = null;
/** After a change in Settings: the next overview is fresh. */
export const invalidateConnections = () => void (cache = null);
/** Cached for 20 s (the page polls; the services shouldn't be hammered). */
export function connectionsOverview(fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < 20_000) return cache.v;
  cache = { at: Date.now(), v: build() };
  return cache.v;
}

async function build() {
  const s = getSettings();
  const conf = {
    sabnzbd: !!(s.sabnzbd.url && s.sabnzbd.apiKey),
    qbittorrent: !!s.qbittorrent.url,
    prowlarr: !!(s.prowlarr.url && s.prowlarr.apiKey),
    plex: !!(s.plex.url && s.plex.token),
    sonarr: !!(s.sonarr.url && s.sonarr.apiKey),
    radarr: !!(s.radarr.url && s.radarr.apiKey),
  };
  const [sab, qbit, prow, plex, sonarr, radarr] = await Promise.all([
    conf.sabnzbd ? probe(() => testSab(s.sabnzbd)) : null,
    conf.qbittorrent ? probe(() => testQbit(s.qbittorrent)) : null,
    conf.prowlarr ? probe(() => testProwlarr(s.prowlarr)) : null,
    conf.plex ? probe(() => testPlex({ url: s.plex.url, token: s.plex.token })) : null,
    conf.sonarr ? probe(() => testSonarr(s.sonarr)) : null,
    conf.radarr ? probe(() => testRadarr(s.radarr)) : null,
  ]);
  const st = (key: keyof typeof conf, p: { ok: boolean; v: unknown; error: string | null } | null, use = { n: 0, last: null as number | null }): ConnStatus => ({
    key,
    configured: conf[key],
    ok: p ? p.ok : null,
    version: p?.v && typeof p.v === "object" && "version" in (p.v as object) ? String((p.v as { version: unknown }).version ?? "") || null : null,
    error: p?.error ?? null,
    grabs: use.n,
    lastGrabAt: use.last,
  });
  const indexers: IndexerRow[] = [];
  if (prow?.ok && prow.v) {
    const since = Date.now() - 3 * 86_400_000;
    for (const ix of (prow.v as { indexers: { id: number; name: string; protocol: string; enable: boolean; priority?: number }[] }).indexers) {
      const u = usage("indexer_id = ?", ix.id);
      const f = db.prepare("SELECT COUNT(*) AS n, (SELECT why FROM indexer_failures WHERE indexer_id = ? ORDER BY at DESC LIMIT 1) AS last FROM indexer_failures WHERE indexer_id = ? AND at > ?").get(ix.id, ix.id, since) as { n: number; last: string | null };
      indexers.push({ id: ix.id, name: ix.name, protocol: ix.protocol === "torrent" ? "torrent" : "usenet", enabled: ix.enable, priority: ix.priority ?? null, source: "prowlarr", grabs: u.n, failures: f.n, lastError: f.n ? f.last : null });
    }
  }
  // Added clients (NZBGet, Transmission, Deluge, rTorrent) and direct indexers.
  const extras = await Promise.all(
    (settingsNow().extraClients ?? []).map(async (c) => {
      const p = clientConfigured(c) ? await probe(() => testClient(c)) : null;
      const u = usage("client = ?", c.id);
      return { key: c.id, type: c.type, name: c.name, configured: clientConfigured(c), ok: p ? p.ok : null, version: p?.v?.version ?? null, error: p?.error ?? null, grabs: u.n, lastGrabAt: u.last, priority: c.priority, enabled: c.enabled };
    }),
  );
  for (const ix of listIndexers())
    indexers.push({ id: ix.numId, key: ix.id, name: ix.name, protocol: ix.protocol, enabled: ix.enabled, priority: ix.priority, source: "direct", kind: ix.kind, grabs: ix.grabs, failures: ix.failures, lastError: ix.lastError });
  // Which Prowlarr indexers AnimeArr asks (defaults for new ones), with the anime-fit hint.
  if (prow?.ok) {
    try {
      const picks = new Map((await syncProwlarrSelection()).map((x) => [x.id, x]));
      for (const ix of indexers) if (ix.source === "prowlarr") ix.pick = picks.get(ix.id) ?? null;
    } catch {
      /* the cards still show without it */
    }
  }
  // The circuit breaker's state per indexer (off for grabbing after repeated failures).
  const br = new Map(breakerList().map((b) => [b.indexerId, b]));
  for (const ix of indexers) ix.breaker = br.get(ix.id)?.state !== "on" ? (br.get(ix.id) ?? null) : null;
  const prefs = s.clientPrefs ?? {};
  return {
    clients: [
      { ...st("sabnzbd", sab, usage("client = 'sabnzbd'")), type: "sabnzbd", name: "SABnzbd", priority: prefs.sabnzbd?.priority ?? 1, enabled: prefs.sabnzbd?.enabled ?? true },
      { ...st("qbittorrent", qbit, usage("client = 'qbittorrent'")), type: "qbittorrent", name: "qBittorrent", priority: prefs.qbittorrent?.priority ?? 1, enabled: prefs.qbittorrent?.enabled ?? true },
      ...extras,
    ],
    duplicates: indexerDuplicates(indexers.filter((x) => x.source === "prowlarr").map((x) => x.name)),
    delays: s.protocol ?? { usenetDelayMin: 0, torrentDelayMin: 0 },
    indexerSources: [st("prowlarr", prow, usage("indexer_id IS NOT NULL"))],
    indexers: indexers.sort((a, b) => (a.priority ?? 25) - (b.priority ?? 25) || a.name.localeCompare(b.name)),
    mediaServers: [st("plex", plex)],
    migration: [st("sonarr", sonarr), st("radarr", radarr)],
    // The default language profile's protocol order ("Usenet is tried first"); per-profile choice in Profiles.
    protocolOrder: (s.profiles.find((p) => p.id === s.defaultProfileId) ?? s.profiles[0])?.protocolOrder ?? ["usenet", "torrent"],
    noPreference: !!(s.profiles.find((p) => p.id === s.defaultProfileId) ?? s.profiles[0])?.noProtocolPreference,
  };
}
