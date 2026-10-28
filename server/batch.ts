/**
 * Smart batch grabs (client-agnostic). Two decisions, both pure where it matters so they can be tested:
 *
 * 1. Season consistency (torrent AND Usenet): when a batch covers a season the library already partly has, does the
 *    grab want only the missing episodes, or the whole season as a Replace season (old files go to the recycle bin
 *    only after the new ones passed their check)? Same group → missing only. Different group, quality at least as good
 *    → whole season. Different group, worse → missing only (single releases of the season's group are preferred for
 *    the gaps by the automatic search). Episodes whose file failed its check always count as missing. Consistency off
 *    → missing only.
 * 2. Which files of a batch are wanted (torrents whose client can select files): the files are mapped to episodes
 *    (or to the movie/special) with the same parser and numbering resolver the import uses; the rest get skipped.
 *
 * Nothing here talks to a specific download client: file listing/selection goes through the DownloadClients
 * capability (listFiles / selectFiles / start). Clients without it (and Usenet) download the whole batch; the import
 * takes only the wanted files, and the leftovers are cleaned after a confirmed import.
 */
import path from "node:path";
import { logDecision } from "./activity.js";
import type { ClientJob, DownloadClients } from "./arr/clients.js";
import { fileForMovie } from "./core/movieTitle.js";
import { parseRelease, type Source } from "./core/parser.js";
import { isCreditlessTitle } from "./core/resolver.js";
import { cache, db } from "./db.js";

// ---------------------------------------------------------------- batch info on the grab

export interface BatchInfo {
  /** pending = waiting for the torrent's file list; partial = unwanted files skipped in the client; whole = the client downloads everything (no file selection, Usenet, or a safe fallback). */
  mode: "pending" | "partial" | "whole";
  /** Episodes in the release / episodes this grab wants. */
  total: number;
  wanted: number;
  /** Episodes deliberately not downloaded/imported (the library has them already). */
  skippedEpisodes: number[];
  /** Files skipped in the client. */
  skippedFiles: number;
  /** The download will hold files that aren't wanted: they are deleted with the folder after a confirmed import (Usenet). */
  leftovers: boolean;
  /** Why the whole batch is downloaded (fallbacks), or what the season decision was. */
  note: string | null;
  /** The season decision turned this grab into a Replace season (a fallback re-decides). */
  autoReplace?: boolean;
  /** A movie/special grabbed from a season batch. */
  movie?: boolean;
  since: number;
  /** Failed attempts at reading/applying the file list. */
  tries?: number;
  /** The job was added stopped (it must be started after the selection). */
  paused?: boolean;
}

export function readBatch(raw: string | null | undefined): BatchInfo | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BatchInfo;
  } catch {
    return null;
  }
}
export const writeBatch = (grabId: number, b: BatchInfo | null) => db.prepare("UPDATE grabs SET batch = ? WHERE id = ?").run(b ? JSON.stringify(b) : null, grabId);

/** One plain line for the Queue and Activity ("Downloading 4 of 26 episodes (you have the rest)"). */
export function batchLine(b: BatchInfo | null): string | null {
  if (!b) return null;
  if (b.movie) return b.mode === "partial" ? "Downloading only the movie/special from this season batch" : b.mode === "pending" ? "Waiting for the torrent's file list to download only the movie/special" : "Downloading the whole season batch; only the movie/special is imported, the rest is cleaned up after the import";
  if (b.total <= 1) return null;
  if (b.wanted >= b.total) return b.autoReplace ? `Downloading all ${b.total} episodes (replacing the season)` : null;
  const rest = b.skippedEpisodes.length ? " (you have the rest)" : "";
  if (b.mode === "partial") return `Downloading ${b.wanted} of ${b.total} episodes${rest}`;
  if (b.mode === "pending") return `Waiting for the torrent's file list to download only ${b.wanted} of ${b.total} episodes`;
  return `Downloading the whole batch; importing ${b.wanted} of ${b.total} episodes${rest}${b.leftovers ? ", the rest is cleaned up after the import" : ""}${b.note ? ` (${b.note})` : ""}`;
}

// ---------------------------------------------------------------- 1. season consistency

export interface ExistingFile {
  episodeId: number;
  group: string | null;
  /** Height (1080) when known. */
  resolution: number | null;
  source: Source;
  /** The file failed its language check (e.g. no EN subs, wrong language): counts as missing. */
  failed: boolean;
}

