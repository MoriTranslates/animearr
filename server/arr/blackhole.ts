/**
 * Blackhole download clients (Usenet and Torrent), like Sonarr's: AnimeArr drops the .nzb / .torrent (or a .magnet
 * file, when allowed) into a watch folder and waits for the finished download to appear in a completed folder. Off by
 * default and never picked automatically while a real client of the same protocol is enabled, unless it is that
 * protocol's preferred client (clients.ts).
 *
 * What it can't do (shown on its Settings card): no progress, speed, ETA or seeders; no partial batch downloads; no
 * stall checks (only a timeout); can't pause/remove/clean up in the downloader or see seeding; finished downloads are
 * noticed by folder watching (size stable across two checks a minute apart); matched by release name only.
 */
import fs from "node:fs";
import path from "node:path";
import type { ClientCfg } from "../settings.js";
import type { ClientStatus } from "./clients.js";

export const isBlackhole = (type: string | null | undefined) => type === "blackhole-usenet" || type === "blackhole-torrent";

/** Names a downloader uses while it's still working on something. */
const TEMP = /(\.!qb|\.part|\.tmp|\.!ut|\.crdownload|\.nzb\.tmp|\.aria2)$/i;
const TEMP_PREFIX = /^(_UNPACK_|_FAILED_|\.)/i;
export const isTempName = (n: string) => TEMP.test(n) || TEMP_PREFIX.test(n);

/** File-name safe form of a release name (the watch file's name). */
export const sanitizeName = (name: string) => name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 200) || "release";
/** Release-name matching: lower-case letters and digits only, without a video/container extension. */
export const normName = (n: string) => n.toLowerCase().replace(/\.(mkv|mp4|avi|m4v|ts|webm|nzb|torrent|magnet)$/i, "").replace(/[^a-z0-9]+/g, "");

/** The job's ref: when it was dropped, and the release name it is matched by. */
export const bhRef = (at: number, name: string) => `${at}:${sanitizeName(name)}`;
const parseRef = (ref: string) => {
  const i = ref.indexOf(":");
  return { at: Number(ref.slice(0, i)) || 0, name: ref.slice(i + 1) };
};

export interface BlackholeDeps {
  /** AnimeArr/Sonarr path → local path (Settings → Paths). */
  local: (p: string) => string;
  /** The importer's source roots (the completed folder must be one of them, or inside one). */
  sourceRoots: () => string[];
  now: () => number;
}

/** Size of a file or folder (any temp-named file inside = still being written: -1). */
function sizeOrBusy(p: string, depth = 0): number {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  if (depth > 6) return 0;
  let total = 0;
  for (const n of fs.readdirSync(p)) {
    if (isTempName(n)) return -1;
    const s = sizeOrBusy(path.join(p, n), depth + 1);
    if (s < 0) return -1;
    total += s;
  }
  return total;
}

/** Last size seen per job (stability check: the same size twice, at least a minute apart). */
const seen = new Map<string, { size: number; at: number }>();
export const STABLE_MS = 60_000;

const under = (p: string, root: string) => {
  const a = path.resolve(p);
  const b = path.resolve(root);
  return a === b || a.startsWith(b + path.sep);
};

/** Folder checks for Test and for enabling: watch folder writable, completed folder readable and a source root. */
export function checkFolders(c: ClientCfg, deps: BlackholeDeps): string[] {
  const problems: string[] = [];
  if (!c.watchFolder) problems.push("set the watch folder");
  if (!c.completedFolder) problems.push("set the completed folder");
  if (problems.length) return problems;
  const watch = deps.local(c.watchFolder!);
  const done = deps.local(c.completedFolder!);
  try {
    if (!fs.statSync(watch).isDirectory()) problems.push(`the watch folder ${c.watchFolder} isn't a folder`);
    else fs.accessSync(watch, fs.constants.W_OK);
  } catch {
    problems.push(`AnimeArr can't write to the watch folder ${c.watchFolder}`);
  }
  try {
    if (!fs.statSync(done).isDirectory()) problems.push(`the completed folder ${c.completedFolder} isn't a folder`);
    else fs.accessSync(done, fs.constants.R_OK);
  } catch {
    problems.push(`AnimeArr can't read the completed folder ${c.completedFolder}`);
  }
  const roots = deps.sourceRoots().map((r) => r.replace(/\/+$/, ""));
  if (!roots.some((r) => c.completedFolder === r || c.completedFolder!.replace(/\/+$/, "").startsWith(`${r}/`)))
    problems.push(`add the completed folder ${c.completedFolder} to the importer's source roots (Settings → Media management → Importer)`);
  return problems;
}

