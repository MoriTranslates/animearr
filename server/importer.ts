/**
 * AnimeArr's own importer and renamer (1.0 takeover, step 2).
 *
 * Import: a finished download (or any folder, for manual import) → which file is which episode → the library path
 * from the naming settings (Sonarr-compatible) → hardlink/copy (torrents keep seeding) or move (Usenet) → sidecar
 * subtitles along → an existing file for the same episode goes to AnimeArr's recycle bin → Sonarr/Radarr re-read the
 * folder (while they still exist) → our own file records catch up.
 *
 * Rename: the series' files whose names differ from the naming settings, as an old → new list; you pick, it renames
 * (sidecars along), logs every rename with undo. Never overwrites: a collision is skipped and reported.
 *
 * Everything starts as a plan (a dry run). Real imports and renames are switched on separately (importer.allowReal /
 * allowRename) after the first plans were reviewed.
 *
 * Safety: sources must be video files outside the library, the recycle bin and AnimeArr's config; nothing is ever
 * overwritten (link-then-unlink, or exclusive copy); a replaced file is only binned after the new one is in place
 * under a temporary name, and comes back if the swap fails.
 */
import { noteBinned } from "./binpurge.js";
import { isCreditlessTitle } from "./core/resolver.js";
import { isTorrentClient } from "./arr/clients.js";
import fs from "node:fs";
import path from "node:path";
import { logDecision } from "./activity.js";
import * as radarr from "./arr/radarr.js";
import * as sonarr from "./arr/sonarr.js";
import { identify } from "./core/identify.js";
import { parseRelease } from "./core/parser.js";
import { sonarrQualityName } from "./core/quality.js";
import { keepTagFor } from "./qualityLocks.js";
import { cache, CONFIG_DIR, db } from "./db.js";
import { catalogLookup } from "./catalog.js";
import { libraryRoots, probeFile, scanFolder, type MediaRecord } from "./mediafiles.js";
import { renderEpisode, renderMovie, renderSeasonFolder, type NamingOptions } from "./naming.js";
import { isNativeMovieId, isNativeSeriesId, rematerializeMovie, rematerializeSeries } from "./native.js";
import { localPath, mappedPath } from "./paths.js";
import { afterLibraryChange } from "./mediaout.js";
import { identifyContext, seriesByTvdb } from "./search.js";
import { getSettings, patchSettings, underAllowedRoot } from "./settings.js";
import { fileForMovie, movieSubtitles } from "./core/movieTitle.js";
import { seriesForMovie } from "./franchise.js";

const VIDEO = /\.(mkv|mp4|m4v|avi|ts|webm)$/i;
const MAX_NAME_BYTES = 250;
const PART = ".animearr-part";

export interface PlanItem {
  source: string; // local path
  dest: string; // local path
  destArr: string; // the *arr/library path
  episodeIds: number[];
  label: string;
  action: "hardlink" | "copy" | "move";
  sidecars: { source: string; dest: string }[];
  replaces: string | null; // local path of the file it replaces (goes to the recycle bin)
  problem: string | null; // set → this item is skipped
}
export interface ImportPlan { tvdbId: number; seriesTitle: string; folder: string; items: PlanItem[]; notes: string[] }

const err = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });

export const namingOptions = (): NamingOptions => {
  const m = getSettings().media;
  return { replaceIllegalCharacters: m.replaceIllegalCharacters, colonReplacement: m.colonReplacement, multiEpisodeStyle: m.multiEpisodeStyle };
};

/** Sonarr-style quality name from a release name / probe ("WEBDL-1080p", "Bluray-1080p Remux"). */
export const qualityName = (release: string, height: number | null) => sonarrQualityName(release, height);

type Probe = Pick<MediaRecord, "video" | "audio" | "subs">;
const mediaInfoOf = (rec: Probe | null) =>
  rec
    ? {
        videoCodec: rec.video?.codec ?? null,
        videoBitDepth: rec.video?.bitDepth ?? null,
        videoDynamicRange: rec.video?.hdr ? "HDR" : null,
        audioCodec: rec.audio[0]?.codec ?? null,
        audioChannels: rec.audio[0]?.channels ?? null,
        audioLanguages: [...new Set(rec.audio.map((a) => a.lang).filter((l): l is string => !!l))],
        subtitleLanguages: [...new Set(rec.subs.filter((s) => !s.partial).map((s) => s.lang).filter((l): l is string => !!l))],
      }
    : undefined;

interface Ep { id: number; season: number; episode: number; absolute: number | null; title: string | null; air_date: string | null; file_id: number | null }
interface SeriesRow { id: number; title: string; year: number | null; path: string; series_type: string; season_folder: number | null }

const seriesRow = (tvdbId: number) => cache.prepare("SELECT id, title, year, path, series_type, season_folder FROM series WHERE tvdb_id = ?").get(tvdbId) as SeriesRow | undefined;

/** Sonarr's "season folder" flag; before the first sync that has it, inferred from where the show's files are. */
function usesSeasonFolders(s: SeriesRow) {
  if (s.season_folder !== null) return s.season_folder === 1;
  const files = cache.prepare("SELECT path FROM files WHERE series_id = ? LIMIT 50").all(s.id) as { path: string }[];
  if (!files.length) return true;
  const base = s.path.replace(/\/+$/, "");
  return files.some((f) => f.path.slice(base.length + 1).includes("/"));
}

/**
 * The library path (Sonarr's view) for an episode file, from the naming settings. Throws when the settings render an
 * empty name or folder. Long names are cut in the episode title (like Sonarr) to stay within the file-name limit.
 */
