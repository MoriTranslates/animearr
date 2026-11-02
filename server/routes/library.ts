/** Routes: Library sync, managed shows, language profiles, tags and release rules, episodes, audits, facts/aliases/numbering rules. */
import { cache, db } from "../system/db.js";
import { logDecision } from "../system/activity.js";
import { gaps, listFacts, missingLanguage, specials } from "../audit.js";
import { coverFor } from "../metadata/covers.js";
import { deleteRule, listRules, saveRule, testRules } from "../releaseRules.js";
import { bulkTags, createTag, deleteTag, listTags, renameTag, setTags, tagsOf } from "../tags.js";
import { deleteProfile, listProfiles, profileFor, saveProfile, setSeriesPrefs, seriesPrefs } from "../profiles.js";
import { registerIcal } from "../ical.js";
import { calendar, deleteEpisodeFiles, episodeDetail, episodeRows, regrabEpisodes, searchAgainSoon, seriesHeader } from "../episodes.js";
import { compactKey } from "../core/normalize.js";
import { refreshCovers } from "../metadata/covers.js";
import { syncLibrary } from "../library.js";
import { candidates, managePreview, managedTick, scheduleFor, setManaged, setShowDryRun, unmonitorInSonarr } from "../managed.js";
import { listManaged } from "../managedList.js";
import { aliasIndex, invalidateIndex } from "../metadata/metadata.js";
import { listGrabs } from "../pipeline.js";
import { moviesForSeries, setLink } from "../franchise.js";
import { lastFolderScan, scanFolder } from "../mediafiles.js";
import { missingScoped } from "../scope.js";

import { movieCalendar, movieDetail } from "../movies.js";
import { isNativeSeriesId, rematerializeSeries } from "../native.js";
import { duplicateListings } from "../duplicates.js";
import { episodesFor, seriesByTvdb } from "../search.js";
import { getSettings, type LanguageProfile } from "../system/settings.js";
import type { FastifyInstance } from "fastify";
import { fail, id, writable } from "./common.js";

