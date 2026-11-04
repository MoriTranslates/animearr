/**
 * One guard for deletes, import sources and the recycling bin: is a path a protected folder, inside one, or holding
 * one? Protected: the library roots, the allowed roots and AnimeArr's own folder (and, for import sources, the bin).
 * Compared by real path (links and other mount names resolved; a folder that doesn't exist yet by its deepest existing
 * part) and, on Windows, without case. Both directions, always: a folder holding the library is as dangerous as one
 * inside it.
 */
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../system/db.js";
import { mappedPath } from "../system/paths.js";
import { getSettings } from "../system/settings.js";
import { libraryRoots } from "./mediafiles.js";

/** The real path of a local path, for comparing folders (see the module note). */
export function realish(p: string) {
  let head = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      head = fs.realpathSync.native(head);
      break;
    } catch {
      const up = path.dirname(head);
      if (up === head) break; // nothing exists up to the disk root: compare the path as given
      rest.unshift(path.basename(head));
      head = up;
    }
  }
  const full = path.join(head, ...rest);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

/** One folder is, is inside, or contains the other (both already realish). */
export function overlaps(a: string, b: string) {
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

const localOf = (arr: string) => realish(path.resolve(mappedPath(arr.replace(/[\\/]+$/, ""))));

/** The library and allowed roots, as this machine sees them (realish). */
export function libraryFolders() {
  return [...libraryRoots(), ...getSettings().allowedRoots].map(localOf);
}

/** AnimeArr's own folder (settings, databases, backups), realish. */
export const configFolder = () => realish(CONFIG_DIR);

/**
 * True when the local path `p` is, is inside, or holds a library or allowed root or AnimeArr's own folder; with
 * `bin`, the recycling bin counts too.
 */
export function touchesProtected(p: string, opts: { bin?: boolean } = {}) {
  const r = realish(p);
  const bin = opts.bin ? getSettings().media.recycleBin.trim() : "";
  return [...libraryFolders(), configFolder(), ...(bin ? [localOf(bin)] : [])].some((x) => overlaps(r, x));
}
