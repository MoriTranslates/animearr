/** Routes: Identify, Deep Search and grabbing, quality goals and upgrades, download-folder rules and clean-up. */
import { replaceSeasonPreview } from "../episodes.js";
import crypto from "node:crypto";
import { searchConfigured } from "../indexers.js";
import { cleanupPlan, downloadsStatus, measure, PRESETS, runCleanup } from "../downloads.js";
import { cache } from "../system/db.js";
import { logDecision } from "../system/activity.js";
import { profileFor, saveProfile } from "../profiles.js";
import { identify } from "../core/identify.js";
import { backlogSummary } from "../managed.js";
import { listManaged } from "../managedList.js";
import { listGrabs, startGrab } from "../pipeline.js";
import { type Candidate } from "../pipelineState.js";
import { upgradeList } from "../upgrade.js";
import { GOAL_IDS, GOALS, goalLabel, isGoal, seadexSource } from "../core/quality.js";
import { locksFor, setLock, TDARR_GUARD } from "../qualityLocks.js";
import { qualityUpgradeView, startNow, upgradeSeasonNow } from "../qualityUpgrade.js";
import { seasonComparison } from "../metadata/seadexFiles.js";
import { checkSeadexNow, cooldownLeft, lastCheck, seadexForSeason } from "../metadata/seadex.js";
import { catalogStatus, entriesForSeries } from "../metadata/catalog.js";

import { renamePlan } from "../importer.js";
import { ownedElsewhere, ownedWhy } from "../duplicates.js";
import { deepSearch, identifyContext, seriesByTvdb, type SearchProgress, type SearchResult } from "../search.js";
import { getSettings, patchSettings } from "../system/settings.js";
import type { FastifyInstance } from "fastify";
import { catalogRunning, catalogTick, fail, id, writable } from "./common.js";

