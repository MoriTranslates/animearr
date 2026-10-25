/**
 * Recycle bin (Sonarr parity). AnimeArr deletes and replaces library files through Sonarr, so Sonarr's recycle bin
 * (Settings → Media Management) is where they go. This module reports whether it's set up and, when the folder is
 * reachable, what's in it for anime shows (read-only; restoring is moving the file back by hand).
 *
 * Sonarr's layout: <bin>/<series folder>/[Season xx/]<file>, the file's mtime set to the deletion time. Its cleanup
 * removes a top-level folder once its newest file is older than recycleBinCleanupDays (a housekeeping task, so the
 * purge time is approximate).
 */
import fs from "node:fs/promises";
import path from "node:path";
import * as sonarr from "./arr/sonarr.js";
import { cache } from "./db.js";
import { localPath } from "./paths.js";
import { underAllowedRoot } from "./settings.js";

export interface RecycleItem { path: string; series: string | null; tvdbId: number | null; size: number; deletedAt: number; purgeAt: number | null }
export interface RecycleStatus { configured: boolean; path: string; cleanupDays: number; reachable: boolean; items: RecycleItem[]; totalCount: number; totalBytes: number; truncated: boolean; error?: string }

const TTL = 60_000;
const MAX_FILES = 3000;
const SHOWN = 300;

let cached: { at: number; v: { recycleBin?: string; recycleBinCleanupDays?: number } } | null = null;
/** Sonarr's recycle-bin setting. `fresh` skips the 1-minute cache (used right before and after a delete). */
export async function recycleSetting(get = sonarr.getMediaManagement, now = Date.now(), fresh = false) {
  if (fresh || !cached || now - cached.at > TTL) cached = { at: now, v: await get() };
  const bin = (cached.v.recycleBin ?? "").trim();
  return { configured: !!bin, path: bin, cleanupDays: cached.v.recycleBinCleanupDays ?? 0 };
}
export const resetRecycleCache = () => void (cached = null);

const MEDIA = /\.(mkv|mp4|avi|m4v|ts|webm|ass|srt|ssa|sup)$/i;

async function walk(root: string, rel: string, depth: number, out: { rel: string; size: number; mtime: number }[]) {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const r = `${rel}/${e.name}`;
    if (e.isDirectory() && depth > 0) await walk(root, r, depth - 1, out);
    else if (e.isFile() && MEDIA.test(e.name)) {
      try {
        const st = await fs.stat(path.join(root, r));
        out.push({ rel: r, size: st.size, mtime: st.mtimeMs });
      } catch {
        /* gone meanwhile */
      }
    }
  }
}

/** What's in Sonarr's recycle bin for anime shows in the allowed root folders, newest first. */
export async function recycleStatus(deps = { get: sonarr.getMediaManagement, localPath }, now = Date.now(), fresh = false): Promise<RecycleStatus> {
  const empty = { reachable: false, items: [], totalCount: 0, totalBytes: 0, truncated: false };
  let s: Awaited<ReturnType<typeof recycleSetting>>;
  try {
    s = await recycleSetting(deps.get, now, fresh);
  } catch (e) {
    return { configured: false, path: "", cleanupDays: 0, ...empty, error: (e as Error).message };
  }
  if (!s.configured) return { ...s, ...empty };
  const local = deps.localPath(s.path);
  if (!local) return { ...s, ...empty };
  // Folder names of anime shows; a name two cached shows share is ambiguous (could be a TV show's), so skipped.
  const shows = new Map<string, { title: string; tvdb_id: number } | null>();
  for (const r of cache.prepare("SELECT title, tvdb_id, path FROM series").all() as { title: string; tvdb_id: number; path: string }[]) {
    const name = path.posix.basename(r.path.replace(/\\/g, "/"));
    if (shows.has(name)) shows.set(name, null);
    else shows.set(name, underAllowedRoot(r.path) ? r : null);
  }
  let top: string[] = [];
  try {
    top = (await fs.readdir(local, { withFileTypes: true })).filter((e) => e.isDirectory() && shows.get(e.name)).map((e) => e.name);
  } catch {
    return { ...s, ...empty };
  }
  const files: { rel: string; size: number; mtime: number }[] = [];
  for (const name of top) {
    if (files.length >= MAX_FILES) break;
    await walk(local, name, 2, files);
  }
  // Sonarr purges a top-level folder by its newest file.
  const newest = new Map<string, number>();
  for (const f of files) {
    const k = f.rel.split("/")[0];
    newest.set(k, Math.max(newest.get(k) ?? 0, f.mtime));
  }
  const items: RecycleItem[] = files.map((f) => {
    const name = f.rel.split("/")[0];
    const show = shows.get(name)!;
    return { path: `${s.path.replace(/\/+$/, "")}/${f.rel}`, series: show.title, tvdbId: show.tvdb_id, size: f.size, deletedAt: f.mtime, purgeAt: s.cleanupDays ? newest.get(name)! + s.cleanupDays * 86_400_000 : null };
  });
  items.sort((a, b) => b.deletedAt - a.deletedAt);
  return { ...s, reachable: true, items: items.slice(0, SHOWN), totalCount: items.length, totalBytes: items.reduce((n, i) => n + i.size, 0), truncated: files.length >= MAX_FILES || items.length > SHOWN };
}
