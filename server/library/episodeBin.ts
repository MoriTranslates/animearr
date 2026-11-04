/**
 * Episode and season delete into AnimeArr's own recycling bin. AnimeArr never calls Sonarr for anime: Sonarr's
 * records are only the user's backup. This works on AnimeArr's own records (the cache's episodes/files rows,
 * media_files and the per-file rows), its own files and its own bin only. Never a hard delete, never without a usable
 * bin, never a Sonarr fallback.
 *
 * Guards, per file: the show's folder must be strictly inside a library or allowed root (never a root, one holding a
 * root, AnimeArr's own folder or the bin), and the file must be strictly inside the show's folder both as recorded and
 * by real path (links resolved). A file that is a link, or that can't be checked, is refused ("can't tell" is never
 * "gone").
 *
 * Per file, its sidecars (subtitles, nfo, thumb: same base name) move first and the video last, each with a no-clobber
 * move into <bin>/<show folder>/<path inside the show>. If any move fails, what already moved of that file is put
 * back and the file stays recorded; the reason comes back to the caller. Only once the video is in the bin are its
 * records changed (the episode becomes missing at once).
 */
import fs from "node:fs";
import path from "node:path";
import { cache, db, tx } from "../system/db.js";
import { logDecision } from "../system/activity.js";
import { getSettings } from "../system/settings.js";
import { fileSurelyGone, keyOf, mappedPath } from "../system/paths.js";
import { binArrPath, binFolder, noteBinned } from "../import/binpurge.js";
import { moveNoClobber } from "../import/fileMoves.js";
import { movePathRows } from "../import/pathRows.js";
import { configFolder, libraryFolders, overlaps, realish } from "../import/protectedPaths.js";

/** A test seam: how one file is moved (no-clobber; the original stays until the copy is complete). */
export const episodeBinDeps = { move: moveNoClobber };

const err = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });

/** The show folder and the bin, checked once per request. */
export interface BinTarget {
  showLocal: string;
  showReal: string;
  binLocal: string;
}

/**
 * Where a show's episode files may go, or a 409 with the reason. Refused when the bin can't be used, or when the
 * show's folder is (or holds) a library root, isn't inside one, or touches AnimeArr's own folder or the bin.
 */
export function binTarget(showArr: string): BinTarget {
  const bin = binFolder();
  if ("error" in bin)
    throw err(`AnimeArr's recycling bin can't be used (${bin.error}); nothing was deleted, and nothing is ever deleted without it`, 409);
  const arr = keyOf(showArr.trim());
  if (!arr) throw err("This show has no folder on record; nothing was deleted", 409);
  const showLocal = path.resolve(mappedPath(arr));
  const showReal = realish(showLocal);
  const roots = libraryFolders();
  const holds = (outer: string, inner: string) => inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
  if (roots.some((r) => holds(showReal, r))) throw err(`${showArr} is (or holds) a library root folder; nothing was deleted`, 409);
  if (!roots.some((r) => holds(r, showReal))) throw err(`${showArr} isn't inside a library root folder; nothing was deleted`, 409);
  if (overlaps(showReal, configFolder())) throw err(`${showArr} is (or holds) AnimeArr's own data folder; nothing was deleted`, 409);
  if (overlaps(showReal, realish(bin.local))) throw err(`${showArr} is (or holds) the recycling bin; nothing was deleted`, 409);
  return { showLocal, showReal, binLocal: bin.local };
}

const SUBS = ["srt", "ass", "ssa", "sub", "idx", "sup", "vtt", "smi"];
const META = ["nfo", "jpg", "jpeg", "png", "tbn", "webp"];
const VIDEO = /^(mkv|mp4|m4v|avi|ts|m2ts|wmv|mov|webm|flv|ogm|mpg|mpeg)$/i;

/**
 * The sidecars of a video: same folder, "<base>.<…>.<ext>" or "<base>-thumb.<ext>" with a subtitle, nfo, image or
 * extra-file extension (never a video). "Show - 01.5.ass" isn't a sidecar of "Show - 01.mkv". Plain files only.
 * Throws when the folder can't be read: the sidecars can't be told, so the file isn't half-deleted.
 */
function sidecarsOf(localVideo: string): string[] {
  const dir = path.dirname(localVideo);
  const name = path.basename(localVideo);
  const base = name.replace(/\.[^.]+$/, "");
  const extra = getSettings()
    .media.extraFileExtensions.split(",")
    .map((x) => x.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean);
  const exts = new Set([...SUBS, ...META, ...extra]);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name !== name)
    .map((d) => d.name)
    .filter((f) => {
      const ext = path.extname(f).slice(1).toLowerCase();
      if (!exts.has(ext) || VIDEO.test(ext)) return false;
      if (f.startsWith(`${base}-thumb.`)) return /^-thumb\.[^.]+$/.test(f.slice(base.length));
      return f.startsWith(`${base}.`) && /^(\.(?!\d+\.)[^.]{1,20})*\.[^.]+$/.test(f.slice(base.length));
    })
    .map((f) => path.join(dir, f));
}

