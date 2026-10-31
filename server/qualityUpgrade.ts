/**
 * Quality upgrades towards each profile's goal (QUALITY-PROFILES §4): the watcher keeps chasing better releases after
 * the first grab, a season at a time.
 *
 * - Managed shows only, monitored episodes with files, inside the allowed roots. A season is due when some of its
 *   files are below the profile's goal (good = WEB 1080p, high = Blu-ray 1080p, collector = SeaDex's best).
 * - Files are judged by their ORIGINAL release name (the scene name AnimeArr/Sonarr recorded at import), so a file
 *   Tdarr re-encoded later still counts as the Blu-ray it came from, never as a downgrade to re-grab.
 * - Never touched: shows/seasons locked "keep as is", profiles that keep originals, files named [Keep] or [Remaster].
 * - A candidate must beat each file it replaces: a higher quality category always does; inside the same category only
 *   when the file isn't already that category's best (no churn when SeaDex swaps between equal releases).
 * - The swap is a Replace-season grab: each new file replaces its episode's file only after it passed the normal
 *   checks, and the old file goes to the recycling bin.
 * - Automatic from day one, with guard rails: the first run only lists its plan (grabs start a day later, or when the
 *   user says "Start now"), a pause switch, at most seasonsPerDay grabs a day and perHour searches an hour; seasons are
 *   rechecked every recheckDays, weekly in the Blu-ray window (3–6 months after a season's last episode).
 * - A show with no Blu-ray release (a DVD-era show, or no BD seen in months) caps its goal at the best that exists.
 * - Honours dry-run (show + global) like every managed grab.
 */
import { logDecision } from "./activity.js";
import { CATEGORY_NAME, beatsCurrent, goalCategory, goalLabel, ladderRank, LOCK_TAG, meetsGoal, qualityScore, type Category, type GoalId, type QualityScore, type SeadexEntry } from "./core/quality.js";
import { cache, db, dbState, setJob } from "./db.js";
import { searchConfigured } from "./indexers.js";
import { listManaged, toCandidate } from "./managed.js";
import { startGrab } from "./pipeline.js";
import { profileFor } from "./profiles.js";
import { isLocked } from "./qualityLocks.js";
import { animeTiers, seadexForSeason } from "./seadex.js";
import { deepSearch, type SearchResult } from "./search.js";
import { getSettings, underAllowedRoot } from "./settings.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** How long the first run's plan is shown before grabs start on their own. */
export const PLAN_GRACE_MS = DAY;

export interface QualityDeps {
  search: typeof deepSearch;
  grab: typeof startGrab;
}
const realDeps: QualityDeps = { search: deepSearch, grab: startGrab };

const kvGet = (k: string) => (db.prepare("SELECT value FROM kv WHERE key = ?").get(k) as { value: string } | undefined)?.value;
const kvSet = (k: string, v: string) => db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);

export interface FileNow { episodeId: number; label: string; release: string; q: QualityScore }
export interface Unit {
  tvdbId: number;
  title: string;
  season: number;
  goal: GoalId;
  /** The goal's category after the profile's resolution and any "no Blu-ray exists" cap. */
  target: Category;
  /** Episodes below the goal (what the upgrade replaces). */
  files: FileNow[];
  /** Last air date of the season (for the Blu-ray window). */
  endedAt: number | null;
  why: string;
}

interface StateRow { tvdb_id: number; season: number; state: string; last_at: number | null; attempts: number; why: string; release: string | null; grab_id: number | null; best_seen: string | null; no_bd: number; updated_at: number }
const stateOf = (tvdbId: number, season: number) => db.prepare("SELECT * FROM quality_upgrade WHERE tvdb_id = ? AND season = ?").get(tvdbId, season) as StateRow | undefined;
function save(tvdbId: number, season: number, v: { state: string; why: string; now: number; searched?: boolean; release?: string | null; grabId?: number | null; bestSeen?: string | null; noBd?: number }) {
  const prev = stateOf(tvdbId, season);
  db.prepare("INSERT OR REPLACE INTO quality_upgrade (tvdb_id, season, state, last_at, attempts, why, release, grab_id, best_seen, no_bd, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    tvdbId,
    season,
    v.state,
    v.searched ? v.now : (prev?.last_at ?? null),
    (prev?.attempts ?? 0) + (v.searched ? 1 : 0),
    v.why,
    v.release === undefined ? (prev?.release ?? null) : v.release,
    v.grabId === undefined ? (prev?.grab_id ?? null) : v.grabId,
    v.bestSeen === undefined ? (prev?.best_seen ?? null) : v.bestSeen,
    v.noBd ?? prev?.no_bd ?? 0,
    v.now,
  );
}