export function episodeDestination(tvdbId: number, eps: Ep[], ctx: { release: string; ext: string; probe: Probe | null; quality?: string | null; originalName?: string }) {
  const s = seriesRow(tvdbId);
  if (!s) throw err("Unknown series", 404);
  const m = getSettings().media;
  const opts = namingOptions();
  const lookup = catalogLookup(tvdbId);
  const season = eps[0].season;
  const fmt = s.series_type === "anime" ? m.animeEpisodeFormat : s.series_type === "daily" ? m.dailyEpisodeFormat : m.standardEpisodeFormat;
  const parsed = parseRelease(ctx.release);
  const titles = eps.map((e) => (e.title && !/^TBA$/i.test(e.title) ? e.title : (lookup(e.season, e.episode, e.absolute)?.title ?? e.title)));
  const nameWith = (cut: number | null) =>
    renderEpisode(
      fmt,
      {
        seriesTitle: s.title,
        seriesYear: s.year,
        season,
        episodes: eps.map((e, i) => ({ episode: e.episode, absolute: e.absolute, title: cut === null || !titles[i] ? titles[i] : titles[i]!.slice(0, cut).trimEnd() + "…", airDate: e.air_date })),
        quality: ctx.quality || qualityName(ctx.release, ctx.probe?.video?.height ?? null),
        mediaInfo: mediaInfoOf(ctx.probe),
        releaseGroup: parsed.group,
        originalTitle: ctx.release,
        keepTag: keepTagFor(tvdbId, season),
      },
      opts,
    );
  let name = m.renameEpisodes ? nameWith(null) : (ctx.originalName ?? ctx.release);
  for (let cut = 60; m.renameEpisodes && Buffer.byteLength(name + ctx.ext) > MAX_NAME_BYTES && cut >= 0; cut -= 10) name = nameWith(cut);
  if (!name.trim() || name.startsWith(".")) throw err("the naming settings give an empty file name");
  if (Buffer.byteLength(name + ctx.ext) > MAX_NAME_BYTES) throw err("the file name would be too long");
  let folder = "";
  if (usesSeasonFolders(s)) {
    folder = season === 0 ? renderSeasonFolder(m.specialsFolderFormat, 0, opts) : renderSeasonFolder(m.seasonFolderFormat, season, opts);
    if (!folder.trim() || /^\.+$/.test(folder)) throw err("the naming settings give an empty season folder");
  }
  // Creditless OP/ED as Plex extras: the show's "Other" folder, named after the special (Plex lists them as extras).
  if (season === 0 && (m.creditlessAs ?? "s00") === "extras" && eps.every((e) => isCreditlessTitle(e.title))) {
    const title = (titles[0] ?? `S00E${String(eps[0].episode).padStart(2, "0")}`).replace(/[\\/:*?"<>|]/g, " ").trim();
    return `${s.path.replace(/\/+$/, "")}/Other/${title} (S00E${String(eps[0].episode).padStart(2, "0")})-other${ctx.ext}`;
  }
  return `${s.path.replace(/\/+$/, "")}/${folder ? `${folder}/` : ""}${name}${ctx.ext}`;
}

/** Sidecar subtitles next to a video (same base name, optionally a language/flag part like ".en.forced"). */
function sidecarsFor(localVideo: string, listing?: Map<string, string[]>) {
  const dir = path.dirname(localVideo);
  const base = path.basename(localVideo).replace(/\.[^.]+$/, "");
  const exts = getSettings().media.extraFileExtensions.split(",").map((x) => x.trim().toLowerCase().replace(/^\./, "")).filter(Boolean);
  let names = listing?.get(dir);
  if (!names) {
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    listing?.set(dir, names);
  }
  return names
    .filter((f) => f.startsWith(`${base}.`) && exts.includes(path.extname(f).slice(1).toLowerCase()))
    .map((f) => ({ file: path.join(dir, f), suffix: f.slice(base.length) }))
    .filter((x) => /^(\.(?!\d+\.)[^.]{1,20})*\.[^.]+$/.test(x.suffix)); // "Show - 01.5.ass" isn't a sidecar of "Show - 01.mkv"
}

const under = (p: string, root: string) => {
  const a = path.resolve(p);
  const r = path.resolve(root);
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
};

/** Where an import may NOT come from: the library, the recycle bin, AnimeArr's own config. */
function forbiddenSource(real: string) {
  const s = getSettings();
  const roots = [...s.allowedRoots, ...libraryRoots()].map(mappedPath);
  if (s.media.recycleBin) roots.push(mappedPath(s.media.recycleBin.replace(/\/+$/, "")));
  roots.push(CONFIG_DIR);
  return roots.some((r) => {
    try {
      return under(real, fs.existsSync(r) ? fs.realpathSync(r) : r);
    } catch {
      return under(real, r);
    }
  });
}

/** Automatic imports: the source must be inside one of AnimeArr's own category folders (never Sonarr's/Radarr's/others). */
export function inSourceRoots(real: string) {
  return (getSettings().importer.sourceRoots ?? []).some((r) => {
    const local = mappedPath(r.replace(/\/+$/, ""));
    try {
      return under(real, fs.existsSync(local) ? fs.realpathSync(local) : local);
    } catch {
      return false;
    }
  });
}

/**
 * A download AnimeArr itself grabbed (its own grab record and client job): trusted wherever the client saved it
 * (any mount name), except inside the library, the bin or AnimeArr's own folder. `trusted` is that job's payload path.
 */
export function trustedSource(real: string, trusted: string | null | undefined) {
  if (!trusted) return false;
  const local = localPath(trusted);
  if (!local) return false;
  try {
    const t = fs.realpathSync(local);
    // AnimeArr's own grab, wherever its client saved it: never the library, the bin or AnimeArr's own folder.
    return !forbiddenSource(t) && under(real, t);
  } catch {
    return false;
  }
}

/** Video files in a download folder, with sizes (for native shows, which have no Sonarr to list them). */
export function listVideos(dir: string) {
  return videosIn(dir, 0).map((f) => ({ path: f, size: fs.statSync(f).size }));
}

/** Video files in a folder: no symlinks, no samples, at most 4 levels and 2000 entries (never the whole disk). */
function videosIn(dir: string, minBytes: number) {
  const out: string[] = [];
  let seen = 0;
  const walk = (d: string, depth: number) => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      if (++seen > 2000) return;
      const f = path.join(d, n);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(f);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (depth < 4) walk(f, depth + 1);
      } else if (st.isFile() && VIDEO.test(n) && !/\bsample\b/i.test(path.relative(dir, f)) && st.size >= minBytes) out.push(f);
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * Plans an import of a folder (or single file) for a show: which file is which episode (explicit ids when given, else
 * identified from the names), where it goes, how, and what it replaces. Nothing is changed.
 */
export async function planImport(input: { tvdbId: number; path: string; episodeIds?: number[]; release?: string; client?: string | null; automatic?: boolean; trusted?: string | null }, deps: { probe: typeof probeFile; minBytes?: number } = { probe: probeFile }): Promise<ImportPlan> {
  const series = seriesByTvdb(input.tvdbId);
  if (!series) throw err("Unknown series", 404);
  const minBytes = deps.minBytes ?? 30e6;
  const m = getSettings().media;
  const notes: string[] = [];
  if (!underAllowedRoot(series.path)) notes.push(`${series.title} is outside the allowed root folders: nothing will be imported`);
  const local = localPath(input.path);
  if (!local) throw err(`AnimeArr can't reach ${input.path} (Settings → Paths)`);
  let real: string;
  let st: fs.Stats;
  try {
    real = fs.realpathSync(local);
    st = fs.statSync(real);
  } catch {
    throw err(`AnimeArr can't read ${input.path}`);
  }
  if (forbiddenSource(real)) throw err("Imports come from download folders, not from the library, the recycling bin or AnimeArr's own folder");
  if (input.automatic && !inSourceRoots(real) && !trustedSource(real, input.trusted)) throw err(`${input.path} isn't in AnimeArr's own download folders (${getSettings().importer.sourceRoots.join(", ")}); only a manual import can take it`);
  let files: string[];
  if (st.isDirectory()) files = videosIn(real, minBytes);
  else {
    if (!VIDEO.test(real)) throw err("That isn't a video file");
    if (st.size < minBytes) throw err("That file is too small to be an episode (a sample?)");
    files = [real];
  }
  const eps = cache.prepare("SELECT e.id, e.season, e.episode, e.absolute, e.title, e.air_date, e.file_id FROM episodes e JOIN series s ON s.id = e.series_id WHERE s.tvdb_id = ?").all(input.tvdbId) as unknown as Ep[];
  const byId = new Map(eps.map((e) => [e.id, e]));
  const ctx = identifyContext();
  const minConf = getSettings().managed.minConfidence;
  const torrent = isTorrentClient(input.client);
  const binSet = !!m.recycleBin.trim();
  const items: PlanItem[] = [];
  const taken = new Set<string>();
  for (const f of files) {
    let ids: number[] = [];
    if (files.length === 1 && input.episodeIds?.length) ids = input.episodeIds;
    else {
      const id = identify(path.basename(f), ctx, { tvdbId: input.tvdbId });
      if (id.resolution?.ok && id.resolution.confidence >= minConf) ids = id.resolution.episodes.map((e) => e.id).filter((x) => !input.episodeIds || input.episodeIds.includes(x));
    }
    const list = ids.map((i) => byId.get(i)).filter((x): x is Ep => !!x).sort((a, b) => a.season - b.season || a.episode - b.episode);
    const label = list.map((e) => `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}`).join("+") || path.basename(f);
    const base: PlanItem = { source: f, dest: "", destArr: "", episodeIds: list.map((e) => e.id), label, action: torrent ? (m.useHardlinks ? "hardlink" : "copy") : "move", sidecars: [], replaces: null, problem: null };
    if (!list.length || list.length !== ids.length) {
      items.push({ ...base, problem: ids.length ? "those episodes aren't in this show" : "couldn't tell which episode this is" });
      continue;
    }
    if (m.episodeTitleRequired === "always" && list.some((e) => (!e.title || /^TBA$/i.test(e.title)) && !catalogLookup(input.tvdbId)(e.season, e.episode, e.absolute)?.title)) {
      items.push({ ...base, problem: "the episode title isn't known yet (Episode Title Required: always)" });
      continue;
    }
    let probe: Probe | null = null;
    try {
      probe = await deps.probe(f);
    } catch {
      probe = null;
    }
    let destArr: string;
    try {
      destArr = episodeDestination(input.tvdbId, list, { release: input.release ?? path.basename(f).replace(/\.[^.]+$/, ""), ext: path.extname(f).toLowerCase(), probe, originalName: path.basename(f).replace(/\.[^.]+$/, "") });
    } catch (e) {
      items.push({ ...base, problem: (e as Error).message });
      continue;
    }
    const dest = mappedPath(destArr);
    // The file this replaces (the episodes' current one), and collisions with anything else.
    const fileIds = [...new Set(list.map((e) => e.file_id).filter((x): x is number => !!x))];
    const others = fileIds.length ? (cache.prepare(`SELECT COUNT(*) AS n FROM episodes WHERE file_id IN (${fileIds.map(() => "?").join(",")}) AND id NOT IN (${list.map(() => "?").join(",")})`).get(...fileIds, ...list.map((e) => e.id)) as { n: number }).n : 0;
    const current = fileIds.length === 1 ? (cache.prepare("SELECT path FROM files WHERE id = ?").get(fileIds[0]) as { path: string } | undefined)?.path ?? null : null;
    const currentLocal = current ? localPath(current) : null;
    const size = fs.statSync(f).size;
    let problem: string | null = null;
    if (!underAllowedRoot(series.path)) problem = "outside the allowed root folders";
    else if (fileIds.length > 1) problem = "these episodes are in separate files now: import this one by hand";
    else if (others) problem = "the current file also holds other episodes: import this one by hand";
    else if (current && !currentLocal) problem = "AnimeArr can't reach the episode's current file, so it can't replace it";
    else if (currentLocal && !binSet) problem = "no recycling bin is set, so the current file can't be replaced safely";
    else if (taken.has(dest)) problem = "two files would get the same name";
    else if (fs.existsSync(dest) && path.resolve(dest) !== path.resolve(currentLocal ?? "")) problem = `a different file already has that name (${path.basename(dest)}): never overwritten`;
    else if (!freeSpaceOk(dest, size)) problem = `not enough free space at the library (Minimum Free Space ${m.minimumFreeSpaceMb} MB)`;
    taken.add(dest);
    items.push({
      ...base,
      dest,
      destArr,
      sidecars: m.importExtraFiles ? sidecarsFor(f).map((s) => ({ source: s.file, dest: dest.replace(/\.[^.]+$/, "") + s.suffix })) : [],
      replaces: currentLocal,
      problem,
    });
  }
  if (!files.length) notes.push("no video files found");
  return { tvdbId: input.tvdbId, seriesTitle: series.title, folder: input.path, items, notes };
}

/** Minimum Free Space: the library disk keeps that much after the file lands (unless the check is skipped). */
function freeSpaceOk(dest: string, size: number) {
  const m = getSettings().media;
  if (m.skipFreeSpaceCheck) return true;
  let dir = path.dirname(dest);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize - size > m.minimumFreeSpaceMb * 1024 * 1024;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------- file operations that never overwrite

/** Renames a → b; fails if b exists (link + unlink; exclusive copy across disks). */
export function moveNoClobber(a: string, b: string) {
  fs.mkdirSync(path.dirname(b), { recursive: true });
  try {
    fs.linkSync(a, b); // EEXIST if b exists: never overwritten
    fs.unlinkSync(a);
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new Error(`${path.basename(b)} already exists: not overwritten`);
    if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw e;
  }
  copyNoClobber(a, b);
  fs.unlinkSync(a);
}

/** Copies a → b; fails if b exists; a failed copy leaves nothing behind. */
function copyNoClobber(a: string, b: string) {
  fs.mkdirSync(path.dirname(b), { recursive: true });
  try {
    fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${path.basename(b)} already exists: not overwritten`);
    fs.rmSync(b, { force: true }); // ours: COPYFILE_EXCL created it
    throw e;
  }
}

/** Places a file; returns what was actually done (a hardlink across disks becomes a copy). */
function placeFile(action: PlanItem["action"], a: string, b: string): PlanItem["action"] {
  fs.mkdirSync(path.dirname(b), { recursive: true });
  if (action === "move") {
    moveNoClobber(a, b);
    return "move";
  }
  if (action === "hardlink") {
    try {
      fs.linkSync(a, b);
      return "hardlink";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${path.basename(b)} already exists: not overwritten`);
    }
  }
  copyNoClobber(a, b);
  return "copy";
}

/**
 * Moves a file (and its sidecars) into the recycle bin, keeping its show folder. Refuses when no bin is set (never
 * deletes). Returns where each file went, so it can be put back.
 */
export function recycle(localFile: string, seriesLocal: string) {
  const bin = getSettings().media.recycleBin.trim();
  if (!bin) throw new Error("no recycling bin is set; nothing was replaced");
  const binLocal = mappedPath(bin.replace(/\/+$/, ""));
  let rel = path.relative(path.dirname(seriesLocal), localFile);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) rel = path.basename(localFile);
  const moved: { from: string; to: string }[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const f of [localFile, ...sidecarsFor(localFile).map((s) => s.file)]) {
    const r = f === localFile ? rel : path.join(path.dirname(rel), path.basename(f));
    let target = path.join(binLocal, r);
    if (fs.existsSync(target)) target = target.replace(/(\.[^.]+)$/, `.${stamp}$1`);
    moveNoClobber(f, target);
    try {
      noteBinned(target, fs.statSync(target).size); // the bin's retention counts from now
    } catch {
      /* bookkeeping only */
    }
    moved.push({ from: f, to: target });
  }
  return moved;
}

