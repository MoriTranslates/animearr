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
import { refuseDropped } from "../library/dropped.js";
import { ownedElsewhere, ownedWhy, type Overlap } from "../library/duplicates.js";
import { seedLimitsFor } from "../search/indexers.js";
import { supersededBy } from "../system/fixes.js";
import { episodesAreNew, grabGate, GrabsPausedError } from "./downloads.js";
import { executeImport, listVideos, planImport } from "../import/importer.js";
import { isNativeSeriesId } from "../library/nativeIds.js";
import path from "node:path";
import { logDecision } from "../system/activity.js";
import { CantLookUp, clientName, isTorrentClient, realClients, type ClientJob, type DownloadClients } from "../arr/clients.js";
import { applySelection, batchLine, existingFiles, planBatch, readBatch, retryStart, type BatchInfo, type ExistingFile } from "./batch.js";
import { identify } from "../core/identify.js";
import { inExtrasFolder } from "../core/resolver.js";
import { langList } from "../core/langs.js";
import { parseRelease } from "../core/parser.js";
import { cache, db, dbState } from "../system/db.js";
import { burnedInFact } from "../library/audit.js";
import { learnFromVerify, sourceKey } from "../library/library.js";
import { clientToSonarr } from "../system/paths.js";
import { episodesFor, identifyContext, seriesByTvdb } from "../search/search.js";
import { profileFor } from "../library/profiles.js";
import { properMode } from "../search/propers.js";
import { getSettings, isDryRun, underAllowedRoot } from "../system/settings.js";
import { judge } from "./verify.js";
import { cleanUnpacked, UNPACK_DIR } from "./extract.js";
import { importMovie, movieFileOpts, movieNextForRow } from "../library/movies.js";
import { scanFolder } from "../import/mediafiles.js";
import { radarrMovieSpecials, refuseMovieSpecials } from "../library/franchise.js";
import { inspectFiles } from "./safety.js";
import {
  ACTIVE,
  blocklist,
  fetchOrNote,
  importModeFor,
  isFetchFailure,
  markHandingOver,
  MAX_ATTEMPTS,
  remainingFallbacks,
  runTimeSec,
  removedByYou,
  SENT_UNKNOWN,
  sendingNow,
  setState,
  takeBackOut,
  VIDEO,
  type Candidate,
  type GrabRequest,
  type GrabRow,
  type PipelineDeps,
} from "./pipelineState.js";
import { episodeFileOpts, realDeps, rejectUnsafeDownload, rowTitle, runtimeOf, selectAfterAdd, unsafeDownload } from "./grabSteps.js";

function managedDryRun(tvdbId: number): boolean | null {
  const r = db.prepare("SELECT dry_run FROM managed WHERE tvdb_id = ?").get(tvdbId) as { dry_run: number } | undefined;
  return r ? !!r.dry_run : null;
}

/** Managed-schedule bookkeeping: the episodes of a finished/failed grab go to "done" or back to "retry". */
function scheduleAfter(episodeIds: number[], outcome: "done" | "retry", why: string) {
  const now = Date.now();
  for (const e of episodeIds)
    db.prepare(
      "UPDATE search_state SET state = CASE WHEN ? = 'retry' AND kind = 'backlog' THEN 'backlog' ELSE ? END, next_at = ?, last_why = ? WHERE episode_id = ? AND state = 'grabbed'",
    ).run(outcome, outcome, outcome === "done" ? now : now + 30 * 60_000, why, e);
}

/**
 * A release that can stand in for a whole season: it maps to more than one episode AND its name isn't one episode
 * (a name the parser once misread as a pack, e.g. "2nd.Season.03", must not replace a season).
 */
export function isSeasonPack(c: Pick<Candidate, "title" | "episodeIds">) {
  if (c.episodeIds.length < 2) return false;
  const p = parseRelease(c.title);
  return !((p.episodes.length === 1 && p.absolute.length <= 1) || (p.absolute.length === 1 && !p.episodes.length));
}

/** A grab that replaces a whole season (the user's Replace season, or the season decision's): packs only. */
const replacesSeason = (req: Pick<GrabRequest, "purpose" | "packsOnly" | "episodeIds">) =>
  (req.purpose === "replace" || !!req.packsOnly) && req.episodeIds.length > 1;

