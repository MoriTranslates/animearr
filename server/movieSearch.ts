/**
 * Automatic movie search: watches the anime movies AnimeArr wants (its own flag, not Radarr's monitored) for their release and searches the missing
 * ones (Sonarr/Radarr-style "Wanted"), within an hourly budget.
 *
 * - Only monitored anime movies inside the allowed root folders, without a file.
 * - First search delayHours after the digital/physical release (or when Radarr says it's available); not found →
 *   6 h, 12 h, 24 h, then every retryDays.
 * - Skips a movie AnimeArr or Radarr is already downloading. Honours the global dry-run.
 * - Same acceptance as the episode scheduler: accepted, confident match, likely the profile's language, no burn-in,
 *   torrents with seeders. Off by default (it grabs for real).
 */
import { grabGate } from "./downloads.js";
import { isNativeMovieId, nativeMovies } from "./native.js";
import { logDecision } from "./activity.js";
import { searchConfigured } from "./indexers.js";
import { radarrConfigured, radarrQueueFor } from "./arr/radarr.js";
import { cache, db, dbState, setJob, tx } from "./db.js";
import { isReleased, releaseAt, searchMovie, startMovieGrab, type MovieRow, isWanted } from "./movies.js";
import type { Candidate } from "./pipeline.js";
import { getSettings, underAllowedRoot } from "./settings.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BACKOFF = [6 * HOUR, 12 * HOUR, 24 * HOUR];

export interface MovieSearchDeps {
  search: typeof searchMovie;
  grab: typeof startMovieGrab;
  radarrQueue(movieId: number): Promise<unknown[]>;
}
const realDeps: MovieSearchDeps = { search: (id) => searchMovie(id), grab: (r) => startMovieGrab(r), radarrQueue: radarrQueueFor };

interface Row { movie_id: number; state: string; next_at: number; last_at: number | null; attempts: number; last_why: string; grab_id: number | null; release_at: number | null }

/** Creates/updates schedule rows for wanted movies; closes the ones that got a file or left scope. */
export function planMovies(now = Date.now()) {
  const s = getSettings().movieSearch;
  const movies = cache.prepare("SELECT * FROM movies WHERE is_anime = 1").all() as unknown as MovieRow[];
  let added = 0;
  tx(db, () => {
    for (const m of movies) {
      const row = db.prepare("SELECT * FROM movie_search WHERE movie_id = ?").get(m.id) as Row | undefined;
      const want = isWanted(m.id);
      const wanted = want && !m.has_file && underAllowedRoot(m.path);
      if (!wanted) {
        if (row && row.state !== "done") db.prepare("UPDATE movie_search SET state = 'done', last_why = ? WHERE movie_id = ?").run(m.has_file ? "has a file" : !want ? "not wanted in AnimeArr" : "outside the allowed root folders", m.id);
        continue;
      }
      const rel = releaseAt(m);
      const due = rel !== null ? rel + s.delayHours * HOUR : null;
      if (!row) {
        if (due === null) {
          db.prepare("INSERT INTO movie_search (movie_id, state, next_at, last_why, release_at) VALUES (?, 'unreleased', ?, 'no release date yet', NULL)").run(m.id, now + DAY);
        } else {
          db.prepare("INSERT INTO movie_search (movie_id, state, next_at, last_why, release_at) VALUES (?, ?, ?, ?, ?)").run(m.id, isReleased(m, now) ? "waiting" : "unreleased", Math.max(due, now), isReleased(m, now) ? "released; searching soon" : "waiting for the release", rel);
        }
        added++;
        continue;
      }
      // A movie that is wanted again (file deleted) or whose release date moved.
      if (row.state === "done") db.prepare("UPDATE movie_search SET state = 'waiting', attempts = 0, next_at = ?, last_why = 'wanted again' WHERE movie_id = ?").run(now, m.id);
      else if (row.state === "unreleased" && due !== null) db.prepare("UPDATE movie_search SET state = ?, next_at = ?, release_at = ?, last_why = ? WHERE movie_id = ?").run(isReleased(m, now) ? "waiting" : "unreleased", Math.max(due, now), rel, isReleased(m, now) ? "released; searching soon" : "waiting for the release", m.id);
    }
  });
  return added;
}

