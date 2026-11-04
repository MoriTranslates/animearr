/**
 * "Remove from AnimeArr" → "Also delete this show's folder and files": the show's (or movie's) own folder goes to
 * AnimeArr's recycling bin, file by file, BEFORE AnimeArr forgets it. Never a hard delete, never without a usable bin.
 *
 * Only the item's own folder (native_series.path / native_movies.path), and only when it is directly inside a library
 * or allowed root (compared by real path, protectedPaths.ts): never a root itself, a folder holding one, a folder
 * outside them, AnimeArr's own folder or the bin. Refused too when another show or movie uses the folder, when Sonarr
 * or Radarr also has the item (its files are that copy's), when a download for it is still in progress, and when the
 * folder holds a link or anything that isn't a plain file or folder. A folder that can't be read is refused ("can't
 * tell" is never "empty"); a folder that is surely gone (ENOENT) just means there is nothing to move.
 *
 * If a move fails part-way, what already moved is put back (newest first) and the item stays in AnimeArr; the error
 * says what moved, what came back and what is still in the bin.
 */
import fs from "node:fs";
import path from "node:path";
import { cache, db } from "../system/db.js";
import { logDecision } from "../system/activity.js";
import { keyOf, mappedPath } from "../system/paths.js";
import { binArrPath, binFolder, noteBinned } from "../import/binpurge.js";
import { moveNoClobber } from "../import/fileMoves.js";
import { movePathRows } from "../import/pathRows.js";
import { configFolder, libraryFolders, overlaps, realish } from "../import/protectedPaths.js";
import { NATIVE_BASE } from "./nativeIds.js";

const err = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });

export type Owner = { kind: "show"; tvdbId: number } | { kind: "movie"; movieId: number };

/** A test seam: how one file is moved (no-clobber; the original stays until the copy is complete). */
export const removeFilesDeps = { move: moveNoClobber };

const ACTIVE = "('sending', 'downloading', 'importing', 'needs-attention', 'removing')";

interface Item {
  title: string;
  arr: string;
  /** Its own row in the cache (series.id / movies.id), excluded from "another show uses this folder". */
  cacheId: number;
  what: "show" | "movie";
}

function item(o: Owner): Item {
  if (o.kind === "show") {
    const r = db.prepare("SELECT id, title, path FROM native_series WHERE tvdb_id = ?").get(o.tvdbId) as
      { id: number; title: string; path: string } | undefined;
    if (!r) throw err("That show wasn't added in AnimeArr", 404);
    return { title: r.title, arr: r.path, cacheId: NATIVE_BASE + r.id, what: "show" };
  }
  const r = db.prepare("SELECT id, title, path FROM native_movies WHERE id = ?").get(o.movieId - NATIVE_BASE) as
    { id: number; title: string; path: string } | undefined;
  if (!r) throw err("That movie wasn't added in AnimeArr", 404);
  return { title: r.title, arr: r.path, cacheId: o.movieId, what: "movie" };
}

/** Record keys compared like folders: forward slashes, no trailing slash, without case on Windows. */
const folderKey = (p: string) => (process.platform === "win32" ? keyOf(p).toLowerCase() : keyOf(p));
const keyOverlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

interface FileEntry {
  abs: string;
  rel: string;
  size: number;
}
export interface FolderPlan {
  path: string;
  canDelete: boolean;
  reason?: string;
  exists: boolean;
  files: number;
  bytes: number;
}
type Checked = { plan: FolderPlan; local: string; binLocal: string; list: FileEntry[] };

/** Every file under `dir`; refuses (throws) on a link or anything that isn't a plain file or folder. */
function walk(dir: string, rel = "", out: FileEntry[] = []): FileEntry[] {
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = path.join(rel, d.name);
    if (d.isSymbolicLink()) throw err(`it holds a link (${r}); move that out by hand first`, 409);
    if (d.isDirectory()) walk(dir, r, out);
    else if (d.isFile()) out.push({ abs: path.join(dir, r), rel: r, size: fs.statSync(path.join(dir, r)).size });
    else throw err(`it holds something that isn't a plain file (${r})`, 409);
  }
  return out;
}

