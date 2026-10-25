/**
 * Archive extraction (Unpackerr-style) for torrents that arrive as RAR/7z/ZIP archives instead of video files.
 * SABnzbd unpacks by itself. Each grab unpacks into its own folder `<download>/_animearr_unpacked/<grabId>`, first
 * as `<grabId>.tmp` and renamed only when every archive succeeded (so a half-finished unpack is never imported).
 * Sonarr imports the unpacked files with "move" (the archives keep seeding); the folder is removed afterwards, and
 * also when the release fails.
 *
 * Unpacking runs in the background: the pipeline tick polls it instead of waiting up to an hour.
 *
 * Safety: archive contents are listed first (sizes must fit the free space and not look like a bomb), symlinks in
 * the result reject the archive, and archive paths are passed after `--`.
 *
 * Needs write access to the download folder and 7-Zip (7zz). Alpine's 7-Zip has no RAR codec: RAR sets then need
 * attention instead of failing the release.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const UNPACK_DIR = "_animearr_unpacked";
const VIDEO = /\.(mkv|mp4|avi|m4v|ts|webm)$/i;
const ARCHIVE = /\.(rar|zip|7z)$|\.(7z|zip)\.\d{3}$/i;
const MIN_VIDEO = 30e6;

export type ExtractOutcome =
  | { kind: "none" } // videos present (or no archives): nothing to do
  | { kind: "pending" } // unpacking in the background
  | { kind: "extracted"; dest: string; files: string[] } // files relative to the download folder
  | { kind: "broken"; why: string } // the release's fault: blocklist + next candidate
  | { kind: "unavailable"; why: string }; // our side (no extractor/codec, read-only folder, no space): needs attention

/** All files under dir (a few levels deep), relative paths, symlinks reported separately. */
function walk(dir: string, depth = 4, rel = ""): { files: string[]; links: string[] } {
  const out = { files: [] as string[], links: [] as string[] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) out.links.push(r);
    else if (e.isDirectory()) {
      if (depth > 0) {
        const sub = walk(dir, depth - 1, r);
        out.files.push(...sub.files);
        out.links.push(...sub.links);
      }
    } else out.files.push(r);
  }
  return out;
}

/** First volumes only: x.rar / x.part01.rar (not .part02.rar or old-style .r00), x.zip, x.7z, x.7z.001 / x.zip.001. */
export function firstVolumes(files: string[]) {
  return files.filter((f) => {
    if (!ARCHIVE.test(f) || /\bsample\b/i.test(f) || f.startsWith(`${UNPACK_DIR}/`)) return false;
    const part = /\.part0*(\d+)\.rar$/i.exec(f);
    if (part) return Number(part[1]) === 1;
    const split = /\.(?:7z|zip)\.(\d{3})$/i.exec(f);
    return !split || Number(split[1]) === 1;
  });
}

const sizeOf = (f: string) => {
  try {
    return fs.statSync(f).size;
  } catch {
    return 0;
  }
};

interface RunError extends Error { code?: string | number; killed?: boolean; stderr?: string; stdout?: string }
function run(tool: string, args: string[], timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    execFile(tool, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err as RunError, { stderr: String(stderr ?? ""), stdout: String(stdout ?? "") }));
      else resolve(String(stdout));
    });
  });
}

const PW = "-pANIMEARR-NO-PASSWORD"; // an encrypted archive fails at once instead of waiting for input
const ourSide = (msg: string) => /space|ENOSPC|memory|Unsupported|Can ?not open the file as archive|Permission denied|EACCES|EROFS/i.test(msg);

