/**
 * A Sonarr v3-compatible API (`/api/v3/...`), so request apps that only speak Sonarr (Jellyseerr, Overseerr) can use
 * AnimeArr as their Sonarr server. Only the endpoints those apps call, answered from AnimeArr's own library:
 *
 * - Shows are the library's series (native ones and, while Sonarr still owns some, Sonarr's). Ids are AnimeArr's own
 *   series ids; movies aren't served (there's no Radarr side).
 * - "Monitored" means managed by AnimeArr; a season is monitored when the show's monitoring scope covers it. Requested
 *   seasons become a "picked seasons" scope (Shows → scope shows them).
 * - Adding a show is a native Add (TVDB id → AniList entry through Anime-Lists), managed, live unless practice mode.
 * - Writes never touch Sonarr: a Sonarr-owned show's scope and tags can change, but it can't be deleted here.
 * - DELETE removes a native show from AnimeArr only. Files are never deleted, whatever deleteFiles says.
 * - Commands: MissingEpisodeSearch / SeriesSearch / EpisodeSearch run AnimeArr's own search (dry run and budgets
 *   apply); refresh and rescan commands are accepted and do nothing (AnimeArr refreshes on its own schedule).
 */
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { registerSonarrMore } from "./sonarrApiMore.js";
import {
  allLanguages,
  anilistForTvdb,
  apiId,
  applySeasons,
  EP_COLS,
  episodeResources,
  type EpRow,
  fail,
  int,
  isManaged,
  lookup,
  monitoredOf,
  monitoredSeasons,
  mustSeries,
  profileByApiId,
  profileResource,
  realDeps,
  SERIES_COLS,
  seriesByTvdb,
  seriesResource,
  type SeriesRow,
  setSeriesTags,
  type SonarrApiDeps,
  writable,
} from "./sonarrResources.js";
import { allRows, cache } from "../system/db.js";
import { refuseDropped } from "../dropped.js";
import { setManaged } from "../managed.js";
import { addShow, NATIVE_BASE, removeShow } from "../native.js";
import { mappedPath } from "../system/paths.js";
import { profileFor, setSeriesPrefs } from "../profiles.js";
import { getSettings } from "../system/settings.js";
import { bulkTags, clearTags, createTag, deleteTag, renameTag, tagRows } from "../tags.js";
import { VERSION } from "../system/version.js";

// ---------------------------------------------------------------- commands

interface CommandRes {
  id: number;
  name: string;
  commandName: string;
  status: string;
  result: string;
  queued: string;
  started?: string;
  ended?: string;
  trigger: string;
  priority: string;
  message?: string;
  body: Record<string, unknown>;
  sendUpdatesToClient: boolean;
  updateScheduledTask: boolean;
}
const commands = new Map<number, CommandRes>();
let nextCommand = 1;

/** Marks a command that is still running as finished (or failed) when its work settles, so clients polling it see it end. */
function settle(c: CommandRes, work: Promise<unknown>) {
  c.status = "started";
  c.result = "unknown";
  c.ended = undefined;
  void work.then(
    () => Object.assign(c, { status: "completed", result: "successful", ended: new Date().toISOString() }),
    (e: Error) => Object.assign(c, { status: "failed", result: "unsuccessful", message: e.message, ended: new Date().toISOString() }),
  );
}
const seasonEpisodeIds = (seriesId: number, season: number, now: number) => {
  const rows = cache.prepare("SELECT id, has_file, air_utc FROM episodes WHERE series_id = ? AND season = ?").all(seriesId, season) as {
    id: number;
    has_file: number;
    air_utc: number | null;
  }[];
  const missing = rows.filter((r) => !r.has_file && r.air_utc !== null && r.air_utc <= now);
  return (missing.length ? missing : rows.filter((r) => !r.has_file)).map((r) => r.id);
};

