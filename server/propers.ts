/**
 * Propers and repacks, the library side (the rule itself is core/propers.ts): which release group and version the file
 * an episode has came from, and the "Propers and repacks" setting. The version is read from the file's recorded release
 * name (the scene name, else the release AnimeArr grabbed for it, else its file name) and from Sonarr's quality
 * revision when the cache has one.
 */
import { LOCK_TAG } from "./core/quality.js";
import { parseRelease } from "./core/parser.js";
import { isNewerRevision, revisionOf, type HaveRevision, type ProperMode, type Revision } from "./core/propers.js";
import { cache, db } from "./system/db.js";
import { profileFor } from "./profiles.js";
import { isLocked } from "./qualityLocks.js";
import { getSettings } from "./system/settings.js";

export const properMode = (): ProperMode => getSettings().media.propers ?? "preferAndUpgrade";

/**
 * Episode id → the release of its newest finished grab. Built once and rebuilt when the grabs change: looking it up per
 * file scanned the whole grabs table for every episode of the library (seconds, with the app frozen meanwhile).
 */
let doneReleases: { key: number; map: Map<number, string> } | null = null;
function doneReleaseOf(episodeId: number): string | undefined {
  // total_changes(): this connection's write counter, free to read; any write may have touched the grabs.
  const key = (db.prepare("SELECT total_changes() AS c").get() as { c: number }).c;
  if (doneReleases?.key !== key) {
    const map = new Map<number, string>();
    for (const g of db.prepare("SELECT episode_ids, release FROM grabs WHERE state = 'done' AND dry_run = 0 ORDER BY id").all() as {
      episode_ids: string;
      release: string;
    }[]) {
      try {
        for (const e of JSON.parse(g.episode_ids) as number[]) map.set(e, g.release); // ascending ids: the newest grab wins
      } catch {
        /* unreadable row */
      }
    }
    doneReleases = { key, map };
  }
  return doneReleases.map.get(episodeId);
}

let metaOf: ReturnType<typeof db.prepare> | null = null;
/** The release name a file came from: its scene name, else the newest finished grab of the episode, else its file name. */
function releaseOfFile(episodeId: number, f: { path: string; scene_name: string | null }): string {
  if (f.scene_name?.trim()) return f.scene_name.trim();
  const meta = (metaOf ??= db.prepare("SELECT scene_name FROM file_meta WHERE path = ?")).get(f.path) as
    { scene_name: string | null } | undefined;
  if (meta?.scene_name?.trim()) return meta.scene_name.trim();
  return (
    doneReleaseOf(episodeId) ??
    f.path
      .split("/")
      .pop()!
      .replace(/\.[a-z0-9]{2,4}$/i, "")
  );
}

/** Group and version of one library file (pure given its row; the episode id finds the grab history). */
export function fileRevision(
  episodeId: number,
  f: { path: string; scene_name: string | null; release_group: string | null; revision: string | null },
): Revision & { release: string } {
  const release = releaseOfFile(episodeId, f);
  const p = parseRelease(release);
  const base = f.path
    .split("/")
    .pop()!
    .replace(/\.[a-z0-9]{2,4}$/i, "");
  const named = base === release ? p : parseRelease(base);
  let version = Math.max(p.version, named.version);
  try {
    const r = f.revision ? (JSON.parse(f.revision) as { version?: number; real?: number }) : null;
    if (r) version = Math.max(version, (r.version ?? 1) + (r.real ?? 0));
  } catch {
    /* an unreadable revision is just unknown */
  }
  return { group: f.release_group?.trim() || p.group || named.group, version, release };
}

/** The files the given episodes have, as revisions (episodes without a file are left out). */
export function haveRevisions(tvdbId: number, episodeIds: number[]): Map<number, HaveRevision> {
  const out = new Map<number, HaveRevision>();
  if (!episodeIds.length) return out;
  const keepAll = profileFor(tvdbId).reencode === "keep"; // keep-original profiles are locked by definition
  const rows = cache
    .prepare(
      `SELECT e.id, e.season, f.path, f.scene_name, f.release_group, f.revision FROM episodes e JOIN files f ON f.id = e.file_id WHERE e.has_file = 1 AND e.id IN (${episodeIds.map(() => "?").join(",")})`,
    )
    .all(...episodeIds) as {
    id: number;
    season: number;
    path: string;
    scene_name: string | null;
    release_group: string | null;
    revision: string | null;
  }[];
  for (const r of rows) {
    const rev = fileRevision(r.id, r);
    out.set(r.id, {
      group: rev.group,
      version: rev.version,
      locked: keepAll || isLocked(tvdbId, r.season) || LOCK_TAG.test(r.path) || LOCK_TAG.test(rev.release),
    });
  }
  return out;
}

/**
 * What the files of a candidate's episodes amount to: the shared group (null when they come from different groups: a
 * mixed set is never "the same group") and the highest version, locked when any of them is. null: no file yet.
 */
export function combineHave(have: Map<number, HaveRevision>, episodeIds: number[]): HaveRevision | null {
  const list = episodeIds.map((id) => have.get(id)).filter((h): h is HaveRevision => !!h);
  if (!list.length) return null;
  const groups = new Set(list.map((h) => (h.group ?? "").toLowerCase()));
  return {
    group: groups.size === 1 ? list[0].group : null,
    version: Math.max(...list.map((h) => h.version)),
    locked: list.some((h) => h.locked),
  };
}

/** Is `release` a newer version of what the library holds for these episodes, under the current setting? */
export function newerVersionOf(tvdbId: number, episodeIds: number[], release: string, mode: ProperMode = properMode()) {
  const have = combineHave(haveRevisions(tvdbId, episodeIds), episodeIds);
  return have ? isNewerRevision(have, revisionOf(release), mode) : { ok: false, why: "no file yet" };
}
