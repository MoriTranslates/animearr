/**
 * Malware blocker (Cleanuparr-style): spots downloads that are not what they claim to be, from file names and sizes
 * alone (nothing is opened or executed). Rules, in order:
 *   1. a file with a dangerous extension (Settings → malware.extensions: .exe .scr .bat … ), anywhere in the download;
 *   2. a double extension: a video name followed by another extension (episode.mkv.exe, episode.mkv.zip);
 *   3. a video file far too small for the episode's runtime (a "video" that is really a stub or a decoy).
 * A password-protected archive where a video is expected is caught when the unpacking finds it (pipeline.ts).
 * The checker is pure; pipeline.ts acts on a verdict (remove from the client, blocklist, search the next release).
 */
import fs from "node:fs";
import path from "node:path";
import { getSettings } from "./settings.js";

export interface FileInfo { name: string; size: number }

const VIDEO_EXT = "mkv|mp4|avi|m4v|ts|webm|mov|wmv|flv|mpg|mpeg";
const VIDEO = new RegExp(`\\.(${VIDEO_EXT})$`, "i");
/** A video extension followed by something else: harmless sidecar and partial-download endings are fine. */
const DOUBLE = new RegExp(`\\.(${VIDEO_EXT})\\.([a-z0-9!_-]{1,8})$`, "i");
const HARMLESS_AFTER_VIDEO = new Set(["srt", "ass", "ssa", "sub", "idx", "vtt", "nfo", "jpg", "jpeg", "png", "txt", "sfv", "md5", "part", "!qb", "!ut", "bak", "bc!", "crdownload", "aria2", "tmp"]);
/** Sample, trailer and creditless/extra clips are legitimately short. */
const SHORT_OK = /(?<![a-z])(sample|trailer|promo|pv|cm|preview|nc ?op|nc ?ed|creditless|opening|ending|extras?|menu|teaser)(?![a-z])/i;

/** The smallest plausible video: 64 kbit/s for the episode's runtime (20 minutes when unknown). */
export const MIN_VIDEO_KBPS = 64;
export const minVideoBytes = (runtimeMin: number | null | undefined) => Math.max(1, runtimeMin && runtimeMin > 0 ? runtimeMin : 20) * 60 * (MIN_VIDEO_KBPS * 125);

/** The settings' extension list, as bare lowercase extensions ("EXE", ".exe" → "exe"). */
export const dangerousExtensions = (list: string[] = getSettings().malware.extensions) => [...new Set(list.map((x) => x.trim().replace(/^\./, "").toLowerCase()).filter(Boolean))];

const base = (name: string) => name.replace(/\\/g, "/").split("/").pop() ?? name;

/**
 * Looks through a download's file list. Returns the first problem as a plain sentence ("contained Episode 05.mkv.lnk"),
 * or null when it looks fine. `runtimeMin` is the episode's runtime (null = unknown) for the too-small check.
 */
export function inspectFiles(files: FileInfo[], opts: { extensions?: string[]; runtimeMin?: number | null } = {}): string | null {
  const bad = new Set(dangerousExtensions(opts.extensions));
  for (const f of files) {
    const n = base(f.name);
    const ext = /\.([^.\\/]+)$/.exec(n)?.[1]?.toLowerCase() ?? "";
    if (bad.has(ext)) return `contained ${n}`;
    const dbl = DOUBLE.exec(n);
    if (dbl && !HARMLESS_AFTER_VIDEO.has(dbl[2].toLowerCase())) return `contained ${n} (a video name with a second extension)`;
  }
  const floor = minVideoBytes(opts.runtimeMin);
  for (const f of files) {
    const n = base(f.name);
    if (!VIDEO.test(n) || SHORT_OK.test(n) || f.size <= 0) continue;
    if (f.size < floor) return `contained ${n}, a video of only ${f.size < 1024 * 1024 ? `${Math.max(1, Math.round(f.size / 1024))} KB` : `${(f.size / 1048576).toFixed(1)} MB`}, far too small for an episode`;
  }
  return null;
}

/** Every file under a download folder (or the one file), sizes included. Symlinks are not followed; depth-limited. */
export function walkFiles(local: string, skip: (rel: string) => boolean = () => false, depth = 0, rel = ""): FileInfo[] {
  try {
    const st = fs.lstatSync(local);
    if (st.isSymbolicLink()) return [];
    if (!st.isDirectory()) return [{ name: rel || path.basename(local), size: st.size }];
    if (depth > 5) return [];
    return fs.readdirSync(local).flatMap((n) => {
      const r = rel ? `${rel}/${n}` : n;
      return skip(r) ? [] : walkFiles(path.join(local, n), skip, depth + 1, r);
    });
  } catch {
    return [];
  }
}
