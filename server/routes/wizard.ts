/** Routes: The setup wizard. */
import { applyArrPreview, arrPreview, createCategory, listFolders, saveWizard, wizardState } from "../wizard.js";
import {
  addJackettTracker,
  deleteClient,
  deleteIndexer,
  jackettTrackers,
  listClients,
  listIndexers,
  saveClient,
  saveIndexer,
  setClientPrefs,
  testExtraClient,
  testIndexer,
} from "../connectionsAdmin.js";
import { connectionsOverview, invalidateConnections } from "../connections.js";
import { testPlex } from "../plex.js";
import { testEmbyLike, testKodi } from "../mediaservers.js";
import { CONFIG_DIR } from "../db.js";
import { testProwlarr } from "../arr/prowlarr.js";
import { radarrConfigured, radarrOptions, radarrRootFolders, testRadarr } from "../arr/radarr.js";
import { sonarrOptions, testSonarr } from "../arr/sonarr.js";
import { testQbit, testSab } from "../arr/clients.js";
import { rootRefusal } from "../roots.js";

import { getSettings } from "../settings.js";
import type { FastifyInstance } from "fastify";
import { fail, writable, withSecret, type TestBody } from "./common.js";

export function registerWizardRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- setup wizard
  app.get("/api/wizard", async () => wizardState());
  app.put<{ Body: Record<string, unknown> }>("/api/wizard", async (req) => (writable(), saveWizard(req.body ?? {})));
  app.get<{ Querystring: { path?: string } }>("/api/fs/folders", async (req) => listFolders(String(req.query.path ?? "/")));
  app.post<{ Body: { client?: string } }>(
    "/api/wizard/category",
    async (req) => (writable(), createCategory(req.body?.client === "qbittorrent" ? "qbittorrent" : "sabnzbd")),
  );
  app.get("/api/wizard/arr-preview", async () => arrPreview());
  app.post<{
    Body: {
      roots?: string[];
      sab?: { url: string; category: string } | null;
      qbit?: { url: string; category: string } | null;
      others?: { type: string; name?: string; url: string }[];
    };
  }>("/api/wizard/arr-apply", async (req) => (writable(), invalidateConnections(), applyArrPreview(req.body ?? {})));
  app.get("/api/indexers", async () => ({ indexers: listIndexers() }));
  app.post<{ Body: Record<string, unknown> }>(
    "/api/indexers",
    async (req) => (writable(), invalidateConnections(), saveIndexer(null, req.body ?? {})),
  );
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/indexers/:id",
    async (req) => (writable(), invalidateConnections(), saveIndexer(req.params.id, req.body ?? {})),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/indexers/:id",
    async (req) => (writable(), invalidateConnections(), deleteIndexer(req.params.id), { ok: true }),
  );
  /** Runs a connection test; its error carries the service and address tested (for humanizeError). */
  async function tested<T>(service: string, url: unknown, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw Object.assign(e as Error, { service, url: String(url ?? "").trim() });
    }
  }
  app.post<{ Body: Record<string, unknown> }>("/api/indexers/test", async (req) =>
    tested(String(req.body?.name || "The indexer"), req.body?.url, () => testIndexer(req.body ?? {})),
  );
  app.post<{ Body: Record<string, unknown> }>("/api/jackett/trackers", async (req) => {
    // Empty fields: say which (the button used to do nothing).
    if (!String(req.body?.url ?? "").trim()) throw fail("Enter Jackett's address first, e.g. http://192.168.1.10:9117");
    if (!String(req.body?.apiKey ?? "").trim()) throw fail("Enter Jackett's API key first (top right of Jackett's page).");
    return tested("Jackett", req.body?.url, async () => ({ trackers: await jackettTrackers(req.body ?? {}) }));
  });
  app.post<{ Body: Record<string, unknown> }>(
    "/api/jackett/add",
    async (req) => (writable(), invalidateConnections(), addJackettTracker(req.body ?? {})),
  );
  app.get("/api/clients", async () => ({ clients: listClients() }));
  app.post<{ Body: Record<string, unknown> }>(
    "/api/clients",
    async (req) => (writable(), invalidateConnections(), saveClient(null, req.body ?? {})),
  );
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/clients/:id",
    async (req) => (writable(), invalidateConnections(), saveClient(req.params.id, req.body ?? {})),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/clients/:id",
    async (req) => (writable(), invalidateConnections(), deleteClient(req.params.id), { ok: true }),
  );
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/clients/:id/prefs",
    async (req) => (writable(), invalidateConnections(), setClientPrefs(req.params.id, req.body ?? {})),
  );
  app.post<{ Body: Record<string, unknown> }>("/api/clients/test", async (req) =>
    tested(String(req.body?.name || req.body?.type || "The download client"), req.body?.url, () => testExtraClient(req.body ?? {})),
  );

  app.get<{ Querystring: { fresh?: string } }>("/api/connections", async (req) => connectionsOverview(req.query.fresh === "1"));

  const SERVICE_NAMES: Record<string, string> = {
    sonarr: "Sonarr",
    radarr: "Radarr",
    prowlarr: "Prowlarr",
    sabnzbd: "SABnzbd",
    plex: "Plex",
    qbittorrent: "qBittorrent",
    jellyfin: "Jellyfin",
    emby: "Emby",
    kodi: "Kodi",
  };
  app.post<{ Params: { service: string }; Body: TestBody }>("/api/test/:service", async (req) => {
    const svc = req.params.service;
    try {
      return await testService(svc, req.body ?? {});
    } catch (e) {
      // The error names the service and the address tested (humanizeError, in the error handler).
      const stored = (getSettings() as unknown as Record<string, { url?: string }>)[svc]?.url ?? "";
      throw Object.assign(e as Error, { service: SERVICE_NAMES[svc], url: String(req.body?.url ?? stored).trim() });
    }
  });
  async function testService(service: string, b: TestBody) {
    const s = getSettings();
    switch (service) {
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
      case "jellyfin":
      case "emby": {
        const c = withSecret(b.url, b.apiKey, s[service].url, s[service].apiKey);
        return testEmbyLike(service, { url: c.url, apiKey: c.secret });
      }
      case "kodi": {
        const c = withSecret(b.url, b.password, s.kodi.url, s.kodi.password, false);
        return testKodi({ url: c.url, username: String(b.username ?? s.kodi.username), password: c.secret });
      }
      case "qbittorrent": {
        const c = withSecret(b.url, b.password, s.qbittorrent.url, s.qbittorrent.password, false);
        return testQbit({
          url: c.url,
          username: String(b.username ?? s.qbittorrent.username),
          password: c.secret,
          category: String(b.category || s.qbittorrent.category),
        });
      }
    }
    throw fail("Unknown service", 404);
  }

  /**
   * Root folders, for the "allowed root folders" picker (suggests /media/AnimeArr when present; never auto-enabled).
   * `/api/rootfolders` is the documented name (docs/API.md); `/api/sonarr/rootfolders` stays for older callers.
   */
  const rootFolders = async () => {
    const o = await sonarrOptions().catch(() => ({ roots: [] as { id: number; path: string; freeSpace?: number }[] }));
    // Radarr's root folders too (movies), when Radarr is set up.
    const movieRoots = radarrConfigured() ? await radarrRootFolders().catch(() => []) : [];
    const roots = [
      ...o.roots.map((r) => ({ ...r, app: "sonarr" })),
      ...movieRoots
        .filter((r) => !o.roots.some((x) => x.path === r.path))
        .map((r) => ({ id: r.id, path: r.path, freeSpace: r.freeSpace, app: "radarr" })),
    ];
    // `refused`: saved folders that can't be a library (e.g. /config from before that was checked), with why.
    const refused = Object.fromEntries(
      getSettings()
        .allowedRoots.map((r) => [r, rootRefusal(r, CONFIG_DIR)])
        .filter(([, why]) => why),
    );
    return {
      roots,
      suggested: o.roots.find((r) => /\/AnimeArr\/?$/i.test(r.path))?.path ?? null,
      allowed: getSettings().allowedRoots,
      refused,
    };
  };
  app.get("/api/rootfolders", rootFolders);
  app.get("/api/sonarr/rootfolders", rootFolders);
}
