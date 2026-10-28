/**
 * ⚡ Automatic search (Sonarr's "Search" button): one tap runs the tiered search, ranks by the show's profile and
 * grabs the best candidate at once, with the same pick rules as the scheduler. When nothing passes the confidence
 * gate (identity not certain, burn-in/foreign-only, low language likelihood) nothing is grabbed: the episode is
 * marked "Needs a look" and the interactive list (🔍) opens with one tap.
 *
 * Several episodes: a season pack that covers the missing set better is preferred (one grab), the rest are searched
 * one by one. Respects dry-run, allowed roots, the in-flight guard, blocklists and the movie-special guard.
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

export interface AutoDeps {
  search: typeof deepSearch;
  grab: typeof startGrab;
  /** The season's group when this batch is a worse release from another group (its singles fill the gaps first). */
  preferSingles?: (tvdbId: number, r: SearchResult) => Promise<string | null>;
}
const realDeps: AutoDeps = { search: deepSearch, grab: startGrab, preferSingles: batchPrefersSingles };

export type AutoOutcome = { episodeIds: number[]; label: string; outcome: "grabbed" | "would-grab" | "needs-look" | "skipped" | "failed"; release?: string; why: string };

const epLabel = (e: { season: number; episode: number; title?: string | null }) => {
  const t = e.title && !/^TBA$/i.test(e.title) ? e.title : "";
  return `${sxe(e.season, e.episode)}${t ? ` · ${t.length > 40 ? `${t.slice(0, 39)}…` : t}` : ""}`;
};
const sxe = (s: number, e: number) => `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;
/** Episodes being searched automatically right now (a second tap doesn't search them again). */
const searching = new Set<number>();
const inFlight = (episodeId: number) =>
  !!db.prepare("SELECT 1 FROM grabs WHERE state IN ('sending', 'downloading', 'importing', 'needs-attention') AND EXISTS (SELECT 1 FROM json_each(grabs.episode_ids) WHERE value = ?)").get(episodeId);

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

async function grabOne(deps: AutoDeps, tvdbId: number, ids: number[], ok: SearchResult[], label: string): Promise<AutoOutcome> {
  const best = ok[0];
  try {
    const out = await deps.grab({ tvdbId, episodeIds: ids, candidate: toCandidate(best), fallbacks: ok.slice(1, 6).map(toCandidate), origin: "manual", automatic: true });
    const outcome = out.dryRun ? "would-grab" : out.failed ? "failed" : "grabbed";
    return { episodeIds: ids, label, outcome, release: best.title, why: `${best.label} · ${best.rank.why}${out.failed ? ` (${out.message})` : ""}` };
  } catch (e) {
    return { episodeIds: ids, label, outcome: "failed", release: best.title, why: (e as Error).message };
  }
}

/** ⚡ for one or more episodes of a show. */
export async function autoSearchEpisodes(tvdbId: number, episodeIds: number[], deps: AutoDeps = realDeps): Promise<{ results: AutoOutcome[] }> {
  const series = seriesByTvdb(tvdbId);
  if (!series) throw Object.assign(new Error("Unknown series"), { statusCode: 404 });
  if (!underAllowedRoot(series.path)) throw Object.assign(new Error(`${series.title} isn't in an library folder (Settings → Automation & safety → Library folders)`), { statusCode: 403 });
  if (episodeIds.length > 26) throw Object.assign(new Error("Search at most 26 episodes at a time"), { statusCode: 400 });
  const all = new Map(episodesFor(tvdbId).map((e) => [e.id, e]));
  const movies = radarrMovieSpecials(series.id);
  const minConf = getSettings().managed.minConfidence;
  const out: AutoOutcome[] = [];
  const targets: number[] = [];
  for (const id of episodeIds) {
    const e = all.get(id);
    if (!e) continue;
    const label = epLabel(e);
    if (movies.has(id)) out.push({ episodeIds: [id], label, outcome: "skipped", why: `a movie (${movies.get(id)!.title}): handled by Radarr` });
    else if (inFlight(id)) out.push({ episodeIds: [id], label, outcome: "skipped", why: "already downloading" });
    else if (searching.has(id)) out.push({ episodeIds: [id], label, outcome: "skipped", why: "already being searched" });
    else if (e.hasFile) out.push({ episodeIds: [id], label, outcome: "skipped", why: "already has a file (use Download again to replace it)" });
    else targets.push(id);
  }
  for (const id of targets) searching.add(id);
  try {
    return await searchTargets(tvdbId, series.title, targets, all, out, minConf, deps);
  } finally {
    for (const id of targets) searching.delete(id);
  }
}

