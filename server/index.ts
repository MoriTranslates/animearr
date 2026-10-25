import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { authState, COOKIE, csrfOk, guard, hostAllowed, isLocalRequest, loginAllowed, loginSucceeded, makeSession, SETUP_TOKEN, trustProxyOption } from "./auth.js";
import { BACKUP_DIR, backupNow, cache, CONFIG_DIR, db, dbState, listBackups, listJobs, resetCache, restoreBackup, startupWarnings } from "./db.js";
import { getDecision, listDecisions, logDecision, markUndone, pruneDecisions } from "./activity.js";
import { testProwlarr } from "./arr/prowlarr.js";
import { testRadarr, radarrOptions } from "./arr/radarr.js";
import { sonarrOptions, testSonarr } from "./arr/sonarr.js";
import { testQbit, testSab } from "./arr/clients.js";
import { redactUrl } from "./arr/http.js";
import { gaps, listFacts, missingLanguage, specials } from "./audit.js";
import { deleteProfile, listProfiles, profileFor, saveProfile, setSeriesPrefs, seriesPrefs } from "./profiles.js";
import { calendar, deleteEpisodeFiles, episodeDetail, episodeRows, regrabEpisodes, searchAgainSoon, seriesHeader } from "./episodes.js";
import { identify } from "./core/identify.js";
import { compactKey } from "./core/normalize.js";
import { parseRelease } from "./core/parser.js";
import { refreshCovers } from "./covers.js";
import { lastSync, syncLibrary, syncRunning } from "./library.js";
import { backlogSummary, candidates, listManaged, managedTick, releaseDryRunDecisions, rssTick, scheduleFor, setManaged, setShowDryRun, unmonitorInSonarr } from "./managed.js";
import { aliasIndex, invalidateIndex, metadataStatus, refreshMetadata } from "./metadata.js";
import { listGrabs, pipelineTick, recoverGrabs, removeGrab, retryImport, startGrab, type Candidate } from "./pipeline.js";
import { grabHistory, queueView } from "./queue.js";
import { recentChecks, repairTick } from "./repair.js";
import { deepSearch, episodesFor, identifyContext, seriesByTvdb, type SearchProgress, type SearchResult } from "./search.js";
import { checkPassword, DEFAULT_LOGIN, ensureDefaultAccount, getSettings, isMasked, usingDefaultPassword, patchSettings, publicSettings, regenerateApiKey, safeEqual, setAccount, setBypassLocal, updateSettings, type LanguageProfile, type Settings } from "./settings.js";
import { ROOT_DIR, VERSION } from "./version.js";

const WEB_DIR = path.join(ROOT_DIR, "dist", "web");
const PORT = Number(process.env.PORT ?? 8484);
const STARTED = Date.now();

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info", serializers: { req: (r) => ({ method: r.method, url: redactUrl(r.url.split("?")[0]), remoteAddress: r.ip }) } },
  trustProxy: trustProxyOption() as string[] | false,
  bodyLimit: 1_000_000,
});
await app.register(fastifyCookie);
app.addHook("onRequest", guard);
app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  app.log.warn(redactUrl(err.message));
  reply.code(err.statusCode && err.statusCode >= 400 ? err.statusCode : 500).send({ error: redactUrl(err.message) });
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
  const base = { version: VERSION, setupRequired: a.setupRequired, loggedIn: a.ok };
  if (!a.ok) return base;
  return {
    ...base,
    via: a.via,
    connected: { sonarr: !!(s.sonarr.url && s.sonarr.apiKey), radarr: !!(s.radarr.url && s.radarr.apiKey), prowlarr: !!(s.prowlarr.url && s.prowlarr.apiKey), sabnzbd: !!(s.sabnzbd.url && s.sabnzbd.apiKey), qbittorrent: !!s.qbittorrent.url },
    dryRun: s.managed.dryRun,
    allowedRoots: s.allowedRoots,
    lastSync: lastSync(),
    syncing: syncRunning(),
    managed: listManaged().length,
    librarySeries: (cache.prepare("SELECT COUNT(*) AS n FROM series").get() as { n: number }).n,
    warnings: [...startupWarnings, ...(dbState.corrupt ? [`The database failed its integrity check (${dbState.detail}). AnimeArr is read-only until you restore a backup (System → Backups).`] : [])],
    uiLanguage: s.ui.language,
    defaultPassword: await usingDefaultPassword(),
    bypassLocal: s.auth.bypassLocal,
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
    case "qbittorrent": {
      const c = withSecret(b.url, b.password, s.qbittorrent.url, s.qbittorrent.password, false);
      return testQbit({ url: c.url, username: String(b.username ?? s.qbittorrent.username), password: c.secret, category: String(b.category || s.qbittorrent.category) });
    }
  }
  throw fail("Unknown service", 404);
});

