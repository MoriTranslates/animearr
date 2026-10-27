/**
 * AnimeArr's own recycling bin (media.recycleBin): what went in and when, the daily purge after
 * media.recycleBinCleanupDays (0 = keep forever, like Sonarr), and "Empty bin now".
 *
 * The time a file went into the bin is recorded when it is moved there (the file's own date is the original's), so the
 * retention counts from the move. Files already in the bin before this was recorded start their clock at the first
 * purge run. Only ever inside the configured bin folder; never when it's empty, "/", or a library/allowed root.
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import { logDecision } from "./activity.js";
import { getSettings } from "./settings.js";
import { mappedPath } from "./paths.js";
import { libraryRoots } from "./mediafiles.js";

const DAY = 86_400_000;

/** The bin's local folder, or why it can't be used. */
export function binFolder(): { local: string } | { error: string } {
  const bin = getSettings().media.recycleBin.trim().replace(/\/+$/, "");
  if (!bin) return { error: "no recycling bin is set" };
  const local = path.resolve(mappedPath(bin));
  const depth = local.split(/[\\/]+/).filter(Boolean).length;
  if (bin === "" || bin === "/" || depth < 2) return { error: `the recycling bin "${bin}" is too close to the root of the disk` };
  const roots = [...libraryRoots(), ...getSettings().allowedRoots].map((r) => path.resolve(mappedPath(r.replace(/\/+$/, ""))));
  if (roots.some((r) => r === local || r.startsWith(local + path.sep))) return { error: `the recycling bin "${bin}" is (or contains) a library folder` };
  return { local };
}

/** Called by the importer for every file it moves into the bin. */
export function noteBinned(localTarget: string, size: number, now = Date.now()) {
  db.prepare("INSERT OR REPLACE INTO recycle_log (path, at, size) VALUES (?, ?, ?)").run(path.resolve(localTarget), now, size);
}

function filesIn(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  let names: fs.Dirent[] = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) filesIn(p, out, depth + 1);
    else if (d.isFile()) out.push(p);
  }
  return out;
}

function removeEmptyDirs(dir: string, root: string) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) if (d.isDirectory() && !d.isSymbolicLink()) removeEmptyDirs(path.join(dir, d.name), root);
  if (dir !== root && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
}

/** Deletes what's older than the retention (or everything, for "Empty bin now"). */
export function purgeBin(opts: { all?: boolean; now?: number } = {}) {
  const now = opts.now ?? Date.now();
  const days = getSettings().media.recycleBinCleanupDays ?? 0;
  const bin = binFolder();
  if ("error" in bin) return { deleted: 0, bytes: 0, skipped: bin.error };
  if (!opts.all && days <= 0) return { deleted: 0, bytes: 0, skipped: "kept forever (cleanup days = 0)" };
  if (!fs.existsSync(bin.local)) return { deleted: 0, bytes: 0, skipped: null };
  const known = new Map((db.prepare("SELECT path, at FROM recycle_log").all() as { path: string; at: number }[]).map((r) => [r.path, r.at]));
  let deleted = 0;
  let bytes = 0;
  for (const f of filesIn(bin.local)) {
    const p = path.resolve(f);
    if (!p.startsWith(bin.local + path.sep)) continue;
    let at = known.get(p);
    if (at === undefined) {
      // In the bin before moves were recorded: its clock starts now.
      noteBinned(p, 0, now);
      at = now;
    }
    if (!opts.all && now - at < days * DAY) continue;
    try {
      const size = fs.statSync(p).size;
      fs.rmSync(p, { force: true });
      db.prepare("DELETE FROM recycle_log WHERE path = ?").run(p);
      deleted++;
      bytes += size;
    } catch {
      /* next run */
    }
  }
  // Rows for files that are gone (restored by hand) go too.
  for (const p of known.keys()) if (!fs.existsSync(p)) db.prepare("DELETE FROM recycle_log WHERE path = ?").run(p);
  try {
    removeEmptyDirs(bin.local, bin.local);
  } catch {
    /* harmless */
  }
  db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('binPurgedAt', ?)").run(String(now));
  if (deleted) logDecision("info", { why: `${opts.all ? "Emptied" : "Cleaned"} AnimeArr's recycling bin: deleted ${deleted} file${deleted === 1 ? "" : "s"} (${(bytes / 1e9).toFixed(1)} GB)${opts.all ? " (you asked)" : `, older than ${days} days`}` });
  return { deleted, bytes, skipped: null };
}

/** For Audit → Maintenance → Recycle: AnimeArr's own bin. */
export function binStatus(now = Date.now()) {
  const m = getSettings().media;
  const bin = binFolder();
  const days = m.recycleBinCleanupDays ?? 0;
  const last = Number((db.prepare("SELECT value FROM kv WHERE key = 'binPurgedAt'").get() as { value: string } | undefined)?.value ?? 0);
  if ("error" in bin) return { path: m.recycleBin, days, error: bin.error, files: 0, bytes: 0, nextPurge: null, oldest: null };
  const files = filesIn(bin.local);
  let bytes = 0;
  for (const f of files)
    try {
      bytes += fs.statSync(f).size;
    } catch {
      /* gone */
    }
  const oldest = (db.prepare("SELECT MIN(at) AS at FROM recycle_log").get() as { at: number | null }).at;
  return { path: m.recycleBin, days, error: null, files: files.length, bytes, nextPurge: days > 0 ? Math.max(now, (last || now) + DAY) : null, oldest };
}

let lastRun = 0;
/** Daily. */
export function binTick(now = Date.now()) {
  if (now - lastRun < DAY - 60_000) return;
  lastRun = now;
  purgeBin({ now });
}
