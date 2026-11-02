/**
 * Grab steps shared by episode grabs (pipeline.ts) and movie grabs (movies.ts): the real dependency bundle, the malware
 * checks, rejecting an unsafe download, and picking the wanted files of a batch torrent. Neither of those modules is
 * imported from here, which keeps them out of an import cycle.
 */
import { logDecision } from "../system/activity.js";
import { clientName, realClients, type ClientJob } from "../arr/clients.js";
import { fetchReleaseFile as realFetchRelease } from "../arr/prowlarr.js";
import * as radarr from "../arr/radarr.js";
import * as sonarr from "../arr/sonarr.js";
import { cleanupGrab } from "./downloads.js";
import { applySelection, writeBatch, type BatchInfo, type FileMapOpts } from "./batch.js";
import { identify } from "../core/identify.js";
import { cache } from "../system/db.js";
import { extractIfNeeded, UNPACK_DIR } from "./extract.js";
import { refreshSeriesEpisodes } from "../library.js";
import { localPath as realLocalPath } from "../system/paths.js";
import { blocklist, setState, type GrabRow, type PipelineDeps } from "./pipelineState.js";
import { inspectFiles, walkFiles } from "./safety.js";
import { scopeFor } from "../scope.js";
import { episodesFor, identifyContext, seriesByTvdb } from "../search/search.js";
import { getSettings } from "../system/settings.js";
import { ffprobe } from "./verify.js";

/** The real side effects (tests pass mocks instead). */
export const realDeps: PipelineDeps = {
  clients: realClients,
  fetchRelease: realFetchRelease,
  cleanup: (id, outcome) => cleanupGrab(id, outcome),
  sonarr: {
    preview: sonarr.manualImportPreview,
    importFiles: sonarr.manualImport,
    command: sonarr.getCommand,
    episode: sonarr.getEpisode,
    episodeFile: sonarr.getEpisodeFile,
  },
  radarr: {
    preview: radarr.radarrImportPreview,
    importFiles: radarr.radarrManualImport,
    command: radarr.getRadarrCommand,
    movie: radarr.getMovie,
  },
  probe: (f) => ffprobe(f),
  localPath: realLocalPath,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  refreshSeries: (id) => refreshSeriesEpisodes(id),
  extract: (dir, key, only) => extractIfNeeded(dir, key, { only }),
};

/** Title for activity entries: the show's, or the movie's for movie grabs. */
export function rowTitle(row: GrabRow): string | undefined {
  if (row.movie_id)
    return (cache.prepare("SELECT title FROM movies WHERE id = ?").get(row.movie_id) as { title: string } | undefined)?.title;
  return row.tvdb_id ? (seriesByTvdb(row.tvdb_id)?.title ?? undefined) : undefined;
}

/** The runtime (minutes) of the episode, or movie, a grab is for; null when unknown. */
export function runtimeOf(row: GrabRow): number | null {
  if (row.movie_id)
    return (
      (cache.prepare("SELECT runtime FROM movies WHERE id = ?").get(row.movie_id) as { runtime: number | null } | undefined)?.runtime ??
      null
    );
  const wanted = JSON.parse(row.episode_ids) as number[];
  return episodesFor(row.tvdb_id).find((e) => wanted.includes(e.id))?.runtime ?? null;
}

/** Malware blocker, before import: looks through the download's folder (or file) when AnimeArr can reach it. */
export function unsafeDownload(deps: Pick<PipelineDeps, "localPath">, row: GrabRow, arrPath: string, isFolder: boolean): string | null {
  const s = getSettings().malware;
  if (!s.enabled) return null;
  const local = deps.localPath(arrPath);
  if (!local) return null;
  return inspectFiles(walkFiles(local, isFolder ? (rel) => rel === UNPACK_DIR || rel.startsWith(`${UNPACK_DIR}/`) : undefined), {
    extensions: s.extensions,
    runtimeMin: runtimeOf(row),
  });
}

/**
 * A download that holds something dangerous or fake: removed from its client (with its data), the release blocklisted
 * with the plain reason; nothing from it is ever imported. The caller then searches the next release (rejectUnsafe in
 * pipeline.ts, or movies.ts for a movie).
 */
export async function rejectUnsafeDownload(row: GrabRow, reason: string, deps: PipelineDeps, when: string) {
  setState(row.id, "failed", reason);
  const bid = blocklist(row, reason);
  let removed = "";
  if (row.client && row.client_ref) {
    try {
      await deps.clients.remove({ client: row.client as ClientJob["client"], ref: row.client_ref });
      removed = `; removed it from ${clientName(row.client) || row.client}`;
    } catch (e) {
      removed = `; couldn't remove it from the download client (${(e as Error).message}), so delete it there by hand`;
    }
  }
  logDecision("fail", {
    tvdbId: row.tvdb_id,
    title: rowTitle(row),
    episodeIds: JSON.parse(row.episode_ids),
    release: row.release,
    why: `${row.release} ${reason} (found ${when}). Blocklisted it${removed}; nothing from it was imported. Looking for the next release.`,
    detail: { grabId: row.id, malware: true, ...(row.movie_id ? { movieId: row.movie_id } : {}) },
    undo: { action: "unblock", args: { id: bid, release: row.release } },
  });
}

/** The file-mapping options of an episode grab (the importer's own mapping, so the import sees the same files). */
export function episodeFileOpts(tvdbId: number, wantedIds: number[]): FileMapOpts {
  const ctx = identifyContext();
  const minConf = getSettings().managed.minConfidence;
  const has = new Set(
    episodesFor(tvdbId)
      .filter((e) => e.hasFile)
      .map((e) => e.id),
  );
  return {
    wantedIds,
    resolve: (name) => {
      const id = identify(name, ctx, { tvdbId, expect: wantedIds });
      return id.resolution?.ok && id.resolution.confidence >= minConf ? id.resolution.episodes.map((e) => e.id) : null;
    },
    keepCreditless: scopeFor(tvdbId).creditless,
    hasFile: (e) => has.has(e),
  };
}

/**
 * Right after a batch torrent was added stopped: read its files and skip the unwanted ones (a .torrent lists them at
 * once; a magnet needs its metadata first, so it is polled briefly here and then by the pipeline tick).
 */
export async function selectAfterAdd(
  grabId: number,
  job: ClientJob,
  batch: BatchInfo,
  deps: Pick<PipelineDeps, "clients" | "sleep">,
  log: { tvdbId: number | null; title?: string; release: string; episodeIds: number[]; movieId?: number | null },
  magnet: boolean,
  opts?: FileMapOpts,
) {
  if (!job.select) {
    // The client can't skip files (or already had this torrent): the whole batch; the import takes what it needs.
    writeBatch(grabId, { ...batch, mode: "whole", note: "the download client can't skip files" });
    return;
  }
  writeBatch(grabId, { ...batch, paused: !!job.paused });
  const ctx = { grabId, job, clients: deps.clients, opts: opts ?? episodeFileOpts(log.tvdbId!, log.episodeIds), log };
  for (let i = 0; i < (magnet ? 5 : 3); i++) {
    try {
      if ((await applySelection(ctx)) !== "pending") return;
    } catch {
      /* the tick tries again */
    }
    await deps.sleep(2000);
  }
}
