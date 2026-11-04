/** Routes: Adding shows: the Sonarr/Radarr cutover, native Add, importing existing folders, import lists. */
import { isBlocked, refuseDropped, undropShow } from "../library/dropped.js";
import { NATIVE_BASE } from "../library/nativeIds.js";
import {
  ackSpecials,
  adoptMovies,
  adoptShows,
  autoMatchMovies,
  cutoverCachedAt,
  cutoverPlan,
  detach,
  matchMovieManual,
  matchShow,
  setArrWrites,
  setWithoutArr,
  switchToAnimeArr,
  unmatch,
} from "../library/cutover.js";
import { cache, db } from "../system/db.js";
import { logDecision } from "../system/activity.js";
import { setSeriesPrefs, setMoviePrefs } from "../library/profiles.js";
import {
  addExclusion,
  cleanList,
  deleteList,
  excludeShow,
  exclusions,
  LIST_STATUSES,
  listLists,
  MAX_AUTO,
  planList,
  removeExclusion,
  saveList,
  syncList,
} from "../library/importLists.js";
import { setManaged } from "../library/managed.js";
import { invalidateIndex } from "../metadata/metadata.js";
import { autoSearchMovie, searchMissingNow } from "../search/autosearch.js";
import { setScope, validateScope, type Scope } from "../library/scope.js";
import { addToQueue } from "../library/fillin.js";

import { adoptFolder, matchFolder, scanRoot } from "../library/folderImport.js";
import { addMovie, addShow, materializeAll, removeMovie, removeShow, searchAdd, seasonPicks } from "../library/native.js";
import { binOwnFolder, removalPlan, withRemoveLock } from "../library/removeFiles.js";
import { getSettings } from "../system/settings.js";
import type { FastifyInstance } from "fastify";
import { fail, id, writable } from "./common.js";

