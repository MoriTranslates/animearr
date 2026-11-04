/** Routes: Status, login/logout, account and API key. */
import { wizardState } from "../system/wizard.js";
import { airingShowCount } from "../library/home.js";
import { downloadsStatus } from "../grabs/downloads.js";
import {
  authState,
  checkPasswordLimited,
  COOKIE,
  csrfOk,
  defaultLoginRefusal,
  DEVICE_COOKIE,
  loginAllowed,
  loginSucceeded,
  validDevice,
} from "../system/auth.js";
import { cache, db, dbState, startupWarnings } from "../system/db.js";
import { lastSync, syncRunning } from "../library/library.js";
import { listManaged } from "../library/managedList.js";
import { binWarnings } from "../import/binpurge.js";
import { sonarrConfigured } from "../arr/sonarr.js";
import { radarrConfigured } from "../arr/radarr.js";

import {
  DEFAULT_LOGIN,
  endAllSessions,
  getSettings,
  usingDefaultPassword,
  patchSettings,
  safeEqual,
  setAccount,
  setBypassLocal,
  settingsStandIn,
} from "../system/settings.js";
import { VERSION } from "../system/version.js";
import type { FastifyInstance } from "fastify";
import { deviceCookie, fail, writable, sessionCookie, webBuild } from "./common.js";

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
    // No device cookie is issued here, even to a session that lacks one (blind review round 3, H1): a session alone
    // could mint unlimited devices that guess outside the global budget and outlive logout. Only a correct password
    // (login or password change) issues one. A browser signed in before device cookies existed gets one at its next login.
    return {
      ...base,
      via: a.via,
      connected: {
        sonarr: sonarrConfigured(),
        radarr: radarrConfigured(),
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
        ...binWarnings(),
        ...((st) =>
          st
            ? [
                `While the database is damaged, AnimeArr uses the settings of the backup ${st.backup} (${new Date(st.at).toISOString().slice(0, 16).replace("T", " ")}): its password and options, which may be older than your latest changes. The no-password home-network login is off until you restore a backup.`,
              ]
            : [])(settingsStandIn()),
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

  // Reachable without a login, so it reads at most a few KB (a username and a password).
  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/auth/login",
    { config: { setup: true }, bodyLimit: 8 * 1024 },
    async (req, reply) => {
      if (!csrfOk(req)) throw fail("Cross-site request blocked", 403);
      // A browser the owner logged in with before has its own throttle entry and password lane (review B4).
      const device = validDevice(req.cookies[DEVICE_COOKIE]);
      if (!loginAllowed(req.ip, String(req.body?.username ?? ""), device))
        throw fail("Too many attempts, wait a few seconds and try again", 429);
      const a = getSettings().auth;
      const okUser = safeEqual(String(req.body?.username ?? ""), a.username);
      // A login that waited so long its browser hung up isn't checked at all (blind review R6).
      const gone = () => req.raw.socket?.destroyed === true;
      const okPass = await checkPasswordLimited(String(req.body?.password ?? ""), a.passwordHash || "00:00", req.ip, { device, gone });
      if (!okUser || !okPass) throw fail("Wrong username or password", 401);
      // Safety rule: the default password only works from the home network, until it's changed.
      const refused = defaultLoginRefusal(req, await usingDefaultPassword());
      if (refused) throw fail(refused, 403);
      loginSucceeded(req.ip, a.username, device);
      sessionCookie(req, reply, a.username);
      deviceCookie(req, reply, device);
      return { ok: true };
    },
  );

  app.post("/api/auth/logout", async (req, reply) => {
    reply.clearCookie(COOKIE, { path: "/" });
    // Session tokens are signed, not stored, so a logout ends them all: a copied token stops working too (review L1).
    // Only a browser session does this; the API key or the home-network bypass can't sign the owner out.
    if (authState(req).via !== "session") return { ok: true, otherSessionsEnded: false };
    try {
      endAllSessions();
    } catch (e) {
      // The database can't be written (flagged corrupt, read-only): this browser is still logged out (its cookie is
      // cleared above), but other sessions stay valid. Not swallowed: logged, and said in the answer (blind review A11).
      req.log.error({ err: e }, "Logout couldn't end the other sessions");
      return {
        ok: true,
        otherSessionsEnded: false,
        warning: `Logged out here, but other browsers stay logged in: the database can't be written (${(e as Error).message}).`,
      };
    }
    return { ok: true, otherSessionsEnded: true };
  });

  app.put<{ Body: { currentPassword?: string; username?: string; password?: string } }>("/api/auth/account", async (req, reply) => {
    writable();
    const a = getSettings().auth;
    // Signed in already: throttled on the device, or on one "signed-in" entry, never on the anonymous real-name budget
    // a login flood can use up (review B7, R1). A stolen session guessing the current password still backs off there.
    const device = validDevice(req.cookies[DEVICE_COOKIE]);
    if (!loginAllowed(req.ip, a.username, device ?? "signed-in")) throw fail("Too many attempts, wait a few seconds and try again", 429);
    // Signed in already: never queued behind anonymous logins (review B7).
    if (!(await checkPasswordLimited(String(req.body?.currentPassword ?? ""), a.passwordHash, req.ip, { signedIn: true })))
      throw fail("Current password is wrong", 403);
    loginSucceeded(req.ip, a.username, device ?? "signed-in"); // clear the lane loginAllowed counted it in
    const username = String(req.body?.username ?? a.username).trim() || a.username;
    const password = String(req.body?.password ?? "");
    if (password && password.length < 8) throw fail("New password must be at least 8 characters");
    if (password === DEFAULT_LOGIN.password) throw fail("Pick a password other than the default one");
    if (password) await setAccount(username, password);
    else patchSettings((s) => ({ ...s, auth: { ...s.auth, username } }));
    sessionCookie(req, reply, username);
    deviceCookie(req, reply, device); // a new password voids old device cookies; this browser stays known
    return { ok: true };
  });

  app.put<{ Body: { bypassLocal?: boolean } }>("/api/auth/mode", async (req) => {
    writable();
    if (authState(req).via !== "session") throw fail("Log in with your password to change this", 403);
    setBypassLocal(req.body?.bypassLocal === true);
    return { ok: true };
  });
}
