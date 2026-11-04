import fs from "node:fs";
import path from "node:path";
import { getSettings, type PathMapping } from "./settings.js";

function apply(p: string, maps: PathMapping[]): string | null {
  const norm = p.replace(/\\/g, "/");
  // Longest prefix wins.
  const m = [...maps]
    .sort((a, b) => b.from.length - a.from.length)
    .find((x) => {
      const f = x.from.replace(/\\/g, "/").replace(/\/+$/, "");
      return norm === f || norm.startsWith(`${f}/`);
    });
  if (!m) return null;
  const f = m.from.replace(/\\/g, "/").replace(/\/+$/, "");
  return m.to.replace(/[\\/]+$/, "") + norm.slice(f.length);
}

/** Sonarr/client path → a path this machine can open, or null when no mapping applies (or it isn't reachable). */
export function localPath(p: string): string | null {
  const mapped = apply(p, getSettings().localPathMappings);
  const candidate = mapped ?? p;
  try {
    fs.accessSync(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Is this file (a Sonarr/library path) certainly gone? Only when its folder lists something and not it, or the
 * folder is missing and the nearest folder above it that exists (at or inside its library root) answers with content.
 * An unmounted share (a missing or empty mount point, also one mounted below the root), a permission error or any
 * other read error means "can't tell", never "gone".
 */
export function fileSurelyGone(p: string): boolean {
  const local = mappedPath(p);
  try {
    const names = fs.readdirSync(path.dirname(local));
    if (!names.length) return false; // an empty folder may be an unmounted mount point: can't tell
    return !names.includes(path.basename(local));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false; // EACCES, EIO, a dead mount: can't tell
  }
  const root = getSettings()
    .allowedRoots.map(keyOf)
    .find((r) => keyOf(p).startsWith(`${r}/`));
  if (!root) return false;
  // Climb from the missing folder towards the root; the first folder that exists must list something.
  for (let dir = path.posix.dirname(path.posix.dirname(keyOf(p))); dir.length >= root.length; dir = path.posix.dirname(dir)) {
    try {
      return fs.readdirSync(mappedPath(dir)).length > 0;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return false; // can't tell
    }
    if (dir === root) break;
  }
  return false; // even the root is missing: an unmounted share
}

/** Sonarr/library path → this machine's path, by the mappings only (for files that don't exist yet). */
export function mappedPath(p: string): string {
  return apply(p, getSettings().localPathMappings) ?? p;
}

/** Download-client path → Sonarr path (remote path mappings); unchanged when none applies. */
export function clientToSonarr(p: string): string {
  return apply(p, getSettings().remotePathMappings) ?? p.replace(/\\/g, "/");
}

/** Record keys use forward slashes, whatever OS the *arr runs on. */
export const keyOf = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