export function registerGrabsRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- identify, deep search, grab

  app.post<{ Body: { name?: string; tvdbId?: number } }>("/api/identify", async (req) => {
    const name = String(req.body?.name ?? "").slice(0, 400);
    if (!name.trim()) throw fail("Paste a release name");
    const r = identify(name, identifyContext(), { tvdbId: req.body?.tvdbId ? id(req.body.tvdbId) : undefined });
    return {
      parsed: { ...r.parsed, raw: undefined },
      summary: r.summary,
      series: r.candidate ? seriesByTvdb(r.candidate.tvdbId) : null,
      mapping: r.resolution
        ? {
            ok: r.resolution.ok,
            label: r.resolution.label,
            confidence: r.resolution.confidence,
            method: r.resolution.method,
            why: r.resolution.why,
            episodeIds: r.resolution.episodes.map((e) => e.id),
          }
        : null,
      others: r.others,
    };
  });

  /** Search results are kept server-side for 30 minutes so a grab can only use a release Prowlarr actually returned. */
  const lastResults = new Map<string, { at: number; tvdbId: number; episodeIds: number[]; results: SearchResult[] }>();
  const searchKey = (tvdbId: number, eps: number[]) => `${tvdbId}:${[...eps].sort((a, b) => a - b).join(",")}`;

  const publicResults = (rs: SearchResult[]) => rs.map(({ downloadUrl: _d, magnetUrl: _m, ...x }) => x);

  /** Runs a Deep Search, keeps its results for grabbing, and logs it. */
  async function runSearch(tvdbId: number, eps: number[], full: boolean, onProgress?: (p: SearchProgress) => void, packs = false) {
    const r = await deepSearch(tvdbId, eps, { full, packs, onProgress });
    for (const [k, v] of lastResults) if (Date.now() - v.at > 30 * 60_000) lastResults.delete(k);
    lastResults.set(searchKey(tvdbId, eps), { at: Date.now(), tvdbId, episodeIds: eps, results: r.results });
    logDecision("search", {
      tvdbId,
      title: r.series.title,
      episodeIds: eps,
      why: `Deep Search: ${r.queries.length} queries (${r.tier === 1 ? "quick" : "wide"} search, ${Math.round(r.tookMs / 100) / 10} s), ${r.found} releases, ${r.matched} for these episodes, ${r.results.filter((x) => x.rank.accept).length} acceptable`,
    });
    // Episodes the library already holds under another series: a hand-picked release is allowed, with a warning.
    const owned = ownedElsewhere(tvdbId);
    return {
      ...r,
      results: publicResults(r.results),
      dryRun: getSettings().managed.dryRun,
      ownedElsewhere: eps.filter((e) => owned.has(e)).map((e) => ({ episodeId: e, why: ownedWhy(owned.get(e)!) })),
    };
  }

  // A season-pack search (Replace season) covers the whole season, however long: Black Clover S1 has 170 episodes.
  const searchBody = (b: { tvdbId?: number; episodeIds?: number[]; full?: boolean; packs?: boolean } | undefined) => ({
    tvdbId: id(b?.tvdbId),
    eps: (b?.episodeIds ?? []).map(id).slice(0, b?.packs === true ? 500 : 50),
    full: b?.full === true,
    packs: b?.packs === true,
  });

  /** Blocking search (scripts, acceptance tests). */
  app.post<{ Body: { tvdbId?: number; episodeIds?: number[]; full?: boolean } }>("/api/search", async (req) => {
    const { tvdbId, eps, full } = searchBody(req.body);
    return runSearch(tvdbId, eps, full);
  });

  /** Search as a job the UI polls: progress ("searched X of Y") and partial results while it runs. */
  interface SearchJob {
    at: number;
    done: boolean;
    progress: { searched: number; total: number; tier: number; found: number };
    partial: ReturnType<typeof publicResults>;
    result: Awaited<ReturnType<typeof runSearch>> | null;
    error: string | null;
  }
  const searchJobs = new Map<string, SearchJob>();
  app.post<{ Body: { tvdbId?: number; episodeIds?: number[]; full?: boolean; packs?: boolean } }>("/api/search/start", async (req) => {
    const { tvdbId, eps, full, packs } = searchBody(req.body);
    if (!seriesByTvdb(tvdbId)) throw fail("That series isn't in the synced library; run Sync first", 404);
    for (const [k, v] of searchJobs) if (Date.now() - v.at > 15 * 60_000) searchJobs.delete(k);
    const jobId = crypto.randomUUID();
    const job: SearchJob = {
      at: Date.now(),
      done: false,
      progress: { searched: 0, total: 0, tier: 1, found: 0 },
      partial: [],
      result: null,
      error: null,
    };
    searchJobs.set(jobId, job);
    void runSearch(
      tvdbId,
      eps,
      full,
      (p) => {
        job.progress = { searched: p.searched, total: p.total, tier: p.tier, found: p.found };
        job.partial = publicResults(p.results);
      },
      packs,
    )
      .then((r) => (job.result = r))
      .catch((e) => (job.error = (e as Error).message))
      .finally(() => (job.done = true));
    return { jobId };
  });
  app.get<{ Params: { id: string } }>("/api/search/job/:id", async (req) => {
    const job = searchJobs.get(req.params.id);
    if (!job) throw fail("That search expired; search again", 404);
    return { done: job.done, progress: job.progress, results: job.done ? undefined : job.partial, result: job.result, error: job.error };
  });

  app.post<{ Body: { tvdbId?: number; episodeIds?: number[]; guid?: string; confirm?: boolean; replace?: boolean } }>(
    "/api/grab",
    async (req) => {
      writable();
      if (req.body?.confirm !== true) throw fail("Confirm the grab first");
      const tvdbId = id(req.body?.tvdbId);
      const eps = (req.body?.episodeIds ?? []).map(id);
      const cached = lastResults.get(searchKey(tvdbId, eps));
      if (!cached) throw fail("Search again first (results expire after 30 minutes)", 409);
      const pick = cached.results.find((r) => r.guid === req.body?.guid);
      if (!pick) throw fail("That release isn't in the last search results", 404);
      const toCand = (r: SearchResult): Candidate => ({
        guid: r.guid,
        title: r.title,
        indexerId: r.indexerId,
        indexer: r.indexer,
        protocol: r.protocol,
        size: r.size,
        downloadUrl: r.downloadUrl,
        magnetUrl: r.magnetUrl,
        label: r.label,
        group: r.group,
        why: r.rank.why,
        episodeIds: r.episodeIds,
      });
      const fallbacks = cached.results.filter((r) => r !== pick && r.rank.accept && r.coversTarget).map(toCand);
      // Replace season: only season packs as fallbacks (a single episode can't replace a season).
      if (req.body?.replace === true && pick.episodeIds.length < 2)
        throw fail("Replace season needs a season pack (this release has one episode)", 400);
      if (req.body?.replace === true)
        return startGrab({
          tvdbId,
          episodeIds: eps,
          candidate: toCand(pick),
          fallbacks: fallbacks.filter((f) => f.episodeIds.length > 1),
          origin: "manual",
          purpose: "replace",
        });
      return startGrab({ tvdbId, episodeIds: eps, candidate: toCand(pick), fallbacks, origin: "manual" });
    },
  );
  /** Replace season: what would be replaced, and why (for the confirm). */
  app.get<{ Params: { tvdbId: string }; Querystring: { season?: string } }>("/api/series/:tvdbId/replace-season", async (req) => {
    const season = Number(req.query.season ?? 1);
    if (!Number.isInteger(season) || season < 0) throw fail("Pick a season", 400);
    return replaceSeasonPreview(id(req.params.tvdbId), season);
  });
  app.get("/api/grabs", async () => listGrabs(100));
  app.get("/api/backlog", async () => backlogSummary());
  app.get("/api/upgrades", async () => upgradeList());
  // Quality goals: the one-time goal question (wizard / Home card / Settings), the upgrade watcher, keep-as-is locks.
  app.get("/api/quality/goal", async () => {
    const s = getSettings();
    const def = s.profiles.find((p) => p.id === s.defaultProfileId) ?? s.profiles[0];
    return {
      asked: !!s.qualityGoalAsked,
      goal: def.qualityGoal ?? "high",
      goals: GOAL_IDS.map((g) => ({ id: g, label: goalLabel(g), help: GOALS[g].help })),
      tdarrGuard: TDARR_GUARD,
    };
  });
  app.put<{ Body: { goal?: string } }>("/api/quality/goal", async (req) => {
    writable();
    const goal = req.body?.goal;
    if (!isGoal(goal)) throw fail("Pick a quality goal");
    const s = getSettings();
    saveProfile(s.defaultProfileId, { qualityGoal: goal });
    patchSettings((x) => ({ ...x, qualityGoalAsked: true }));
    return { goal, label: goalLabel(goal) };
  });
  app.get("/api/quality/upgrades", async () => await qualityUpgradeView());
  app.post("/api/quality/upgrades/start", async () => {
    writable();
    startNow();
    return qualityUpgradeView();
  });
  app.put<{ Body: { paused?: boolean; mode?: string; gbPerDay?: number } }>("/api/quality/upgrades", async (req) => {
    writable();
    const b = req.body ?? {};
    patchSettings((x) => ({
      ...x,
      qualityUpgrade: {
        ...x.qualityUpgrade,
        ...(typeof b.paused === "boolean" ? { paused: b.paused } : {}),
        ...(b.mode === "off" || b.mode === "auto" ? { mode: b.mode } : {}),
        ...(Number.isFinite(b.gbPerDay) ? { gbPerDay: Math.min(100000, Math.max(1, Math.round(b.gbPerDay!))) } : {}),
      },
    }));
    if (typeof b.paused === "boolean") logDecision("info", { why: `Quality upgrades ${b.paused ? "paused" : "resumed"}` });
    return qualityUpgradeView();
  });
  app.get<{ Params: { tvdbId: string } }>("/api/series/:tvdbId/quality", async (req) => {
    const tvdbId = id(req.params.tvdbId);
    const prof = profileFor(tvdbId);
    const series = cache.prepare("SELECT id FROM series WHERE tvdb_id = ?").get(tvdbId) as { id: number } | undefined;
    if (!series) throw fail("Unknown series", 404);
    const seasons = (
      cache.prepare("SELECT DISTINCT season FROM episodes WHERE series_id = ? AND season > 0 ORDER BY season").all(series.id) as {
        season: number;
      }[]
    ).map((r) => r.season);
    return {
      goal: prof.qualityGoal ?? "high",
      goalLabel: goalLabel(prof.qualityGoal ?? "high"),
      reencode: prof.reencode ?? "tdarr",
      locks: locksFor(tvdbId),
      seadex: seasons.map((season) => ({
        season,
        picks: (seadexForSeason(tvdbId, season)?.torrents ?? []).map((x) => ({
          group: x.group,
          best: x.best,
          dualAudio: x.dualAudio,
          tracker: x.tracker,
          source: seadexSource(x),
        })),
        compare: seasonComparison(tvdbId, season),
      })),
      managed: listManaged().some((m) => m.tvdbId === tvdbId),
      check: { lastAt: lastCheck(tvdbId), retryInMs: cooldownLeft(lastCheck(tvdbId)) },
    };
  });
  /** "Check SeaDex now": fetches and saves SeaDex's picks for this show's AniList entries (once per cooldown). */
  app.post<{ Params: { tvdbId: string } }>("/api/series/:tvdbId/seadex/check", async (req) => {
    writable();
    const tvdbId = id(req.params.tvdbId);
    try {
      const r = await checkSeadexNow(tvdbId);
      if (r.status === "checked")
        logDecision("info", { tvdbId, why: `SeaDex checked by hand: ${r.found} of ${r.entries} AniList entries have picks` });
      return r;
    } catch (e) {
      throw fail(`SeaDex didn't answer: ${(e as Error).message}`, 502);
    }
  });
  /** "Upgrade now" for one season: without confirm it only says what it would grab; with confirm it grabs that. */
  app.post<{ Params: { tvdbId: string }; Body: { season?: number; confirm?: boolean } }>(
    "/api/series/:tvdbId/upgrade-season",
    async (req) => {
      writable();
      const season = Number(req.body?.season);
      if (!Number.isInteger(season) || season < 1) throw fail("Pick a season", 400);
      if (!searchConfigured()) throw fail("No indexer is set up for searching", 409);
      return upgradeSeasonNow(id(req.params.tvdbId), season, { confirm: req.body?.confirm === true });
    },
  );
  app.put<{ Params: { tvdbId: string }; Body: { season?: number | null; keep?: boolean } }>("/api/series/:tvdbId/keep", async (req) => {
    writable();
    const tvdbId = id(req.params.tvdbId);
    const season = req.body?.season === null || req.body?.season === undefined ? null : Number(req.body.season);
    const keep = req.body?.keep === true;
    const changed = setLock(tvdbId, season, keep);
    const title =
      (cache.prepare("SELECT title FROM series WHERE tvdb_id = ?").get(tvdbId) as { title: string } | undefined)?.title ?? String(tvdbId);
    if (changed)
      logDecision("info", {
        tvdbId,
        title,
        why: `${title}${season === null ? "" : ` season ${season}`}: ${keep ? 'locked "keep as is" (never upgraded; file names get [Keep] so Tdarr skips them)' : "unlocked (quality upgrades may replace its files again)"}`,
      });
    // The file names follow the lock ({Keep Tag}): the rename plan shows what changes.
    return {
      locks: locksFor(tvdbId),
      rename: await renamePlan(tvdbId)
        .then((r) => r.items.length)
        .catch(() => null),
    };
  });
  app.get("/api/catalog", async () => catalogStatus());
  app.post("/api/catalog/refresh", async () => {
    writable();
    if (catalogRunning) return { started: false, running: true };
    void catalogTick(true).catch(() => undefined);
    return { started: true };
  });
  app.get<{ Params: { tvdbId: string } }>("/api/series/:tvdbId/catalog", async (req) => entriesForSeries(id(req.params.tvdbId)));
  // ---------------------------------------------------------------- download-folder rules + clean-up

  app.get("/api/downloads/status", async () => {
    await measure();
    return { ...downloadsStatus(), presets: PRESETS, settings: getSettings().downloads };
  });
  app.post("/api/downloads/cleanup/plan", async () => {
    const p = await cleanupPlan();
    return {
      actions: p.actions,
      measure: { byScope: p.measure.byScope, disk: p.measure.disk, errors: p.measure.errors },
      allowDelete: getSettings().downloads.allowDelete,
    };
  });
  app.post<{ Body: { only?: string[] } }>("/api/downloads/cleanup/run", async (req) => {
    writable();
    if (getSettings().downloads.cleanup === "off") throw fail("The clean-up is switched off (Settings → Download folders)", 409);
    const steps = ["retry", "leftover", "quarantine"] as const;
    const only = req.body?.only?.filter((x): x is (typeof steps)[number] => (steps as readonly string[]).includes(x));
    return { results: await runCleanup({ only, userAsked: true }) };
  });
  app.put<{ Body: { allowDelete?: boolean } }>("/api/downloads/allow-delete", async (req) => {
    writable();
    const on = req.body?.allowDelete === true;
    patchSettings((x) => ({ ...x, downloads: { ...x.downloads, allowDelete: on } }));
    logDecision("info", {
      why: on
        ? "Download clean-up may now delete (leftovers, junk, finished torrents in AnimeArr's own folders)"
        : "Download clean-up deletions switched off",
    });
    return getSettings().downloads;
  });
}
