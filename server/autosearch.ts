/**
 * ⚡ Automatic search (Sonarr's "Search" button): one tap runs the tiered search, ranks by the show's profile and
 * grabs the best candidate at once, with the same pick rules as the scheduler. When nothing passes the confidence
 * gate (identity not certain, burn-in/foreign-only, low language likelihood) nothing is grabbed: the episode is
 * marked "Needs a look" and the interactive list (🔍) opens with one tap.
 *
 * Several episodes: a season pack that covers the missing set better is preferred (one grab), the rest are searched
 * one by one. Respects dry-run, allowed roots, the in-flight guard, blocklists and the movie-special guard.
 *
 * An episode that already has a file is only looked at for a newer version of it (v2, REPACK from the same group, when
 * "Propers and repacks" allows upgrades, the file isn't locked and a recycling bin is set): that one is replaced, nothing else.
 *
 * The ⚡ button doesn't wait for all that: queueAutoSearch() marks the episodes as being searched and returns at once;
 * the search runs as a background job (a few at a time, its indexer queries in a lane of the app-wide scheduler) and its
 * outcomes land in Activity, the bell (grabs, failures) and GET /api/autosearch/jobs. Jobs live in memory only.
 */
import { logDecision } from "./activity.js";
import { cache, db } from "./db.js";
import { radarrMovieSpecials } from "./franchise.js";
import { automaticPicks, toCandidate } from "./managed.js";
import { startGrab } from "./pipeline.js";
import { deepSearch, episodesFor, seriesByTvdb, type SearchResult } from "./search.js";
import { getSettings, underAllowedRoot } from "./settings.js";
import { searchMovie, startMovieGrab } from "./movies.js";
import type { Candidate } from "./pipeline.js";
import { batchPrefersSingles } from "./batch.js";
import { addToQueue } from "./fillin.js";
import { searchAgainSoon, wrongLanguageEpisodes } from "./episodes.js";
import { listManaged } from "./managed.js";
import { scopedEpisodeIds } from "./scope.js";
import { ownedElsewhere, ownedWhy } from "./duplicates.js";
import { properMode } from "./propers.js";
import { inLane } from "./searchQueue.js";
import crypto from "node:crypto";

export interface AutoDeps {
  search: typeof deepSearch;
  grab: typeof startGrab;
  /** The season's group when this batch is a worse release from another group (its singles fill the gaps first). */
  preferSingles?: (tvdbId: number, r: SearchResult) => Promise<string | null>;
}
const realDeps: AutoDeps = { search: deepSearch, grab: startGrab, preferSingles: batchPrefersSingles };

export type AutoOutcome = {
  episodeIds: number[];
  label: string;
  outcome: "grabbed" | "would-grab" | "needs-look" | "skipped" | "failed";
  release?: string;
  why: string;
};

const epLabel = (e: { season: number; episode: number; title?: string | null }) => {
  const t = e.title && !/^TBA$/i.test(e.title) ? e.title : "";
  return `${sxe(e.season, e.episode)}${t ? ` · ${t.length > 40 ? `${t.slice(0, 39)}…` : t}` : ""}`;
};
const sxe = (s: number, e: number) => `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;
/** Episodes being searched automatically right now (a second tap doesn't search them again). */
const searching = new Set<number>();
const inFlight = (episodeId: number) =>
  !!db
    .prepare(
      "SELECT 1 FROM grabs WHERE state IN ('sending', 'downloading', 'importing', 'needs-attention') AND EXISTS (SELECT 1 FROM json_each(grabs.episode_ids) WHERE value = ?)",
    )
    .get(episodeId);

/** Why the best result wasn't good enough to grab on its own. */
function gateWhy(results: SearchResult[], minConf: number) {
  const best = results[0];
  if (!best) return "nothing found";
  if (!best.rank.accept) return `the best result isn't acceptable: ${best.rank.reject}`;
  if (best.confidence < minConf) return `not sure it's the right episode (${best.confidence}% < ${minConf}%)`;
  if (best.rank.flags.some((f) => f.key === "burnIn")) return "the best result has burned-in subtitles";
  if (best.rank.langProb < 0.5) return `the language is uncertain (${Math.round(best.rank.langProb * 100)}%)`;
  if (!best.coversTarget || best.extra > 0) return "the best result covers other episodes too";
  return "no result passes the automatic rules";
}