export function registerAddingRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- cutover (Sonarr/Radarr → AnimeArr)

  // The plan is built on request ("Build plan"), in slices, and cached; ?cached=1 only returns a built one.
  app.get<{ Querystring: { cached?: string; fresh?: string } }>("/api/cutover", async (req) => {
    if (req.query.cached === "1" && cutoverCachedAt() === null) return { built: false };
    return { built: true, ...(await cutoverPlan(undefined, { cached: req.query.fresh !== "1" })) };
  });

  app.post<{ Body: { tvdbIds?: number[]; movieIds?: number[]; acceptSpecials?: boolean } }>("/api/cutover/adopt", async (req) => {
    writable();
    const b = req.body ?? {};
    const shows = adoptShows(
      (b.tvdbIds ?? []).map(Number).filter((x) => Number.isInteger(x) && x > 0),
      { acceptSpecials: b.acceptSpecials === true },
    );
    const movies = await adoptMovies((b.movieIds ?? []).map(Number).filter((x) => Number.isInteger(x) && x > 0));
    materializeAll();
    return { shows, movies };
  });
  app.post<{ Body: { tvdbIds?: number[]; movieIds?: number[]; acceptSpecials?: boolean } }>("/api/cutover/remove", async (req) => {
    writable();
    const b = req.body ?? {};
    const out = await switchToAnimeArr({
      tvdbIds: (b.tvdbIds ?? []).map(Number),
      movieIds: (b.movieIds ?? []).map(Number),
      acceptSpecials: b.acceptSpecials === true,
    });
    invalidateIndex();
    return { results: out };
  });
  app.post<{ Body: { tvdbId: number; anilistId: number; season?: number; offset?: number; force?: boolean } }>(
    "/api/cutover/match-show",
    async (req) => {
      writable();
      const b = req.body ?? ({} as never);
      return matchShow(id(b.tvdbId), id(b.anilistId), Number(b.season ?? 1), Number(b.offset ?? 0), undefined, { force: b.force === true });
    },
  );
  app.post<{ Body: { movieId: number; anilistId: number } }>("/api/cutover/match-movie", async (req) => {
    writable();
    await matchMovieManual(id(req.body?.movieId), id(req.body?.anilistId));
    return { ok: true };
  });
  app.post<{ Body: { anilistId: number } }>("/api/cutover/unmatch", async (req) => {
    writable();
    await unmatch(id(req.body?.anilistId));
    return { ok: true };
  });
  app.post<{ Body: { tvdbId: number; on?: boolean } }>("/api/cutover/ack-specials", async (req) => {
    writable();
    ackSpecials(id(req.body?.tvdbId), req.body?.on !== false);
    return { ok: true };
  });
  app.post("/api/cutover/match-movies", async () => {
    writable();
    return autoMatchMovies();
  });
  app.put<{ Body: { allowArrWrites?: boolean } }>("/api/cutover/allow", async (req) => {
    writable();
    setArrWrites(req.body?.allowArrWrites === true);
    return getSettings().cutover;
  });
  // Detach: AnimeArr takes adopted shows and movies over without any call to Sonarr/Radarr (all: everything adopted).
  app.post<{ Body: { tvdbIds?: number[]; movieIds?: number[]; all?: boolean; acceptSpecials?: boolean } }>(
    "/api/cutover/detach",
    async (req) => {
      writable();
      const b = req.body ?? {};
      const pos = (xs: unknown[] | undefined) => (xs ?? []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
      const tvdbIds = pos(b.tvdbIds);
      const movieIds = pos(b.movieIds);
      if (!tvdbIds.length && !movieIds.length && b.all !== true) throw fail("Pick what to detach, or ask for all of it");
      const results = await detach({ tvdbIds, movieIds, all: b.all === true, acceptSpecials: b.acceptSpecials === true });
      invalidateIndex();
      return { results };
    },
  );
  app.put<{ Body: { on?: boolean } }>("/api/cutover/without-arr", async (req) => {
    writable();
    return setWithoutArr(req.body?.on === true);
  });

  // ---------------------------------------------------------------- native Add (no Sonarr/Radarr)

  app.get<{ Querystring: { q?: string } }>("/api/add/search", async (req) => searchAdd(String(req.query.q ?? "").slice(0, 200)));
  app.get("/api/add/season", async () => ({ items: await seasonPicks().catch(() => []) }));
  app.post<{
    Body: {
      anilistId: number;
      rootFolder: string;
      kind?: "show" | "movie";
      profileId?: string | null;
      sizePreset?: string | null;
      scope?: Scope | null;
      then?: "search" | "queue" | "none";
      live?: boolean;
      unblock?: boolean;
    };
  }>("/api/add", async (req) => {
    writable();
    const b = req.body ?? ({} as never);
    if (!id(b.anilistId)) throw fail("anilistId is required", 400);
    if (b.profileId && !getSettings().profiles.some((p) => p.id === b.profileId)) throw fail("Unknown profile", 400);
    if (b.sizePreset && !["lean", "balanced", "best"].includes(b.sizePreset)) throw fail("Unknown size preset", 400);
    if (b.then && !["search", "queue", "none"].includes(b.then)) throw fail("Unknown next step", 400);
    if (b.kind === "movie") {
      if (b.then === "queue") throw fail("Movies aren't queued; search now or just add", 400);
      const mv = await addMovie({ anilistId: Number(b.anilistId), rootFolder: String(b.rootFolder ?? "") });
      if (b.profileId) setMoviePrefs(mv.movieId, b.profileId, null);
      let then: unknown = null;
      if (b.then === "search") {
        then = { searching: 1 };
        void autoSearchMovie(mv.movieId).catch((e) =>
          logDecision("fail", { title: mv.title, why: `Search after adding ${mv.title} failed: ${(e as Error).message}` }),
        );
      }
      return { ...mv, then };
    }
    const scope = b.scope ? validateScope(b.scope) : null;
    // A blocked show (dropped and removed): refused unless the user chose "Add anyway", which unblocks it first.
    const mapped = (
      db.prepare("SELECT tvdb_id FROM entries WHERE anilist_id = ?").get(Number(b.anilistId)) as { tvdb_id: number | null } | undefined
    )?.tvdb_id;
    if (b.unblock === true) for (const t of [mapped, NATIVE_BASE + Number(b.anilistId)]) if (t && isBlocked(t)) undropShow(t);
    refuseDropped(mapped);
    refuseDropped(NATIVE_BASE + Number(b.anilistId));
    const added = await addShow({ anilistId: Number(b.anilistId), rootFolder: String(b.rootFolder ?? "") });
    if (b.profileId || b.sizePreset)
      setSeriesPrefs(added.tvdbId, b.profileId || null, null, (b.sizePreset || null) as Parameters<typeof setSeriesPrefs>[3]);
    if (scope) setScope([added.tvdbId], scope);
    const managed = setManaged([added.tvdbId], true, { live: b.live !== false && !getSettings().managed.dryRun });
    let then: unknown = null;
    if (b.then === "queue") then = addToQueue([added.tvdbId]);
    else if (b.then === "search") then = searchMissingNow(added.tvdbId, added.title);
    return { ...added, managed, then };
  });

  // Import existing folders: list a root's show folders, match one folder at a time (the page paces AniList), adopt as-is.
  app.get<{ Querystring: { root?: string } }>("/api/import/folders", async (req) => scanRoot(String(req.query.root ?? "")));
  app.post<{ Body: { name: string } }>("/api/import/match", async (req) => matchFolder(String(req.body?.name ?? "").slice(0, 300)));
  app.post<{ Body: { rootFolder: string; name: string; anilistId: number; profileId?: string | null } }>(
    "/api/import/adopt",
    async (req) => {
      writable();
      const b = req.body ?? ({} as never);
      if (b.profileId && !getSettings().profiles.some((p) => p.id === b.profileId)) throw fail("Unknown profile", 400);
      refuseDropped(
        (db.prepare("SELECT tvdb_id FROM entries WHERE anilist_id = ?").get(Number(b.anilistId)) as { tvdb_id: number | null } | undefined)
          ?.tvdb_id,
      );
      const r = await adoptFolder({ rootFolder: String(b.rootFolder ?? ""), name: String(b.name ?? ""), anilistId: Number(b.anilistId) });
      if (b.profileId) setSeriesPrefs(r.tvdbId, b.profileId, null, null);
      const managed = setManaged([r.tvdbId], true, { live: !getSettings().managed.dryRun }); // the same defaults as Add
      return { ...r, managed };
    },
  );

  // "Also delete its folder and files" (?files=1): the folder goes to the recycling bin FIRST (removeFiles.ts); a refused
  // or failed move throws, and then the show or movie is NOT forgotten. One remove per item at a time (double clicks).
  app.get<{ Params: { movieId: string } }>("/api/add/movie/:movieId/remove-plan", async (req) =>
    removalPlan({ kind: "movie", movieId: id(req.params.movieId) }),
  );
  app.get<{ Params: { tvdbId: string } }>("/api/add/:tvdbId/remove-plan", async (req) =>
    removalPlan({ kind: "show", tvdbId: id(req.params.tvdbId) }),
  );
  app.delete<{ Params: { movieId: string }; Querystring: { files?: string } }>("/api/add/movie/:movieId", async (req) => {
    writable();
    const owner = { kind: "movie", movieId: id(req.params.movieId) } as const;
    return withRemoveLock(owner, async () => {
      if (req.query.files !== "1") return removeMovie(owner.movieId);
      const binned = await binOwnFolder(owner);
      return { ...removeMovie(owner.movieId, { filesBinned: binned.moved > 0 }), binned };
    });
  });
  app.delete<{ Params: { tvdbId: string }; Querystring: { exclude?: string; files?: string } }>("/api/add/:tvdbId", async (req) => {
    writable();
    const tvdbId = id(req.params.tvdbId);
    const owner = { kind: "show", tvdbId } as const;
    return withRemoveLock(owner, async () => {
      const binned = req.query.files === "1" ? await binOwnFolder(owner) : null;
      // "Don't let my import lists add it again" (Sonarr's list exclusion), taken before the show's entries are forgotten.
      const title = (cache.prepare("SELECT title FROM series WHERE tvdb_id = ?").get(tvdbId) as { title: string } | undefined)?.title ?? "";
      const out = { ...removeShow(tvdbId, { filesBinned: !!binned?.moved }), ...(binned ? { binned } : {}) };
      return req.query.exclude === "1" ? { ...out, excluded: excludeShow(tvdbId, title) } : out;
    });
  });

  // ---------------------------------------------------------------- import lists (AniList / MyAnimeList)

  app.get("/api/import-lists", async () => ({
    lists: listLists(),
    exclusions: exclusions(),
    statuses: LIST_STATUSES,
    intervalHours: getSettings().lists.intervalHours,
    maxAuto: MAX_AUTO,
  }));
  app.post<{ Body: Record<string, unknown> }>("/api/import-lists", async (req) => (writable(), saveList(null, req.body ?? {})));
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/import-lists/:id",
    async (req) => (writable(), saveList(id(req.params.id), req.body ?? {})),
  );
  app.delete<{ Params: { id: string } }>("/api/import-lists/:id", async (req) => (writable(), deleteList(id(req.params.id)), { ok: true }));
  // Test: reads the (unsaved) account and says what a sync would do. Adds nothing.
  app.post<{ Body: Record<string, unknown> }>("/api/import-lists/test", async (req) => {
    const c = cleanList(req.body ?? {});
    const plan = await planList(c);
    return { total: plan.total, matched: plan.matched, wouldAdd: plan.add.length, skipped: plan.skipped, items: plan.items.slice(0, 200) };
  });
  app.post<{ Params: { id: string }; Body: { confirm?: boolean } }>(
    "/api/import-lists/:id/sync",
    async (req) => (writable(), syncList(id(req.params.id), { confirm: req.body?.confirm === true })),
  );
  app.post("/api/import-lists/sync", async () => {
    writable();
    const out: { id: number; name: string; added: number; preview: boolean; error?: string }[] = [];
    for (const l of listLists().filter((x) => x.enabled)) {
      try {
        const r = await syncList(l.id);
        out.push({ id: l.id, name: l.name, added: r.added, preview: r.preview });
      } catch (e) {
        out.push({ id: l.id, name: l.name, added: 0, preview: false, error: (e as Error).message });
      }
    }
    return { lists: out };
  });
  app.post<{ Body: { anilistId?: number; title?: string } }>(
    "/api/import-lists/exclusions",
    async (req) => (writable(), addExclusion(Number(req.body?.anilistId), String(req.body?.title ?? "")), { exclusions: exclusions() }),
  );
  app.delete<{ Params: { anilistId: string } }>(
    "/api/import-lists/exclusions/:anilistId",
    async (req) => (writable(), removeExclusion(id(req.params.anilistId)), { exclusions: exclusions() }),
  );
}