/** Starts a grab (or records what it would do in dry-run). */
export async function startGrab(
  req: GrabRequest,
  deps: PipelineDeps = realDeps,
): Promise<{ id: number; dryRun: boolean; message: string; failed?: boolean }> {
  if (dbState.corrupt)
    throw Object.assign(new Error("The database failed its integrity check; restore a backup first"), { statusCode: 503 });
  const series = seriesByTvdb(req.tvdbId);
  if (!series) throw Object.assign(new Error("Unknown series; sync the library first"), { statusCode: 404 });
  refuseDropped(req.tvdbId); // a show the user dropped is never grabbed, whoever asks
  if (!underAllowedRoot(series.path)) {
    const roots = getSettings().allowedRoots;
    throw Object.assign(
      new Error(
        `${series.title} is in ${path.posix.dirname(series.path)}, which is not an allowed root folder${roots.length ? ` (${roots.join(", ")})` : ""}. AnimeArr only grabs and imports for shows inside the root folders you chose in Settings → Automation & safety → Library folders.`,
      ),
      { statusCode: 403 },
    );
  }
  const c = req.candidate;
  if (replacesSeason(req) && !isSeasonPack(c))
    throw Object.assign(new Error(`Replace season needs a season pack; ${c.title} is a single episode`), { statusCode: 400 });
  const dryRun =
    req.origin === "manual"
      ? getSettings().managed.dryRun || (!!req.automatic && managedDryRun(req.tvdbId) === true)
      : isDryRun(managedDryRun(req.tvdbId));
  // Import only what was asked for, plus episodes of the release that have no file yet: a pack must never replace
  // files the library already has (the user's rule: never delete library files).
  // S0 "episodes" that are really movies belong to Radarr: never grab them as episodes (double download).
  refuseMovieSpecials(series.id, req.episodeIds);
  // Automatic grabs (the scheduler, fill-in, upgrades, ⚡) never buy an episode the library already holds under another
  // series (a duplicate TVDB listing), not even as the extra episodes of a pack. A release the user picks by hand is
  // allowed; the picker warns first.
  const owned = req.origin === "managed" || req.automatic ? ownedElsewhere(req.tvdbId) : new Map<number, Overlap>();
  const hit = req.episodeIds.every((id) => owned.has(id)) ? owned.get(req.episodeIds[0]) : undefined;
  if (hit) {
    logDecision("info", {
      tvdbId: req.tvdbId,
      title: series.title,
      episodeIds: req.episodeIds,
      release: req.candidate.title,
      why: `Not grabbed: ${ownedWhy(hit)}`,
    });
    throw Object.assign(new Error(`${series.title}: ${ownedWhy(hit)}`), { statusCode: 409 });
  }
  const asMovie = radarrMovieSpecials(series.id);
  const all = episodesFor(req.tvdbId);
  // A pack that also contains a movie special: the special is left to Radarr (not imported as an episode).
  let importIds = c.episodeIds.filter(
    (id) => !asMovie.has(id) && !owned.has(id) && (req.episodeIds.includes(id) || all.some((e) => e.id === id && !e.hasFile)),
  );
  // Smart batch: per season, only the missing episodes, or the whole season as a Replace season (batch.ts).
  let purpose = req.purpose ?? null;
  let seasonWhy: string | null = null;
  const inBatch = c.episodeIds.filter((id) => !asMovie.has(id));
  if (inBatch.length > 1 && !req.purpose) {
    const prof = profileFor(req.tvdbId);
    const seasons = [...new Set(all.filter((e) => inBatch.includes(e.id)).map((e) => e.season))];
    const existing = new Map<number, ExistingFile[]>();
    for (const s of seasons) existing.set(s, await existingFiles(series.id, s));
    const plan = planBatch({
      seriesId: series.id,
      candidateEpisodeIds: c.episodeIds,
      baseIds: importIds,
      release: c.title,
      group: c.group ?? null,
      consistency: prof.groupConsistency ?? "prefer",
      profileResolution: prof.resolution,
      recycleBin: !!getSettings().media.recycleBin.trim(),
      propers: properMode(),
      exclude: new Set(asMovie.keys()),
      existingOf: (_sid, s) => existing.get(s) ?? [],
    });
    importIds = plan.importIds;
    purpose = plan.purpose;
    seasonWhy = plan.why;
  }
  if (!importIds.length) throw Object.assign(new Error("This release doesn't cover the episodes asked for"), { statusCode: 400 });
  // Download-folder rules (the strictest wins). Free space applies to every attempt; the folder rules to new grabs
  // (a fallback after a failure isn't one), and a grab the user starts by hand may pass them.
  if (!dryRun) {
    const gate = grabGate("show", episodesAreNew(importIds), { manual: req.origin === "manual" && !req.automatic });
    if (gate.paused && ((req.attempt ?? 1) === 1 || /free/.test(gate.why))) throw new GrabsPausedError(`Grabs are paused: ${gate.why}`);
  }
  // Never two downloads for the same episode at once (manual + scheduled, or a double click).
  if (!dryRun) {
    const active = db
      .prepare(`SELECT id, episode_ids, release FROM grabs WHERE state IN (${ACTIVE.map(() => "?").join(",")})`)
      .all(...ACTIVE) as { id: number; episode_ids: string; release: string }[];
    const clash = active.find((g) => (JSON.parse(g.episode_ids) as number[]).some((x) => importIds.includes(x)));
    if (clash)
      throw Object.assign(new Error(`Already downloading ${clash.release} for this episode (grab ${clash.id})`), { statusCode: 409 });
  }
  const eps = all.filter((e) => importIds.includes(e.id));
  const target = eps
    .map((e) => `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")} (episode id ${e.id})`)
    .join(", ");
  const now = Date.now();
  // A batch that holds more than this grab wants: torrents whose client can skip files download only the wanted ones;
  // everything else downloads the whole batch, imports only the wanted files and cleans the rest after the import.
  const skippedEps = inBatch.filter((e) => !importIds.includes(e));
  const select = c.protocol === "torrent" && skippedEps.length > 0 && !!deps.clients.selectFiles;
  const batch: BatchInfo | null =
    inBatch.length > 1
      ? {
          mode: select ? "pending" : "whole",
          total: inBatch.length,
          wanted: importIds.length,
          skippedEpisodes: skippedEps,
          skippedFiles: 0,
          leftovers: skippedEps.length > 0,
          note: null,
          autoReplace: purpose === "replace" && !req.purpose,
          since: now,
          // Sent stopped for the file choice: recorded before it's sent, so a restart still starts it (M6).
          ...(select ? { paused: true } : {}),
        }
      : null;
  const why = seasonWhy ? `${c.why}. ${seasonWhy}` : c.why;
  // A whole-season replace only ever falls back to another season pack (a single episode can't replace a season).
  const fallbacks = replacesSeason({ purpose, packsOnly: req.packsOnly, episodeIds: importIds.length > 1 ? importIds : req.episodeIds })
    ? req.fallbacks.filter(isSeasonPack)
    : req.fallbacks;
  const ins = db
    .prepare(
      "INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, indexer_id, protocol, state, dry_run, origin, why, candidates, attempt, progress_at, purpose, batch, indexer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      now,
      now,
      req.tvdbId,
      series.id,
      JSON.stringify(importIds),
      c.title,
      c.guid,
      c.indexerId,
      c.protocol,
      dryRun ? "dry-run" : "sending",
      dryRun ? 1 : 0,
      req.origin,
      why,
      JSON.stringify(fallbacks.slice(0, 5)),
      req.attempt ?? 1,
      now,
      purpose,
      batch ? JSON.stringify(batch) : null,
      c.indexer ?? null,
    );
  const id = Number(ins.lastInsertRowid);
  const line = batchLine(batch);
  if (dryRun) {
    const msg = `would grab ${c.title} (${c.protocol}, ${c.indexer}) for ${series.title} ${c.label}: ${why}.${line ? ` ${line}.` : ""} Would import it as ${target}.`;
    logDecision("would-grab", {
      tvdbId: req.tvdbId,
      title: series.title,
      episodeIds: importIds,
      release: c.title,
      why: `Dry-run: ${msg}`,
      detail: { grabId: id, fallbacks: fallbacks.length },
    });
    // The toast says it plainly; the release, indexer and episode ids stay in the activity log.
    return {
      id,
      dryRun: true,
      message: `Practice mode: would download ${series.title} ${c.label}. Nothing was downloaded (details in Activity).`,
    };
  }
  sendingNow.add(id);
  try {
    const file = await fetchOrNote(deps, c);
    let job: ClientJob;
    if (c.protocol === "usenet" && !file.data) throw new Error("No NZB data");
    markHandingOver(id, c.protocol, file);
    if (c.protocol === "usenet") {
      job = await deps.clients.addNzb(file.data!, c.title);
    } else job = await deps.clients.addTorrent(file, c.title, { ...seedLimitsFor(c.indexerId), ...(select ? { paused: true } : {}) });
    if (
      !db
        .prepare(
          "UPDATE grabs SET state = 'downloading', error = NULL, updated_at = ?, client = ?, client_ref = ? WHERE id = ? AND state = 'sending'",
        )
        .run(Date.now(), job.client, job.ref, id).changes
    ) {
      // Closed (removed by you) while it was being sent: take it back out of the client.
      await takeBackOut(deps, job, c.title, req.tvdbId);
      return { id, dryRun: false, message: "Cancelled", failed: true };
    }
    logDecision("grab", {
      tvdbId: req.tvdbId,
      title: series.title,
      episodeIds: importIds,
      release: c.title,
      why: `Sent ${c.title} to ${clientName(job.client)} for ${series.title} ${c.label}: ${why}${line ? `. ${line}` : ""}`,
      detail: { grabId: id },
    });
    if (batch && select)
      await selectAfterAdd(
        id,
        job,
        batch,
        deps,
        { tvdbId: req.tvdbId, title: series.title, release: c.title, episodeIds: importIds },
        !!file.magnet,
      );
    return { id, dryRun: false, message: `Sent to ${job.client}` };
  } catch (e) {
    // Removed by you while it was being sent: the removal stands, no next candidate.
    if (removedByYou(id)) return { id, dryRun: false, message: "Cancelled", failed: true };
    setState(id, "failed", (e as Error).message);
    logDecision("fail", {
      tvdbId: req.tvdbId,
      title: series.title,
      episodeIds: importIds,
      release: c.title,
      why: `Couldn't send ${c.title}: ${(e as Error).message}`,
      detail: { grabId: id },
    });
    // A fetch failure doesn't use up an attempt: the next candidate (from another indexer) gets a full try.
    const next = await tryNext(
      id,
      { ...req, fallbacks, attempt: (req.attempt ?? 1) - (isFetchFailure(e) ? 1 : 0) },
      deps,
      (e as Error).message,
      e,
    );
    return next ?? { id, dryRun: false, message: (e as Error).message, failed: true };
  } finally {
    sendingNow.delete(id);
  }
}