const searchesLastHour = (now: number) => (db.prepare("SELECT COUNT(*) AS n FROM movie_searches WHERE at > ?").get(now - HOUR) as { n: number }).n;
const toCand = (r: Awaited<ReturnType<typeof searchMovie>>["results"][number]): Candidate => ({ guid: r.guid, title: r.title, indexerId: r.indexerId, indexer: r.indexer, protocol: r.protocol, size: r.size, downloadUrl: r.downloadUrl, magnetUrl: r.magnetUrl, label: r.label, group: r.group, why: r.rank.why, episodeIds: [] });

/** One pass: plan, follow up on grabs, then search what's due within the hourly budget. */
export async function moviePass(deps: MovieSearchDeps = realDeps, now = Date.now()) {
  const s = getSettings().movieSearch;
  if (!s.enabled || dbState.corrupt) return { searched: 0 };
  planMovies(now);
  db.prepare("DELETE FROM movie_searches WHERE at < ?").run(now - DAY);
  // Leaving dry-run: "would grab" decisions get a real search.
  if (!getSettings().managed.dryRun) db.prepare("UPDATE movie_search SET state = 'waiting', next_at = ?, last_why = 'dry-run turned off' WHERE state = 'would-grab'").run(now);
  // Follow-ups: a grab that failed (all candidates) goes back to searching in an hour.
  for (const r of db.prepare("SELECT * FROM movie_search WHERE state = 'grabbed'").all() as unknown as Row[]) {
    const g = r.grab_id ? (db.prepare("SELECT state FROM grabs WHERE id = ?").get(r.grab_id) as { state: string } | undefined) : undefined;
    const latest = db.prepare("SELECT state FROM grabs WHERE movie_id = ? ORDER BY id DESC LIMIT 1").get(r.movie_id) as { state: string } | undefined;
    if (latest && ["sending", "downloading", "importing", "needs-attention"].includes(latest.state)) continue;
    const last = db.prepare("SELECT state, error FROM grabs WHERE movie_id = ? ORDER BY id DESC LIMIT 1").get(r.movie_id) as { state: string; error: string | null } | undefined;
    if (last?.state === "done") continue; // the planner closes it once Radarr has the file
    const removedByYou = /by you/.test(last?.error ?? "");
    const wait = removedByYou ? s.retryDays * DAY : r.attempts >= 2 ? (r.attempts <= BACKOFF.length ? BACKOFF[r.attempts - 1] : s.retryDays * DAY) : HOUR;
    db.prepare("UPDATE movie_search SET state = 'retry', next_at = ?, last_why = ? WHERE movie_id = ?").run(now + wait, removedByYou ? "you removed the download; searching again later" : "the download didn't work out; searching again", r.movie_id);
    void g;
  }
  const minConf = getSettings().managed.minConfidence;
  const take = Math.min(2, s.perHour - searchesLastHour(now));
  if (take <= 0) return { searched: 0 };
  const due = db.prepare("SELECT * FROM movie_search WHERE state IN ('waiting', 'retry') AND next_at <= ? ORDER BY release_at DESC LIMIT ?").all(now, take) as unknown as Row[];
  let searched = 0;
  for (const r of due) {
    // Grabs paused by a download-folder rule: wait without searching or using up the backoff.
    const gate = grabGate("movie", false);
    if (gate.paused) {
      db.prepare("UPDATE movie_search SET next_at = ?, last_why = ? WHERE movie_id = ?").run(now + 30 * 60_000, `Grabs are paused: ${gate.why}`, r.movie_id);
      continue;
    }
    const m = cache.prepare("SELECT title, year FROM movies WHERE id = ?").get(r.movie_id) as { title: string; year: number | null } | undefined;
    const label = m ? (m.year ? `${m.title} (${m.year})` : m.title) : `movie ${r.movie_id}`;
    if (db.prepare("SELECT 1 FROM grabs WHERE movie_id = ? AND state IN ('sending', 'downloading', 'importing', 'needs-attention')").get(r.movie_id)) {
      db.prepare("UPDATE movie_search SET next_at = ?, last_why = 'AnimeArr is already downloading it' WHERE movie_id = ?").run(now + 6 * HOUR, r.movie_id);
      continue;
    }
    let inRadarr: unknown[];
    try {
      inRadarr = isNativeMovieId(r.movie_id) ? [] : await deps.radarrQueue(r.movie_id); // a movie added in AnimeArr isn't in Radarr
    } catch (e) {
      // Can't tell whether Radarr is downloading it: don't risk a second download.
      db.prepare("UPDATE movie_search SET next_at = ?, last_why = ? WHERE movie_id = ?").run(now + HOUR, `couldn't check Radarr's queue (${(e as Error).message})`, r.movie_id);
      continue;
    }
    if (inRadarr.length) {
      db.prepare("UPDATE movie_search SET next_at = ?, last_why = 'Radarr is downloading it' WHERE movie_id = ?").run(now + 6 * HOUR, r.movie_id);
      continue;
    }
    db.prepare("INSERT INTO movie_searches (at) VALUES (?)").run(now);
    searched++;
    const attempts = r.attempts + 1;
    const wait = attempts <= BACKOFF.length ? BACKOFF[attempts - 1] : s.retryDays * DAY;
    try {
      const res = await deps.search(r.movie_id);
      const ok = res.results.filter((x) => x.rank.accept && x.confidence >= minConf && x.rank.langProb >= 0.5 && !x.rank.flags.some((f) => f.key === "burnIn") && !(x.protocol === "torrent" && !x.seeders));
      if (!ok.length) {
        const why = `nothing acceptable yet (${res.matched} of ${res.found} releases matched)`;
        db.prepare("UPDATE movie_search SET state = 'retry', attempts = ?, last_at = ?, next_at = ?, last_why = ? WHERE movie_id = ?").run(attempts, now, now + wait, why, r.movie_id);
        logDecision("skip", { title: label, why: `Movie search for ${label}: ${why}. Next try in ${Math.round(wait / HOUR)} h.`, detail: { movieId: r.movie_id } });
        continue;
      }
      const out = await deps.grab({ movieId: r.movie_id, candidate: toCand(ok[0]), fallbacks: ok.slice(1, 6).map(toCand), origin: "managed" });
      const state = out.dryRun ? "would-grab" : out.failed ? "retry" : "grabbed";
      db.prepare("UPDATE movie_search SET state = ?, attempts = ?, last_at = ?, next_at = ?, last_why = ?, grab_id = ? WHERE movie_id = ?").run(state, attempts, now, out.failed ? now + (attempts >= 2 ? wait : HOUR) : now, out.message, out.dryRun || out.failed ? null : out.id, r.movie_id);
    } catch (e) {
      db.prepare("UPDATE movie_search SET state = 'retry', attempts = ?, last_at = ?, next_at = ?, last_why = ? WHERE movie_id = ?").run(attempts, now, now + (attempts >= 2 ? wait : HOUR), `Error: ${(e as Error).message}`, r.movie_id);
    }
  }
  return { searched };
}