export function registerLibraryRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- library import / sync, managed shows

  app.post<{ Body: { full?: boolean } }>("/api/library/sync", async (req) => {
    writable();
    void syncLibrary(req.body?.full === true)
      .then(() => refreshCovers())
      .catch(() => undefined);
    return { started: true };
  });
  // `/api/shows` is the documented name for the full library list (docs/API.md); the Shows page still uses the old one.
  app.get("/api/shows", async () => candidates());
  app.get("/api/library/candidates", async () => candidates());
  app.get<{ Querystring: { q?: string } }>("/api/series", async (req) => {
    const q = compactKey(String(req.query.q ?? ""));
    const rows = cache.prepare("SELECT tvdb_id, title, poster, status, year FROM series ORDER BY sort_title").all() as {
      tvdb_id: number;
      title: string;
      poster: string | null;
      status: string;
      year: number | null;
    }[];
    const alt = q
      ? new Set(
          (
            cache.prepare("SELECT s.tvdb_id FROM alt_titles a JOIN series s ON s.id = a.series_id WHERE a.key LIKE ?").all(`%${q}%`) as {
              tvdb_id: number;
            }[]
          ).map((r) => r.tvdb_id),
        )
      : null;
    return rows
      .filter((r) => !q || compactKey(r.title).includes(q) || alt?.has(r.tvdb_id))
      .slice(0, 50)
      .map((r) => ({ tvdbId: r.tvdb_id, title: r.title, status: r.status, year: r.year, cover: coverFor(r) }));
  });
  app.get<{ Params: { tvdbId: string } }>("/api/series/:tvdbId", async (req) => {
    const tvdbId = id(req.params.tvdbId);
    const s = seriesByTvdb(tvdbId);
    if (!s) throw fail("Not in the synced library", 404);
    const eps = episodesFor(tvdbId).sort((a, b) => a.season - b.season || a.episode - b.episode);
    // Opening a series page re-checks its folder in the background (at most every 10 minutes).
    if (getSettings().library.scan && Date.now() - lastFolderScan(s.path) > 10 * 60_000)
      void scanFolder(s.path)
        .then(() => isNativeSeriesId(s.id) && rematerializeSeries(s.id))
        .catch(() => undefined);
    const idx = aliasIndex();
    return {
      ...s,
      managed: listManaged().find((m) => m.tvdbId === tvdbId) ?? null,
      episodes: eps,
      anidb: idx.anidbIdsFor(tvdbId).map((x) => ({ ...x, title: idx.anidbTitle(x.aid) })),
      aliases: db.prepare("SELECT id, title, season, source FROM aliases WHERE tvdb_id = ? ORDER BY id").all(tvdbId) as {
        id: number;
        title: string;
        season: number | null;
        source: string;
      }[],
      rules: db.prepare("SELECT id, grp, mode, season, offset, note FROM rules WHERE tvdb_id = ? ORDER BY id").all(tvdbId),
      facts: listFacts(tvdbId),
      schedule: scheduleFor(tvdbId),
      header: seriesHeader(tvdbId),
      prefs: seriesPrefs(tvdbId),
      tags: tagsOf("series", tvdbId),
      rows: episodeRows(s.id),
      movies: moviesForSeries(tvdbId),
    };
  });
  app.put<{ Body: { tvdbId?: number; movieId?: number; on?: boolean } }>("/api/franchise/link", async (req) => {
    writable();
    setLink(id(req.body?.tvdbId), id(req.body?.movieId), req.body?.on !== false);
    return { ok: true };
  });

  // ---------------------------------------------------------------- language profiles + per-show override

  app.get("/api/profiles", async () => ({ profiles: listProfiles(), defaultProfileId: getSettings().defaultProfileId }));
  app.post<{ Body: Record<string, unknown> & { makeDefault?: boolean } }>("/api/profiles", async (req) => {
    writable();
    return saveProfile(null, (req.body ?? {}) as Partial<LanguageProfile>, req.body?.makeDefault === true);
  });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> & { makeDefault?: boolean } }>("/api/profiles/:id", async (req) => {
    writable();
    return saveProfile(String(req.params.id), (req.body ?? {}) as Partial<LanguageProfile>, req.body?.makeDefault === true);
  });
  app.delete<{ Params: { id: string } }>("/api/profiles/:id", async (req) => {
    writable();
    deleteProfile(String(req.params.id));
    return { ok: true };
  });
  app.put<{ Params: { tvdbId: string }; Body: { profileId?: string | null; watchMode?: string | null; sizePreset?: string | null } }>(
    "/api/series/:tvdbId/prefs",
    async (req) => {
      writable();
      const tvdbId = id(req.params.tvdbId);
      if (!seriesByTvdb(tvdbId)) throw fail("Unknown series", 404);
      return setSeriesPrefs(
        tvdbId,
        req.body?.profileId || null,
        (req.body?.watchMode || null) as Parameters<typeof setSeriesPrefs>[2],
        req.body?.sizePreset === undefined ? undefined : ((req.body.sizePreset || null) as Parameters<typeof setSeriesPrefs>[3]),
      );
    },
  );

  // ---------------------------------------------------------------- tags + release rules

  app.get("/api/tags", async () => ({ tags: listTags() }));
  app.post<{ Body: { label?: string } }>("/api/tags", async (req) => (writable(), createTag(req.body?.label)));
  app.put<{ Params: { id: string }; Body: { label?: string } }>(
    "/api/tags/:id",
    async (req) => (writable(), renameTag(id(req.params.id), req.body?.label)),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/tags/:id",
    async (req) => (writable(), { ok: true, unlinked: deleteTag(id(req.params.id)) }),
  );
  app.put<{ Params: { tvdbId: string }; Body: { tags?: number[] } }>("/api/series/:tvdbId/tags", async (req) => {
    writable();
    const tvdbId = id(req.params.tvdbId);
    if (!seriesByTvdb(tvdbId)) throw fail("Unknown series", 404);
    return { tags: setTags("series", tvdbId, req.body?.tags) };
  });
  app.put<{ Params: { id: string }; Body: { tags?: number[] } }>("/api/movies/:id/tags", async (req) => {
    writable();
    const movieId = id(req.params.id);
    movieDetail(movieId); // 404 when unknown
    return { tags: setTags("movie", movieId, req.body?.tags) };
  });
  /** Add and/or remove tags on the selected shows (Shows page) or movies. */
  app.post<{ Body: { kind?: string; ids?: number[]; add?: number[]; remove?: number[] } }>("/api/tags/bulk", async (req) => {
    writable();
    const b = req.body ?? {};
    if (b.kind !== "series" && b.kind !== "movie") throw fail("kind must be series or movie");
    const nums = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter(Number.isInteger).slice(0, 2000) : []);
    return bulkTags(b.kind, nums(b.ids), nums(b.add), nums(b.remove));
  });

  app.get("/api/release-rules", async () => ({ rules: listRules() }));
  app.post<{ Body: Record<string, unknown> }>("/api/release-rules", async (req) => (writable(), saveRule(null, (req.body ?? {}) as never)));
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/release-rules/:id",
    async (req) => (writable(), saveRule(String(req.params.id), (req.body ?? {}) as never)),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/release-rules/:id",
    async (req) => (writable(), deleteRule(String(req.params.id)), { ok: true }),
  );
  /** "Test against a title": which rules match or block a sample release name. */
  app.post<{ Body: { title?: string; tvdbId?: number; movieId?: number } }>("/api/release-rules/test", async (req) => {
    const title = String(req.body?.title ?? "")
      .trim()
      .slice(0, 500);
    if (!title) throw fail("Type a release name to test");
    const scope = req.body?.tvdbId
      ? { kind: "series" as const, ref: id(req.body.tvdbId) }
      : req.body?.movieId
        ? { kind: "movie" as const, ref: id(req.body.movieId) }
        : undefined;
    return testRules(title, scope);
  });

  // ---------------------------------------------------------------- episodes: detail, delete, re-grab, calendar

  app.get<{ Params: { id: string } }>("/api/episodes/:id", async (req) => {
    const d = episodeDetail(id(req.params.id));
    if (!d) throw fail("Unknown episode", 404);
    return d;
  });
  type EpBody = { tvdbId?: number; episodeIds?: number[]; confirm?: boolean };
  const epBody = (b: EpBody | undefined) => {
    const ids = (b?.episodeIds ?? []).map(id).slice(0, 100);
    if (!ids.length) throw fail("Pick at least one episode");
    return { tvdbId: id(b?.tvdbId), ids };
  };
  app.post<{ Body: EpBody }>("/api/episodes/delete", async (req) => {
    writable();
    if (req.body?.confirm !== true) throw fail("Confirm the delete first");
    const { tvdbId, ids } = epBody(req.body);
    return deleteEpisodeFiles(tvdbId, ids);
  });
  app.post<{ Body: EpBody }>("/api/episodes/regrab", async (req) => {
    writable();
    if (req.body?.confirm !== true) throw fail("Confirm the re-grab first");
    const { tvdbId, ids } = epBody(req.body);
    return { results: await regrabEpisodes(tvdbId, ids), dryRun: getSettings().managed.dryRun };
  });
  app.post<{ Body: EpBody }>("/api/episodes/search-soon", async (req) => {
    writable();
    const { tvdbId, ids } = epBody(req.body);
    if (!listManaged().some((m) => m.tvdbId === tvdbId))
      throw fail("Only managed shows have a search schedule; use Deep Search instead", 409);
    searchAgainSoon(tvdbId, ids);
    void managedTick().catch(() => undefined);
    return { ok: true };
  });
  app.get<{ Querystring: { from?: string; to?: string; managed?: string } }>("/api/calendar", async (req) => {
    const day = 86_400_000;
    const from = Number(req.query.from) || Date.now() - 7 * day;
    const to = Number(req.query.to) || Date.now() + 14 * day;
    if (to - from > 120 * day) throw fail("Pick a shorter range");
    return { from, to, entries: calendar(from, to, req.query.managed === "1"), movies: movieCalendar(from, to, req.query.managed === "1") };
  });

  registerIcal(app);

  app.post<{ Body: { tvdbIds?: number[]; on?: boolean; live?: boolean } }>("/api/managed", async (req) => {
    writable();
    const ids = (req.body?.tvdbIds ?? []).map(id).slice(0, 500);
    return setManaged(ids, req.body?.on !== false, { live: req.body?.live === true });
  });
  app.post<{ Body: { tvdbIds?: number[] } }>("/api/managed/preview", async (req) =>
    managePreview((req.body?.tvdbIds ?? []).map(id).slice(0, 500)),
  );
  app.get("/api/managed", async () => ({
    dryRun: getSettings().managed.dryRun,
    backlogOn: getSettings().backlog.enabled,
    shows: listManaged().map((m) => ({
      ...m,
      cover: seriesByTvdb(m.tvdbId)?.cover ?? null,
      schedule: scheduleFor(m.tvdbId, 6),
      missing: missingScoped(m.tvdbId, m.seriesId).length,
    })),
    grabs: listGrabs(30, { episodesOnly: true }),
  }));
  app.put<{ Params: { tvdbId: string }; Body: { dryRun?: boolean } }>("/api/managed/:tvdbId", async (req) => {
    writable();
    if (typeof req.body?.dryRun !== "boolean") throw fail("dryRun must be true or false");
    setShowDryRun(id(req.params.tvdbId), req.body.dryRun);
    return { ok: true };
  });
  app.post<{ Params: { tvdbId: string }; Body: { monitored?: boolean; confirm?: boolean } }>(
    "/api/managed/:tvdbId/sonarr-monitor",
    async (req) => {
      writable();
      if (req.body?.confirm !== true) throw fail("Confirm first");
      await unmonitorInSonarr(id(req.params.tvdbId), req.body?.monitored === true);
      return { ok: true };
    },
  );
  app.post("/api/managed/run", async () => {
    void managedTick().catch((e) => app.log.warn(e.message));
    return { started: true };
  });

  // ---------------------------------------------------------------- audits (read-only)

  app.get<{ Querystring: { sidecars?: string } }>("/api/audit/language", async (req) =>
    missingLanguage({ checkSidecars: req.query.sidecars === "1" }),
  );
  // `/api/wanted` is the documented name for the wanted list (docs/API.md); Audit → Gaps still uses the old one.
  app.get("/api/wanted", async () => gaps());
  app.get("/api/audit/gaps", async () => gaps());
  app.get("/api/audit/duplicates", async () => ({ items: duplicateListings() }));
  app.get("/api/audit/specials", async () => specials());

  // ---------------------------------------------------------------- facts, aliases, numbering rules (user data)

  app.post<{ Body: { tvdbId?: number; season?: number | null; kind?: string; lang?: string; note?: string } }>(
    "/api/facts",
    async (req) => {
      writable();
      const tvdbId = id(req.body?.tvdbId);
      const s = seriesByTvdb(tvdbId);
      if (!s) throw fail("Unknown series", 404);
      const kind = req.body?.kind === "no_release" ? "no_release" : "burned_in";
      const season = req.body?.season === null || req.body?.season === undefined ? null : Number(req.body.season);
      const lang = String(req.body?.lang ?? profileFor(tvdbId).subLangs[0] ?? "en").slice(0, 10);
      const note = String(req.body?.note ?? "").slice(0, 200);
      const r = db
        .prepare(
          "INSERT INTO facts (tvdb_id, season, kind, lang, note, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET note = excluded.note, at = excluded.at RETURNING id",
        )
        .get(tvdbId, season, kind, lang, note, Date.now()) as { id: number };
      logDecision("fact", {
        tvdbId,
        title: s.title,
        why: `You confirmed: ${s.title}${season !== null ? ` season ${season}` : ""} ${kind === "burned_in" ? `has burned-in ${lang} subtitles` : "has no release in your language"}${note ? ` (${note})` : ""}`,
        undo: { action: "delete-fact", args: { id: r.id } },
      });
      return { ok: true };
    },
  );
  app.delete<{ Params: { id: string } }>("/api/facts/:id", async (req) => {
    writable();
    db.prepare("DELETE FROM facts WHERE id = ?").run(id(req.params.id));
    return { ok: true };
  });

  app.post<{ Body: { tvdbId?: number; title?: string; season?: number | null } }>("/api/aliases", async (req) => {
    writable();
    const tvdbId = id(req.body?.tvdbId);
    const s = seriesByTvdb(tvdbId);
    if (!s) throw fail("Unknown series", 404);
    const title = String(req.body?.title ?? "")
      .trim()
      .slice(0, 200);
    const key = compactKey(title);
    if (!key) throw fail("Type the alias");
    const season =
      req.body?.season === null || req.body?.season === undefined || (req.body.season as unknown) === "" ? null : Number(req.body.season);
    const r = db
      .prepare(
        "INSERT INTO aliases (key, title, tvdb_id, season, source, created_at) VALUES (?, ?, ?, ?, 'user', ?) ON CONFLICT DO NOTHING",
      )
      .run(key, title, tvdbId, season, Date.now());
    invalidateIndex();
    if (r.changes)
      logDecision("alias", {
        tvdbId,
        title: s.title,
        why: `Alias "${title}" → ${s.title}${season !== null ? ` season ${season}` : ""}`,
        undo: { action: "delete-alias", args: { id: Number(r.lastInsertRowid) } },
      });
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>("/api/aliases/:id", async (req) => {
    writable();
    db.prepare("DELETE FROM aliases WHERE id = ?").run(id(req.params.id));
    invalidateIndex();
    return { ok: true };
  });

  app.post<{ Body: { tvdbId?: number; group?: string; mode?: string; season?: number | null; offset?: number; note?: string } }>(
    "/api/rules",
    async (req) => {
      writable();
      const tvdbId = id(req.body?.tvdbId);
      const s = seriesByTvdb(tvdbId);
      if (!s) throw fail("Unknown series", 404);
      const mode = ["auto", "absolute", "season", "offset"].find((m) => m === req.body?.mode);
      if (!mode) throw fail("Pick a numbering mode");
      const season = req.body?.season === null || req.body?.season === undefined ? null : Number(req.body.season);
      if ((mode === "season" || mode === "offset") && (season === null || !Number.isInteger(season))) throw fail("Pick the season");
      const group =
        String(req.body?.group ?? "")
          .trim()
          .slice(0, 60) || null;
      const offset = Math.trunc(Number(req.body?.offset ?? 0)) || 0;
      const r = db
        .prepare("INSERT INTO rules (tvdb_id, grp, mode, season, offset, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(tvdbId, group, mode, season, offset, String(req.body?.note ?? "").slice(0, 200), Date.now());
      logDecision("rule", {
        tvdbId,
        title: s.title,
        why: `Numbering rule for ${s.title}${group ? ` (${group} only)` : ""}: ${mode}${season !== null ? ` season ${season}` : ""}${offset ? ` offset ${offset}` : ""}`,
        undo: { action: "delete-rule", args: { id: Number(r.lastInsertRowid) } },
      });
      return { ok: true };
    },
  );
  app.delete<{ Params: { id: string } }>("/api/rules/:id", async (req) => {
    writable();
    db.prepare("DELETE FROM rules WHERE id = ?").run(id(req.params.id));
    return { ok: true };
  });
}
