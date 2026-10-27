/**
 * Setup problems for the bell's "Needs action" (playtest: the bell said 0 while the download client couldn't be
 * reached and the AniDB titles download failed). They're computed, not stored: they drop out by themselves once
 * fixed. Checked at most every 5 minutes (the connection checks talk to every service).
 */
import { connectionsOverview } from "./connections.js";
import { listJobs } from "./db.js";
import { humanizeError } from "./errors.js";
import type { Fix } from "./fixes.js";

export interface SetupProblem { id: number; at: number; event: "setup"; title: string; body: string; read: boolean; fixes: Fix[]; action: true; tvdbId: null; movieId: null }

/** Metadata jobs whose failure leaves AnimeArr without titles/episode lists. */
const METADATA_JOBS: Record<string, string> = { anidb: "AniDB titles download", catalog: "Anime catalog refresh", metadata: "Episode lists and title mappings" };

let memo: { at: number; v: SetupProblem[] } | null = null;

export async function setupProblems(now = Date.now(), deps = { overview: () => connectionsOverview(), jobs: () => listJobs() as { name: string; state: string; detail: string | null; finishedAt: number | null }[] }): Promise<SetupProblem[]> {
  if (memo && now - memo.at < 300_000) return memo.v;
  const out: SetupProblem[] = [];
  let id = -1;
  const add = (title: string, body: string, fixes: Fix[]) => out.push({ id: id--, at: now, event: "setup", title, body, read: true, fixes, action: true, tvdbId: null, movieId: null });
  try {
    const o = await deps.overview();
    for (const c of o.clients as { key: string; name: string; configured: boolean; ok: boolean | null; error: string | null; enabled?: boolean }[]) {
      if (!c.configured || c.ok !== false || c.enabled === false) continue;
      const fixes: Fix[] = [{ action: "openSettings", label: "Open Download clients", params: { tab: "clients" } }];
      if (c.key === "sabnzbd" || c.key === "qbittorrent") fixes.unshift({ action: "testConnection", label: `Test ${c.name}`, params: { service: c.key } });
      add(`${c.name} isn't working`, c.error ?? `AnimeArr can't reach ${c.name}, so nothing can download.`, fixes);
    }
    for (const ms of o.mediaServers as { configured: boolean; ok: boolean | null; error: string | null }[])
      if (ms.configured && ms.ok === false) add("Plex isn't working", ms.error ?? "AnimeArr can't reach Plex.", [{ action: "openSettings", label: "Open Media servers", params: { tab: "mediaservers" } }]);
  } catch {
    /* the bell still shows without them */
  }
  for (const j of deps.jobs())
    if (METADATA_JOBS[j.name] && j.state === "error") add(`${METADATA_JOBS[j.name]} failed`, humanizeError(String(j.detail ?? "")).message, [{ action: "openSettings", label: "Open System", params: { tab: "system" } }]);
  memo = { at: now, v: out };
  return out;
}

/** The bell with setup problems on top of "Needs action". */
export function withSetupProblems<T extends { needs: number; items: unknown[] }>(b: T, problems: SetupProblem[]): T {
  return { ...b, needs: b.needs + problems.length, items: [...problems, ...b.items] };
}

export const resetSetupProblems = () => void (memo = null);
