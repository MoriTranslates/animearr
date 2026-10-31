/**
 * Media-server output layer: what AnimeArr writes beside the videos so every media server shows a show the way
 * AnimeArr numbered it (split cours, sequel seasons, specials), and the one hook the importer and renamer call after
 * they changed a show's folder.
 *
 * - NFO files (Kodi's format, read by Jellyfin, Emby and Kodi): tvshow.nfo, season.nfo, <episode file>.nfo with the
 *   ids AnimeArr knows (tvdb, tmdb, imdb, anidb, anilist), titles, plot, dates and AnimeArr's season/episode numbers.
 *   Multi-episode files get one <episodedetails> block per episode (Kodi's convention; Jellyfin's parser reads it).
 * - .plexmatch for Plex (title, year, tvdbid/tmdbid hints).
 * - poster/banner artwork from AniList, only when the folder has none.
 *
 * Every text file AnimeArr writes carries MARKER. A file without it is the user's own and is never overwritten or
 * removed. Files are only rewritten when their content changes, so servers don't rescan for nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { logDecision } from "./activity.js";
import { cache, db } from "./db.js";
import { allowedImage } from "./img.js";
import { notifyMediaServers } from "./mediaservers.js";
import { mappedPath } from "./paths.js";
import { notifyPlex } from "./plex.js";
import { getSettings, underAllowedRoot } from "./settings.js";

export const MARKER = "Written by AnimeArr";
const NOTE = `${MARKER}. Delete this line to keep your own edits; AnimeArr then leaves the file alone.`;
const VIDEO = /\.(mkv|mp4|m4v|avi|ts|webm)$/i;

export interface ShowMeta {
  title: string;
  originalTitle?: string | null;
  year?: number | null;
  plot?: string | null;
  premiered?: string | null;
  status?: string | null;
  studio?: string | null;
  genres?: string[];
  ids: { tvdb?: number | null; tmdb?: number | null; imdb?: string | null; anidb?: number | null; anilist?: number | null };
  poster?: string | null;
  banner?: string | null;
}
export interface EpisodeMeta { season: number; episode: number; title?: string | null; aired?: string | null; runtime?: number | null; absolute?: number | null }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const el = (name: string, v: string | number | null | undefined, attrs = "") => (v === null || v === undefined || v === "" ? "" : `  <${name}${attrs}>${esc(String(v))}</${name}>\n`);
/** AniList descriptions are HTML ("<br>", "<i>…</i>", "(Source: …)"): plain text for the NFO. */
export const plainText = (html: string | null | undefined) =>
  (html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
const head = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<!-- ${NOTE} -->\n`;

function uniqueIds(ids: ShowMeta["ids"]) {
  // tvdb is the default id (the numbering AnimeArr's seasons follow); the others help servers that prefer them.
  const def = ids.tvdb ? "tvdb" : ids.tmdb ? "tmdb" : ids.anidb ? "anidb" : ids.anilist ? "anilist" : null;
  return (["tvdb", "tmdb", "imdb", "anidb", "anilist"] as const)
    .filter((k) => ids[k])
    .map((k) => el("uniqueid", ids[k], ` type="${k}"${k === def ? ' default="true"' : ""}`))
    .join("");
}

export function tvshowNfo(m: ShowMeta) {
  return (
    head +
    "<tvshow>\n" +
    el("title", m.title) +
    (m.originalTitle && m.originalTitle !== m.title ? el("originaltitle", m.originalTitle) : "") +
    el("plot", plainText(m.plot)) +
    el("year", m.year) +
    el("premiered", m.premiered) +
    el("status", m.status) +
    el("studio", m.studio) +
    (m.genres ?? []).map((g) => el("genre", g)).join("") +
    uniqueIds(m.ids) +
    (m.poster ? el("thumb", m.poster, ' aspect="poster"') : "") +
    (m.banner ? el("thumb", m.banner, ' aspect="banner"') : "") +
    "</tvshow>\n"
  );
}

export function seasonNfo(season: number, title?: string | null) {
  return head + "<season>\n" + el("seasonnumber", season) + el("title", title ?? (season === 0 ? "Specials" : `Season ${season}`)) + "</season>\n";
}

/** One <episodedetails> block per episode in the file (a multi-episode file lists them all). */
export function episodeNfo(showTitle: string, eps: EpisodeMeta[]) {
  return (
    head +
    eps
      .map((e) => "<episodedetails>\n" + el("title", e.title || `Episode ${e.episode}`) + el("showtitle", showTitle) + el("season", e.season) + el("episode", e.episode) + el("aired", e.aired) + el("runtime", e.runtime) + "</episodedetails>\n")
      .join("")
  );
}

export function plexmatch(m: ShowMeta) {
  return [`# ${NOTE}`, `title: ${m.title}`, m.year ? `year: ${m.year}` : "", m.ids.tvdb ? `tvdbid: ${m.ids.tvdb}` : "", m.ids.tmdb ? `tmdbid: ${m.ids.tmdb}` : "", m.ids.imdb ? `imdbid: ${m.ids.imdb}` : ""].filter(Boolean).join("\n") + "\n";
}