async function unpackAll(localDir: string, archives: string[], tmp: string, tool: string, timeoutMs: number): Promise<ExtractOutcome> {
  // List first: total size must fit (and not look like an archive bomb).
  let total = 0;
  for (const a of archives) {
    try {
      const out = await run(tool, ["l", "-slt", "-ba", PW, "--", path.resolve(localDir, a)], 5 * 60_000);
      for (const m of out.matchAll(/^Size = (\d+)$/gm)) total += Number(m[1]);
    } catch (e) {
      const err = e as RunError;
      if (err.code === "ENOENT") return { kind: "unavailable", why: `the 7-Zip program (${tool}) isn't installed` };
      const msg = `${err.stderr ?? ""}\n${err.stdout ?? ""}\n${err.message}`;
      if (/wrong password|encrypted/i.test(msg)) return { kind: "broken", why: `${path.basename(a)} is password-protected` };
      if (/\.rar$/i.test(a) && /Unsupported|Can ?not open/i.test(msg)) return { kind: "unavailable", why: "this 7-Zip can't read RAR archives (Alpine's 7-Zip has no RAR codec); unpack it by hand, or see the extraction note in Settings" };
      if (ourSide(msg)) return { kind: "unavailable", why: `couldn't read ${path.basename(a)} (${msg.trim().split("\n").find((l) => l.trim())})` };
      return { kind: "broken", why: `${path.basename(a)} is damaged or not an archive` };
    }
  }
  const packed = archives.reduce((n, a) => n + sizeOf(path.resolve(localDir, a)), 0);
  if (packed && total > Math.max(packed * 20, 2e9)) return { kind: "broken", why: `the archives would unpack to ${(total / 1e9).toFixed(1)} GB from ${(packed / 1e9).toFixed(1)} GB (looks like an archive bomb)` };
  try {
    const st = fs.statfsSync(localDir);
    if (total > st.bavail * st.bsize) return { kind: "unavailable", why: `not enough free space to unpack (${(total / 1e9).toFixed(1)} GB needed)` };
  } catch {
    /* statfs unsupported: carry on */
  }
  try {
    fs.mkdirSync(tmp, { recursive: true });
  } catch (e) {
    return { kind: "unavailable", why: `can't write to the download folder to unpack it (${(e as Error).message})` };
  }
  for (const a of archives) {
    // Each archive into its own subfolder (mirrors where it was), so same-named files in two archives don't collide.
    const out = path.join(tmp, path.posix.dirname(a) === "." ? "" : path.posix.dirname(a));
    try {
      await run(tool, ["x", "-aou", "-bd", "-bso0", "-bsp0", PW, `-o${out}`, "--", path.resolve(localDir, a)], timeoutMs);
    } catch (e) {
      const err = e as RunError;
      const msg = `${err.stderr ?? ""}\n${err.message}`;
      const produced = walk(out).files.some((f) => VIDEO.test(f));
      if (err.code === 1 && produced) continue; // exit 1 = warnings only (e.g. data after the end of the archive)
      if (err.code === "ENOENT") return { kind: "unavailable", why: `the 7-Zip program (${tool}) isn't installed` };
      if (err.killed) return { kind: "unavailable", why: `unpacking ${path.basename(a)} took longer than ${Math.round(timeoutMs / 60_000)} min` };
      if (/wrong password|encrypted/i.test(msg)) return { kind: "broken", why: `${path.basename(a)} is password-protected` };
      if (ourSide(msg)) return { kind: "unavailable", why: `couldn't unpack ${path.basename(a)} (${msg.trim().split("\n").find((l) => l.trim())})` };
      return { kind: "broken", why: `couldn't unpack ${path.basename(a)}: ${msg.trim().split("\n").find((l) => /error/i.test(l))?.trim() ?? "damaged archive"}` };
    }
  }
  const res = walk(tmp, 6);
  if (res.links.length) return { kind: "broken", why: `the archive contains links (${res.links[0]}); refused for safety` };
  if (!res.files.some((f) => VIDEO.test(f))) return { kind: "broken", why: "the archives contain no video files" };
  return { kind: "extracted", dest: tmp, files: [] };
}

const jobs = new Map<string, Promise<ExtractOutcome>>();
const results = new Map<string, ExtractOutcome>();

/**
 * Polled by the pipeline for a finished download folder: "none" when there's nothing to unpack, "pending" while
 * unpacking in the background, then the outcome (once). A finished unpack (renamed into place) is reused, so "Retry
 * import" doesn't unpack twice; a leftover `.tmp` (restart mid-unpack) is discarded and redone.
 */
export function extractIfNeeded(localDir: string, key: string, opts: { tool?: string; timeoutMs?: number; only?: string[] } = {}): Promise<ExtractOutcome> | ExtractOutcome {
  const dest = path.join(localDir, UNPACK_DIR, key);
  const tmp = `${dest}.tmp`;
  const relFiles = (dir: string) => walk(dir, 6).files.filter((f) => VIDEO.test(f)).map((f) => path.posix.join(UNPACK_DIR, key, f));
  const done = results.get(dest);
  if (done) {
    results.delete(dest);
    return done.kind === "extracted" ? { kind: "extracted", dest, files: relFiles(dest) } : done;
  }
  if (jobs.has(dest)) return { kind: "pending" };
  if (fs.existsSync(dest)) {
    const files = relFiles(dest);
    if (files.length) return { kind: "extracted", dest, files };
  }
  // `only`: a single-file torrent that is itself an archive (its folder is the shared category folder).
  const all = opts.only ?? walk(localDir).files.filter((f) => !f.startsWith(`${UNPACK_DIR}/`));
  if (!opts.only && all.some((f) => VIDEO.test(f) && !/\bsample\b/i.test(f) && sizeOf(path.join(localDir, f)) > MIN_VIDEO)) return { kind: "none" };
  const archives = firstVolumes(all);
  if (!archives.length) return { kind: "none" };
  fs.rmSync(tmp, { recursive: true, force: true });
  const job = unpackAll(localDir, archives, tmp, opts.tool ?? process.env.ANIMEARR_7Z ?? "7zz", opts.timeoutMs ?? 60 * 60_000)
    .then((r) => {
      if (r.kind === "extracted") fs.renameSync(tmp, dest);
      else fs.rmSync(tmp, { recursive: true, force: true });
      return r;
    })
    .catch((e: Error): ExtractOutcome => {
      fs.rmSync(tmp, { recursive: true, force: true });
      return { kind: "unavailable", why: `unpacking failed: ${e.message}` };
    })
    .then((r) => {
      results.set(dest, r);
      jobs.delete(dest);
      return r;
    });
  jobs.set(dest, job);
  return { kind: "pending" };
}

/** Removes a grab's unpack folder (only ever `<…>/_animearr_unpacked/<key>`), and the parent when it's empty. */
export function cleanUnpacked(dest: string) {
  if (path.basename(path.dirname(dest)) !== UNPACK_DIR) return;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.rmSync(`${dest}.tmp`, { recursive: true, force: true });
  try {
    fs.rmdirSync(path.dirname(dest)); // only succeeds when empty
  } catch {
    /* other grabs still use it */
  }
}