export interface SeasonInput {
  season: number;
  consistency: "off" | "prefer" | "strong";
  /** The batch's episodes in this season (movie specials left out). */
  batchEpisodes: number[];
  /** Episodes of the season the library has a file for. */
  existing: ExistingFile[];
  batch: { group: string | null; resolution: number | null; source: Source };
  /** The profile's resolution (quality is ranked like the release ranking: the profile's resolution first). */
  profileResolution: number;
  /** A recycle bin is set (Replace season needs it, so old files can come back). */
  recycleBin: boolean;
}

export interface SeasonDecision {
  mode: "missing" | "replace";
  /** Episodes of this season the grab wants. */
  want: number[];
  /** Episodes that have a file the batch would replace (failed checks, or the whole season). */
  replaces: number[];
  /** The batch is a worse release from another group: single releases of the season's group should fill the gaps first. */
  preferSingles: boolean;
  seasonGroup: string | null;
  why: string;
}

const SOURCE_RANK: Record<string, number> = { bluray: 3, web: 2, hdtv: 1, dvd: 0 };
/** Resolution against the profile, the way the release ranking scores it: the profile's own best, higher next, lower worst. */
const resScore = (r: number | null, want: number) => (r === null ? null : r === want ? 3 : r > want ? 2 : r >= 720 ? 1 : 0);

/** -1 worse, 0 same, 1 better; unknown on either side counts as the same (null when nothing is known at all). */
export function compareQuality(a: { resolution: number | null; source: Source }, b: { resolution: number | null; source: Source }, profileRes: number): number | null {
  const ra = resScore(a.resolution, profileRes);
  const rb = resScore(b.resolution, profileRes);
  if (ra !== null && rb !== null && ra !== rb) return ra > rb ? 1 : -1;
  const sa = a.source ? SOURCE_RANK[a.source] : undefined;
  const sb = b.source ? SOURCE_RANK[b.source] : undefined;
  if (sa !== undefined && sb !== undefined && sa !== sb) return sa > sb ? 1 : -1;
  if (ra === null && sa === undefined) return null;
  return 0;
}

