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
import path from "node:path";
import { logDecision } from "./activity.js";
import { fetchReleaseFile as realFetchRelease, type ProwlarrRelease } from "./arr/prowlarr.js";
import { realClients, type ClientJob, type DownloadClients } from "./arr/clients.js";
import * as sonarr from "./arr/sonarr.js";
import { identify } from "./core/identify.js";
import { langList } from "./core/langs.js";
import { parseRelease } from "./core/parser.js";
import { db, dbState } from "./db.js";
import { burnedInFact } from "./audit.js";
import { learnFromVerify, refreshSeriesEpisodes, sourceKey } from "./library.js";
import { clientToSonarr, localPath as realLocalPath } from "./paths.js";
import { episodesFor, identifyContext, seriesByTvdb, type SearchResult } from "./search.js";
import { getSettings, isDryRun, underAllowedRoot } from "./settings.js";
import { ffprobe, judge, type ProbeResult } from "./verify.js";

export interface PipelineDeps {
  clients: DownloadClients;
  fetchRelease(r: ProwlarrRelease): Promise<{ data?: Buffer; magnet?: string; filename: string }>;
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
}

export const realDeps: PipelineDeps = {
  clients: realClients,
  fetchRelease: realFetchRelease,
  sonarr: { preview: sonarr.manualImportPreview, importFiles: sonarr.manualImport, command: sonarr.getCommand, episode: sonarr.getEpisode, episodeFile: sonarr.getEpisodeFile },
  probe: (f) => ffprobe(f),
  localPath: realLocalPath,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  refreshSeries: (id) => refreshSeriesEpisodes(id),
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
  attempt?: number;
  progress?: number | null;
  progress_at?: number | null;
}

/** Grab states that are still in flight (a new grab for the same episode must wait for these). */
const ACTIVE = ["sending", "downloading", "importing"];
/** No download progress for this long → the download is treated as dead. */
export const STALL_MS = 6 * 3_600_000;
const MAX_ATTEMPTS = 3;

const setState = (id: number, state: string, error: string | null = null, extra: { client?: string; ref?: string } = {}) =>
  db.prepare("UPDATE grabs SET state = ?, error = ?, updated_at = ?, client = COALESCE(?, client), client_ref = COALESCE(?, client_ref) WHERE id = ?").run(state, error, Date.now(), extra.client ?? null, extra.ref ?? null, id);

function managedDryRun(tvdbId: number): boolean | null {
  const r = db.prepare("SELECT dry_run FROM managed WHERE tvdb_id = ?").get(tvdbId) as { dry_run: number } | undefined;
  return r ? !!r.dry_run : null;
}

function isBlocked(c: { guid: string; title: string }) {
  return !!db.prepare("SELECT 1 FROM blocklist WHERE release = ? OR (guid IS NOT NULL AND guid = ?) LIMIT 1").get(c.title, c.guid);
}

/** Managed-schedule bookkeeping: the episodes of a finished/failed grab go to "done" or back to "retry". */
function scheduleAfter(episodeIds: number[], outcome: "done" | "retry", why: string) {
  const now = Date.now();
  for (const e of episodeIds)
    db.prepare("UPDATE search_state SET state = ?, next_at = ?, last_why = ? WHERE episode_id = ? AND state = 'grabbed'").run(outcome, outcome === "done" ? now : now + 30 * 60_000, why, e);
}

