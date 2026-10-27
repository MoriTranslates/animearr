/**
 * AnimeArr's own file records (1.0 takeover, step 1). AnimeArr scans its library roots itself and ffprobes every
 * video file: tracks, languages, forced flags, codecs, runtime, size, mtime, and the subtitle sidecars next to it.
 * The records are AnimeArr's, separate from Sonarr's/Radarr's mediaInfo (which has no forced flag).
 *
 * Kept current incrementally: every 30 minutes the roots are walked (stat only) and only files whose size or mtime
 * changed (e.g. after Tdarr rewrites one) are probed again. Read-only: nothing on disk is changed.
 *
 * Paths are stored as the *arr/library sees them (the same paths Sonarr/Radarr use), mapped to this machine's paths
 * through Settings → Paths for reading.
 */
import { applyOverrides } from "./detection.js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { sidecarLang, toLang } from "./core/langs.js";
import { cache, db, dbState, setJob, tx } from "./db.js";
import { localPath } from "./paths.js";
import { getSettings } from "./settings.js";
import { PARTIAL_TRACK } from "./verify.js";

const VIDEO = /\.(mkv|mp4|m4v|avi|ts|webm|wmv|mov)$/i;
const SIDECAR = /\.(ass|ssa|srt|sup|sub|vtt)$/i;

export interface Track { index: number; codec: string | null; lang: string | null; title: string | null; default: boolean; forced: boolean }
export interface AudioTrack extends Track { channels: number | null }
export interface SubTrack extends Track { /** Not full dialogue: forced flag, or a "Signs & Songs" / "Forced" title. */ partial: boolean }
export interface MediaRecord {
  path: string;
  root: string;
  size: number;
  mtime: number;
  duration: number | null;
  container: string | null;
  video: { codec: string | null; width: number | null; height: number | null; hdr: boolean; /** Absent in records made before it was probed. */ bitDepth?: number | null } | null;
  audio: AudioTrack[];
  subs: SubTrack[];
  sidecars: { file: string; lang: string | null; forced: boolean }[];
}

const FULL = /\b(full|dialog(ue)?|complete)\b/i;

interface RawStream { index: number; codec_type: string; codec_name?: string; width?: number; height?: number; pix_fmt?: string; bits_per_raw_sample?: string; channels?: number; color_transfer?: string; disposition?: { default?: number; forced?: number }; tags?: { language?: string; title?: string } }