/**
 * The "no Blu-ray exists" cap: a DVD-era show (before 2008) after two searches without any Blu-ray, or any show whose
 * season ended over a year ago after six such searches, aims for the best category seen instead.
 */
export function capOf(st: Pick<StateRow, "best_seen" | "no_bd"> | undefined, year: number | null, endedAt: number | null, now = Date.now()): Category | null {
  if (!st || !st.no_bd) return null;
  const old = year !== null && year < 2008;
  const long = endedAt !== null && now - endedAt > 365 * DAY;
  if ((old && st.no_bd >= 2) || (long && st.no_bd >= 6)) return (st.best_seen as Category | null) ?? "dvd";
  return null;
}

/** The original release name of a library file: its recorded scene name, else the file name. */
const releaseOf = (f: { path: string; scene_name: string | null }) => {
  if (f.scene_name?.trim()) return f.scene_name.trim();
  const meta = db.prepare("SELECT scene_name FROM file_meta WHERE path = ?").get(f.path) as { scene_name: string | null } | undefined;
  return meta?.scene_name?.trim() || f.path.split("/").pop()!.replace(/\.[a-z0-9]{2,4}$/i, "");
};
const heightOf = (res: string | null) => {
  const m = /(\d{3,4})\s*p?\s*$/i.exec(res ?? "") ?? /x(\d{3,4})/.exec(res ?? "");
  return m ? Number(m[1]) : null;
};

/** Seasons of managed shows with files below their profile's goal (locked shows/seasons/files left out). */
export function upgradeUnits(now = Date.now()): Unit[] {
  const tiers = animeTiers();
  const out: Unit[] = [];
  for (const m of listManaged()) {
    const prof = profileFor(m.tvdbId);
    if (prof.reencode === "keep") continue; // keep-original profiles are locked by definition
    const series = cache.prepare("SELECT path, year FROM series WHERE tvdb_id = ?").get(m.tvdbId) as { path: string; year: number | null } | undefined;
    if (!series || !underAllowedRoot(series.path)) continue;
    const goal = prof.qualityGoal ?? "high";
    const rows = cache
      .prepare("SELECT e.id, e.season, e.episode, e.air_utc, f.path, f.scene_name, f.resolution FROM episodes e JOIN files f ON f.id = e.file_id WHERE e.series_id = ? AND e.season > 0 AND e.monitored = 1 AND e.has_file = 1 ORDER BY e.season, e.episode")
      .all(m.seriesId) as { id: number; season: number; episode: number; air_utc: number | null; path: string; scene_name: string | null; resolution: string | null }[];
    const seasons = [...new Set(rows.map((r) => r.season))];
    for (const season of seasons) {
      if (isLocked(m.tvdbId, season)) continue;
      const seadex = seadexForSeason(m.tvdbId, season);
      const eps = rows.filter((r) => r.season === season);
      const endedAt = Math.max(0, ...(cache.prepare("SELECT air_utc FROM episodes WHERE series_id = ? AND season = ? AND air_utc IS NOT NULL").all(m.seriesId, season) as { air_utc: number }[]).map((r) => r.air_utc)) || null;
      const cap = capOf(stateOf(m.tvdbId, season), series.year, endedAt, now);
      const target = goalCategory(goal, prof.resolution, cap);
      const files: FileNow[] = [];
      for (const r of eps) {
        const release = releaseOf(r);
        if (LOCK_TAG.test(r.path) || LOCK_TAG.test(release)) continue;
        const q = qualityScore(release, { tiers, seadex, mode: prof.watchMode }, heightOf(r.resolution));
        if (meetsGoal(q, goal, { profileResolution: prof.resolution, cap, seadexKnown: !!seadex && !seadex.incomplete })) continue;
        files.push({ episodeId: r.id, label: `S${String(r.season).padStart(2, "0")}E${String(r.episode).padStart(2, "0")}`, release, q });
      }
      if (!files.length) continue;
      const worst = files.reduce((a, b) => (ladderRank(b.q.info.category) < ladderRank(a.q.info.category) ? b : a));
      const why = `${files.length} episode${files.length > 1 ? "s" : ""} below ${goalLabel(goal)}${cap ? ` (capped at ${CATEGORY_NAME[cap]}: no Blu-ray release seen)` : ""}; worst ${CATEGORY_NAME[worst.q.info.category]}`;
      out.push({ tvdbId: m.tvdbId, title: m.title, season, goal, target, files, endedAt, why });
    }
  }
  return out;
}

