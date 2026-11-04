/**
 * Managed shows: AnimeArr decides and grabs for a user-selected set of series; Sonarr stays the importer/library.
 *
 * - Watch: episodes from the synced Sonarr calendar. The first search runs `searchDelayMin` after air, then retries with
 *   the backoff list until `maxAttempts`. A cheap "RSS" pass reads Prowlarr's recent releases and triggers an episode
 *   as soon as a matching release shows up.
 * - Decide: Deep Search + ranking. Automatic grabs need an accepted release, mapping confidence ≥ minConfidence and
 *   P(profile language) ≥ 50%.
 * - DRY-RUN by default (global switch AND per show): the log says "would grab X".
 */
import { isDropped } from "./dropped.js";
import { parseRelease } from "../core/parser.js";
import { matchMovie } from "./movies.js";
import { episodesAreNew, grabGate, GrabsPausedError } from "../grabs/downloads.js";
import { NATIVE_BASE } from "./nativeIds.js";
import { listManaged, type ManagedRow } from "./managedList.js";
import { logDecision } from "../system/activity.js";
import { couldntSearch, outageBackoffMs, searchConfigured } from "../search/indexers.js";
import { searchAll } from "../search/indexers.js";
import { setSeriesMonitored } from "../arr/sonarr.js";
import { identify } from "../core/identify.js";
import { cache, db, dbState, setJob, tx } from "../system/db.js";
import { startGrab } from "../grabs/pipeline.js";
import { toCandidate } from "../grabs/pipelineState.js";
import { decisionSummary, deepSearch, identifyContext, seasonGroupOf, type SearchResult } from "../search/search.js";
import { getSettings, isDryRun, underAllowedRoot } from "../system/settings.js";
import { burnedInFact } from "./audit.js";
import { coverFor } from "../metadata/covers.js";
import { profileFor } from "./profiles.js";
import { newerVersionOf } from "../search/propers.js";
import { CATEGORY_NAME, ladderRank, qualityScore } from "../core/quality.js";
import { hintProper, recheckSoon, upgradeUnits, type Unit } from "../search/qualityUpgrade.js";
import { missingScoped, scopedEpisodeIds } from "./scope.js";
import { planWrongLanguage } from "./episodes.js";
import { binUsable } from "../import/binpurge.js";

const DAY = 86_400_000;

/** Current anime season window (Winter = Jan–Mar ...). */
export function seasonWindow(now = new Date()) {
  const q = Math.floor(now.getUTCMonth() / 3);
  const start = Date.UTC(now.getUTCFullYear(), q * 3, 1);
  const end = Date.UTC(now.getUTCFullYear(), q * 3 + 3, 1);
  return { name: ["Winter", "Spring", "Summer", "Fall"][q], year: now.getUTCFullYear(), start, end };
}

/** Library series with the facts the bulk "choose what AnimeArr manages" screen filters on. */
export function candidates() {
  const w = seasonWindow();
  const managed = new Map(listManaged().map((m) => [m.tvdbId, m]));
  const tags = new Map<number, string>();
  const rows = cache
    .prepare(
      "SELECT id, tvdb_id, title, path, status, monitored, tags, poster, anidb_status, network, next_airing, previous_airing FROM series ORDER BY sort_title",
    )
    .all() as {
    id: number;
    tvdb_id: number;
    title: string;
    path: string;
    status: string;
    monitored: number;
    tags: string;
    poster: string | null;
    anidb_status: string;
    network: string | null;
    next_airing: string | null;
    previous_airing: string | null;
  }[];
  const airing = cache
    .prepare(
      "SELECT series_id, COUNT(*) AS n, MIN(air_utc) AS first FROM episodes WHERE season > 0 AND air_utc >= ? AND air_utc < ? GROUP BY series_id",
    )
    .all(w.start - 14 * DAY, w.end) as { series_id: number; n: number; first: number }[];
  const airingBy = new Map(airing.map((a) => [a.series_id, a]));
  return {
    season: { name: w.name, year: w.year },
    allowedRoots: getSettings().allowedRoots,
    series: rows.map((r) => ({
      seriesId: r.id,
      tvdbId: r.tvdb_id,
      title: r.title,
      path: r.path,
      status: r.status,
      monitored: !!r.monitored,
      tags: (JSON.parse(r.tags) as number[]).map((t) => tags.get(t) ?? t),
      cover: coverFor(r),
      network: r.network,
      airingThisSeason: airingBy.has(r.id),
      episodesThisSeason: airingBy.get(r.id)?.n ?? 0,
      nextAiring: r.next_airing,
      anidb: r.anidb_status,
      allowed: underAllowedRoot(r.path),
      managed: managed.has(r.tvdb_id),
      dryRun: managed.get(r.tvdb_id)?.dryRun ?? true,
    })),
  };
}