async function grabOne(
  deps: AutoDeps,
  tvdbId: number,
  ids: number[],
  ok: SearchResult[],
  label: string,
  purpose?: "replace",
  note?: string | null,
): Promise<AutoOutcome> {
  const best = ok[0];
  try {
    const out = await deps.grab({
      tvdbId,
      episodeIds: ids,
      candidate: toCandidate(best),
      fallbacks: ok.slice(1, 6).map(toCandidate),
      origin: "manual",
      automatic: true,
      ...(purpose ? { purpose } : {}),
    });
    const outcome = out.dryRun ? "would-grab" : out.failed ? "failed" : "grabbed";
    return {
      episodeIds: ids,
      label,
      outcome,
      release: best.title,
      why: `${best.label} · ${best.rank.why}${out.failed ? ` (${out.message})` : ""}${note ? ` · stopped early: ${note}` : ""}`,
    };
  } catch (e) {
    return { episodeIds: ids, label, outcome: "failed", release: best.title, why: (e as Error).message };
  }
}

/** ⚡ for one or more episodes of a show. */
/** ⚡ searches this many episodes at once; more would hit every indexer once per episode in one burst. */
export const AUTO_NOW = 26;
/** ⚡ checks at most this many episodes that already have a file for a newer version per tap (each is one search). */
const MAX_VERSION_CHECKS = 6;
/** A torrent pack needs this many seeders to be picked over single releases. */
const MIN_PACK_SEEDERS = 3;
/** How far below the best single release a pack may rank and still be picked (one grab instead of many). */
const PACK_SCORE_SLACK = 5;

/**
 * ⚡ for one or more episodes, waiting for the outcome (the HTTP route queues it with queueAutoSearch() instead).
 * `claimed`: episodes a queued job already marked as being searched (they aren't skipped as "already being searched").
 */
export async function autoSearchEpisodes(
  tvdbId: number,
  episodeIds: number[],
  deps: AutoDeps = realDeps,
  opts: { claimed?: Set<number> } = {},
): Promise<{ results: AutoOutcome[]; queued?: { n: number; where: "soon" | "fillin" } }> {
  const series = seriesByTvdb(tvdbId);
  if (!series) throw Object.assign(new Error("Unknown series"), { statusCode: 404 });
  if (!underAllowedRoot(series.path))
    throw Object.assign(new Error(`${series.title} isn't in an library folder (Settings → Automation & safety → Library folders)`), {
      statusCode: 403,
    });
  // A bigger pick: the first 26 now, the rest to the paced searches (managed shows) or the fill-in queue (others).
  let queued: { n: number; where: "soon" | "fillin" } | undefined;
  if (episodeIds.length > AUTO_NOW) {
    const rest = episodeIds.slice(AUTO_NOW);
    episodeIds = episodeIds.slice(0, AUTO_NOW);
    if (listManaged().some((m) => m.tvdbId === tvdbId)) {
      searchAgainSoon(tvdbId, rest, { why: `${rest.length} more episodes than ⚡ searches at once: queued for the next searches` });
      queued = { n: rest.length, where: "soon" };
    } else {
      addToQueue([tvdbId]);
      queued = { n: rest.length, where: "fillin" };
    }
  }
  const all = new Map(episodesFor(tvdbId).map((e) => [e.id, e]));
  const movies = radarrMovieSpecials(series.id);
  const minConf = getSettings().managed.minConfidence;
  const out: AutoOutcome[] = [];
  const targets: number[] = [];
  const owned = ownedElsewhere(tvdbId);
  const versionChecks: number[] = [];
  const wrong = wrongLanguageEpisodes(tvdbId);
  const checkVersions = properMode() === "preferAndUpgrade" && !!getSettings().media.recycleBin.trim();
  for (const id of episodeIds) {
    const e = all.get(id);
    if (!e) continue;
    const label = epLabel(e);
    if (movies.has(id))
      out.push({ episodeIds: [id], label, outcome: "skipped", why: `a movie (${movies.get(id)!.title}): handled by Radarr` });
    else if (owned.has(id)) {
      out.push({ episodeIds: [id], label, outcome: "skipped", why: ownedWhy(owned.get(id)!) });
      logDecision("info", {
        tvdbId,
        title: series.title,
        episodeIds: [id],
        why: `Automatic search for ${series.title} ${label} skipped: ${ownedWhy(owned.get(id)!)}. Nothing was searched or grabbed.`,
      });
    } else if (inFlight(id)) out.push({ episodeIds: [id], label, outcome: "skipped", why: "already downloading" });
    else if (searching.has(id) && !opts.claimed?.has(id))
      out.push({ episodeIds: [id], label, outcome: "skipped", why: "already being searched" });
    // A managed show's file in the wrong language is searched like a missing one (the new file must pass the check
    // before the old one goes to the recycling bin).
    else if (e.hasFile && wrong.has(id)) targets.push(id);
    else if (e.hasFile && checkVersions && versionChecks.length < MAX_VERSION_CHECKS) versionChecks.push(id);
    else if (e.hasFile)
      out.push({ episodeIds: [id], label, outcome: "skipped", why: "already has a file (use Download again to replace it)" });
    else targets.push(id);
  }
  for (const id of [...targets, ...versionChecks]) searching.add(id);
  try {
    const res = await searchTargets(tvdbId, series.title, targets, all, out, minConf, deps);
    for (const id of versionChecks) res.results.push(await checkVersion(tvdbId, series.title, id, all.get(id)!, deps));
    return { ...res, queued };
  } finally {
    for (const id of [...targets, ...versionChecks]) searching.delete(id);
  }
}

