/**
 * Grab → download → (verify) → import → verify, with explicit episode IDs (works even when the series is unmonitored in
 * Sonarr). All side effects go through `PipelineDeps` so the whole flow is testable with mocks, and every step writes a
 * plain-language entry to the activity log.
 *
 * Safety rails:
 * - DRY-RUN: nothing is sent to a download client; the log says "would grab X".
 * - Allowed root folders: AnimeArr refuses to grab for / import into a series outside them.
 * - On a failed verification the release is blocklisted and the next candidate is tried (up to 3 per request).
 */
import path from "node:path";
import { logDecision } from "./activity.js";
import { fetchReleaseFile as realFetchRelease, type ProwlarrRelease } from "./arr/prowlarr.js";
import { realClients, type ClientJob, type DownloadClients } from "./arr/clients.js";
import * as sonarr from "./arr/sonarr.js";
import { identify } from "./core/identify.js";
import { parseRelease } from "./core/parser.js";
import { db, dbState } from "./db.js";
import { burnedInFact } from "./audit.js";
import { learnFromVerify, sourceKey } from "./library.js";
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
}

export const realDeps: PipelineDeps = {
  clients: realClients,
  fetchRelease: realFetchRelease,
  sonarr: { preview: sonarr.manualImportPreview, importFiles: sonarr.manualImport, command: sonarr.getCommand, episode: sonarr.getEpisode, episodeFile: sonarr.getEpisodeFile },
  probe: (f) => ffprobe(f),
  localPath: realLocalPath,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export type Candidate = Pick<SearchResult, "guid" | "title" | "indexerId" | "indexer" | "protocol" | "size" | "downloadUrl" | "magnetUrl" | "label" | "group"> & { why: string; episodeIds: number[] };

export interface GrabRequest {
  tvdbId: number;
  /** Episodes the user/scheduler asked for. */
  episodeIds: number[];
  candidate: Candidate;
  /** Next-best accepted candidates, tried in order if this one fails verification. */
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
}

const setState = (id: number, state: string, error: string | null = null, extra: { client?: string; ref?: string } = {}) =>
  db.prepare("UPDATE grabs SET state = ?, error = ?, updated_at = ?, client = COALESCE(?, client), client_ref = COALESCE(?, client_ref) WHERE id = ?").run(state, error, Date.now(), extra.client ?? null, extra.ref ?? null, id);

function managedDryRun(tvdbId: number): boolean | null {
  const r = db.prepare("SELECT dry_run FROM managed WHERE tvdb_id = ?").get(tvdbId) as { dry_run: number } | undefined;
  return r ? !!r.dry_run : null;
}

/** Starts a grab (or records what it would do in dry-run). Returns the grab id. */
export async function startGrab(req: GrabRequest, deps: PipelineDeps = realDeps): Promise<{ id: number; dryRun: boolean; message: string }> {
  if (dbState.corrupt) throw Object.assign(new Error("The database failed its integrity check; restore a backup first"), { statusCode: 503 });
  const series = seriesByTvdb(req.tvdbId);
  if (!series) throw Object.assign(new Error("Unknown series; sync the library first"), { statusCode: 404 });
  if (!underAllowedRoot(series.path)) {
    const roots = getSettings().allowedRoots;
    throw Object.assign(new Error(`${series.title} is in ${path.posix.dirname(series.path)}, which is not an allowed root folder${roots.length ? ` (${roots.join(", ")})` : ""}. AnimeArr only grabs and imports for shows inside the root folders you allowed in Settings → Safety.`), { statusCode: 403 });
  }
  const c = req.candidate;
  const dryRun = req.origin === "manual" ? getSettings().managed.dryRun : isDryRun(managedDryRun(req.tvdbId));
  const eps = episodesFor(req.tvdbId).filter((e) => c.episodeIds.includes(e.id));
  const target = eps.map((e) => `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")} (episode id ${e.id})`).join(", ");
  const now = Date.now();
  const ins = db
    .prepare("INSERT INTO grabs (at, updated_at, tvdb_id, series_id, episode_ids, release, guid, indexer_id, protocol, state, dry_run, origin, why, candidates) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(now, now, req.tvdbId, series.id, JSON.stringify(c.episodeIds), c.title, c.guid, c.indexerId, c.protocol, dryRun ? "dry-run" : "sending", dryRun ? 1 : 0, req.origin, c.why, JSON.stringify(req.fallbacks.slice(0, 5)));
  const id = Number(ins.lastInsertRowid);
  if (dryRun) {
    const msg = `would grab ${c.title} (${c.protocol}, ${c.indexer}) for ${series.title} ${c.label}: ${c.why}. Would import into Sonarr as ${target}.`;
    logDecision("would-grab", { tvdbId: req.tvdbId, title: series.title, episodeIds: c.episodeIds, release: c.title, why: `Dry-run: ${msg}`, detail: { grabId: id, fallbacks: req.fallbacks.length } });
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
    logDecision("grab", { tvdbId: req.tvdbId, title: series.title, episodeIds: c.episodeIds, release: c.title, why: `Sent ${c.title} to ${job.client === "sabnzbd" ? "SABnzbd" : "qBittorrent"} (category ${job.client === "sabnzbd" ? getSettings().sabnzbd.category : getSettings().qbittorrent.category}) for ${series.title} ${c.label}: ${c.why}`, detail: { grabId: id } });
    return { id, dryRun: false, message: `Sent to ${job.client}` };
  } catch (e) {
    setState(id, "failed", (e as Error).message);
    logDecision("fail", { tvdbId: req.tvdbId, title: series.title, episodeIds: c.episodeIds, release: c.title, why: `Couldn't send ${c.title}: ${(e as Error).message}`, detail: { grabId: id } });
    await tryNext(id, req, deps, (e as Error).message);
    return { id, dryRun: false, message: (e as Error).message };
  }
}

async function tryNext(grabId: number, req: GrabRequest, deps: PipelineDeps, reason: string) {
  const attempt = (req.attempt ?? 1) + 1;
  const [next, ...rest] = req.fallbacks;
  if (!next || attempt > 3) {
    logDecision("skip", { tvdbId: req.tvdbId, episodeIds: req.episodeIds, why: `No more candidates to try after: ${reason}`, detail: { grabId } });
    return null;
  }
  logDecision("info", { tvdbId: req.tvdbId, episodeIds: req.episodeIds, release: next.title, why: `Trying the next candidate ${next.title} (${next.why})`, detail: { grabId } });
  return startGrab({ ...req, candidate: next, fallbacks: rest, attempt }, deps);
}

function blocklist(row: GrabRow, reason: string) {
  db.prepare("INSERT INTO blocklist (guid, release, tvdb_id, reason, at) VALUES (?, ?, ?, ?, ?)").run(row.guid, row.release, row.tvdb_id, reason, Date.now());
}

const VIDEO = /\.(mkv|mp4|avi|m4v|ts|webm)$/i;

/** One pass over in-flight grabs: checks the download clients, then imports and verifies finished downloads. */
export async function pipelineTick(deps: PipelineDeps = realDeps) {
  if (dbState.corrupt) return;
  const rows = db.prepare("SELECT * FROM grabs WHERE state IN ('downloading') ORDER BY id").all() as unknown as GrabRow[];
  for (const row of rows) {
    try {
      const st = await deps.clients.status({ client: row.client as ClientJob["client"], ref: row.client_ref! });
      if (st.state === "failed" || st.state === "missing") {
        setState(row.id, "failed", st.message ?? st.state);
        blocklist(row, `download ${st.state}${st.message ? `: ${st.message}` : ""}`);
        logDecision("fail", { tvdbId: row.tvdb_id, episodeIds: JSON.parse(row.episode_ids), release: row.release, why: `Download ${st.state}${st.message ? ` (${st.message})` : ""}; blocklisted`, detail: { grabId: row.id }, undo: { action: "unblock", args: { release: row.release } } });
        await tryNext(row.id, rowRequest(row), deps, `download ${st.state}`);
      } else if (st.state === "completed" && st.path) {
        setState(row.id, "importing");
        await importAndVerify(row, st.path, deps);
      }
    } catch (e) {
      db.prepare("UPDATE grabs SET error = ?, updated_at = ? WHERE id = ?").run((e as Error).message, Date.now(), row.id);
    }
  }
}

function rowRequest(row: GrabRow): GrabRequest {
  const fallbacks = JSON.parse(row.candidates) as Candidate[];
  return { tvdbId: row.tvdb_id, episodeIds: JSON.parse(row.episode_ids), candidate: fallbacks[0], fallbacks, origin: row.origin, attempt: 1 };
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
  if (!series || !underAllowedRoot(series.path)) return fail("series is outside the allowed root folders", false);
  const sonarrPath = clientToSonarr(clientPath);
  const folder = VIDEO.test(sonarrPath) ? path.posix.dirname(sonarrPath) : sonarrPath;
  const items = (await deps.sonarr.preview(folder, undefined, series.id)).filter((x) => VIDEO.test(x.path) && !/\bsample\b/i.test(x.path) && (x.size ?? 1e9) > 30e6);
  const inThis = items.filter((x) => x.path.startsWith(folder));
  if (!inThis.length) return fail(`no video files found in ${folder}`, false);

  // Map each file to episodes: single file + single episode is direct; otherwise identify each file name.
  const ctx = identifyContext();
  const plan: { item: (typeof inThis)[number]; episodeIds: number[] }[] = [];
  if (inThis.length === 1 && wanted.length === 1) plan.push({ item: inThis[0], episodeIds: wanted });
  else
    for (const it of inThis) {
      const id = identify(path.posix.basename(it.path), ctx, { tvdbId: row.tvdb_id });
      const ids = (id.resolution?.ok ? id.resolution.episodes.map((e) => e.id) : []).filter((x) => wanted.includes(x));
      if (ids.length) plan.push({ item: it, episodeIds: ids });
    }
  if (!plan.length) return fail("couldn't tell which file is which episode", false);

  const prof = getSettings().profile;
  const parsed = parseRelease(row.release);
  const eps = episodesFor(row.tvdb_id);
  const season = eps.find((e) => wanted.includes(e.id))?.season ?? null;
  const burned = prof.subLangs.find((l) => !!burnedInFact(row.tvdb_id, season, l)) ?? null;
  const expectedMin = eps.find((e) => wanted.includes(e.id))?.runtime ?? null;

  // Verify BEFORE import when the file is reachable from here.
  const preVerified = new Set<string>();
  for (const p of plan) {
    const local = deps.localPath(p.item.path);
    if (!local) continue;
    const probe = await deps.probe(local);
    const v = judge(probe, prof, expectedMin, burned);
    learnFromVerify(parsed.group, parsed.platform ?? sourceKey(row.release, null, parsed.source), v.subs, v.audio);
    if (!v.ok) return fail(`${path.posix.basename(p.item.path)}: ${v.why}`, false);
    preVerified.add(p.item.path);
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
  const cmd = await deps.sonarr.importFiles(files, "auto");
  logDecision("import", { tvdbId: row.tvdb_id, title: series.title, episodeIds: wanted, release: row.release, why: `Asked Sonarr to import ${files.length} file(s) as ${files.map((f) => f.episodeIds.join("+")).join(", ")} (explicit episode IDs, command ${cmd.id})`, detail: { grabId: row.id, commandId: cmd.id } });
  let status = "queued";
  for (let i = 0; i < 120 && !["completed", "failed", "aborted"].includes(status); i++) {
    await deps.sleep(5000);
    status = (await deps.sonarr.command(cmd.id)).status;
  }
  if (status !== "completed") return fail(`Sonarr import ${status}`, false);

  // Verify AFTER import from Sonarr's mediaInfo for files we couldn't probe ourselves.
  for (const p of plan) {
    if (preVerified.has(p.item.path)) continue;
    const ep = await deps.sonarr.episode(p.episodeIds[0]);
    if (!ep.episodeFileId) return fail(`Sonarr reported success but S${ep.seasonNumber}E${ep.episodeNumber} has no file`, true);
    const ef = await deps.sonarr.episodeFile(ep.episodeFileId);
    const { langList } = await import("./core/langs.js");
    const subs = langList(ef.mediaInfo?.subtitles);
    const audio = langList(ef.mediaInfo?.audioLanguages);
    const [mm, ss] = (ef.mediaInfo?.runTime ?? "").split(":").map(Number);
    const v = judge({ subs, audio, durationSec: Number.isFinite(mm) ? mm * 60 + (ss || 0) : null, sidecars: [], untagged: 0 }, prof, expectedMin, burned);
    learnFromVerify(parsed.group, parsed.platform ?? sourceKey(row.release, null, parsed.source), v.subs, v.audio);
    if (!v.ok) return fail(`${path.posix.basename(ef.path)}: ${v.why}`, true);
    logDecision("verify-ok", { tvdbId: row.tvdb_id, title: series.title, episodeIds: p.episodeIds, release: row.release, why: `Imported and checked ${path.posix.basename(ef.path)}: ${v.why}`, detail: { grabId: row.id } });
  }
  setState(row.id, "done");
}

export function listGrabs(limit = 50) {
  return (db.prepare("SELECT * FROM grabs ORDER BY id DESC LIMIT ?").all(limit) as unknown as GrabRow[]).map((g) => ({ ...g, episode_ids: JSON.parse(g.episode_ids) as number[], candidates: undefined, fallbacks: (JSON.parse(g.candidates) as unknown[]).length }));
}
