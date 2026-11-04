/**
 * The pipeline's shared state and types: grab rows, grab requests, the dependency bundle, grab states, the blocklist
 * and fetching a release. A leaf under pipeline.ts, movies.ts and downloads.ts, so those modules share it without
 * importing each other.
 */
import type { ClientJob, DownloadClients } from "../arr/clients.js";
import { clientName, isTorrentClient } from "../arr/clients.js";
import { logDecision } from "../system/activity.js";
import { torrentHash } from "../arr/torrentClients.js";
import type { ProwlarrRelease } from "../arr/prowlarr.js";
import type * as radarr from "../arr/radarr.js";
import type * as sonarr from "../arr/sonarr.js";
import { db } from "../system/db.js";
import type { ExtractOutcome } from "./extract.js";
import { describeFetchError, indexerOff, isTitleEncodingError, recordIndexerFailure, recordIndexerSuccess } from "../search/health.js";
import type { SearchResult } from "../search/search.js";
import type { ProbeResult } from "./verify.js";

export interface PipelineDeps {
  clients: DownloadClients;
  fetchRelease(r: ProwlarrRelease): Promise<{ data?: Buffer; magnet?: string; filename: string }>;
  /** Clean-up right after an outcome is final (downloads.ts cleanupGrab); absent in tests = nothing deleted. */
  cleanup?: (grabId: number, outcome: "imported" | "rejected") => Promise<string | null>;
  /** Radarr calls for movie grabs (optional: tests of episode grabs don't need them). */
  radarr?: {
    preview: typeof radarr.radarrImportPreview;
    importFiles: typeof radarr.radarrManualImport;
    command: typeof radarr.getRadarrCommand;
    movie: typeof radarr.getMovie;
  };
  sonarr: {
    preview: typeof sonarr.manualImportPreview;
    importFiles: typeof sonarr.manualImport;
    command: typeof sonarr.getCommand;
    episode: typeof sonarr.getEpisode;
    episodeFile: typeof sonarr.getEpisodeFile;
  };
  probe(file: string): Promise<ProbeResult>;
  localPath(p: string): string | null;
  sleep(ms: number): Promise<void>;
  /** Re-reads the series from Sonarr into the cache after an import (so the UI shows the new file at once). */
  refreshSeries?(seriesId: number): Promise<void>;
  /** Unpacks a download that arrived as archives (Settings → extraction); polled, "pending" while it runs. */
  extract?(localDir: string, key: string, only?: string[]): Promise<ExtractOutcome> | ExtractOutcome;
}

export type Candidate = Pick<
  SearchResult,
  "guid" | "title" | "indexerId" | "indexer" | "protocol" | "size" | "downloadUrl" | "magnetUrl" | "label" | "group"
> & { why: string; episodeIds: number[] };

export interface GrabRequest {
  tvdbId: number;
  /** Episodes the user/scheduler asked for. */
  episodeIds: number[];
  candidate: Candidate;
  /** Next-best accepted candidates, tried in order if this one fails. */
  fallbacks: Candidate[];
  /** "manual" = Deep Search with confirmation (global dry-run applies); "managed" = scheduler (show dry-run applies too). */
  origin: "manual" | "managed";
  attempt?: number;
  /**
   * "dual-upgrade": replaces a sub-only placeholder, so the file must really have the dub (checked strictly).
   * "replace": Replace season (the user's explicit choice): the pack replaces the selected episodes' files, each only
   * after its new file passed the check; an episode whose new file fails (or is missing from the pack) keeps its file.
   */
  purpose?: "dual-upgrade" | "replace" | null;
  /** ⚡ automatic search: also honour the show's own dry-run (interactive grabs only follow the global switch). */
  automatic?: boolean;
  /** The next try of a whole-season Replace season: only a season pack may take over (never a single episode). */
  packsOnly?: boolean;
}

export interface GrabRow {
  id: number;
  at: number;
  updated_at: number;
  tvdb_id: number;
  series_id: number;
  episode_ids: string;
  release: string;
  guid: string;
  protocol: string;
  client: string | null;
  client_ref: string | null;
  state: string;
  dry_run: number;
  why: string;
  error: string | null;
  candidates: string;
  origin: "manual" | "managed";
  /** Radarr movie id for movie grabs (tvdb_id/series_id are null then). */
  movie_id?: number | null;
  /** The user asked to replace the file the movie already has. */
  replace_file?: number;
  purpose?: "dual-upgrade" | "replace" | null;
  attempt?: number;
  progress?: number | null;
  progress_at?: number | null;
  keep?: number;
  /** Smart batch info (JSON, batch.ts). */
  batch?: string | null;
  /** Strikes so far (consecutive health checks that found it stalled), when the last one was added, and why. */
  strikes?: number;
  strike_at?: number | null;
  strike_why?: string | null;
  /** The indexer's name (blocklist page). */
  indexer?: string | null;
  /** 1 = the torrent was in the client before AnimeArr's add (or adopted after a restart): never removed or deleted. */
  not_ours?: number;
}