/** An episode with a file: grabs a newer version of it (same group, higher version) as a Replace grab, or leaves it alone. */
async function checkVersion(
  tvdbId: number,
  seriesTitle: string,
  id: number,
  e: ReturnType<typeof episodesFor>[number],
  deps: AutoDeps,
): Promise<AutoOutcome> {
  const label = epLabel(e);
  const none = (why: string): AutoOutcome => ({ episodeIds: [id], label, outcome: "skipped", why });
  try {
    const res = await deps.search(tvdbId, [id], { budget: 12 });
    const ok = automaticPicks(res.results, tvdbId, e.season).filter((r) => r.rank.flags.some((f) => f.key === "newerVersion"));
    if (!ok.length) return none("already has a file (no newer version found)");
    const o = await grabOne(deps, tvdbId, [id], ok, label, "replace");
    logDecision("info", {
      tvdbId,
      title: seriesTitle,
      episodeIds: [id],
      release: ok[0].title,
      why: `Automatic search for ${seriesTitle} ${label}: ${ok[0].rank.why}. ${o.outcome === "would-grab" ? "Dry-run: nothing grabbed" : o.outcome === "failed" ? "Couldn't grab it" : "Grabbed; the old file goes to the recycling bin only after the new one passes the checks"}`,
    });
    return o;
  } catch (err) {
    return { episodeIds: [id], label, outcome: "failed", why: (err as Error).message };
  }
}

