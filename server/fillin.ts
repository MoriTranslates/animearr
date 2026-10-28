/**
 * Staged fill-in queue: ended shows are added to a queue and activated in waves (default 5 shows). A wave is done
 * when each show is ≥90% filled in (its in-scope missing episodes) or made no progress for 7 days; then the next
 * wave starts. Activating a show makes it managed (live unless the global dry-run is on) with its monitoring scope;
 * the missing-episode search (and its hourly limit) does the actual searching.
 */
import { isDropped } from "./dropped.js";
import { logDecision } from "./activity.js";
import { cache, db, dbState, setJob } from "./db.js";
import { listManaged, setManaged } from "./managed.js";
import { missingScoped, scopeFor, setScope } from "./scope.js";
import { getSettings } from "./settings.js";

const DAY = 86_400_000;

interface Row { tvdb_id: number; position: number; state: "queued" | "active" | "done" | "skipped"; wave: number | null; added_at: number; activated_at: number | null; done_at: number | null; start_missing: number | null; last_missing: number | null; progress_at: number | null; note: string }

/** In-scope missing (aired) episodes of a show right now. */
export function missingInScope(tvdbId: number, now = Date.now()) {
  const s = cache.prepare("SELECT id FROM series WHERE tvdb_id = ?").get(tvdbId) as { id: number } | undefined;
  if (!s) return null;
  return missingScoped(tvdbId, s.id, now).length;
}