/** Grab states that are still in flight (a new grab for the same episode must wait for these). */
export const ACTIVE = ["sending", "downloading", "importing"];

/**
 * Grabs this process is sending to a client right now. A 'sending' row not in here was cut off by a restart: the
 * pipeline asks the client whether it arrived (review 2026-11-02, H9).
 */
export const sendingNow = new Set<number>();
/** client_ref of a cut-off 'sending' row that was handed to a client without an id to look it up by (an NZB). */
export const SENT_UNKNOWN = "?";
/**
 * Records, just before the release is handed to a client, how to find it there after a restart: a torrent's
 * info-hash, else SENT_UNKNOWN. A row without it was cut off before anything reached a client. False when the grab
 * isn't 'sending' any more (you removed it while its release was fetched): then nothing may be sent (review M4).
 */
export function markHandingOver(id: number, protocol: string, file: { data?: Buffer; magnet?: string }): boolean {
  const ref = protocol === "torrent" ? (torrentHash(file) ?? SENT_UNKNOWN) : SENT_UNKNOWN;
  return db.prepare("UPDATE grabs SET client_ref = ? WHERE id = ? AND state = 'sending'").run(ref, id).changes > 0;
}

/** The user removed this grab while it was being sent (removeGrab claims it, then closes it as "removed by you"). */
export function removedByYou(id: number): boolean {
  const r = db.prepare("SELECT state, error FROM grabs WHERE id = ?").get(id) as { state: string; error: string | null } | undefined;
  return !!r && (r.state === "removing" || (r.state === "failed" && /^removed by you/.test(r.error ?? "")));
}

/**
 * A send that finished after the user removed it: out of the client again, or a clear note when that fails. A
 * torrent the client already had before this add (a duplicate) is someone else's: it is left alone (review M4).
 */
export async function takeBackOut(deps: PipelineDeps, job: ClientJob, release: string, tvdbId: number | null) {
  if (job.duplicate) {
    logDecision("info", {
      tvdbId,
      release,
      why: `You removed ${release} while it was being sent; ${clientName(job.client)} already had that torrent before, so it was left as it was`,
    });
    return;
  }
  try {
    await deps.clients.remove(job);
  } catch (e) {
    logDecision("fail", {
      tvdbId,
      release,
      why: `You removed ${release} while it was being sent, but taking it back out of ${clientName(job.client)} failed (${(e as Error).message}); remove it there by hand`,
    });
  }
}
/** Default stall time (tests); the live value is Settings → queueHealth.stallHours. */
export const STALL_MS = 6 * 3_600_000;
export const MAX_ATTEMPTS = 3;

/**
 * Sets a grab's state. `from` makes it a compare-and-set: only a grab still in one of those states changes (true when
 * it did). Every change made after an await passes the state it read, so a grab the user removed meanwhile is never
 * brought back (blind review of the jobs branch, H2/M1).
 */
export const setState = (
  id: number,
  state: string,
  error: string | null = null,
  extra: { client?: string; ref?: string } = {},
  from?: string[],
): boolean =>
  db
    .prepare(
      `UPDATE grabs SET state = ?, error = ?, updated_at = ?, client = COALESCE(?, client), client_ref = COALESCE(?, client_ref) WHERE id = ?${from ? ` AND state IN (${from.map(() => "?").join(",")})` : ""}`,
    )
    .run(state, error, Date.now(), extra.client ?? null, extra.ref ?? null, id, ...(from ?? [])).changes > 0;

export function isBlocked(c: { guid: string; title: string }) {
  return !!db.prepare("SELECT 1 FROM blocklist WHERE release = ? OR (guid IS NOT NULL AND guid = ?) LIMIT 1").get(c.title, c.guid);
}

/** The .nzb/.torrent couldn't be fetched: the indexer's problem (health), not the release's or the episode's. */
export class FetchFailedError extends Error {
  readonly fetchFailed = true;
  constructor(
    message: string,
    readonly indexerId: number | null,
  ) {
    super(message);
  }
}
export const isFetchFailure = (e: unknown): e is FetchFailedError => !!(e as { fetchFailed?: boolean } | null)?.fetchFailed;
/** Prefix of a fetch failure's message (also how it's recognised in grabs.error). */
export const FETCH_PREFIX = "Couldn't download the";

