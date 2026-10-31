/**
 * "Keep as is" locks and the {Keep Tag} (QUALITY-PROFILES §5/§5b). A locked show or season is never upgraded, and
 * its files carry "[Keep]" in their names (through the {Keep Tag} naming token), so a Tdarr flow guard skips them
 * too. The tag in the file name is the single source of truth for both tools: it survives a database restore and
 * works for anyone who reads the folder. The user's own "[Remaster]" files count the same.
 */
import { cache, db } from "./db.js";
import { profileFor } from "./profiles.js";

export const KEEP_TAG = "[Keep]";
const WHOLE_SHOW = -1;

/** Locks of a show: the whole show and/or single seasons. */
export function locksFor(tvdbId: number) {
  const rows = db.prepare("SELECT season FROM quality_locks WHERE tvdb_id = ?").all(tvdbId) as { season: number }[];
  return { show: rows.some((r) => r.season === WHOLE_SHOW), seasons: rows.map((r) => r.season).filter((s) => s !== WHOLE_SHOW).sort((a, b) => a - b) };
}

export function isLocked(tvdbId: number, season: number | null) {
  return !!db.prepare("SELECT 1 FROM quality_locks WHERE tvdb_id = ? AND (season = ? OR season = ?)").get(tvdbId, WHOLE_SHOW, season ?? WHOLE_SHOW);
}

/** Locks or unlocks a show (season null) or one season. Returns whether anything changed. */
export function setLock(tvdbId: number, season: number | null, keep: boolean, now = Date.now()) {
  const s = season ?? WHOLE_SHOW;
  if (!Number.isInteger(s) || s < WHOLE_SHOW) throw Object.assign(new Error("Pick a season"), { statusCode: 400 });
  if (!cache.prepare("SELECT 1 FROM series WHERE tvdb_id = ?").get(tvdbId)) throw Object.assign(new Error("Unknown series"), { statusCode: 404 });
  const r = keep ? db.prepare("INSERT OR IGNORE INTO quality_locks (tvdb_id, season, at) VALUES (?, ?, ?)").run(tvdbId, s, now) : db.prepare("DELETE FROM quality_locks WHERE tvdb_id = ? AND season = ?").run(tvdbId, s);
  return r.changes > 0;
}

/** Whether a show's files get the {Keep Tag}: locked, or its profile keeps original files (no Tdarr re-encode). */
export function keepTagFor(tvdbId: number, season: number | null) {
  return isLocked(tvdbId, season) || profileFor(tvdbId).reencode === "keep";
}

/**
 * A Tdarr Flow "Custom JS Function" step for right after "Input File": tagged files leave the flow on output 2 (wire it
 * to nothing, or to the flow's end), everything else continues on output 1.
 */
export const TDARR_GUARD = `module.exports = async (args) => {
  const name = String(args.inputFileObj._id || '').split('/').pop();
  const skip = /\\[(keep|remaster)\\]/i.test(name);
  args.jobLog(\`Keep check: \${name} -> \${skip ? 'tagged [Keep]/[Remaster], leaving it alone' : 'not tagged, continue'}\`);
  return { outputFileObj: args.inputFileObj, outputNumber: skip ? 2 : 1, variables: args.variables };
}`;
