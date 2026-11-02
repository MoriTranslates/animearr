/** Routes: AnimeArr's own importer and renamer, manual import, movie search and grabs, the recycle bin. */
import { binStatus, purgeBin, unpinBinned } from "../import/binpurge.js";
import { searchConfigured } from "../search/indexers.js";
import { reevaluate } from "../grabs/downloads.js";
import { cache, db } from "../system/db.js";
import { logDecision } from "../system/activity.js";
import { setMoviePrefs } from "../library/profiles.js";
import { finishGrabByHand, grabDownloadPath, keepGrab, nextForGrab, removeGrab } from "../grabs/pipeline.js";
import { retryImport, type Candidate } from "../grabs/pipelineState.js";
import { grabHistory, queueView, removeSonarrQueueItem, sonarrQueueProblems } from "../grabs/queue.js";
import { recentChecks, repairTick } from "../import/repair.js";
import { recycleSetting, recycleStatus } from "../import/recycle.js";
import { movieSearchSummary, planMovies } from "../search/movieSearch.js";
import { fileSummary, scanFolder, scanLibrary, scanRunning } from "../import/mediafiles.js";
import { autoJobs, queueAutoSearch, queueAutoSearchMovie } from "../search/autosearch.js";
import { scopeFor, scopePreview, setScope, validateScope } from "../library/scope.js";
import { addToQueue, editQueue, fillInView } from "../library/fillin.js";

import { listMovies, movieDetail, searchMovie, setWanted, startMovieGrab } from "../library/movies.js";
import {
  applyRenameRouted,
  browseImport,
  executeImport,
  executeMovieImport,
  planImport,
  planMovieImport,
  planRename,
  renamePlan,
} from "../import/importer.js";
import { importMediaDefaults, previewNaming } from "../import/mediadefaults.js";
import { isNativeSeriesId, rematerializeSeries } from "../library/native.js";
import { seriesByTvdb } from "../search/search.js";
import { getSettings, patchSettings } from "../system/settings.js";
import type { FastifyInstance } from "fastify";
import { fail, id, writable } from "./common.js";