/**
 * Fetches the NZB/torrent. A failing download link counts against the indexer (ranking penalty, then the circuit
 * breaker after 3 in a row), except Prowlarr's HTTP 500 on non-ASCII titles, which isn't the indexer's fault. The
 * caller moves on to a candidate from another indexer without using up an attempt (no blocklist: the release is fine).
 */
export async function fetchOrNote(deps: PipelineDeps, c: Candidate) {
  try {
    const out = await deps.fetchRelease({
      guid: c.guid,
      title: c.title,
      size: c.size,
      indexerId: c.indexerId,
      indexer: c.indexer,
      protocol: c.protocol,
      downloadUrl: c.downloadUrl,
      magnetUrl: c.magnetUrl,
    });
    recordIndexerSuccess(c.indexerId);
    return out;
  } catch (e) {
    const msg = describeFetchError(e, c.downloadUrl);
    if (isTitleEncodingError(msg, c.title))
      throw new FetchFailedError(
        `${FETCH_PREFIX} release: Prowlarr couldn't serve it (HTTP 500 on its non-ASCII name); trying the next one`,
        null,
      );
    recordIndexerFailure(c.indexerId, msg, Date.now(), { name: c.indexer });
    throw new FetchFailedError(
      `${FETCH_PREFIX} ${c.protocol === "usenet" ? ".nzb" : ".torrent"} from ${c.indexer ?? "the indexer"}: ${msg}`,
      c.indexerId ?? null,
    );
  }
}

/**
 * What's left to try: not blocklisted, not from an indexer that's off; after a fetch failure, not from that same
 * indexer either (its host is likely down for all of them).
 */
export function remainingFallbacks(fallbacks: Candidate[], failed?: unknown) {
  const badIndexer = isFetchFailure(failed) ? failed.indexerId : null;
  return fallbacks.filter((f) => !isBlocked(f) && !indexerOff(f.indexerId) && !(badIndexer && f.indexerId === badIndexer));
}

export function blocklist(row: GrabRow, reason: string) {
  return Number(
    db
      .prepare("INSERT INTO blocklist (guid, release, tvdb_id, reason, at, movie_id, protocol, indexer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.guid, row.release, row.tvdb_id, reason, Date.now(), row.movie_id ?? null, row.protocol ?? null, row.indexer ?? null)
      .lastInsertRowid,
  );
}

export const VIDEO = /\.(mkv|mp4|avi|m4v|ts|webm)$/i;

/** *arr mediaInfo runTime ("23:40" or "1:58:12") → seconds. */
export function runTimeSec(rt: string | null | undefined): number | null {
  const parts = (rt ?? "").split(":").map(Number);
  if (parts.length < 2 || !parts.every(Number.isFinite)) return null;
  return parts.reduce((s, n) => s * 60 + n, 0);
}

/**
 * ManualImport mode: torrents are copied (hardlinked when the *arr has hardlinks on) so they keep seeding; Usenet
 * downloads are moved. "auto" would move untracked downloads, which pulls files out from under qBittorrent.
 */
export const importModeFor = (client: string | null): "copy" | "move" => (isTorrentClient(client) ? "copy" : "move");

/** "Retry import" for a grab that downloaded fine but couldn't be imported. */
export function retryImport(id: number) {
  const r = db
    .prepare(
      "UPDATE grabs SET state = 'downloading', error = NULL, updated_at = ?, progress_at = ? WHERE id = ? AND state = 'needs-attention' AND client IS NOT NULL",
    )
    .run(Date.now(), Date.now(), id);
  if (!r.changes) {
    const g = db.prepare("SELECT state, client FROM grabs WHERE id = ?").get(id) as { state: string; client: string | null } | undefined;
    if (g?.state === "needs-attention" && g.client === null)
      throw Object.assign(
        new Error(
          "This grab has no download client on record, so there's nothing to import; check the client, or remove it to search again",
        ),
        {
          statusCode: 409,
        },
      );
    throw Object.assign(new Error("Only grabs that need attention can be retried"), { statusCode: 409 });
  }
}

/** A search result as a grab candidate. */
export function toCandidate(r: SearchResult): Candidate {
  return {
    guid: r.guid,
    title: r.title,
    indexerId: r.indexerId,
    indexer: r.indexer,
    protocol: r.protocol,
    size: r.size,
    downloadUrl: r.downloadUrl,
    magnetUrl: r.magnetUrl,
    label: r.label,
    group: r.group,
    why: r.rank.why,
    episodeIds: r.episodeIds,
  };
}
