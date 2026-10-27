/**
 * Which folders may be a library ("allowed root") folder. AnimeArr's own data folder (/config) was the only writable
 * folder a fresh container offered, so a new user put his library in it; system folders are never a library either.
 */
import path from "node:path";

/** Top-level system folders of a Linux container (never a library; hidden in the folder browser at "/"). */
export const SYSTEM_DIRS = new Set(["proc", "sys", "dev", "run", "etc", "usr", "bin", "sbin", "lib", "lib32", "lib64", "libx32", "boot", "var", "tmp", "opt", "srv", "root", "home", "app", "lost+found", "snap"]);
/** Folders whose insides are never a library (/home/me/Anime or /srv/media can be, so those only refuse themselves). */
const SYSTEM_DEEP = new Set(["proc", "sys", "dev", "run", "etc", "usr", "bin", "sbin", "lib", "lib32", "lib64", "libx32", "boot", "tmp", "app", "lost+found", "snap"]);
/** Removable-media mount points a base image ships with (/media/cdrom, /mnt/usb…): hidden anywhere near the top. */
export const DEVICE_DIRS = /^(cdrom\d*|floppy\d*|usb\d*|dvd\d*|cdrw|zip)$/i;

const norm = (p: string) => path.posix.normalize(p.trim()).replace(/\/+$/, "") || "/";
const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

/** Why `p` can't be a library folder (a sentence for the user), or null when it can. */
export function rootRefusal(p: string, configDir: string): string | null {
  if (!p.trim().startsWith("/")) return `"${p}" isn't a full folder path (it should start with /).`;
  const r = norm(p);
  if (r === "/") return "The whole disk (/) can't be a library folder. Pick the folder your anime goes in, e.g. /media/Anime.";
  const conf = norm(configDir);
  if (inside(r, conf) || inside(r, "/config") || inside(conf, r))
    return `${r} is AnimeArr's own data folder (settings, database, backups), not a place for your library. Pick the folder your anime goes in, e.g. /media/Anime. If you don't see one, add it to the container first (a path mapping in the Docker/Unraid template).`;
  const parts = r.split("/").filter(Boolean);
  if (SYSTEM_DEEP.has(parts[0]) || (parts.length === 1 && SYSTEM_DIRS.has(parts[0]))) return `${r} is a system folder inside the container, not a library folder. Pick the folder your anime goes in, e.g. /media/Anime.`;
  if (parts.some((x) => DEVICE_DIRS.test(x)) && parts.length <= 2) return `${r} is a placeholder for a CD or USB drive, not a library folder.`;
  return null;
}

/** Folder-browser entries to hide under `dir` (system folders at "/", CD/floppy/USB placeholders near the top). */
export function hiddenInBrowser(dir: string, name: string) {
  const d = norm(dir);
  if (d === "/" && SYSTEM_DIRS.has(name)) return true;
  return DEVICE_DIRS.test(name) && d.split("/").filter(Boolean).length <= 1;
}
