import { binTick } from "./binpurge.js";
import { breakerTick } from "./health.js";
import { fixesFor } from "./system/fixes.js";
import { humanizeError } from "./system/errors.js";
import { asciiJson } from "./system/json.js";
import { anidbStatus, anidbTick, anidbView, fetchForTvdb, setAnidbOverride } from "./metadata/anidb.js";
import { installLogCapture, logStream } from "./system/logs.js";
import { allShowCuts, invalidateCutover, refreshCuts, resumeCutovers } from "./cutover.js";
import { downloadsTick } from "./downloads.js";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { guard, trustProxyOption } from "./system/auth.js";
import { backupNow, cache, listBackups } from "./system/db.js";
import { logDecision, pruneDecisions } from "./system/activity.js";
import { redactUrl } from "./arr/http.js";
import { importListsTick } from "./importLists.js";
import { refreshCovers } from "./metadata/covers.js";
import { lastSync, syncLibrary } from "./library.js";
import { managedTick, rssTick } from "./managed.js";
import { refreshMetadata } from "./metadata/metadata.js";
import { pipelineTick, recoverGrabs } from "./pipeline.js";
import { repairTick } from "./repair.js";
import { upgradeTick } from "./upgrade.js";
import { qualityUpgradeTick } from "./qualityUpgrade.js";
import { seadexTick } from "./metadata/seadex.js";
import { movieTick } from "./movieSearch.js";
import { fileScanTick } from "./mediafiles.js";
import { fillInTick } from "./fillin.js";

import { importMediaDefaultsOnce } from "./mediadefaults.js";
import { registerSonarrApi } from "./sonarrApi.js";
import { materializeAll } from "./native.js";
import { DEFAULT_LOGIN, ensureDefaultAccount, getSettings, URL_BASE_RE, usingDefaultPassword } from "./system/settings.js";
import { TEST_APP, later, WEB_DIR, PORT, fail, id, writable, breakerDeps, catalogTick } from "./routes/common.js";
import { registerAccountRoutes } from "./routes/account.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerWizardRoutes } from "./routes/wizard.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerGrabsRoutes } from "./routes/grabs.js";
import { registerNotifyRoutes } from "./routes/notify.js";
import { registerAddingRoutes } from "./routes/adding.js";
import { registerFilesRoutes } from "./routes/files.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerSystemRoutes } from "./routes/system.js";

// UMASK (like the *arr images): files and folders AnimeArr's importer creates get the usual 775/664 with UMASK=002.
if (/^0?[0-7]{3}$/.test(process.env.UMASK ?? "")) process.umask(parseInt(process.env.UMASK!, 8));

/**
 * URL base for a reverse proxy on a sub-path (https://host/animearr/): URL_BASE, or Settings → System (restart).
 * Incoming URLs have it stripped, so every route stays the same; the page gets a <base href> for its assets.
 */
const URL_BASE = (() => {
  const v = (process.env.URL_BASE ?? getSettings().urlBase ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/^(?!\/)(.)/, "/$1");
  if (URL_BASE_RE.test(v)) return v;
  console.warn(`Ignoring the URL base "${v}": use something like /animearr (letters, digits, . _ ~ - only)`);
  return "";
})();
installLogCapture(); // the log viewer keeps what the server prints
const app = Fastify({
  rewriteUrl: (req) => {
    const u = req.url ?? "/";
    if (!URL_BASE) return u;
    if (u === URL_BASE) return "/";
    return u.startsWith(`${URL_BASE}/`) ? u.slice(URL_BASE.length) : u;
  },
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    stream: logStream,
    serializers: {
      req: (r) => ({ method: r.method, url: redactUrl(r.url.startsWith("/api/v3/") ? r.url : r.url.split("?")[0]), remoteAddress: r.ip }),
    },
  }, // Sonarr-API queries kept (keys redacted) to debug clients
  trustProxy: trustProxyOption() as string[] | false,
  bodyLimit: 1_000_000,
  // Sonarr matches paths regardless of case and its clients rely on it (nzb360 asks for /api/v3/episodeFile).
  routerOptions: { caseSensitive: false },
});
/** Every route as registered (method, path, config): the route tests check each one against the auth guard. */
export const registeredRoutes: { method: string; url: string; config: { public?: boolean; setup?: boolean } }[] = [];
app.addHook("onRoute", (r) => {
  for (const m of [r.method].flat())
    registeredRoutes.push({ method: String(m), url: r.url, config: (r.config ?? {}) as { public?: boolean; setup?: boolean } });
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
  // Plain words for connection errors ("SABnzbd unreachable (fetch failed)" → which address, what to check); the raw
  // text rides along as `detail` (the UI shows it behind "Details"). Fixes still match the raw text.
  const ctx = err as Error & { service?: string; url?: string };
  const h = humanizeError(err.message, { service: ctx.service, url: ctx.url });
  reply
    .code(err.statusCode && err.statusCode >= 400 ? err.statusCode : 500)
    .send({ error: redactUrl(h.message), ...(h.detail ? { detail: redactUrl(h.detail) } : {}), fixes: fixesFor(err.message) });
});