function setPerms(dir: string) {
  const m = getSettings().media;
  if (!m.setPermissions) return;
  try {
    if (/^[0-7]{3,4}$/.test(m.chmodFolder)) fs.chmodSync(dir, parseInt(m.chmodFolder, 8));
    if (/^\d+$/.test(m.chownGroup)) fs.chownSync(dir, process.getuid?.() ?? -1, Number(m.chownGroup));
  } catch {
    /* not ours to change */
  }
}

/**
 * Carries out the plan's good items. Refused unless real imports were switched on (importer.allowReal), except when
 * `dryRun` (then it only reports). Order per item: new file in place under a temporary name → old file (and its
 * sidecars) to the bin → temporary name → final name; if the last step fails the old file comes back.
 */
export async function executeImport(plan: ImportPlan, opts: { dryRun?: boolean; only?: string[]; grabId?: number } = {}) {
  const series = seriesRow(plan.tvdbId);
  if (!series) throw err("Unknown series", 404);
  return placeItems(plan.items, {
    arrRoot: series.path,
    title: series.title,
    tvdbId: plan.tvdbId,
    after: async () => {
      if (!isNativeSeriesId(series.id)) await sonarr.rescanSeries(series.id).catch(() => undefined); // Sonarr re-reads the folder while it's still in use
      await scanFolder(series.path).catch(() => undefined);
      if (isNativeSeriesId(series.id)) rematerializeSeries(series.id);
      await afterLibraryChange({ tvdbId: plan.tvdbId, folders: [...new Set(plan.items.filter((i) => !i.problem && i.destArr).map((i) => path.posix.dirname(i.destArr)))] });
    },
  }, opts);
}