export type BinOutcome =
  | { kind: "gone" } // the file was already gone from disk: only the records change
  | { kind: "moved"; moved: { from: string; to: string; size: number }[]; video: string };

/**
 * Moves one episode file (and its sidecars) to the bin. Throws with the reason when refused or when a move fails (then
 * what moved is put back; anything that couldn't come back is named).
 */
export async function binEpisodeFile(fileArr: string, t: BinTarget): Promise<BinOutcome> {
  const localVideo = path.resolve(mappedPath(fileArr));
  let st: fs.Stats;
  try {
    st = fs.lstatSync(localVideo);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && fileSurelyGone(fileArr)) return { kind: "gone" }; // an unmounted share is never "gone"
    throw new Error(`AnimeArr couldn't check the file (${code ?? (e as Error).message}); nothing was moved`, { cause: e });
  }
  if (st.isSymbolicLink()) throw new Error("the file is a link, not the show's own file; nothing was moved");
  if (!st.isFile()) throw new Error("that isn't a plain file; nothing was moved");
  const real = realish(localVideo);
  if (!real.startsWith(t.showReal.endsWith(path.sep) ? t.showReal : t.showReal + path.sep))
    throw new Error(`the file is outside the show's folder by its real path (${fileArr}); nothing was moved`);
  const relOf = (f: string) => path.relative(path.dirname(t.showLocal), f);
  if (relOf(localVideo).startsWith("..") || path.isAbsolute(relOf(localVideo)))
    throw new Error(`the file is outside the show's folder (${fileArr}); nothing was moved`);
  // Sidecars first, the video last: whatever fails, the video is either in the library or in the bin, never half.
  const group = [...sidecarsOf(localVideo), localVideo];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const moved: { from: string; to: string; size: number }[] = [];
  for (const f of group) {
    let to = path.join(t.binLocal, relOf(f));
    if (fs.existsSync(to)) to = /\.[^.\\/]+$/.test(to) ? to.replace(/(\.[^.\\/]+)$/, `.${stamp}$1`) : `${to}.${stamp}`;
    const size = fs.statSync(f).size;
    try {
      await episodeBinDeps.move(f, to);
    } catch (e) {
      const stranded: string[] = [];
      for (const m of [...moved].reverse()) {
        try {
          await episodeBinDeps.move(m.to, m.from);
        } catch (re) {
          stranded.push(`${path.basename(m.from)} (at ${m.to}: ${(re as Error).message})`);
        }
      }
      throw new Error(
        `couldn't move ${path.basename(f)} to AnimeArr's recycling bin (${(e as Error).message}); ` +
          (stranded.length
            ? `the episode file stays, but ${stranded.length === 1 ? "this sidecar is" : "these sidecars are"} still in the bin: ${stranded.join("; ")}`
            : "nothing was moved, the file is where it was"),
      );
    }
    moved.push({ from: f, to, size });
  }
  return { kind: "moved", moved, video: localVideo };
}

/**
 * After the video left the library (or was already gone): the episodes holding it become missing, its file row and
 * scan row go, its per-file rows (episode links, release details, track corrections, marks) go to the bin with it,
 * and the bin's clock starts for every moved file. Returns a note when the bookkeeping failed (the move stands).
 */
export function recordBinned(o: { seriesId: number; fileId: number; fileArr: string; outcome: BinOutcome; binLocal: string }) {
  const notes: string[] = [];
  try {
    tx(cache, () => {
      cache.prepare("UPDATE episodes SET has_file = 0, file_id = NULL WHERE series_id = ? AND file_id = ?").run(o.seriesId, o.fileId);
      cache.prepare("DELETE FROM files WHERE id = ? AND series_id = ?").run(o.fileId, o.seriesId);
    });
  } catch (e) {
    notes.push(`the episode list couldn't be updated (${(e as Error).message}); it shows right after the next sync`);
  }
  try {
    db.prepare("DELETE FROM media_files WHERE path = ?").run(keyOf(o.fileArr));
    const out = o.outcome;
    if (out.kind === "moved") {
      const video = out.moved.find((m) => m.from === out.video);
      if (video) movePathRows(o.fileArr, binArrPath(video.to, o.binLocal));
      for (const m of out.moved) noteBinned(m.to, m.size);
    } else movePathRows(o.fileArr, `deleted:${Date.now()}:${keyOf(o.fileArr)}`);
  } catch (e) {
    notes.push(`its records couldn't follow it (${(e as Error).message})`);
  }
  if (notes.length)
    logDecision("fail", {
      title: o.fileArr,
      why: `Moved ${path.posix.basename(keyOf(o.fileArr))} to the recycling bin, but ${notes.join("; ")}`,
    });
  return notes.join("; ");
}

const busy = new Set<number>();
/** One episode/season delete per show at a time: a double click (or a second tab) gets a clear "already running". */
export async function withDeleteLock<T>(tvdbId: number, fn: () => Promise<T>): Promise<T> {
  if (busy.has(tvdbId)) throw err("A delete for this show is already running; wait for it to finish", 409);
  busy.add(tvdbId);
  try {
    return await fn();
  } finally {
    busy.delete(tvdbId);
  }
}
