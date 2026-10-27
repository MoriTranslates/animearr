/**
 * Grab → download → (verify) → import → verify, with explicit episode IDs (works even when the series is unmonitored in
 * Sonarr). All side effects go through `PipelineDeps` so the whole flow is testable with mocks, and every step writes a
 * plain-language entry to the activity log.
 *
 * Safety rails:
 * - DRY-RUN: nothing is sent to a download client; the log says "would grab X".
 * - Allowed root folders: AnimeArr refuses to grab for / import into a series outside them.
 * - A pack never replaces episodes that already have a file (only asked-for or missing episodes are imported).
 * - Never two downloads for the same episode at once.
 * - On a failed download/verification the release is blocklisted and the next candidate is tried (3 attempts in all).
 *   Problems that aren't the release's fault (import errors, unmappable files) go to "needs attention" instead.
 */
import { refuseDropped } from "./dropped.js";
import { seedLimitsFor } from "./indexers.js";
import { supersededBy } from "./fixes.js";
import { episodesAreNew, grabGate, GrabsPausedError } from "./downloads.js";
import { executeImport, listVideos, planImport } from "./importer.js";
import { isNativeSeriesId } from "./native.js";
import path from "node:path";
import { logDecision } from "./activity.js";
import { fetchReleaseFile as realFetchRelease, type ProwlarrRelease } from "./arr/prowlarr.js";
import { isTorrentClient, realClients, type ClientJob, type DownloadClients } from "./arr/clients.js";
import * as radarr from "./arr/radarr.js";
import * as sonarr from "./arr/sonarr.js";
import { identify } from "./core/identify.js";
import { langList } from "./core/langs.js";
import { parseRelease } from "./core/parser.js";
import { cache, db, dbState } from "./db.js";
import { burnedInFact } from "./audit.js";
import { learnFromVerify, refreshSeriesEpisodes, sourceKey } from "./library.js";
import { clientToSonarr, localPath as realLocalPath } from "./paths.js";
import { episodesFor, identifyContext, seriesByTvdb, type SearchResult } from "./search.js";
import { profileFor } from "./profiles.js";
import { getSettings, isDryRun, underAllowedRoot } from "./settings.js";
import { ffprobe, judge, type ProbeResult } from "./verify.js";
import { cleanUnpacked, extractIfNeeded, UNPACK_DIR, type ExtractOutcome } from "./extract.js";
import { importMovie, movieNextForRow } from "./movies.js";
import { describeFetchError, indexerOff, isTitleEncodingError, recordIndexerFailure, recordIndexerSuccess } from "./health.js";
import { scanFolder } from "./mediafiles.js";
import { radarrMovieSpecials, refuseMovieSpecials } from "./franchise.js";

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

export const realDeps: PipelineDeps = {
  clients: realClients,
  fetchRelease: realFetchRelease,
  cleanup: (id, outcome) => import("./downloads.js").then((m) => m.cleanupGrab(id, outcome)),
  sonarr: { preview: sonarr.manualImportPreview, importFiles: sonarr.manualImport, command: sonarr.getCommand, episode: sonarr.getEpisode, episodeFile: sonarr.getEpisodeFile },
  radarr: { preview: radarr.radarrImportPreview, importFiles: radarr.radarrManualImport, command: radarr.getRadarrCommand, movie: radarr.getMovie },
  probe: (f) => ffprobe(f),
  localPath: realLocalPath,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  refreshSeries: (id) => refreshSeriesEpisodes(id),
  extract: (dir, key, only) => extractIfNeeded(dir, key, { only }),
};

export type Candidate = Pick<SearchResult, "guid" | "title" | "indexerId" | "indexer" | "protocol" | "size" | "downloadUrl" | "magnetUrl" | "label" | "group"> & { why: string; episodeIds: number[] };

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
}

/** Grab states that are still in flight (a new grab for the same episode must wait for these). */
export const ACTIVE = ["sending", "downloading", "importing"];
/** Default stall time (tests); the live value is Settings → queueHealth.stallHours. */
export const STALL_MS = 6 * 3_600_000;
export const MAX_ATTEMPTS = 3;

export const setState = (id: number, state: string, error: string | null = null, extra: { client?: string; ref?: string } = {}) =>
  db.prepare("UPDATE grabs SET state = ?, error = ?, updated_at = ?, client = COALESCE(?, client), client_ref = COALESCE(?, client_ref) WHERE id = ?").run(state, error, Date.now(), extra.client ?? null, extra.ref ?? null, id);

function managedDryRun(tvdbId: number): boolean | null {
  const r = db.prepare("SELECT dry_run FROM managed WHERE tvdb_id = ?").get(tvdbId) as { dry_run: number } | undefined;
  return r ? !!r.dry_run : null;
}

export function isBlocked(c: { guid: string; title: string }) {
  return !!db.prepare("SELECT 1 FROM blocklist WHERE release = ? OR (guid IS NOT NULL AND guid = ?) LIMIT 1").get(c.title, c.guid);
}

