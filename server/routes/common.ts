/**
 * Helpers shared by server/index.ts and the route modules: request checks (ids, read-only mode, outbound URLs, stored
 * secrets), the session cookie, the test-app switch, the port and start time, the web build id, the breaker's probes.
 */
import { blockedOutboundHost } from "../system/outbound.js";
import { type Fetcher } from "../search/health.js";
import { indexerNumId, searchIndexer } from "../search/indexers.js";
import fs from "node:fs";
import path from "node:path";
import { type FastifyReply, type FastifyRequest } from "fastify";
import { COOKIE, makeSession } from "../system/auth.js";
import { dbState, setJob } from "../system/db.js";
import { fetchReleaseFile, prowlarrConfigured, prowlarrSearch } from "../arr/prowlarr.js";
import { refreshCatalog, tmdbEpisodes } from "../metadata/catalog.js";

import { materializeAll } from "../native.js";
import { getSettings, isMasked } from "../system/settings.js";
import { ROOT_DIR } from "../system/version.js";

/**
 * ANIMEARR_TEST_APP=1: the routes are built (and `app` exported) but nothing is started: no background jobs, no
 * startup work, no listening socket. Only the route tests use it (test/routes-guard.test.ts).
 */
export const TEST_APP = process.env.ANIMEARR_TEST_APP === "1";
export const later = (fn: () => void, ms: number) => (TEST_APP ? undefined : setTimeout(fn, ms));
export const WEB_DIR = path.join(ROOT_DIR, "dist", "web");
export const PORT = Number(process.env.PORT ?? 8484);
export const STARTED = Date.now();

export const fail = (msg: string, code = 400) => Object.assign(new Error(msg), { statusCode: code });
export const id = (v: unknown) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw fail("Bad id");
  return n;
};
export const writable = () => {
  if (dbState.corrupt)
    throw fail("The database failed its integrity check, so AnimeArr is read-only. Restore a backup in System → Backups.", 503);
};

/** Outbound service URLs: http(s) only, never link-local / cloud metadata addresses. */
export function checkOutbound(url: string) {
  let u: URL;
  if (!url.trim()) throw fail("Enter the address first, e.g. http://192.168.1.10:8080");
  try {
    u = new URL(url);
  } catch {
    throw fail(`"${url}" isn't a full address. It should look like http://192.168.1.10:8080 (with http:// and the port).`);
  }
  if (!/^https?:$/.test(u.protocol)) throw fail("Address must start with http:// or https://");
  if (blockedOutboundHost(u.hostname)) throw fail("That address isn't allowed");
  return url;
}

/** A stored secret is only re-used for the URL it was saved with, so it can't be sent somewhere new. */
export function withSecret(url: unknown, secret: unknown, storedUrl: string, storedSecret: string, required = true) {
  const u = checkOutbound(
    String(url || storedUrl)
      .trim()
      .replace(/\/+$/, ""),
  );
  const s = String(secret ?? "");
  if (s && !isMasked(s)) return { url: u, secret: s };
  if (u === storedUrl && storedSecret) return { url: u, secret: storedSecret };
  if (!required) return { url: u, secret: "" };
  throw fail("Enter the API key again for a new address");
}

export function sessionCookie(req: FastifyRequest, reply: FastifyReply, username: string) {
  reply.setCookie(COOKIE, makeSession(username), {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: req.protocol === "https",
    maxAge: 30 * 86400,
  });
}

/** What the indexer circuit breaker uses to probe an indexer that's off (routes and the background job). */
export const breakerDeps = {
  fetch: (r: Parameters<Fetcher>[0]) =>
    fetchReleaseFile({
      guid: r.guid,
      title: r.title,
      size: r.size ?? 0,
      indexerId: r.indexerId,
      indexer: r.indexer,
      protocol: r.protocol,
      downloadUrl: r.downloadUrl ?? undefined,
      magnetUrl: r.magnetUrl ?? undefined,
    }),
  search: async (indexerId: number) => {
    const ix = (getSettings().indexers ?? []).find((x) => indexerNumId(x.id) === indexerId);
    // A Prowlarr indexer that kept timing out: one small recent-releases search through Prowlarr.
    if (!ix && prowlarrConfigured() && indexerId < 1_000_000)
      return (await prowlarrSearch("", { indexerIds: [indexerId], limit: 5, timeoutMs: 60_000 }), true);
    if (!ix) return false;
    await searchIndexer(ix, ix.kind === "rss" ? "anime" : "", { limit: 5 });
    return true;
  },
};

/** The web build being served: the hashed name of its entry script (open tabs compare it to theirs to offer a reload). */
export let buildCache: { mtime: number; id: string | null } | null = null;
export function webBuild(): string | null {
  try {
    const file = path.join(WEB_DIR, "index.html");
    const mtime = fs.statSync(file).mtimeMs;
    if (buildCache?.mtime !== mtime)
      buildCache = { mtime, id: /assets\/index-([\w-]+)\.js/.exec(fs.readFileSync(file, "utf8"))?.[1] ?? null };
    return buildCache.id;
  } catch {
    return null;
  }
}

export let catalogRunning = false;
/** Own metadata: AniList catalog (+ TMDB episode titles when a key is set). */
export async function catalogTick(force = false) {
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

/** Body of a connection test (the wizard and Settings). */
export type TestBody = { url?: string; apiKey?: string; username?: string; password?: string; category?: string };