const isOurs = (text: string) => text.includes(MARKER);

export interface WriteDeps {
  read(p: string): string | null;
  write(p: string, text: string): void;
  writeBytes(p: string, data: Buffer): void;
  remove(p: string): void;
  exists(p: string): boolean;
  list(dir: string): { name: string; dir: boolean }[];
  image(url: string): Promise<{ data: Buffer; ext: string } | null>;
}
export const realWriteDeps: WriteDeps = {
  read: (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  write: (p, text) => fs.writeFileSync(p, text, "utf8"),
  writeBytes: (p, data) => fs.writeFileSync(p, data),
  remove: (p) => fs.unlinkSync(p),
  exists: (p) => fs.existsSync(p),
  list: (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() }));
    } catch {
      return [];
    }
  },
  image: fetchImage,
};

/** An artwork file from a known image host (no open proxy), size-capped, images only. */
async function fetchImage(url: string): Promise<{ data: Buffer; ext: string } | null> {
  if (!allowedImage(url)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/^image\/(jpeg|png|webp)/i.test(type)) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length || data.length > 5_000_000) return null;
    return { data, ext: /png/i.test(type) ? "png" : /webp/i.test(type) ? "webp" : "jpg" };
  } catch {
    return null;
  }
}

export interface SyncCounts { written: number; unchanged: number; userFiles: number; removed: number; artwork: number }

/** Writes text unless the file is the user's own; unchanged content isn't rewritten. */
function put(file: string, text: string, deps: WriteDeps, c: SyncCounts) {
  const cur = deps.read(file);
  if (cur !== null && !isOurs(cur)) return void c.userFiles++;
  if (cur === text) return void c.unchanged++;
  deps.write(file, text);
  c.written++;
}

export interface SeriesOutput { show: ShowMeta; folder: string; files: { path: string; episodes: EpisodeMeta[] }[] }

/**
 * Brings one show's metadata files in step with its videos: writes what's enabled, removes AnimeArr's own episode
 * NFOs whose video is gone (renamed, upgraded or deleted). `folder` and file paths are local paths.
 */