/** ffprobe with everything the records need. */
export function probeFile(file: string, bin = process.env.FFPROBE_PATH || "ffprobe"): Promise<Omit<MediaRecord, "path" | "root" | "size" | "mtime" | "sidecars">> {
  return new Promise((resolve, reject) => {
    execFile(bin, ["-v", "error", "-show_entries", "stream=index,codec_type,codec_name,width,height,channels,color_transfer,pix_fmt,bits_per_raw_sample:stream_disposition=default,forced:stream_tags=language,title:format=duration,format_name", "-of", "json", file], { timeout: 120_000, maxBuffer: 16 << 20 }, (err, stdout) => {
      if (err) return reject(new Error(`ffprobe failed: ${err.message.split("\n")[0]}`));
      try {
        const j = JSON.parse(stdout) as { streams?: RawStream[]; format?: { duration?: string; format_name?: string } };
        const lang = (s: RawStream) => {
          const l = toLang(s.tags?.language ?? "");
          return l && l !== "und" ? l : null;
        };
        const base = (s: RawStream): Track => ({ index: s.index, codec: s.codec_name ?? null, lang: lang(s), title: s.tags?.title ?? null, default: s.disposition?.default === 1, forced: s.disposition?.forced === 1 });
        const v = (j.streams ?? []).find((s) => s.codec_type === "video" && s.codec_name !== "mjpeg" && s.codec_name !== "png");
        resolve({
          duration: j.format?.duration ? Number(j.format.duration) : null,
          container: j.format?.format_name ?? null,
          video: v ? { codec: v.codec_name ?? null, width: v.width ?? null, height: v.height ?? null, hdr: /smpte2084|arib-std-b67/.test(v.color_transfer ?? ""), bitDepth: Number(v.bits_per_raw_sample) || (/p12/.test(v.pix_fmt ?? "") ? 12 : /p10/.test(v.pix_fmt ?? "") ? 10 : v.pix_fmt ? 8 : null) } : null,
          audio: (j.streams ?? []).filter((s) => s.codec_type === "audio").map((s) => ({ ...base(s), channels: s.channels ?? null })),
          subs: (j.streams ?? []).filter((s) => s.codec_type === "subtitle").map((s) => {
            const t = base(s);
            return { ...t, partial: t.forced || (PARTIAL_TRACK.test(t.title ?? "") && !FULL.test(t.title ?? "")) };
          }),
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Record keys use forward slashes, whatever OS the *arr runs on. */
export const keyOf = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** The library roots: the root folders of the synced anime series and movies (as the *arrs see them), nested ones folded. */
export function libraryRoots(): string[] {
  const set = new Set<string>();
  for (const r of cache.prepare("SELECT DISTINCT root_folder FROM series WHERE root_folder IS NOT NULL").all() as { root_folder: string }[]) set.add(r.root_folder.replace(/[\\/]+$/, ""));
  for (const r of cache.prepare("SELECT DISTINCT root_folder FROM movies WHERE is_anime = 1 AND root_folder IS NOT NULL").all() as { root_folder: string }[]) set.add(r.root_folder.replace(/[\\/]+$/, ""));
  const all = [...set].filter(Boolean).sort();
  return all.filter((r) => !all.some((o) => o !== r && keyOf(r).startsWith(`${keyOf(o)}/`)));
}

interface WalkState { files: { file: string; size: number; mtime: number }[]; side: Map<string, string[]>; failures: number }
async function walk(dir: string, depth: number, st: WalkState) {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    st.failures++;
    return;
  }
  const subs: string[] = [];
  const videos: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "@eaDir" || e.name === "_animearr_unpacked") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) await walk(p, depth - 1, st);
    } else if (e.isFile()) {
      if (VIDEO.test(e.name)) videos.push(p);
      else if (SIDECAR.test(e.name)) subs.push(e.name);
    }
  }
  // stat a few at a time (FUSE is slow one by one)
  for (let i = 0; i < videos.length; i += 8)
    await Promise.all(
      videos.slice(i, i + 8).map(async (p) => {
        try {
          const s = await fs.stat(p);
          st.files.push({ file: p, size: s.size, mtime: Math.floor(s.mtimeMs) });
        } catch {
          /* vanished */
        }
      }),
    );
  if (subs.length) st.side.set(dir, subs);
}

/** Sidecar subtitle files belonging to a video: same base name, then only language/flag tokens. */
function sidecarsOf(local: string, side: Map<string, string[]>) {
  const base = path.basename(local).replace(/\.[^.]+$/, "");
  return (side.get(path.dirname(local)) ?? [])
    .filter((f) => f.startsWith(`${base}.`) && /^(\.[A-Za-z]{2,3}(-[A-Za-z]{2,4})?|\.(forced|signs?|sdh|cc|default|full))*\.[a-z0-9]{2,4}$/i.test(f.slice(base.length)))
    .map((f) => ({ file: f, lang: sidecarLang(f) ?? null, forced: /\.(forced|signs?)(\.|$)/i.test(f) }));
}

export interface ScanResult { roots: string[]; unreachable: string[]; files: number; probed: number; removed: number; errors: number; skippedRemoval: string[]; tookMs: number }

let running: Promise<ScanResult> | null = null;
let progress = { phase: "idle", done: 0, total: 0 };
export const scanProgress = () => ({ ...progress, running: !!running });
export const scanRunning = () => !!running;

const RETRY_ERRORS_MS = 12 * 3_600_000;

/**
 * Scans the library roots: new or changed files (size/mtime) are probed, files that couldn't be read are retried
 * after 12 h, gone ones removed. `full` re-probes everything. Probing runs two at a time.
 * Removal is skipped for a root whose walk hit errors, came back empty, or lost more than 20% of its files at once
 * (an unmounted or flaky share must never wipe the records).
 */
export function scanLibrary(opts: { full?: boolean; probe?: typeof probeFile; roots?: string[] } = {}): Promise<ScanResult> {
  if (running) return running;
  running = (async (): Promise<ScanResult> => {
    const started = Date.now();
    const probe = opts.probe ?? probeFile;
    const roots = opts.roots ?? libraryRoots();
    const res: ScanResult = { roots, unreachable: [], files: 0, probed: 0, removed: 0, errors: 0, skippedRemoval: [], tookMs: 0 };
    progress = { phase: "walking", done: 0, total: 0 };
    setJob("file scan", "running", `Walking ${roots.length} library folders`);
    const found: { arr: string; root: string; local: string; size: number; mtime: number; sidecars: MediaRecord["sidecars"] }[] = [];
    const walked = new Map<string, { files: number; failures: number }>();
    for (const root of roots) {
      const local = localPath(root);
      if (!local) {
        res.unreachable.push(root);
        continue;
      }
      const st: WalkState = { files: [], side: new Map(), failures: 0 };
      await walk(local, 8, st);
      walked.set(keyOf(root), { files: st.files.length, failures: st.failures });
      for (const f of st.files) found.push({ arr: `${keyOf(root)}/${path.relative(local, f.file).replace(/\\/g, "/")}`, root: keyOf(root), local: f.file, size: f.size, mtime: f.mtime, sidecars: sidecarsOf(f.file, st.side) });
    }
    res.files = found.length;
    const known = new Map((db.prepare("SELECT path, size, mtime, probed_at, sidecars, error FROM media_files").all() as { path: string; size: number; mtime: number; probed_at: number | null; sidecars: string; error: string | null }[]).map((r) => [r.path, r]));
    const todo = found.filter((f) => {
      const k = known.get(f.arr);
      return opts.full || !k || k.size !== f.size || k.mtime !== f.mtime || !k.probed_at || (!!k.error && started - k.probed_at > RETRY_ERRORS_MS);
    });
    // Sidecars can change without the video changing; mark everything seen.
    const setSide = db.prepare("UPDATE media_files SET sidecars = ? WHERE path = ?");
    const seen = db.prepare("UPDATE media_files SET seen_at = ? WHERE path = ?");
    tx(db, () => {
      for (const f of found) {
        const k = known.get(f.arr);
        if (!k) continue;
        const sc = JSON.stringify(f.sidecars);
        if (sc !== k.sidecars) setSide.run(sc, f.arr);
        seen.run(started, f.arr);
      }
    });
    progress = { phase: "probing", done: 0, total: todo.length };
    const upsert = db.prepare(
      `INSERT INTO media_files (path, root, size, mtime, probed_at, duration, container, video, audio, subs, sidecars, error, seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET root = excluded.root, size = excluded.size, mtime = excluded.mtime, probed_at = excluded.probed_at, duration = excluded.duration,
         container = excluded.container, video = excluded.video, audio = excluded.audio, subs = excluded.subs, sidecars = excluded.sidecars, error = excluded.error, seen_at = excluded.seen_at`,
    );
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, todo.length) }, async () => {
        while (i < todo.length) {
          const f = todo[i++];
          let rec: Awaited<ReturnType<typeof probeFile>> | null = null;
          let error: string | null = null;
          try {
            rec = await probe(f.local);
          } catch (e) {
            error = (e as Error).message;
            res.errors++;
          }
          upsert.run(f.arr, f.root, f.size, f.mtime, Date.now(), rec?.duration ?? null, rec?.container ?? null, JSON.stringify(rec?.video ?? null), JSON.stringify(rec?.audio ?? []), JSON.stringify(rec?.subs ?? []), JSON.stringify(f.sidecars), error, started);
          res.probed++;
          progress.done++;
          if (progress.done % 200 === 0) setJob("file scan", "running", `Probed ${progress.done} of ${todo.length} new or changed files`);
        }
      }),
    );
    // Files no longer on disk, only for roots whose walk was clean and plausible.
    for (const [root, w] of walked) {
      const had = (db.prepare("SELECT COUNT(*) AS n FROM media_files WHERE root = ?").get(root) as { n: number }).n;
      const gone = (db.prepare("SELECT COUNT(*) AS n FROM media_files WHERE root = ? AND seen_at < ?").get(root, started) as { n: number }).n;
      if (w.failures || (w.files === 0 && had > 0) || (had > 20 && gone > had * 0.2)) {
        if (gone) res.skippedRemoval.push(root);
        continue;
      }
      res.removed += Number(db.prepare("DELETE FROM media_files WHERE root = ? AND seen_at < ?").run(root, started).changes);
    }
    // Roots that aren't library roots any more (moved or removed in Sonarr/Radarr).
    if (!opts.roots && roots.length) {
      const current = new Set(roots.map(keyOf));
      for (const r of db.prepare("SELECT DISTINCT root FROM media_files").all() as { root: string }[]) if (!current.has(r.root)) res.removed += Number(db.prepare("DELETE FROM media_files WHERE root = ?").run(r.root).changes);
    }
    summaryCache = null;
    res.tookMs = Date.now() - started;
    setJob(
      "file scan",
      res.unreachable.length && !walked.size ? "error" : "done",
      `${res.files} files in ${walked.size} folders; ${res.probed} probed, ${res.removed} removed, ${res.errors} errors${res.skippedRemoval.length ? `; removal skipped for ${res.skippedRemoval.join(", ")} (incomplete walk)` : ""}${res.unreachable.length ? `; not reachable: ${res.unreachable.join(", ")}` : ""}`,
    );
    return res;
  })().finally(() => {
    running = null;
    progress = { phase: "idle", done: 0, total: 0 };
  });
  return running;
}