/** How long until a season is looked at again: weekly in the Blu-ray window, quarterly when capped. */
export function recheckMs(u: Pick<Unit, "endedAt">, capped: boolean, now = Date.now()) {
  if (capped) return 90 * DAY;
  const since = u.endedAt ? now - u.endedAt : null;
  if (since !== null && since >= 90 * DAY && since <= 180 * DAY) return 7 * DAY;
  return getSettings().qualityUpgrade.recheckDays * DAY;
}

const count = (kind: "search" | "grab", since: number) => (db.prepare("SELECT COUNT(*) AS n FROM quality_upgrade_log WHERE kind = ? AND at > ?").get(kind, since) as { n: number }).n;
const note = (kind: "search" | "grab", now: number) => db.prepare("INSERT INTO quality_upgrade_log (at, kind) VALUES (?, ?)").run(now, kind);

export interface UpgradePick {
  result: SearchResult;
  covered: number[];
  q: QualityScore;
  why: string;
}

/**
 * The best upgrade among search results: it must beat every file it would replace (category first, then SeaDex/tiers)
 * and be a confident, acceptable, alive release without burned-in subs. Whole-season packs win over single episodes.
 */
export function pickUpgrade(results: SearchResult[], unit: Pick<Unit, "files" | "goal">, ctx: { seadex: SeadexEntry | null; mode: "sub" | "dub" | "dual" | "either"; minConfidence: number }): UpgradePick | null {
  const tiers = animeTiers();
  const byEp = new Map(unit.files.map((f) => [f.episodeId, f]));
  const picks: UpgradePick[] = [];
  for (const r of results) {
    if (!r.rank.accept || r.confidence < ctx.minConfidence || (r.protocol === "torrent" && !r.seeders) || r.rank.flags.some((f) => f.key === "burnIn" || f.key === "placeholder")) continue;
    const covered = r.episodeIds.filter((id) => byEp.has(id));
    if (!covered.length) continue;
    const q = qualityScore(r.title, { tiers, seadex: ctx.seadex, mode: ctx.mode, goal: unit.goal });
    const verdicts = covered.map((id) => beatsCurrent(q, byEp.get(id)!.q));
    if (!verdicts.every((v) => v.ok)) continue;
    picks.push({ result: r, covered, q, why: verdicts[0].why });
  }
  picks.sort((a, b) => b.covered.length - a.covered.length || ladderRank(b.q.info.category) - ladderRank(a.q.info.category) || b.q.points - a.q.points || b.result.rank.score - a.result.rank.score);
  return picks[0] ?? null;
}

/** Plan state: when the first run listed its plan, and whether the user said "Start now". */
export function planState(now = Date.now()) {
  const planAt = Number(kvGet("qualityUpgrade.planAt") ?? 0) || null;
  const started = kvGet("qualityUpgrade.started") === "1";
  const startsAt = planAt ? planAt + PLAN_GRACE_MS : null;
  return { planAt, started, startsAt, live: started || (startsAt !== null && now >= startsAt) };
}
export function startNow() {
  if (!kvGet("qualityUpgrade.planAt")) kvSet("qualityUpgrade.planAt", String(Date.now()));
  kvSet("qualityUpgrade.started", "1");
  logDecision("info", { why: "Quality upgrades: started now (you skipped the one-day look at the plan)" });
}