export async function syncSeriesFiles(o: SeriesOutput, opts: { nfo: boolean; plexmatch: boolean; artwork: boolean }, deps: WriteDeps = realWriteDeps): Promise<SyncCounts> {
  const c: SyncCounts = { written: 0, unchanged: 0, userFiles: 0, removed: 0, artwork: 0 };
  if (!deps.exists(o.folder)) return c;
  if (opts.nfo) {
    put(path.join(o.folder, "tvshow.nfo"), tvshowNfo(o.show), deps, c);
    const seasonDirs = new Set<string>();
    for (const f of o.files) {
      const dir = path.dirname(f.path);
      if (dir !== o.folder && f.episodes.length && !seasonDirs.has(dir)) {
        seasonDirs.add(dir);
        put(path.join(dir, "season.nfo"), seasonNfo(f.episodes[0].season), deps, c);
      }
      if (f.episodes.length) put(f.path.replace(/\.[^./\\]+$/, ".nfo"), episodeNfo(o.show.title, f.episodes), deps, c);
    }
  }
  if (opts.plexmatch) put(path.join(o.folder, ".plexmatch"), plexmatch(o.show), deps, c);
  if (opts.artwork) {
    const names = new Set(deps.list(o.folder).map((x) => x.name.toLowerCase()));
    for (const [kind, url] of [["poster", o.show.poster], ["banner", o.show.banner]] as const) {
      if (!url || [...names].some((n) => n.startsWith(`${kind}.`))) continue; // the folder already has one (maybe the user's)
      const img = await deps.image(url);
      if (!img) continue;
      deps.writeBytes(path.join(o.folder, `${kind}.${img.ext}`), img.data);
      c.artwork++;
    }
  }
  // AnimeArr's own episode NFOs whose video is gone (show folder and one level of season folders).
  const dirs = [o.folder, ...deps.list(o.folder).filter((x) => x.dir).map((x) => path.join(o.folder, x.name))];
  for (const dir of dirs) {
    const entries = deps.list(dir);
    const videos = new Set(entries.filter((x) => !x.dir && VIDEO.test(x.name)).map((x) => x.name.replace(/\.[^.]+$/, "").toLowerCase()));
    for (const x of entries) {
      if (x.dir || !/\.nfo$/i.test(x.name) || /^(tvshow|season)\.nfo$/i.test(x.name) || videos.has(x.name.replace(/\.nfo$/i, "").toLowerCase())) continue;
      const file = path.join(dir, x.name);
      const text = deps.read(file);
      if (text !== null && isOurs(text)) {
        deps.remove(file);
        c.removed++;
      }
    }
  }
  return c;
}

const json = <T>(s: string | null | undefined, d: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : d;
  } catch {
    return d;
  }
};

/** What AnimeArr knows about a show, from its own catalog (series row + the AniList entries mapped to it). */
export function seriesOutput(tvdbId: number): SeriesOutput | null {
  const s = cache.prepare("SELECT id, tvdb_id, tmdb_id, imdb_id, title, year, status, network, overview, genres, first_aired, path, poster, anidb_ids FROM series WHERE tvdb_id = ?").get(tvdbId) as
    | { id: number; tvdb_id: number; tmdb_id: number | null; imdb_id: string | null; title: string; year: number | null; status: string | null; network: string | null; overview: string | null; genres: string; first_aired: string | null; path: string | null; poster: string | null; anidb_ids: string }
    | undefined;
  if (!s?.path) return null;
  const native = db.prepare("SELECT anilist_id, synthetic FROM native_series WHERE tvdb_id = ?").get(tvdbId) as { anilist_id: number; synthetic: number } | undefined;
  // The earliest AniList entry of the show (season 1), or the native show's own entry when TVDB doesn't have it.
  const e = (native?.synthetic
    ? db.prepare("SELECT * FROM entries WHERE anilist_id = ?").get(native.anilist_id)
    : db.prepare("SELECT * FROM entries WHERE tvdb_id = ? AND (tvdb_season IS NULL OR tvdb_season != '0') ORDER BY start_date IS NULL, start_date LIMIT 1").get(tvdbId)) as
    | { anilist_id: number; anidb_id: number | null; title_native: string | null; description: string | null; cover: string | null; banner: string | null; start_date: string | null; genres: string; tmdb_tv: number | null }
    | undefined;
  const status = (s.status ?? "").toLowerCase();
  const show: ShowMeta = {
    title: s.title,
    originalTitle: e?.title_native ?? null,
    year: s.year,
    plot: e?.description ?? s.overview,
    premiered: (s.first_aired ?? e?.start_date ?? "").slice(0, 10) || null,
    status: status === "ended" || status === "finished" ? "Ended" : status ? "Continuing" : null,
    studio: s.network,
    genres: json<string[]>(e?.genres, []).length ? json<string[]>(e?.genres, []) : json<string[]>(s.genres, []),
    ids: { tvdb: native?.synthetic ? null : s.tvdb_id, tmdb: s.tmdb_id ?? e?.tmdb_tv ?? null, imdb: s.imdb_id, anidb: e?.anidb_id ?? json<number[]>(s.anidb_ids, [])[0] ?? null, anilist: e?.anilist_id ?? native?.anilist_id ?? null },
    poster: e?.cover ?? s.poster,
    banner: e?.banner ?? null,
  };
  const rows = cache.prepare("SELECT e.season, e.episode, e.absolute, e.title, e.air_date, e.runtime, f.path FROM episodes e JOIN files f ON f.id = e.file_id WHERE e.series_id = ? ORDER BY e.season, e.episode").all(s.id) as { season: number; episode: number; absolute: number | null; title: string | null; air_date: string | null; runtime: number | null; path: string }[];
  const byFile = new Map<string, EpisodeMeta[]>();
  for (const r of rows) {
    const list = byFile.get(r.path) ?? [];
    list.push({ season: r.season, episode: r.episode, absolute: r.absolute, title: r.title, aired: r.air_date?.slice(0, 10) ?? null, runtime: r.runtime });
    byFile.set(r.path, list);
  }
  return { show, folder: mappedPath(s.path), files: [...byFile].map(([p, eps]) => ({ path: mappedPath(p), episodes: eps })) };
}