// ---------------------------------------------------------------- reading the records

interface Row { path: string; root: string; size: number; mtime: number; probed_at: number | null; duration: number | null; container: string | null; video: string; audio: string; subs: string; sidecars: string; error: string | null }
const toRecord = (r: Row) => ({
  path: r.path,
  root: r.root,
  size: r.size,
  mtime: r.mtime,
  probedAt: r.probed_at,
  duration: r.duration,
  container: r.container,
  video: JSON.parse(r.video) as MediaRecord["video"],
  audio: JSON.parse(r.audio) as AudioTrack[],
  subs: applyOverrides(r.path, JSON.parse(r.subs) as SubTrack[]),
  sidecars: JSON.parse(r.sidecars) as MediaRecord["sidecars"],
  error: r.error,
});
export type FileRecord = ReturnType<typeof toRecord>;

let byPath: ReturnType<typeof db.prepare> | null = null;
/** AnimeArr's record of a file (null when not scanned, unreadable, or — given the size the *arr has — out of date). */
export function recordFor(arrPath: string, expectSize?: number | null): FileRecord | null {
  byPath ??= db.prepare("SELECT * FROM media_files WHERE path = ?");
  const r = byPath.get(keyOf(arrPath)) as Row | undefined;
  if (!r || !r.probed_at || r.error) return null;
  if (expectSize && r.size !== expectSize) return null;
  return toRecord(r);
}

