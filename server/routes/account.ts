/** Routes: Status, login/logout, account and API key. */
import { wizardState } from "../system/wizard.js";
import { airingShowCount } from "../home.js";
import { downloadsStatus } from "../downloads.js";
import { authState, COOKIE, csrfOk, defaultLoginRefusal, loginAllowed, loginSucceeded } from "../system/auth.js";
import { cache, db, dbState, startupWarnings } from "../system/db.js";
import { lastSync, syncRunning } from "../library.js";
import { listManaged } from "../managedList.js";

import {
  checkPassword,
  DEFAULT_LOGIN,
  getSettings,
  usingDefaultPassword,
  patchSettings,
  safeEqual,
  setAccount,
  setBypassLocal,
} from "../system/settings.js";
import { VERSION } from "../system/version.js";
import type { FastifyInstance } from "fastify";
import { fail, writable, sessionCookie, webBuild } from "./common.js";

export function registerAccountRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- status & account

  app.get("/ping", async () => ({ status: "OK" }));

  app.get("/api/status", { config: { setup: true } }, async (req) => {
    const s = getSettings();
    const a = authState(req);
    const base = { version: VERSION, build: webBuild(), setupRequired: a.setupRequired, loggedIn: a.ok };
    // The login screen tells home-network visitors the default login while it's still in use (it only works from home).
    if (!a.ok)
      return (await usingDefaultPassword()) && !defaultLoginRefusal(req, true) ? { ...base, defaultLogin: DEFAULT_LOGIN.username } : base;
    return {
      ...base,
      via: a.via,
      connected: {
        sonarr: !!(s.sonarr.url && s.sonarr.apiKey),
        radarr: !!(s.radarr.url && s.radarr.apiKey),
        prowlarr: !!(s.prowlarr.url && s.prowlarr.apiKey),
        sabnzbd: !!(s.sabnzbd.url && s.sabnzbd.apiKey),
        qbittorrent: !!s.qbittorrent.url,
      },
      dryRun: s.managed.dryRun,
      grabsPaused: (() => {
        const d = downloadsStatus();
        if (!d.why) return null;
        const disk = d.measure?.disk;
        return {
          why: d.why,
          disk: disk
            ? {
                freeGb: Math.round(disk.freeGb),
                animearrGb: Math.round(disk.animearrGb),
                otherGb: Math.round(disk.otherGb),
                label: disk.label,
                shareFreeGb: disk.share ? Math.round(disk.share.freeGb) : null,
              }
            : null,
          diskRule: d.rules.some((r) => r.id === "free-space" && r.paused),
        };
      })(),
      allowedRoots: s.allowedRoots,
      lastSync: lastSync(),
      syncing: syncRunning(),
      managed: listManaged().length,
      librarySeries: (cache.prepare("SELECT COUNT(*) AS n FROM series").get() as { n: number }).n,
      warnings: [
        ...startupWarnings,
        ...(dbState.corrupt
          ? [
              `The database failed its integrity check (${dbState.detail}). AnimeArr is read-only until you restore a backup (System → Backups).`,
            ]
          : []),
      ],
      uiLanguage: s.ui.language,
      textScale: s.ui.textScale ?? null,
      // Still the default login (captain/morebooty): the banner and the wizard's account step ask to change it.
      defaultPassword: await usingDefaultPassword(),
      // Shows in dry-run (the global switch, or their own), so the UI only mentions dry-run when something is in it.
      dryRunShows: listManaged()
        .filter((m) => m.dryRun)
        .map((m) => ({ tvdbId: m.tvdbId, title: m.title })),
      bypassLocal: s.auth.bypassLocal,
      wizardDone: wizardState().done,
      freshInstall:
        !wizardState().done &&
        !s.sonarr.url &&
        !s.radarr.url &&
        !s.prowlarr.url &&
        !s.sabnzbd.url &&
        !s.qbittorrent.url &&
        !(s.extraClients ?? []).length &&
        !(s.indexers ?? []).length,
      // The season card: shows with an episode airing this week or last.
      airingShows: airingShowCount(),
      // The nav's Queue badge: what's downloading, and what needs a look.
      queue: db
        .prepare(
          "SELECT COALESCE(SUM(state IN ('sending', 'downloading', 'importing')), 0) AS active, COALESCE(SUM(state = 'needs-attention'), 0) AS attention FROM grabs WHERE dry_run = 0",
        )
        .get() as { active: number; attention: number },
    };
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", { config: { setup: true } }, async (req, reply) => {
    if (!csrfOk(req)) throw fail("Cross-site request blocked", 403);
    if (!loginAllowed(req.ip, String(req.body?.username ?? ""))) throw fail("Too many attempts, wait a few seconds and try again", 429);
    const a = getSettings().auth;
    const okUser = safeEqual(String(req.body?.username ?? ""), a.username);
    const okPass = await checkPassword(String(req.body?.password ?? ""), a.passwordHash || "00:00");
    if (!okUser || !okPass) throw fail("Wrong username or password", 401);
    // Safety rule: the default password only works from the home network, until it's changed.
    const refused = defaultLoginRefusal(req, await usingDefaultPassword());
    if (refused) throw fail(refused, 403);
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
    if (password === DEFAULT_LOGIN.password) throw fail("Pick a password other than the default one");
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
}