let running = false;
export async function movieTick() {
  if (running || !getSettings().movieSearch.enabled || !searchConfigured() || (!radarrConfigured() && !nativeMovies().length)) return;
  running = true;
  try {
    const r = await moviePass();
    const counts = db.prepare("SELECT state, COUNT(*) AS n FROM movie_search GROUP BY state").all() as { state: string; n: number }[];
    setJob("movie search", "done", `${r.searched} movie searches; ${counts.map((c) => `${c.n} ${c.state}`).join(", ")}${getSettings().managed.dryRun ? " (dry-run)" : ""}`);
  } catch (e) {
    setJob("movie search", "error", (e as Error).message);
  } finally {
    running = false;
  }
}

/** Counts for Settings. */
export function movieSearchSummary() {
  const rows = db.prepare("SELECT state, COUNT(*) AS n FROM movie_search GROUP BY state").all() as { state: string; n: number }[];
  const wanted = (cache.prepare("SELECT id, path, monitored, has_file, digital_release, physical_release, is_available, in_cinemas FROM movies WHERE is_anime = 1 AND has_file = 0").all() as unknown as MovieRow[]).filter((m) => isWanted(m.id) && underAllowedRoot(m.path));
  return { ...getSettings().movieSearch, wanted: wanted.length, released: wanted.filter((m) => isReleased(m)).length, states: Object.fromEntries(rows.map((r) => [r.state, r.n])) };
}
