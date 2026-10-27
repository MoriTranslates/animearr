/** Queue (AnimeArr's own downloads, with live client status) and grab history. */
import { clientName } from "./arr/clients.js";
import { colorFor } from "./home.js";
import { coverFor } from "./audit.js";
import { liveFixesFor } from "./fixes.js";
import { cache, db } from "./db.js";
import { grabStages, realDeps, type GrabRow, type PipelineDeps } from "./pipeline.js";
import type { ClientJob } from "./arr/clients.js";
import * as sonarr from "./arr/sonarr.js";
import { logDecision } from "./activity.js";
import { getSettings, underAllowedRoot } from "./settings.js";

const label = (id: number) => {
  const e = cache.prepare("SELECT season, episode, title FROM episodes WHERE id = ?").get(id) as { season: number; episode: number; title: string | null } | undefined;
  return e ? `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}${e.title && !/^TBA$/i.test(e.title) ? ` · ${e.title.length > 40 ? `${e.title.slice(0, 39)}…` : e.title}` : ""}` : `#${id}`;
};
const seriesTitle = (tvdbId: number) => (cache.prepare("SELECT title FROM series WHERE tvdb_id = ?").get(tvdbId) as { title: string } | undefined)?.title ?? String(tvdbId);

const movieTitle = (id: number) => {
  const m = cache.prepare("SELECT title, year FROM movies WHERE id = ?").get(id) as { title: string; year: number | null } | undefined;
  return m ? (m.year ? `${m.title} (${m.year})` : m.title) : `Movie ${id}`;
};

/** Poster and colour for a grab's card. */
function art(g: GrabRow): { cover: string | null; color: string | null } {
  if (g.movie_id) return { cover: (cache.prepare("SELECT poster FROM movies WHERE id = ?").get(g.movie_id) as { poster: string | null } | undefined)?.poster ?? null, color: null };
  const s = cache.prepare("SELECT tvdb_id, poster FROM series WHERE tvdb_id = ?").get(g.tvdb_id) as { tvdb_id: number; poster: string | null } | undefined;
  return { cover: s ? coverFor(s) : null, color: colorFor(g.tvdb_id) };
}

function view(g: GrabRow) {
  const eps = JSON.parse(g.episode_ids) as number[];
  const fixes = g.error && (g.state === "needs-attention" || g.state === "failed") ? liveFixesFor(g.error, { grabId: g.id, tvdbId: g.tvdb_id, movieId: g.movie_id ?? null, episodeIds: eps, kind: verifyFailed(g) ? "verify-fail" : g.state === "failed" ? "fail" : "attention" }) : [];
  return { id: g.id, at: g.at, updatedAt: g.updated_at, tvdbId: g.tvdb_id, movieId: g.movie_id ?? null, series: g.movie_id ? movieTitle(g.movie_id) : seriesTitle(g.tvdb_id), episodes: eps.map(label), episodeIds: eps, release: g.release, protocol: g.protocol, client: g.client, state: g.state, dryRun: !!g.dry_run, why: g.why, error: g.error, progress: g.progress ?? null, attempt: g.attempt ?? 1, origin: g.origin, fixes, ...art(g), clientName: clientName(g.client) };
}

/** A grab that failed the language check (its error is the blocklist reason the check wrote). */
const verifyFailed = (g: GrabRow) => g.state === "failed" && !!g.error && !!db.prepare("SELECT 1 FROM blocklist WHERE release = ? AND reason = ? LIMIT 1").get(g.release, g.error);

export async function queueView(deps: PipelineDeps = realDeps) {
  const active = db.prepare("SELECT * FROM grabs WHERE state IN ('sending', 'downloading', 'importing', 'needs-attention') ORDER BY id DESC").all() as unknown as GrabRow[];
  const stages = grabStages();
  const items = await Promise.all(
    active.map(async (g) => {
      let live = null;
      if (g.state === "downloading" && g.client && g.client_ref) {
        try {
          // A slow client doesn't hold the whole page (the first call once took 18 s): 4 s, then "no answer yet".
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            live = await Promise.race([
              deps.clients.status({ client: g.client as ClientJob["client"], ref: g.client_ref }),
              new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error("the download client is slow to answer")), 4000))),
            ]);
          } finally {
            clearTimeout(timer);
          }
        } catch (e) {
          live = { state: "unknown", progress: g.progress ?? 0, message: (e as Error).message };
        }
      }
      return { ...view(g), live, stage: stages.get(g.id)?.stage ?? null, ahead: stages.get(g.id)?.ahead ?? null };
    }),
  );
  return { items };
}