async function searchTargets(
  tvdbId: number,
  seriesTitle: string,
  targets: number[],
  all: Map<number, ReturnType<typeof episodesFor>[number]>,
  out: AutoOutcome[],
  minConf: number,
  deps: AutoDeps,
): Promise<{ results: AutoOutcome[] }> {
  let remaining = [...targets];
  // A season pack that covers at least two of the wanted episodes and more than any single release.
  // (only when they're all in one season: burn-in rules are per season)
  if (remaining.length > 1 && new Set(remaining.map((x) => all.get(x)!.season)).size === 1) {
    const res = await deps.search(tvdbId, remaining, { budget: 12 });
    const season = all.get(remaining[0])?.season ?? null;
    // Batches with episodes you already have count too (smart batch grabs: only the wanted files are downloaded or
    // imported, or the season decision replaces the whole season).
    // A pack has to be healthy (a torrent with a few seeders stalls) and rank at least as well as the single releases
    // it would stand in for; otherwise the singles are the better grab.
    const picks = automaticPicks(res.results, tvdbId, season, { allowPacks: true, allowExtras: true });
    const bestSingle = Math.max(
      -Infinity,
      ...picks.filter((r) => r.episodeIds.length === 1 && remaining.includes(r.episodeIds[0])).map((r) => r.rank.score),
    );
    const packs = picks
      .filter(
        (r) =>
          !(r.protocol === "torrent" && r.seeders !== null && r.seeders < MIN_PACK_SEEDERS) &&
          r.rank.score >= bestSingle - PACK_SCORE_SLACK,
      )
      .map((r) => ({ r, covers: r.episodeIds.filter((x) => remaining.includes(x)) }))
      .filter((x) => x.covers.length >= 2)
      .sort(
        (a, b) => b.covers.length - a.covers.length || b.r.rank.score - a.r.rank.score || a.r.episodeIds.length - b.r.episodeIds.length,
      );
    let pack: (typeof packs)[number] | undefined = packs[0];
    // A worse batch from another group: single releases of the season's group fill the gaps first, when there are any.
    if (pack && deps.preferSingles) {
      const sg = await deps.preferSingles(tvdbId, pack.r);
      if (sg) {
        const singles = automaticPicks(res.results, tvdbId, season, { allowPacks: true }).filter(
          (r) => r.episodeIds.length === 1 && remaining.includes(r.episodeIds[0]) && r.group?.toLowerCase() === sg.toLowerCase(),
        );
        if (singles.length) {
          logDecision("info", {
            tvdbId,
            title: seriesTitle,
            episodeIds: pack.covers,
            release: pack.r.title,
            why: `Skipped the batch ${pack.r.title} for now: it's another group and lower quality than your files, and ${sg} (the season's group) has single releases for the gaps`,
          });
          pack = undefined;
        }
      }
    }
    if (pack && pack.covers.length >= Math.ceil(remaining.length / 2)) {
      const labels = pack.covers.map((x) => sxe(all.get(x)!.season, all.get(x)!.episode));
      const chosen = pack;
      const same = (p: (typeof packs)[number]) =>
        p.covers.length === chosen.covers.length && p.covers.every((x) => chosen.covers.includes(x));
      const ok = packs.filter(same).map((p) => p.r);
      const o = await grabOne(deps, tvdbId, pack.covers, ok, `${labels[0]}–${labels.at(-1)}`);
      out.push(o);
      if (o.outcome !== "failed") remaining = remaining.filter((x) => !chosen.covers.includes(x));
    }
  }
  for (const id of remaining) {
    const e = all.get(id)!;
    const label = epLabel(e);
    try {
      const res = await deps.search(tvdbId, [id], { budget: 12, earlyStop: { minConfidence: minConf } });
      const ok = automaticPicks(res.results, tvdbId, e.season);
      if (!ok.length) {
        const why = gateWhy(res.results, minConf);
        out.push({ episodeIds: [id], label, outcome: "needs-look", why: `${why} (${res.results.length} results)` });
        logDecision("info", {
          tvdbId,
          title: seriesTitle,
          episodeIds: [id],
          why: `Automatic search for ${seriesTitle} ${label}: needs a look — ${why}. Nothing was grabbed; open the interactive list to pick one.`,
          detail: { needsLook: true },
        });
        continue;
      }
      out.push(await grabOne(deps, tvdbId, [id], ok, label, undefined, ok[0] === res.results[0] ? res.stoppedEarly : null));
    } catch (e) {
      out.push({ episodeIds: [id], label, outcome: "failed", why: (e as Error).message });
    }
  }
  return { results: out };
}

/**
 * "Search now" for a show that was just added (Add, or a Jellyseerr request): its aired, missing episodes in scope.
 * ⚡ handles at most 26 episodes at once; a longer backlog goes to the fill-in queue instead.
 */