/** Sonarr root folders, for the "allowed root folders" picker (suggests /media/AnimeArr when present; never auto-enabled). */
app.get("/api/sonarr/rootfolders", async () => {
  const o = await sonarrOptions();
  return { roots: o.roots, suggested: o.roots.find((r) => /\/AnimeArr\/?$/i.test(r.path))?.path ?? null, allowed: getSettings().allowedRoots };
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
  const rows = cache.prepare("SELECT tvdb_id, title, poster, status FROM series ORDER BY sort_title").all() as { tvdb_id: number; title: string; poster: string | null; status: string }[];
  const alt = q ? new Set((cache.prepare("SELECT s.tvdb_id FROM alt_titles a JOIN series s ON s.id = a.series_id WHERE a.key LIKE ?").all(`%${q}%`) as { tvdb_id: number }[]).map((r) => r.tvdb_id)) : null;
  return rows.filter((r) => !q || compactKey(r.title).includes(q) || alt?.has(r.tvdb_id)).slice(0, 50).map((r) => ({ tvdbId: r.tvdb_id, title: r.title, status: r.status }));
});
app.get<{ Params: { tvdbId: string } }>("/api/series/:tvdbId", async (req) => {
  const tvdbId = id(req.params.tvdbId);
  const s = seriesByTvdb(tvdbId);
  if (!s) throw fail("Not in the synced library", 404);
  const eps = episodesFor(tvdbId).sort((a, b) => a.season - b.season || a.episode - b.episode);
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
  };
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
app.put<{ Params: { tvdbId: string }; Body: { profileId?: string | null; watchMode?: string | null } }>("/api/series/:tvdbId/prefs", async (req) => {
  writable();
  const tvdbId = id(req.params.tvdbId);
  if (!seriesByTvdb(tvdbId)) throw fail("Unknown series", 404);
  return setSeriesPrefs(tvdbId, req.body?.profileId || null, (req.body?.watchMode || null) as Parameters<typeof setSeriesPrefs>[2]);
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
  return { from, to, entries: calendar(from, to, req.query.managed === "1") };
});

app.post<{ Body: { tvdbIds?: number[]; on?: boolean } }>("/api/managed", async (req) => {
  writable();
  const ids = (req.body?.tvdbIds ?? []).map(id).slice(0, 500);
  return setManaged(ids, req.body?.on !== false);
});
app.get("/api/managed", async () => ({ dryRun: getSettings().managed.dryRun, shows: listManaged().map((m) => ({ ...m, cover: seriesByTvdb(m.tvdbId)?.cover ?? null, schedule: scheduleFor(m.tvdbId, 6) })), grabs: listGrabs(30) }));
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

app.post<{ Body: { tvdbId?: number; episodeIds?: number[]; guid?: string; confirm?: boolean } }>("/api/grab", async (req) => {
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
  return startGrab({ tvdbId, episodeIds: eps, candidate: toCand(pick), fallbacks, origin: "manual" });
});
app.get("/api/grabs", async () => listGrabs(100));
app.get("/api/backlog", async () => backlogSummary());
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
app.get<{ Querystring: { before?: string; state?: string } }>("/api/history", async (req) => grabHistory({ before: req.query.before ? Number(req.query.before) : undefined, state: req.query.state || undefined }));
app.post<{ Params: { id: string }; Body: { blocklist?: boolean; searchNext?: boolean; confirm?: boolean } }>("/api/queue/:id/remove", async (req) => {
  writable();
  if (req.body?.confirm !== true) throw fail("Confirm first");
  const next = await removeGrab(id(req.params.id), { blocklist: req.body?.blocklist === true, searchNext: req.body?.searchNext === true });
  return { ok: true, next };
});
app.post<{ Params: { id: string } }>("/api/grabs/:id/retry", async (req) => {
  writable();
  retryImport(id(req.params.id));
  return { ok: true };
});

// ---------------------------------------------------------------- activity log + undo

app.get<{ Querystring: { before?: string; tvdbId?: string; kinds?: string } }>("/api/activity", async (req) =>
  listDecisions({ before: req.query.before ? Number(req.query.before) : undefined, tvdbId: req.query.tvdbId ? Number(req.query.tvdbId) : undefined, kinds: req.query.kinds ? req.query.kinds.split(",") : undefined, limit: 100 }),
);
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
await app.register(fastifyStatic, { root: WEB_DIR, wildcard: true, index: ["index.html"] });
app.setNotFoundHandler((req, reply) =>
  req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : fs.existsSync(path.join(WEB_DIR, "index.html")) ? reply.sendFile("index.html") : reply.code(503).send("Web UI not built yet: run npm run build"),
);

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
every(5 * 60_000, () => managedTick(), "managed");
let lastRss = 0;
every(60_000, async () => {
  const m = getSettings().managed.rssMin;
  if (m > 0 && Date.now() - lastRss >= m * 60_000) {
    lastRss = Date.now();
    await rssTick();
  }
}, "rss");

if (await ensureDefaultAccount()) app.log.warn(`First start: log in with ${DEFAULT_LOGIN.username} / ${DEFAULT_LOGIN.password}, then change the password in Settings → Security.`);
await app.listen({ host: "0.0.0.0", port: PORT });
if (await usingDefaultPassword()) app.log.warn(`The login is still the default (${DEFAULT_LOGIN.username} / ${DEFAULT_LOGIN.password}). Change it in Settings → Security.`);