async function tryNext(
  grabId: number,
  req: GrabRequest,
  deps: PipelineDeps,
  reason: string,
  cause?: unknown,
): Promise<Awaited<ReturnType<typeof startGrab>> | null> {
  const attempt = (req.attempt ?? 1) + 1;
  // Skip fallbacks that got blocklisted meanwhile (e.g. the same release cross-posted on another indexer), and those
  // from an indexer that is off or whose download link just failed.
  // A whole-season replace moves on to another season pack only (never a single episode under the season's ids).
  const packs = replacesSeason(req);
  const [next, ...rest] = remainingFallbacks(packs ? req.fallbacks.filter(isSeasonPack) : req.fallbacks, cause);
  if (!next || attempt > MAX_ATTEMPTS) {
    const none = packs && !next ? "; no other season pack to try, so the season is left as it is" : "";
    logDecision("skip", {
      tvdbId: req.tvdbId,
      episodeIds: req.episodeIds,
      why: `No more candidates to try after: ${reason}${attempt > MAX_ATTEMPTS ? ` (${MAX_ATTEMPTS} attempts used)` : none}`,
      detail: { grabId },
    });
    scheduleAfter(req.episodeIds, "retry", `last grab failed: ${reason}`);
    return null;
  }
  logDecision("info", {
    tvdbId: req.tvdbId,
    episodeIds: req.episodeIds,
    release: next.title,
    why: `Trying the next candidate ${next.title} (${next.why})`,
    detail: { grabId },
  });
  try {
    return await startGrab({ ...req, candidate: next, fallbacks: rest, attempt }, deps);
  } catch (e) {
    logDecision("skip", {
      tvdbId: req.tvdbId,
      episodeIds: req.episodeIds,
      why: `Couldn't try the next candidate: ${(e as Error).message}`,
      detail: { grabId },
    });
    scheduleAfter(req.episodeIds, "retry", (e as Error).message);
    return null;
  }
}

/**
 * After a restart: grabs caught mid-import need a look. Grabs caught mid-send are left 'sending' for the pipeline tick
 * to resolve against the download client (resolveCutOffSends): failing them blindly could grab a second copy of one
 * that did arrive, and leaving a fresh one alone left it stuck for good (review 2026-11-02, H9).
 */
export function recoverGrabs() {
  if (dbState.corrupt) return;
  db.prepare(
    "UPDATE grabs SET state = 'needs-attention', error = 'AnimeArr restarted during the import; check the show folder, then retry the import' WHERE state = 'importing'",
  ).run();
}

/** How long a cut-off torrent may go without an answer from its client before it needs a look. */
export const CUTOFF_GIVE_UP_MS = 60 * 60_000;
/** Since when each cut-off row's client couldn't be asked (in memory: a restart gives it another hour). */
const cantTellSince = new Map<number, number>();

/**
 * 'sending' rows this process isn't sending (cut off by a restart): did the release reach a client?
 * - nothing was handed over yet: failed, the next candidate is tried;
 * - a torrent: the clients are asked for its info-hash. There: it moves on to downloading. No client has it: failed,
 *   the next candidate is tried. A client couldn't be asked: it stays 'sending' and is asked again next tick (never
 *   failed, never sent twice), for at most CUTOFF_GIVE_UP_MS; then, or at once when a client can't be asked at all
 *   (a watch folder), it needs a look (review of the jobs branch, H1);
 * - an NZB: looked up by name; any doubt needs a look. The user checks the client and removes it here to search again.
 */
async function resolveCutOffSends(deps: PipelineDeps, now = Date.now()) {
  const rows = (db.prepare("SELECT * FROM grabs WHERE state = 'sending' AND dry_run = 0 ORDER BY id").all() as unknown as GrabRow[]).filter(
    (r) => !sendingNow.has(r.id),
  );
  for (const row of rows) {
    const title = rowTitle(row);
    const retry = async (why: string) => {
      if (
        !db
          .prepare("UPDATE grabs SET state = 'failed', error = ?, updated_at = ? WHERE id = ? AND state = 'sending'")
          .run(why, Date.now(), row.id).changes
      )
        return;
      logDecision("fail", { tvdbId: row.tvdb_id, title, release: row.release, why: `${row.release}: ${why}`, detail: { grabId: row.id } });
      if (row.movie_id) await movieNextForRow(row, deps, why);
      else await tryNext(row.id, rowRequest(row), deps, why);
    };
    if (!row.client_ref) {
      await retry("AnimeArr restarted before it was handed to the download client; trying the next candidate");
      continue;
    }
    const needsLook = (why?: string) =>
      setState(
        row.id,
        "needs-attention",
        `AnimeArr restarted while handing this to the download client and can't tell whether it arrived${why ? ` (${why})` : ""}. Check the client: if it's there, let it finish there; remove it here to search again`,
      );
    let job: ClientJob | null;
    if (row.protocol !== "torrent") {
      // An NZB: looked up by its release name (one exact match in AnimeArr's category); a client down or any doubt
      // (several or near matches) needs a look rather than a guess, and it is never sent twice.
      if (!deps.clients.findNzb) {
        needsLook();
        continue;
      }
      try {
        job = await deps.clients.findNzb(row.release, row.at);
      } catch (e) {
        needsLook((e as Error).message);
        continue;
      }
    } else if (row.client_ref === SENT_UNKNOWN || !deps.clients.findTorrent) {
      needsLook();
      continue;
    } else
      try {
        job = await deps.clients.findTorrent(row.client_ref);
        cantTellSince.delete(row.id);
      } catch (e) {
        const msg = (e as Error).message;
        const since = cantTellSince.get(row.id) ?? now;
        cantTellSince.set(row.id, since);
        if (e instanceof CantLookUp || now - since >= CUTOFF_GIVE_UP_MS) {
          cantTellSince.delete(row.id);
          needsLook(e instanceof CantLookUp ? msg : `${msg}; still no answer after ${CUTOFF_GIVE_UP_MS / 60_000} min`);
          continue;
        }
        db.prepare("UPDATE grabs SET error = ? WHERE id = ? AND state = 'sending'").run(
          `AnimeArr restarted while sending this; the download client couldn't be asked whether it arrived (${msg}). Asking again shortly`,
          row.id,
        );
        continue;
      }
    if (!job) {
      await retry("AnimeArr restarted while sending it, and no download client has it; trying the next candidate");
      continue;
    }
    if (
      db
        .prepare(
          "UPDATE grabs SET state = 'downloading', error = NULL, updated_at = ?, progress_at = ?, client = ?, client_ref = ? WHERE id = ? AND state = 'sending'",
        )
        .run(Date.now(), Date.now(), job.client, job.ref, row.id).changes
    )
      logDecision("grab", {
        tvdbId: row.tvdb_id,
        title,
        release: row.release,
        why: `${row.release} reached ${clientName(job.client)} before AnimeArr restarted; following it from here`,
        detail: { grabId: row.id },
      });
  }
}

/** Health checks that count as separate strikes are at least this far apart (the tick itself runs every 30 s). */
export const STRIKE_GAP_MS = 10 * 60_000;