/** A record in the shape the language judge uses (forced-only tracks never count as subtitles). */
export function probeOf(rec: FileRecord) {
  const full = new Set<string>();
  const partial = new Set<string>();
  let untagged = 0;
  for (const s of rec.subs) {
    if (!s.lang) untagged++;
    else if (s.partial) partial.add(s.lang);
    else full.add(s.lang);
  }
  return {
    subs: [...full],
    audio: [...new Set(rec.audio.map((a) => a.lang).filter((l): l is string => !!l))],
    durationSec: rec.duration,
    sidecars: rec.sidecars.filter((s) => s.lang && !s.forced).map((s) => s.lang!),
    untagged,
    forced: [...partial].filter((l) => !full.has(l)),
  };
}

let summaryCache: { key: string; forcedOnly: number; samples: string[] } | null = null;
/** Summary for the System page: counts, problems worth a look (the forced-only count is cached until files change). */
export function fileSummary() {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const roots = db.prepare("SELECT root, COUNT(*) AS n, SUM(size) AS bytes FROM media_files GROUP BY root ORDER BY root").all() as { root: string; n: number; bytes: number }[];
  const stamp = db.prepare("SELECT COUNT(*) AS n, MAX(probed_at) AS m FROM media_files").get() as { n: number; m: number | null };
  const key = `${stamp.n}:${stamp.m}`;
  if (!summaryCache || summaryCache.key !== key) {
    let count = 0;
    const samples: string[] = [];
    for (const r of db.prepare(`SELECT path, subs, sidecars FROM media_files WHERE probed_at IS NOT NULL AND error IS NULL AND subs LIKE '%"partial":true%'`).all() as { path: string; subs: string; sidecars: string }[]) {
      const subs = JSON.parse(r.subs) as SubTrack[];
      const side = JSON.parse(r.sidecars) as MediaRecord["sidecars"];
      const fullEn = subs.some((x) => x.lang === "en" && !x.partial) || side.some((x) => x.lang === "en" && !x.forced);
      if (!fullEn && subs.some((x) => x.lang === "en" && x.partial)) {
        count++;
        if (samples.length < 20) samples.push(r.path);
      }
    }
    summaryCache = { key, forcedOnly: count, samples };
  }
  const forcedOnly = summaryCache.forcedOnly;
  const forcedSamples = summaryCache.samples;
  return {
    roots: libraryRoots(),
    byRoot: roots,
    total: n("SELECT COUNT(*) AS n FROM media_files"),
    probed: n("SELECT COUNT(*) AS n FROM media_files WHERE probed_at IS NOT NULL AND error IS NULL"),
    errors: n("SELECT COUNT(*) AS n FROM media_files WHERE error IS NOT NULL"),
    errorSamples: (db.prepare("SELECT path, error FROM media_files WHERE error IS NOT NULL LIMIT 20").all() as { path: string; error: string }[]),
    forcedOnlyEnglish: forcedOnly,
    forcedSamples,
    lastScan: (cache.prepare("SELECT state, detail, finished_at FROM jobs WHERE name = 'file scan'").get() as { state: string; detail: string; finished_at: number } | undefined) ?? null,
    progress: scanProgress(),
  };
}