/** One pass: follow up on earlier upgrade grabs, then search due seasons and grab within the budgets. */
export async function qualityUpgradePass(deps: QualityDeps = realDeps, now = Date.now()) {
  const s = getSettings().qualityUpgrade;
  const res = { units: 0, searched: 0, grabbed: 0, planned: false, paused: false };
  if (s.mode === "off" || dbState.corrupt) return res;
  db.prepare("DELETE FROM quality_upgrade_log WHERE at < ?").run(now - 2 * DAY);

  // 1. Follow-ups (before any search, so the budget never skips them).
  for (const r of db.prepare("SELECT * FROM quality_upgrade WHERE state = 'grabbed'").all() as unknown as StateRow[]) {
    const g = r.grab_id ? (db.prepare("SELECT state, release FROM grabs WHERE id = ?").get(r.grab_id) as { state: string; release: string } | undefined) : undefined;
    if (g && ["sending", "downloading", "importing", "needs-attention"].includes(g.state)) continue;
    if (g?.state === "done") save(r.tvdb_id, r.season, { state: "upgraded", why: `upgraded to ${g.release}`, now, grabId: null });
    else save(r.tvdb_id, r.season, { state: "waiting", why: g ? `the upgrade didn't work out (${g.release}: ${g.state}); the old files stayed` : "the upgrade grab is gone", now, grabId: null, release: null });
  }

  const units = upgradeUnits(now);
  res.units = units.length;
  // 2. The first run lists its plan and stops there.
  const plan = planState(now);
  if (!plan.planAt) {
    kvSet("qualityUpgrade.planAt", String(now));
    res.planned = true;
    const list = units.slice(0, 10).map((u) => `${u.title} S${String(u.season).padStart(2, "0")} (${u.why})`);
    logDecision("info", { why: `Quality upgrades: the plan. ${units.length} season${units.length === 1 ? "" : "s"} below their goal${list.length ? `: ${list.join("; ")}${units.length > list.length ? "; …" : ""}` : ""}. Grabs start in a day (up to ${s.seasonsPerDay} seasons a day), or now with "Start now"; "Pause upgrades" stops them.` });
    return res;
  }
  if (!plan.live) return res;
  if (s.paused) {
    res.paused = true;
    return res;
  }

  // 3. Searches and grabs, least recently checked first.
  const minConfidence = getSettings().managed.minConfidence;
  const due = units
    .map((u) => ({ u, st: stateOf(u.tvdbId, u.season) }))
    .filter(({ u, st }) => st?.state !== "grabbed" && (!st?.last_at || now - st.last_at >= recheckMs(u, u.target !== goalCategory(u.goal, profileFor(u.tvdbId).resolution), now)))
    .sort((a, b) => (a.st?.last_at ?? 0) - (b.st?.last_at ?? 0));
  for (const { u, st } of due) {
    if (count("grab", now - DAY) >= s.seasonsPerDay) break;
    if (count("search", now - HOUR) >= s.perHour) break;
    const ids = u.files.map((f) => f.episodeId);
    if (db.prepare("SELECT 1 FROM grabs WHERE state IN ('sending', 'downloading', 'importing', 'needs-attention') AND EXISTS (SELECT 1 FROM json_each(grabs.episode_ids) WHERE value IN (SELECT value FROM json_each(?)))").get(JSON.stringify(ids))) continue;
    note("search", now);
    res.searched++;
    let results: SearchResult[];
    try {
      results = (await deps.search(u.tvdbId, ids, { budget: 8 })).results;
    } catch (e) {
      save(u.tvdbId, u.season, { state: "waiting", why: `search failed: ${(e as Error).message}`, now, searched: true });
      continue;
    }
    // What exists: the best accepted category seen, and whether any Blu-ray turned up (for the "no BD" cap).
    const cats = results.filter((r) => r.rank.accept).map((r) => qualityScore(r.title, {}).info.category);
    const bestSeen = cats.reduce<Category | null>((a, c) => (!a || ladderRank(c) > ladderRank(a) ? c : a), (st?.best_seen as Category | null) ?? null);
    const sawBd = cats.some((c) => c.startsWith("bluray"));
    const noBd = sawBd ? 0 : (st?.no_bd ?? 0) + 1;
    const prof = profileFor(u.tvdbId);
    const pick = pickUpgrade(results, u, { seadex: seadexForSeason(u.tvdbId, u.season), mode: prof.watchMode, minConfidence });
    const label = `${u.title} S${String(u.season).padStart(2, "0")}`;
    if (!pick) {
      save(u.tvdbId, u.season, { state: "waiting", why: `nothing better yet (${results.length} releases seen; goal ${goalLabel(u.goal)})`, now, searched: true, bestSeen, noBd, release: null });
      continue;
    }
    const from = CATEGORY_NAME[u.files[0].q.info.category];
    const why = `Quality upgrade for ${label}: ${pick.result.title} (${CATEGORY_NAME[pick.q.info.category]}${pick.q.why.length ? `, ${pick.q.why.join(", ")}` : ""}) for ${pick.covered.length} episode${pick.covered.length > 1 ? "s" : ""}: ${pick.why}`;
    try {
      const candidates = [pick.result, ...results.filter((r) => r !== pick.result && pickUpgrade([r], u, { seadex: seadexForSeason(u.tvdbId, u.season), mode: prof.watchMode, minConfidence })?.covered.length === pick.covered.length)];
      const out = await deps.grab({ tvdbId: u.tvdbId, episodeIds: pick.covered, candidate: toCandidate(pick.result), fallbacks: candidates.slice(1, 4).map(toCandidate), origin: "managed", purpose: "replace" });
      if (!out.dryRun && !out.failed) {
        note("grab", now);
        res.grabbed++;
      }
      const state = out.dryRun ? "found" : out.failed ? "waiting" : "grabbed";
      save(u.tvdbId, u.season, { state, why: `${out.dryRun ? "dry-run: " : ""}${out.message}`, now, searched: true, release: pick.result.title, grabId: out.dryRun || out.failed ? null : out.id, bestSeen, noBd });
      logDecision("info", { tvdbId: u.tvdbId, title: u.title, episodeIds: pick.covered, release: pick.result.title, why: `${why}. ${out.dryRun ? "Dry-run: nothing grabbed" : out.failed ? `Couldn't grab: ${out.message}` : `Grabbed; each new file replaces your ${from} file only after it passes the checks, and the old one goes to the recycling bin`}` });
    } catch (e) {
      save(u.tvdbId, u.season, { state: "waiting", why: `grab failed: ${(e as Error).message}`, now, searched: true, bestSeen, noBd, release: null });
    }
  }
  return res;
}

let running = false;
export async function qualityUpgradeTick() {
  if (running || getSettings().qualityUpgrade.mode === "off" || !searchConfigured()) return;
  running = true;
  try {
    const r = await qualityUpgradePass();
    setJob("quality upgrades", "done", r.planned ? `plan listed: ${r.units} seasons below their goal` : r.paused ? `paused (${r.units} seasons below their goal)` : `${r.units} seasons below their goal; ${r.searched} searched, ${r.grabbed} grabbed`);
  } catch (e) {
    setJob("quality upgrades", "error", (e as Error).message);
  } finally {
    running = false;
  }
}

/** For the Audit tab: the plan / seasons below their goal with their state, budgets and switches. */
export function qualityUpgradeView(now = Date.now()) {
  const s = getSettings().qualityUpgrade;
  const units = upgradeUnits(now);
  const items = units.map((u) => {
    const st = stateOf(u.tvdbId, u.season);
    return { tvdbId: u.tvdbId, title: u.title, season: u.season, goal: goalLabel(u.goal), target: CATEGORY_NAME[u.target], episodes: u.files.length, now: [...new Set(u.files.map((f) => CATEGORY_NAME[f.q.info.category]))], why: u.why, state: st?.state ?? "waiting", stateWhy: st?.why ?? "not searched yet", release: st?.release ?? null, lastAt: st?.last_at ?? null };
  });
  const shown = new Set(items.map((i) => `${i.tvdbId}|${i.season}`));
  const recent = (db.prepare("SELECT * FROM quality_upgrade WHERE state IN ('upgraded', 'grabbed') AND updated_at > ? ORDER BY updated_at DESC LIMIT 50").all(now - 30 * DAY) as unknown as StateRow[])
    .filter((r) => !shown.has(`${r.tvdb_id}|${r.season}`))
    .map((r) => ({ tvdbId: r.tvdb_id, title: (cache.prepare("SELECT title FROM series WHERE tvdb_id = ?").get(r.tvdb_id) as { title: string } | undefined)?.title ?? String(r.tvdb_id), season: r.season, state: r.state, why: r.why, at: r.updated_at }));
  return { mode: s.mode, paused: s.paused, seasonsPerDay: s.seasonsPerDay, grabsToday: count("grab", now - DAY), plan: planState(now), items, recent };
}
