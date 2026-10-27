import os from "node:os";
import { binStatus, binTick, purgeBin } from "./binpurge.js";
import { replaceSeasonPreview } from "./episodes.js";
import crypto from "node:crypto";
import { setIndexerUse } from "./indexerPick.js";
import { droppedList, dropShow, refuseDropped, undropShow } from "./dropped.js";
import { breakerList, breakerTick, setBreaker, testIndexer as retestIndexer, type Fetcher } from "./health.js";
import { watchLinks } from "./watchIn.js";
import { indexerNumId, searchConfigured, searchIndexer } from "./indexers.js";
import { deleteOverrides, fileDetail, peekFrames, renameSidecarBack, rescanOne, setTrackLanguage, useSidecar } from "./detection.js";
import { applyArrPreview, arrPreview, createCategory, listFolders, saveWizard, wizardState } from "./wizard.js";
import { addJackettTracker, deleteClient, deleteIndexer, indexerCatalog, jackettTrackers, listClients, listIndexers, saveClient, saveIndexer, setClientPrefs, testExtraClient, testIndexer } from "./connectionsAdmin.js";
import { airingShowCount, homeSummary } from "./home.js";
import { thumb, type ThumbSize } from "./img.js";
import { connectionsOverview, invalidateConnections } from "./connections.js";
import { fixesFor } from "./fixes.js";
import { asciiJson } from "./json.js";
import { anidbStatus, anidbTick, anidbView, fetchForTvdb, setAnidbOverride } from "./anidb.js";
import { testTmdb } from "./catalog.js";
import { bell, markRead, send } from "./notify.js";
import { ackSpecials, adoptMovies, adoptShows, allShowCuts, autoMatchMovies, cutoverCachedAt, cutoverPlan, invalidateCutover, matchMovieManual, matchShow, refreshCuts, setArrWrites, switchToAnimeArr, unmatch } from "./cutover.js";
import { testPlex } from "./plex.js";
import { cleanupPlan, downloadsStatus, downloadsTick, measure, PRESETS, reevaluate, runCleanup } from "./downloads.js";
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { authState, COOKIE, csrfOk, guard, hostAllowed, isLocalRequest, loginAllowed, loginSucceeded, makeSession, SETUP_TOKEN, trustProxyOption } from "./auth.js";
import { BACKUP_DIR, backupNow, cache, CONFIG_DIR, db, dbState, listBackups, listJobs, resetCache, restoreBackup, setJob, startupWarnings } from "./db.js";
import { getDecision, listDecisions, logDecision, markUndone, pruneDecisions } from "./activity.js";
import { fetchReleaseFile, prowlarrConfigured, prowlarrIndexers, testProwlarr } from "./arr/prowlarr.js";
import { radarrConfigured, radarrOptions, radarrRootFolders, testRadarr } from "./arr/radarr.js";
import { sonarrOptions, testSonarr } from "./arr/sonarr.js";
import { testQbit, testSab } from "./arr/clients.js";
import { redactUrl } from "./arr/http.js";
import { gaps, listFacts, missingLanguage, specials, coverFor } from "./audit.js";
import { deleteProfile, listProfiles, profileFor, saveProfile, setSeriesPrefs, seriesPrefs, setMoviePrefs } from "./profiles.js";
import { calendar, deleteEpisodeFiles, episodeDetail, episodeRows, regrabEpisodes, searchAgainSoon, seriesHeader } from "./episodes.js";
import { identify } from "./core/identify.js";
import { compactKey } from "./core/normalize.js";
import { parseRelease } from "./core/parser.js";
import { refreshCovers } from "./covers.js";
import { lastSync, syncLibrary, syncRunning } from "./library.js";
import { backlogSummary, candidates, managePreview, listManaged, managedTick, releaseDryRunDecisions, rssTick, scheduleFor, setManaged, setShowDryRun, unmonitorInSonarr } from "./managed.js";
import { aliasIndex, invalidateIndex, metadataStatus, refreshMetadata } from "./metadata.js";
import { finishGrabByHand, grabDownloadPath, keepGrab, listGrabs, nextForGrab, pipelineTick, recoverGrabs, removeGrab, retryImport, startGrab, type Candidate } from "./pipeline.js";
import { grabHistory, queueView, removeSonarrQueueItem, sonarrQueueProblems } from "./queue.js";
import { recentChecks, repairTick } from "./repair.js";
import { recycleSetting, recycleStatus } from "./recycle.js";
import { upgradeList, upgradeTick } from "./upgrade.js";
import { moviesForSeries, setLink } from "./franchise.js";
import { movieSearchSummary, movieTick, planMovies } from "./movieSearch.js";
import { fileScanTick, fileSummary, lastFolderScan, scanFolder, scanLibrary, scanRunning, libraryRoots } from "./mediafiles.js";
import { autoSearchEpisodes, autoSearchMovie } from "./autosearch.js";
import { scopedEpisodeIds, scopeFor, scopePreview, setScope, validateScope, type Scope } from "./scope.js";
import { addToQueue, editQueue, fillInTick, fillInView } from "./fillin.js";
import { catalogStatus, entriesForSeries, refreshCatalog, tmdbEpisodes } from "./catalog.js";

let catalogRunning = false;
/** Own metadata: AniList catalog (+ TMDB episode titles when a key is set). */
async function catalogTick(force = false) {
  if (catalogRunning) return;
  catalogRunning = true;
  try {
    await refreshCatalog({ force });
    await tmdbEpisodes();
    materializeAll(); // native shows pick up new episodes/titles
  } catch (e) {
    setJob("catalog", "error", (e as Error).message);
  } finally {
    catalogRunning = false;
  }
}
import { listMovies, movieCalendar, movieDetail, searchMovie, setWanted, startMovieGrab } from "./movies.js";
import { applyRenameRouted, browseImport, executeImport, executeMovieImport, planImport, planMovieImport, planRename, renameBack, renamePlan } from "./importer.js";
import { importMediaDefaults, importMediaDefaultsOnce, previewNaming } from "./mediadefaults.js";
import { addMovie, addShow, isNativeSeriesId, materializeAll, NATIVE_BASE, rematerializeSeries, removeMovie, removeShow, searchAdd, seasonPicks } from "./native.js";
import { deepSearch, episodesFor, identifyContext, seriesByTvdb, type SearchProgress, type SearchResult } from "./search.js";
import { checkPassword, getSettings, URL_BASE_RE, isMasked, usingDefaultPassword, patchSettings, publicSettings, regenerateApiKey, safeEqual, setAccount, setBypassLocal, updateSettings, type LanguageProfile, type Settings } from "./settings.js";
import { ROOT_DIR, VERSION } from "./version.js";

// UMASK (like the *arr images): files and folders AnimeArr's importer creates get the usual 775/664 with UMASK=002.
if (/^0?[0-7]{3}$/.test(process.env.UMASK ?? "")) process.umask(parseInt(process.env.UMASK!, 8));

const WEB_DIR = path.join(ROOT_DIR, "dist", "web");
const PORT = Number(process.env.PORT ?? 8484);
const STARTED = Date.now();

/**
 * URL base for a reverse proxy on a sub-path (https://host/animearr/): URL_BASE, or Settings → System (restart).
 * Incoming URLs have it stripped, so every route stays the same; the page gets a <base href> for its assets.
 */
const URL_BASE = (() => {
  const v = (process.env.URL_BASE ?? getSettings().urlBase ?? "").trim().replace(/\/+$/, "").replace(/^(?!\/)(.)/, "/$1");
  if (URL_BASE_RE.test(v)) return v;
  console.warn(`Ignoring the URL base "${v}": use something like /animearr (letters, digits, . _ ~ - only)`);
  return "";
})();
const app = Fastify({
  rewriteUrl: (req) => {
    const u = req.url ?? "/";
    if (!URL_BASE) return u;
    if (u === URL_BASE) return "/";
    return u.startsWith(`${URL_BASE}/`) ? u.slice(URL_BASE.length) : u;
  },
  logger: { level: process.env.LOG_LEVEL ?? "info", serializers: { req: (r) => ({ method: r.method, url: redactUrl(r.url.split("?")[0]), remoteAddress: r.ip }) } },
  trustProxy: trustProxyOption() as string[] | false,
  bodyLimit: 1_000_000,
});
await app.register(fastifyCookie);
// JSON goes out as plain ASCII (non-ASCII as \uXXXX escapes): a client that decodes the body as Latin-1/cp1252 instead
// of UTF-8 (Windows PowerShell 5.1, some proxies and shell pipes) still gets "…" and titles right, never "â€¦".
app.setReplySerializer((payload) => asciiJson(payload));
app.addHook("onRequest", guard);
// Any change to the migration invalidates the cached plan.
app.addHook("onResponse", async (req) => {
  if (req.method === "GET") return;
  const body = (req.body ?? {}) as { tvdbIds?: number[]; tvdbId?: number };
  // Migration actions: only the shows acted on are recomputed (the plan stays on screen).
  if (req.url.startsWith("/api/cutover/")) {
    const ids = [...(body.tvdbIds ?? []), ...(body.tvdbId ? [body.tvdbId] : [])].map(Number).filter(Boolean);
    if (ids.length) refreshCuts(ids);
    else invalidateCutover();
    return;
  }
  // Anything else that changes a show's cut: AniDB overrides/fetches, syncs, scans, adds and removals.
  if (/^\/api\/(series\/\d+\/(anidb|scan)|library\/sync|add\b|media\/scan|files\/rescan)/.test(req.url)) invalidateCutover();
});
// Slow requests are logged (a sync loop blocking the event loop shows up here first).
app.addHook("onResponse", async (req, reply) => {
  const ms = reply.elapsedTime;
  if (ms > 500) console.warn(`[slow] ${req.method} ${req.url.split("?")[0]} ${Math.round(ms)} ms`);
});
app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  app.log.warn(redactUrl(err.message));
  reply.code(err.statusCode && err.statusCode >= 400 ? err.statusCode : 500).send({ error: redactUrl(err.message), fixes: fixesFor(err.message) });
});