/** Which episodes a file AnimeArr imported holds (so a native show never has to guess from the name). */
export const fileLink = (arrPath: string) => {
  const r = db.prepare("SELECT episode_ids FROM file_links WHERE path = ?").get(arrPath) as { episode_ids: string } | undefined;
  return r ? (JSON.parse(r.episode_ids) as number[]) : null;
};

/** Temporary files this process is writing right now. */
const inFlight = new Set<string>();

/**
 * A "*.animearr-part" left behind by an import that was cut off (AnimeArr restarted mid-copy): it's AnimeArr's own
 * temporary file and nobody is writing it (the caller holds the in-flight mark for it), so it goes before the retry. Only while the
 * source still exists: if the source is gone, the part may be the only copy, and it stays for a look.
 */
export function clearStalePart(tmp: string, source: string) {
  if (!tmp.endsWith(PART) || !fs.existsSync(tmp) || !fs.existsSync(source)) return false;
  const st = fs.lstatSync(tmp);
  if (!st.isFile()) return false;
  fs.rmSync(tmp, { force: true });
  logDecision("info", { why: `Removed ${path.basename(tmp)}, left behind by an import that was cut off; importing it again` });
  return true;
}

/**
 * The shared placement for episodes and movies. Refused unless real imports were switched on (importer.allowReal and
 * the real-import budget), except when `dryRun` (then it only reports). Order per item: new file in place under a
 * temporary name → old file (and its sidecars) to the bin → temporary name → final name; if the last step fails the old
 * file comes back.
 */