export function searchMissingNow(tvdbId: number, title: string, now = Date.now()) {
  const s = cache.prepare("SELECT id FROM series WHERE tvdb_id = ?").get(tvdbId) as { id: number } | undefined;
  if (!s) return { searching: 0 };
  const missing = [...scopedEpisodeIds(tvdbId, s.id, now)].filter((e) => {
    const r = cache.prepare("SELECT has_file, air_utc FROM episodes WHERE id = ?").get(e) as
      { has_file: number; air_utc: number | null } | undefined;
    return r?.has_file === 0 && r.air_utc !== null && r.air_utc <= now; // aired, no file
  });
  if (missing.length > 26) return { searching: 0, queued: addToQueue([tvdbId]).added, missing: missing.length };
  if (missing.length)
    void autoSearchEpisodes(tvdbId, missing).catch((e) =>
      logDecision("fail", { tvdbId, title, why: `Search after adding ${title} failed: ${(e as Error).message}` }),
    );
  return { searching: missing.length };
}
/** The movie ⚡'s checks, before anything is searched: known, in a library folder, and replace confirmed when it has a file. */
function movieTarget(movieId: number, opts: { replace?: boolean }) {
  const m = cache.prepare("SELECT title, year, has_file, path FROM movies WHERE id = ?").get(movieId) as
    { title: string; year: number | null; has_file: number; path: string } | undefined;
  if (!m) throw Object.assign(new Error("Unknown movie"), { statusCode: 404 });
  const label = m.year ? `${m.title} (${m.year})` : m.title;
  if (!underAllowedRoot(m.path))
    throw Object.assign(new Error(`${label} isn't in an library folder (Settings → Automation & safety → Library folders)`), {
      statusCode: 403,
    });
  if (m.has_file && !opts.replace) throw Object.assign(new Error(`${label} already has a file; confirm replacing it`), { statusCode: 409 });
  return label;
}

/** ⚡ for a movie (a movie that has a file needs replace = the user confirmed it). */
export async function autoSearchMovie(
  movieId: number,
  opts: { replace?: boolean } = {},
  deps = { search: searchMovie, grab: startMovieGrab },
) {
  const label = movieTarget(movieId, opts);
  const minConf = getSettings().managed.minConfidence;
  const res = await deps.search(movieId);
  const ok = res.results.filter(
    (x) =>
      x.rank.accept &&
      x.confidence >= minConf &&
      x.rank.langProb >= 0.5 &&
      !x.rank.flags.some((f) => f.key === "burnIn") &&
      !(x.protocol === "torrent" && !x.seeders),
  );
  if (!ok.length) {
    const best = res.results[0];
    const why = !best
      ? "nothing found"
      : !best.rank.accept
        ? `the best result isn't acceptable: ${best.rank.reject}`
        : best.confidence < minConf
          ? `not sure it's this movie (${best.confidence}%)`
          : "no result passes the automatic rules";
    logDecision("info", {
      title: label,
      why: `Automatic search for ${label}: needs a look — ${why}. Nothing was grabbed.`,
      detail: { movieId, needsLook: true },
    });
    return { outcome: "needs-look" as const, why, label };
  }
  const cand = (x: (typeof ok)[number]): Candidate => ({
    guid: x.guid,
    title: x.title,
    indexerId: x.indexerId,
    indexer: x.indexer,
    protocol: x.protocol,
    size: x.size,
    downloadUrl: x.downloadUrl,
    magnetUrl: x.magnetUrl,
    label: x.label,
    group: x.group,
    why: x.rank.why,
    episodeIds: [],
  });
  const out = await deps.grab({
    movieId,
    candidate: cand(ok[0]),
    fallbacks: ok.slice(1, 6).map(cand),
    origin: "manual",
    replace: opts.replace,
  });
  return {
    outcome: out.dryRun ? ("would-grab" as const) : out.failed ? ("failed" as const) : ("grabbed" as const),
    release: ok[0].title,
    why: `${ok[0].rank.why}${out.failed ? ` (${out.message})` : ""}`,
    label,
  };
}

// ---------------------------------------------------------------- ⚡ as background jobs

export interface AutoJob {
  id: string;
  kind: "episodes" | "movie";
  tvdbId: number | null;
  movieId: number | null;
  title: string;
  /** The episodes this job searches (marked "being searched" until it ends). */
  episodeIds: number[];
  state: "queued" | "running" | "done" | "failed";
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Per episode (or the movie): grabbed, would-grab, needs-look, skipped or failed, with why. */
  results: AutoOutcome[];
  /** Episodes over the 26 handed to the paced searches or Fill-in. */
  queued?: { n: number; where: "soon" | "fillin" };
  error: string | null;
}
type JobRun = () => Promise<Pick<AutoJob, "results" | "queued">>;
/** ⚡ jobs that run at once; more wait their turn (first come, first served). Their queries share the global cap anyway. */
export const MAX_AUTO_JOBS = 2;
/** Finished jobs are listed this long (and at most KEEP_DONE of them). */
const KEEP_DONE_MS = 60 * 60_000;
const KEEP_DONE = 30;
const jobs: AutoJob[] = [];
const runners = new Map<string, JobRun>();
/** Movies with a ⚡ queued or running. */
const searchingMovies = new Set<number>();