/** Starts a grab (or records what it would do in dry-run). */
export async function startGrab(req: GrabRequest, deps: PipelineDeps = realDeps): Promise<{ id: number; dryRun: boolean; message: string; failed?: boolean }> {
  if (dbState.corrupt) throw Object.assign(new Error("The database failed its integrity check; restore a backup first"), { statusCode: 503 });
  const series = seriesByTvdb(req.tvdbId);
  if (!series) throw Object.assign(new Error("Unknown series; sync the library first"), { statusCode: 404 });
  if (!underAllowedRoot(series.path)) {
    const roots = getSettings().allowedRoots;
    throw Object.assign(new Error(`${series.title} is in ${path.posix.dirname(series.path)}, which is not an allowed root folder${roots.length ? ` (${roots.join(", ")})` : ""}. AnimeArr only grabs and imports for shows inside the root folders you allowed in Settings → Safety.`), { statusCode: 403 });
  }
  const c = req.candidate;
  const dryRun = req.origin === "manual" ? getSettings().managed.dryRun : isDryRun(managedDryRun(req.tvdbId));
  // Import only what was asked for, plus episodes of the release that have no file yet: a pack must never replace
  // files the library already has (the user's rule: never delete library files).
  const all = episodesFor(req.tvdbId);
  const importIds = c.episodeIds.filter((id) => req.episodeIds.includes(id) || all.some((e) => e.id === id && !e.hasFile));
  if (!importIds.length) throw Object.assign(new Error("This release doesn't cover the episodes asked for"), { statusCode: 400 });
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
    .prepare("INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, indexer_id, protocol, state, dry_run, origin, why, candidates, attempt, progress_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(now, now, req.tvdbId, series.id, JSON.stringify(importIds), c.title, c.guid, c.indexerId, c.protocol, dryRun ? "dry-run" : "sending", dryRun ? 1 : 0, req.origin, c.why, JSON.stringify(req.fallbacks.slice(0, 5)), req.attempt ?? 1, now);
  const id = Number(ins.lastInsertRowid);
  if (dryRun) {
    const msg = `would grab ${c.title} (${c.protocol}, ${c.indexer}) for ${series.title} ${c.label}: ${c.why}. Would import into Sonarr as ${target}.`;
    logDecision("would-grab", { tvdbId: req.tvdbId, title: series.title, episodeIds: importIds, release: c.title, why: `Dry-run: ${msg}`, detail: { grabId: id, fallbacks: req.fallbacks.length } });
    return { id, dryRun: true, message: msg };
  }
  try {
    const file = await deps.fetchRelease({ guid: c.guid, title: c.title, size: c.size, indexerId: c.indexerId, indexer: c.indexer, protocol: c.protocol, downloadUrl: c.downloadUrl, magnetUrl: c.magnetUrl });
    let job: ClientJob;
    if (c.protocol === "usenet") {
      if (!file.data) throw new Error("No NZB data");
      job = await deps.clients.addNzb(file.data, c.title);
    } else job = await deps.clients.addTorrent(file, c.title);
    setState(id, "downloading", null, { client: job.client, ref: job.ref });
    logDecision("grab", { tvdbId: req.tvdbId, title: series.title, episodeIds: importIds, release: c.title, why: `Sent ${c.title} to ${job.client === "sabnzbd" ? "SABnzbd" : "qBittorrent"} (category ${job.client === "sabnzbd" ? getSettings().sabnzbd.category : getSettings().qbittorrent.category}) for ${series.title} ${c.label}: ${c.why}`, detail: { grabId: id } });
    return { id, dryRun: false, message: `Sent to ${job.client}` };
  } catch (e) {
    setState(id, "failed", (e as Error).message);
    logDecision("fail", { tvdbId: req.tvdbId, title: series.title, episodeIds: importIds, release: c.title, why: `Couldn't send ${c.title}: ${(e as Error).message}`, detail: { grabId: id } });
    const next = await tryNext(id, { ...req, attempt: req.attempt ?? 1 }, deps, (e as Error).message);
    return next ?? { id, dryRun: false, message: (e as Error).message, failed: true };
  }
}

async function tryNext(grabId: number, req: GrabRequest, deps: PipelineDeps, reason: string): Promise<Awaited<ReturnType<typeof startGrab>> | null> {
  const attempt = (req.attempt ?? 1) + 1;
  // Skip fallbacks that got blocklisted meanwhile (e.g. the same release cross-posted on another indexer).
  const [next, ...rest] = req.fallbacks.filter((f) => !isBlocked(f));
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

function blocklist(row: GrabRow, reason: string) {
  db.prepare("INSERT INTO blocklist (guid, release, tvdb_id, reason, at) VALUES (?, ?, ?, ?, ?)").run(row.guid, row.release, row.tvdb_id, reason, Date.now());
}

const VIDEO = /\.(mkv|mp4|avi|m4v|ts|webm)$/i;

/** After a restart: grabs caught mid-import need a look; grabs caught mid-send never reached a client. */
export function recoverGrabs() {
  if (dbState.corrupt) return;
  db.prepare("UPDATE grabs SET state = 'needs-attention', error = 'AnimeArr restarted during the import; check Sonarr, then retry the import' WHERE state = 'importing'").run();
  db.prepare("UPDATE grabs SET state = 'failed', error = 'AnimeArr restarted while sending to the download client' WHERE state = 'sending' AND updated_at < ?").run(Date.now() - 10 * 60_000);
}

let ticking = false;
/** One pass over in-flight grabs: checks the download clients, then imports and verifies finished downloads. */
export async function pipelineTick(deps: PipelineDeps = realDeps, now = Date.now()) {
  if (dbState.corrupt || ticking) return;
  ticking = true;
  try {
    const rows = db.prepare("SELECT * FROM grabs WHERE state = 'downloading' ORDER BY id").all() as unknown as GrabRow[];
    for (const row of rows) {
      try {
        const st = await deps.clients.status({ client: row.client as ClientJob["client"], ref: row.client_ref! });
        const stalled = st.state !== "completed" && now - (row.progress_at ?? row.updated_at) > STALL_MS && (row.progress ?? -1) >= st.progress;
        if (st.state === "failed" || stalled) {
          const why = stalled ? `no download progress for ${STALL_MS / 3_600_000} hours` : `download failed${st.message ? `: ${st.message}` : ""}`;
          setState(row.id, "failed", why);
          blocklist(row, why);
          logDecision("fail", { tvdbId: row.tvdb_id, episodeIds: JSON.parse(row.episode_ids), release: row.release, why: `${why}; blocklisted ${row.release}`, detail: { grabId: row.id }, undo: { action: "unblock", args: { release: row.release } } });
          await tryNext(row.id, rowRequest(row), deps, why);
        } else if (st.state === "missing") {
          // The job vanished from the client (e.g. its history was cleared by hand): not the release's fault.
          setState(row.id, "needs-attention", "the download disappeared from the download client");
        } else if (st.state === "completed" && st.path) {
          // Claim the row so an overlapping tick can't import it twice.
          if (!db.prepare("UPDATE grabs SET state = 'importing', updated_at = ? WHERE id = ? AND state = 'downloading'").run(Date.now(), row.id).changes) continue;
          try {
            await importAndVerify(row, st.path, deps);
          } catch (e) {
            setState(row.id, "needs-attention", `import error: ${(e as Error).message}`);
            logDecision("fail", { tvdbId: row.tvdb_id, episodeIds: JSON.parse(row.episode_ids), release: row.release, why: `Import of ${row.release} hit an error: ${(e as Error).message}. The download is kept; press "Retry import" when the cause is fixed.`, detail: { grabId: row.id } });
          }
        } else if ((row.progress ?? -1) < st.progress) {
          db.prepare("UPDATE grabs SET progress = ?, progress_at = ? WHERE id = ?").run(st.progress, now, row.id);
        }
      } catch (e) {
        db.prepare("UPDATE grabs SET error = ? WHERE id = ?").run((e as Error).message, row.id);
      }
    }
  } finally {
    ticking = false;
  }
}

function rowRequest(row: GrabRow): GrabRequest {
  const fallbacks = JSON.parse(row.candidates) as Candidate[];
  return { tvdbId: row.tvdb_id, episodeIds: JSON.parse(row.episode_ids), candidate: fallbacks[0], fallbacks, origin: row.origin, attempt: row.attempt ?? 1 };
}

/** Imports a finished download through Sonarr's ManualImport with explicit episode IDs, verifying before and after. */
export async function importAndVerify(row: GrabRow, clientPath: string, deps: PipelineDeps = realDeps) {
  const series = seriesByTvdb(row.tvdb_id);
  const wanted = JSON.parse(row.episode_ids) as number[];
  const fail = async (why: string, imported: boolean) => {
    setState(row.id, "failed", why);
    blocklist(row, why);
    logDecision("verify-fail", { tvdbId: row.tvdb_id, title: series?.title, episodeIds: wanted, release: row.release, why: `${row.release} failed verification: ${why}${imported ? " (already imported; it will be replaced if a better release is found)" : ""}. Blocklisted it.`, detail: { grabId: row.id }, undo: { action: "unblock", args: { release: row.release } } });
    await tryNext(row.id, rowRequest(row), deps, why);
  };
  /** Problems that aren't the release's fault: no blocklist, no next candidate; the user can retry the import. */
  const attention = (why: string) => {
    setState(row.id, "needs-attention", why);
    logDecision("fail", { tvdbId: row.tvdb_id, title: series?.title, episodeIds: wanted, release: row.release, why: `Downloaded ${row.release} but couldn't import it: ${why}. The download is kept; fix the cause and press "Retry import".`, detail: { grabId: row.id } });
  };
  if (!series || !underAllowedRoot(series.path)) return attention("the series is outside the allowed root folders");
  const sonarrPath = clientToSonarr(clientPath);
  const single = VIDEO.test(sonarrPath);
  const folder = single ? path.posix.dirname(sonarrPath) : sonarrPath;
  // Folder only: given a seriesId, Sonarr's preview ignores the folder and lists the series' library files instead.
  const items = (await deps.sonarr.preview(folder)).filter((x) => VIDEO.test(x.path) && !/\bsample\b/i.test(x.path) && (x.size ?? 1e9) > 30e6);
  // A single-file torrent's folder is the shared category folder: only that one file belongs to this grab.
  const inThis = items.filter((x) => (single ? x.path === sonarrPath : x.path.startsWith(`${folder}/`)));
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

  const prof = getSettings().profile;
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
    const v = judge(probe, prof, expectedMin, burned);
    learnFromVerify(parsed.group, learnKey, v.subs, v.audio);
    if (!v.ok) return fail(`${path.posix.basename(p.item.path)}: ${v.why}`, false);
    preVerified.add(p.item.path);
    verdicts.push(v.why);
    logDecision("verify-ok", { tvdbId: row.tvdb_id, title: series.title, episodeIds: p.episodeIds, release: row.release, why: `Checked ${path.posix.basename(p.item.path)} before import: ${v.why}`, detail: { grabId: row.id, probe } });
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
  }));
  const startedImport = Date.now();
  const cmd = await deps.sonarr.importFiles(files, "auto");
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
      const [mm, ss] = (ef.mediaInfo?.runTime ?? "").split(":").map(Number);
      const v = judge({ subs, audio, durationSec: Number.isFinite(mm) ? mm * 60 + (ss || 0) : null, sidecars: [], untagged: 0 }, prof, expectedMin, burned);
      learnFromVerify(parsed.group, learnKey, v.subs, v.audio);
      if (!v.ok) return fail(`${path.posix.basename(ef.path)}: ${v.why}`, true);
      verdicts.push(v.why);
      logDecision("verify-ok", { tvdbId: row.tvdb_id, title: series.title, episodeIds: p.episodeIds, release: row.release, why: `Imported and checked ${path.posix.basename(ef.path)}: ${v.why}`, detail: { grabId: row.id } });
    }
  }
  setState(row.id, "done");
  scheduleAfter(mapped, "done", `imported ${row.release}`);
  const labels = eps.filter((e) => mapped.includes(e.id)).map((e) => `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}`);
  logDecision("import", { tvdbId: row.tvdb_id, title: series.title, episodeIds: mapped, release: row.release, why: `Imported ✓ as ${labels.join(", ")}: ${[...new Set(verdicts)].join("; ") || "checked"}`, detail: { grabId: row.id, final: true } });
  try {
    await deps.refreshSeries?.(series.id);
  } catch {
    /* the next sync catches up */
  }
}

/** "Retry import" for a grab that downloaded fine but couldn't be imported. */
export function retryImport(id: number) {
  const r = db.prepare("UPDATE grabs SET state = 'downloading', error = NULL, updated_at = ?, progress_at = ? WHERE id = ? AND state = 'needs-attention'").run(Date.now(), Date.now(), id);
  if (!r.changes) throw Object.assign(new Error("Only grabs that need attention can be retried"), { statusCode: 409 });
}

export function listGrabs(limit = 50) {
  return (db.prepare("SELECT * FROM grabs ORDER BY id DESC LIMIT ?").all(limit) as unknown as GrabRow[]).map((g) => ({ ...g, episode_ids: JSON.parse(g.episode_ids) as number[], candidates: undefined, fallbacks: (JSON.parse(g.candidates) as unknown[]).length }));
}