/** The group most of the files come from (a real majority), like the search's season group. */
export function majorityGroup(files: { group: string | null }[]): string | null {
  const counts = new Map<string, { n: number; name: string }>();
  for (const f of files) {
    if (!f.group) continue;
    const k = f.group.toLowerCase();
    counts.set(k, { n: (counts.get(k)?.n ?? 0) + 1, name: counts.get(k)?.name ?? f.group });
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  const total = [...counts.values()].reduce((a, c) => a + c.n, 0);
  if (!best || (best.n * 2 <= total && total > 1)) return null;
  return best.name;
}

/** The typical quality of the season's files (the most common resolution/source among the season group's files, else all). */
function typicalQuality(files: ExistingFile[], group: string | null) {
  const pool = group ? files.filter((f) => f.group?.toLowerCase() === group.toLowerCase()) : files;
  const top = <T>(xs: T[]) => {
    const m = new Map<T, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  return { resolution: top(pool.map((f) => f.resolution).filter((r): r is number => r !== null)), source: top(pool.map((f) => f.source).filter((s): s is NonNullable<Source> => !!s)) as Source };
}

/** Per season: only the missing episodes, or the whole season as a Replace season. Pure. */
export function decideSeason(x: SeasonInput): SeasonDecision {
  const have = new Map(x.existing.map((f) => [f.episodeId, f]));
  const inBatch = x.batchEpisodes;
  const missing = inBatch.filter((e) => !have.has(e));
  const failed = inBatch.filter((e) => have.get(e)?.failed);
  const good = x.existing.filter((f) => !f.failed && inBatch.includes(f.episodeId));
  const seasonGroup = majorityGroup(x.existing.filter((f) => !f.failed));
  const s = `season ${x.season}`;
  const failedNote = failed.length ? `; ${failed.length} episode${failed.length === 1 ? "" : "s"} whose file failed its check count as missing` : "";
  const missingOnly = (why: string, preferSingles = false): SeasonDecision => {
    // Failed files are replaced through the Replace-season path (old file to the bin only after the new one passed); without a bin they stay.
    const repl = x.recycleBin ? failed : [];
    const binNote = failed.length && !x.recycleBin ? `; ${failed.length} episode${failed.length === 1 ? "" : "s"} with a failed file stay as they are (Replace season needs the recycling bin)` : "";
    return { mode: "missing", want: [...missing, ...repl], replaces: repl, preferSingles, seasonGroup, why: `${why}${repl.length ? failedNote : ""}${binNote}` };
  };
  if (!good.length) return { mode: "missing", want: [...missing, ...(x.recycleBin ? failed : [])], replaces: x.recycleBin ? failed : [], preferSingles: false, seasonGroup, why: `Taking ${s}: you have none of its episodes${failed.length ? ` with a good file${x.recycleBin ? failedNote : ""}` : ""}` };
  if (x.consistency === "off") return missingOnly(`Only the ${missing.length} missing episode${missing.length === 1 ? "" : "s"} of ${s}: keeping one group per season is off`);
  const batchGroup = x.batch.group;
  if (seasonGroup && batchGroup && seasonGroup.toLowerCase() === batchGroup.toLowerCase()) return missingOnly(`Only the ${missing.length} missing episode${missing.length === 1 ? "" : "s"} of ${s}: same group as your files (${seasonGroup})`);
  const existingQ = typicalQuality(good, seasonGroup);
  const cmp = compareQuality(x.batch, existingQ, x.profileResolution);
  const groupWords = seasonGroup ? `${seasonGroup} → ${batchGroup ?? "no group"}` : `your files are a mix of groups`;
  if (cmp === null || cmp < 0) {
    const worse = cmp === null ? "can't tell its quality" : "lower quality than your files";
    return missingOnly(`Only the ${missing.length} missing episode${missing.length === 1 ? "" : "s"} of ${s}: the batch is another group (${groupWords}) and ${worse}; the season stays mixed`, cmp !== null && !!seasonGroup);
  }
  if (!x.recycleBin) return missingOnly(`Only the ${missing.length} missing episode${missing.length === 1 ? "" : "s"} of ${s}: replacing the season would keep one group (${batchGroup ?? "?"}) but needs the recycling bin (Settings → Media management)`);
  return {
    mode: "replace",
    want: [...inBatch],
    replaces: inBatch.filter((e) => have.has(e)),
    preferSingles: false,
    seasonGroup,
    why: `Replacing the whole of ${s}: ${cmp > 0 ? "better" : "same"} quality, and keeps one group (${batchGroup ?? "the batch's"})${seasonGroup ? ` instead of ${seasonGroup}` : ""}; old files go to the recycling bin only after the new ones pass their check`,
  };
}

/** Height from Sonarr's mediaInfo resolution ("1920x1080") or a quality name ("WEBDL-1080p"). */
export const heightOf = (res: string | null | undefined) => {
  const m = /x(\d{3,4})\b/.exec(res ?? "") ?? /(\d{3,4})p?\s*$/.exec(res ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  return h >= 1500 ? 2160 : h >= 900 ? 1080 : h >= 650 ? 720 : 480;
};
const sourceOf = (src: string | null, scene: string | null, quality: string | null): Source => {
  const s = (src ?? "").toLowerCase();
  if (/bluray/.test(s)) return "bluray";
  if (/web/.test(s)) return "web";
  if (/television|hdtv/.test(s)) return "hdtv";
  if (/dvd/.test(s)) return "dvd";
  if (scene) {
    const p = parseRelease(scene).source;
    if (p) return p;
  }
  if (/bluray/i.test(quality ?? "")) return "bluray";
  if (/web/i.test(quality ?? "")) return "web";
  return null;
};

export interface BatchPlan {
  importIds: number[];
  purpose: "replace" | null;
  why: string | null;
  preferSingles: boolean;
  decisions: SeasonDecision[];
}

/**
 * The season decision for a batch candidate, from the library (cache): which episodes the grab wants and whether it is
 * a Replace season. `baseIds` = what the grab wants without the decision (asked for, or without a file).
 * `existingOf` reads the season's files with their check verdict (episodes.ts; injected to keep imports one-way).
 */
export function planBatch(input: {
  seriesId: number;
  candidateEpisodeIds: number[];
  baseIds: number[];
  release: string;
  group: string | null;
  consistency: "off" | "prefer" | "strong";
  profileResolution: number;
  recycleBin: boolean;
  exclude: Set<number>;
  existingOf: (seriesId: number, season: number) => ExistingFile[];
}): BatchPlan {
  const eps = cache.prepare(`SELECT id, season FROM episodes WHERE id IN (${input.candidateEpisodeIds.map(() => "?").join(",") || "NULL"})`).all(...input.candidateEpisodeIds) as { id: number; season: number }[];
  const seasons = [...new Set(eps.map((e) => e.season))].sort((a, b) => a - b);
  const parsed = parseRelease(input.release);
  const want = new Set(input.baseIds);
  const decisions: SeasonDecision[] = [];
  for (const season of seasons) {
    const batchEpisodes = eps.filter((e) => e.season === season && !input.exclude.has(e.id)).map((e) => e.id);
    if (batchEpisodes.length < 2) continue;
    const d = decideSeason({ season, consistency: input.consistency, batchEpisodes, existing: input.existingOf(input.seriesId, season), batch: { group: input.group ?? parsed.group, resolution: parsed.resolution, source: parsed.source }, profileResolution: input.profileResolution, recycleBin: input.recycleBin });
    decisions.push(d);
    for (const e of d.want) want.add(e);
  }
  const replacing = decisions.some((d) => d.replaces.length > 0);
  return {
    importIds: input.candidateEpisodeIds.filter((e) => want.has(e) && !input.exclude.has(e)),
    purpose: replacing ? "replace" : null,
    why: decisions.length ? decisions.map((d) => d.why).join(". ") : null,
    preferSingles: decisions.some((d) => d.preferSingles),
    decisions,
  };
}

/** The season's files from the cache, with their language verdict (failed = the check says "no"). */
export async function existingFiles(seriesId: number, season: number): Promise<ExistingFile[]> {
  const { episodeRows } = await import("./episodes.js");
  const hasFile = (id: number) => !!(cache.prepare("SELECT has_file FROM episodes WHERE id = ?").get(id) as { has_file: number } | undefined)?.has_file;
  const files = new Map((cache.prepare("SELECT id, source, scene_name, quality, resolution FROM files WHERE series_id = ?").all(seriesId) as { id: number; source: string | null; scene_name: string | null; quality: string | null; resolution: string | null }[]).map((f) => [f.id, f]));
  return episodeRows(seriesId)
    // An episode with a file but no file details yet (not synced) still has its file: never "missing".
    .filter((e) => e.season === season && (e.file || e.status === "have" || hasFile(e.id)))
    .map((e) => {
      const f = e.file ? files.get(e.file.id) : undefined;
      return {
        episodeId: e.id,
        group: e.file?.group ?? (f?.scene_name ? parseRelease(f.scene_name).group : null),
        resolution: heightOf(f?.resolution) ?? heightOf(f?.quality),
        source: sourceOf(f?.source ?? null, f?.scene_name ?? null, f?.quality ?? null),
        failed: e.file?.lang?.state === "no",
      };
    });
}

// ---------------------------------------------------------------- 2. which files are wanted

export interface BatchFile {
  /** The client's file index. */
  index: number;
  /** Path inside the torrent ("Show (Batch)/Specials/Show - OVA.mkv"). */
  name: string;
  size: number;
}

export interface FilePlan {
  /** True = download everything (nothing to skip, or mapping wasn't safe). */
  whole: boolean;
  wanted: number[];
  skipped: number[];
  /** Episodes whose files are skipped. */
  skippedEpisodes: number[];
  /** Creditless OP/ED episodes kept as valued extras (not asked for, no file yet): the import takes them too. */
  extraEpisodes: number[];
  reason: string;
}

const VIDEO = /\.(mkv|mp4|avi|m4v|ts|webm|wmv|mov)$/i;
const SUBTITLE = /\.(ass|ssa|srt|sup|vtt|idx|sub|smi)$/i;
const ARCHIVE = /\.(rar|r\d\d|zip|7z|\d{3})$/i;

export interface FileMapOpts {
  /** Episodes the grab wants (an episode grab), or empty for a movie grab. */
  wantedIds: number[];
  /** File name → its episodes (the importer's mapping: identify with the show's context; null = unmapped). */
  resolve: (basename: string) => number[] | null;
  /** Keep creditless OP/ED files nobody asked for (the show's creditless setting), unless the library has them. */
  keepCreditless: boolean;
  hasFile?: (episodeId: number) => boolean;
  /** A movie grab: the movie's distinguishing subtitles (movieTitle.ts). */
  movie?: { subtitles: string[] };
}

const base = (n: string) => n.split(/[\\/]/).pop()!;
const stem = (n: string) => base(n).replace(/\.[^.]+$/, "");

/**
 * Which files of a batch to download. Videos are mapped with the same resolver the import uses; subtitle sidecars
 * follow their video; fonts and other small files are always kept. Safety: every wanted episode must have a file
 * (otherwise everything is downloaded, so the import sees what it would have seen); archives are never split.
 */
export function planFiles(files: BatchFile[], o: FileMapOpts): FilePlan {
  const whole = (reason: string): FilePlan => ({ whole: true, wanted: files.map((f) => f.index), skipped: [], skippedEpisodes: [], extraEpisodes: [], reason });
  if (!files.length) return whole("the torrent lists no files");
  if (files.some((f) => ARCHIVE.test(f.name))) return whole("the batch is packed in archives");
  const videos = files.filter((f) => VIDEO.test(f.name));
  if (videos.length < 2) return whole("one video file: nothing to skip");
  const keep = new Set<number>();
  const skip = new Set<number>();
  const skippedEps = new Set<number>();
  const extraEps = new Set<number>();
  const keptStems: string[] = [];
  const skippedStems: string[] = [];
  if (o.movie) {
    const hit = fileForMovie(videos.map((v) => ({ path: v.name, v })), o.movie.subtitles);
    if (!hit) return whole("no single file names the movie");
    for (const v of videos) (v === hit.v ? keep : skip).add(v.index);
    keptStems.push(stem(hit.v.name));
    for (const v of videos) if (v !== hit.v) skippedStems.push(stem(v.name));
  } else {
    const covered = new Set<number>();
    for (const v of videos) {
      const b = base(v.name);
      const ids = o.resolve(b);
      const creditless = !!parseRelease(b).creditless || isCreditlessTitle(stem(b));
      if (ids?.some((e) => o.wantedIds.includes(e))) {
        keep.add(v.index);
        keptStems.push(stem(v.name));
        for (const e of ids) if (o.wantedIds.includes(e)) covered.add(e);
      } else if (creditless && o.keepCreditless && !(ids ?? []).some((e) => o.hasFile?.(e))) {
        // An NCOP/NCED the library doesn't have yet: a valued extra (imported when it maps to the show's special).
        keep.add(v.index);
        keptStems.push(stem(v.name));
        for (const e of ids ?? []) extraEps.add(e);
      } else {
        skip.add(v.index);
        skippedStems.push(stem(v.name));
        for (const e of ids ?? []) skippedEps.add(e);
      }
    }
    const uncovered = o.wantedIds.filter((e) => !covered.has(e));
    if (uncovered.length) return whole(`couldn't match ${uncovered.length} wanted episode${uncovered.length === 1 ? "" : "s"} to a file`);
  }
  // Sidecars: a subtitle goes with the video whose name it starts with; one that names no video is kept (tiny).
  for (const f of files) {
    if (VIDEO.test(f.name)) continue;
    if (SUBTITLE.test(f.name)) {
      const s = stem(f.name);
      const owner = (list: string[]) => list.filter((v) => s === v || s.startsWith(`${v}.`)).sort((a, b) => b.length - a.length)[0] ?? null;
      const k = owner(keptStems);
      const sk = owner(skippedStems);
      if (sk && (!k || sk.length > k.length)) skip.add(f.index);
      else keep.add(f.index);
      continue;
    }
    keep.add(f.index); // fonts (shared by every episode), NFOs, covers
  }
  if (!skip.size) return whole("every file is wanted");
  if (!keep.size) return whole("no file is wanted");
  return { whole: false, wanted: files.filter((f) => keep.has(f.index)).map((f) => f.index), skipped: [...skip], skippedEpisodes: [...skippedEps], extraEpisodes: [...extraEps], reason: `${skip.size} file${skip.size === 1 ? "" : "s"} skipped` };
}

// ---------------------------------------------------------------- applying it through the client capability

export interface SelectContext {
  grabId: number;
  job: ClientJob;
  clients: DownloadClients;
  opts: FileMapOpts;
  /** For the activity log. */
  log: { tvdbId: number | null; title?: string; release: string; episodeIds: number[]; movieId?: number | null };
}

/**
 * Reads the torrent's file list and skips the unwanted files, then starts it. "pending" = no file list yet (magnet
 * still fetching its metadata): call again later. Any problem → the whole torrent is downloaded (never stuck stopped).
 */
export async function applySelection(c: SelectContext, now = Date.now()): Promise<"pending" | "partial" | "whole"> {
  const b = readBatch((db.prepare("SELECT batch FROM grabs WHERE id = ?").get(c.grabId) as { batch: string | null } | undefined)?.batch);
  if (!b) return "whole";
  const finishWhole = async (why: string) => {
    if (c.job.paused && c.clients.start) await c.clients.start(c.job).catch(() => undefined);
    writeBatch(c.grabId, { ...b, mode: "whole", note: why, leftovers: b.wanted < b.total || !!b.movie });
    logDecision("info", { tvdbId: c.log.tvdbId, title: c.log.title, episodeIds: c.log.episodeIds, release: c.log.release, why: `Downloading all of ${c.log.release}: ${why}`, detail: { grabId: c.grabId, ...(c.log.movieId ? { movieId: c.log.movieId } : {}) } });
    return "whole" as const;
  };
  if (!c.clients.listFiles || !c.clients.selectFiles || (c.clients.canSelectFiles && !c.clients.canSelectFiles(c.job)) || !c.job.select) return finishWhole("the download client can't skip files");
  let files: BatchFile[] | null;
  try {
    files = await c.clients.listFiles(c.job);
  } catch (e) {
    const tries = (b.tries ?? 0) + 1;
    if (tries >= 5 || now - b.since > 30 * 60_000) return finishWhole(`couldn't read its file list (${(e as Error).message})`);
    writeBatch(c.grabId, { ...b, tries });
    return "pending";
  }
  if (!files || !files.length) {
    // No metadata yet. A magnet that never gets any is failed by the pipeline's metadata timeout; one whose list
    // still doesn't come after 30 min is simply downloaded whole.
    if (now - b.since > 30 * 60_000) return finishWhole("its file list didn't arrive in 30 minutes");
    return "pending";
  }
  const plan = planFiles(files, c.opts);
  if (plan.whole) return finishWhole(plan.reason);
  if (plan.extraEpisodes.length && !c.log.movieId) {
    // Creditless extras kept: the import takes them as well.
    const ids = JSON.parse((db.prepare("SELECT episode_ids FROM grabs WHERE id = ?").get(c.grabId) as { episode_ids: string }).episode_ids) as number[];
    db.prepare("UPDATE grabs SET episode_ids = ? WHERE id = ?").run(JSON.stringify([...new Set([...ids, ...plan.extraEpisodes])]), c.grabId);
  }
  try {
    await c.clients.selectFiles(c.job, plan.wanted, plan.skipped);
    if (c.job.paused && c.clients.start) await c.clients.start(c.job);
  } catch (e) {
    return finishWhole(`couldn't skip files (${(e as Error).message})`);
  }
  const skippedEpisodes = [...new Set([...b.skippedEpisodes, ...plan.skippedEpisodes])];
  const next: BatchInfo = { ...b, mode: "partial", skippedFiles: plan.skipped.length, skippedEpisodes, leftovers: false, note: null };
  writeBatch(c.grabId, next);
  logDecision("info", { tvdbId: c.log.tvdbId, title: c.log.title, episodeIds: c.log.episodeIds, release: c.log.release, why: `${batchLine(next) ?? "Downloading only the wanted files"}: skipped ${plan.skipped.length} file${plan.skipped.length === 1 ? "" : "s"} of ${c.log.release} in the download client`, detail: { grabId: c.grabId, ...(c.log.movieId ? { movieId: c.log.movieId } : {}) } });
  return "partial";
}

/** Path-free helper for tests and the import: does a torrent-internal name look like a video. */
export const isVideoName = (n: string) => VIDEO.test(path.posix.basename(n));

/**
 * The automatic search's question about a batch: is it a worse release from another group (so the season's group's
 * single releases should fill the gaps first)? The season's group when so, else null.
 */
export async function batchPrefersSingles(tvdbId: number, r: { episodeIds: number[]; title: string; group: string | null }): Promise<string | null> {
  const s = cache.prepare("SELECT id FROM series WHERE tvdb_id = ?").get(tvdbId) as { id: number } | undefined;
  if (!s || r.episodeIds.length < 2) return null;
  const { profileFor } = await import("./profiles.js");
  const { getSettings } = await import("./settings.js");
  const prof = profileFor(tvdbId);
  const seasons = (cache.prepare(`SELECT DISTINCT season FROM episodes WHERE id IN (${r.episodeIds.map(() => "?").join(",")})`).all(...r.episodeIds) as { season: number }[]).map((x) => x.season);
  const existing = new Map<number, ExistingFile[]>();
  for (const season of seasons) existing.set(season, await existingFiles(s.id, season));
  const plan = planBatch({ seriesId: s.id, candidateEpisodeIds: r.episodeIds, baseIds: [], release: r.title, group: r.group, consistency: prof.groupConsistency ?? "prefer", profileResolution: prof.resolution, recycleBin: !!getSettings().media.recycleBin.trim(), exclude: new Set(), existingOf: (_id, season) => existing.get(season) ?? [] });
  return plan.decisions.find((d) => d.preferSingles)?.seasonGroup ?? null;
}