/** Adds a strike (at most one per STRIKE_GAP_MS) and returns the strikes so far. */
export function addStrike(row: GrabRow, why: string, now: number, limit: number): number {
  const cur = (db.prepare("SELECT strikes, strike_at FROM grabs WHERE id = ?").get(row.id) as
    { strikes: number; strike_at: number | null } | undefined) ?? { strikes: 0, strike_at: null };
  if (cur.strike_at && now - cur.strike_at < STRIKE_GAP_MS) return cur.strikes;
  const n = cur.strikes + 1;
  db.prepare("UPDATE grabs SET strikes = ?, strike_at = ?, strike_why = ? WHERE id = ?").run(n, now, why, row.id);
  if (n < limit)
    logDecision("info", {
      tvdbId: row.tvdb_id,
      title: rowTitle(row),
      episodeIds: JSON.parse(row.episode_ids),
      release: row.release,
      why: `Strike ${n} of ${limit} for ${row.release}: ${why}. It is removed if it doesn't recover.`,
      detail: { grabId: row.id, strikes: n },
    });
  return n;
}
const resetStrikes = (id: number) => db.prepare("UPDATE grabs SET strikes = 0, strike_at = NULL, strike_why = NULL WHERE id = ?").run(id);

/** Episodes a grab's earlier import passes already placed in the library (from its "import" activity entries). */
function placedByGrab(grabId: number): Set<number> {
  const rows = db
    .prepare("SELECT episode_ids FROM decisions WHERE kind = 'import' AND undone_at IS NULL AND json_extract(detail, '$.grabId') = ?")
    .all(grabId) as { episode_ids: string }[];
  return new Set(rows.flatMap((r) => JSON.parse(r.episode_ids) as number[]));
}

/** Grabs whose torrent file list was already checked and found fine. */
const scanned = new Set<number>();
/** Malware blocker, while downloading: the file list of a torrent (once it has metadata), for clients that expose it. */
async function scanWhileDownloading(row: GrabRow, job: ClientJob, deps: PipelineDeps): Promise<string | null> {
  const s = getSettings().malware;
  if (!s.enabled || scanned.has(row.id) || !deps.clients.listFiles || !deps.clients.canSelectFiles?.(job)) return null;
  const files = await deps.clients.listFiles(job).catch(() => null);
  if (!files?.length) return null; // no metadata yet: looked at again next round
  const bad = inspectFiles(files, { extensions: s.extensions, runtimeMin: runtimeOf(row) });
  if (!bad) scanned.add(row.id);
  return bad;
}

/**
 * A download that holds something dangerous or fake: removed from its client (with its data), the release blocklisted
 * with the plain reason, the next release searched; nothing from it is ever imported.
 */
export async function rejectUnsafe(row: GrabRow, reason: string, deps: PipelineDeps, when: string) {
  await rejectUnsafeDownload(row, reason, deps, when);
  if (row.movie_id) await movieNextForRow(row, deps, reason);
  else await tryNext(row.id, rowRequest(row), deps, reason);
}