// ---------------------------------------------------------------- routes (server/routes/*.ts), in this order

registerAccountRoutes(app);
registerSettingsRoutes(app);
registerWizardRoutes(app);
registerLibraryRoutes(app);
registerGrabsRoutes(app);
registerNotifyRoutes(app);
registerAddingRoutes(app);
registerFilesRoutes(app);
registerActivityRoutes(app);
registerSystemRoutes(app);

// ---------------------------------------------------------------- web UI

if (!fs.existsSync(path.join(WEB_DIR, "index.html")))
  app.log.warn(`No web build in ${WEB_DIR} yet; run "npm run build" (the API works meanwhile).`);
fs.mkdirSync(WEB_DIR, { recursive: true });
// wildcard: true serves files built after startup too (vite build while the dev server runs).
// Sonarr v3-compatible API for request apps (Jellyseerr, Overseerr): see server/sonarrApi.ts.
registerSonarrApi(app, { urlBase: URL_BASE });

await app.register(fastifyStatic, { root: WEB_DIR, wildcard: true, index: false });

/** Where trailers play from (the ▶ Trailer dialog): nothing else may be framed. Dailymotion's embed redirects to geo.dailymotion.com. */
const TRAILER_FRAMES = "https://www.youtube-nocookie.com https://www.dailymotion.com https://geo.dailymotion.com";
/** The page itself, with <base href> set to the URL base (so relative asset URLs work on any path). */
const sendIndex = (reply: import("fastify").FastifyReply) => {
  const file = path.join(WEB_DIR, "index.html");
  if (!fs.existsSync(file)) return reply.code(503).send("Web UI not built yet: run npm run build");
  const html = fs
    .readFileSync(file, "utf8")
    .replace("<head>", `<head>\n    <base href="${URL_BASE.replace(/[^A-Za-z0-9._~/-]/g, "")}/" />`);
  // No framing (clickjacking), no referrer leaks; scripts only from ourselves. The only frames: trailer players.
  return reply
    .type("text/html; charset=utf-8")
    .header("Cache-Control", "no-cache")
    .header("X-Frame-Options", "DENY")
    .header(
      "Content-Security-Policy",
      `frame-ancestors 'none'; base-uri 'self'; object-src 'none'; script-src 'self'; frame-src ${TRAILER_FRAMES}`,
    )
    .header("Referrer-Policy", "no-referrer")
    .send(html);
};
app.get("/", { config: { public: true } }, async (_req, reply) => sendIndex(reply));
app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : sendIndex(reply)));

// ---------------------------------------------------------------- background jobs

const every = (ms: number, fn: () => Promise<unknown> | unknown, name: string) =>
  TEST_APP
    ? undefined
    : setInterval(() => {
        try {
          void Promise.resolve(fn()).catch((e) => app.log.warn(`${name}: ${(e as Error).message}`));
        } catch (e) {
          app.log.warn(`${name}: ${(e as Error).message}`);
        }
      }, ms);