async function placeItems(items: PlanItem[], target: { arrRoot: string; title: string; tvdbId?: number; movieId?: number; after: () => Promise<void> }, opts: { dryRun?: boolean; only?: string[]; grabId?: number }) {
  const real = !opts.dryRun;
  if (real && !getSettings().importer.allowReal) throw err("Real imports by AnimeArr's own importer aren't switched on yet (the first plan is being reviewed)", 409);
  if (real && (getSettings().importer.realBudget ?? 0) === 0) throw err("AnimeArr's importer is paused for a review of its last real import (Settings → Media management → Importer)", 409);
  const rootLocal = mappedPath(target.arrRoot);
  const out: { label: string; done: boolean; why: string }[] = [];
  for (const it of items) {
    if (opts.only && !opts.only.includes(it.source)) continue;
    if (it.problem) {
      out.push({ label: it.label, done: false, why: it.problem });
      continue;
    }
    if (!real) {
      out.push({ label: it.label, done: false, why: `would ${it.action} ${path.basename(it.source)} → ${it.destArr}${it.replaces ? " (the old file goes to the recycling bin)" : ""}` });
      continue;
    }
    // Defence in depth: the plan is re-checked here.
    if (!getSettings().importer.allowReal || (getSettings().importer.realBudget ?? 0) === 0 || !underAllowedRoot(target.arrRoot) || !under(it.dest, rootLocal)) {
      out.push({ label: it.label, done: false, why: "refused: outside the allowed root folders or real imports are off" });
      continue;
    }
    const tmp = it.dest + PART;
    let binned: { from: string; to: string }[] = [];
    let did: PlanItem["action"] | null = null;
    if (inFlight.has(tmp)) {
      out.push({ label: it.label, done: false, why: "this file is being imported right now" });
      continue;
    }
    inFlight.add(tmp);
    try {
      if (fs.existsSync(it.dest) && path.resolve(it.dest) !== path.resolve(it.replaces ?? "")) throw new Error("a file with that name appeared meanwhile: not overwritten");
      clearStalePart(tmp, it.source);
      did = placeFile(it.action, it.source, tmp);
      if (it.replaces && fs.existsSync(it.replaces)) binned = recycle(it.replaces, rootLocal);
      try {
        moveNoClobber(tmp, it.dest);
      } catch (e) {
        for (const b of binned.reverse()) {
          try {
            moveNoClobber(b.to, b.from);
          } catch {
            /* reported below */
          }
        }
        binned = [];
        throw e;
      }
      for (const s of it.sidecars) {
        try {
          placeFile(it.action === "move" ? "move" : "copy", s.source, s.dest);
        } catch {
          /* a subtitle that can't be placed doesn't undo the video */
        }
      }
      // Placed: the budget counts it whatever happens next; bookkeeping can't turn it into a failure.
      if ((getSettings().importer.realBudget ?? 0) > 0) patchSettings((x) => ({ ...x, importer: { ...x.importer, realBudget: x.importer.realBudget - 1 } }));
      const verb = did === "move" ? "moved" : did === "hardlink" ? "hardlinked" : "copied";
      out.push({ label: it.label, done: true, why: `${verb} to ${it.destArr}${binned.length ? "; the old file is in the recycling bin" : ""}` });
      try {
        setPerms(path.dirname(it.dest));
        if (it.episodeIds.length) db.prepare("INSERT OR REPLACE INTO file_links (path, tvdb_id, episode_ids, at) VALUES (?, ?, ?, ?)").run(it.destArr, target.tvdbId ?? null, JSON.stringify(it.episodeIds), Date.now());
      } catch {
        /* bookkeeping only */
      }
      logDecision("import", { tvdbId: target.tvdbId ?? null, title: target.title, episodeIds: it.episodeIds, why: `Imported ${it.label} → ${it.destArr} (AnimeArr's importer, ${verb})${binned.length ? `; replaced file moved to ${binned[0].to}` : ""}`, detail: { ...(target.movieId ? { movieId: target.movieId } : {}), ...(opts.grabId ? { grabId: opts.grabId } : {}) } }); // a grab's import notifies once, at the end
    } catch (e) {
      // Nothing half-done stays: the temporary file goes (a moved source goes back first).
      if (did && fs.existsSync(tmp)) {
        try {
          if (did === "move") moveNoClobber(tmp, it.source);
          else fs.rmSync(tmp, { force: true });
        } catch {
          /* left as *.animearr-part for a look */
        }
      }
      out.push({ label: it.label, done: false, why: (e as Error).message });
    } finally {
      inFlight.delete(tmp);
    }
  }
  if (real && out.some((x) => x.done)) await target.after();
  return out;
}

// ---------------------------------------------------------------- movies

export interface MoviePlan { movieId: number; title: string; items: PlanItem[]; notes: string[] }

/** Plans a movie import: the biggest video is the movie (two big ones = ask), named with the movie format. */
export async function planMovieImport(input: { movieId: number; path: string; release?: string; client?: string | null; automatic?: boolean; trusted?: string | null; live?: { path: string; currentFile: string | null }; part?: number }, deps: { probe: typeof probeFile; minBytes?: number } = { probe: probeFile }): Promise<MoviePlan> {
  const mv = cache.prepare("SELECT id, tmdb_id, imdb_id, title, original_title, alt_titles, year, path, file FROM movies WHERE id = ?").get(input.movieId) as { id: number; tmdb_id: number | null; imdb_id: string | null; title: string; original_title: string | null; alt_titles: string | null; year: number | null; path: string; file: string | null } | undefined;
  if (!mv) throw err("Unknown movie", 404);
  const m = getSettings().media;
  const notes: string[] = [];
  const local = localPath(input.path);
  if (!local) throw err(`AnimeArr can't reach ${input.path} (Settings → Paths)`);
  let real: string;
  let st: fs.Stats;
  try {
    real = fs.realpathSync(local);
    st = fs.statSync(real);
  } catch {
    throw err(`AnimeArr can't read ${input.path}`);
  }
  if (forbiddenSource(real)) throw err("Imports come from download folders, not from the library, the recycling bin or AnimeArr's own folder");
  if (input.automatic && !inSourceRoots(real) && !trustedSource(real, input.trusted)) throw err(`${input.path} isn't in AnimeArr's own download folders (${getSettings().importer.sourceRoots.join(", ")}); only a manual import can take it`);
  const minBytes = deps.minBytes ?? 100e6;
  const files = st.isDirectory() ? videosIn(real, minBytes) : VIDEO.test(real) && st.size >= minBytes ? [real] : [];
  const label = mv.year ? `${mv.title} (${mv.year})` : mv.title;
  if (!files.length) return { movieId: mv.id, title: label, items: [], notes: ["no video files found"] };
  const bySize = files.map((f) => ({ f, path: f, size: fs.statSync(f).size })).sort((a, b) => b.size - a.size);
  // A batch that bundles the movie/special: the file whose name carries the movie's subtitle ("… - OVA - Date to Date").
  let alt: string[] = [];
  try {
    alt = JSON.parse(mv.alt_titles ?? "[]") as string[];
  } catch {
    alt = [];
  }
  const named = bySize.length > 1 ? fileForMovie(bySize, movieSubtitles([mv.title, mv.original_title ?? "", ...alt], seriesForMovie(mv.id).map((x) => x.title))) : null;
  if (named) notes.push(`picked ${path.basename(named.f)} (its name matches the movie); the other ${bySize.length - 1} video file${bySize.length - 1 === 1 ? "" : "s"} are left alone`);
  const main = named ?? bySize[0];
  const base: PlanItem = { source: main.f, dest: "", destArr: "", episodeIds: [], label, action: isTorrentClient(input.client) ? (m.useHardlinks ? "hardlink" : "copy") : "move", sidecars: [], replaces: null, problem: null };
  if (!named && bySize[1] && bySize[1].size > main.size * 0.4) return { movieId: mv.id, title: label, items: [{ ...base, problem: `several large video files (${bySize.slice(0, 3).map((x) => path.basename(x.f)).join(", ")}): import the right one by hand, or as parts` }], notes };
  let probe: Probe | null = null;
  try {
    probe = await deps.probe(main.f);
  } catch {
    probe = null;
  }
  const release = input.release ?? path.basename(main.f).replace(/\.[^.]+$/, "");
  const ext = path.extname(main.f).toLowerCase();
  const opts = namingOptions();
  const name0 = m.renameMovies
    ? renderMovie(m.movieFormat, { movieTitle: mv.title, year: mv.year, quality: qualityName(release, probe?.video?.height ?? null), mediaInfo: mediaInfoOf(probe), releaseGroup: parseRelease(release).group, imdbId: mv.imdb_id, tmdbId: mv.tmdb_id, originalTitle: release }, { ...opts, colonReplacement: m.movieColonReplacement ?? opts.colonReplacement })
    : path.basename(main.f).replace(/\.[^.]+$/, "");
  // One part of a multi-part movie: Plex's stacking names ("<Movie> (Year) - pt1.mkv", "- pt2.mkv").
  const name = input.part ? `${name0} - pt${input.part}` : name0;
  let problem: string | null = null;
  if (!name.trim() || name.startsWith(".")) problem = "the movie format gives an empty file name";
  else if (Buffer.byteLength(name + ext) > MAX_NAME_BYTES) problem = "the file name would be too long";
  // Radarr's live view wins over the cache (the movie may have moved, or gained a file).
  if (input.live) {
    mv.path = input.live.path;
    mv.file = input.live.currentFile ? JSON.stringify({ path: input.live.currentFile }) : null;
  }
  const destArr = `${mv.path.replace(/\/+$/, "")}/${name}${ext}`;
  const dest = mappedPath(destArr);
  const currentArr = mv.file ? ((JSON.parse(mv.file) as { path: string | null }).path ?? null) : null;
  const currentLocal = currentArr ? localPath(currentArr) : null;
  if (problem) {
    /* keep the first problem */
  } else if (!underAllowedRoot(mv.path)) problem = "outside the allowed root folders";
  else if (currentArr && !currentLocal) problem = "AnimeArr can't reach the movie's current file, so it can't replace it";
  else if (currentLocal && input.part) problem = "the movie already has a file: replacing it with a multi-part release is done by hand";
  else if (currentLocal && !m.recycleBin.trim()) problem = "no recycling bin is set, so the current file can't be replaced safely";
  else if (fs.existsSync(dest) && path.resolve(dest) !== path.resolve(currentLocal ?? "")) problem = `a different file already has that name (${path.basename(dest)}): never overwritten`;
  else if (!freeSpaceOk(dest, main.size)) problem = `not enough free space at the library (Minimum Free Space ${m.minimumFreeSpaceMb} MB)`;
  return {
    movieId: mv.id,
    title: label,
    items: [{ ...base, dest, destArr, sidecars: m.importExtraFiles ? sidecarsFor(main.f).map((s) => ({ source: s.file, dest: dest.replace(/\.[^.]+$/, "") + s.suffix })) : [], replaces: currentLocal, problem }],
    notes,
  };
}