export function grabHistory(opts: { before?: number; limit?: number; state?: string } = {}) {
  const where = ["state NOT IN ('sending', 'downloading', 'importing', 'needs-attention')"];
  const args: (number | string)[] = [];
  if (opts.before) (where.push("id < ?"), args.push(opts.before));
  if (opts.state) (where.push("state = ?"), args.push(opts.state));
  const rows = db.prepare(`SELECT * FROM grabs WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(200, opts.limit ?? 50)) as unknown as GrabRow[];
  return rows.map(view);
}

// ---------------------------------------------------------------- Sonarr's own queue (report; removal only on request)

export interface SonarrProblem { id: number; downloadId: string | null; series: string; tvdbId: number | null; episodes: string[]; release: string; client: string | null; protocol: string | null; problem: "failed" | "sonarr-handling" | "import-blocked" | "warning" | "stalled"; messages: string[]; added: string | null }

const ep = (q: sonarr.SonarrQueueItem) => (q.episode ? `S${String(q.episode.seasonNumber).padStart(2, "0")}E${String(q.episode.episodeNumber).padStart(2, "0")}` : null);

/** AnimeArr's own downloads (if Sonarr's download client shares AnimeArr's category, they could show up there). */
const ownDownload = (downloadId?: string) => !!downloadId && !!db.prepare("SELECT 1 FROM grabs WHERE lower(client_ref) = lower(?) LIMIT 1").get(downloadId);

/**
 * Sonarr's queue items (shows in the allowed root folders) that need a look: failed downloads, imports Sonarr is
 * blocked on, client warnings, and downloads with no data after queueHealth.stallHours. One entry per download (a
 * season pack is one entry), AnimeArr's own downloads excluded.
 */
export async function sonarrQueueProblems(getQueue = sonarr.getQueue, now = Date.now()): Promise<SonarrProblem[]> {
  if (!sonarr.sonarrConfigured()) return [];
  const stallMs = getSettings().queueHealth.stallHours * 3_600_000;
  const byDownload = new Map<string, SonarrProblem>();
  for (const q of await getQueue()) {
    if (!q.series || !underAllowedRoot(q.series.path) || ownDownload(q.downloadId)) continue;
    const key = q.downloadId ?? `id${q.id}`;
    const known = byDownload.get(key);
    if (known) {
      const e = ep(q);
      if (e && !known.episodes.includes(e)) known.episodes.push(e);
      continue;
    }
    const messages = [...(q.errorMessage ? [q.errorMessage] : []), ...(q.statusMessages ?? []).flatMap((m) => (m.messages?.length ? m.messages : m.title ? [m.title] : []))];
    const state = q.trackedDownloadState ?? "";
    const added = q.added ? Date.parse(q.added) : NaN;
    let problem: SonarrProblem["problem"] | null = null;
    if (state === "failedPending") problem = "sonarr-handling";
    else if (q.status === "failed" || state === "failed") problem = "failed";
    else if (state === "importBlocked" || (state === "importPending" && q.trackedDownloadStatus !== "ok")) problem = "import-blocked";
    else if (q.trackedDownloadStatus === "warning" || q.trackedDownloadStatus === "error" || q.status === "warning") problem = "warning";
    else if (q.status === "downloading" && q.size && q.sizeleft === q.size && Number.isFinite(added) && now - added > stallMs) {
      problem = "stalled";
      messages.push(`no data downloaded in ${Math.round((now - added) / 3_600_000)} hours`);
    }
    if (!problem) continue;
    const e = ep(q);
    byDownload.set(key, {
      id: q.id,
      downloadId: q.downloadId ?? null,
      series: q.series.title,
      tvdbId: q.series.tvdbId ?? null,
      episodes: e ? [e] : [],
      release: q.title,
      client: q.downloadClient ?? null,
      protocol: q.protocol ?? null,
      problem,
      messages: [...new Set(messages)],
      added: q.added ?? null,
    });
  }
  return [...byDownload.values()];
}

/** User-confirmed: remove one download from Sonarr's queue (and its download client), optionally blocklisting it. */
export async function removeSonarrQueueItem(id: number, blocklist: boolean, expectDownloadId: string | null, deps = { getQueue: sonarr.getQueue, remove: sonarr.removeQueueItem }) {
  const item = (await deps.getQueue()).find((q) => q.id === id);
  if (!item) throw Object.assign(new Error("That item isn't in Sonarr's queue any more"), { statusCode: 404 });
  if (!item.series || !underAllowedRoot(item.series.path)) throw Object.assign(new Error("That show is outside the allowed root folders"), { statusCode: 403 });
  if ((item.downloadId ?? null) !== expectDownloadId) throw Object.assign(new Error("Sonarr's queue changed; refresh and try again"), { statusCode: 409 });
  if (ownDownload(item.downloadId)) throw Object.assign(new Error("That's AnimeArr's own download; remove it from AnimeArr's queue instead"), { statusCode: 409 });
  await deps.remove(id, blocklist);
  logDecision("sonarr", { tvdbId: item.series.tvdbId, title: item.series.title, release: item.title, why: `You removed ${item.title} from Sonarr's queue and its download client${blocklist ? ", and blocklisted it in Sonarr (Sonarr searches again if the episode is monitored)" : ""}` });
}