const position = (job: AutoJob) => (job.state === "queued" ? jobs.filter((j) => j.state === "queued").indexOf(job) + 1 : 0);

function pumpJobs() {
  while (jobs.filter((j) => j.state === "running").length < MAX_AUTO_JOBS) {
    const job = jobs.find((j) => j.state === "queued");
    if (!job) return;
    job.state = "running";
    job.startedAt = Date.now();
    const run = runners.get(job.id)!;
    runners.delete(job.id);
    // The job's indexer queries share one lane: served in turn with other jobs and searches, never all first.
    void inLane(`auto:${job.id}`, run)
      .then(
        (r) => {
          job.results.push(...r.results);
          if (r.queued) job.queued = r.queued;
          job.state = "done";
          job.finishedAt = Date.now();
          logJob(job);
        },
        (e) => {
          job.state = "failed";
          job.error = (e as Error).message;
          job.finishedAt = Date.now();
          logDecision("fail", {
            tvdbId: job.tvdbId,
            title: job.title,
            episodeIds: job.episodeIds,
            why: `Automatic search for ${job.title} failed: ${job.error}`,
            detail: job.movieId ? { movieId: job.movieId } : {},
          });
        },
      )
      .finally(() => {
        for (const id of job.episodeIds) searching.delete(id);
        if (job.movieId) searchingMovies.delete(job.movieId);
        pumpJobs();
      });
  }
}

/** One Activity line per job: what happened to each episode (grabs and needs-a-look have their own lines too). */
function logJob(job: AutoJob) {
  const r = job.results;
  if (!r.length) return;
  const n = (o: AutoOutcome["outcome"]) => r.filter((x) => x.outcome === o).length;
  const parts = [
    n("grabbed") && `${n("grabbed")} started`,
    n("would-grab") && `${n("would-grab")} would download (practice mode)`,
    n("needs-look") && `${n("needs-look")} need a look`,
    n("skipped") && `${n("skipped")} skipped`,
    n("failed") && `${n("failed")} failed`,
    r.some((x) => x.why.includes("stopped early:")) &&
      `${r.filter((x) => x.why.includes("stopped early:")).length} stopped early (SeaDex's best was already found)`,
  ].filter(Boolean);
  const notes = r
    .filter((x) => x.outcome === "skipped" || x.outcome === "failed")
    .slice(0, 5)
    .map((x) => `${x.label}: ${x.why}`);
  const took = Math.round(((job.finishedAt ?? Date.now()) - (job.startedAt ?? job.queuedAt)) / 1000);
  const more = job.queued ? `; ${job.queued.n} more queued for ${job.queued.where === "soon" ? "the next searches" : "Fill-in"}` : "";
  logDecision("search", {
    tvdbId: job.tvdbId,
    title: job.title,
    episodeIds: job.episodeIds,
    why: `Automatic search for ${job.title}: ${parts.join(", ")}${notes.length ? ` (${notes.join("; ")})` : ""}${more} · ${took} s`,
    detail: { autoJob: job.id, ...(job.movieId ? { movieId: job.movieId } : {}) },
  });
}

function addJob(job: AutoJob, run: JobRun) {
  const now = Date.now();
  for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].finishedAt && now - jobs[i].finishedAt! > KEEP_DONE_MS) jobs.splice(i, 1);
  while (jobs.filter((j) => j.finishedAt).length >= KEEP_DONE)
    jobs.splice(
      jobs.findIndex((j) => j.finishedAt),
      1,
    );
  jobs.push(job);
  if (job.state === "queued") {
    runners.set(job.id, run);
    pumpJobs();
  }
  return { queued: true as const, jobId: job.id, episodes: job.episodeIds.length, position: position(job) };
}