export async function executeMovieImport(plan: MoviePlan, opts: { dryRun?: boolean; grabId?: number } = {}) {
  if (!opts.dryRun && !getSettings().importer.movies) throw err("Movie imports by AnimeArr's own importer aren't switched on yet (the first movie plan is being reviewed)", 409);
  const mv = cache.prepare("SELECT id, path, title FROM movies WHERE id = ?").get(plan.movieId) as { id: number; path: string; title: string } | undefined;
  if (!mv) throw err("Unknown movie", 404);
  return placeItems(plan.items, {
    arrRoot: mv.path,
    title: plan.title,
    movieId: mv.id,
    after: async () => {
      if (!isNativeMovieId(mv.id)) await radarr.rescanMovie(mv.id).catch(() => undefined);
      await scanFolder(mv.path).catch(() => undefined);
      if (isNativeMovieId(mv.id)) rematerializeMovie(mv.id);
      await afterLibraryChange({ folders: [mv.path] });
    },
  }, opts);
}

// ---------------------------------------------------------------- rename existing files

export interface RenameItem { fileId: number; from: string; to: string; episodes: string; problem: string | null; sidecars: { from: string; to: string }[] }

/** Sonarr's {Quality Full}: the name, then v2 (anime) / Proper / Repack, then REAL. */
export function qualityFull(name: string, rev: { version?: number; real?: number; isRepack?: boolean }, seriesType: string) {
  const v = rev.version ?? 1;
  const proper = v > 1 ? (seriesType === "anime" ? `v${v}` : rev.isRepack ? "Repack" : "Proper") : "";
  return [name, proper, (rev.real ?? 0) > 0 ? "REAL" : ""].filter(Boolean).join(" ");
}

const BIT_DEPTH = /\{[^{}]*mediainfo[ ._]videobitdepth[^{}]*\}/i;

/** The series' files whose names differ from the naming settings (old → new). Empty when renaming is off. */
export function planRename(tvdbId: number): { items: RenameItem[] } {
  const s = seriesRow(tvdbId);
  if (!s) throw err("Unknown series", 404);
  const m = getSettings().media;
  if (!m.renameEpisodes) return { items: [] };
  const fmt = s.series_type === "anime" ? m.animeEpisodeFormat : s.series_type === "daily" ? m.dailyEpisodeFormat : m.standardEpisodeFormat;
  const files = cache.prepare("SELECT id, path, scene_name, quality, revision FROM files WHERE series_id = ?").all(s.id) as { id: number; path: string; scene_name: string | null; quality: string | null; revision: string | null }[];
  const items: RenameItem[] = [];
  const taken = new Set<string>();
  const listing = new Map<string, string[]>();
  for (const f of files) {
    const eps = cache.prepare("SELECT id, season, episode, absolute, title, air_date, file_id FROM episodes WHERE file_id = ? ORDER BY season, episode").all(f.id) as unknown as Ep[];
    if (!eps.length) continue;
    const rec = (db.prepare("SELECT video, audio, subs FROM media_files WHERE path = ?").get(f.path) as { video: string; audio: string; subs: string } | undefined) ?? null;
    const probe: Probe | null = rec ? { video: JSON.parse(rec.video), audio: JSON.parse(rec.audio), subs: JSON.parse(rec.subs) } : null;
    let to: string;
    try {
      if (!f.revision || !f.quality) throw new Error("waiting for the show's next sync from Sonarr (quality details)");
      to = episodeDestination(tvdbId, eps, { release: f.scene_name ?? path.posix.basename(f.path).replace(/\.[^.]+$/, ""), ext: path.posix.extname(f.path), probe, quality: qualityFull(f.quality, JSON.parse(f.revision), s.series_type) });
    } catch (e) {
      items.push({ fileId: f.id, from: f.path, to: f.path, episodes: "", problem: (e as Error).message, sidecars: [] });
      continue;
    }
    if (to === f.path) continue;
    const local = localPath(f.path);
    const toLocal = mappedPath(to);
    let problem: string | null = null;
    if (!underAllowedRoot(s.path)) problem = "outside the allowed root folders";
    else if (!local) problem = "AnimeArr can't reach this file";
    else if (!probe || (BIT_DEPTH.test(fmt) && !probe.video?.bitDepth)) problem = "the file's details aren't scanned yet (Refresh & scan first)";
    else if (taken.has(to)) problem = "two files would get the same name";
    else if (fs.existsSync(toLocal)) problem = "a file with the new name already exists: never overwritten";
    taken.add(to);
    const side = local ? sidecarsFor(local, listing).map((x) => ({ from: x.file, to: toLocal.replace(/\.[^.]+$/, "") + x.suffix })) : [];
    items.push({ fileId: f.id, from: f.path, to, episodes: eps.map((e) => `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}`).join("+"), problem, sidecars: side });
  }
  return { items };
}