export function addToQueue(tvdbIds: number[], now = Date.now()) {
  let pos = (db.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM fill_queue").get() as { p: number }).p;
  let added = 0;
  for (const id of tvdbIds) {
    if (!cache.prepare("SELECT 1 FROM series WHERE tvdb_id = ?").get(id) || isDropped(id)) continue;
    added += Number(db.prepare("INSERT INTO fill_queue (tvdb_id, position, state, added_at) VALUES (?, ?, 'queued', ?) ON CONFLICT(tvdb_id) DO NOTHING").run(id, ++pos, now).changes);
  }
  return { added };
}

export function editQueue(tvdbId: number, action: "up" | "down" | "skip" | "remove" | "requeue") {
  const r = db.prepare("SELECT * FROM fill_queue WHERE tvdb_id = ?").get(tvdbId) as Row | undefined;
  if (!r) throw Object.assign(new Error("Not in the fill-in queue"), { statusCode: 404 });
  if (action === "remove") return void db.prepare("DELETE FROM fill_queue WHERE tvdb_id = ?").run(tvdbId);
  if (action === "skip") return void db.prepare("UPDATE fill_queue SET state = 'skipped', note = 'skipped by you' WHERE tvdb_id = ?").run(tvdbId);
  if (action === "requeue") return void db.prepare("UPDATE fill_queue SET state = 'queued', wave = NULL, note = '' WHERE tvdb_id = ?").run(tvdbId);
  // Swap with the neighbouring queued row.
  const other = db.prepare(`SELECT tvdb_id, position FROM fill_queue WHERE state = 'queued' AND position ${action === "up" ? "<" : ">"} ? ORDER BY position ${action === "up" ? "DESC" : "ASC"} LIMIT 1`).get(r.position) as { tvdb_id: number; position: number } | undefined;
  if (!other) return;
  db.prepare("UPDATE fill_queue SET position = ? WHERE tvdb_id = ?").run(other.position, r.tvdb_id);
  db.prepare("UPDATE fill_queue SET position = ? WHERE tvdb_id = ?").run(r.position, other.tvdb_id);
}

/** One pass: update progress, finish shows/waves, start the next wave. */
export function fillInTick(now = Date.now()) {
  const s = getSettings().fillIn;
  if (dbState.corrupt) return;
  // Nothing is searched while the missing-episode search is off: don't run stall clocks or start waves then.
  const searching = getSettings().backlog.enabled;
  const managed = new Set(listManaged().map((m) => m.tvdbId));
  const active = db.prepare("SELECT * FROM fill_queue WHERE state = 'active'").all() as unknown as Row[];
  for (const r of active) {
    const missing = missingInScope(r.tvdb_id, now);
    if (missing === null || !managed.has(r.tvdb_id)) {
      db.prepare("UPDATE fill_queue SET state = 'done', done_at = ?, note = ? WHERE tvdb_id = ?").run(now, missing === null ? "no longer in the library" : "no longer managed", r.tvdb_id);
      continue;
    }
    const start = r.start_missing ?? missing;
    const progressed = r.last_missing !== null && missing < r.last_missing;
    const filled = start === 0 ? 1 : Math.max(0, (start - missing) / start);
    if (missing !== r.last_missing) db.prepare("UPDATE fill_queue SET last_missing = ?, progress_at = CASE WHEN ? THEN ? ELSE progress_at END WHERE tvdb_id = ?").run(missing, progressed ? 1 : 0, now, r.tvdb_id);
    if (!searching) {
      db.prepare("UPDATE fill_queue SET progress_at = ? WHERE tvdb_id = ?").run(now, r.tvdb_id); // the stall clock waits
      continue;
    }
    const stalled = !progressed && now - (r.progress_at ?? r.activated_at ?? now) > s.stallDays * DAY;
    if (filled * 100 >= s.advancePct || stalled)
      db.prepare("UPDATE fill_queue SET state = 'done', done_at = ?, last_missing = ?, note = ? WHERE tvdb_id = ?").run(now, missing, stalled ? `no progress for ${s.stallDays} days (${missing} still missing)` : `${Math.round(filled * 100)}% filled in`, r.tvdb_id);
  }
  const stillActive = (db.prepare("SELECT COUNT(*) AS n FROM fill_queue WHERE state = 'active'").get() as { n: number }).n;
  if (s.paused || stillActive || !searching) return;
  const next = db.prepare("SELECT * FROM fill_queue WHERE state = 'queued' ORDER BY position LIMIT ?").all(s.waveSize) as unknown as Row[];
  if (!next.length) return;
  const wave = ((db.prepare("SELECT COALESCE(MAX(wave), 0) AS w FROM fill_queue").get() as { w: number }).w ?? 0) + 1;
  // Fill-in shows use AnimeArr's scope (Sonarr's monitored flags no longer matter for them) and go live.
  for (const x of next) if (!db.prepare("SELECT 1 FROM series_scope WHERE tvdb_id = ?").get(x.tvdb_id)) setScope([x.tvdb_id], { ...getSettings().scope.ended, creditless: getSettings().scope.ended.creditless !== false }, now);
  const r = setManaged(next.filter((x) => !managed.has(x.tvdb_id)).map((x) => x.tvdb_id), true, { live: true });
  const refused = new Map(r.refused.map((x) => [x.tvdbId, x.reason]));
  const lines: string[] = [];
  for (const x of next) {
    if (refused.has(x.tvdb_id)) {
      db.prepare("UPDATE fill_queue SET state = 'skipped', note = ? WHERE tvdb_id = ?").run(`couldn't be managed: ${refused.get(x.tvdb_id)}`, x.tvdb_id);
      continue;
    }
    const missing = missingInScope(x.tvdb_id, now) ?? 0;
    db.prepare("UPDATE fill_queue SET state = 'active', wave = ?, activated_at = ?, start_missing = ?, last_missing = ?, progress_at = ?, note = '' WHERE tvdb_id = ?").run(wave, now, missing, missing, now, x.tvdb_id);
    const title = (cache.prepare("SELECT title FROM series WHERE tvdb_id = ?").get(x.tvdb_id) as { title: string }).title;
    lines.push(`${title} (${missing})`);
  }
  if (lines.length) {
    const per = getSettings().backlog.perHour;
    const total = (db.prepare("SELECT COALESCE(SUM(start_missing), 0) AS n FROM fill_queue WHERE state = 'active'").get() as { n: number }).n;
    logDecision("info", { why: `Fill-in wave ${wave} started: ${lines.join(", ")}. ${total} missing episodes, searched about ${per} per hour (≈${Math.ceil(total / Math.max(1, per))} h)${getSettings().backlog.enabled ? "" : "; the missing-episode search is OFF, so nothing will be searched until it's on"}.` });
    setJob("fill-in", "done", `Wave ${wave}: ${lines.length} shows`);
  }
}

/** For the page: waves, progress, ETA. */
export function fillInView(now = Date.now()) {
  const rows = db.prepare("SELECT * FROM fill_queue ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'queued' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, position").all() as unknown as Row[];
  const title = (id: number) => (cache.prepare("SELECT title, poster, tvdb_id FROM series WHERE tvdb_id = ?").get(id) as { title: string; poster: string | null } | undefined) ?? { title: String(id), poster: null };
  const items = rows.map((r) => {
    const t = title(r.tvdb_id);
    const missing = r.state === "queued" || r.state === "active" ? missingInScope(r.tvdb_id, now) : r.last_missing;
    const sc = scopeFor(r.tvdb_id);
    return { tvdbId: r.tvdb_id, title: t.title, cover: t.poster, state: r.state, wave: r.wave, position: r.position, startMissing: r.start_missing, missing, note: r.note, activatedAt: r.activated_at, doneAt: r.done_at, scope: { seasons: sc.seasons, recentN: sc.recentN, episodes: sc.episodes, specials: sc.specials } };
  });
  const per = Math.max(1, getSettings().backlog.perHour);
  const remaining = items.filter((i) => i.state === "active" || i.state === "queued").reduce((n, i) => n + (i.missing ?? 0), 0);
  return { settings: getSettings().fillIn, backlogEnabled: getSettings().backlog.enabled, perHour: per, remaining, etaHours: Math.ceil(remaining / per), items };
}