const enabledOutput = () => {
  const m = getSettings().mediaOutput;
  return { nfo: !!m?.nfo, plexmatch: !!m?.plexmatch, artwork: !!m?.artwork };
};

/** Writes one show's metadata files (when any are switched on and the show is inside an allowed root folder). */
export async function syncSeriesMetadata(tvdbId: number, deps: WriteDeps = realWriteDeps) {
  const opts = enabledOutput();
  if (!opts.nfo && !opts.plexmatch && !opts.artwork) return null;
  const o = seriesOutput(tvdbId);
  const arrPath = (cache.prepare("SELECT path FROM series WHERE tvdb_id = ?").get(tvdbId) as { path: string | null } | undefined)?.path;
  if (!o || !underAllowedRoot(arrPath)) return null;
  return syncSeriesFiles(o, opts, deps);
}

/**
 * The hook after AnimeArr changed a show's or movie's folder (import, upgrade, rename, undo, delete): metadata files
 * first (so the servers read the new ones), then every enabled media server is asked to scan those folders.
 */
export async function afterLibraryChange(c: { tvdbId?: number | null; folders: string[] }) {
  if (c.tvdbId) {
    try {
      await syncSeriesMetadata(c.tvdbId);
    } catch (e) {
      logDecision("fail", { tvdbId: c.tvdbId, why: `Couldn't write the media-server files: ${(e as Error).message}` });
    }
  }
  notifyPlex(c.folders);
  notifyMediaServers(c.folders);
}

let running: Promise<SyncCounts & { shows: number }> | null = null;
/** "Write metadata for every show now" (Settings → Media servers): one show at a time, in the background. */
export function syncAllMetadata(deps: WriteDeps = realWriteDeps) {
  if (running) return { started: false };
  running = (async () => {
    const total: SyncCounts & { shows: number } = { written: 0, unchanged: 0, userFiles: 0, removed: 0, artwork: 0, shows: 0 };
    const ids = (cache.prepare("SELECT tvdb_id FROM series ORDER BY title").all() as { tvdb_id: number }[]).map((x) => x.tvdb_id);
    for (const id of ids) {
      try {
        const c = await syncSeriesMetadata(id, deps);
        if (!c) continue;
        total.shows++;
        for (const k of ["written", "unchanged", "userFiles", "removed", "artwork"] as const) total[k] += c[k];
      } catch {
        /* one unreadable folder doesn't stop the rest */
      }
    }
    logDecision("info", { why: `Media-server files for ${total.shows} ${total.shows === 1 ? "show" : "shows"}: ${total.written} written, ${total.unchanged} already up to date, ${total.removed} removed, ${total.artwork} artwork${total.userFiles ? `; ${total.userFiles} of your own files left alone` : ""}` });
    return total;
  })().finally(() => (running = null));
  return { started: true };
}
export const metadataSyncRunning = () => !!running;