export type RenameRoute = "sonarr" | "animearr";

/**
 * Who renames a show's files: Sonarr (its RenameFiles command) while Sonarr still owns the show, so its file records
 * and history stay intact; AnimeArr's own renamer after cutover or for AnimeArr-native shows.
 */
export function renameRoute(tvdbId: number, deps = { sonarrOn: sonarr.sonarrConfigured }): RenameRoute {
  const s = seriesRow(tvdbId);
  return s && !isNativeSeriesId(s.id) && deps.sonarrOn() ? "sonarr" : "animearr";
}

/** The rename preview by route: Sonarr's own preview, or AnimeArr's plan. */
export async function renamePlan(tvdbId: number, deps = { sonarrOn: sonarr.sonarrConfigured, preview: sonarr.renamePreview }): Promise<{ route: RenameRoute; items: RenameItem[] }> {
  const route = renameRoute(tvdbId, deps);
  if (route === "animearr") return { route, items: planRename(tvdbId).items };
  const s = seriesRow(tvdbId)!;
  if (!getSettings().media.renameEpisodes) return { route, items: [] };
  const base = s.path.replace(/\/+$/, "");
  const items = (await deps.preview(s.id)).map((x) => ({
    fileId: x.episodeFileId,
    from: `${base}/${x.existingPath}`,
    to: `${base}/${x.newPath}`,
    episodes: x.episodeNumbers.map((e) => `S${String(x.seasonNumber).padStart(2, "0")}E${String(e).padStart(2, "0")}`).join("+"),
    problem: underAllowedRoot(s.path) ? null : "outside the allowed root folders",
    sidecars: [],
  }));
  return { route, items };
}

/** Renames the chosen files by route. Through Sonarr: its RenameFiles command (no undo; Sonarr keeps its records). */
export async function applyRenameRouted(tvdbId: number, fileIds: number[], deps = { sonarrOn: sonarr.sonarrConfigured, preview: sonarr.renamePreview, renameFiles: sonarr.renameFiles, getCommand: sonarr.getCommand, sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) }) {
  const route = renameRoute(tvdbId, deps);
  if (route === "animearr") return { route, results: await applyRename(tvdbId, fileIds) };
  if (!getSettings().importer.allowRename) throw err("Renaming isn't switched on (Settings → Media management → Importer)", 409);
  const s = seriesRow(tvdbId)!;
  if (!underAllowedRoot(s.path)) throw err("This show is outside the allowed root folders");
  const before = (await renamePlan(tvdbId, deps)).items.filter((i) => fileIds.includes(i.fileId));
  if (!before.length) return { route, results: [] };
  const cmd = await deps.renameFiles(s.id, before.map((i) => i.fileId));
  let status = "queued";
  for (let i = 0; i < 60 && !["completed", "failed", "aborted"].includes(status); i++) {
    await deps.sleep(2000);
    status = (await deps.getCommand(cmd.id)).status;
  }
  const still = new Set((await renamePlan(tvdbId, deps)).items.map((i) => i.fileId));
  const results = before.map((i) => ({ from: i.from, to: i.to, done: status === "completed" && !still.has(i.fileId), why: status === "completed" ? (still.has(i.fileId) ? "Sonarr didn't rename it" : "renamed by Sonarr") : `Sonarr's rename ${status}` }));
  const n = results.filter((r) => r.done).length;
  if (n) logDecision("info", { tvdbId, title: s.title, why: `Sonarr renamed ${n} file${n === 1 ? "" : "s"} of ${s.title} (asked by AnimeArr; Sonarr keeps its file records). ${results.filter((r) => r.done).slice(0, 3).map((r) => path.posix.basename(r.to)).join(", ")}${n > 3 ? "…" : ""}` });
  void scanFolder(s.path).catch(() => undefined);
  return { route, results };
}

/** Renames the chosen files (and their sidecars); every rename is logged with undo. */
export async function applyRename(tvdbId: number, fileIds: number[]) {
  if (!getSettings().importer.allowRename) throw err("Renaming isn't switched on yet (the first rename plan is being reviewed)", 409);
  const s = seriesRow(tvdbId);
  if (!s) throw err("Unknown series", 404);
  if (!underAllowedRoot(s.path)) throw err("This show is outside the allowed root folders");
  const seriesLocal = mappedPath(s.path);
  const plan = planRename(tvdbId).items.filter((i) => fileIds.includes(i.fileId));
  const out: { from: string; to: string; done: boolean; why: string }[] = [];
  for (const it of plan) {
    if (it.problem) {
      out.push({ from: it.from, to: it.to, done: false, why: it.problem });
      continue;
    }
    try {
      const a = localPath(it.from)!;
      const b = mappedPath(it.to);
      if (!under(a, seriesLocal) || !under(b, seriesLocal)) throw new Error("outside the show's folder");
      moveNoClobber(a, b);
      const st = fs.statSync(b);
      const sides: { from: string; to: string }[] = [];
      for (const x of it.sidecars) {
        try {
          moveNoClobber(x.from, x.to);
          sides.push({ from: x.to, to: x.from });
        } catch {
          /* a subtitle that can't be renamed keeps its name */
        }
      }
      out.push({ from: it.from, to: it.to, done: true, why: sides.length < it.sidecars.length ? "renamed (some subtitle files kept their names)" : "renamed" });
      logDecision("info", { tvdbId, title: s.title, why: `Renamed ${path.posix.basename(it.from)} → ${path.posix.basename(it.to)}`, undo: { action: "rename-back", args: { tvdbId, from: b, to: a, size: st.size, mtime: st.mtimeMs, sidecars: sides } } });
    } catch (e) {
      out.push({ from: it.from, to: it.to, done: false, why: (e as Error).message });
    }
  }
  if (out.some((x) => x.done)) {
    if (!isNativeSeriesId(s.id)) await sonarr.rescanSeries(s.id).catch(() => undefined);
    await scanFolder(s.path).catch(() => undefined);
    if (isNativeSeriesId(s.id)) rematerializeSeries(s.id);
    await afterLibraryChange({ tvdbId, folders: [s.path] });
  }
  return out;
}