async function startup() {
  // A cutover cut off between Sonarr's delete and AnimeArr's own switch is finished first.
  await resumeCutovers().catch((e) => app.log.warn(`cutover journal: ${(e as Error).message}`));
  try {
    await refreshMetadata();
  } catch (e) {
    app.log.warn(`metadata: ${(e as Error).message}`);
  }
  const last = lastSync();
  if (getSettings().sonarr.url && (!last || Date.now() - last > getSettings().sync.intervalHours * 3_600_000))
    await syncLibrary()
      .then(() => refreshCovers())
      .catch(() => undefined);
}
if (!TEST_APP) {
  recoverGrabs();
  materializeAll(); // native shows into the (rebuildable) cache
}
later(() => void startup(), 3_000);
every(
  60 * 60_000,
  async () => {
    const s = getSettings();
    const last = lastSync();
    if (s.sonarr.url && (!last || Date.now() - last > s.sync.intervalHours * 3_600_000)) await syncLibrary().then(() => refreshCovers());
    await refreshMetadata();
    // Nightly backup (keeps 7) and log pruning.
    const nightly = listBackups().find((b) => b.kind === "nightly");
    if (!nightly || Date.now() - nightly.at > 23 * 3_600_000) backupNow("nightly");
    pruneDecisions();
  },
  "hourly",
);
every(30_000, () => pipelineTick(), "pipeline");
every(10 * 60_000, () => repairTick(), "after-import check");
every(15 * 60_000, () => upgradeTick(), "dual upgrades");
every(30 * 60_000, () => qualityUpgradeTick(), "quality upgrades");
every(10 * 60_000, () => seadexTick(), "SeaDex");
every(10 * 60_000, () => movieTick(), "movie search");
every(15 * 60_000, () => breakerTick(breakerDeps), "indexer re-tests");
every(60 * 60_000, async () => binTick(), "recycling bin purge");
every(30 * 60_000, async () => (await fileScanTick(), void materializeAll()), "file scan");
every(30 * 60_000, () => fillInTick(), "fill-in");
every(15 * 60_000, () => importListsTick(), "import lists"); // (each list syncs every lists.intervalHours)
every(6 * 3_600_000, () => catalogTick(), "catalog");
later(() => void catalogTick().catch(() => undefined), 5 * 60_000);
later(() => void fileScanTick().catch(() => undefined), 90_000);
later(() => void importMediaDefaultsOnce(), 20_000);
every(5 * 60_000, () => managedTick(), "managed");
every(5 * 60_000, () => downloadsTick(), "download rules");
// AniDB: a few library entries every 15 minutes (never a crawl); shows blocked in the cutover first.
every(
  15 * 60_000,
  async () => {
    const st = anidbStatus();
    if (!st.configured || st.blockedUntil || st.capped) return; // nothing to do: no planning either
    const blocked = [...(await allShowCuts()).values()].filter((c) => c.blockers.length).map((c) => c.tvdbId);
    const aids = blocked.flatMap((t) =>
      (
        JSON.parse(
          (cache.prepare("SELECT anidb_ids FROM series WHERE tvdb_id = ?").get(t) as { anidb_ids: string } | undefined)?.anidb_ids ?? "[]",
        ) as { aid: number }[]
      ).map((x) => x.aid),
    );
    const r = await anidbTick(aids);
    if (r.fetched) materializeAll(); // native shows pick up AniDB's episodes
  },
  "anidb",
);
app.get("/api/anidb", async () => anidbStatus());
app.get<{ Params: { tvdbId: string } }>("/api/series/:tvdbId/anidb", async (req) => ({
  status: anidbStatus(),
  entries: anidbView(id(req.params.tvdbId)),
}));
app.post<{ Params: { tvdbId: string } }>("/api/series/:tvdbId/anidb/fetch", async (req) => {
  writable();
  const r = await fetchForTvdb(id(req.params.tvdbId));
  if (r.fetched) materializeAll();
  return r;
});
app.put<{ Params: { tvdbId: string }; Body: { aid: number; season?: number | null; offset?: number } }>(
  "/api/series/:tvdbId/anidb/override",
  async (req) => {
    writable();
    const b = req.body ?? ({} as never);
    const season = b.season === null || b.season === undefined ? null : Number(b.season);
    if (season !== null && (!Number.isInteger(season) || season < 0 || season > 99)) throw fail("Season 0–99", 400);
    const offset = Number(b.offset ?? 0);
    if (!Number.isInteger(offset) || offset < -5000 || offset > 5000) throw fail("Offset −5000–5000", 400);
    setAnidbOverride(id(b.aid), id(req.params.tvdbId), season, offset);
    logDecision("info", {
      tvdbId: id(req.params.tvdbId),
      why:
        season === null
          ? `AniDB ${b.aid}: back to Anime-Lists' placement`
          : `AniDB ${b.aid} placed on season ${season}${offset ? ` (offset ${offset})` : ""} by you`,
    });
    materializeAll();
    return { entries: anidbView(id(req.params.tvdbId)) };
  },
);
later(() => void downloadsTick().catch(() => undefined), 30_000);
let lastRss = 0;
every(
  60_000,
  async () => {
    const m = getSettings().managed.rssMin;
    if (m > 0 && Date.now() - lastRss >= m * 60_000) {
      lastRss = Date.now();
      await rssTick();
    }
  },
  "rss",
);

// First start: the default login. It only works from the home network until it's changed (see defaultLoginRefusal),
// so a port forward doesn't open a known password to the internet. Installs that already have an account are untouched.
// (This replaces the old one-time setup code: with a home-network-only default there is nothing left to claim remotely.)
export { app };
if (TEST_APP) await app.ready();
else if (await ensureDefaultAccount())
  app.log.warn(
    `First start: log in with ${DEFAULT_LOGIN.username} / ${DEFAULT_LOGIN.password} from your home network, then change the password (Settings → Security).`,
  );
if (!TEST_APP) await app.listen({ host: "0.0.0.0", port: PORT });
if (!TEST_APP && (await usingDefaultPassword()))
  app.log.warn(
    `The login is still the default password (${DEFAULT_LOGIN.password}). It only works from your home network until you change it in Settings → Security.`,
  );
