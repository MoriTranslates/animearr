/** Routes: Settings, connection tests, indexers and download clients, media-server files, dropped shows, the indexer circuit breaker, phone addresses and single-file tools. */
import os from "node:os";
import { setIndexerUse } from "../search/indexerPick.js";
import { droppedList, dropShow, undropShow } from "../library/dropped.js";
import { breakerList, setBreaker, testIndexer as retestIndexer } from "../search/health.js";
import { watchLinks } from "../media/watchIn.js";
import { indexerNumId } from "../search/indexers.js";
import { fileDetail, peekFrames, rescanOne, setTrackLanguage, useSidecar } from "../import/detection.js";
import { indexerCatalog } from "../search/indexerCatalog.js";
import { homeSummary } from "../library/home.js";
import { thumb, type ThumbSize } from "../metadata/img.js";
import { invalidateConnections } from "../system/connections.js";
import { testTmdb } from "../metadata/catalog.js";
import { metadataSyncRunning, syncAllMetadata, syncSeriesMetadata } from "../media/mediaout.js";
import { reevaluate } from "../grabs/downloads.js";
import fs from "node:fs";
import path from "node:path";
import { authState } from "../system/auth.js";
import { logDecision } from "../system/activity.js";
import { prowlarrConfigured, prowlarrIndexers } from "../arr/prowlarr.js";
import { releaseDryRunDecisions } from "../library/managed.js";
import { listManaged } from "../library/managedList.js";
import { invalidateIndex } from "../metadata/metadata.js";
import { libraryRoots } from "../import/mediafiles.js";

import { getSettings, isMasked, publicSettings, regenerateApiKey, updateSettings, type Settings } from "../system/settings.js";
import type { FastifyInstance } from "fastify";
import { PORT, fail, id, writable, breakerDeps } from "./common.js";

export function registerSettingsRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- settings & connection tests

  app.get("/api/settings", async () => publicSettings());
  app.put<{ Body: Partial<Settings> }>("/api/settings", async (req) => {
    writable();
    const before = getSettings();
    const next = updateSettings(req.body);
    if (JSON.stringify(before.downloads) !== JSON.stringify(next.downloads)) reevaluate(); // rule edits apply at once
    if (before.managed.dryRun !== next.managed.dryRun) {
      logDecision("info", {
        why: next.managed.dryRun
          ? "Global dry-run turned ON: nothing will be grabbed"
          : "Global dry-run turned OFF: shows whose own dry-run is off will be grabbed for real",
      });
      if (!next.managed.dryRun) for (const m of listManaged()) if (!m.dryRun) releaseDryRunDecisions(m.tvdbId);
    }
    if (before.allowedRoots.join("|") !== next.allowedRoots.join("|"))
      logDecision("info", { why: `Allowed root folders: ${next.allowedRoots.join(", ") || "none"}` });
    invalidateIndex();
    return publicSettings();
  });
  app.get("/api/settings/apikey", async (req) => ({ apiKey: authState(req).via === "session" ? getSettings().apiKey : null }));
  app.post("/api/settings/apikey/regenerate", async (req) => {
    writable();
    if (authState(req).via !== "session") throw fail("Log in to manage the API key", 403);
    return { apiKey: regenerateApiKey() };
  });

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
    reply
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("ETag", r.etag)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "sandbox; default-src 'none'")
      .type(r.type);
    return reply.send(fs.createReadStream(r.file));
  });

  app.get<{ Querystring: { from?: string; managed?: string } }>("/api/home", async (req) =>
    homeSummary(Date.now(), Number(req.query.from) || undefined, req.query.managed === "1"),
  );

  // ---------------------------------------------------------------- indexers & download clients (Settings cards)
  app.get("/api/catalog/indexers", async () => indexerCatalog());
  // ---------------------------------------------------------------- media-server files (NFO, .plexmatch, artwork)
  app.get("/api/mediaout", async () => ({ running: metadataSyncRunning() }));
  app.post("/api/mediaout/sync", async () => (writable(), syncAllMetadata()));
  app.post<{ Params: { tvdbId: string } }>("/api/series/:tvdbId/mediaout", async (req) => {
    writable();
    const r = await syncSeriesMetadata(id(req.params.tvdbId));
    if (!r)
      throw fail(
        "Nothing to write: switch on NFO files, .plexmatch or artwork in Settings → Media servers (and the show must be in an allowed root folder)",
        409,
      );
    return r;
  });
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
    const known = [
      ...(prowlarrConfigured() ? (await prowlarrIndexers()).map((x) => x.id) : []),
      ...(getSettings().indexers ?? []).map((x) => indexerNumId(x.id)),
    ];
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
    const clean =
      s.startsWith("/") && !s.includes("\\") && !s.split("/").some((seg) => seg === ".." || seg === ".") && path.posix.normalize(s) === s;
    if (!clean || !libraryRoots().some((r) => s.startsWith(`${r.replace(/\/+$/, "")}/`)))
      throw fail("That file isn't in a library folder", 400);
    return s;
  };
  app.get<{ Querystring: { path?: string; title?: string; kind?: string } }>("/api/watch", async (req) =>
    watchLinks(libraryFile(req.query.path), String(req.query.title ?? ""), req.query.kind === "movie" ? "movie" : "episode"),
  );
  app.get<{ Querystring: { path?: string } }>("/api/files/detail", async (req) => fileDetail(libraryFile(req.query.path)));
  app.post<{ Body: Record<string, unknown> }>("/api/files/track", async (req) => {
    writable();
    const b = req.body ?? {};
    return setTrackLanguage({
      path: libraryFile(b.path),
      trackIndex: Number(b.trackIndex),
      lang: b.lang ? String(b.lang) : null,
      forced: b.forced === true,
      scope: b.scope === "season" || b.scope === "group" ? b.scope : "file",
      tvdbId: b.tvdbId ? Number(b.tvdbId) : null,
      season: b.season !== undefined && b.season !== null ? Number(b.season) : null,
      group: b.group ? String(b.group) : null,
      title: b.title ? String(b.title) : undefined,
      alsoTag: b.alsoTag === true,
    });
  });
  app.post<{ Body: Record<string, unknown> }>("/api/files/sidecar", async (req) => {
    writable();
    const b = req.body ?? {};
    return useSidecar({
      video: libraryFile(b.video),
      file: String(b.file ?? ""),
      lang: String(b.lang ?? "en"),
      tvdbId: b.tvdbId ? Number(b.tvdbId) : null,
      title: b.title ? String(b.title) : undefined,
    });
  });
  app.post<{ Body: { path?: string } }>("/api/files/rescan", async (req) => (writable(), rescanOne(libraryFile(req.body?.path))));
  app.get<{ Querystring: { path?: string } }>("/api/files/peek", async (req) => ({
    frames: await peekFrames(libraryFile(req.query.path), null),
  }));
}