export function setManaged(
  tvdbIds: number[],
  on: boolean,
  opts: { live?: boolean } = {},
): { changed: number; refused: { tvdbId: number; title: string; reason: string }[] } {
  if (dbState.corrupt)
    throw Object.assign(new Error("The database failed its integrity check; restore a backup first"), { statusCode: 503 });
  const refused: { tvdbId: number; title: string; reason: string }[] = [];
  let changed = 0;
  for (const tvdbId of tvdbIds) {
    const s = cache.prepare("SELECT id, title, path FROM series WHERE tvdb_id = ?").get(tvdbId) as
      { id: number; title: string; path: string } | undefined;
    if (!s) {
      refused.push({ tvdbId, title: String(tvdbId), reason: "not in the synced library" });
      continue;
    }
    if (on) {
      if (isDropped(tvdbId)) {
        refused.push({ tvdbId, title: s.title, reason: "you dropped it (un-drop it on its page first)" });
        continue;
      }
      if (!underAllowedRoot(s.path)) {
        refused.push({ tvdbId, title: s.title, reason: `its folder ${s.path} is not under an allowed root folder` });
        continue;
      }
      // Dry-run unless the caller confirmed live (the Shows confirm dialog, the fill-in queue).
      const live = !!opts.live && !getSettings().managed.dryRun;
      const r = db
        .prepare("INSERT INTO managed (tvdb_id, series_id, title, dry_run, since) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tvdb_id) DO NOTHING")
        .run(tvdbId, s.id, s.title, live ? 0 : 1, Date.now());
      if (r.changes) {
        changed++;
        logDecision("managed", {
          tvdbId,
          title: s.title,
          why: `${s.title} is now managed by AnimeArr${live ? "" : " (in dry run: it only logs what it would grab; Settings → Automation & safety → Practice mode)"}`,
          undo: { action: "unmanage", args: { tvdbId } },
        });
      }
    } else {
      const r = db.prepare("DELETE FROM managed WHERE tvdb_id = ?").run(tvdbId);
      db.prepare("DELETE FROM search_state WHERE tvdb_id = ?").run(tvdbId);
      if (r.changes) {
        changed++;
        logDecision("managed", {
          tvdbId,
          title: s.title,
          why: `${s.title} is no longer managed by AnimeArr`,
          undo: { action: "manage", args: { tvdbId } },
        });
      }
    }
  }
  return { changed, refused };
}

export function setShowDryRun(tvdbId: number, dryRun: boolean) {
  const r = db.prepare("UPDATE managed SET dry_run = ? WHERE tvdb_id = ?").run(dryRun ? 1 : 0, tvdbId);
  if (!r.changes) throw Object.assign(new Error("That show isn't managed"), { statusCode: 404 });
  if (!dryRun && !getSettings().managed.dryRun) releaseDryRunDecisions(tvdbId);
  const m = listManaged().find((x) => x.tvdbId === tvdbId)!;
  logDecision("managed", {
    tvdbId,
    title: m.title,
    why: dryRun
      ? `Dry-run turned ON for ${m.title}`
      : `Dry-run turned OFF for ${m.title}${getSettings().managed.dryRun ? " (the global dry-run switch is still on, so nothing is grabbed yet)" : ": AnimeArr will grab for real"}`,
  });
}

/** Optional, user-confirmed: stop Sonarr from also searching for a managed show. */
export async function unmonitorInSonarr(tvdbId: number, monitored: boolean) {
  const m = listManaged().find((x) => x.tvdbId === tvdbId);
  if (!m) throw Object.assign(new Error("That show isn't managed"), { statusCode: 404 });
  if (m.seriesId >= NATIVE_BASE)
    throw Object.assign(new Error("This show was added in AnimeArr; Sonarr doesn't have it"), { statusCode: 409 });
  const s = cache.prepare("SELECT path FROM series WHERE tvdb_id = ?").get(tvdbId) as { path: string } | undefined;
  if (!underAllowedRoot(s?.path)) throw Object.assign(new Error("Outside the allowed root folders"), { statusCode: 403 });
  await setSeriesMonitored(m.seriesId, monitored);
  db.prepare("UPDATE managed SET unmonitored_in_sonarr = ? WHERE tvdb_id = ?").run(monitored ? 0 : 1, tvdbId);
  logDecision("sonarr", {
    tvdbId,
    title: m.title,
    why: monitored
      ? `Set ${m.title} back to monitored in Sonarr`
      : `Set ${m.title} to unmonitored in Sonarr, so only AnimeArr searches for it`,
    undo: monitored ? null : { action: "remonitor", args: { tvdbId } },
  });
}

// ---------------------------------------------------------------- schedule

interface StateRow {
  episode_id: number;
  tvdb_id: number;
  air_utc: number | null;
  next_at: number;
  attempts: number;
  last_at: number | null;
  state: string;
  last_why: string;
  kind?: string;
  /** Searches in a row that didn't count because an indexer didn't answer (0 once one counts). */
  outage_streak?: number;
}