/** Why the item's folder can't go to the bin, or what would go. Throws 404 when the item isn't AnimeArr's own. */
function check(o: Owner): Checked | { plan: FolderPlan } {
  const it = item(o);
  const arr = keyOf(it.arr.trim());
  const no = (reason: string) => ({ plan: { path: it.arr, canDelete: false, reason, exists: false, files: 0, bytes: 0 } });
  if (!arr) return no(`this ${it.what} has no folder on record`);
  const bin = binFolder();
  if ("error" in bin) return no(`AnimeArr's recycling bin can't be used (${bin.error}); nothing is ever deleted without it`);
  if (o.kind === "show" && cache.prepare("SELECT 1 FROM series WHERE tvdb_id = ? AND id < ?").get(o.tvdbId, NATIVE_BASE))
    return no("Sonarr also has this show; its files belong to Sonarr's copy");
  if (o.kind === "movie") {
    const tmdb = (db.prepare("SELECT tmdb_id FROM native_movies WHERE id = ?").get(o.movieId - NATIVE_BASE) as { tmdb_id: number | null })
      .tmdb_id;
    if (tmdb && cache.prepare("SELECT 1 FROM movies WHERE tmdb_id = ? AND id < ?").get(tmdb, NATIVE_BASE))
      return no("Radarr also has this movie; its files belong to Radarr's copy");
  }
  // Only a folder directly inside a library/allowed root, by real path: never a root, one holding a root, or outside.
  const local = path.resolve(mappedPath(arr));
  const real = realish(local);
  const roots = libraryFolders();
  if (roots.some((r) => r === real || r.startsWith(real.endsWith(path.sep) ? real : real + path.sep)))
    return no(`${it.arr} is (or holds) a library root folder`);
  if (!roots.some((r) => path.dirname(real) === r)) return no(`${it.arr} isn't a folder directly inside a library root folder`);
  if (overlaps(real, configFolder())) return no(`${it.arr} is (or holds) AnimeArr's own data folder`);
  if (overlaps(real, realish(bin.local))) return no(`${it.arr} is (or holds) the recycling bin`);
  // Another show or movie in the folder (or around it): its files aren't this one's to bin.
  // Compared both as recorded and as this machine maps them (a Sonarr path and a native one can name one folder).
  const k = folderKey(arr);
  const km = folderKey(mappedPath(arr));
  const others = [
    ...(cache.prepare("SELECT id, path FROM series WHERE path IS NOT NULL").all() as { id: number; path: string }[]).map((r) => ({
      ...r,
      own: it.what === "show" && r.id === it.cacheId,
    })),
    ...(cache.prepare("SELECT id, path FROM movies WHERE path IS NOT NULL").all() as { id: number; path: string }[]).map((r) => ({
      ...r,
      own: it.what === "movie" && r.id === it.cacheId,
    })),
    ...(db.prepare("SELECT id, path FROM native_series").all() as { id: number; path: string }[]).map((r) => ({
      ...r,
      own: it.what === "show" && NATIVE_BASE + r.id === it.cacheId,
    })),
    ...(db.prepare("SELECT id, path FROM native_movies").all() as { id: number; path: string }[]).map((r) => ({
      ...r,
      own: it.what === "movie" && NATIVE_BASE + r.id === it.cacheId,
    })),
  ];
  const shared = others.find(
    (r) => !r.own && r.path.trim() && (keyOverlaps(folderKey(r.path), k) || keyOverlaps(folderKey(mappedPath(r.path)), km)),
  );
  if (shared) return no(`another show or movie also uses ${shared.path}`);
  const active =
    o.kind === "show"
      ? db.prepare(`SELECT 1 FROM grabs WHERE dry_run = 0 AND tvdb_id = ? AND state IN ${ACTIVE}`).get(o.tvdbId)
      : db.prepare(`SELECT 1 FROM grabs WHERE dry_run = 0 AND movie_id = ? AND state IN ${ACTIVE}`).get(o.movieId);
  if (active) return no(`a download for this ${it.what} is still in progress; wait for it, or remove it in Activity, first`);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(local);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT")
      return { plan: { path: it.arr, canDelete: true, exists: false, files: 0, bytes: 0 }, local, binLocal: bin.local, list: [] };
    return no(`AnimeArr couldn't check ${it.arr} (${code ?? (e as Error).message})`); // can't tell is never "empty"
  }
  if (st.isSymbolicLink()) return no(`${it.arr} is a link, not the ${it.what}'s own folder`);
  if (!st.isDirectory()) return no(`${it.arr} isn't a folder`);
  let list: FileEntry[];
  try {
    list = walk(local);
  } catch (e) {
    return no(`AnimeArr won't bin ${it.arr}: ${(e as Error).message}`);
  }
  const bytes = list.reduce((n, f) => n + f.size, 0);
  return { plan: { path: it.arr, canDelete: true, exists: true, files: list.length, bytes }, local, binLocal: bin.local, list };
}

/** For the confirm dialog: whether the folder can go to the bin, and what's in it. */
export function removalPlan(o: Owner): FolderPlan {
  return check(o).plan;
}

