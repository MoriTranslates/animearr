/**
 * Shows the user dropped on purpose. A dropped show is never managed, grabbed (not even by a manual or scripted grab),
 * put in the fill-in queue or re-added, until the user un-drops it. Dropping keeps the files.
 */
import { cache, db } from "./db.js";
import { logDecision } from "./activity.js";
import { setSeriesMonitored } from "./arr/sonarr.js";
import { NATIVE_BASE } from "./native.js";
import { underAllowedRoot } from "./settings.js";

export const isDropped = (tvdbId: number | null | undefined) => !!tvdbId && !!db.prepare("SELECT 1 FROM dropped WHERE tvdb_id = ?").get(tvdbId);

export const droppedList = () => db.prepare("SELECT tvdb_id AS tvdbId, title, at, why FROM dropped ORDER BY title").all() as { tvdbId: number; title: string; at: number; why: string }[];

export class DroppedError extends Error {
  statusCode = 409;
  constructor(title: string) {
    super(`You dropped ${title}: un-drop it on its page first`);
  }
}
/** Throws when the show is dropped (the gate in front of managing, grabbing and adding). */
export function refuseDropped(tvdbId: number | null | undefined) {
  if (!isDropped(tvdbId)) return;
  const r = db.prepare("SELECT title FROM dropped WHERE tvdb_id = ?").get(tvdbId!) as { title: string };
  throw new DroppedError(r.title || `this show (TVDB ${tvdbId})`);
}

/**
 * Drops a show: stops managing it, takes it out of the fill-in queue and its search schedule and, when asked,
 * unmonitors it in Sonarr. Undoable (un-drop doesn't re-manage; that stays the user's choice).
 */
export async function dropShow(tvdbId: number, o: { why?: string; unmonitor?: boolean } = {}) {
  const s = cache.prepare("SELECT id, title, path, monitored FROM series WHERE tvdb_id = ?").get(tvdbId) as { id: number; title: string; path: string; monitored: number } | undefined;
  const title = s?.title ?? `TVDB ${tvdbId}`;
  db.prepare("INSERT INTO dropped (tvdb_id, title, at, why) VALUES (?, ?, ?, ?) ON CONFLICT(tvdb_id) DO UPDATE SET why = excluded.why").run(tvdbId, title, Date.now(), (o.why ?? "").slice(0, 300));
  const wasManaged = db.prepare("DELETE FROM managed WHERE tvdb_id = ?").run(tvdbId).changes > 0;
  db.prepare("DELETE FROM search_state WHERE tvdb_id = ?").run(tvdbId);
  db.prepare("DELETE FROM fill_queue WHERE tvdb_id = ?").run(tvdbId);
  let sonarr = "";
  if (o.unmonitor && s && s.monitored && s.id < NATIVE_BASE && underAllowedRoot(s.path)) {
    try {
      await setSeriesMonitored(s.id, false);
      sonarr = "; unmonitored it in Sonarr";
    } catch (e) {
      sonarr = `; couldn't unmonitor it in Sonarr (${(e as Error).message})`;
    }
  }
  logDecision("managed", { tvdbId, title, why: `You dropped ${title}: AnimeArr won't manage, grab, fill in or re-add it${wasManaged ? "; no longer managed" : ""}${sonarr}. Files are kept.`, undo: { action: "undrop", args: { tvdbId } } });
  return { tvdbId, title, wasManaged };
}

export function undropShow(tvdbId: number) {
  const r = db.prepare("SELECT title FROM dropped WHERE tvdb_id = ?").get(tvdbId) as { title: string } | undefined;
  if (!r) return { changed: 0 };
  db.prepare("DELETE FROM dropped WHERE tvdb_id = ?").run(tvdbId);
  logDecision("managed", { tvdbId, title: r.title, why: `${r.title} is no longer dropped (not managed; manage it again if you want AnimeArr to grab for it)` });
  return { changed: 1 };
}