/** Creates/updates search_state rows for aired-or-airing episodes of managed shows that have no file. */
export function planSchedule(now = Date.now()) {
  const s = getSettings().managed;
  const managed = listManaged();
  let added = 0;
  for (const m of managed) {
    const scoped = scopedEpisodeIds(m.tvdbId, m.seriesId, now);
    const eps = cache
      .prepare("SELECT id, air_utc, has_file FROM episodes WHERE series_id = ? AND air_utc IS NOT NULL AND air_utc <= ? AND air_utc >= ?")
      .all(m.seriesId, now + DAY, now - 30 * DAY) as { id: number; air_utc: number; has_file: number }[];
    for (const e of eps) {
      if (!e.has_file && !scoped.has(e.id)) {
        db.prepare(
          "UPDATE search_state SET state = 'done', last_why = 'outside the monitoring scope' WHERE episode_id = ? AND state IN ('waiting', 'retry')",
        ).run(e.id);
        continue;
      }
      if (e.has_file) {
        db.prepare(
          "UPDATE search_state SET state = 'done', last_why = 'Sonarr has a file' WHERE episode_id = ? AND state NOT IN ('done', 'replace')",
        ).run(e.id);
        continue;
      }
      const r = db
        .prepare(
          "INSERT INTO search_state (episode_id, tvdb_id, air_utc, next_at, state) VALUES (?, ?, ?, ?, 'waiting') ON CONFLICT(episode_id) DO NOTHING",
        )
        .run(e.id, m.tvdbId, e.air_utc, e.air_utc + s.searchDelayMin * 60_000);
      added += Number(r.changes) || reopenReturned(e.id, "new", e.air_utc + s.searchDelayMin * 60_000);
    }
  }
  return added;
}