async function searchTargets(tvdbId: number, seriesTitle: string, targets: number[], all: Map<number, ReturnType<typeof episodesFor>[number]>, out: AutoOutcome[], minConf: number, deps: AutoDeps): Promise<{ results: AutoOutcome[] }> {
  let remaining = [...targets];
  // A season pack that covers at least two of the wanted episodes and more than any single release.
  // (only when they're all in one season: burn-in rules are per season)
  if (remaining.length > 1 && new Set(remaining.map((x) => all.get(x)!.season)).size === 1) {
    const res = await deps.search(tvdbId, remaining, { budget: 12 });
    const season = all.get(remaining[0])?.season ?? null;
    // Batches with episodes you already have count too (smart batch grabs: only the wanted files are downloaded or
    // imported, or the season decision replaces the whole season).
    const packs = automaticPicks(res.results, tvdbId, season, { allowPacks: true, allowExtras: true })
      .map((r) => ({ r, covers: r.episodeIds.filter((x) => remaining.includes(x)) }))
      .filter((x) => x.covers.length >= 2)
      .sort((a, b) => b.covers.length - a.covers.length || a.r.episodeIds.length - b.r.episodeIds.length);
    let pack: (typeof packs)[number] | undefined = packs[0];
    // A worse batch from another group: single releases of the season's group fill the gaps first, when there are any.
    if (pack && deps.preferSingles) {
      const sg = await deps.preferSingles(tvdbId, pack.r);
      if (sg) {
        const singles = automaticPicks(res.results, tvdbId, season, { allowPacks: true }).filter((r) => r.episodeIds.length === 1 && remaining.includes(r.episodeIds[0]) && r.group?.toLowerCase() === sg.toLowerCase());
        if (singles.length) {
          logDecision("info", { tvdbId, title: seriesTitle, episodeIds: pack.covers, release: pack.r.title, why: `Skipped the batch ${pack.r.title} for now: it's another group and lower quality than your files, and ${sg} (the season's group) has single releases for the gaps` });
          pack = undefined;
        }
      }
    }
    if (pack && pack.covers.length >= Math.ceil(remaining.length / 2)) {
      const labels = pack.covers.map((x) => sxe(all.get(x)!.season, all.get(x)!.episode));
      const chosen = pack;
      const same = (p: (typeof packs)[number]) => p.covers.length === chosen.covers.length && p.covers.every((x) => chosen.covers.includes(x));
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
      const res = await deps.search(tvdbId, [id], { budget: 12 });
      const ok = automaticPicks(res.results, tvdbId, e.season);
      if (!ok.length) {
        const why = gateWhy(res.results, minConf);
        out.push({ episodeIds: [id], label, outcome: "needs-look", why: `${why} (${res.results.length} results)` });
        logDecision("info", { tvdbId, title: seriesTitle, episodeIds: [id], why: `Automatic search for ${seriesTitle} ${label}: needs a look — ${why}. Nothing was grabbed; open the interactive list to pick one.`, detail: { needsLook: true } });
        continue;
      }
      out.push(await grabOne(deps, tvdbId, [id], ok, label));
    } catch (e) {
      out.push({ episodeIds: [id], label, outcome: "failed", why: (e as Error).message });
    }
  }
  return { results: out };
}

/** ⚡ for a movie (a movie that has a file needs replace = the user confirmed it). */
export async function autoSearchMovie(movieId: number, opts: { replace?: boolean } = {}, deps = { search: searchMovie, grab: startMovieGrab }) {
  const m = cache.prepare("SELECT title, year FROM movies WHERE id = ?").get(movieId) as { title: string; year: number | null } | undefined;
  if (!m) throw Object.assign(new Error("Unknown movie"), { statusCode: 404 });
  const label = m.year ? `${m.title} (${m.year})` : m.title;
  const row = cache.prepare("SELECT has_file, path FROM movies WHERE id = ?").get(movieId) as { has_file: number; path: string };
  if (!underAllowedRoot(row.path)) throw Object.assign(new Error(`${label} isn't in an library folder (Settings → Automation & safety → Library folders)`), { statusCode: 403 });
  if (row.has_file && !opts.replace) throw Object.assign(new Error(`${label} already has a file; confirm replacing it`), { statusCode: 409 });
  const minConf = getSettings().managed.minConfidence;
  const res = await deps.search(movieId);
  const ok = res.results.filter((x) => x.rank.accept && x.confidence >= minConf && x.rank.langProb >= 0.5 && !x.rank.flags.some((f) => f.key === "burnIn") && !(x.protocol === "torrent" && !x.seeders));
  if (!ok.length) {
    const best = res.results[0];
    const why = !best ? "nothing found" : !best.rank.accept ? `the best result isn't acceptable: ${best.rank.reject}` : best.confidence < minConf ? `not sure it's this movie (${best.confidence}%)` : "no result passes the automatic rules";
    logDecision("info", { title: label, why: `Automatic search for ${label}: needs a look — ${why}. Nothing was grabbed.`, detail: { movieId, needsLook: true } });
    return { outcome: "needs-look" as const, why, label };
  }
  const cand = (x: (typeof ok)[number]): Candidate => ({ guid: x.guid, title: x.title, indexerId: x.indexerId, indexer: x.indexer, protocol: x.protocol, size: x.size, downloadUrl: x.downloadUrl, magnetUrl: x.magnetUrl, label: x.label, group: x.group, why: x.rank.why, episodeIds: [] });
  const out = await deps.grab({ movieId, candidate: cand(ok[0]), fallbacks: ok.slice(1, 6).map(cand), origin: "manual", replace: opts.replace });
  return { outcome: out.dryRun ? ("would-grab" as const) : out.failed ? ("failed" as const) : ("grabbed" as const), release: ok[0].title, why: `${ok[0].rank.why}${out.failed ? ` (${out.message})` : ""}`, label };
}