/** Managed-schedule bookkeeping: the episodes of a finished/failed grab go to "done" or back to "retry". */
function scheduleAfter(episodeIds: number[], outcome: "done" | "retry", why: string) {
  const now = Date.now();
  for (const e of episodeIds)
    db.prepare("UPDATE search_state SET state = CASE WHEN ? = 'retry' AND kind = 'backlog' THEN 'backlog' ELSE ? END, next_at = ?, last_why = ? WHERE episode_id = ? AND state = 'grabbed'").run(outcome, outcome, outcome === "done" ? now : now + 30 * 60_000, why, e);
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
    const out = await deps.fetchRelease({ guid: c.guid, title: c.title, size: c.size, indexerId: c.indexerId, indexer: c.indexer, protocol: c.protocol, downloadUrl: c.downloadUrl, magnetUrl: c.magnetUrl });
    recordIndexerSuccess(c.indexerId);
    return out;
  } catch (e) {
    const msg = describeFetchError(e, c.downloadUrl);
    if (isTitleEncodingError(msg, c.title)) throw new FetchFailedError(`${FETCH_PREFIX} release: Prowlarr couldn't serve it (HTTP 500 on its non-ASCII name); trying the next one`, null);
    recordIndexerFailure(c.indexerId, msg, Date.now(), { name: c.indexer });
    throw new FetchFailedError(`${FETCH_PREFIX} ${c.protocol === "usenet" ? ".nzb" : ".torrent"} from ${c.indexer ?? "the indexer"}: ${msg}`, c.indexerId ?? null);
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

/** Starts a grab (or records what it would do in dry-run). */
export async function startGrab(req: GrabRequest, deps: PipelineDeps = realDeps): Promise<{ id: number; dryRun: boolean; message: string; failed?: boolean }> {
  if (dbState.corrupt) throw Object.assign(new Error("The database failed its integrity check; restore a backup first"), { statusCode: 503 });
  const series = seriesByTvdb(req.tvdbId);
  if (!series) throw Object.assign(new Error("Unknown series; sync the library first"), { statusCode: 404 });
  refuseDropped(req.tvdbId); // a show the user dropped is never grabbed, whoever asks
  if (!underAllowedRoot(series.path)) {
    const roots = getSettings().allowedRoots;
    throw Object.assign(new Error(`${series.title} is in ${path.posix.dirname(series.path)}, which is not an allowed root folder${roots.length ? ` (${roots.join(", ")})` : ""}. AnimeArr only grabs and imports for shows inside the root folders you allowed in Settings → Safety.`), { statusCode: 403 });
  }
  const c = req.candidate;
  const dryRun = req.origin === "manual" ? getSettings().managed.dryRun || (!!req.automatic && managedDryRun(req.tvdbId) === true) : isDryRun(managedDryRun(req.tvdbId));
  // Import only what was asked for, plus episodes of the release that have no file yet: a pack must never replace
  // files the library already has (the user's rule: never delete library files).
  // S0 "episodes" that are really movies belong to Radarr: never grab them as episodes (double download).
  refuseMovieSpecials(series.id, req.episodeIds);
  const asMovie = radarrMovieSpecials(series.id);
  const all = episodesFor(req.tvdbId);
  // A pack that also contains a movie special: the special is left to Radarr (not imported as an episode).
  const importIds = c.episodeIds.filter((id) => !asMovie.has(id) && (req.episodeIds.includes(id) || all.some((e) => e.id === id && !e.hasFile)));
  if (!importIds.length) throw Object.assign(new Error("This release doesn't cover the episodes asked for"), { statusCode: 400 });
  // Download-folder rules (the strictest wins). Free space applies to every attempt; the folder rules to new grabs
  // (a fallback after a failure isn't one), and a grab the user starts by hand may pass them.
  if (!dryRun) {
    const gate = grabGate("show", episodesAreNew(importIds), { manual: req.origin === "manual" && !req.automatic });
    if (gate.paused && ((req.attempt ?? 1) === 1 || /free/.test(gate.why))) throw new GrabsPausedError(`Grabs are paused: ${gate.why}`);
  }
  // Never two downloads for the same episode at once (manual + scheduled, or a double click).
  if (!dryRun) {
    const active = db.prepare(`SELECT id, episode_ids, release FROM grabs WHERE state IN (${ACTIVE.map(() => "?").join(",")})`).all(...ACTIVE) as { id: number; episode_ids: string; release: string }[];
    const clash = active.find((g) => (JSON.parse(g.episode_ids) as number[]).some((x) => importIds.includes(x)));
    if (clash) throw Object.assign(new Error(`Already downloading ${clash.release} for this episode (grab ${clash.id})`), { statusCode: 409 });
  }
  const eps = all.filter((e) => importIds.includes(e.id));
  const target = eps.map((e) => `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")} (episode id ${e.id})`).join(", ");
  const now = Date.now();
  const ins = db
    .prepare("INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, indexer_id, protocol, state, dry_run, origin, why, candidates, attempt, progress_at, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(now, now, req.tvdbId, series.id, JSON.stringify(importIds), c.title, c.guid, c.indexerId, c.protocol, dryRun ? "dry-run" : "sending", dryRun ? 1 : 0, req.origin, c.why, JSON.stringify(req.fallbacks.slice(0, 5)), req.attempt ?? 1, now, req.purpose ?? null);
  const id = Number(ins.lastInsertRowid);
  if (dryRun) {
    const msg = `would grab ${c.title} (${c.protocol}, ${c.indexer}) for ${series.title} ${c.label}: ${c.why}. Would import into Sonarr as ${target}.`;
    logDecision("would-grab", { tvdbId: req.tvdbId, title: series.title, episodeIds: importIds, release: c.title, why: `Dry-run: ${msg}`, detail: { grabId: id, fallbacks: req.fallbacks.length } });
    return { id, dryRun: true, message: msg };
  }
  try {
    const file = await fetchOrNote(deps, c);
    let job: ClientJob;
    if (c.protocol === "usenet") {
      if (!file.data) throw new Error("No NZB data");
      job = await deps.clients.addNzb(file.data, c.title);
    } else job = await deps.clients.addTorrent(file, c.title, seedLimitsFor(c.indexerId));
    if (!db.prepare("UPDATE grabs SET state = 'downloading', error = NULL, updated_at = ?, client = ?, client_ref = ? WHERE id = ? AND state = 'sending'").run(Date.now(), job.client, job.ref, id).changes) {
      // Closed while it was being sent: take it back out of the client.
      await deps.clients.remove(job).catch(() => undefined);
      return { id, dryRun: false, message: "Cancelled", failed: true };
    }
    logDecision("grab", { tvdbId: req.tvdbId, title: series.title, episodeIds: importIds, release: c.title, why: `Sent ${c.title} to ${job.client === "sabnzbd" ? "SABnzbd" : "qBittorrent"} (category ${job.client === "sabnzbd" ? getSettings().sabnzbd.category : getSettings().qbittorrent.category}) for ${series.title} ${c.label}: ${c.why}`, detail: { grabId: id } });
    return { id, dryRun: false, message: `Sent to ${job.client}` };
  } catch (e) {
    setState(id, "failed", (e as Error).message);
    logDecision("fail", { tvdbId: req.tvdbId, title: series.title, episodeIds: importIds, release: c.title, why: `Couldn't send ${c.title}: ${(e as Error).message}`, detail: { grabId: id } });
    // A fetch failure doesn't use up an attempt: the next candidate (from another indexer) gets a full try.
    const next = await tryNext(id, { ...req, attempt: (req.attempt ?? 1) - (isFetchFailure(e) ? 1 : 0) }, deps, (e as Error).message, e);
    return next ?? { id, dryRun: false, message: (e as Error).message, failed: true };
  }
}

async function tryNext(grabId: number, req: GrabRequest, deps: PipelineDeps, reason: string, cause?: unknown): Promise<Awaited<ReturnType<typeof startGrab>> | null> {
  const attempt = (req.attempt ?? 1) + 1;
  // Skip fallbacks that got blocklisted meanwhile (e.g. the same release cross-posted on another indexer), and those
  // from an indexer that is off or whose download link just failed.
  const [next, ...rest] = remainingFallbacks(req.fallbacks, cause);
  if (!next || attempt > MAX_ATTEMPTS) {
    logDecision("skip", { tvdbId: req.tvdbId, episodeIds: req.episodeIds, why: `No more candidates to try after: ${reason}${attempt > MAX_ATTEMPTS ? ` (${MAX_ATTEMPTS} attempts used)` : ""}`, detail: { grabId } });
    scheduleAfter(req.episodeIds, "retry", `last grab failed: ${reason}`);
    return null;
  }
  logDecision("info", { tvdbId: req.tvdbId, episodeIds: req.episodeIds, release: next.title, why: `Trying the next candidate ${next.title} (${next.why})`, detail: { grabId } });
  try {
    return await startGrab({ ...req, candidate: next, fallbacks: rest, attempt }, deps);
  } catch (e) {
    logDecision("skip", { tvdbId: req.tvdbId, episodeIds: req.episodeIds, why: `Couldn't try the next candidate: ${(e as Error).message}`, detail: { grabId } });
    scheduleAfter(req.episodeIds, "retry", (e as Error).message);
    return null;
  }
}

export function blocklist(row: GrabRow, reason: string) {
  db.prepare("INSERT INTO blocklist (guid, release, tvdb_id, reason, at, movie_id) VALUES (?, ?, ?, ?, ?, ?)").run(row.guid, row.release, row.tvdb_id, reason, Date.now(), row.movie_id ?? null);
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

/** After a restart: grabs caught mid-import need a look; grabs caught mid-send never reached a client. */
export function recoverGrabs() {
  if (dbState.corrupt) return;
  db.prepare("UPDATE grabs SET state = 'needs-attention', error = 'AnimeArr restarted during the import; check the show folder, then retry the import' WHERE state = 'importing'").run();
  db.prepare("UPDATE grabs SET state = 'failed', error = 'AnimeArr restarted while sending to the download client' WHERE state = 'sending' AND updated_at < ?").run(Date.now() - 10 * 60_000);
}

let ticking = false;
/** One pass over in-flight grabs: checks the download clients, then imports and verifies finished downloads. */
export async function pipelineTick(deps: PipelineDeps = realDeps, now = Date.now()) {
  if (dbState.corrupt || ticking) return;
  ticking = true;
  try {
    const rows = db.prepare("SELECT * FROM grabs WHERE state = 'downloading' ORDER BY id").all() as unknown as GrabRow[];
    const ready: { row: GrabRow; path: string }[] = [];
    for (const row of rows) {
      try {
        const job = { client: row.client as ClientJob["client"], ref: row.client_ref! };
        const st = await deps.clients.status(job);
        const qh = getSettings().queueHealth;
        const stallMs = qh.stallHours * 3_600_000;
        const noMetadata = /metaDL/i.test(st.clientStatus ?? "");
        // Waiting in the client's queue behind other downloads, paused, or post-processing isn't stalling: restart the
        // clock. After 3 days of that the Queue page says so (nothing is removed).
        if (st.state === "queued" && !noMetadata) {
          const long = now - row.at > 3 * 86_400_000 ? `still waiting in the download client after ${Math.floor((now - row.at) / 86_400_000)} days (${st.clientStatus ?? "queued"})` : null;
          db.prepare("UPDATE grabs SET progress_at = ?, progress = MAX(COALESCE(progress, 0), ?), error = ? WHERE id = ?").run(now, st.progress, long, row.id);
          continue;
        }
        if (st.state === "error") {
          // Often transient (disk full, permissions): don't blocklist or delete; the user decides on the Queue page.
          setState(row.id, "needs-attention", `${st.message ?? "the download client reports an error"}; check the client, then retry or remove it`);
          continue;
        }
        // Time spent in metaDL (the queued branch keeps progress_at fresh until the torrent starts fetching metadata).
        const metadataStuck = noMetadata && now - (row.progress_at ?? row.at) > qh.metadataMin * 60_000;
        const stalled = st.state === "downloading" && !noMetadata && now - (row.progress_at ?? row.updated_at) > stallMs && (row.progress ?? -1) >= st.progress;
        if (st.state === "failed" || stalled || metadataStuck) {
          const why = metadataStuck
            ? `the torrent found no peers to get its metadata from in ${qh.metadataMin} min`
            : stalled
              ? `no download progress for ${qh.stallHours} hours${st.seeders === 0 ? " (no seeders)" : ""}`
              : `download failed${st.message ? `: ${st.message}` : ""}`;
          setState(row.id, "failed", why);
          blocklist(row, why);
          let removed = "";
          if (qh.removeFailed) {
            try {
              await deps.clients.remove(job);
              removed = `; removed it from ${job.client === "sabnzbd" ? "SABnzbd" : "qBittorrent"}`;
            } catch (e) {
              removed = `; couldn't remove it from the download client (${(e as Error).message})`;
            }
          }
          logDecision("fail", { tvdbId: row.tvdb_id, title: rowTitle(row), episodeIds: JSON.parse(row.episode_ids), release: row.release, why: `${why}; blocklisted ${row.release}${removed}`, detail: { grabId: row.id }, undo: { action: "unblock", args: { release: row.release } } });
          if (row.movie_id) await movieNextForRow(row, deps, why);
          else await tryNext(row.id, rowRequest(row), deps, why);
        } else if (st.state === "missing") {
          // The job vanished from the client (e.g. its history was cleared by hand): not the release's fault.
          setState(row.id, "needs-attention", "the download disappeared from the download client");
        } else if (st.state === "completed" && st.path) {
          // Downloaded: wait in the import line (progress 1 = "waiting to import"; the UI shows the position).
          if ((row.progress ?? 0) < 1) db.prepare("UPDATE grabs SET progress = 1, progress_at = ? WHERE id = ?").run(now, row.id);
          ready.push({ row, path: st.path });
        } else if ((row.progress ?? -1) < st.progress) {
          db.prepare("UPDATE grabs SET progress = ?, progress_at = ? WHERE id = ?").run(st.progress, now, row.id);
        }
      } catch (e) {
        db.prepare("UPDATE grabs SET error = ? WHERE id = ?").run((e as Error).message, row.id);
      }
    }
    // Imports: two lines in parallel at most; each show or movie in one line (never two at once for the same one).
    const groups = new Map<string, typeof ready>();
    for (const r of ready) {
      const key = r.row.movie_id ? `m${r.row.movie_id}` : `s${r.row.tvdb_id}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const lines = [...groups.values()];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(IMPORT_SLOTS, lines.length) }, async () => {
        while (next < lines.length) {
          for (const { row, path: p } of lines[next++]) {
            // Claim the row so an overlapping tick can't import it twice.
            if (!db.prepare("UPDATE grabs SET state = 'importing', updated_at = ? WHERE id = ? AND state = 'downloading'").run(Date.now(), row.id).changes) continue;
            try {
              if (row.movie_id) await importMovie(row, p, deps);
              else await importAndVerify(row, p, deps);
              rescanAfterImport(row);
            } catch (e) {
              setState(row.id, "needs-attention", `import error: ${(e as Error).message}`);
              logDecision("fail", { tvdbId: row.tvdb_id, title: rowTitle(row), episodeIds: JSON.parse(row.episode_ids), release: row.release, why: `Import of ${row.release} hit an error: ${(e as Error).message}. The download is kept; press "Retry import" when the cause is fixed.`, detail: { grabId: row.id } });
            }
          }
        }
      }),
    );
  } finally {
    ticking = false;
  }
}

const IMPORT_SLOTS = 2;

/** Our own file records catch up with an import at once (in the background). */
function rescanAfterImport(row: GrabRow) {
  const folder = row.movie_id
    ? (cache.prepare("SELECT path FROM movies WHERE id = ?").get(row.movie_id) as { path: string } | undefined)?.path
    : seriesByTvdb(row.tvdb_id)?.path;
  if (folder && getSettings().library.scan) void scanFolder(folder).catch(() => undefined);
}

/**
 * Where each in-flight grab is: downloading, waiting to import (with how many are ahead), or importing.
 * Waiting = the client finished (progress 1) and the import line hasn't reached it yet.
 */
export function grabStages(): Map<number, { stage: "downloading" | "waiting" | "importing" | "attention"; ahead: number }> {
  const rows = db.prepare("SELECT id, state, progress FROM grabs WHERE state IN ('sending', 'downloading', 'importing', 'needs-attention') ORDER BY id").all() as { id: number; state: string; progress: number | null }[];
  const out = new Map<number, { stage: "downloading" | "waiting" | "importing" | "attention"; ahead: number }>();
  let waiting = 0;
  for (const r of rows) {
    if (r.state === "importing") out.set(r.id, { stage: "importing", ahead: 0 });
    else if (r.state === "needs-attention") out.set(r.id, { stage: "attention", ahead: 0 });
    else if ((r.progress ?? 0) >= 1) out.set(r.id, { stage: "waiting", ahead: waiting++ });
    else out.set(r.id, { stage: "downloading", ahead: 0 });
  }
  return out;
}

/** Title for activity entries: the show's, or the movie's for movie grabs. */
function rowTitle(row: GrabRow): string | undefined {
  if (row.movie_id) return (cache.prepare("SELECT title FROM movies WHERE id = ?").get(row.movie_id) as { title: string } | undefined)?.title;
  return row.tvdb_id ? (seriesByTvdb(row.tvdb_id)?.title ?? undefined) : undefined;
}

/**
 * Fix buttons. "Keep anyway": import a download whose language check failed (the user decides), if nothing else is
 * already downloading for it. "Try next release": the grab's next candidate.
 */
export function keepGrab(id: number) {
  const row = db.prepare("SELECT * FROM grabs WHERE id = ?").get(id) as GrabRow | undefined;
  if (!row || !["failed", "needs-attention"].includes(row.state) || !row.client_ref) throw Object.assign(new Error("Only a finished download that failed its check can be kept"), { statusCode: 409 });
  const eps = JSON.parse(row.episode_ids) as number[];
  const others = db.prepare(`SELECT id, episode_ids, movie_id FROM grabs WHERE id != ? AND dry_run = 0 AND state IN (${ACTIVE.map(() => "?").join(",")})`).all(id, ...ACTIVE) as { id: number; episode_ids: string; movie_id: number | null }[];
  const clash = others.find((o) => (row.movie_id ? o.movie_id === row.movie_id : (JSON.parse(o.episode_ids) as number[]).some((e) => eps.includes(e))));
  if (clash) throw Object.assign(new Error(`Another download for it is already running (grab ${clash.id}); remove that one first`), { statusCode: 409 });
  const newer = supersededBy(id);
  if (newer) throw Object.assign(new Error(`A newer download (grab ${newer}) already replaced this one; keeping the old one would overwrite it`), { statusCode: 409 });
  if (/already imported/i.test(row.error ?? "")) throw Object.assign(new Error("This one is already imported; it stays until a better release is found"), { statusCode: 409 });
  if (!db.prepare("UPDATE grabs SET keep = 1, state = 'downloading', error = NULL, updated_at = ?, progress_at = ? WHERE id = ? AND state IN ('failed', 'needs-attention')").run(Date.now(), Date.now(), id).changes)
    throw Object.assign(new Error("This download changed meanwhile; refresh and try again"), { statusCode: 409 });
  db.prepare("DELETE FROM blocklist WHERE release = ?").run(row.release);
  logDecision("info", { tvdbId: row.tvdb_id, episodeIds: eps, release: row.release, why: `You kept ${row.release}: it will be imported despite the language check`, detail: { grabId: id, movieId: row.movie_id } });
}

export async function nextForGrab(id: number, deps: PipelineDeps = realDeps) {
  const row = db.prepare("SELECT * FROM grabs WHERE id = ?").get(id) as GrabRow | undefined;
  if (!row || !["failed", "needs-attention"].includes(row.state)) throw Object.assign(new Error("Only a failed download or one that needs attention can move on to the next release"), { statusCode: 409 });
  const newer = supersededBy(id);
  if (newer) throw Object.assign(new Error(`A newer download (grab ${newer}) is already handling it`), { statusCode: 409 });
  if (row.state === "needs-attention") setState(id, "failed", "you moved on to the next release");
  if (!db.prepare("SELECT 1 FROM blocklist WHERE release = ? LIMIT 1").get(row.release)) blocklist(row, "you moved on to the next release");
  if (row.movie_id) {
    const { movieNextForRow } = await import("./movies.js");
    return movieNextForRow(row, deps, "you moved on to the next release");
  }
  return tryNext(id, rowRequest(row), deps, "you moved on to the next release");
}

function rowRequest(row: GrabRow): GrabRequest {
  const fallbacks = JSON.parse(row.candidates) as Candidate[];
  return { tvdbId: row.tvdb_id, episodeIds: JSON.parse(row.episode_ids), candidate: fallbacks[0], fallbacks, origin: row.origin, attempt: row.attempt ?? 1, purpose: row.purpose ?? null };
}

/** Imports a finished download through Sonarr's ManualImport with explicit episode IDs, verifying before and after. */
export async function importAndVerify(row: GrabRow, clientPath: string, deps: PipelineDeps = realDeps) {
  const series = seriesByTvdb(row.tvdb_id);
  const wanted = JSON.parse(row.episode_ids) as number[];
  let unpacked: string | null = null;
  const fail = async (why: string, imported: boolean) => {
    if (unpacked) {
      try {
        cleanUnpacked(unpacked);
      } catch {
        /* leftovers are harmless */
      }
    }
    setState(row.id, "failed", why);
    blocklist(row, why);
    // Rejected: its download goes with the next clean-up sweep, an hour from now, so "Keep anyway" still has its files.
    const cleans = getSettings().downloads.cleanup === "auto" && getSettings().downloads.allowDelete;
    logDecision("verify-fail", { tvdbId: row.tvdb_id, title: series?.title, episodeIds: wanted, release: row.release, why: `${row.release} failed verification: ${why}${imported ? " (already imported; it will be replaced if a better release is found)" : ""}. Blocklisted it${cleans ? "; its download is cleaned up in about an hour unless you choose Keep anyway" : ""}; looking for the next release.`, detail: { grabId: row.id }, undo: { action: "unblock", args: { release: row.release } } });
    await tryNext(row.id, rowRequest(row), deps, why);
  };
  /** Problems that aren't the release's fault: no blocklist, no next candidate; the user can retry the import. */
  const attention = (why: string) => {
    setState(row.id, "needs-attention", why);
    logDecision("fail", { tvdbId: row.tvdb_id, title: series?.title, episodeIds: wanted, release: row.release, why: `Downloaded ${row.release} but couldn't import it: ${why}. The download is kept; fix the cause and press "Retry import".`, detail: { grabId: row.id } });
  };
  if (!series || !underAllowedRoot(series.path)) return attention("the series is outside the allowed root folders");
  const sonarrPath0 = clientToSonarr(clientPath);
  const singleArchive = /\.(rar|zip|7z)$/i.test(sonarrPath0);
  // A single-file torrent that is an archive: its folder is the shared category folder.
  const sonarrPath = singleArchive ? path.posix.dirname(sonarrPath0) : sonarrPath0;
  const single = VIDEO.test(sonarrPath);
  const folder = single ? path.posix.dirname(sonarrPath) : sonarrPath;
  // Torrents that arrive as archives: unpack (in the background) into the grab's own subfolder first; Sonarr then
  // MOVES the unpacked files, so the archives keep seeding and nothing is left behind. SABnzbd unpacks by itself.
  let unpackRel: string | null = null;
  if (!single && isTorrentClient(row.client) && getSettings().extraction.enabled && deps.extract) {
    const local = deps.localPath(folder);
    if (!local) return attention(`can't reach ${folder} from AnimeArr to unpack it (check Settings → Paths)`);
    const x = await deps.extract(local, String(row.id), singleArchive ? [path.posix.basename(sonarrPath0)] : undefined);
    if (x.kind === "pending") {
      // Hand the row back to the tick; it polls again next round.
      db.prepare("UPDATE grabs SET state = 'downloading', error = 'unpacking…', updated_at = ?, progress_at = ? WHERE id = ? AND state = 'importing'").run(Date.now(), Date.now(), row.id);
      return;
    }
    if (x.kind === "unavailable") return attention(x.why);
    if (x.kind === "broken") return fail(x.why, false);
    if (x.kind === "extracted") {
      unpacked = x.dest;
      unpackRel = `${folder}/${UNPACK_DIR}/${row.id}/`;
      logDecision("info", { tvdbId: row.tvdb_id, title: series.title, episodeIds: wanted, release: row.release, why: `Unpacked ${row.release}: ${x.files.length} video file(s)`, detail: { grabId: row.id } });
    }
  } else if (singleArchive) return attention(`${path.posix.basename(sonarrPath0)} is an archive; turn on unpacking in Settings → Safety, or unpack it by hand`);
  // Folder only: given a seriesId, Sonarr's preview ignores the folder and lists the series' library files instead.
  // A native show (added in AnimeArr) has no Sonarr: the folder is listed here.
  const native = isNativeSeriesId(series.id);
  let listed: { path: string; size?: number; quality?: unknown; languages?: unknown; releaseGroup?: string; indexerFlags?: number }[];
  if (native) {
    const localFolder = deps.localPath(folder);
    if (!localFolder) return attention(`can't reach ${folder} from AnimeArr (check Settings → Paths)`);
    listed = listVideos(localFolder).map((f) => ({ path: `${folder}/${path.relative(localFolder, f.path).split(path.sep).join("/")}`, size: f.size }));
  } else listed = await deps.sonarr.preview(folder);
  const items = listed.filter((x) => VIDEO.test(x.path) && !/\bsample\b/i.test(x.path) && (x.size ?? 1e9) > 30e6) as Awaited<ReturnType<PipelineDeps["sonarr"]["preview"]>>;
  // A single-file torrent's folder is the shared category folder: only that one file belongs to this grab.
  // Unpacked: only the unpacked files (they are moved; the torrent's own files must keep seeding).
  const inThis = items.filter((x) => (unpackRel ? x.path.startsWith(unpackRel) : single ? x.path === sonarrPath : x.path.startsWith(`${folder}/`) && !x.path.startsWith(`${folder}/${UNPACK_DIR}/`)));
  if (!inThis.length) return attention(`no video files found in ${single ? sonarrPath : folder}`);

  // Map each file to episodes: single file + single episode is direct; otherwise identify each file name confidently.
  const ctx = identifyContext();
  const minConf = getSettings().managed.minConfidence;
  const plan: { item: (typeof inThis)[number]; episodeIds: number[] }[] = [];
  if (inThis.length === 1 && wanted.length === 1) plan.push({ item: inThis[0], episodeIds: wanted });
  else
    for (const it of inThis) {
      const id = identify(path.posix.basename(it.path), ctx, { tvdbId: row.tvdb_id });
      if (!id.resolution?.ok || id.resolution.confidence < minConf) continue;
      const ids = id.resolution.episodes.map((e) => e.id).filter((x) => wanted.includes(x));
      if (ids.length) plan.push({ item: it, episodeIds: ids });
    }
  const mapped = plan.flatMap((p) => p.episodeIds);
  if (!plan.length) return attention("couldn't tell which file is which episode");
  if (new Set(mapped).size !== mapped.length) return attention("two files look like the same episode; import them by hand");
  const replacing = row.purpose === "replace";
  /** Replace season: episodes that keep their old file (new one failed its check, or isn't in the pack). */
  const kept: { id: number; why: string }[] = replacing ? wanted.filter((e) => !mapped.includes(e)).map((id) => ({ id, why: "not in the pack" })) : [];

  const prof = profileFor(row.tvdb_id);
  // A dual-audio upgrade replaces a placeholder: only a file with the original audio AND the dub counts.
  const strictUpgrade = (v: ReturnType<typeof judge>): ReturnType<typeof judge> => {
    if (row.purpose !== "dual-upgrade" || !v.ok) return v;
    const original = prof.originalLangs ?? ["ja"];
    const dub = (prof.dubLangs ?? []).filter((l) => !original.includes(l));
    const base = v.audio.map((a) => a.split("-")[0]);
    const hasDub = dub.find((l) => base.includes(l));
    const hasOriginal = !original.length || base.some((a) => original.includes(a));
    return hasDub && hasOriginal ? v : { ...v, ok: false, why: `no ${hasDub ? "original" : dub.join("/")} audio (audio: ${v.audio.join("/") || "unknown"}): not the dual-audio release it claimed to be` };
  };
  const parsed = parseRelease(row.release);
  const eps = episodesFor(row.tvdb_id);
  const season = eps.find((e) => wanted.includes(e.id))?.season ?? null;
  const burned = prof.subLangs.find((l) => !!burnedInFact(row.tvdb_id, season, l)) ?? null;
  const expectedMin = eps.find((e) => wanted.includes(e.id))?.runtime ?? null;
  const learnKey = parsed.platform ?? sourceKey(row.release, null, parsed.source);

  // Verify BEFORE import when the file is reachable from here.
  const preVerified = new Set<string>();
  const verdicts: string[] = [];
  for (const p of plan) {
    const local = deps.localPath(p.item.path);
    if (!local) continue;
    const probe = await deps.probe(local);
    const v = strictUpgrade(judge(probe, prof, expectedMin, burned));
    learnFromVerify(parsed.group, learnKey, v.subs, v.audio);
    // Replace season: a new file that fails keeps that episode's old file; the rest of the pack goes ahead.
    if (!v.ok && !row.keep && replacing) {
      for (const id of p.episodeIds) kept.push({ id, why: v.why });
      logDecision("info", { tvdbId: row.tvdb_id, title: series.title, episodeIds: p.episodeIds, release: row.release, why: `Replace season: ${path.posix.basename(p.item.path)} failed its check (${v.why}); the old file stays for ${p.episodeIds.length > 1 ? "these episodes" : "this episode"}`, detail: { grabId: row.id } });
      continue;
    }
    if (!v.ok && !row.keep) return fail(`${path.posix.basename(p.item.path)}: ${v.why}`, false);
    if (!v.ok) logDecision("info", { tvdbId: row.tvdb_id, title: series.title, episodeIds: p.episodeIds, release: row.release, why: `Kept ${path.posix.basename(p.item.path)} as you asked, although: ${v.why}`, detail: { grabId: row.id } });
    preVerified.add(p.item.path);
    verdicts.push(v.why);
    if (v.ok) logDecision("verify-ok", { tvdbId: row.tvdb_id, title: series.title, episodeIds: p.episodeIds, release: row.release, why: `Checked ${path.posix.basename(p.item.path)} before import: ${v.why}`, detail: { grabId: row.id, probe } });
  }

  const files = plan.map((p) => ({
    path: p.item.path,
    seriesId: series.id,
    episodeIds: p.episodeIds,
    quality: p.item.quality,
    languages: p.item.languages,
    releaseGroup: p.item.releaseGroup ?? parsed.group ?? undefined,
    indexerFlags: p.item.indexerFlags ?? 0,
    releaseType: p.episodeIds.length > 1 ? "multiEpisode" : "singleEpisode",
    downloadId: row.client_ref ?? undefined,
  }));
  const startedImport = Date.now();
  // AnimeArr imports by itself (the user's decision): nothing goes through Sonarr's import any more. Whatever can't go
  // through AnimeArr's importer waits in "needs attention". (engine "sonarr" can't be chosen in the settings; it only
  // remains for old tests of the earlier Sonarr route.)
  const imp = getSettings().importer;
  const budgetOk = (imp.realBudget ?? 0) < 0 || (imp.realBudget ?? 0) >= plan.length; // never half a batch
  if (native || imp.engine !== "sonarr") {
    if (!imp.allowReal) return attention("real imports by AnimeArr's importer are switched off (Settings → Media management → Importer)");
    if (!budgetOk) return attention("AnimeArr's importer is paused for a review (Settings → Media management → Importer)");
    const keptIds = new Set(kept.map((k) => k.id));
    const toPlace = plan.filter((p) => !p.episodeIds.some((e) => keptIds.has(e)));
    if (!toPlace.every((p) => preVerified.has(p.item.path))) return attention("AnimeArr couldn't check every file before importing (check Settings → Paths)");
    if (replacing && !toPlace.length) return fail(`none of the pack's files passed the check (${[...new Set(kept.map((k) => k.why))].join("; ")})`, false);
    if (replacing && !getSettings().media.recycleBin.trim()) return attention("Replace season needs AnimeArr's recycling bin (Settings → Media management), so the old files can come back");
    let swapped = 0;
    for (const p of toPlace) {
      try {
        const ip = await planImport({ tvdbId: row.tvdb_id, path: p.item.path, episodeIds: p.episodeIds, release: row.release, client: unpacked ? null : row.client, automatic: true, trusted: clientToSonarr(clientPath) });
        const res = await executeImport(ip, { grabId: row.id });
        const bad = res.find((r) => !r.done);
        if (bad || !res.length) {
          // Replace season: one episode that can't be placed keeps its old file; the others carry on.
          if (replacing) {
            for (const id of p.episodeIds) kept.push({ id, why: bad?.why ?? "nothing to import" });
            continue;
          }
          return attention(`AnimeArr's importer: ${bad?.why ?? "nothing to import"}`);
        }
        swapped++;
        if (replacing) db.prepare("UPDATE grabs SET progress_at = ?, error = ? WHERE id = ?").run(Date.now(), `swapped ${swapped}/${toPlace.length}`, row.id);
      } catch (e) {
        if (replacing) {
          for (const id of p.episodeIds) kept.push({ id, why: (e as Error).message });
          continue;
        }
        return attention(`AnimeArr's importer: ${(e as Error).message}`);
      }
    }
    if (replacing && !swapped) return attention(`Replace season: no episode could be swapped (${[...new Set(kept.map((k) => k.why))].join("; ")}); every old file stays`);
    if (replacing) {
      db.prepare("UPDATE grabs SET error = NULL WHERE id = ?").run(row.id);
      if (kept.length) {
        const label = (id: number) => {
          const e = eps.find((x) => x.id === id);
          return e ? `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}` : String(id);
        };
        logDecision("fail", { tvdbId: row.tvdb_id, title: series.title, episodeIds: kept.map((k) => k.id), release: row.release, why: `Replace season: kept the old file for ${kept.map((k) => `${label(k.id)} (${k.why})`).join(", ")}; needs a look`, detail: { grabId: row.id } });
      }
      const keptNow = new Set(kept.map((k) => k.id));
      // Episodes that kept their old file may still need this download (fix the cause, then Retry import): keep it.
      return finishImport(row, series, mapped.filter((e) => !keptNow.has(e)), eps, verdicts, unpacked, deps, kept.length === 0);
    }
    return finishImport(row, series, mapped, eps, verdicts, unpacked, deps);
  }
  const cmd = await deps.sonarr.importFiles(files, unpacked ? "move" : importModeFor(row.client));
  logDecision("import", { tvdbId: row.tvdb_id, title: series.title, episodeIds: mapped, release: row.release, why: `Asked Sonarr to import ${files.length} file(s) as ${files.map((f) => f.episodeIds.join("+")).join(", ")} (explicit episode IDs, command ${cmd.id})`, detail: { grabId: row.id, commandId: cmd.id } });
  let status = "queued";
  for (let i = 0; i < 120 && !["completed", "failed", "aborted"].includes(status); i++) {
    await deps.sleep(5000);
    status = (await deps.sonarr.command(cmd.id)).status;
  }
  if (status !== "completed") return attention(`Sonarr import ${status}`);

  // After import: every planned episode must now have a file added by THIS import (Sonarr can "complete" a command
  // that rejected a file). Files we couldn't probe ourselves are checked from Sonarr's mediaInfo.
  for (const p of plan) {
    for (const eid of p.episodeIds) {
      const ep = await deps.sonarr.episode(eid);
      const ef = ep.episodeFileId ? await deps.sonarr.episodeFile(ep.episodeFileId) : null;
      const fresh = !!ef && (!ef.dateAdded || Date.parse(ef.dateAdded) >= startedImport - 60_000);
      if (!ef || !fresh) return attention(`Sonarr finished the import but S${ep.seasonNumber}E${ep.episodeNumber} doesn't have the new file (it may have rejected it; check Sonarr's activity)`);
      if (preVerified.has(p.item.path) || eid !== p.episodeIds[0]) continue;
      const subs = langList(ef.mediaInfo?.subtitles);
      const audio = langList(ef.mediaInfo?.audioLanguages);
      // No track info yet (media analysis off or not finished): can't judge, so don't blame the release.
      if (!subs.length && !audio.length) return attention(`Sonarr has no track information for ${path.posix.basename(ef.path)} yet, so the language couldn't be checked; check the file, then retry`);
      const v = strictUpgrade(judge({ subs, audio, durationSec: runTimeSec(ef.mediaInfo?.runTime), sidecars: [], untagged: 0 }, prof, expectedMin, burned));
      learnFromVerify(parsed.group, learnKey, v.subs, v.audio);
      if (!v.ok && !row.keep) return fail(`${path.posix.basename(ef.path)}: ${v.why}`, true);
      verdicts.push(v.why);
      logDecision("verify-ok", { tvdbId: row.tvdb_id, title: series.title, episodeIds: p.episodeIds, release: row.release, why: `Imported and checked ${path.posix.basename(ef.path)}: ${v.why}`, detail: { grabId: row.id } });
    }
  }
  return finishImport(row, series, mapped, eps, verdicts, unpacked, deps);
}

async function finishImport(row: GrabRow, series: NonNullable<ReturnType<typeof seriesByTvdb>>, mapped: number[], eps: ReturnType<typeof episodesFor>, verdicts: string[], unpacked: string | null, deps: PipelineDeps, cleanup = true) {
  setState(row.id, "done");
  if (unpacked) {
    try {
      cleanUnpacked(unpacked);
    } catch {
      /* leftovers are harmless; the next import of this folder reuses them */
    }
  }
  for (const e of mapped) cache.prepare("UPDATE episodes SET has_file = 1 WHERE id = ?").run(e);
  scheduleAfter(mapped, "done", `imported ${row.release}`);
  const labels = eps.filter((e) => mapped.includes(e.id)).map((e) => `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}`);
  logDecision("import", { tvdbId: row.tvdb_id, title: series.title, episodeIds: mapped, release: row.release, why: `Imported ✓ as ${labels.join(", ")}: ${[...new Set(verdicts)].join("; ") || "checked"}`, detail: { grabId: row.id, final: true } });
  try {
    await deps.refreshSeries?.(series.id);
  } catch {
    /* the next sync catches up */
  }
  // Confirmed import (files placed, the show refreshed): the download can go (or once seeding is done).
  if (cleanup) await deps.cleanup?.(row.id, "imported");
}

/** "Retry import" for a grab that downloaded fine but couldn't be imported. */
export function retryImport(id: number) {
  const r = db.prepare("UPDATE grabs SET state = 'downloading', error = NULL, updated_at = ?, progress_at = ? WHERE id = ? AND state = 'needs-attention'").run(Date.now(), Date.now(), id);
  if (!r.changes) throw Object.assign(new Error("Only grabs that need attention can be retried"), { statusCode: 409 });
}

export function listGrabs(limit = 50, opts: { episodesOnly?: boolean } = {}) {
  return (db.prepare(`SELECT * FROM grabs${opts.episodesOnly ? " WHERE movie_id IS NULL" : ""} ORDER BY id DESC LIMIT ?`).all(limit) as unknown as GrabRow[]).map((g) => ({ ...g, episode_ids: JSON.parse(g.episode_ids) as number[], candidates: undefined, fallbacks: (JSON.parse(g.candidates) as unknown[]).length }));
}

/**
 * Queue action: removes one of AnimeArr's own downloads from its client (deleting the downloaded data, never library
 * files). Optionally blocklists the release and tries the next candidate. User-confirmed in the UI.
 */
export async function removeGrab(id: number, opts: { blocklist: boolean; searchNext: boolean }, deps: PipelineDeps = realDeps) {
  if (dbState.corrupt) throw Object.assign(new Error("The database failed its integrity check; restore a backup first"), { statusCode: 503 });
  const row = db.prepare("SELECT * FROM grabs WHERE id = ?").get(id) as GrabRow | undefined;
  if (!row) throw Object.assign(new Error("Unknown download"), { statusCode: 404 });
  // Claim it atomically, so the pipeline can't start importing it meanwhile ("sending" rows are not removable yet).
  if (!db.prepare("UPDATE grabs SET state = 'removing', updated_at = ? WHERE id = ? AND state IN ('downloading', 'needs-attention')").run(Date.now(), id).changes)
    throw Object.assign(new Error(`This download is ${row.state === "sending" ? "still being sent to the client; try again in a moment" : row.state}; only downloading or needs-attention ones can be removed`), { statusCode: 409 });
  // A row that may have been mid-import keeps its files (Sonarr could be moving them right now).
  const mayBeImporting = row.state === "needs-attention" && /^((Sonarr|Radarr) import|AnimeArr restarted during the import|import error)/.test(row.error ?? "");
  if (row.client && row.client_ref && !mayBeImporting) {
    try {
      await deps.clients.remove({ client: row.client as ClientJob["client"], ref: row.client_ref });
    } catch (e) {
      // The download is still there (client unreachable, or it isn't AnimeArr's): put the row back and say so.
      db.prepare("UPDATE grabs SET state = ?, updated_at = ? WHERE id = ? AND state = 'removing'").run(row.state, Date.now(), id);
      throw Object.assign(new Error(`Couldn't remove it from the download client: ${(e as Error).message}`), { statusCode: 502 });
    }
  }
  setState(row.id, "failed", mayBeImporting ? "closed by you (downloaded files kept: an import may have been in progress)" : "removed by you");
  const eps = JSON.parse(row.episode_ids) as number[];
  let undo = null;
  if (opts.blocklist) {
    const r = db.prepare("INSERT INTO blocklist (guid, release, tvdb_id, reason, at, movie_id) VALUES (?, ?, ?, ?, ?, ?)").run(row.guid, row.release, row.tvdb_id, "removed from the queue by you", Date.now(), row.movie_id ?? null);
    undo = { action: "unblock" as const, args: { id: Number(r.lastInsertRowid), release: row.release } };
  }
  logDecision("info", { tvdbId: row.tvdb_id, episodeIds: eps, release: row.release, why: `${mayBeImporting ? "Closed" : "Removed"} ${row.release}${mayBeImporting ? " without deleting its files (an import may have been in progress)" : " from the queue"}${opts.blocklist ? " and blocklisted it" : ""}${opts.searchNext ? "; trying the next candidate" : ""} (you confirmed)`, detail: { grabId: row.id }, undo });
  if (opts.searchNext) return row.movie_id ? movieNextForRow(row, deps, "removed by you") : tryNext(row.id, rowRequest(row), deps, "removed by you");
  scheduleAfter(eps, "retry", "download removed by you");
  return null;
}