export function registerFilesRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- AnimeArr's own importer + renamer (plans first)

  /** A manual import opened from a grab: its release name (quality, group) and client (torrents are copied, keep seeding). */
  const grabSource = (b: { release?: string; client?: string | null; grabId?: number | null }) => {
    const g = b.grabId
      ? (db.prepare("SELECT release, client FROM grabs WHERE id = ?").get(Number(b.grabId)) as
          { release: string; client: string | null } | undefined)
      : undefined;
    return { release: b.release ?? g?.release, client: b.client ?? g?.client ?? null };
  };
  /** The hand import's per-file choices: which files (only) and which episode each one is (assign: source → ids). */
  const handChoices = (b: { only?: unknown; assign?: unknown }) => ({
    only: Array.isArray(b.only) ? b.only.map(String) : undefined,
    assign:
      b.assign && typeof b.assign === "object"
        ? Object.fromEntries(
            Object.entries(b.assign as Record<string, unknown>)
              .filter(([, v]) => Array.isArray(v))
              .map(([k, v]) => [k, (v as unknown[]).map(Number).filter((n) => Number.isInteger(n) && n > 0)]),
          )
        : undefined,
  });
  app.post<{
    Body: {
      tvdbId: number;
      path: string;
      episodeIds?: number[];
      release?: string;
      client?: string | null;
      grabId?: number | null;
      only?: string[];
      assign?: Record<string, number[]>;
    };
  }>("/api/import/plan", async (req) => {
    const b = req.body ?? ({} as never);
    if (!b.tvdbId || !b.path) throw fail("tvdbId and path are required", 400);
    return planImport({
      tvdbId: Number(b.tvdbId),
      path: String(b.path),
      episodeIds: b.episodeIds?.map(Number),
      ...grabSource(b),
      ...handChoices(b),
    });
  });
  app.post<{
    Body: {
      tvdbId: number;
      path: string;
      episodeIds?: number[];
      release?: string;
      client?: string | null;
      only?: string[];
      assign?: Record<string, number[]>;
      dryRun?: boolean;
      grabId?: number | null;
    };
  }>("/api/import/run", async (req) => {
    writable();
    const b = req.body ?? ({} as never);
    if (!b.tvdbId || !b.path) throw fail("tvdbId and path are required", 400);
    const plan = await planImport({
      tvdbId: Number(b.tvdbId),
      path: String(b.path),
      episodeIds: b.episodeIds?.map(Number),
      ...grabSource(b),
      ...handChoices(b),
    });
    const results = await executeImport(plan, {
      dryRun: b.dryRun !== false,
      only: b.only,
      grabId: b.grabId ? Number(b.grabId) : undefined,
    });
    // Opened from a grab's fix: everything it was for is imported → the grab is done.
    if (b.grabId && b.dryRun === false && results.length && results.every((r) => r.done))
      await finishGrabByHand(Number(b.grabId), plan.seriesTitle);
    return { plan, results };
  });
  /**
   * Manual import picker: lists a folder under the importer's source roots (and the grab's own download folder, when
   * opened from a grab). Read-only, confined to those roots. Also returns the grab's download path, to start there.
   */
  app.get<{ Querystring: { path?: string; grabId?: string } }>("/api/import/browse", async (req) => {
    const grabPath = req.query.grabId ? await grabDownloadPath(id(req.query.grabId)) : null;
    // No path asked: start in the grab's download (when known); an empty path lists the roots.
    const want = req.query.path ?? grabPath ?? "";
    return { ...(await browseImport({ path: want, extra: [grabPath] })), grabPath };
  });
  /** Movie import plan (a dry run; nothing is changed). */
  app.post<{ Body: { movieId: number; path: string; release?: string; client?: string | null; grabId?: number | null } }>(
    "/api/import/movie-plan",
    async (req) => {
      const b = req.body ?? ({} as never);
      if (!id(b.movieId) || !b.path) throw fail("movieId and path are required", 400);
      return planMovieImport({ movieId: Number(b.movieId), path: String(b.path), ...grabSource(b) });
    },
  );
  app.get<{ Params: { tvdbId: string } }>("/api/series/:tvdbId/rename", async (req) => renamePlan(id(req.params.tvdbId)));
  app.post<{ Params: { tvdbId: string }; Body: { fileIds: number[] } }>("/api/series/:tvdbId/rename", async (req) => {
    writable();
    return applyRenameRouted(id(req.params.tvdbId), (req.body?.fileIds ?? []).map(Number));
  });
  app.get("/api/media/rename-all", async () => {
    const rows = cache.prepare("SELECT tvdb_id, title FROM series ORDER BY sort_title").all() as { tvdb_id: number; title: string }[];
    const out: { tvdbId: number; title: string; count: number }[] = [];
    for (const r of rows) {
      await new Promise((res) => setImmediate(res)); // one show at a time: other requests are answered in between
      try {
        const n = planRename(r.tvdb_id).items.length;
        if (n) out.push({ tvdbId: r.tvdb_id, title: r.title, count: n });
      } catch {
        /* skip */
      }
    }
    return { series: out, total: out.reduce((a, b) => a + b.count, 0) };
  });
  app.post<{ Body: Record<string, unknown> }>("/api/media/preview", async (req) => previewNaming((req.body ?? {}) as never));
  app.get("/api/media/status", async () => ({ importer: getSettings().importer, importedFromArr: getSettings().media.importedFromArr }));
  /** Who imports, and whether real imports/renames are on (switched on after the first plans were reviewed). */
  app.put<{ Body: { engine?: string; allowReal?: boolean; allowRename?: boolean; realBudget?: number; movies?: boolean } }>(
    "/api/media/importer",
    async (req) => {
      writable();
      const b = req.body ?? {};
      const cur = getSettings().importer;
      if (b.engine === "sonarr") throw fail("Imports through Sonarr/Radarr are gone: AnimeArr imports by itself", 400);
      const next = {
        engine: "animearr" as const,
        allowReal: typeof b.allowReal === "boolean" ? b.allowReal : cur.allowReal,
        allowRename: typeof b.allowRename === "boolean" ? b.allowRename : cur.allowRename,
        realBudget: Number.isInteger(b.realBudget) && b.realBudget! >= -1 && b.realBudget! <= 1000 ? b.realBudget! : (cur.realBudget ?? 0),
        movies: typeof b.movies === "boolean" ? b.movies : !!cur.movies,
        sourceRoots: cur.sourceRoots ?? ["/data/completed/animearr", "/data/qbittorrent/completed/animearr"],
      };
      patchSettings((x) => ({ ...x, importer: next }));
      logDecision("info", {
        why: `Importer: ${next.engine === "animearr" ? "AnimeArr's own" : "through Sonarr/Radarr"}; real imports ${next.allowReal ? (next.realBudget < 0 ? "on" : `on for ${next.realBudget} more`) : "off"}; renames ${next.allowRename ? "on" : "off"}`,
      });
      return next;
    },
  );
  app.post("/api/media/import-defaults", async () => {
    writable();
    return importMediaDefaults();
  });

  app.post<{ Params: { tvdbId: string } }>("/api/series/:tvdbId/scan", async (req) => {
    const s = seriesByTvdb(id(req.params.tvdbId));
    if (!s) throw fail("Unknown series", 404);
    const r = await scanFolder(s.path);
    if (isNativeSeriesId(s.id)) rematerializeSeries(s.id);
    return r;
  });
  app.post<{ Params: { id: string } }>("/api/movies/:id/scan", async (req) => {
    const m = cache.prepare("SELECT path FROM movies WHERE id = ?").get(id(req.params.id)) as { path: string } | undefined;
    if (!m) throw fail("Unknown movie", 404);
    return scanFolder(m.path);
  });
  app.get<{
    Params: { tvdbId: string };
    Querystring: { seasons?: string; recentN?: string; episodes?: string; specials?: string; creditless?: string; picked?: string };
  }>("/api/series/:tvdbId/scope", async (req) => {
    const tvdbId = id(req.params.tvdbId);
    const current = scopeFor(tvdbId);
    const q = req.query;
    const want = q.seasons
      ? validateScope({
          seasons: q.seasons as never,
          recentN: Number(q.recentN ?? 1),
          episodes: q.episodes as never,
          specials: q.specials === "1",
          creditless: q.creditless !== "0",
          picked: (q.picked ?? "").split(",").filter(Boolean).map(Number),
        })
      : current;
    return { scope: current, preview: scopePreview(tvdbId, want) };
  });
  app.put<{ Body: { tvdbIds?: number[]; scope?: Record<string, unknown> | null } }>("/api/scope", async (req) => {
    writable();
    const ids = (req.body?.tvdbIds ?? []).map(id);
    if (!ids.length) throw fail("Pick at least one show");
    setScope(ids, req.body?.scope ? validateScope(req.body.scope as never) : null);
    return { ok: true, changed: ids.length };
  });
  app.get("/api/fillin", async () => fillInView());
  app.post<{ Body: { tvdbIds?: number[] } }>("/api/fillin", async (req) => {
    writable();
    return addToQueue((req.body?.tvdbIds ?? []).map(id));
  });
  app.put<{ Params: { tvdbId: string }; Body: { action?: string } }>("/api/fillin/:tvdbId", async (req) => {
    writable();
    const a = req.body?.action;
    if (!["up", "down", "skip", "remove", "requeue"].includes(a ?? "")) throw fail("Unknown action");
    editQueue(id(req.params.tvdbId), a as "up");
    return { ok: true };
  });
  // ⚡ answers at once: the search runs as a background job; its outcomes go to Activity, the bell and /api/autosearch/jobs.
  app.post<{ Body: { tvdbId?: number; episodeIds?: number[] } }>("/api/autosearch", async (req) => {
    writable();
    if (!searchConfigured()) throw fail("No indexer is set up (Settings → Indexers)");
    return queueAutoSearch(id(req.body?.tvdbId), (req.body?.episodeIds ?? []).map(id));
  });
  app.get("/api/autosearch/jobs", async () => autoJobs());
  app.post<{ Body: { movieIds?: number[]; wanted?: boolean } }>("/api/movies/wanted", async (req) => {
    writable();
    const r = setWanted(
      (req.body?.movieIds ?? []).map(Number).filter((x) => Number.isInteger(x) && x > 0),
      req.body?.wanted !== false,
    );
    planMovies();
    return r;
  });
  app.post<{ Params: { id: string }; Body: { replace?: boolean } }>("/api/movies/:id/autosearch", async (req) => {
    writable();
    // The same indexers as "Pick a version…" (Prowlarr or AnimeArr's own), not Prowlarr only.
    if (!searchConfigured()) throw fail("No indexer is set up (Settings → Indexers)");
    return queueAutoSearchMovie(id(req.params.id), { replace: req.body?.replace === true });
  });
  app.get("/api/files/summary", async () => fileSummary());
  app.post<{ Body: { full?: boolean } }>("/api/files/scan", async (req) => {
    writable();
    if (scanRunning()) return { started: false, running: true };
    void scanLibrary({ full: req.body?.full === true }).catch(() => undefined);
    return { started: true };
  });
  app.get("/api/movies-search", async () => movieSearchSummary());
  app.get("/api/movies", async () => listMovies());
  app.get<{ Params: { id: string } }>("/api/movies/:id", async (req) => movieDetail(id(req.params.id)));
  app.put<{ Params: { id: string }; Body: { profileId?: string | null; watchMode?: string | null } }>(
    "/api/movies/:id/prefs",
    async (req) => {
      writable();
      const movieId = id(req.params.id);
      movieDetail(movieId); // 404 when unknown
      return setMoviePrefs(movieId, req.body?.profileId || null, (req.body?.watchMode || null) as Parameters<typeof setMoviePrefs>[2]);
    },
  );
  // Grabs pick from the server's own last results (never a download URL sent by the browser).
  const lastMovieResults = new Map<number, { at: number; results: Awaited<ReturnType<typeof searchMovie>>["results"] }>();
  app.post<{ Params: { id: string } }>("/api/movies/:id/search", async (req) => {
    if (!searchConfigured()) throw fail("No indexer is set up (Settings → Indexers)");
    const r = await searchMovie(id(req.params.id));
    lastMovieResults.set(r.movie.id, { at: Date.now(), results: r.results });
    // Download links carry indexer API keys/passkeys: never sent to the browser (grabs use the cached results).
    return { ...r, results: r.results.map(({ downloadUrl: _d, magnetUrl: _m, ...x }) => x), dryRun: getSettings().managed.dryRun };
  });
  app.post<{ Params: { id: string }; Body: { guid?: string; confirm?: boolean; replace?: boolean } }>(
    "/api/movies/:id/grab",
    async (req) => {
      writable();
      if (req.body?.confirm !== true) throw fail("Confirm the grab first");
      const movieId = id(req.params.id);
      const cached = lastMovieResults.get(movieId);
      if (!cached || Date.now() - cached.at > 30 * 60_000) throw fail("Search again first (results expire after 30 minutes)", 409);
      const pick = cached.results.find((r) => r.guid === req.body?.guid);
      if (!pick) throw fail("That release isn't in the last search results", 404);
      const toCand = (r: (typeof cached.results)[number]): Candidate => ({
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
        episodeIds: [],
      });
      const fallbacks = cached.results.filter((r) => r !== pick && r.rank.accept && r.confidence >= 80).map(toCand);
      return startMovieGrab({ movieId, candidate: toCand(pick), fallbacks, origin: "manual", replace: req.body?.replace === true });
    },
  );
  app.get<{ Querystring: { fresh?: string } }>("/api/recycle", async (req) =>
    recycleStatus(undefined, Date.now(), req.query.fresh === "1"),
  );
  app.get("/api/recycle/animearr", async () => binStatus());
  app.post<{ Body: { confirm?: boolean } }>("/api/recycle/animearr/empty", async (req) => {
    writable();
    if (req.body?.confirm !== true) throw fail("Confirm emptying the bin first", 400);
    return purgeBin({ all: true });
  });
  // A file an import couldn't put back stays pinned in the bin until the user says they dealt with it.
  app.post<{ Body: { path?: string } }>("/api/recycle/animearr/unpin", async (req) => {
    writable();
    if (!unpinBinned(String(req.body?.path ?? ""))) throw fail("That file isn't pinned in the bin", 404);
    return { ok: true };
  });
  app.get("/api/recycle/setting", async () => {
    try {
      return await recycleSetting(undefined, Date.now(), true);
    } catch (e) {
      return { configured: false, path: "", cleanupDays: 0, error: (e as Error).message };
    }
  });
  app.get("/api/repair/recent", async () => ({ mode: getSettings().repair.mode, checks: recentChecks(100) }));
  app.post("/api/repair/run", async () => {
    writable();
    const run = repairTick();
    if (!run) return { done: false, reason: getSettings().repair.mode === "off" ? "off" : "no-sonarr" };
    // Wait up to 20 s; a long first run keeps going in the background.
    const r = await Promise.race([
      run.then(
        (x) => x,
        () => null,
      ),
      new Promise<undefined>((res) => setTimeout(res, 20_000)),
    ]);
    if (r === undefined) return { done: false, reason: "running" };
    if (r === null) return { done: false, reason: "error" };
    return { done: true, checked: r.length, bad: r.filter((x) => !x.ok && x.action !== "skipped").length };
  });
  app.get("/api/queue", async () => queueView());
  app.get("/api/queue/sonarr", async () => ({ items: await sonarrQueueProblems() }));
  app.post<{ Params: { id: string }; Body: { blocklist?: boolean; confirm?: boolean; downloadId?: string | null } }>(
    "/api/queue/sonarr/:id/remove",
    async (req) => {
      writable();
      if (req.body?.confirm !== true) throw fail("Confirm first");
      await removeSonarrQueueItem(
        id(req.params.id),
        req.body?.blocklist === true,
        typeof req.body?.downloadId === "string" ? req.body.downloadId : null,
      );
      return { ok: true };
    },
  );
  app.get<{ Querystring: { before?: string; state?: string } }>("/api/history", async (req) =>
    grabHistory({ before: req.query.before ? Number(req.query.before) : undefined, state: req.query.state || undefined }),
  );
  app.post<{ Params: { id: string }; Body: { blocklist?: boolean; searchNext?: boolean; confirm?: boolean } }>(
    "/api/queue/:id/remove",
    async (req) => {
      writable();
      if (req.body?.confirm !== true) throw fail("Confirm first");
      const next = await removeGrab(id(req.params.id), {
        blocklist: req.body?.blocklist === true,
        searchNext: req.body?.searchNext === true,
      });
      return { ok: true, next };
    },
  );
  app.post<{ Params: { id: string } }>("/api/grabs/:id/keep", async (req) => {
    writable();
    keepGrab(id(req.params.id));
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/grabs/:id/next", async (req) => {
    writable();
    const r = await nextForGrab(id(req.params.id));
    return { ok: true, next: r };
  });
  app.post<{ Body: { movieId: number; path: string; grabId?: number | null } }>("/api/import/movie-run", async (req) => {
    writable();
    const grabId = req.body?.grabId ? Number(req.body.grabId) : undefined;
    const plan = await planMovieImport({
      movieId: id(req.body?.movieId),
      path: String(req.body?.path ?? ""),
      ...grabSource(req.body ?? {}),
    });
    const results = await executeMovieImport(plan, { grabId });
    if (grabId && results.length && results.every((r) => r.done)) await finishGrabByHand(grabId, plan.title);
    return { plan, results };
  });
  app.post<{ Body: { name: string } }>("/api/downloads/rules/disable", async (req) => {
    writable();
    const name = String(req.body?.name ?? "");
    const s = getSettings();
    if (!s.downloads.rules.some((r) => r.name === name)) throw fail("No rule with that name", 404);
    patchSettings((x) => ({
      ...x,
      downloads: { ...x.downloads, rules: x.downloads.rules.map((r) => (r.name === name ? { ...r, enabled: false } : r)) },
    }));
    reevaluate();
    logDecision("info", { why: `You switched the download-folder rule "${name}" off (grabs resume)` });
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/grabs/:id/retry", async (req) => {
    writable();
    retryImport(id(req.params.id));
    return { ok: true };
  });
}