let ticking = false;
/** One pass over in-flight grabs: checks the download clients, then imports and verifies finished downloads. */
export async function pipelineTick(deps: PipelineDeps = realDeps, now = Date.now()) {
  if (dbState.corrupt || ticking) return;
  ticking = true;
  try {
    await resolveCutOffSends(deps, now).catch((e) =>
      logDecision("fail", { why: `Couldn't check the downloads a restart cut off: ${(e as Error).message}; trying again next round` }),
    );
    const rows = db.prepare("SELECT * FROM grabs WHERE state = 'downloading' ORDER BY id").all() as unknown as GrabRow[];
    const ready: { row: GrabRow; path: string }[] = [];
    for (const row of rows) {
      try {
        if (row.batch && (await pendingSelection(row, deps).catch((e) => reportBatchStep(row, e))) === "attention") continue;
        const job = { client: row.client as ClientJob["client"], ref: row.client_ref! };
        const st = await deps.clients.status(job);
        const qh = getSettings().queueHealth;
        const stallMs = qh.stallHours * 3_600_000;
        const noMetadata = /metaDL/i.test(st.clientStatus ?? "");
        // Malware blocker while it downloads (only clients that can list a torrent's files; Usenet is checked before import).
        if (st.state !== "missing" && st.state !== "completed") {
          const bad = await scanWhileDownloading(row, job, deps);
          if (bad) {
            await rejectUnsafe(row, bad, deps, "while it was downloading");
            continue;
          }
        }
        // Waiting in the client's queue behind other downloads, paused, or post-processing isn't stalling: restart the
        // clock. After 3 days of that the Queue page says so (nothing is removed).
        if (st.state === "queued" && !noMetadata) {
          const long =
            now - row.at > 3 * 86_400_000
              ? `still waiting in the download client after ${Math.floor((now - row.at) / 86_400_000)} days (${st.clientStatus ?? "queued"})`
              : null;
          db.prepare(
            "UPDATE grabs SET progress_at = ?, progress = MAX(COALESCE(progress, 0), ?), error = ?, strikes = 0, strike_at = NULL, strike_why = NULL WHERE id = ?",
          ).run(now, st.progress, long, row.id);
          continue;
        }
        if (st.state === "error") {
          // Often transient (disk full, permissions): don't blocklist or delete; the user decides on the Queue page.
          setState(
            row.id,
            "needs-attention",
            `${st.message ?? "the download client reports an error"}; check the client, then retry or remove it`,
          );
          continue;
        }
        // Time spent in metaDL (the queued branch keeps progress_at fresh until the torrent starts fetching metadata).
        const metadataStuck = noMetadata && now - (row.progress_at ?? row.at) > qh.metadataMin * 60_000;
        const stalled =
          st.state === "downloading" &&
          !noMetadata &&
          now - (row.progress_at ?? row.updated_at) > stallMs &&
          (row.progress ?? -1) >= st.progress;
        const unhealthy = stalled || metadataStuck;
        // A download that recovered loses its strikes.
        if (!unhealthy && st.state !== "failed" && row.strikes) resetStrikes(row.id);
        if (st.state === "failed" || unhealthy) {
          let why = metadataStuck
            ? `the torrent found no peers to get its metadata from in ${qh.metadataMin} min`
            : stalled
              ? `no download progress for ${qh.stallHours} hours${st.seeders === 0 ? " (no seeders)" : ""}`
              : `download failed${st.message ? `: ${st.message}` : ""}`;
          // Stalled and metadata-less downloads get strikes on consecutive health checks; a failure the client itself reports is final.
          if (unhealthy && qh.strikes > 1) {
            const n = addStrike(row, why, now, qh.strikes);
            if (n < qh.strikes) continue;
            why = `${why} (strike ${n} of ${qh.strikes})`;
          }
          setState(row.id, "failed", why);
          blocklist(row, why);
          let removed = "";
          if (qh.removeFailed) {
            try {
              await deps.clients.remove(job);
              removed = `; removed it from ${clientName(job.client) || job.client}`;
            } catch (e) {
              removed = `; couldn't remove it from the download client (${(e as Error).message})`;
            }
          }
          logDecision("fail", {
            tvdbId: row.tvdb_id,
            title: rowTitle(row),
            episodeIds: JSON.parse(row.episode_ids),
            release: row.release,
            why: `${why}; blocklisted ${row.release}${removed}`,
            detail: { grabId: row.id },
            undo: { action: "unblock", args: { release: row.release } },
          });
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
            if (
              !db
                .prepare("UPDATE grabs SET state = 'importing', updated_at = ? WHERE id = ? AND state = 'downloading'")
                .run(Date.now(), row.id).changes
            )
              continue;
            try {
              if (row.movie_id) await importMovie(row, p, deps);
              else await importAndVerify(row, p, deps);
              rescanAfterImport(row);
            } catch (e) {
              setState(row.id, "needs-attention", `import error: ${(e as Error).message}`);
              logDecision("fail", {
                tvdbId: row.tvdb_id,
                title: rowTitle(row),
                episodeIds: JSON.parse(row.episode_ids),
                release: row.release,
                why: `Import of ${row.release} hit an error: ${(e as Error).message}. The download is kept; press "Retry import" when the cause is fixed.`,
                detail: { grabId: row.id },
              });
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
  const rows = db
    .prepare("SELECT id, state, progress FROM grabs WHERE state IN ('sending', 'downloading', 'importing', 'needs-attention') ORDER BY id")
    .all() as { id: number; state: string; progress: number | null }[];
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

/**
 * Fix buttons. "Keep anyway": import a download whose language check failed (the user decides), if nothing else is
 * already downloading for it. "Try next release": the grab's next candidate.
 */
export function keepGrab(id: number) {
  const row = db.prepare("SELECT * FROM grabs WHERE id = ?").get(id) as GrabRow | undefined;
  if (!row || !["failed", "needs-attention"].includes(row.state) || !row.client_ref)
    throw Object.assign(new Error("Only a finished download that failed its check can be kept"), { statusCode: 409 });
  const eps = JSON.parse(row.episode_ids) as number[];
  const others = db
    .prepare(`SELECT id, episode_ids, movie_id FROM grabs WHERE id != ? AND dry_run = 0 AND state IN (${ACTIVE.map(() => "?").join(",")})`)
    .all(id, ...ACTIVE) as { id: number; episode_ids: string; movie_id: number | null }[];
  const clash = others.find((o) =>
    row.movie_id ? o.movie_id === row.movie_id : (JSON.parse(o.episode_ids) as number[]).some((e) => eps.includes(e)),
  );
  if (clash)
    throw Object.assign(new Error(`Another download for it is already running (grab ${clash.id}); remove that one first`), {
      statusCode: 409,
    });
  const newer = supersededBy(id);
  if (newer)
    throw Object.assign(new Error(`A newer download (grab ${newer}) already replaced this one; keeping the old one would overwrite it`), {
      statusCode: 409,
    });
  if (/already imported/i.test(row.error ?? ""))
    throw Object.assign(new Error("This one is already imported; it stays until a better release is found"), { statusCode: 409 });
  if (
    !db
      .prepare(
        "UPDATE grabs SET keep = 1, state = 'downloading', error = NULL, updated_at = ?, progress_at = ? WHERE id = ? AND state IN ('failed', 'needs-attention')",
      )
      .run(Date.now(), Date.now(), id).changes
  )
    throw Object.assign(new Error("This download changed meanwhile; refresh and try again"), { statusCode: 409 });
  db.prepare("DELETE FROM blocklist WHERE release = ?").run(row.release);
  logDecision("info", {
    tvdbId: row.tvdb_id,
    episodeIds: eps,
    release: row.release,
    why: `You kept ${row.release}: it will be imported despite the language check`,
    detail: { grabId: id, movieId: row.movie_id },
  });
}

export async function nextForGrab(id: number, deps: PipelineDeps = realDeps) {
  const row = db.prepare("SELECT * FROM grabs WHERE id = ?").get(id) as GrabRow | undefined;
  if (!row || !["failed", "needs-attention"].includes(row.state))
    throw Object.assign(new Error("Only a failed download or one that needs attention can move on to the next release"), {
      statusCode: 409,
    });
  const newer = supersededBy(id);
  if (newer) throw Object.assign(new Error(`A newer download (grab ${newer}) is already handling it`), { statusCode: 409 });
  if (row.state === "needs-attention") setState(id, "failed", "you moved on to the next release");
  if (!db.prepare("SELECT 1 FROM blocklist WHERE release = ? LIMIT 1").get(row.release)) blocklist(row, "you moved on to the next release");
  if (row.movie_id) return movieNextForRow(row, deps, "you moved on to the next release");
  return tryNext(id, rowRequest(row), deps, "you moved on to the next release");
}

function rowRequest(row: GrabRow): GrabRequest {
  const fallbacks = JSON.parse(row.candidates) as Candidate[];
  // A Replace season the season decision chose (not the user): the next candidate is decided afresh.
  const auto = readBatch(row.batch)?.autoReplace;
  const episodeIds = JSON.parse(row.episode_ids) as number[];
  // ...but a whole-season replace still only moves on to another season pack.
  const packsOnly = row.purpose === "replace" && episodeIds.length > 1;
  return {
    tvdbId: row.tvdb_id,
    episodeIds,
    candidate: fallbacks[0],
    fallbacks,
    origin: row.origin,
    attempt: row.attempt ?? 1,
    purpose: auto ? null : (row.purpose ?? null),
    ...(packsOnly ? { packsOnly } : {}),
  };
}

/**
 * Pipeline tick, batch torrents: one still waiting for its file list (a magnet fetching metadata) gets its selection;
 * one added stopped whose start failed is started again (review 2026-11-02, M6). "attention" = it kept failing to
 * start and now needs a look.
 */
export async function pendingSelection(row: GrabRow, deps: PipelineDeps): Promise<"attention" | undefined> {
  const b = readBatch(row.batch);
  if (!b || !row.client || !row.client_ref) return;
  const ids = JSON.parse(row.episode_ids) as number[];
  const log = row.movie_id
    ? { tvdbId: null, release: row.release, episodeIds: [], movieId: row.movie_id }
    : { tvdbId: row.tvdb_id, title: rowTitle(row), release: row.release, episodeIds: ids };
  if (b.startFailed) {
    const r = await retryStart({ grabId: row.id, job: { client: row.client, ref: row.client_ref }, clients: deps.clients, log });
    if (r !== "attention") return;
    const why = readBatch((db.prepare("SELECT batch FROM grabs WHERE id = ?").get(row.id) as { batch: string | null }).batch)?.startFailed
      ?.why;
    setState(
      row.id,
      "needs-attention",
      `it was added stopped to choose its files, and the download client couldn't be told to start it for an hour (${why ?? b.startFailed.why}); start it in the client, or remove it here`,
    );
    return "attention";
  }
  if (b.mode !== "pending") return;
  const job: ClientJob = { client: row.client, ref: row.client_ref, select: true, paused: !!b.paused };
  await applySelection({
    grabId: row.id,
    job,
    clients: deps.clients,
    opts: row.movie_id ? movieFileOpts(row.movie_id) : episodeFileOpts(row.tvdb_id, ids),
    log,
  });
}

/** A batch step that threw (not a client answer, which applySelection handles): reported once per grab and error. */
const batchStepErrors = new Map<number, string>();
function reportBatchStep(row: GrabRow, e: unknown) {
  const msg = (e as Error).message;
  if (batchStepErrors.get(row.id) === msg) return; // the same error as last tick: already in the activity log
  batchStepErrors.set(row.id, msg);
  logDecision("fail", {
    tvdbId: row.tvdb_id,
    release: row.release,
    why: `Couldn't handle the file choice of ${row.release}: ${msg}; trying again every round`,
    detail: { grabId: row.id },
  });
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
    logDecision("verify-fail", {
      tvdbId: row.tvdb_id,
      title: series?.title,
      episodeIds: wanted,
      release: row.release,
      why: `${row.release} failed verification: ${why}${imported ? " (already imported; it will be replaced if a better release is found)" : ""}. Blocklisted it${cleans ? "; its download is cleaned up in about an hour unless you choose Keep anyway" : ""}; looking for the next release.`,
      detail: { grabId: row.id },
      undo: { action: "unblock", args: { release: row.release } },
    });
    await tryNext(row.id, rowRequest(row), deps, why);
  };
  /** Problems that aren't the release's fault: no blocklist, no next candidate; the user can retry the import. */
  const attention = (why: string) => {
    setState(row.id, "needs-attention", why);
    logDecision("fail", {
      tvdbId: row.tvdb_id,
      title: series?.title,
      episodeIds: wanted,
      release: row.release,
      why: `Downloaded ${row.release} but couldn't import it: ${why}. The download is kept; fix the cause and press "Retry import".`,
      detail: { grabId: row.id },
    });
  };
  if (!series || !underAllowedRoot(series.path)) return attention("the series is outside the allowed root folders");
  const sonarrPath0 = clientToSonarr(clientPath);
  const singleArchive = /\.(rar|zip|7z)$/i.test(sonarrPath0);
  // A single-file torrent that is an archive: its folder is the shared category folder.
  const sonarrPath = singleArchive ? path.posix.dirname(sonarrPath0) : sonarrPath0;
  const single = VIDEO.test(sonarrPath);
  const folder = single ? path.posix.dirname(sonarrPath) : sonarrPath;
  // Malware blocker: nothing from a download with dangerous or fake files is unpacked or imported.
  const unsafe = unsafeDownload(deps, row, single || singleArchive ? sonarrPath0 : folder, !(single || singleArchive));
  if (unsafe) return rejectUnsafe(row, unsafe, deps, "before import");
  // Torrents that arrive as archives: unpack (in the background) into the grab's own subfolder first; Sonarr then
  // MOVES the unpacked files, so the archives keep seeding and nothing is left behind. SABnzbd unpacks by itself.
  let unpackRel: string | null = null;
  if (!single && isTorrentClient(row.client) && getSettings().extraction.enabled && deps.extract) {
    const local = deps.localPath(folder);
    if (!local) return attention(`can't reach ${folder} from AnimeArr to unpack it (check Settings → Paths)`);
    const x = await deps.extract(local, String(row.id), singleArchive ? [path.posix.basename(sonarrPath0)] : undefined);
    if (x.kind === "pending") {
      // Hand the row back to the tick; it polls again next round.
      db.prepare(
        "UPDATE grabs SET state = 'downloading', error = 'unpacking…', updated_at = ?, progress_at = ? WHERE id = ? AND state = 'importing'",
      ).run(Date.now(), Date.now(), row.id);
      return;
    }
    if (x.kind === "unavailable") return attention(x.why);
    if (x.kind === "broken")
      return getSettings().malware.enabled && /password-protected/.test(x.why)
        ? rejectUnsafe(row, `contained a password-protected archive instead of a video (${x.why})`, deps, "before import")
        : fail(x.why, false);
    if (x.kind === "extracted") {
      unpacked = x.dest;
      unpackRel = `${folder}/${UNPACK_DIR}/${row.id}/`;
      logDecision("info", {
        tvdbId: row.tvdb_id,
        title: series.title,
        episodeIds: wanted,
        release: row.release,
        why: `Unpacked ${row.release}: ${x.files.length} video file${x.files.length === 1 ? "" : "s"}`,
        detail: { grabId: row.id },
      });
    }
  } else if (singleArchive)
    return attention(
      `${path.posix.basename(sonarrPath0)} is an archive; turn on unpacking in Settings → Automation & safety, or unpack it by hand`,
    );
  // Folder only: given a seriesId, Sonarr's preview ignores the folder and lists the series' library files instead.
  // A native show (added in AnimeArr) has no Sonarr: the folder is listed here.
  const native = isNativeSeriesId(series.id);
  let listed: { path: string; size?: number; quality?: unknown; languages?: unknown; releaseGroup?: string; indexerFlags?: number }[];
  if (native) {
    const localFolder = deps.localPath(folder);
    if (!localFolder) return attention(`can't reach ${folder} from AnimeArr (check Settings → Paths)`);
    listed = listVideos(localFolder).map((f) => ({
      path: `${folder}/${path.relative(localFolder, f.path).split(path.sep).join("/")}`,
      size: f.size,
    }));
  } else listed = await deps.sonarr.preview(folder);
  const items = listed.filter((x) => VIDEO.test(x.path) && !/\bsample\b/i.test(x.path) && (x.size ?? 1e9) > 30e6) as Awaited<
    ReturnType<PipelineDeps["sonarr"]["preview"]>
  >;
  // A single-file torrent's folder is the shared category folder: only that one file belongs to this grab.
  // Unpacked: only the unpacked files (they are moved; the torrent's own files must keep seeding).
  const inThis = items.filter((x) =>
    unpackRel
      ? x.path.startsWith(unpackRel)
      : single
        ? x.path === sonarrPath
        : x.path.startsWith(`${folder}/`) && !x.path.startsWith(`${folder}/${UNPACK_DIR}/`),
  );
  if (!inThis.length) return attention(`no video files found in ${single ? sonarrPath : folder}`);

  // Map each file to episodes: single file + single episode is direct; otherwise identify each file name confidently.
  const ctx = identifyContext();
  const minConf = getSettings().managed.minConfidence;
  const plan: { item: (typeof inThis)[number]; episodeIds: number[] }[] = [];
  if (inThis.length === 1 && wanted.length === 1) plan.push({ item: inThis[0], episodeIds: wanted });
  else
    for (const it of inThis) {
      const id = identify(path.posix.basename(it.path), ctx, { tvdbId: row.tvdb_id, expect: wanted });
      if (!id.resolution?.ok || id.resolution.confidence < minConf) continue;
      // Files in the download's extras folder ("NCED & NCOP", "Extras", …) are never regular episodes.
      if (inExtrasFolder(it.path.slice(folder.length + 1)) && id.resolution.episodes.some((e) => e.season > 0)) continue;
      const ids = id.resolution.episodes.map((e) => e.id).filter((x) => wanted.includes(x));
      if (ids.length) plan.push({ item: it, episodeIds: ids });
    }
  const mapped = plan.flatMap((p) => p.episodeIds);
  if (!plan.length) return attention("couldn't tell which file is which episode");
  const dup = mapped.find((e, i) => mapped.indexOf(e) !== i);
  if (dup !== undefined) {
    // Say which episode, and whether a creditless opening/ending is one of them; the fix opens the whole download.
    const n = episodesFor(row.tvdb_id).find((e) => e.id === dup)?.episode;
    const cl = plan
      .filter((p) => p.episodeIds.includes(dup))
      .map((p) => parseRelease(path.posix.basename(p.item.path)).creditless)
      .find(Boolean);
    return attention(
      `two files in this download look like ${n !== undefined ? `episode ${n}` : "the same episode"}${cl ? ` (one is a creditless ${cl.kind === "op" ? "opening" : "ending"})` : ""}; review the files to import`,
    );
  }
  const replacing = row.purpose === "replace";
  const seasonNo = episodesFor(row.tvdb_id).find((e) => wanted.includes(e.id))?.season ?? null;
  const replaceLabel = seasonNo === null ? "Replace season" : seasonNo === 0 ? "Specials replace" : `Season ${seasonNo} replace`;
  // A whole-season replace whose download turned out to be one episode: stop before anything is touched.
  if (
    replacing &&
    wanted.length > 1 &&
    ((inThis.length === 1 && new Set(mapped).size === 1) || !isSeasonPack({ title: row.release, episodeIds: wanted }))
  ) {
    const one = episodesFor(row.tvdb_id).find((e) => e.id === mapped[0]);
    const n = one?.episode ?? parseRelease(row.release).absolute[0] ?? parseRelease(row.release).episodes[0];
    return attention(
      `${replaceLabel} stopped: the download was only ${n ? `episode ${n}` : "one episode"}, not the whole season. Nothing in your library changed.`,
    );
  }
  /** Replace season: episodes that keep their old file (new one failed its check, or isn't in the pack). */
  const kept: { id: number; why: string }[] = replacing
    ? wanted.filter((e) => !mapped.includes(e)).map((id) => ({ id, why: "not in the pack" }))
    : [];

  const prof = profileFor(row.tvdb_id);
  // A dual-audio upgrade replaces a placeholder: only a file with the original audio AND the dub counts.
  const strictUpgrade = (v: ReturnType<typeof judge>): ReturnType<typeof judge> => {
    if (row.purpose !== "dual-upgrade" || !v.ok) return v;
    const original = prof.originalLangs ?? ["ja"];
    const dub = (prof.dubLangs ?? []).filter((l) => !original.includes(l));
    const base = v.audio.map((a) => a.split("-")[0]);
    const hasDub = dub.find((l) => base.includes(l));
    const hasOriginal = !original.length || base.some((a) => original.includes(a));
    return hasDub && hasOriginal
      ? v
      : {
          ...v,
          ok: false,
          why: `no ${hasDub ? "original" : dub.join("/")} audio (audio: ${v.audio.join("/") || "unknown"}): not the dual-audio release it claimed to be`,
        };
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
      logDecision("info", {
        tvdbId: row.tvdb_id,
        title: series.title,
        episodeIds: p.episodeIds,
        release: row.release,
        why: `Replace season: ${path.posix.basename(p.item.path)} failed its check (${v.why}); the old file stays for ${p.episodeIds.length > 1 ? "these episodes" : "this episode"}`,
        detail: { grabId: row.id },
      });
      continue;
    }
    if (!v.ok && !row.keep) return fail(`${path.posix.basename(p.item.path)}: ${v.why}`, false);
    if (!v.ok)
      logDecision("info", {
        tvdbId: row.tvdb_id,
        title: series.title,
        episodeIds: p.episodeIds,
        release: row.release,
        why: `Kept ${path.posix.basename(p.item.path)} as you asked, although: ${v.why}`,
        detail: { grabId: row.id },
      });
    preVerified.add(p.item.path);
    verdicts.push(v.why);
    if (v.ok)
      logDecision("verify-ok", {
        tvdbId: row.tvdb_id,
        title: series.title,
        episodeIds: p.episodeIds,
        release: row.release,
        why: `Checked ${path.posix.basename(p.item.path)} before import: ${v.why}`,
        detail: { grabId: row.id, probe },
      });
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
    // Retry import of a replace that stopped part-way: episodes this grab already placed are not copied again.
    const placed = replacing ? placedByGrab(row.id) : new Set<number>();
    const done = plan.filter((p) => p.episodeIds.every((e) => placed.has(e)));
    const toPlace = plan.filter((p) => !p.episodeIds.some((e) => keptIds.has(e)) && !done.includes(p));
    if (!toPlace.every((p) => preVerified.has(p.item.path)))
      return attention("AnimeArr couldn't check every file before importing (check Settings → Paths)");
    if (replacing && !toPlace.length && !done.length)
      return fail(`none of the pack's files passed the check (${[...new Set(kept.map((k) => k.why))].join("; ")})`, false);
    if (replacing && !getSettings().media.recycleBin.trim())
      return attention("Replace season needs AnimeArr's recycling bin (Settings → Media management), so the old files can come back");
    let swapped = 0;
    for (const p of toPlace) {
      try {
        const ip = await planImport({
          tvdbId: row.tvdb_id,
          path: p.item.path,
          episodeIds: p.episodeIds,
          release: row.release,
          client: unpacked ? null : row.client,
          automatic: true,
          trusted: clientToSonarr(clientPath),
        });
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
        if (replacing)
          db.prepare("UPDATE grabs SET progress_at = ?, error = ? WHERE id = ?").run(
            Date.now(),
            `swapped ${swapped}/${toPlace.length}`,
            row.id,
          );
      } catch (e) {
        if (replacing) {
          for (const id of p.episodeIds) kept.push({ id, why: (e as Error).message });
          continue;
        }
        return attention(`AnimeArr's importer: ${(e as Error).message}`);
      }
    }
    if (replacing && !swapped && !done.length)
      return attention(
        `${replaceLabel} stopped: no episode could be swapped (${[...new Set(kept.map((k) => k.why))].join("; ")}). Nothing in your library changed.`,
      );
    if (replacing) {
      db.prepare("UPDATE grabs SET error = NULL WHERE id = ?").run(row.id);
      if (kept.length) {
        const label = (id: number) => {
          const e = eps.find((x) => x.id === id);
          return e ? `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}` : String(id);
        };
        logDecision("fail", {
          tvdbId: row.tvdb_id,
          title: series.title,
          episodeIds: kept.map((k) => k.id),
          release: row.release,
          why: `Replace season: kept the old file for ${kept.map((k) => `${label(k.id)} (${k.why})`).join(", ")}; needs a look`,
          detail: { grabId: row.id },
        });
      }
      const keptNow = new Set(kept.map((k) => k.id));
      // Episodes that kept their old file may still need this download: it stays, and the grab waits in "needs
      // attention" so Retry import can finish them once the cause is fixed.
      await finishImport(
        row,
        series,
        mapped.filter((e) => !keptNow.has(e)),
        eps,
        verdicts,
        unpacked,
        deps,
        kept.length === 0,
      );
      if (kept.length)
        setState(
          row.id,
          "needs-attention",
          `${replaceLabel}: ${kept.length} episode${kept.length === 1 ? "" : "s"} kept their old file (${[...new Set(kept.map((k) => k.why))].join("; ")}). The others were replaced. Fix the cause, then press Retry import`,
        );
      return;
    }
    return finishImport(row, series, mapped, eps, verdicts, unpacked, deps);
  }
  if (replacing) return attention("Replace season needs AnimeArr's own importer (Settings → Media management → Importer)");
  const cmd = await deps.sonarr.importFiles(files, unpacked ? "move" : importModeFor(row.client));
  logDecision("import", {
    tvdbId: row.tvdb_id,
    title: series.title,
    episodeIds: mapped,
    release: row.release,
    why: `Asked Sonarr to import ${files.length} file${files.length === 1 ? "" : "s"} as ${files.map((f) => f.episodeIds.join("+")).join(", ")} (explicit episode IDs, command ${cmd.id})`,
    detail: { grabId: row.id, commandId: cmd.id },
  });
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
      if (!ef || !fresh)
        return attention(
          `Sonarr finished the import but S${ep.seasonNumber}E${ep.episodeNumber} doesn't have the new file (it may have rejected it; check Sonarr's activity)`,
        );
      if (preVerified.has(p.item.path) || eid !== p.episodeIds[0]) continue;
      const subs = langList(ef.mediaInfo?.subtitles);
      const audio = langList(ef.mediaInfo?.audioLanguages);
      // No track info yet (media analysis off or not finished): can't judge, so don't blame the release.
      if (!subs.length && !audio.length)
        return attention(
          `Sonarr has no track information for ${path.posix.basename(ef.path)} yet, so the language couldn't be checked; check the file, then retry`,
        );
      const v = strictUpgrade(
        judge({ subs, audio, durationSec: runTimeSec(ef.mediaInfo?.runTime), sidecars: [], untagged: 0 }, prof, expectedMin, burned),
      );
      learnFromVerify(parsed.group, learnKey, v.subs, v.audio);
      if (!v.ok && !row.keep) return fail(`${path.posix.basename(ef.path)}: ${v.why}`, true);
      verdicts.push(v.why);
      logDecision("verify-ok", {
        tvdbId: row.tvdb_id,
        title: series.title,
        episodeIds: p.episodeIds,
        release: row.release,
        why: `Imported and checked ${path.posix.basename(ef.path)}: ${v.why}`,
        detail: { grabId: row.id },
      });
    }
  }
  return finishImport(row, series, mapped, eps, verdicts, unpacked, deps);
}

async function finishImport(
  row: GrabRow,
  series: NonNullable<ReturnType<typeof seriesByTvdb>>,
  mapped: number[],
  eps: ReturnType<typeof episodesFor>,
  verdicts: string[],
  unpacked: string | null,
  deps: PipelineDeps,
  cleanup = true,
) {
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
  const labels = eps
    .filter((e) => mapped.includes(e.id))
    .map((e) => `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}`);
  logDecision("import", {
    tvdbId: row.tvdb_id,
    title: series.title,
    episodeIds: mapped,
    release: row.release,
    why: `Imported ✓ as ${labels.join(", ")}: ${[...new Set(verdicts)].join("; ") || "checked"}`,
    detail: { grabId: row.id, final: true },
  });
  try {
    await deps.refreshSeries?.(series.id);
  } catch {
    /* the next sync catches up */
  }
  // Confirmed import (files placed, the show refreshed): the download can go (or once seeding is done).
  if (cleanup) await deps.cleanup?.(row.id, "imported");
}

export function listGrabs(limit = 50, opts: { episodesOnly?: boolean } = {}) {
  return (
    db
      .prepare(`SELECT * FROM grabs${opts.episodesOnly ? " WHERE movie_id IS NULL" : ""} ORDER BY id DESC LIMIT ?`)
      .all(limit) as unknown as GrabRow[]
  ).map((g) => ({
    ...g,
    episode_ids: JSON.parse(g.episode_ids) as number[],
    candidates: undefined,
    fallbacks: (JSON.parse(g.candidates) as unknown[]).length,
  }));
}

/**
 * Queue action: removes one of AnimeArr's own downloads from its client (deleting the downloaded data, never library
 * files). Optionally blocklists the release and tries the next candidate. User-confirmed in the UI.
 */
export async function removeGrab(id: number, opts: { blocklist: boolean; searchNext: boolean }, deps: PipelineDeps = realDeps) {
  if (dbState.corrupt)
    throw Object.assign(new Error("The database failed its integrity check; restore a backup first"), { statusCode: 503 });
  const row = db.prepare("SELECT * FROM grabs WHERE id = ?").get(id) as GrabRow | undefined;
  if (!row) throw Object.assign(new Error("Unknown download"), { statusCode: 404 });
  // Claim it atomically, so the pipeline can't start importing it meanwhile. A 'sending' row this process is sending
  // right now is taken back out of the client by the send itself once the client accepts it (it finds the row closed).
  if (
    !db
      .prepare(
        "UPDATE grabs SET state = 'removing', updated_at = ? WHERE id = ? AND state IN ('sending', 'downloading', 'needs-attention')",
      )
      .run(Date.now(), id).changes
  )
    throw Object.assign(new Error(`This download is ${row.state}; only sending, downloading or needs-attention ones can be removed`), {
      statusCode: 409,
    });
  // A row that may have been mid-import keeps its files (Sonarr could be moving them right now).
  const mayBeImporting =
    row.state === "needs-attention" && /^((Sonarr|Radarr) import|AnimeArr restarted during the import|import error)/.test(row.error ?? "");
  let job = row.client && row.client_ref ? { client: row.client as ClientJob["client"], ref: row.client_ref } : null;
  // Cut off mid-send by a restart: a torrent is looked up by its info-hash (an NZB has no id to look up by).
  const cutOffTorrent =
    row.state === "sending" && !sendingNow.has(id) && row.protocol === "torrent" && !!row.client_ref && row.client_ref !== SENT_UNKNOWN;
  // A cut-off send whose client can't be checked (down, a watch folder) or won't remove it is still closed here, with a
  // note to check the client: AnimeArr may never have got it there, and refusing would leave it stuck for good (H1).
  let unchecked: string | null = null;
  if (cutOffTorrent && deps.clients.findTorrent) {
    try {
      job = await deps.clients.findTorrent(row.client_ref!);
    } catch (e) {
      unchecked = `couldn't check the download client: ${(e as Error).message}`;
    }
  }
  if (job && !mayBeImporting) {
    try {
      await deps.clients.remove(job);
    } catch (e) {
      if (cutOffTorrent) unchecked = `couldn't remove it from the download client: ${(e as Error).message}`;
      else {
        // The download is still there (client unreachable, or it isn't AnimeArr's): put the row back and say so.
        db.prepare("UPDATE grabs SET state = ?, updated_at = ? WHERE id = ? AND state = 'removing'").run(row.state, Date.now(), id);
        throw Object.assign(new Error(`Couldn't remove it from the download client: ${(e as Error).message}`), { statusCode: 502 });
      }
    }
  }
  setState(
    row.id,
    "failed",
    mayBeImporting
      ? "closed by you (downloaded files kept: an import may have been in progress)"
      : unchecked
        ? `removed by you (${unchecked}; check the client yourself and remove it there if it arrived)`
        : row.state === "sending" && row.client_ref === SENT_UNKNOWN && !sendingNow.has(id)
          ? "removed by you (AnimeArr can't look it up in the download client: check there whether it arrived)"
          : "removed by you",
  );
  const eps = JSON.parse(row.episode_ids) as number[];
  let undo = null;
  if (opts.blocklist) {
    undo = { action: "unblock" as const, args: { id: blocklist(row, "removed from the queue by you"), release: row.release } };
  }
  logDecision("info", {
    tvdbId: row.tvdb_id,
    episodeIds: eps,
    release: row.release,
    why: `${mayBeImporting ? "Closed" : "Removed"} ${row.release}${mayBeImporting ? " without deleting its files (an import may have been in progress)" : " from the queue"}${opts.blocklist ? " and blocklisted it" : ""}${opts.searchNext ? "; trying the next candidate" : ""} (you confirmed)`,
    detail: { grabId: row.id },
    undo,
  });
  if (opts.searchNext)
    return row.movie_id ? movieNextForRow(row, deps, "removed by you") : tryNext(row.id, rowRequest(row), deps, "removed by you");
  scheduleAfter(eps, "retry", "download removed by you");
  return null;
}

/** Where a grab's download is (the client's storage path, mapped to the path AnimeArr/Sonarr use); null when unknown. */
export async function grabDownloadPath(grabId: number, clients: DownloadClients = realClients): Promise<string | null> {
  const row = db.prepare("SELECT client, client_ref FROM grabs WHERE id = ? AND dry_run = 0").get(grabId) as
    { client: string | null; client_ref: string | null } | undefined;
  if (!row?.client || !row.client_ref) return null;
  try {
    const st = await clients.status({ client: row.client as ClientJob["client"], ref: row.client_ref });
    return st.path ? clientToSonarr(st.path).replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

/**
 * A manual import that took a grab's download (opened from its fix): the grab is done, like an automatic import (its
 * download is cleaned up by the usual rule). Only a grab that is still waiting for this (needs attention / failed).
 */
export async function finishGrabByHand(grabId: number, what: string, deps: Pick<PipelineDeps, "cleanup"> = realDeps) {
  const row = db.prepare("SELECT id, state, release, tvdb_id, movie_id FROM grabs WHERE id = ?").get(grabId) as
    { id: number; state: string; release: string; tvdb_id: number | null; movie_id: number | null } | undefined;
  if (!row || !["needs-attention", "failed"].includes(row.state)) return false;
  setState(row.id, "done");
  logDecision("import", {
    tvdbId: row.tvdb_id,
    release: row.release,
    why: `Imported ✓ ${what} by hand from ${row.release}`,
    detail: { grabId: row.id, ...(row.movie_id ? { movieId: row.movie_id } : {}), final: true },
  });
  await deps.cleanup?.(row.id, "imported");
  return true;
}