const fail = (msg: string, code = 400) => Object.assign(new Error(msg), { statusCode: code });
const id = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw fail("Bad id");
  return n;
};
const writable = () => {
  if (dbState.corrupt) throw fail("The database failed its integrity check, so AnimeArr is read-only. Restore a backup in System → Backups.", 503);
};

/** Outbound service URLs: http(s) only, never link-local / cloud metadata addresses. */
function checkOutbound(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw fail("That address isn't a valid URL (it should start with http://)");
  }
  if (!/^https?:$/.test(u.protocol)) throw fail("Address must start with http:// or https://");
  if (/^(169\.254\.|0\.|\[?fe80:)/i.test(u.hostname) || u.hostname === "metadata.google.internal") throw fail("That address isn't allowed");
  return url;
}

/** A stored secret is only re-used for the URL it was saved with, so it can't be sent somewhere new. */
function withSecret(url: unknown, secret: unknown, storedUrl: string, storedSecret: string, required = true) {
  const u = checkOutbound(String(url || storedUrl).trim().replace(/\/+$/, ""));
  const s = String(secret ?? "");
  if (s && !isMasked(s)) return { url: u, secret: s };
  if (u === storedUrl && storedSecret) return { url: u, secret: storedSecret };
  if (!required) return { url: u, secret: "" };
  throw fail("Enter the API key again for a new address");
}

function sessionCookie(req: FastifyRequest, reply: FastifyReply, username: string) {
  reply.setCookie(COOKIE, makeSession(username), { path: "/", httpOnly: true, sameSite: "strict", secure: req.protocol === "https", maxAge: 30 * 86400 });
}

// ---------------------------------------------------------------- status & account

app.get("/ping", async () => ({ status: "OK" }));

app.get("/api/status", { config: { setup: true } }, async (req) => {
  const s = getSettings();
  const a = authState(req);
  const base = { version: VERSION, build: webBuild(), setupRequired: a.setupRequired, loggedIn: a.ok };
  if (!a.ok) return base;
  return {
    ...base,
    via: a.via,
    connected: { sonarr: !!(s.sonarr.url && s.sonarr.apiKey), radarr: !!(s.radarr.url && s.radarr.apiKey), prowlarr: !!(s.prowlarr.url && s.prowlarr.apiKey), sabnzbd: !!(s.sabnzbd.url && s.sabnzbd.apiKey), qbittorrent: !!s.qbittorrent.url },
    dryRun: s.managed.dryRun,
    grabsPaused: (() => {
      const d = downloadsStatus();
      if (!d.why) return null;
      const disk = d.measure?.disk;
      return { why: d.why, disk: disk ? { freeGb: Math.round(disk.freeGb), animearrGb: Math.round(disk.animearrGb), otherGb: Math.round(disk.otherGb), label: disk.label, shareFreeGb: disk.share ? Math.round(disk.share.freeGb) : null } : null, diskRule: d.rules.some((r) => r.id === "free-space" && r.paused) };
    })(),
    allowedRoots: s.allowedRoots,
    lastSync: lastSync(),
    syncing: syncRunning(),
    managed: listManaged().length,
    librarySeries: (cache.prepare("SELECT COUNT(*) AS n FROM series").get() as { n: number }).n,
    warnings: [...startupWarnings, ...(dbState.corrupt ? [`The database failed its integrity check (${dbState.detail}). AnimeArr is read-only until you restore a backup (System → Backups).`] : [])],
    uiLanguage: s.ui.language,
    textScale: s.ui.textScale ?? null,
    // LAN sessions without a login (bypassLocal) don't need the nag; the default password only matters off the LAN.
    defaultPassword: a.via === "local" ? false : await usingDefaultPassword(),
    // Shows in dry-run (the global switch, or their own), so the UI only mentions dry-run when something is in it.
    dryRunShows: listManaged().filter((m) => m.dryRun).map((m) => ({ tvdbId: m.tvdbId, title: m.title })),
    bypassLocal: s.auth.bypassLocal,
    wizardDone: wizardState().done,
    freshInstall: !wizardState().done && !s.sonarr.url && !s.radarr.url && !s.prowlarr.url && !s.sabnzbd.url && !s.qbittorrent.url && !(s.extraClients ?? []).length && !(s.indexers ?? []).length,
    // The season card: shows with an episode airing this week or last.
    airingShows: airingShowCount(),
    // The nav's Queue badge: what's downloading, and what needs a look.
    queue: db.prepare("SELECT COALESCE(SUM(state IN ('sending', 'downloading', 'importing')), 0) AS active, COALESCE(SUM(state = 'needs-attention'), 0) AS attention FROM grabs WHERE dry_run = 0").get() as { active: number; attention: number },
  };
});

let settingUp = false;
app.post<{ Body: { username?: string; password?: string; bypassLocal?: boolean; setupToken?: string } }>("/api/auth/setup", { config: { setup: true } }, async (req, reply) => {
  writable();
  if (getSettings().auth.passwordHash || settingUp) throw fail("Account already exists", 409);
  if (!csrfOk(req)) throw fail("Cross-site request blocked", 403);
  const local = isLocalRequest(req) && hostAllowed(req);
  if (!local && !safeEqual(String(req.body?.setupToken ?? ""), SETUP_TOKEN)) throw fail("Open AnimeArr from your home network to create the account, or enter the setup code from the log", 403);
  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (!username || password.length < 8) throw fail("Choose a username and a password of at least 8 characters");
  settingUp = true;
  try {
    await setAccount(username, password);
    patchSettings((s) => ({ ...s, auth: { ...s.auth, bypassLocal: req.body?.bypassLocal === true } }));
  } finally {
    settingUp = false;
  }
  sessionCookie(req, reply, username);
  return { ok: true };
});

app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", { config: { setup: true } }, async (req, reply) => {
  if (!csrfOk(req)) throw fail("Cross-site request blocked", 403);
  if (!loginAllowed(req.ip, String(req.body?.username ?? ""))) throw fail("Too many attempts, wait a few seconds and try again", 429);
  const a = getSettings().auth;
  const okUser = safeEqual(String(req.body?.username ?? ""), a.username);
  const okPass = await checkPassword(String(req.body?.password ?? ""), a.passwordHash || "00:00");
  if (!okUser || !okPass) throw fail("Wrong username or password", 401);
  loginSucceeded(req.ip, a.username);
  sessionCookie(req, reply, a.username);
  return { ok: true };
});

app.post("/api/auth/logout", async (_req, reply) => {
  reply.clearCookie(COOKIE, { path: "/" });
  return { ok: true };
});

app.put<{ Body: { currentPassword?: string; username?: string; password?: string } }>("/api/auth/account", async (req, reply) => {
  writable();
  const a = getSettings().auth;
  if (!loginAllowed(req.ip, a.username)) throw fail("Too many attempts, wait a few seconds and try again", 429);
  if (!(await checkPassword(String(req.body?.currentPassword ?? ""), a.passwordHash))) throw fail("Current password is wrong", 403);
  loginSucceeded(req.ip, a.username);
  const username = String(req.body?.username ?? a.username).trim() || a.username;
  const password = String(req.body?.password ?? "");
  if (password && password.length < 8) throw fail("New password must be at least 8 characters");
  if (password) await setAccount(username, password);
  else patchSettings((s) => ({ ...s, auth: { ...s.auth, username } }));
  sessionCookie(req, reply, username);
  return { ok: true };
});

app.put<{ Body: { bypassLocal?: boolean } }>("/api/auth/mode", async (req) => {
  writable();
  if (authState(req).via !== "session") throw fail("Log in with your password to change this", 403);
  setBypassLocal(req.body?.bypassLocal === true);
  return { ok: true };
});

// ---------------------------------------------------------------- settings & connection tests

app.get("/api/settings", async () => publicSettings());
app.put<{ Body: Partial<Settings> }>("/api/settings", async (req) => {
  writable();
  const before = getSettings();
  const next = updateSettings(req.body);
  if (JSON.stringify(before.downloads) !== JSON.stringify(next.downloads)) reevaluate(); // rule edits apply at once
  if (before.managed.dryRun !== next.managed.dryRun) {
    logDecision("info", { why: next.managed.dryRun ? "Global dry-run turned ON: nothing will be grabbed" : "Global dry-run turned OFF: shows whose own dry-run is off will be grabbed for real" });
    if (!next.managed.dryRun) for (const m of listManaged()) if (!m.dryRun) releaseDryRunDecisions(m.tvdbId);
  }
  if (before.allowedRoots.join("|") !== next.allowedRoots.join("|")) logDecision("info", { why: `Allowed root folders: ${next.allowedRoots.join(", ") || "none"}` });
  invalidateIndex();
  return publicSettings();
});
app.get("/api/settings/apikey", async (req) => ({ apiKey: authState(req).via === "session" ? getSettings().apiKey : null }));
app.post("/api/settings/apikey/regenerate", async (req) => {
  writable();
  if (authState(req).via !== "session") throw fail("Log in to manage the API key", 403);
  return { apiKey: regenerateApiKey() };
});

type TestBody = { url?: string; apiKey?: string; username?: string; password?: string; category?: string };

/** Settings → Metadata: TMDB key/token test (the saved one when the field still shows the mask). */
app.post<{ Body: { key?: string } }>("/api/test/tmdb", async (req) => {
  const k = String(req.body?.key ?? "");
  const key = !k || isMasked(k) ? getSettings().metadata.tmdbKey : k;
  if (!key) throw fail("Enter a TMDB API key or Read Access Token", 400);
  return testTmdb(key);
});
/** Poster thumbnails (see server/img.ts): the provider's smaller rendition, cached on disk, cached by browsers for a year. */
app.get<{ Querystring: { u?: string; s?: string } }>("/api/img", async (req, reply) => {
  const size = (["sm", "md", "lg", "xl"].includes(req.query.s ?? "") ? req.query.s : "md") as ThumbSize;
  const r = await thumb(String(req.query.u ?? ""), size);
  if (!r) return reply.code(404).send({ error: "No such image" });
  if (req.headers["if-none-match"] === r.etag) return reply.code(304).send();
  reply.header("Cache-Control", "private, max-age=31536000, immutable").header("ETag", r.etag).header("X-Content-Type-Options", "nosniff").header("Content-Security-Policy", "sandbox; default-src 'none'").type(r.type);
  return reply.send(fs.createReadStream(r.file));
});