/**
 * ⚡ from the UI: checks the show, marks the episodes as being searched and queues the search; returns at once.
 * An episode already being searched (an earlier tap still queued or running) is skipped right away. `deps` for tests.
 */
export function queueAutoSearch(tvdbId: number, episodeIds: number[], deps: AutoDeps = realDeps) {
  const series = seriesByTvdb(tvdbId);
  if (!series) throw Object.assign(new Error("Unknown series"), { statusCode: 404 });
  if (!underAllowedRoot(series.path))
    throw Object.assign(new Error(`${series.title} isn't in an library folder (Settings → Automation & safety → Library folders)`), {
      statusCode: 403,
    });
  const all = new Map(episodesFor(tvdbId).map((e) => [e.id, e]));
  const ids = [...new Set(episodeIds)].filter((id) => all.has(id));
  const busy = ids.filter((id) => searching.has(id));
  const list = ids.filter((id) => !searching.has(id));
  const claimed = new Set(list.slice(0, AUTO_NOW));
  for (const id of claimed) searching.add(id);
  const job: AutoJob = {
    id: crypto.randomUUID(),
    kind: "episodes",
    tvdbId,
    movieId: null,
    title: series.title,
    episodeIds: [...claimed],
    state: list.length ? "queued" : "done",
    queuedAt: Date.now(),
    startedAt: null,
    finishedAt: list.length ? null : Date.now(),
    results: busy.map((id) => ({
      episodeIds: [id],
      label: epLabel(all.get(id)!),
      outcome: "skipped" as const,
      why: "already being searched",
    })),
    error: null,
  };
  return addJob(job, () => autoSearchEpisodes(tvdbId, list, deps, { claimed }));
}

/** The movie ⚡ as a job (checked first, so a missing replace confirmation still answers 409 at once). */
export function queueAutoSearchMovie(
  movieId: number,
  opts: { replace?: boolean } = {},
  deps = { search: searchMovie, grab: startMovieGrab },
) {
  const label = movieTarget(movieId, opts);
  const busy = searchingMovies.has(movieId);
  if (!busy) searchingMovies.add(movieId);
  const job: AutoJob = {
    id: crypto.randomUUID(),
    kind: "movie",
    tvdbId: null,
    movieId,
    title: label,
    episodeIds: [],
    state: busy ? "done" : "queued",
    queuedAt: Date.now(),
    startedAt: null,
    finishedAt: busy ? Date.now() : null,
    results: busy ? [{ episodeIds: [], label, outcome: "skipped", why: "already being searched" }] : [],
    error: null,
  };
  return addJob(job, async () => {
    const r = await autoSearchMovie(movieId, opts, deps);
    return {
      results: [{ episodeIds: [], label: r.label, outcome: r.outcome, release: "release" in r ? r.release : undefined, why: r.why }],
    };
  });
}

/** GET /api/autosearch/jobs: running and waiting jobs, then recent finished ones (newest first), and what's being searched. */
export function autoJobs() {
  const order = { running: 0, queued: 1, done: 2, failed: 2 };
  return {
    jobs: [...jobs]
      .sort((a, b) => order[a.state] - order[b.state] || (b.finishedAt ?? b.queuedAt) - (a.finishedAt ?? a.queuedAt))
      .map((j) => ({ ...j, position: position(j) })),
    searching: [...searching],
    searchingMovies: [...searchingMovies],
  };
}

/** Tests: waits until no ⚡ job is queued or running. */
export async function autoJobsIdle() {
  while (jobs.some((j) => j.state === "queued" || j.state === "running")) await new Promise((r) => setTimeout(r, 5));
}

// Jobs live in memory: a restart drops the ones still waiting or running (the scheduled searches pick those episodes up again).
process.once("exit", () => {
  const left = jobs.filter((j) => j.state === "queued" || j.state === "running");
  try {
    for (const j of left)
      logDecision("info", {
        tvdbId: j.tvdbId,
        title: j.title,
        episodeIds: j.episodeIds,
        why: `Automatic search for ${j.title} was ${j.state === "running" ? "interrupted" : "still waiting"} when AnimeArr stopped, so it didn't finish. Search again, or let the scheduled searches find it.`,
        detail: { autoJob: j.id },
      });
  } catch {
    /* shutting down: best effort */
  }
});