export function scheduleFor(tvdbId?: number, limit = 500) {
  const rows = (tvdbId
    ? db.prepare("SELECT * FROM search_state WHERE tvdb_id = ? ORDER BY air_utc DESC LIMIT ?").all(tvdbId, limit)
    : db.prepare("SELECT * FROM search_state ORDER BY next_at LIMIT ?").all(limit)) as unknown as StateRow[];
  const info = new Map<number, { season: number; episode: number; title: string | null }>();
  for (let i = 0; i < rows.length; i += 400) {
    const ids = rows.slice(i, i + 400).map((r) => r.episode_id);
    for (const e of cache
      .prepare(`SELECT id, season, episode, title FROM episodes WHERE id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as { id: number; season: number; episode: number; title: string | null }[])
      info.set(e.id, e);
  }
  return rows.map((r) => {
    const e = info.get(r.episode_id);
    return {
      episodeId: r.episode_id,
      tvdbId: r.tvdb_id,
      season: e?.season ?? null,
      episode: e?.episode ?? null,
      title: e?.title ?? null,
      airUtc: r.air_utc,
      nextAt: r.next_at,
      attempts: r.attempts,
      lastAt: r.last_at,
      state: r.state,
      why: r.last_why,
    };
  });
}

/**
 * The releases an automatic grab may take (the scheduler, ⚡ automatic search): accepted, confident mapping, likely
 * the profile's language, exactly the episodes asked for, no burn-ins (unless the user confirmed that's all there is),
 * no dead torrents. Best first (the results are ranked already).
 */
export function automaticPicks(
  results: SearchResult[],
  tvdbId: number,
  season: number | null,
  opts: { allowPacks?: boolean; allowExtras?: boolean; delays?: boolean } = {},
) {
  const s = getSettings().managed;
  const burnedOk = profileFor(tvdbId).subLangs.some((l) => !!burnedInFact(tvdbId, season, l));
  const ok = results.filter(
    (r) =>
      r.rank.accept &&
      r.confidence >= s.minConfidence &&
      r.rank.langProb >= 0.5 &&
      (opts.allowPacks ? r.episodeIds.length > 0 : r.coversTarget) &&
      (r.extra <= 0 || !!opts.allowExtras) &&
      (burnedOk || !r.rank.flags.some((f) => f.key === "burnIn")) &&
      !(r.protocol === "torrent" && r.seeders === 0),
  );
  return opts.delays ? ok.filter((r) => delayLeftMin(r) === 0) : ok;
}

/**
 * Sonarr-style delay (Settings → Download clients): an automatic grab of a protocol waits until the release is this
 * many minutes old, so a Usenet release can show up before a torrent is taken (or the other way round).
 */
export function delayLeftMin(r: { protocol: "usenet" | "torrent"; ageHours: number | null }) {
  const p = getSettings().protocol ?? { usenetDelayMin: 0, torrentDelayMin: 0 };
  const delay = r.protocol === "usenet" ? p.usenetDelayMin : p.torrentDelayMin;
  if (!delay || r.ageHours === null) return 0;
  return Math.max(0, Math.ceil(delay - r.ageHours * 60));
}

/** Searches one episode of a managed show and grabs (or, in dry-run, logs) the best acceptable release. */
export async function decideEpisode(st: StateRow, now = Date.now()) {
  const s = getSettings().managed;
  const backlog = st.kind === "backlog" && st.state !== "replace";
  const m = listManaged().find((x) => x.tvdbId === st.tvdb_id);
  if (!m) return;
  // Grabs paused by a download-folder rule: wait without searching or using up an attempt.
  const gate = grabGate("show", episodesAreNew([st.episode_id], now));
  if (gate.paused) {
    db.prepare("UPDATE search_state SET next_at = ?, last_why = ? WHERE episode_id = ?").run(
      now + 30 * 60_000,
      `Grabs are paused: ${gate.why}`,
      st.episode_id,
    );
    return;
  }
  const res = await deepSearch(st.tvdb_id, [st.episode_id], { budget: 8 });
  // Indexers down (all of them, or some): "nothing found" doesn't count; see below, once the picks are known.
  const gap = couldntSearch(res);
  const season = res.targets[0]?.season ?? null;
  const ok = automaticPicks(res.results, st.tvdb_id, season, { delays: true });
  // Everything good is still inside its protocol delay: look again when the first one is old enough.
  const waiting = ok.length ? [] : automaticPicks(res.results, st.tvdb_id, season).filter((r) => delayLeftMin(r) > 0);
  if (waiting.length) {
    const left = Math.min(...waiting.map(delayLeftMin));
    const w = waiting.find((r) => delayLeftMin(r) === left)!;
    db.prepare("UPDATE search_state SET next_at = ?, last_why = ? WHERE episode_id = ?").run(
      now + left * 60_000 + 60_000,
      `Waiting ${left} min for the ${w.protocol === "usenet" ? "Usenet" : "torrent"} delay (${w.title})`,
      st.episode_id,
    );
    return;
  }
  // Group consistency on airing shows: the season's group usually posts within hours; wait for it a while (a day, or
  // three with "strongly prefer") before taking another group's release.
  const weight = profileFor(st.tvdb_id).groupConsistency ?? "prefer";
  const sid = (cache.prepare("SELECT id FROM series WHERE tvdb_id = ?").get(st.tvdb_id) as { id: number } | undefined)?.id;
  const sg = sid !== undefined ? seasonGroupOf(sid, season, weight, [st.episode_id]) : null;
  // Only when the season's group hasn't posted at all (a release of it that was rejected is no reason to wait).
  if (sg && ok.length && !res.results.some((r) => r.group?.toLowerCase() === sg.group.toLowerCase())) {
    const air =
      (cache.prepare("SELECT air_utc FROM episodes WHERE id = ?").get(st.episode_id) as { air_utc: number | null } | undefined)?.air_utc ??
      null;
    const until = air !== null ? air + (sg.weight === "strong" ? 72 : 24) * 3_600_000 : 0;
    if (until > now) {
      db.prepare("UPDATE search_state SET next_at = ?, last_why = ? WHERE episode_id = ?").run(
        Math.min(now + 60 * 60_000, until),
        `Waiting for ${sg.group} (the season's group) until ${new Date(until).toISOString().slice(0, 16).replace("T", " ")} UTC; then the best other release`,
        st.episode_id,
      );
      return;
    }
  }
  const { best, why } = decisionSummary(ok.length ? ok : res.results);
  // Nothing to grab, but not every indexer answered: not an attempt (no give-up, no backoff, no retryDays), asked
  // again soon, and the reason is on the schedule (review 2026-11-02, M4).
  // Each such search in a row waits longer (30 min … a day), so one flaky indexer doesn't cost a full search every
  // 30 min forever (blind review 2026-11-03, R3); the streak resets once a search counts.
  if (gap && !(best && ok.includes(best))) {
    outagesThisRound++;
    if (gap.kind === "all") allDownThisRound++;
    const streak = st.outage_streak ?? 0;
    const wait = outageBackoffMs(streak);
    db.prepare("UPDATE search_state SET next_at = ?, last_why = ?, outage_streak = ? WHERE episode_id = ?").run(
      now + wait,
      `Couldn't search fully: ${gap.why}; ${res.found} releases seen, trying again in ${Math.round(wait / 60_000)} min`,
      streak + 1,
      st.episode_id,
    );
    return;
  }
  const attempts = st.attempts + 1;
  const backoff = s.backoffMin[Math.min(attempts - 1, s.backoffMin.length - 1)] * 60_000;
  if (best && ok.includes(best)) {
    const out = await startGrab({
      tvdbId: st.tvdb_id,
      episodeIds: [st.episode_id],
      candidate: toCandidate(best),
      fallbacks: ok.filter((x) => x !== best).map(toCandidate),
      origin: "managed",
    });
    const failedState = backlog ? "backlog" : "retry";
    const state = out.dryRun ? "would-grab" : out.failed ? failedState : "grabbed";
    db.prepare(
      "UPDATE search_state SET attempts = ?, last_at = ?, next_at = ?, state = ?, last_why = ?, grab_id = ?, outage_streak = 0 WHERE episode_id = ?",
    ).run(attempts, now, out.failed ? now + (backlog ? DAY : backoff) : now, state, out.message, out.id, st.episode_id);
    return;
  }
  const label = `${m.title} ${res.targets[0] ? `S${res.targets[0].season}E${res.targets[0].episode}` : ""}`;
  if (backlog) {
    // Missing-episode search: no give-up, just try again in retryDays (RSS can still bring it forward).
    const days = getSettings().backlog.retryDays;
    db.prepare(
      "UPDATE search_state SET attempts = ?, last_at = ?, next_at = ?, state = 'backlog', last_why = ?, outage_streak = 0 WHERE episode_id = ?",
    ).run(attempts, now, now + days * DAY, `${why} (${res.found} releases seen)`, st.episode_id);
    logDecision("skip", {
      tvdbId: st.tvdb_id,
      title: m.title,
      episodeIds: [st.episode_id],
      why: `Missing-episode search, ${label}: ${why}. Next try in ${days} days.`,
    });
    return;
  }
  const gaveUp = attempts >= s.maxAttempts;
  db.prepare(
    "UPDATE search_state SET attempts = ?, last_at = ?, next_at = ?, state = ?, last_why = ?, outage_streak = 0 WHERE episode_id = ?",
  ).run(attempts, now, now + backoff, gaveUp ? "gave-up" : "retry", `${why} (${res.found} releases seen)`, st.episode_id);
  logDecision("skip", {
    tvdbId: st.tvdb_id,
    title: m.title,
    episodeIds: [st.episode_id],
    why: `${label}: ${why}. ${gaveUp ? `Gave up after ${attempts} searches.` : `Next try in ${Math.round(backoff / 60_000)} min.`}`,
  });
}

/** Leaving dry-run: episodes that were only "would grab" get searched for real on the next tick. */
export function releaseDryRunDecisions(tvdbId?: number) {
  const now = Date.now();
  const r = tvdbId
    ? db
        .prepare(
          "UPDATE search_state SET state = CASE kind WHEN 'backlog' THEN 'backlog' ELSE 'waiting' END, next_at = ?, last_why = 'dry-run turned off' WHERE state = 'would-grab' AND tvdb_id = ?",
        )
        .run(now, tvdbId)
    : db
        .prepare(
          "UPDATE search_state SET state = CASE kind WHEN 'backlog' THEN 'backlog' ELSE 'waiting' END, next_at = ?, last_why = 'dry-run turned off' WHERE state = 'would-grab'",
        )
        .run(now);
  return Number(r.changes);
}

async function decideSafely(st: StateRow, now: number) {
  try {
    await decideEpisode(st, now);
  } catch (e) {
    if (e instanceof GrabsPausedError) {
      db.prepare("UPDATE search_state SET next_at = ?, last_why = ? WHERE episode_id = ?").run(now + 30 * 60_000, e.message, st.episode_id);
      return;
    }
    // Errors count as an attempt, so a permanently broken episode (removed series, outside the allowed roots)
    // ends in "gave-up" instead of retrying forever. Backlog rows just wait a day.
    const attempts = st.attempts + 1;
    if (st.kind === "backlog") {
      db.prepare("UPDATE search_state SET attempts = ?, last_at = ?, last_why = ?, next_at = ? WHERE episode_id = ?").run(
        attempts,
        now,
        `Error: ${(e as Error).message}`,
        now + DAY,
        st.episode_id,
      );
      return;
    }
    const gaveUp = attempts >= getSettings().managed.maxAttempts;
    db.prepare("UPDATE search_state SET attempts = ?, last_at = ?, state = ?, last_why = ?, next_at = ? WHERE episode_id = ?").run(
      attempts,
      now,
      gaveUp ? "gave-up" : "retry",
      `Error: ${(e as Error).message}`,
      now + 30 * 60_000,
      st.episode_id,
    );
  }
}

const HOUR = 3_600_000;
const BACKLOG_STATES = "('backlog', 'retry')"; // a failed backlog grab comes back as 'retry' but stays in the backlog's budget

const LEFT_SONARR = "no longer in Sonarr";
/**
 * A search closed because its episode left Sonarr's list reopens when the episode is back (still missing, in scope):
 * the close may have come from a cache gap (a rebuilt cache, a half answer), and the schedule's insert never touches
 * an existing row (review 2026-11-02, H11). Returns 1 when it reopened.
 */
function reopenReturned(episodeId: number, kind: "new" | "backlog", nextAt: number): number {
  return Number(
    db
      .prepare(
        "UPDATE search_state SET state = ?, kind = ?, attempts = 0, outage_streak = 0, next_at = ?, last_why = 'back in Sonarr' WHERE episode_id = ? AND state = 'done' AND last_why = ?",
      )
      .run(kind === "new" ? "waiting" : "backlog", kind, nextAt, episodeId, LEFT_SONARR).changes,
  );
}

/**
 * Closes schedule rows whose episode got a file in the meantime (Sonarr, a manual import), was unmonitored, left
 * Sonarr or isn't managed any more. Runs even while the missing-episode search is off. 'replace' rows are left
 * alone: they have a (bad) file by design.
 */
function closeFound(now = Date.now()) {
  const managedMap = new Map(listManaged().map((m) => [m.tvdbId, m.seriesId]));
  const managedIds = new Set(managedMap.keys());
  const scopes = new Map<number, Set<number>>();
  const inScopeCached = (tvdbId: number, episodeId: number) => {
    if (!scopes.has(tvdbId))
      scopes.set(tvdbId, managedMap.has(tvdbId) ? scopedEpisodeIds(tvdbId, managedMap.get(tvdbId)!, now) : new Set());
    return scopes.get(tvdbId)!.has(episodeId);
  };
  const epInfo = cache.prepare("SELECT has_file, monitored FROM episodes WHERE id = ?");
  const close = db.prepare("UPDATE search_state SET state = 'done', last_why = ? WHERE episode_id = ?");
  const rows = db
    .prepare("SELECT episode_id, tvdb_id, kind FROM search_state WHERE state IN ('backlog', 'waiting', 'retry', 'would-grab')")
    .all() as { episode_id: number; tvdb_id: number; kind: string }[];
  tx(db, () => {
    for (const r of rows) {
      const e = epInfo.get(r.episode_id) as { has_file: number; monitored: number } | undefined;
      if (!e) close.run(LEFT_SONARR, r.episode_id);
      else if (e.has_file) close.run("Sonarr has a file", r.episode_id);
      else if (r.kind === "backlog" && !managedIds.has(r.tvdb_id)) close.run("not managed", r.episode_id);
      else if (managedIds.has(r.tvdb_id) && !inScopeCached(r.tvdb_id, r.episode_id))
        close.run("outside the monitoring scope", r.episode_id);
    }
  });
}

/**
 * Plans the missing-episode search: aired (more than 30 days ago, newer ones are the normal schedule's), monitored
 * episodes of managed shows without a file. Episodes the normal schedule gave up on join after retryDays.
 */
export function planBacklog(now = Date.now()) {
  const b = getSettings().backlog;
  if (b.enabled)
    db.prepare(
      "UPDATE search_state SET state = 'backlog', kind = 'backlog', attempts = 0, outage_streak = 0, next_at = ?, last_why = 'back in the missing-episode search' WHERE state = 'gave-up' AND COALESCE(last_at, 0) < ?",
    ).run(now, now - b.retryDays * DAY);
  closeFound(now);
  if (!b.enabled) return 0;
  const cutoff = now - b.retryDays * DAY;
  const insert = db.prepare(
    "INSERT INTO search_state (episode_id, tvdb_id, air_utc, next_at, state, kind) VALUES (?, ?, ?, ?, 'backlog', 'backlog') ON CONFLICT(episode_id) DO NOTHING",
  );
  // A 'done' episode that is missing again (file deleted) rejoins, but never right after AnimeArr imported it
  // (the cache can lag behind the import until the next refresh).
  const reopen = db.prepare(
    "UPDATE search_state SET state = 'backlog', kind = 'backlog', attempts = 0, outage_streak = 0, next_at = ?, last_why = 'missing again' WHERE episode_id = ? AND state = 'done' AND COALESCE(last_at, 0) < ? AND NOT EXISTS (SELECT 1 FROM grabs g WHERE g.id = search_state.grab_id AND g.updated_at > ?)",
  );
  const listEps = cache.prepare(
    "SELECT id, air_utc FROM episodes WHERE series_id = ? AND has_file = 0 AND air_utc IS NOT NULL AND air_utc < ?",
  );
  let added = 0;
  tx(db, () => {
    for (const m of listManaged()) {
      const scoped = scopedEpisodeIds(m.tvdbId, m.seriesId, now);
      for (const e of (listEps.all(m.seriesId, now - 30 * DAY) as { id: number; air_utc: number }[]).filter((x) => scoped.has(x.id))) {
        const n = Number(insert.run(e.id, m.tvdbId, e.air_utc, now).changes);
        added += n || reopenReturned(e.id, "backlog", now) || Number(reopen.run(now, e.id, cutoff, cutoff).changes);
      }
    }
  });
  return added;
}

/** Backlog searches in the last hour (an explicit log: one row per search, whatever its outcome). */
const searchesLastHour = (now: number) =>
  (db.prepare("SELECT COUNT(*) AS n FROM backlog_searches WHERE at > ?").get(now - HOUR) as { n: number }).n;

let lastPlan = 0;
/**
 * Missing-episode searches that are due, within the hourly budget. RSS finds first, then newest episodes first (like
 * Sonarr's Wanted list). Planning (a scan of the library) runs at most every 30 minutes.
 */
export async function backlogPass(now = Date.now(), opts: { plan?: boolean } = {}) {
  if (opts.plan ?? now - lastPlan >= 30 * 60_000) {
    lastPlan = now;
    planBacklog(now);
    // Off by default: a library imported before AnimeArr can hold thousands of raw or wrong-language files.
    if (getSettings().backlog.wrongLanguage) planWrongLanguage(now);
  }
  const b = getSettings().backlog;
  if (!b.enabled) return 0;
  db.prepare("DELETE FROM backlog_searches WHERE at < ?").run(now - DAY);
  const take = Math.min(2, b.perHour - searchesLastHour(now));
  if (take <= 0) return 0;
  const due = db
    .prepare(
      `SELECT * FROM search_state WHERE kind = 'backlog' AND state IN ${BACKLOG_STATES} AND next_at <= ? ORDER BY (last_why LIKE 'New release seen%') DESC, air_utc DESC LIMIT ?`,
    )
    .all(now, take) as unknown as StateRow[];
  for (const st of due) {
    // Counts against the hourly budget whatever the outcome (Prowlarr down included).
    db.prepare("INSERT INTO backlog_searches (at) VALUES (?)").run(now);
    db.prepare("UPDATE search_state SET last_at = ? WHERE episode_id = ?").run(now, st.episode_id);
    await decideSafely({ ...st, kind: "backlog" }, now);
  }
  return due.length;
}

/** What the missing-episode search has to do (for Settings). */
export function backlogSummary(now = Date.now()) {
  const b = getSettings().backlog;
  // Missing episodes (the shared definition, scope.ts) of managed shows; `missing` is the older part this search
  // covers (aired more than 30 days ago), `missingAll` every one (newer ones are the normal schedule's).
  const all = listManaged();
  const per = new Map(all.map((m) => [m.tvdbId, missingScoped(m.tvdbId, m.seriesId, now)]));
  const count = (m: ManagedRow) => (per.get(m.tvdbId) ?? []).filter((e) => e.air_utc! < now - 30 * DAY).length;
  const missing = all.reduce((n, m) => n + count(m), 0);
  const missingAll = all.reduce((n, m) => n + (per.get(m.tvdbId)?.length ?? 0), 0);
  const liveRows = all.filter((m) => !isDryRun(m.dryRun));
  const live = liveRows.map((m) => m.seriesId);
  const missingLive = liveRows.reduce((n, m) => n + count(m), 0);
  const rows = db.prepare("SELECT state, COUNT(*) AS n FROM search_state WHERE kind = 'backlog' GROUP BY state").all() as {
    state: string;
    n: number;
  }[];
  return {
    ...b,
    missing,
    missingAll,
    missingLive,
    liveShows: live.length,
    states: Object.fromEntries(rows.map((r) => [r.state, r.n])),
    searchedLastHour: searchesLastHour(now),
  };
}

let ticking = false;
/** Searches this round that couldn't ask every indexer (the job's status says so instead of "done" alone). */
let outagesThisRound = 0;
/** Of those, searches where no indexer answered at all (a real outage: the job shows "error"). */
let allDownThisRound = 0;
/** Scheduler tick: plan, then search episodes that are due (a few per tick, to be gentle on indexers). */
export async function managedTick(now = Date.now()) {
  if (ticking || dbState.corrupt || !searchConfigured() || !listManaged().length) return;
  ticking = true;
  outagesThisRound = 0;
  allDownThisRound = 0;
  try {
    planSchedule(now);
    const due = db
      .prepare(
        "SELECT * FROM search_state WHERE state IN ('waiting', 'retry', 'replace') AND kind <> 'backlog' AND next_at <= ? ORDER BY next_at LIMIT 3",
      )
      .all(now) as unknown as StateRow[];
    for (const st of due) await decideSafely(st, now);
    const backlog = await backlogPass(now);
    const detail = `${listManaged().length} managed shows; ${due.length} episode searches this round${backlog ? ` + ${backlog} missing-episode searches` : ""}${isDryRun(null) ? " (dry-run)" : ""}`;
    // Some indexer missing on a few searches is a warning (those episodes back off), not a failed job; "error" only
    // when a search got no answer from any indexer.
    setJob(
      "managed",
      allDownThisRound ? "error" : "done",
      outagesThisRound
        ? `${detail}. Warning: ${outagesThisRound} couldn't reach every indexer (each tries again later, backing off)`
        : detail,
    );
  } finally {
    ticking = false;
  }
}

/** RSS-like pass: Prowlarr's recent releases; a release that maps to a waiting episode makes it due now. */
const rssSeen = new Map<string, number>(); // guid → first seen (each release is looked at once)

/**
 * RSS-style new-release watch: the newest releases of every indexer (AnimeArr's categories, the newest N of each). A
 * release for a wanted episode (managed show, any state that still wants a file) or a wanted movie brings that search
 * forward at once; the search then ranks every candidate, so RSS never grabs a release blindly. An episode that already
 * has a file is watched too: a newer version of it (v2, same group) or a better category than the file, in a season the
 * quality watcher keeps, makes that season's next check come now. The watcher's guard rails still decide what is grabbed.
 */
export async function rssTick(now = Date.now(), deps = { search: searchAll }) {
  if (dbState.corrupt || !searchConfigured()) return { checked: 0, hits: 0 };
  const waiting = db
    .prepare("SELECT episode_id, tvdb_id FROM search_state WHERE state IN ('waiting', 'retry', 'replace', 'backlog', 'gave-up')")
    .all() as { episode_id: number; tvdb_id: number }[];
  const movies = db.prepare("SELECT movie_id FROM movie_search WHERE state IN ('waiting', 'retry', 'unreleased')").all() as {
    movie_id: number;
  }[];
  const upgrades = getSettings().qualityUpgrade.mode !== "off" ? new Set(listManaged().map((m) => m.tvdbId)) : new Set<number>();
  if (!waiting.length && !movies.length && !upgrades.size) return { checked: 0, hits: 0 };
  const wanted = new Map(waiting.map((w) => [w.episode_id, w.tvdb_id]));
  const recent = (await deps.search("", { limit: 100, perIndexer: true })).filter((r) => !rssSeen.has(r.guid));
  // Remembered releases: the newest 20,000 (insertion order).
  while (rssSeen.size > 20_000) rssSeen.delete(rssSeen.keys().next().value!);
  const ctx = identifyContext();
  let hits = 0;
  let upgradeHits = 0;
  let units: Unit[] | null = null; // seasons below their goal, worked out when a release for a file we have first needs them
  const recycling = binUsable(); // a replacement needs a recycling bin the importer accepts
  const parseAlt = (s: string) => {
    try {
      return JSON.parse(s) as string[];
    } catch {
      return [];
    }
  };
  const movieRows = movies.length
    ? (
        cache
          .prepare(`SELECT id, title, original_title, alt_titles, year FROM movies WHERE id IN (${movies.map(() => "?").join(",")})`)
          .all(...movies.map((m) => m.movie_id)) as {
          id: number;
          title: string;
          original_title: string | null;
          alt_titles: string;
          year: number | null;
        }[]
      ).map((m) => ({ ...m, alts: parseAlt(m.alt_titles) }))
    : [];
  for (const r of recent) {
    rssSeen.set(r.guid, now);
    const id = identify(r.title, ctx, { publishDate: r.publishDate ? Date.parse(r.publishDate) : null });
    for (const e of id.resolution?.ok ? id.resolution.episodes : []) {
      if (!wanted.has(e.id)) continue;
      // A given-up episode gets one more search when a new release for it shows up.
      hits += Number(
        db
          .prepare(
            "UPDATE search_state SET next_at = ?, last_why = ?, state = CASE state WHEN 'gave-up' THEN 'retry' ELSE state END WHERE episode_id = ? AND (next_at > ? OR state = 'gave-up')",
          )
          .run(now, `New release seen: ${r.title}`, e.id, now).changes,
      );
    }
    const tvdbId = id.candidate?.tvdbId;
    if (tvdbId !== undefined && upgrades.has(tvdbId) && id.resolution?.ok) {
      const owned = id.resolution.episodes.filter(
        (e) =>
          !wanted.has(e.id) &&
          (cache.prepare("SELECT has_file FROM episodes WHERE id = ?").get(e.id) as { has_file: number } | undefined)?.has_file,
      );
      if (owned.length) {
        const title = ctx.index.library(tvdbId)?.title ?? id.summary;
        const seasons = [...new Set(owned.map((e) => e.season))];
        const newer = recycling
          ? newerVersionOf(
              tvdbId,
              owned.map((e) => e.id),
              r.title,
            )
          : { ok: false, why: "" };
        if (newer.ok) {
          // A newer version of a file we have: the watcher checks those episodes for one on its next pass.
          hintProper(
            owned.map((e) => e.id),
            now,
          );
          for (const season of seasons) recheckSoon(tvdbId, season);
          upgradeHits++;
          logDecision("info", {
            tvdbId,
            title,
            episodeIds: owned.map((e) => e.id),
            release: r.title,
            why: `New release seen: ${r.title}, ${newer.why}. Checking for a newer version of ${owned.length > 1 ? `${owned.length} episodes` : `episode ${id.resolution.label}`} soon; nothing is grabbed from the feed`,
          });
        } else {
          units ??= await upgradeUnits(now);
          const cat = qualityScore(r.title, {}).info.category;
          for (const season of seasons) {
            const unit = units.find((u) => u.tvdbId === tvdbId && u.season === season);
            const below = unit?.files.filter(
              (f) => !f.proper && owned.some((e) => e.id === f.episodeId) && ladderRank(cat) > ladderRank(f.q.info.category),
            );
            if (!unit || !below?.length || !recheckSoon(tvdbId, season)) continue;
            upgradeHits++;
            logDecision("info", {
              tvdbId,
              title,
              episodeIds: below.map((f) => f.episodeId),
              release: r.title,
              why: `New release seen: ${r.title} (${CATEGORY_NAME[cat]}), better than your ${CATEGORY_NAME[below[0].q.info.category]} files in season ${season}. Checking that season for an upgrade soon; nothing is grabbed from the feed`,
            });
          }
        }
      }
    }
    if (movieRows.length && !id.resolution?.ok) {
      const p = parseRelease(r.title);
      if (p.episodes.length) continue; // an episode release, not a movie
      for (const m of movieRows) {
        const mm = matchMovie(p, { title: m.title, original_title: m.original_title, alt_titles: m.alts, year: m.year });
        if (mm.confidence < 82) continue; // title + year match
        // An "unreleased" movie with a release out early is wanted now.
        hits += Number(
          db
            .prepare(
              "UPDATE movie_search SET next_at = ?, last_why = ?, state = CASE state WHEN 'unreleased' THEN 'waiting' ELSE state END WHERE movie_id = ? AND next_at > ?",
            )
            .run(now, `New release seen: ${r.title}`, m.id, now).changes,
        );
      }
    }
  }
  setJob(
    "rss",
    "done",
    `${recent.length} new releases checked, ${hits} for wanted episodes/movies${upgradeHits ? `, ${upgradeHits} newer versions/upgrades for files you have (checked soon)` : ""}`,
  );
  return { checked: recent.length, hits, upgradeHits };
}

/** For the "Manage selected" confirm: how many in-scope missing episodes these shows would search live. */
export function managePreview(tvdbIds: number[], now = Date.now()) {
  let missing = 0;
  for (const id of tvdbIds) {
    const s = cache.prepare("SELECT id FROM series WHERE tvdb_id = ?").get(id) as { id: number } | undefined;
    if (!s) continue;
    const scoped = scopedEpisodeIds(id, s.id, now);
    missing += (
      cache
        .prepare("SELECT id FROM episodes WHERE series_id = ? AND has_file = 0 AND air_utc IS NOT NULL AND air_utc <= ?")
        .all(s.id, now) as { id: number }[]
    ).filter((e) => scoped.has(e.id)).length;
  }
  return {
    shows: tvdbIds.length,
    missing,
    dryRun: getSettings().managed.dryRun,
    backlog: getSettings().backlog.enabled,
    perHour: getSettings().backlog.perHour,
  };
}