/** Undo of a rename (from the activity log): only inside the show's folder, only if it's still the same file. */
export async function renameBack(args: { tvdbId?: number; from: string; to: string; size?: number; mtime?: number; sidecars?: { from: string; to: string }[] }) {
  const s = args.tvdbId ? seriesRow(args.tvdbId) : undefined;
  if (!s || !underAllowedRoot(s.path)) throw new Error("this show is no longer in an allowed root folder");
  const root = mappedPath(s.path);
  const all = [args, ...(args.sidecars ?? [])];
  if (all.some((x) => !under(x.from, root) || !under(x.to, root))) throw new Error("outside the show's folder; not renamed back");
  const st = fs.statSync(args.from);
  if (args.size !== undefined && st.size !== args.size) throw new Error("the file changed since the rename; not renamed back");
  moveNoClobber(args.from, args.to);
  for (const x of args.sidecars ?? []) {
    try {
      if (fs.existsSync(x.from)) moveNoClobber(x.from, x.to);
    } catch {
      /* keep going */
    }
  }
  if (!isNativeSeriesId(s.id)) await sonarr.rescanSeries(s.id).catch(() => undefined);
  await scanFolder(s.path).catch(() => undefined);
  if (isNativeSeriesId(s.id)) rematerializeSeries(s.id);
  await afterLibraryChange({ tvdbId: args.tvdbId, folders: [s.path] });
}

// ---------------------------------------------------------------- manual import: browse the download folders

export interface BrowseEntry { name: string; path: string; dir: boolean; size: number; mtime: number; video: boolean; videos: number }
export interface BrowseResult { roots: { path: string; label: string }[]; path: string | null; parent: string | null; entries: BrowseEntry[]; truncated: boolean }

/** Where a manual import may browse: the importer's source roots, plus a grab's own download folder (resolved by the server). */
export function browseRoots(extra: (string | null | undefined)[] = []) {
  const out: { path: string; local: string; label: string; file?: boolean }[] = [];
  const own = getSettings().importer.sourceRoots ?? [];
  for (const [i, raw] of [...own, ...extra].entries()) {
    if (!raw) continue;
    const p = raw.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!p.startsWith("/") || out.some((r) => r.path === p)) continue;
    const local = localPath(p);
    if (!local) continue;
    const fromGrab = i >= own.length;
    let real: string;
    let file = false;
    try {
      real = fs.realpathSync(local);
      const st = fs.statSync(real);
      // A grab's download can be one file (a single-episode torrent): that file alone is browsable, nothing beside it.
      if (fromGrab && st.isFile()) file = true;
      else if (!st.isDirectory()) continue;
      if (forbiddenSource(real)) continue;
    } catch {
      continue;
    }
    out.push({ path: p, local: real, label: fromGrab ? "download" : "source", ...(file ? { file } : {}) });
  }
  return out;
}

/** A folder's size and video count: no symlinks, at most 4 levels and 2000 entries. */
function folderStats(dir: string) {
  let size = 0;
  let videos = 0;
  let seen = 0;
  const walk = (d: string, depth: number) => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      if (++seen > 2000) return;
      const f = path.join(d, n);
      try {
        const st = fs.lstatSync(f);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (depth < 4) walk(f, depth + 1);
        } else if (st.isFile()) {
          size += st.size;
          if (VIDEO.test(n) && !/\bsample\b/i.test(n)) videos++;
        }
      } catch {
        /* skip */
      }
    }
  };
  walk(dir, 0);
  return { size, videos };
}

/**
 * Lists a folder for the manual-import picker. Read-only; only inside the allowed roots (no "..", no symlinks out,
 * never the library/bin/config); newest first; video files flagged. No path = the roots themselves.
 */
export function browseImport(input: { path?: string | null; extra?: (string | null | undefined)[] }): BrowseResult {
  const roots = browseRoots(input.extra);
  const rootsOut = roots.map((r) => ({ path: r.path, label: r.label }));
  const entryOf = (name: string, arr: string, local: string): BrowseEntry | null => {
    try {
      const st = fs.lstatSync(local);
      if (st.isSymbolicLink()) return null;
      if (st.isDirectory()) {
        const s = folderStats(local);
        return { name, path: arr, dir: true, size: s.size, mtime: st.mtimeMs, video: false, videos: s.videos };
      }
      if (!st.isFile()) return null;
      const video = VIDEO.test(name);
      return { name, path: arr, dir: false, size: st.size, mtime: st.mtimeMs, video, videos: video ? 1 : 0 };
    } catch {
      return null;
    }
  };
  const want = (input.path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!want) return { roots: rootsOut, path: null, parent: null, entries: roots.map((r) => entryOf(r.path, r.path, r.local)).filter((x): x is BrowseEntry => !!x).sort((a, b) => b.mtime - a.mtime), truncated: false };
  if (want.includes("\0") || want.split("/").some((s) => s === ".." || s === ".")) throw err("That path isn't allowed", 400);
  // The most specific root that holds the path.
  const root = [...roots].sort((a, b) => b.path.length - a.path.length).find((r) => want === r.path || want.startsWith(`${r.path}/`));
  if (!root) throw err("Manual import only browses AnimeArr's download folders", 403);
  const rel = want.slice(root.path.length).replace(/^\/+/, "");
  let real: string;
  try {
    real = fs.realpathSync(path.join(root.local, ...rel.split("/").filter(Boolean)));
  } catch {
    throw err(`AnimeArr can't read ${want}`, 404);
  }
  if (!under(real, root.local) || forbiddenSource(real)) throw err("Manual import only browses AnimeArr's download folders", 403);
  const parentOf = (p: string) => (p === root.path ? null : p.slice(0, p.lastIndexOf("/")) || null);
  if (!fs.statSync(real).isDirectory()) {
    const e = entryOf(path.basename(real), want, real);
    return { roots: rootsOut, path: want, parent: parentOf(want), entries: e ? [e] : [], truncated: false };
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(real);
  } catch {
    throw err(`AnimeArr can't read ${want}`, 404);
  }
  const truncated = names.length > 500;
  const entries = names
    .slice(0, 500)
    .map((n) => entryOf(n, `${want}/${n}`, path.join(real, n)))
    .filter((x): x is BrowseEntry => !!x)
    .sort((a, b) => b.mtime - a.mtime);
  return { roots: rootsOut, path: want, parent: parentOf(want), entries, truncated };
}