function writeNew(dir: string, base: string, ext: string, data: Buffer | string) {
  for (let i = 0; i < 50; i++) {
    const file = path.join(dir, `${base}${i ? ` (${i})` : ""}${ext}`);
    try {
      fs.writeFileSync(file, data, { flag: "wx" }); // never overwrite
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error("too many files with this name in the watch folder");
}

export function blackholeDriver(deps: BlackholeDeps) {
  return {
    async test(c: ClientCfg) {
      const problems = checkFolders(c, deps);
      if (problems.length) throw new Error(`${c.name}: ${problems.join("; ")}`);
      return { version: "folder watch", categoryExists: true, categories: [] as string[] };
    },
    async addNzb(c: ClientCfg, data: Buffer, name: string) {
      if (!c.watchFolder) throw new Error(`${c.name} is not configured`);
      writeNew(deps.local(c.watchFolder), sanitizeName(name), ".nzb", data);
      return bhRef(deps.now(), name);
    },
    async addTorrent(c: ClientCfg, src: { data?: Buffer; magnet?: string }, name: string) {
      if (!c.watchFolder) throw new Error(`${c.name} is not configured`);
      const dir = deps.local(c.watchFolder);
      if (src.data) writeNew(dir, sanitizeName(name), ".torrent", src.data);
      else if (src.magnet) {
        // "refused" lets the grab fall back to the next torrent client (or the next release).
        if (!c.saveMagnets) throw new Error(`${c.name} refused a magnet-only release (turn on "Save magnet links as .magnet files" to take them)`);
        writeNew(dir, sanitizeName(name), ".magnet", src.magnet);
      } else throw new Error(`Nothing to send to ${c.name}`);
      return { ref: bhRef(deps.now(), name) };
    },
    async status(c: ClientCfg, ref: string): Promise<ClientStatus> {
      const { at, name } = parseRef(ref);
      const want = normName(name);
      const timeoutH = c.timeoutHours ?? 24;
      const waiting = (clientStatus = "Waiting for download…"): ClientStatus => ({ state: "queued", progress: 0, clientStatus, etaSec: null, speed: null, seeders: null });
      if (!c.completedFolder) return { state: "error", progress: 0, message: `${c.name} has no completed folder` };
      const done = deps.local(c.completedFolder);
      let entries: string[];
      try {
        entries = fs.readdirSync(done);
      } catch (e) {
        return { state: "error", progress: 0, message: `${c.name}: can't read the completed folder (${(e as Error).message})` };
      }
      const hit = entries.find((n) => !isTempName(n) && normName(n) === want);
      if (!hit) {
        seen.delete(ref);
        if (deps.now() - at > timeoutH * 3_600_000) return { state: "failed", progress: 0, message: `nothing named like it arrived in ${c.name}'s completed folder within ${timeoutH} h` };
        return waiting();
      }
      let size: number;
      try {
        size = sizeOrBusy(path.join(done, hit));
      } catch {
        return waiting();
      }
      const prev = seen.get(ref);
      const now = deps.now();
      if (size > 0 && prev && prev.size === size && now - prev.at >= STABLE_MS) {
        seen.delete(ref);
        return { state: "completed", progress: 1, path: `${c.completedFolder.replace(/\/+$/, "")}/${hit}`, clientStatus: "found in the completed folder" };
      }
      if (!prev || prev.size !== size) seen.set(ref, { size, at: now });
      return waiting("Waiting for download… (finishing)");
    },
    /** Only the watch file, while the downloader hasn't picked it up; AnimeArr can't remove it from your downloader. */
    async remove(c: ClientCfg, ref: string) {
      if (!c.watchFolder) return;
      const { name } = parseRef(ref);
      const dir = deps.local(c.watchFolder);
      for (const ext of [".nzb", ".torrent", ".magnet"]) {
        const f = path.join(dir, `${name}${ext}`);
        if (under(f, dir) && fs.existsSync(f)) fs.rmSync(f, { force: true });
      }
    },
  };
}

/** Where a blackhole job's finished download is (AnimeArr's path view), or null (after import, for the clean-up). */
export function findCompleted(c: ClientCfg, ref: string, local: (p: string) => string): string | null {
  if (!c.completedFolder) return null;
  const want = normName(parseRef(ref).name);
  try {
    const hit = fs.readdirSync(local(c.completedFolder)).find((n) => !isTempName(n) && normName(n) === want);
    return hit ? `${c.completedFolder.replace(/\/+$/, "")}/${hit}` : null;
  } catch {
    return null;
  }
}