async function runCommand(body: Record<string, unknown>, d: SonarrApiDeps): Promise<CommandRes> {
  const name = String(body.name ?? "");
  const now = new Date().toISOString();
  const c: CommandRes = {
    id: nextCommand++,
    name,
    commandName: name,
    status: "completed",
    result: "successful",
    queued: now,
    started: now,
    ended: now,
    trigger: "manual",
    priority: "normal",
    body,
    sendUpdatesToClient: true,
    updateScheduledTask: true,
  };
  if (name === "MissingEpisodeSearch" || (name === "SeriesSearch" && body.seriesId)) {
    const s = mustSeries(int(body.seriesId, "seriesId"));
    const r = d.searchMissing(s.tvdb_id, s.title);
    c.message = r.queued ? `${r.missing} missing episodes went to the fill-in queue` : `Searching ${r.searching} missing episodes`;
  } else if (name === "SeasonSearch") {
    const s = mustSeries(int(body.seriesId, "seriesId"));
    const season = Number(body.seasonNumber);
    if (!Number.isInteger(season) || season < 0) throw fail("Bad seasonNumber");
    const ids = seasonEpisodeIds(s.id, season, Date.now());
    if (ids.length) settle(c, d.searchEpisodes(s.tvdb_id, ids));
    c.message = `Searching ${ids.length} episodes of season ${season}`;
  } else if (name === "EpisodeSearch") {
    const ids = (Array.isArray(body.episodeIds) ? body.episodeIds : []).map((x) => int(x, "episode id"));
    const bySeries = new Map<number, number[]>();
    for (const e of ids.length
      ? (cache.prepare(`SELECT id, series_id FROM episodes WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as {
          id: number;
          series_id: number;
        }[])
      : [])
      bySeries.set(e.series_id, [...(bySeries.get(e.series_id) ?? []), e.id]);
    const jobs: Promise<unknown>[] = [];
    for (const [sid, eps] of bySeries) {
      const s = mustSeries(sid);
      jobs.push(d.searchEpisodes(s.tvdb_id, eps.slice(0, 26))); // outcomes land in Activity
    }
    settle(c, Promise.all(jobs));
    c.message = `Searching ${ids.length} episodes`;
  } else if (name === "RescanSeries" || name === "RefreshSeries") {
    // A rescan re-reads the show folder; AnimeArr refreshes metadata on its own schedule.
    if (body.seriesId && name === "RescanSeries") {
      const s = mustSeries(int(body.seriesId, "seriesId"));
      if (s.path) settle(c, d.rescan(s.path));
    }
    c.message = name === "RescanSeries" ? "Rescanning the show folder" : "AnimeArr refreshes metadata on its own schedule";
  } else if (/^(Refresh|Rescan)Monitored/.test(name)) {
    c.message = "AnimeArr refreshes and rescans on its own schedule";
  } else if (name === "RssSync") {
    settle(c, d.rssSync());
    c.message = "Checking the indexers' newest releases";
  } else if (name === "Backup") {
    const file = d.backup();
    c.message = file ? `Backup saved as ${file}` : "The backup could not be made";
    if (!file) Object.assign(c, { status: "failed", result: "unsuccessful" });
  } else if (name === "RenameSeries" || name === "RenameFiles") {
    c.message = "AnimeArr renames only when you confirm it on the show's page (Rename)";
  } else {
    throw fail(`AnimeArr doesn't run the Sonarr command "${name}"`);
  }
  commands.set(c.id, c);
  if (commands.size > 100) commands.delete(commands.keys().next().value!);
  return c;
}

// ---------------------------------------------------------------- routes

/** A view of a query object whose keys are found in any case (an exact match wins). */
export function caseInsensitive<T extends Record<string, unknown>>(q: T): T {
  const lower = new Map(Object.keys(q).map((k) => [k.toLowerCase(), k]));
  return new Proxy(q, {
    get: (t, k) => (typeof k !== "string" || k in t ? Reflect.get(t, k) : Reflect.get(t, lower.get(k.toLowerCase()) ?? k)),
    has: (t, k) => (typeof k !== "string" ? Reflect.has(t, k) : k in t || lower.has(k.toLowerCase())),
  });
}

export function registerSonarrApi(app: FastifyInstance, opts: { urlBase: string; deps?: Partial<SonarrApiDeps> }) {
  const d: SonarrApiDeps = { ...realDeps, ...opts.deps };
  const started = new Date().toISOString();
  const V = "/api/v3";

  // Sonarr (ASP.NET) binds query names in any case: seriesID, SeriesId and seriesId are the same parameter. Every
  // handler here reads the camelCase name, so the query is looked up case-insensitively on these routes.
  app.addHook("preHandler", async (req) => {
    if (!req.routeOptions.url?.startsWith(`${V}/`)) return;
    const q = req.query as Record<string, unknown> | undefined;
    if (q && typeof q === "object") req.query = caseInsensitive(q);
  });

  // Sonarr 4 on the wire (no language profiles asked for); AnimeArr's own version rides along.
  app.get(`${V}/system/status`, async () => ({
    appName: "AnimeArr",
    instanceName: "AnimeArr",
    version: "4.0.0.0",
    animeArrVersion: VERSION,
    buildTime: started,
    isDebug: false,
    isProduction: true,
    isAdmin: false,
    isUserInteractive: false,
    startupPath: "/app",
    appData: "/config",
    osName: process.platform,
    osVersion: "",
    isNetCore: false,
    isMono: false,
    isLinux: process.platform === "linux",
    isOsx: process.platform === "darwin",
    isWindows: process.platform === "win32",
    isDocker: fs.existsSync("/.dockerenv"),
    mode: "console",
    branch: "main",
    authentication: "forms",
    sqliteVersion: "",
    migrationVersion: 0,
    urlBase: opts.urlBase,
    runtimeVersion: process.versions.node,
    runtimeName: "node",
    startTime: started,
    packageUpdateMechanism: "docker",
  }));

  app.get(`${V}/qualityprofile`, async () => getSettings().profiles.map(profileResource));
  app.get<{ Params: { id: string } }>(`${V}/qualityprofile/:id`, async (req) => {
    const p = profileByApiId(req.params.id);
    if (!p) throw fail("Profile not found", 404);
    return profileResource(p);
  });
  // Sonarr 3's language profiles: AnimeArr's languages live in its profiles, so there's one catch-all.
  app.get(`${V}/languageprofile`, async () => [
    {
      id: 1,
      name: "AnimeArr profile languages",
      upgradeAllowed: false,
      cutoff: { id: 1, name: "English" },
      languages: allLanguages().map((l) => ({ language: l, allowed: true })),
    },
  ]);
  app.get(`${V}/language`, async () => allLanguages());
  app.get<{ Params: { id: string } }>(
    `${V}/language/:id`,
    async (req) =>
      allLanguages().find((l) => l.id === Number(req.params.id)) ??
      (() => {
        throw fail("Language not found", 404);
      })(),
  );

  app.get(`${V}/rootfolder`, async () =>
    getSettings().allowedRoots.map((p) => {
      let freeSpace = 0;
      let totalSpace = 0;
      try {
        const st = fs.statfsSync(mappedPath(p));
        freeSpace = st.bavail * st.bsize;
        totalSpace = st.blocks * st.bsize;
      } catch {
        /* unmounted: reported as 0 */
      }
      return { id: apiId("root", p), path: p, accessible: totalSpace > 0, freeSpace, totalSpace, unmappedFolders: [] };
    }),
  );

  app.get(`${V}/tag`, async () => tagRows());
  app.get<{ Params: { id: string } }>(
    `${V}/tag/:id`,
    async (req) =>
      tagRows().find((t) => t.id === int(req.params.id)) ??
      (() => {
        throw fail("Tag not found", 404);
      })(),
  );
  app.post<{ Body: { label?: string } }>(`${V}/tag`, async (req, reply) => {
    writable();
    reply.code(201);
    return createTag(req.body?.label);
  });
  app.put<{ Params: { id: string }; Body: { label?: string } }>(`${V}/tag/:id`, async (req, reply) => {
    writable();
    reply.code(202);
    return renameTag(int(req.params.id), req.body?.label);
  });
  app.delete<{ Params: { id: string } }>(`${V}/tag/:id`, async (req) => {
    writable();
    if (tagRows().some((t) => t.id === int(req.params.id))) deleteTag(int(req.params.id));
    return {};
  });

  app.get<{ Querystring: { tvdbId?: string } }>(`${V}/series`, async (req) => {
    const rows = req.query.tvdbId
      ? allRows<SeriesRow>(cache.prepare(`SELECT ${SERIES_COLS} FROM series WHERE tvdb_id = ?`), int(req.query.tvdbId, "tvdbId"))
      : allRows<SeriesRow>(cache.prepare(`SELECT ${SERIES_COLS} FROM series ORDER BY sort_title`));
    const now = Date.now();
    return rows.map((s) => seriesResource(s, now));
  });
  app.get<{ Querystring: { term?: string } }>(`${V}/series/lookup`, async (req) => lookup(String(req.query.term ?? ""), d));
  app.get<{ Params: { id: string } }>(`${V}/series/:id`, async (req) => seriesResource(mustSeries(int(req.params.id))));

  // Add: a native show, managed (live unless practice mode), with the requested seasons and profile.
  app.post<{ Body: Record<string, unknown> }>(`${V}/series`, async (req, reply) => {
    writable();
    const b = req.body ?? {};
    const tvdbId = int(b.tvdbId, "tvdbId");
    refuseDropped(tvdbId);
    if (seriesByTvdb(tvdbId)) throw fail("This series has already been added", 400);
    const anilistId = await anilistForTvdb(tvdbId, d);
    if (!anilistId) throw fail(`AnimeArr's anime mappings (Anime-Lists) don't know TVDB ${tvdbId}; AnimeArr only adds anime`, 404);
    const added = await addShow({ anilistId, rootFolder: String(b.rootFolderPath ?? "") }, { media: d.media, fribb: d.fribb });
    const profile = profileByApiId(b.qualityProfileId);
    if (profile) setSeriesPrefs(added.tvdbId, profile.id, null);
    const seasons = monitoredOf(b.seasons);
    if (seasons) applySeasons(added.tvdbId, seasons);
    setSeriesTags(added.tvdbId, b.tags);
    if (b.monitored !== false) setManaged([added.tvdbId], true, { live: true });
    const opt = (b.addOptions ?? {}) as { searchForMissingEpisodes?: boolean };
    if (opt.searchForMissingEpisodes && b.monitored !== false) d.searchMissing(added.tvdbId, added.title);
    reply.code(201);
    return seriesResource(seriesByTvdb(added.tvdbId)!);
  });

  // Edit: season monitoring (the scope), tags, and managing a show that wasn't. Never written to Sonarr.
  const edit = async (idParam: unknown, b: Record<string, unknown>) => {
    writable();
    const s = mustSeries(int(idParam));
    const seasons = monitoredOf(b.seasons);
    if (seasons) applySeasons(s.tvdb_id, seasons);
    if (b.tags !== undefined) setSeriesTags(s.tvdb_id, b.tags);
    if (b.monitored === true && !isManaged(s.tvdb_id)) setManaged([s.tvdb_id], true, { live: true });
    const profile = b.qualityProfileId !== undefined ? profileByApiId(b.qualityProfileId) : null;
    if (profile && profile.id !== profileFor(s.tvdb_id).id) setSeriesPrefs(s.tvdb_id, profile.id, null);
    return seriesResource(mustSeries(s.id));
  };
  // Bulk edit (nzb360 / LunaSea "series editor"): monitoring, profile and tags, mapped onto AnimeArr's own. Nothing
  // that moves or deletes files: deleteFiles and moveFiles are refused, and so is a different root folder.
  app.put<{ Body: Record<string, unknown> }>(`${V}/series/editor`, async (req, reply) => {
    writable();
    const b = req.body ?? {};
    if (b.deleteFiles === true) throw fail("AnimeArr never deletes files through the API", 400);
    if (b.moveFiles === true) throw fail("AnimeArr doesn't move shows' files through the API; do it in AnimeArr", 400);
    if (!Array.isArray(b.seriesIds) || !b.seriesIds.length) throw fail("Pass seriesIds", 400);
    const rows = b.seriesIds.map((x) => mustSeries(int(x, "series id")));
    const root = typeof b.rootFolderPath === "string" && b.rootFolderPath.trim() ? b.rootFolderPath.trim().replace(/\/+$/, "") : null;
    if (root && rows.some((s) => (s.root_folder ?? "").replace(/\/+$/, "") !== root))
      throw fail("AnimeArr doesn't change a show's root folder through the API (that would move its files); do it in AnimeArr", 400);
    const profile = b.qualityProfileId !== undefined ? profileByApiId(b.qualityProfileId) : null;
    if (b.qualityProfileId !== undefined && !profile) throw fail("Profile not found", 404);
    const tags = Array.isArray(b.tags) ? b.tags.map((x) => int(x, "tag id")) : null;
    const how = String(b.applyTags ?? "add").toLowerCase();
    if (tags && !["add", "remove", "replace"].includes(how)) throw fail("applyTags is add, remove or replace", 400);
    const tvdbIds = rows.map((s) => s.tvdb_id);
    if (b.monitored === true || b.monitored === false) setManaged(tvdbIds, b.monitored, { live: true }); // "unmonitored" = not managed; files stay
    for (const s of rows) {
      if (profile && profile.id !== profileFor(s.tvdb_id).id) setSeriesPrefs(s.tvdb_id, profile.id, null);
      if (tags && how === "replace") setSeriesTags(s.tvdb_id, tags);
    }
    if (tags && how !== "replace") bulkTags("series", tvdbIds, how === "add" ? tags : [], how === "remove" ? tags : []);
    reply.code(202);
    return rows.map((s) => seriesResource(mustSeries(s.id)));
  });
  app.put<{ Body: Record<string, unknown> }>(`${V}/series`, async (req, reply) => {
    reply.code(202);
    return edit(req.body?.id, req.body ?? {});
  });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(`${V}/series/:id`, async (req, reply) => {
    reply.code(202);
    return edit(req.params.id, req.body ?? {});
  });

  // Remove: native shows only, and never their files (deleteFiles is ignored on purpose).
  app.delete<{ Params: { id: string } }>(`${V}/series/:id`, async (req) => {
    writable();
    const s = mustSeries(int(req.params.id));
    if (s.id < NATIVE_BASE) throw fail("This show still belongs to Sonarr (AnimeArr runs next to it); remove it in Sonarr", 409);
    removeShow(s.tvdb_id);
    clearTags("series", s.tvdb_id);
    return {};
  });

  app.get<{ Querystring: { seriesId?: string; episodeIds?: string | string[] } }>(`${V}/episode`, async (req) => {
    const q = req.query;
    if (q.seriesId)
      return episodeResources(
        allRows<EpRow>(
          cache.prepare(`SELECT ${EP_COLS} FROM episodes WHERE series_id = ? ORDER BY season, episode`),
          int(q.seriesId, "seriesId"),
        ),
      );
    const ids = (Array.isArray(q.episodeIds) ? q.episodeIds : String(q.episodeIds ?? "").split(","))
      .filter(Boolean)
      .map((x) => int(x, "episode id"));
    if (!ids.length) throw fail("Pass seriesId or episodeIds");
    return episodeResources(
      allRows<EpRow>(
        cache.prepare(`SELECT ${EP_COLS} FROM episodes WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY season, episode`),
        ...ids,
      ),
    );
  });
  app.get<{ Params: { id: string } }>(`${V}/episode/:id`, async (req) => {
    const r = cache.prepare(`SELECT ${EP_COLS} FROM episodes WHERE id = ?`).get(int(req.params.id)) as EpRow | undefined;
    if (!r) throw fail("Episode not found", 404);
    return episodeResources([r])[0];
  });
  // Monitoring works per season in AnimeArr: monitoring an episode monitors its season; a season is unmonitored
  // when all of its episodes are.
  app.put<{ Body: { episodeIds?: unknown[]; monitored?: boolean } }>(`${V}/episode/monitor`, async (req, reply) => {
    writable();
    const ids = (req.body?.episodeIds ?? []).map((x) => int(x, "episode id"));
    const want = req.body?.monitored !== false;
    const rows = ids.length
      ? allRows<EpRow>(cache.prepare(`SELECT ${EP_COLS} FROM episodes WHERE id IN (${ids.map(() => "?").join(",")})`), ...ids)
      : [];
    for (const sid of new Set(rows.map((r) => r.series_id))) {
      const s = mustSeries(sid);
      const mine = rows.filter((r) => r.series_id === sid);
      const seasons = monitoredSeasons(s);
      if (want) for (const r of mine) seasons.add(r.season);
      else
        for (const season of new Set(mine.map((r) => r.season))) {
          const all = (
            cache.prepare("SELECT id FROM episodes WHERE series_id = ? AND season = ?").all(sid, season) as { id: number }[]
          ).map((r) => r.id);
          if (all.every((x) => ids.includes(x))) seasons.delete(season);
        }
      applySeasons(s.tvdb_id, [...seasons]);
      if (want && !isManaged(s.tvdb_id)) setManaged([s.tvdb_id], true, { live: true });
    }
    reply.code(202);
    return episodeResources(rows);
  });

  registerSonarrMore(app, d);

  app.post<{ Body: Record<string, unknown> }>(`${V}/command`, async (req, reply) => {
    writable();
    reply.code(201);
    return runCommand(req.body ?? {}, d);
  });
  app.get(`${V}/command`, async () => [...commands.values()]);
  app.get<{ Params: { id: string } }>(
    `${V}/command/:id`,
    async (req) =>
      commands.get(int(req.params.id)) ??
      (() => {
        throw fail("Command not found", 404);
      })(),
  );
}
