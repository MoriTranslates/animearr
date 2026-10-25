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
import { identify } from "./core/identify.js";
import { compactKey } from "./core/normalize.js";
import { parseRelease } from "./core/parser.js";
import { refreshCovers } from "./covers.js";
import { lastSync, syncLibrary, syncRunning } from "./library.js";
import { candidates, listManaged, managedTick, rssTick, scheduleFor, setManaged, setShowDryRun, unmonitorInSonarr } from "./managed.js";
import { aliasIndex, invalidateIndex, metadataStatus, refreshMetadata } from "./metadata.js";
import { listGrabs, pipelineTick, startGrab, type Candidate } from "./pipeline.js";
import { deepSearch, episodesFor, identifyContext, seriesByTvdb, type SearchResult } from "./search.js";
import { checkPassword, getSettings, isMasked, patchSettings, publicSettings, regenerateApiKey, safeEqual, setAccount, setBypassLocal, updateSettings, type Settings } from "./settings.js";
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
  if (before.managed.dryRun !== next.managed.dryRun) logDecision("info", { why: next.managed.dryRun ? "Global dry-run turned ON: nothing will be grabbed" : "Global dry-run turned OFF: shows whose own dry-run is off will be grabbed for real" });
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
  };
});

app.post<{ Body: { tvdbIds?: number[]; on?: boolean } }>("/api/managed", async (req) => {
  writable();
  const ids = (req.body?.tvdbIds ?? []).map(id).slice(0, 500);
  return setManaged(ids, req.body?.on !== false);
});
app.get("/api/managed", async () => ({ dryRun: getSettings().managed.dryRun, shows: listManaged().map((m) => ({ ...m, cover: seriesByTvdb(m.tvdbId)?.cover ?? null, schedule: scheduleFor(m.tvdbId).slice(0, 6) })), grabs: listGrabs(30) }));
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
  const lang = String(req.body?.lang ?? getSettings().profile.subLangs[0]).slice(0, 10);
  const note = String(req.body?.note ?? "").slice(0, 200);
  const r = db.prepare("INSERT INTO facts (tvdb_id, season, kind, lang, note, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET note = excluded.note, at = excluded.at").run(tvdbId, season, kind, lang, note, Date.now());
  logDecision("fact", { tvdbId, title: s.title, why: `You confirmed: ${s.title}${season !== null ? ` season ${season}` : ""} ${kind === "burned_in" ? `has burned-in ${lang} subtitles` : "has no release in your language"}${note ? ` (${note})` : ""}`, undo: { action: "delete-fact", args: { id: Number(r.lastInsertRowid) } } });
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

app.post<{ Body: { tvdbId?: number; episodeIds?: number[] } }>("/api/search", async (req) => {
  const tvdbId = id(req.body?.tvdbId);
  const eps = (req.body?.episodeIds ?? []).map(id).slice(0, 50);
  const r = await deepSearch(tvdbId, eps);
  for (const [k, v] of lastResults) if (Date.now() - v.at > 30 * 60_000) lastResults.delete(k);
  lastResults.set(searchKey(tvdbId, eps), { at: Date.now(), tvdbId, episodeIds: eps, results: r.results });
  logDecision("search", { tvdbId, title: r.series.title, episodeIds: eps, why: `Deep Search: ${r.queries.length} queries, ${r.found} releases, ${r.matched} for these episodes, ${r.results.filter((x) => x.rank.accept).length} acceptable` });
  return { ...r, results: r.results.map(({ downloadUrl: _d, magnetUrl: _m, ...x }) => x), dryRun: getSettings().managed.dryRun };
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
      db.prepare("DELETE FROM blocklist WHERE release = ?").run(String(a.release));
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
app.post("/api/system/cache/reset", async () => {
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
every(5 * 60_000, () => managedTick(), "managed");
let lastRss = 0;
every(60_000, async () => {
  const m = getSettings().managed.rssMin;
  if (m > 0 && Date.now() - lastRss >= m * 60_000) {
    lastRss = Date.now();
    await rssTick();
  }
}, "rss");

await app.listen({ host: "0.0.0.0", port: PORT });
if (!getSettings().auth.passwordHash)
  app.log.warn(`No account yet. Open AnimeArr from your home network to create one, or use setup code ${SETUP_TOKEN} from elsewhere (one-time, changes on restart).`);