app.get<{ Querystring: { from?: string; managed?: string } }>("/api/home", async (req) => homeSummary(Date.now(), Number(req.query.from) || undefined, req.query.managed === "1"));

// ---------------------------------------------------------------- indexers & download clients (Settings cards)
app.get("/api/catalog/indexers", async () => indexerCatalog());
// ---------------------------------------------------------------- dropped shows
app.get("/api/dropped", async () => droppedList());
app.post<{ Params: { tvdbId: string }; Body: { why?: string; unmonitor?: boolean } }>("/api/series/:tvdbId/drop", async (req) => {
  writable();
  const t = id(req.params.tvdbId);
  if (!t) throw fail("Unknown show", 400);
  return dropShow(t, { why: String(req.body?.why ?? ""), unmonitor: req.body?.unmonitor === true });
});
app.delete<{ Params: { tvdbId: string } }>("/api/series/:tvdbId/drop", async (req) => (writable(), undropShow(id(req.params.tvdbId))));
// ---------------------------------------------------------------- indexer circuit breaker
const breakerDeps = {
  fetch: (r: Parameters<Fetcher>[0]) => fetchReleaseFile({ guid: r.guid, title: r.title, size: r.size ?? 0, indexerId: r.indexerId, indexer: r.indexer, protocol: r.protocol, downloadUrl: r.downloadUrl ?? undefined, magnetUrl: r.magnetUrl ?? undefined }),
  search: async (indexerId: number) => {
    const ix = (getSettings().indexers ?? []).find((x) => indexerNumId(x.id) === indexerId);
    if (!ix) return false;
    await searchIndexer(ix, ix.kind === "rss" ? "anime" : "", { limit: 5 });
    return true;
  },
};
app.get("/api/indexers/breaker", async () => breakerList());
// ---------------------------------------------------------------- "Open on your phone": the addresses a phone can use
app.get("/api/phone", async () => {
  // Home-network addresses first; container bridges, VPNs and virtual adapters aren't what a phone can reach.
  const rank = (ip: string) => (ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  const lan = Object.entries(os.networkInterfaces())
    .filter(([name]) => !/^(docker|br-|veth|vethernet|virbr|tailscale|zt|utun|wg)/i.test(name))
    .flatMap(([, list]) => list ?? [])
    .filter((n) => n.family === "IPv4" && !n.internal)
    .map((n) => n.address)
    .sort((a, b) => rank(a) - rank(b))
    .map((ip) => `http://${ip}:${PORT}`);
  return { externalUrl: getSettings().externalUrl ?? "", lan, bypassLocal: getSettings().auth.bypassLocal };
});
app.post<{ Params: { id: string }; Body: { use?: boolean } }>("/api/indexers/prowlarr/:id/use", async (req) => {
  writable();
  const ixId = id(req.params.id);
  if (!ixId) throw fail("Unknown indexer", 400);
  const r = await setIndexerUse(ixId, req.body?.use !== false);
  invalidateConnections();
  return r;
});
app.post<{ Params: { id: string }; Body: { action?: string } }>("/api/indexers/breaker/:id", async (req) => {
  writable();
  const ixId = id(req.params.id);
  if (!ixId) throw fail("Unknown indexer", 400);
  const known = [...(prowlarrConfigured() ? (await prowlarrIndexers()).map((x) => x.id) : []), ...(getSettings().indexers ?? []).map((x) => indexerNumId(x.id))];
  if (!known.includes(ixId)) throw fail("Unknown indexer", 404);
  const action = req.body?.action;
  if (action === "test") return retestIndexer(ixId, breakerDeps, Date.now(), true);
  if (action === "on" || action === "keep-off") return (setBreaker(ixId, action), { ok: true });
  throw fail("action must be test, on or keep-off", 400);
});
// ---------------------------------------------------------------- one file: watch in…, fix detection, peek
/** Only files inside AnimeArr's library folders. */
const libraryFile = (p: unknown) => {
  const s = String(p ?? "");
  const clean = s.startsWith("/") && !s.includes("\\") && !s.split("/").some((seg) => seg === ".." || seg === ".") && path.posix.normalize(s) === s;
  if (!clean || !libraryRoots().some((r) => s.startsWith(`${r.replace(/\/+$/, "")}/`))) throw fail("That file isn't in a library folder", 400);
  return s;
};
app.get<{ Querystring: { path?: string; title?: string; kind?: string } }>("/api/watch", async (req) => watchLinks(libraryFile(req.query.path), String(req.query.title ?? ""), req.query.kind === "movie" ? "movie" : "episode"));
app.get<{ Querystring: { path?: string } }>("/api/files/detail", async (req) => fileDetail(libraryFile(req.query.path)));
app.post<{ Body: Record<string, unknown> }>("/api/files/track", async (req) => {
  writable();
  const b = req.body ?? {};
  return setTrackLanguage({ path: libraryFile(b.path), trackIndex: Number(b.trackIndex), lang: b.lang ? String(b.lang) : null, forced: b.forced === true, scope: b.scope === "season" || b.scope === "group" ? b.scope : "file", tvdbId: b.tvdbId ? Number(b.tvdbId) : null, season: b.season !== undefined && b.season !== null ? Number(b.season) : null, group: b.group ? String(b.group) : null, title: b.title ? String(b.title) : undefined, alsoTag: b.alsoTag === true });
});
app.post<{ Body: Record<string, unknown> }>("/api/files/sidecar", async (req) => {
  writable();
  const b = req.body ?? {};
  return useSidecar({ video: libraryFile(b.video), file: String(b.file ?? ""), lang: String(b.lang ?? "en"), tvdbId: b.tvdbId ? Number(b.tvdbId) : null, title: b.title ? String(b.title) : undefined });
});
app.post<{ Body: { path?: string } }>("/api/files/rescan", async (req) => (writable(), rescanOne(libraryFile(req.body?.path))));
app.get<{ Querystring: { path?: string } }>("/api/files/peek", async (req) => ({ frames: await peekFrames(libraryFile(req.query.path), null) }));
// ---------------------------------------------------------------- setup wizard
app.get("/api/wizard", async () => wizardState());
app.put<{ Body: Record<string, unknown> }>("/api/wizard", async (req) => (writable(), saveWizard(req.body ?? {})));
app.get<{ Querystring: { path?: string } }>("/api/fs/folders", async (req) => listFolders(String(req.query.path ?? "/")));
app.post<{ Body: { client?: string } }>("/api/wizard/category", async (req) => (writable(), createCategory(req.body?.client === "qbittorrent" ? "qbittorrent" : "sabnzbd")));
app.get("/api/wizard/arr-preview", async () => arrPreview());
app.post<{ Body: { roots?: string[]; sab?: { url: string; category: string } | null; qbit?: { url: string; category: string } | null; others?: { type: string; name?: string; url: string }[] } }>("/api/wizard/arr-apply", async (req) => (writable(), invalidateConnections(), applyArrPreview(req.body ?? {})));
app.get("/api/indexers", async () => ({ indexers: listIndexers() }));
app.post<{ Body: Record<string, unknown> }>("/api/indexers", async (req) => (writable(), invalidateConnections(), saveIndexer(null, req.body ?? {})));
app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/indexers/:id", async (req) => (writable(), invalidateConnections(), saveIndexer(req.params.id, req.body ?? {})));
app.delete<{ Params: { id: string } }>("/api/indexers/:id", async (req) => (writable(), invalidateConnections(), deleteIndexer(req.params.id), { ok: true }));
app.post<{ Body: Record<string, unknown> }>("/api/indexers/test", async (req) => testIndexer(req.body ?? {}));
app.post<{ Body: Record<string, unknown> }>("/api/jackett/trackers", async (req) => ({ trackers: await jackettTrackers(req.body ?? {}) }));
app.post<{ Body: Record<string, unknown> }>("/api/jackett/add", async (req) => (writable(), invalidateConnections(), addJackettTracker(req.body ?? {})));
app.get("/api/clients", async () => ({ clients: listClients() }));
app.post<{ Body: Record<string, unknown> }>("/api/clients", async (req) => (writable(), invalidateConnections(), saveClient(null, req.body ?? {})));
app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/clients/:id", async (req) => (writable(), invalidateConnections(), saveClient(req.params.id, req.body ?? {})));
app.delete<{ Params: { id: string } }>("/api/clients/:id", async (req) => (writable(), invalidateConnections(), deleteClient(req.params.id), { ok: true }));
app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/clients/:id/prefs", async (req) => (writable(), invalidateConnections(), setClientPrefs(req.params.id, req.body ?? {})));
app.post<{ Body: Record<string, unknown> }>("/api/clients/test", async (req) => testExtraClient(req.body ?? {}));

app.get<{ Querystring: { fresh?: string } }>("/api/connections", async (req) => connectionsOverview(req.query.fresh === "1"));

app.post<{ Params: { service: string }; Body: TestBody }>("/api/test/:service", async (req) => {
  const s = getSettings();
  const b = req.body ?? {};
  switch (req.params.service) {
    case "sonarr": {
      const c = withSecret(b.url, b.apiKey, s.sonarr.url, s.sonarr.apiKey);
      const conn = { url: c.url, apiKey: c.secret };
      return { ...(await testSonarr(conn)), options: await sonarrOptions(conn) };
    }
    case "radarr": {
      const c = withSecret(b.url, b.apiKey, s.radarr.url, s.radarr.apiKey);
      const conn = { url: c.url, apiKey: c.secret };
      return { ...(await testRadarr(conn)), options: await radarrOptions(conn) };
    }
    case "prowlarr": {
      const c = withSecret(b.url, b.apiKey, s.prowlarr.url, s.prowlarr.apiKey);
      return testProwlarr({ url: c.url, apiKey: c.secret });
    }
    case "sabnzbd": {
      const c = withSecret(b.url, b.apiKey, s.sabnzbd.url, s.sabnzbd.apiKey);
      return testSab({ url: c.url, apiKey: c.secret, category: String(b.category || s.sabnzbd.category) });
    }
    case "plex": {
      const c = withSecret(b.url, b.apiKey, s.plex.url, s.plex.token);
      return testPlex({ url: c.url, token: c.secret });
    }
    case "qbittorrent": {
      const c = withSecret(b.url, b.password, s.qbittorrent.url, s.qbittorrent.password, false);
      return testQbit({ url: c.url, username: String(b.username ?? s.qbittorrent.username), password: c.secret, category: String(b.category || s.qbittorrent.category) });
    }
  }
  throw fail("Unknown service", 404);
});

/** Sonarr root folders, for the "allowed root folders" picker (suggests /media/AnimeArr when present; never auto-enabled). */
app.get("/api/sonarr/rootfolders", async () => {
  const o = await sonarrOptions().catch(() => ({ roots: [] as { id: number; path: string; freeSpace?: number }[] }));
  // Radarr's root folders too (movies), when Radarr is set up.
  const movieRoots = radarrConfigured() ? await radarrRootFolders().catch(() => []) : [];
  const roots = [...o.roots.map((r) => ({ ...r, app: "sonarr" })), ...movieRoots.filter((r) => !o.roots.some((x) => x.path === r.path)).map((r) => ({ id: r.id, path: r.path, freeSpace: r.freeSpace, app: "radarr" }))];
  return { roots, suggested: o.roots.find((r) => /\/AnimeArr\/?$/i.test(r.path))?.path ?? null, allowed: getSettings().allowedRoots };
});

// ---------------------------------------------------------------- library import / sync, managed shows

app.post<{ Body: { full?: boolean } }>("/api/library/sync", async (req) => {
  writable();
  void syncLibrary(req.body?.full === true).then(() => refreshCovers()).catch(() => undefined);
  return { started: true };
});
app.get("/api/library/candidates", async () => candidates());
app.get<{ Querystring: { q?: string } }>("/api/series", async (req) => {
  const q = compactKey(String(req.query.q ?? ""));
  const rows = cache.prepare("SELECT tvdb_id, title, poster, status, year FROM series ORDER BY sort_title").all() as { tvdb_id: number; title: string; poster: string | null; status: string; year: number | null }[];
  const alt = q ? new Set((cache.prepare("SELECT s.tvdb_id FROM alt_titles a JOIN series s ON s.id = a.series_id WHERE a.key LIKE ?").all(`%${q}%`) as { tvdb_id: number }[]).map((r) => r.tvdb_id)) : null;
  return rows.filter((r) => !q || compactKey(r.title).includes(q) || alt?.has(r.tvdb_id)).slice(0, 50).map((r) => ({ tvdbId: r.tvdb_id, title: r.title, status: r.status, year: r.year, cover: coverFor(r) }));
});
app.get<{ Params: { tvdbId: string } }>("/api/series/:tvdbId", async (req) => {
  const tvdbId = id(req.params.tvdbId);
  const s = seriesByTvdb(tvdbId);
  if (!s) throw fail("Not in the synced library", 404);
  const eps = episodesFor(tvdbId).sort((a, b) => a.season - b.season || a.episode - b.episode);
  // Opening a series page re-checks its folder in the background (at most every 10 minutes).
  if (getSettings().library.scan && Date.now() - lastFolderScan(s.path) > 10 * 60_000) void scanFolder(s.path).then(() => isNativeSeriesId(s.id) && rematerializeSeries(s.id)).catch(() => undefined);
  const idx = aliasIndex();
  return {
    ...s,
    managed: listManaged().find((m) => m.tvdbId === tvdbId) ?? null,
    episodes: eps,
    anidb: idx.anidbIdsFor(tvdbId).map((x) => ({ ...x, title: idx.anidbTitle(x.aid) })),
    aliases: (db.prepare("SELECT id, title, season, source FROM aliases WHERE tvdb_id = ? ORDER BY id").all(tvdbId) as { id: number; title: string; season: number | null; source: string }[]),
    rules: db.prepare("SELECT id, grp, mode, season, offset, note FROM rules WHERE tvdb_id = ? ORDER BY id").all(tvdbId),
    facts: listFacts(tvdbId),
    schedule: scheduleFor(tvdbId),
    header: seriesHeader(tvdbId),
    prefs: seriesPrefs(tvdbId),
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
app.put<{ Params: { tvdbId: string }; Body: { profileId?: string | null; watchMode?: string | null; sizePreset?: string | null } }>("/api/series/:tvdbId/prefs", async (req) => {
  writable();
  const tvdbId = id(req.params.tvdbId);
  if (!seriesByTvdb(tvdbId)) throw fail("Unknown series", 404);
  return setSeriesPrefs(tvdbId, req.body?.profileId || null, (req.body?.watchMode || null) as Parameters<typeof setSeriesPrefs>[2], req.body?.sizePreset === undefined ? undefined : ((req.body.sizePreset || null) as Parameters<typeof setSeriesPrefs>[3]));
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
  if (!listManaged().some((m) => m.tvdbId === tvdbId)) throw fail("Only managed shows have a search schedule; use Deep Search instead", 409);
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

app.post<{ Body: { tvdbIds?: number[]; on?: boolean; live?: boolean } }>("/api/managed", async (req) => {
  writable();
  const ids = (req.body?.tvdbIds ?? []).map(id).slice(0, 500);
  return setManaged(ids, req.body?.on !== false, { live: req.body?.live === true });
});
app.post<{ Body: { tvdbIds?: number[] } }>("/api/managed/preview", async (req) => managePreview((req.body?.tvdbIds ?? []).map(id).slice(0, 500)));
app.get("/api/managed", async () => ({ dryRun: getSettings().managed.dryRun, shows: listManaged().map((m) => ({ ...m, cover: seriesByTvdb(m.tvdbId)?.cover ?? null, schedule: scheduleFor(m.tvdbId, 6) })), grabs: listGrabs(30, { episodesOnly: true }) }));
app.put<{ Params: { tvdbId: string }; Body: { dryRun?: boolean } }>("/api/managed/:tvdbId", async (req) => {
  writable();
  if (typeof req.body?.dryRun !== "boolean") throw fail("dryRun must be true or false");
  setShowDryRun(id(req.params.tvdbId), req.body.dryRun);
  return { ok: true };
});
app.post<{ Params: { tvdbId: string }; Body: { monitored?: boolean; confirm?: boolean } }>("/api/managed/:tvdbId/sonarr-monitor", async (req) => {
  writable();
  if (req.body?.confirm !== true) throw fail("Confirm first");
  await unmonitorInSonarr(id(req.params.tvdbId), req.body?.monitored === true);
  return { ok: true };
});
app.post("/api/managed/run", async () => {
  void managedTick().catch((e) => app.log.warn(e.message));
  return { started: true };
});

// ---------------------------------------------------------------- audits (read-only)

app.get<{ Querystring: { sidecars?: string } }>("/api/audit/language", async (req) => missingLanguage({ checkSidecars: req.query.sidecars === "1" }));
app.get("/api/audit/gaps", async () => gaps());
app.get("/api/audit/specials", async () => specials());

// ---------------------------------------------------------------- facts, aliases, numbering rules (user data)

app.post<{ Body: { tvdbId?: number; season?: number | null; kind?: string; lang?: string; note?: string } }>("/api/facts", async (req) => {
  writable();
  const tvdbId = id(req.body?.tvdbId);
  const s = seriesByTvdb(tvdbId);
  if (!s) throw fail("Unknown series", 404);
  const kind = req.body?.kind === "no_release" ? "no_release" : "burned_in";
  const season = req.body?.season === null || req.body?.season === undefined ? null : Number(req.body.season);
  const lang = String(req.body?.lang ?? profileFor(tvdbId).subLangs[0] ?? "en").slice(0, 10);
  const note = String(req.body?.note ?? "").slice(0, 200);
  const r = db.prepare("INSERT INTO facts (tvdb_id, season, kind, lang, note, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET note = excluded.note, at = excluded.at RETURNING id").get(tvdbId, season, kind, lang, note, Date.now()) as { id: number };
  logDecision("fact", { tvdbId, title: s.title, why: `You confirmed: ${s.title}${season !== null ? ` season ${season}` : ""} ${kind === "burned_in" ? `has burned-in ${lang} subtitles` : "has no release in your language"}${note ? ` (${note})` : ""}`, undo: { action: "delete-fact", args: { id: r.id } } });
  return { ok: true };
});
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
  const title = String(req.body?.title ?? "").trim().slice(0, 200);
  const key = compactKey(title);
  if (!key) throw fail("Type the alias");
  const season = req.body?.season === null || req.body?.season === undefined || (req.body.season as unknown) === "" ? null : Number(req.body.season);
  const r = db.prepare("INSERT INTO aliases (key, title, tvdb_id, season, source, created_at) VALUES (?, ?, ?, ?, 'user', ?) ON CONFLICT DO NOTHING").run(key, title, tvdbId, season, Date.now());
  invalidateIndex();
  if (r.changes) logDecision("alias", { tvdbId, title: s.title, why: `Alias "${title}" → ${s.title}${season !== null ? ` season ${season}` : ""}`, undo: { action: "delete-alias", args: { id: Number(r.lastInsertRowid) } } });
  return { ok: true };
});
app.delete<{ Params: { id: string } }>("/api/aliases/:id", async (req) => {
  writable();
  db.prepare("DELETE FROM aliases WHERE id = ?").run(id(req.params.id));
  invalidateIndex();
  return { ok: true };
});

app.post<{ Body: { tvdbId?: number; group?: string; mode?: string; season?: number | null; offset?: number; note?: string } }>("/api/rules", async (req) => {
  writable();
  const tvdbId = id(req.body?.tvdbId);
  const s = seriesByTvdb(tvdbId);
  if (!s) throw fail("Unknown series", 404);
  const mode = ["auto", "absolute", "season", "offset"].find((m) => m === req.body?.mode);
  if (!mode) throw fail("Pick a numbering mode");
  const season = req.body?.season === null || req.body?.season === undefined ? null : Number(req.body.season);
  if ((mode === "season" || mode === "offset") && (season === null || !Number.isInteger(season))) throw fail("Pick the season");
  const group = String(req.body?.group ?? "").trim().slice(0, 60) || null;
  const offset = Math.trunc(Number(req.body?.offset ?? 0)) || 0;
  const r = db.prepare("INSERT INTO rules (tvdb_id, grp, mode, season, offset, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(tvdbId, group, mode, season, offset, String(req.body?.note ?? "").slice(0, 200), Date.now());
  logDecision("rule", { tvdbId, title: s.title, why: `Numbering rule for ${s.title}${group ? ` (${group} only)` : ""}: ${mode}${season !== null ? ` season ${season}` : ""}${offset ? ` offset ${offset}` : ""}`, undo: { action: "delete-rule", args: { id: Number(r.lastInsertRowid) } } });
  return { ok: true };
});
app.delete<{ Params: { id: string } }>("/api/rules/:id", async (req) => {
  writable();
  db.prepare("DELETE FROM rules WHERE id = ?").run(id(req.params.id));
  return { ok: true };
});

// ---------------------------------------------------------------- identify, deep search, grab

app.post<{ Body: { name?: string; tvdbId?: number } }>("/api/identify", async (req) => {
  const name = String(req.body?.name ?? "").slice(0, 400);
  if (!name.trim()) throw fail("Paste a release name");
  const r = identify(name, identifyContext(), { tvdbId: req.body?.tvdbId ? id(req.body.tvdbId) : undefined });
  return {
    parsed: { ...r.parsed, raw: undefined },
    summary: r.summary,
    series: r.candidate ? seriesByTvdb(r.candidate.tvdbId) : null,
    mapping: r.resolution ? { ok: r.resolution.ok, label: r.resolution.label, confidence: r.resolution.confidence, method: r.resolution.method, why: r.resolution.why, episodeIds: r.resolution.episodes.map((e) => e.id) } : null,
    others: r.others,
  };
});

/** Search results are kept server-side for 30 minutes so a grab can only use a release Prowlarr actually returned. */
const lastResults = new Map<string, { at: number; tvdbId: number; episodeIds: number[]; results: SearchResult[] }>();
const searchKey = (tvdbId: number, eps: number[]) => `${tvdbId}:${[...eps].sort((a, b) => a - b).join(",")}`;

const publicResults = (rs: SearchResult[]) => rs.map(({ downloadUrl: _d, magnetUrl: _m, ...x }) => x);

/** Runs a Deep Search, keeps its results for grabbing, and logs it. */
async function runSearch(tvdbId: number, eps: number[], full: boolean, onProgress?: (p: SearchProgress) => void) {
  const r = await deepSearch(tvdbId, eps, { full, onProgress });
  for (const [k, v] of lastResults) if (Date.now() - v.at > 30 * 60_000) lastResults.delete(k);
  lastResults.set(searchKey(tvdbId, eps), { at: Date.now(), tvdbId, episodeIds: eps, results: r.results });
  logDecision("search", { tvdbId, title: r.series.title, episodeIds: eps, why: `Deep Search: ${r.queries.length} queries (${r.tier === 1 ? "quick" : "wide"} search, ${Math.round(r.tookMs / 100) / 10} s), ${r.found} releases, ${r.matched} for these episodes, ${r.results.filter((x) => x.rank.accept).length} acceptable` });
  return { ...r, results: publicResults(r.results), dryRun: getSettings().managed.dryRun };
}

const searchBody = (b: { tvdbId?: number; episodeIds?: number[]; full?: boolean } | undefined) => ({ tvdbId: id(b?.tvdbId), eps: (b?.episodeIds ?? []).map(id).slice(0, 50), full: b?.full === true });

/** Blocking search (scripts, acceptance tests). */
app.post<{ Body: { tvdbId?: number; episodeIds?: number[]; full?: boolean } }>("/api/search", async (req) => {
  const { tvdbId, eps, full } = searchBody(req.body);
  return runSearch(tvdbId, eps, full);
});

/** Search as a job the UI polls: progress ("searched X of Y") and partial results while it runs. */
interface SearchJob { at: number; done: boolean; progress: { searched: number; total: number; tier: number; found: number }; partial: ReturnType<typeof publicResults>; result: Awaited<ReturnType<typeof runSearch>> | null; error: string | null }
const searchJobs = new Map<string, SearchJob>();
app.post<{ Body: { tvdbId?: number; episodeIds?: number[]; full?: boolean } }>("/api/search/start", async (req) => {
  const { tvdbId, eps, full } = searchBody(req.body);
  if (!seriesByTvdb(tvdbId)) throw fail("That series isn't in the synced library; run Sync first", 404);
  for (const [k, v] of searchJobs) if (Date.now() - v.at > 15 * 60_000) searchJobs.delete(k);
  const jobId = crypto.randomUUID();
  const job: SearchJob = { at: Date.now(), done: false, progress: { searched: 0, total: 0, tier: 1, found: 0 }, partial: [], result: null, error: null };
  searchJobs.set(jobId, job);
  void runSearch(tvdbId, eps, full, (p) => {
    job.progress = { searched: p.searched, total: p.total, tier: p.tier, found: p.found };
    job.partial = publicResults(p.results);
  })
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

app.post<{ Body: { tvdbId?: number; episodeIds?: number[]; guid?: string; confirm?: boolean; replace?: boolean } }>("/api/grab", async (req) => {
  writable();
  if (req.body?.confirm !== true) throw fail("Confirm the grab first");
  const tvdbId = id(req.body?.tvdbId);
  const eps = (req.body?.episodeIds ?? []).map(id);
  const cached = lastResults.get(searchKey(tvdbId, eps));
  if (!cached) throw fail("Search again first (results expire after 30 minutes)", 409);
  const pick = cached.results.find((r) => r.guid === req.body?.guid);
  if (!pick) throw fail("That release isn't in the last search results", 404);
  const toCand = (r: SearchResult): Candidate => ({ guid: r.guid, title: r.title, indexerId: r.indexerId, indexer: r.indexer, protocol: r.protocol, size: r.size, downloadUrl: r.downloadUrl, magnetUrl: r.magnetUrl, label: r.label, group: r.group, why: r.rank.why, episodeIds: r.episodeIds });
  const fallbacks = cached.results.filter((r) => r !== pick && r.rank.accept && r.coversTarget).map(toCand);
  // Replace season: only season packs as fallbacks (a single episode can't replace a season).
  if (req.body?.replace === true && pick.episodeIds.length < 2) throw fail("Replace season needs a season pack (this release has one episode)", 400);
  if (req.body?.replace === true) return startGrab({ tvdbId, episodeIds: eps, candidate: toCand(pick), fallbacks: fallbacks.filter((f) => f.episodeIds.length > 1), origin: "manual", purpose: "replace" });
  return startGrab({ tvdbId, episodeIds: eps, candidate: toCand(pick), fallbacks, origin: "manual" });
});
/** Replace season: what would be replaced, and why (for the confirm). */
app.get<{ Params: { tvdbId: string }; Querystring: { season?: string } }>("/api/series/:tvdbId/replace-season", async (req) => {
  const season = Number(req.query.season ?? 1);
  if (!Number.isInteger(season) || season < 0) throw fail("Pick a season", 400);
  return replaceSeasonPreview(id(req.params.tvdbId), season);
});
app.get("/api/grabs", async () => listGrabs(100));
app.get("/api/backlog", async () => backlogSummary());
app.get("/api/upgrades", async () => upgradeList());
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
  return { actions: p.actions, measure: { byScope: p.measure.byScope, disk: p.measure.disk, errors: p.measure.errors }, allowDelete: getSettings().downloads.allowDelete };
});
app.post<{ Body: { only?: string[] } }>("/api/downloads/cleanup/run", async (req) => {
  writable();
  if (getSettings().downloads.cleanup === "off") throw fail("The clean-up is switched off (Settings → Downloads)", 409);
  const steps = ["retry", "leftover", "quarantine"] as const;
  const only = req.body?.only?.filter((x): x is (typeof steps)[number] => (steps as readonly string[]).includes(x));
  return { results: await runCleanup({ only, userAsked: true }) };
});
app.put<{ Body: { allowDelete?: boolean } }>("/api/downloads/allow-delete", async (req) => {
  writable();
  const on = req.body?.allowDelete === true;
  patchSettings((x) => ({ ...x, downloads: { ...x.downloads, allowDelete: on } }));
  logDecision("info", { why: on ? "Download clean-up may now delete (leftovers, junk, finished torrents in AnimeArr's own folders)" : "Download clean-up deletions switched off" });
  return getSettings().downloads;
});

// ---------------------------------------------------------------- notifications (bell + test)

app.get("/api/notifications", async () => bell());
app.post<{ Body: { upToId?: number } }>("/api/notifications/read", async (req) => {
  writable();
  markRead(Number(req.body?.upToId) || 0);
  return bell();
});
app.post("/api/notifications/test", async () => {
  const s = getSettings().notify;
  if (!s.discordWebhook && !s.ntfyUrl) throw fail("Set up Discord or ntfy first (and save)", 400);
  const out = await send("imported", "Test", "AnimeArr can reach this channel.");
  if (!out.length) throw fail("The 'imported' event is switched off, or too many notifications this minute", 400);
  return { results: out };
});

// ---------------------------------------------------------------- cutover (Sonarr/Radarr → AnimeArr)

// The plan is built on request ("Build plan"), in slices, and cached; ?cached=1 only returns a built one.
app.get<{ Querystring: { cached?: string; fresh?: string } }>("/api/cutover", async (req) => {
  if (req.query.cached === "1" && cutoverCachedAt() === null) return { built: false };
  return { built: true, ...(await cutoverPlan(undefined, { cached: req.query.fresh !== "1" })) };
});

app.post<{ Body: { tvdbIds?: number[]; movieIds?: number[]; acceptSpecials?: boolean } }>("/api/cutover/adopt", async (req) => {
  writable();
  const b = req.body ?? {};
  const shows = adoptShows((b.tvdbIds ?? []).map(Number).filter((x) => Number.isInteger(x) && x > 0), { acceptSpecials: b.acceptSpecials === true });
  const movies = await adoptMovies((b.movieIds ?? []).map(Number).filter((x) => Number.isInteger(x) && x > 0));
  materializeAll();
  return { shows, movies };
});
app.post<{ Body: { tvdbIds?: number[]; movieIds?: number[]; acceptSpecials?: boolean } }>("/api/cutover/remove", async (req) => {
  writable();
  const b = req.body ?? {};
  const out = await switchToAnimeArr({ tvdbIds: (b.tvdbIds ?? []).map(Number), movieIds: (b.movieIds ?? []).map(Number), acceptSpecials: b.acceptSpecials === true });
  invalidateIndex();
  return { results: out };
});
app.post<{ Body: { tvdbId: number; anilistId: number; season?: number; offset?: number; force?: boolean } }>("/api/cutover/match-show", async (req) => {
  writable();
  const b = req.body ?? ({} as never);
  return matchShow(id(b.tvdbId), id(b.anilistId), Number(b.season ?? 1), Number(b.offset ?? 0), undefined, { force: b.force === true });
});
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

// ---------------------------------------------------------------- native Add (no Sonarr/Radarr)

app.get<{ Querystring: { q?: string } }>("/api/add/search", async (req) => searchAdd(String(req.query.q ?? "").slice(0, 200)));
app.get("/api/add/season", async () => ({ items: await seasonPicks().catch(() => []) }));
app.post<{ Body: { anilistId: number; rootFolder: string; kind?: "show" | "movie"; profileId?: string | null; sizePreset?: string | null; scope?: Scope | null; then?: "search" | "queue" | "none"; live?: boolean } }>("/api/add", async (req) => {
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
      void autoSearchMovie(mv.movieId).catch((e) => logDecision("fail", { title: mv.title, why: `Search after adding ${mv.title} failed: ${(e as Error).message}` }));
    }
    return { ...mv, then };
  }
  const scope = b.scope ? validateScope(b.scope) : null;
  refuseDropped((db.prepare("SELECT tvdb_id FROM entries WHERE anilist_id = ?").get(Number(b.anilistId)) as { tvdb_id: number | null } | undefined)?.tvdb_id);
  const added = await addShow({ anilistId: Number(b.anilistId), rootFolder: String(b.rootFolder ?? "") });
  if (b.profileId || b.sizePreset) setSeriesPrefs(added.tvdbId, b.profileId || null, null, (b.sizePreset || null) as Parameters<typeof setSeriesPrefs>[3]);
  if (scope) setScope([added.tvdbId], scope);
  const managed = setManaged([added.tvdbId], true, { live: b.live !== false && !getSettings().managed.dryRun });
  let then: unknown = null;
  if (b.then === "queue") then = addToQueue([added.tvdbId]);
  else if (b.then === "search") {
    const ids = [...scopedEpisodeIds(added.tvdbId, (cache.prepare("SELECT id FROM series WHERE tvdb_id = ?").get(added.tvdbId) as { id: number }).id)];
    const now = Date.now();
    const missing = ids.filter((e) => {
      const r = cache.prepare("SELECT has_file, air_utc FROM episodes WHERE id = ?").get(e) as { has_file: number; air_utc: number | null } | undefined;
      return r?.has_file === 0 && r.air_utc !== null && r.air_utc <= now; // aired, no file
    });
    // ⚡ handles at most 26 episodes at once; a longer backlog goes to the fill-in queue instead.
    if (missing.length > 26) then = { searching: 0, queued: addToQueue([added.tvdbId]).added, missing: missing.length };
    else {
      then = { searching: missing.length };
      if (missing.length)
        void autoSearchEpisodes(added.tvdbId, missing).catch((e) => logDecision("fail", { tvdbId: added.tvdbId, title: added.title, why: `Search after adding ${added.title} failed: ${(e as Error).message}` }));
    }
  }
  return { ...added, managed, then };
});

app.delete<{ Params: { movieId: string } }>("/api/add/movie/:movieId", async (req) => {
  writable();
  return removeMovie(id(req.params.movieId));
});
app.delete<{ Params: { tvdbId: string } }>("/api/add/:tvdbId", async (req) => {
  writable();
  return removeShow(id(req.params.tvdbId));
});

// ---------------------------------------------------------------- AnimeArr's own importer + renamer (plans first)

/** A manual import opened from a grab: its release name (quality, group) and client (torrents are copied, keep seeding). */
const grabSource = (b: { release?: string; client?: string | null; grabId?: number | null }) => {
  const g = b.grabId ? (db.prepare("SELECT release, client FROM grabs WHERE id = ?").get(Number(b.grabId)) as { release: string; client: string | null } | undefined) : undefined;
  return { release: b.release ?? g?.release, client: b.client ?? g?.client ?? null };
};
app.post<{ Body: { tvdbId: number; path: string; episodeIds?: number[]; release?: string; client?: string | null; grabId?: number | null } }>("/api/import/plan", async (req) => {
  const b = req.body ?? ({} as never);
  if (!b.tvdbId || !b.path) throw fail("tvdbId and path are required", 400);
  return planImport({ tvdbId: Number(b.tvdbId), path: String(b.path), episodeIds: b.episodeIds?.map(Number), ...grabSource(b) });
});
app.post<{ Body: { tvdbId: number; path: string; episodeIds?: number[]; release?: string; client?: string | null; only?: string[]; dryRun?: boolean; grabId?: number | null } }>("/api/import/run", async (req) => {
  writable();
  const b = req.body ?? ({} as never);
  if (!b.tvdbId || !b.path) throw fail("tvdbId and path are required", 400);
  const plan = await planImport({ tvdbId: Number(b.tvdbId), path: String(b.path), episodeIds: b.episodeIds?.map(Number), ...grabSource(b) });
  const results = await executeImport(plan, { dryRun: b.dryRun !== false, only: b.only, grabId: b.grabId ? Number(b.grabId) : undefined });
  // Opened from a grab's fix: everything it was for is imported → the grab is done.
  if (b.grabId && b.dryRun === false && results.length && results.every((r) => r.done)) await finishGrabByHand(Number(b.grabId), plan.seriesTitle);
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
  return { ...browseImport({ path: want, extra: [grabPath] }), grabPath };
});
/** Movie import plan (a dry run; nothing is changed). */
app.post<{ Body: { movieId: number; path: string; release?: string; client?: string | null; grabId?: number | null } }>("/api/import/movie-plan", async (req) => {
  const b = req.body ?? ({} as never);
  if (!id(b.movieId) || !b.path) throw fail("movieId and path are required", 400);
  return planMovieImport({ movieId: Number(b.movieId), path: String(b.path), ...grabSource(b) });
});
app.get<{ Params: { tvdbId: string } }>("/api/series/:tvdbId/rename", async (req) => renamePlan(id(req.params.tvdbId)));
app.post<{ Params: { tvdbId: string }; Body: { fileIds: number[] } }>("/api/series/:tvdbId/rename", async (req) => {
  writable();
  return applyRenameRouted(id(req.params.tvdbId), (req.body?.fileIds ?? []).map(Number));
});
app.get("/api/media/rename-all", async () => {
  const rows = cache.prepare("SELECT tvdb_id, title FROM series ORDER BY sort_title").all() as { tvdb_id: number; title: string }[];
  const out: { tvdbId: number; title: string; count: number }[] = [];
  for (const r of rows) {
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
app.put<{ Body: { engine?: string; allowReal?: boolean; allowRename?: boolean; realBudget?: number; movies?: boolean } }>("/api/media/importer", async (req) => {
  writable();
  const b = req.body ?? {};
  const cur = getSettings().importer;
  if (b.engine === "sonarr") throw fail("Imports through Sonarr/Radarr are gone: AnimeArr imports by itself", 400);
  const next = { engine: "animearr" as const, allowReal: typeof b.allowReal === "boolean" ? b.allowReal : cur.allowReal, allowRename: typeof b.allowRename === "boolean" ? b.allowRename : cur.allowRename, realBudget: Number.isInteger(b.realBudget) && b.realBudget! >= -1 && b.realBudget! <= 1000 ? b.realBudget! : (cur.realBudget ?? 0), movies: typeof b.movies === "boolean" ? b.movies : !!cur.movies, sourceRoots: cur.sourceRoots ?? ["/data/completed/animearr", "/data/qbittorrent/completed/animearr"] };
  patchSettings((x) => ({ ...x, importer: next }));
  logDecision("info", { why: `Importer: ${next.engine === "animearr" ? "AnimeArr's own" : "through Sonarr/Radarr"}; real imports ${next.allowReal ? (next.realBudget < 0 ? "on" : `on for ${next.realBudget} more`) : "off"}; renames ${next.allowRename ? "on" : "off"}` });
  return next;
});
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
app.get<{ Params: { tvdbId: string }; Querystring: { seasons?: string; recentN?: string; episodes?: string; specials?: string; creditless?: string } }>("/api/series/:tvdbId/scope", async (req) => {
  const tvdbId = id(req.params.tvdbId);
  const current = scopeFor(tvdbId);
  const q = req.query;
  const want = q.seasons ? validateScope({ seasons: q.seasons as never, recentN: Number(q.recentN ?? 1), episodes: q.episodes as never, specials: q.specials === "1", creditless: q.creditless !== "0" }) : current;
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
app.post<{ Body: { tvdbId?: number; episodeIds?: number[] } }>("/api/autosearch", async (req) => {
  writable();
  if (!searchConfigured()) throw fail("No indexer is set up (Settings → Indexers)");
  return autoSearchEpisodes(id(req.body?.tvdbId), (req.body?.episodeIds ?? []).map(id));
});
app.post<{ Body: { movieIds?: number[]; wanted?: boolean } }>("/api/movies/wanted", async (req) => {
  writable();
  const r = setWanted((req.body?.movieIds ?? []).map(Number).filter((x) => Number.isInteger(x) && x > 0), req.body?.wanted !== false);
  planMovies();
  return r;
});
app.post<{ Params: { id: string }; Body: { replace?: boolean } }>("/api/movies/:id/autosearch", async (req) => {
  writable();
  // The same indexers as "Pick a version…" (Prowlarr or AnimeArr's own), not Prowlarr only.
  if (!searchConfigured()) throw fail("No indexer is set up (Settings → Indexers)");
  return autoSearchMovie(id(req.params.id), { replace: req.body?.replace === true });
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
app.put<{ Params: { id: string }; Body: { profileId?: string | null; watchMode?: string | null } }>("/api/movies/:id/prefs", async (req) => {
  writable();
  const movieId = id(req.params.id);
  movieDetail(movieId); // 404 when unknown
  return setMoviePrefs(movieId, req.body?.profileId || null, (req.body?.watchMode || null) as Parameters<typeof setMoviePrefs>[2]);
});
// Grabs pick from the server's own last results (never a download URL sent by the browser).
const lastMovieResults = new Map<number, { at: number; results: Awaited<ReturnType<typeof searchMovie>>["results"] }>();
app.post<{ Params: { id: string } }>("/api/movies/:id/search", async (req) => {
  if (!searchConfigured()) throw fail("No indexer is set up (Settings → Indexers)");
  const r = await searchMovie(id(req.params.id));
  lastMovieResults.set(r.movie.id, { at: Date.now(), results: r.results });
  // Download links carry indexer API keys/passkeys: never sent to the browser (grabs use the cached results).
  return { ...r, results: r.results.map(({ downloadUrl: _d, magnetUrl: _m, ...x }) => x), dryRun: getSettings().managed.dryRun };
});
app.post<{ Params: { id: string }; Body: { guid?: string; confirm?: boolean; replace?: boolean } }>("/api/movies/:id/grab", async (req) => {
  writable();
  if (req.body?.confirm !== true) throw fail("Confirm the grab first");
  const movieId = id(req.params.id);
  const cached = lastMovieResults.get(movieId);
  if (!cached || Date.now() - cached.at > 30 * 60_000) throw fail("Search again first (results expire after 30 minutes)", 409);
  const pick = cached.results.find((r) => r.guid === req.body?.guid);
  if (!pick) throw fail("That release isn't in the last search results", 404);
  const toCand = (r: (typeof cached.results)[number]): Candidate => ({ guid: r.guid, title: r.title, indexerId: r.indexerId, indexer: r.indexer, protocol: r.protocol, size: r.size, downloadUrl: r.downloadUrl, magnetUrl: r.magnetUrl, label: r.label, group: r.group, why: r.rank.why, episodeIds: [] });
  const fallbacks = cached.results.filter((r) => r !== pick && r.rank.accept && r.confidence >= 80).map(toCand);
  return startMovieGrab({ movieId, candidate: toCand(pick), fallbacks, origin: "manual", replace: req.body?.replace === true });
});
app.get<{ Querystring: { fresh?: string } }>("/api/recycle", async (req) => recycleStatus(undefined, Date.now(), req.query.fresh === "1"));
app.get("/api/recycle/animearr", async () => binStatus());
app.post<{ Body: { confirm?: boolean } }>("/api/recycle/animearr/empty", async (req) => {
  writable();
  if (req.body?.confirm !== true) throw fail("Confirm emptying the bin first", 400);
  return purgeBin({ all: true });
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
  const r = await Promise.race([run.then((x) => x, () => null), new Promise<undefined>((res) => setTimeout(res, 20_000))]);
  if (r === undefined) return { done: false, reason: "running" };
  if (r === null) return { done: false, reason: "error" };
  return { done: true, checked: r.length, bad: r.filter((x) => !x.ok && x.action !== "skipped").length };
});
app.get("/api/queue", async () => queueView());
app.get("/api/queue/sonarr", async () => ({ items: await sonarrQueueProblems() }));
app.post<{ Params: { id: string }; Body: { blocklist?: boolean; confirm?: boolean; downloadId?: string | null } }>("/api/queue/sonarr/:id/remove", async (req) => {
  writable();
  if (req.body?.confirm !== true) throw fail("Confirm first");
  await removeSonarrQueueItem(id(req.params.id), req.body?.blocklist === true, typeof req.body?.downloadId === "string" ? req.body.downloadId : null);
  return { ok: true };
});
app.get<{ Querystring: { before?: string; state?: string } }>("/api/history", async (req) => grabHistory({ before: req.query.before ? Number(req.query.before) : undefined, state: req.query.state || undefined }));
app.post<{ Params: { id: string }; Body: { blocklist?: boolean; searchNext?: boolean; confirm?: boolean } }>("/api/queue/:id/remove", async (req) => {
  writable();
  if (req.body?.confirm !== true) throw fail("Confirm first");
  const next = await removeGrab(id(req.params.id), { blocklist: req.body?.blocklist === true, searchNext: req.body?.searchNext === true });
  return { ok: true, next };
});
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
  const plan = await planMovieImport({ movieId: id(req.body?.movieId), path: String(req.body?.path ?? ""), ...grabSource(req.body ?? {}) });
  const results = await executeMovieImport(plan, { grabId });
  if (grabId && results.length && results.every((r) => r.done)) await finishGrabByHand(grabId, plan.title);
  return { plan, results };
});
app.post<{ Body: { name: string } }>("/api/downloads/rules/disable", async (req) => {
  writable();
  const name = String(req.body?.name ?? "");
  const s = getSettings();
  if (!s.downloads.rules.some((r) => r.name === name)) throw fail("No rule with that name", 404);
  patchSettings((x) => ({ ...x, downloads: { ...x.downloads, rules: x.downloads.rules.map((r) => (r.name === name ? { ...r, enabled: false } : r)) } }));
  reevaluate();
  logDecision("info", { why: `You switched the download-folder rule "${name}" off (grabs resume)` });
  return { ok: true };
});
app.post<{ Params: { id: string } }>("/api/grabs/:id/retry", async (req) => {
  writable();
  retryImport(id(req.params.id));
  return { ok: true };
});

// ---------------------------------------------------------------- activity log + undo

app.get<{ Querystring: { before?: string; tvdbId?: string; kinds?: string } }>("/api/activity", async (req) =>
  withArt(listDecisions({ before: req.query.before ? Number(req.query.before) : undefined, tvdbId: req.query.tvdbId ? Number(req.query.tvdbId) : undefined, kinds: req.query.kinds ? req.query.kinds.split(",") : undefined, limit: 100 })),
);
/** Activity cards: the show/movie poster and a short episode label ("S01E02–E04"), looked up once per page. */
function withArt<T extends { tvdbId: number | null; episodeIds: number[]; detail: unknown }>(list: T[]) {
  const covers = new Map<string, string | null>();
  const coverOf = (key: string, get: () => string | null) => (covers.has(key) ? covers.get(key)! : (covers.set(key, get()), covers.get(key)!));
  return list.map((d) => {
    const movieId = (d.detail as { movieId?: number } | null)?.movieId;
    const cover = d.tvdbId
      ? coverOf(`s${d.tvdbId}`, () => {
          const s = cache.prepare("SELECT tvdb_id, poster FROM series WHERE tvdb_id = ?").get(d.tvdbId) as { tvdb_id: number; poster: string | null } | undefined;
          return s ? coverFor(s) : null;
        })
      : movieId
        ? coverOf(`m${movieId}`, () => (cache.prepare("SELECT poster FROM movies WHERE id = ?").get(movieId) as { poster: string | null } | undefined)?.poster ?? null)
        : null;
    let label = "";
    if (d.episodeIds.length) {
      const eps = d.episodeIds.map((e) => cache.prepare("SELECT season, episode FROM episodes WHERE id = ?").get(e) as { season: number; episode: number } | undefined).filter((x): x is { season: number; episode: number } => !!x).sort((a, b) => a.season - b.season || a.episode - b.episode);
      if (eps.length) label = `S${String(eps[0].season).padStart(2, "0")}E${String(eps[0].episode).padStart(2, "0")}${eps.length > 1 ? `–E${String(eps[eps.length - 1].episode).padStart(2, "0")}` : ""}`;
    }
    return { ...d, cover, label, movieId: movieId ?? null };
  });
}
app.post<{ Params: { id: string } }>("/api/activity/:id/undo", async (req) => {
  writable();
  const d = getDecision(id(req.params.id));
  if (!d?.undo) throw fail("This can't be undone", 404);
  if (d.undoneAt) throw fail("Already undone", 409);
  const a = d.undo.args as Record<string, number | string>;
  switch (d.undo.action) {
    case "unmanage":
      setManaged([Number(a.tvdbId)], false);
      break;
    case "manage":
      setManaged([Number(a.tvdbId)], true);
      break;
    case "rename-back":
      await renameBack(d.undo.args as unknown as Parameters<typeof renameBack>[0]);
      break;
    case "delete-alias":
      db.prepare("DELETE FROM aliases WHERE id = ?").run(Number(a.id));
      invalidateIndex();
      break;
    case "delete-rule":
      db.prepare("DELETE FROM rules WHERE id = ?").run(Number(a.id));
      break;
    case "delete-fact":
      db.prepare("DELETE FROM facts WHERE id = ?").run(Number(a.id));
      break;
    case "unblock":
      if (a.id) db.prepare("DELETE FROM blocklist WHERE id = ?").run(Number(a.id));
      else db.prepare("DELETE FROM blocklist WHERE release = ?").run(String(a.release));
      break;
    case "remonitor":
      await unmonitorInSonarr(Number(a.tvdbId), true);
      break;
    case "undrop":
      undropShow(Number(a.tvdbId));
      break;
    case "delete-overrides":
      deleteOverrides(String(a.ids).split(",").map(Number).filter(Boolean));
      break;
    case "rename-sidecar-back":
      renameSidecarBack(d.undo.args as { dir: string; from: string; to: string });
      break;
  }
  markUndone(d.id);
  logDecision("info", { tvdbId: d.tvdbId, title: d.title, why: `Undid: ${d.why}` });
  return { ok: true };
});

// ---------------------------------------------------------------- system: jobs, metadata, backups

app.get("/api/system", async () => ({
  version: VERSION,
  uptime: Date.now() - STARTED,
  node: process.version,
  configDir: CONFIG_DIR,
  jobs: listJobs(),
  metadata: metadataStatus(),
  aliasKeys: aliasIndex().size,
  db: { corrupt: dbState.corrupt, detail: dbState.detail },
  backups: listBackups(),
  backupDir: BACKUP_DIR,
  memoryMb: Math.round(process.memoryUsage().rss / 1e6),
}));
app.post("/api/system/metadata", async () => refreshMetadata(false));
app.post("/api/system/backup", async () => {
  writable();
  return { name: backupNow("manual") };
});
app.post<{ Body: { name?: string; password?: string } }>("/api/system/restore", async (req) => {
  if (authState(req).via === "apikey") throw fail("Restoring needs the account password", 403);
  if (!loginAllowed(req.ip, getSettings().auth.username)) throw fail("Too many attempts, wait a few seconds", 429);
  if (!(await checkPassword(String(req.body?.password ?? ""), getSettings().auth.passwordHash))) throw fail("Wrong password", 403);
  restoreBackup(String(req.body?.name ?? ""));
  app.log.warn("Backup restored; exiting so the app restarts with it.");
  setTimeout(() => process.exit(0), 500);
  return { ok: true, message: "Restored. AnimeArr is restarting; reload the page in a few seconds (start it again yourself if it isn't running in Docker)." };
});
app.post("/api/system/cache/reset", async (req) => {
  writable();
  if (authState(req).via === "apikey") throw fail("Log in to rebuild the cache", 403);
  resetCache();
  invalidateIndex();
  void syncLibrary(true).catch(() => undefined);
  return { ok: true };
});

// ---------------------------------------------------------------- web UI

if (!fs.existsSync(path.join(WEB_DIR, "index.html"))) app.log.warn(`No web build in ${WEB_DIR} yet; run "npm run build" (the API works meanwhile).`);
fs.mkdirSync(WEB_DIR, { recursive: true });
// wildcard: true serves files built after startup too (vite build while the dev server runs).
await app.register(fastifyStatic, { root: WEB_DIR, wildcard: true, index: false });
/** The web build being served: the hashed name of its entry script (open tabs compare it to theirs to offer a reload). */
let buildCache: { mtime: number; id: string | null } | null = null;
function webBuild(): string | null {
  try {
    const file = path.join(WEB_DIR, "index.html");
    const mtime = fs.statSync(file).mtimeMs;
    if (buildCache?.mtime !== mtime) buildCache = { mtime, id: /assets\/index-([\w-]+)\.js/.exec(fs.readFileSync(file, "utf8"))?.[1] ?? null };
    return buildCache.id;
  } catch {
    return null;
  }
}
/** The page itself, with <base href> set to the URL base (so relative asset URLs work on any path). */
const sendIndex = (reply: import("fastify").FastifyReply) => {
  const file = path.join(WEB_DIR, "index.html");
  if (!fs.existsSync(file)) return reply.code(503).send("Web UI not built yet: run npm run build");
  const html = fs.readFileSync(file, "utf8").replace("<head>", `<head>\n    <base href="${URL_BASE.replace(/[^A-Za-z0-9._~/-]/g, "")}/" />`);
  // No framing (clickjacking), no referrer leaks; scripts only from ourselves.
  return reply
    .type("text/html; charset=utf-8")
    .header("Cache-Control", "no-cache")
    .header("X-Frame-Options", "DENY")
    .header("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; script-src 'self'")
    .header("Referrer-Policy", "no-referrer")
    .send(html);
};
app.get("/", { config: { public: true } }, async (_req, reply) => sendIndex(reply));
app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : sendIndex(reply)));

// ---------------------------------------------------------------- background jobs

const every = (ms: number, fn: () => Promise<unknown> | unknown, name: string) =>
  setInterval(() => {
    try {
      void Promise.resolve(fn()).catch((e) => app.log.warn(`${name}: ${(e as Error).message}`));
    } catch (e) {
      app.log.warn(`${name}: ${(e as Error).message}`);
    }
  }, ms);

async function startup() {
  try {
    await refreshMetadata();
  } catch (e) {
    app.log.warn(`metadata: ${(e as Error).message}`);
  }
  const last = lastSync();
  if (getSettings().sonarr.url && (!last || Date.now() - last > getSettings().sync.intervalHours * 3_600_000)) await syncLibrary().then(() => refreshCovers()).catch(() => undefined);
}
recoverGrabs();
materializeAll(); // native shows into the (rebuildable) cache
setTimeout(() => void startup(), 3_000);
every(60 * 60_000, async () => {
  const s = getSettings();
  const last = lastSync();
  if (s.sonarr.url && (!last || Date.now() - last > s.sync.intervalHours * 3_600_000)) await syncLibrary().then(() => refreshCovers());
  await refreshMetadata();
  // Nightly backup (keeps 7) and log pruning.
  const nightly = listBackups().find((b) => b.kind === "nightly");
  if (!nightly || Date.now() - nightly.at > 23 * 3_600_000) backupNow("nightly");
  pruneDecisions();
}, "hourly");
every(30_000, () => pipelineTick(), "pipeline");
every(10 * 60_000, () => repairTick(), "after-import check");
every(15 * 60_000, () => upgradeTick(), "dual upgrades");
every(10 * 60_000, () => movieTick(), "movie search");
every(15 * 60_000, () => breakerTick(breakerDeps), "indexer re-tests");
every(60 * 60_000, async () => binTick(), "recycling bin purge");
every(30 * 60_000, async () => (await fileScanTick(), void materializeAll()), "file scan");
every(30 * 60_000, () => fillInTick(), "fill-in");
every(6 * 3_600_000, () => catalogTick(), "catalog");
setTimeout(() => void catalogTick().catch(() => undefined), 5 * 60_000);
setTimeout(() => void fileScanTick().catch(() => undefined), 90_000);
setTimeout(() => void importMediaDefaultsOnce(), 20_000);
every(5 * 60_000, () => managedTick(), "managed");
every(5 * 60_000, () => downloadsTick(), "download rules");
// AniDB: a few library entries every 15 minutes (never a crawl); shows blocked in the cutover first.
every(15 * 60_000, async () => {
  const st = anidbStatus();
  if (!st.configured || st.blockedUntil || st.capped) return; // nothing to do: no planning either
  const blocked = [...(await allShowCuts()).values()].filter((c) => c.blockers.length).map((c) => c.tvdbId);
  const aids = blocked.flatMap((t) => (JSON.parse((cache.prepare("SELECT anidb_ids FROM series WHERE tvdb_id = ?").get(t) as { anidb_ids: string } | undefined)?.anidb_ids ?? "[]") as { aid: number }[]).map((x) => x.aid));
  const r = await anidbTick(aids);
  if (r.fetched) materializeAll(); // native shows pick up AniDB's episodes
}, "anidb");
app.get("/api/anidb", async () => anidbStatus());
app.get<{ Params: { tvdbId: string } }>("/api/series/:tvdbId/anidb", async (req) => ({ status: anidbStatus(), entries: anidbView(id(req.params.tvdbId)) }));
app.post<{ Params: { tvdbId: string } }>("/api/series/:tvdbId/anidb/fetch", async (req) => {
  writable();
  const r = await fetchForTvdb(id(req.params.tvdbId));
  if (r.fetched) materializeAll();
  return r;
});
app.put<{ Params: { tvdbId: string }; Body: { aid: number; season?: number | null; offset?: number } }>("/api/series/:tvdbId/anidb/override", async (req) => {
  writable();
  const b = req.body ?? ({} as never);
  const season = b.season === null || b.season === undefined ? null : Number(b.season);
  if (season !== null && (!Number.isInteger(season) || season < 0 || season > 99)) throw fail("Season 0–99", 400);
  const offset = Number(b.offset ?? 0);
  if (!Number.isInteger(offset) || offset < -5000 || offset > 5000) throw fail("Offset −5000–5000", 400);
  setAnidbOverride(id(b.aid), id(req.params.tvdbId), season, offset);
  logDecision("info", { tvdbId: id(req.params.tvdbId), why: season === null ? `AniDB ${b.aid}: back to Anime-Lists' placement` : `AniDB ${b.aid} placed on season ${season}${offset ? ` (offset ${offset})` : ""} by you` });
  materializeAll();
  return { entries: anidbView(id(req.params.tvdbId)) };
});
setTimeout(() => void downloadsTick().catch(() => undefined), 30_000);
let lastRss = 0;
every(60_000, async () => {
  const m = getSettings().managed.rssMin;
  if (m > 0 && Date.now() - lastRss >= m * 60_000) {
    lastRss = Date.now();
    await rssTick();
  }
}, "rss");

// First start: no default login (a known password would be open to anyone who port-forwards). The account is created
// in the browser, from the home network or with this one-time setup code.
if (!getSettings().auth.passwordHash) app.log.warn(`First start: open AnimeArr in your browser to create your account. Setup code (needed when you're not on the same network): ${SETUP_TOKEN}`);
await app.listen({ host: "0.0.0.0", port: PORT });
if (await usingDefaultPassword()) app.log.warn("The login is still the old default password. Change it in Settings → Security.");
