/**
 * Shows the user dropped on purpose. A dropped show is never managed, grabbed (not even by a manual or scripted grab),
 * put in the fill-in queue or re-added, until the user un-drops it. Dropping keeps the files.
 */
import { cache, db } from "../system/db.js";
import { logDecision } from "../system/activity.js";
import { setSeriesMonitored } from "../arr/sonarr.js";
import { NATIVE_BASE } from "./nativeIds.js";
import { underAllowedRoot } from "../system/settings.js";

export const isDropped = (tvdbId: number | null | undefined) =>
  !!tvdbId && !!db.prepare("SELECT 1 FROM dropped WHERE tvdb_id = ?").get(tvdbId);

export const droppedList = () =>
  db.prepare("SELECT tvdb_id AS tvdbId, title, at, why FROM dropped ORDER BY title").all() as {
    tvdbId: number;
    title: string;
    at: number;
    why: string;
  }[];

/** Dropped AND removed from the library ("Also delete it", or Remove for a show whose record Sonarr holds). */
export const isBlocked = (tvdbId: number | null | undefined) =>
  !!tvdbId && !!db.prepare("SELECT 1 FROM dropped WHERE tvdb_id = ? AND removed = 1").get(tvdbId);
/** Every blocked show's tvdbId (the Sonarr sync and Add's search check many at once). */
export const blockedIds = () =>
  new Set((db.prepare("SELECT tvdb_id FROM dropped WHERE removed = 1").all() as { tvdb_id: number }[]).map((r) => r.tvdb_id));

/** The Blocked shows list: title, when and why. */
export const blockedList = () =>
  db.prepare("SELECT tvdb_id AS tvdbId, title, at, why FROM dropped WHERE removed = 1 ORDER BY at DESC").all() as {
    tvdbId: number;
    title: string;
    at: number;
    why: string;
  }[];

export class DroppedError extends Error {
  statusCode = 409;
  constructor(title: string, blocked = false) {
    super(
      blocked
        ? `You removed and blocked ${title}: unblock it (Import lists → Blocked shows) or choose Add anyway`
        : `You dropped ${title}: un-drop it on its page first`,
    );
  }
}
/** Throws when the show is dropped (the gate in front of managing, grabbing and adding). */
export function refuseDropped(tvdbId: number | null | undefined) {
  if (!isDropped(tvdbId)) return;
  const r = db.prepare("SELECT title, removed FROM dropped WHERE tvdb_id = ?").get(tvdbId!) as { title: string; removed: number };
  throw new DroppedError(r.title || `this show (TVDB ${tvdbId})`, r.removed === 1);
}

/**
 * Drops a show: stops managing it, takes it out of the fill-in queue and its search schedule and, when asked,
 * unmonitors it in Sonarr. Undoable (un-drop doesn't re-manage; that stays the user's choice).
 */
export async function dropShow(tvdbId: number, o: { why?: string; unmonitor?: boolean; removed?: string } = {}) {
  const s = cache.prepare("SELECT id, title, path, monitored FROM series WHERE tvdb_id = ?").get(tvdbId) as
    { id: number; title: string; path: string; monitored: number } | undefined;
  const title = s?.title ?? `TVDB ${tvdbId}`;
  // `removed`: dropShowAndRemove blocks it too (the why says what happened to the files); never calls Sonarr.
  const why = (o.removed ?? o.why ?? "").slice(0, 300);
  db.prepare(
    "INSERT INTO dropped (tvdb_id, title, at, why, removed) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tvdb_id) DO UPDATE SET why = excluded.why, removed = MAX(dropped.removed, excluded.removed), at = CASE WHEN excluded.removed > dropped.removed THEN excluded.at ELSE dropped.at END",
  ).run(tvdbId, title, Date.now(), why, o.removed ? 1 : 0);
  const wasManaged = db.prepare("DELETE FROM managed WHERE tvdb_id = ?").run(tvdbId).changes > 0;
  // Remembered so "Drop → delete" later still knows these files were AnimeArr's (removeFiles.ts).
  if (wasManaged) db.prepare("UPDATE dropped SET was_managed = 1 WHERE tvdb_id = ?").run(tvdbId);
  db.prepare("DELETE FROM search_state WHERE tvdb_id = ?").run(tvdbId);
  db.prepare("DELETE FROM fill_queue WHERE tvdb_id = ?").run(tvdbId);
  let sonarr = "";
  if (o.unmonitor && !o.removed && s && s.monitored && s.id < NATIVE_BASE && underAllowedRoot(s.path)) {
    try {
      await setSeriesMonitored(s.id, false);
      sonarr = "; unmonitored it in Sonarr";
    } catch (e) {
      sonarr = `; couldn't unmonitor it in Sonarr (${(e as Error).message})`;
    }
  }
  if (!o.removed)
    logDecision("managed", {
      tvdbId,
      title,
      why: `You dropped ${title}: AnimeArr won't manage, grab, fill in or re-add it${wasManaged ? "; no longer managed" : ""}${sonarr}. Files are kept.`,
      undo: { action: "undrop", args: { tvdbId } },
    });
  return { tvdbId, title, wasManaged };
}

/** Un-drop, and for a blocked show "Unblock": its import-list exclusions from the block go too, so it can be added again. */
export function undropShow(tvdbId: number) {
  const r = db.prepare("SELECT title, removed FROM dropped WHERE tvdb_id = ?").get(tvdbId) as
    { title: string; removed: number } | undefined;
  if (!r) return { changed: 0 };
  db.prepare("DELETE FROM dropped WHERE tvdb_id = ?").run(tvdbId);
  db.prepare("DELETE FROM import_list_exclusions WHERE tvdb_id = ?").run(tvdbId);
  logDecision("managed", {
    tvdbId,
    title: r.title,
    why: r.removed
      ? `${r.title} is no longer blocked: Add, import lists and the Sonarr sync may bring it back`
      : `${r.title} is no longer dropped (not managed; manage it again if you want AnimeArr to grab for it)`,
  });
  return { changed: 1 };
}