/** Scheduler hook (every 30 min): walk and stat everything, probe only what's new or changed (size/mtime). */
export async function fileScanTick() {
  if (dbState.corrupt || !getSettings().library.scan) return;
  await scanLibrary();
}

// ---------------------------------------------------------------- one folder at a time (Refresh & scan, after an import)

const folderScans = new Map<string, number>();
export const lastFolderScan = (arrFolder: string) => folderScans.get(keyOf(arrFolder)) ?? 0;

/**
 * Walks one show/movie folder and probes new or changed files right away (Refresh & scan, after an import, when a
 * series page opens). Records keep the library root they belong to; removal only inside this folder, and only after
 * a clean walk.
 */
export async function scanFolder(arrFolder: string, probe: typeof probeFile = probeFile): Promise<{ files: number; probed: number; removed: number }> {
  const folder = keyOf(arrFolder);
  folderScans.set(folder, Date.now());
  const local = localPath(arrFolder);
  if (!local) return { files: 0, probed: 0, removed: 0 };
  const root = libraryRoots().map(keyOf).find((r) => folder === r || folder.startsWith(`${r}/`)) ?? folder;
  const st: WalkState = { files: [], side: new Map(), failures: 0 };
  await walk(local, 6, st);
  const started = Date.now();
  const found = st.files.map((f) => ({ arr: `${folder}/${path.relative(local, f.file).split(path.sep).join("/")}`, local: f.file, size: f.size, mtime: f.mtime, sidecars: sidecarsOf(f.file, st.side) }));
  const known = new Map((db.prepare("SELECT path, size, mtime, probed_at, error FROM media_files WHERE substr(path, 1, ?) = ?").all(folder.length + 1, `${folder}/`) as { path: string; size: number; mtime: number; probed_at: number | null; error: string | null }[]).map((r) => [r.path, r]));
  const upsert = db.prepare(
    `INSERT INTO media_files (path, root, size, mtime, probed_at, duration, container, video, audio, subs, sidecars, error, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, probed_at = excluded.probed_at, duration = excluded.duration, container = excluded.container,
       video = excluded.video, audio = excluded.audio, subs = excluded.subs, sidecars = excluded.sidecars, error = excluded.error, seen_at = excluded.seen_at`,
  );
  let probed = 0;
  for (const f of found) {
    const k = known.get(f.arr);
    if (k && k.size === f.size && k.mtime === f.mtime && k.probed_at && !k.error) {
      db.prepare("UPDATE media_files SET seen_at = ?, sidecars = ? WHERE path = ?").run(started, JSON.stringify(f.sidecars), f.arr);
      continue;
    }
    let rec: Awaited<ReturnType<typeof probeFile>> | null = null;
    let error: string | null = null;
    try {
      rec = await probe(f.local);
    } catch (e) {
      error = (e as Error).message;
    }
    upsert.run(f.arr, root, f.size, f.mtime, Date.now(), rec?.duration ?? null, rec?.container ?? null, JSON.stringify(rec?.video ?? null), JSON.stringify(rec?.audio ?? []), JSON.stringify(rec?.subs ?? []), JSON.stringify(f.sidecars), error, started);
    probed++;
  }
  let removed = 0;
  if (!st.failures) for (const p of known.keys()) if (!found.some((f) => f.arr === p)) removed += Number(db.prepare("DELETE FROM media_files WHERE path = ?").run(p).changes);
  summaryCache = null;
  return { files: found.length, probed, removed };
}

/**
 * AnimeArr's record of a file, judged against what the *arr knows: the record wins when it matches the *arr's size
 * or is newer than the *arr's import (e.g. Tdarr rewrote the file). An older, different record is stale.
 */
export function ownFile(arrPath: string, arr: { size?: number | null; dateAdded?: string | null } = {}): FileRecord | null {
  const rec = recordFor(arrPath);
  if (!rec) return null;
  if (!arr.size || rec.size === arr.size) return rec;
  const added = arr.dateAdded ? Date.parse(arr.dateAdded) : NaN;
  return Number.isFinite(added) && rec.mtime > added ? rec : null;
}