const busy = new Set<string>();
/** One remove per show or movie at a time: a double click (or a second tab) gets a clear "already being removed". */
export async function withRemoveLock<T>(o: Owner, fn: () => Promise<T> | T): Promise<T> {
  const key = o.kind === "show" ? `s${o.tvdbId}` : `m${o.movieId}`;
  if (busy.has(key)) throw err(`That ${o.kind} is already being removed`, 409);
  busy.add(key);
  try {
    return await fn();
  } finally {
    busy.delete(key);
  }
}

function removeEmptyDirs(dir: string) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true }))
    if (d.isDirectory() && !d.isSymbolicLink()) removeEmptyDirs(path.join(dir, d.name));
  if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); // only ever an empty folder
}

/**
 * Moves the item's folder into the recycling bin (<bin>/<folder name>/..., a name already there gets a stamped one,
 * never overwritten). Throws (409) when refused, (500) when a move fails: then what moved is put back and the item
 * must NOT be forgotten. Call inside withRemoveLock, then forget the item.
 */
export async function binOwnFolder(o: Owner) {
  const c = check(o);
  if (!("list" in c))
    throw err(`Not deleted: ${c.plan.reason}. ${o.kind === "show" ? "The show" : "The movie"} is still in AnimeArr.`, 409);
  const { plan, local, binLocal, list } = c;
  if (!plan.exists) return { moved: 0, bytes: 0, folderMissing: true, leftBehind: false };
  const name = path.basename(local);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const moved: { from: string; to: string; rel: string; size: number }[] = [];
  for (const f of list) {
    let to = path.join(binLocal, name, f.rel);
    if (fs.existsSync(to)) to = /\.[^.\\/]+$/.test(to) ? to.replace(/(\.[^.\\/]+)$/, `.${stamp}$1`) : `${to}.${stamp}`;
    try {
      await removeFilesDeps.move(f.abs, to);
    } catch (e) {
      // Part-way: put back what already went, newest first; say exactly what didn't come back.
      const stranded: string[] = [];
      for (const m of [...moved].reverse()) {
        try {
          await removeFilesDeps.move(m.to, m.from);
        } catch (re) {
          stranded.push(`${m.rel} (at ${m.to}: ${(re as Error).message})`);
        }
      }
      const back = moved.length - stranded.length;
      const msg =
        `Couldn't move ${f.rel} to the recycling bin (${(e as Error).message}). ` +
        (moved.length
          ? `${back} of ${moved.length} file${moved.length === 1 ? "" : "s"} already moved ${back === 1 ? "was" : "were"} put back. `
          : "Nothing had moved yet. ") +
        (stranded.length
          ? `${stranded.length} ${stranded.length === 1 ? "is" : "are"} still in the recycling bin: ${stranded.join("; ")}. `
          : "") +
        `${o.kind === "show" ? "The show" : "The movie"} is still in AnimeArr.`;
      logDecision("fail", { tvdbId: o.kind === "show" ? o.tvdbId : null, title: plan.path, why: msg });
      throw err(msg, 500);
    }
    moved.push({ from: f.abs, to, rel: f.rel, size: f.size });
  }
  // Bookkeeping per moved file: the bin's clock, and the file's rows go to the bin with it (like a replaced file's).
  const arrBase = keyOf(plan.path.trim());
  for (const m of moved) {
    const arrFrom = `${arrBase}/${m.rel.split(path.sep).join("/")}`;
    try {
      noteBinned(m.to, m.size);
      movePathRows(arrFrom, binArrPath(m.to, binLocal));
      db.prepare("DELETE FROM media_files WHERE path = ?").run(arrFrom);
    } catch (e) {
      logDecision("fail", {
        title: plan.path,
        why: `Moved ${m.rel} to the recycling bin, but its records couldn't follow (${(e as Error).message})`,
      });
    }
  }
  let leftBehind = false;
  try {
    removeEmptyDirs(local);
  } catch {
    /* every file is in the bin; an empty folder that won't go (in use, permissions) is reported as left behind below */
  }
  leftBehind = fs.existsSync(local);
  const bytes = moved.reduce((n, m) => n + m.size, 0);
  logDecision("info", {
    tvdbId: o.kind === "show" ? o.tvdbId : null,
    title: plan.path,
    why: `Moved ${moved.length} file${moved.length === 1 ? "" : "s"} (${(bytes / 1e9).toFixed(2)} GB) of ${plan.path} to the recycling bin${leftBehind ? "; the folder itself couldn't be removed" : ""}`,
  });
  return { moved: moved.length, bytes, folderMissing: false, leftBehind };
}
