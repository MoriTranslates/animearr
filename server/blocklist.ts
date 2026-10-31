/**
 * The blocklist page: releases AnimeArr will not grab again (failed, rejected, malware, or removed by you), with the
 * show/movie, reason, date, protocol and indexer. Removing an entry lets the release be picked again.
 */
import type { FastifyInstance } from "fastify";
import { logDecision } from "./activity.js";
import { cache, db, dbState } from "./db.js";

export interface BlocklistEntry { id: number; release: string; tvdbId: number | null; movieId: number | null; title: string; reason: string; at: number; protocol: string | null; indexer: string | null }
interface Row { id: number; release: string; tvdb_id: number | null; movie_id: number | null; reason: string; at: number; protocol: string | null; indexer: string | null }

const titleOf = (r: Row) =>
  r.movie_id
    ? ((cache.prepare("SELECT title FROM movies WHERE id = ?").get(r.movie_id) as { title: string } | undefined)?.title ?? `Movie ${r.movie_id}`)
    : r.tvdb_id
      ? ((cache.prepare("SELECT title FROM series WHERE tvdb_id = ?").get(r.tvdb_id) as { title: string } | undefined)?.title ?? `Show ${r.tvdb_id}`)
      : "";

/** Newest first. `tvdbId` / `movieId` filter by show or movie; `before` is the last id of the previous page. */
export function listBlocklist(opts: { tvdbId?: number; movieId?: number; before?: number; limit?: number } = {}) {
  const where: string[] = [];
  const args: number[] = [];
  if (opts.tvdbId) (where.push("tvdb_id = ?"), args.push(opts.tvdbId));
  if (opts.movieId) (where.push("movie_id = ?"), args.push(opts.movieId));
  const filtered = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM blocklist${filtered}`).get(...args) as { n: number }).n;
  if (opts.before) (where.push("id < ?"), args.push(opts.before));
  const rows = db.prepare(`SELECT id, release, tvdb_id, movie_id, reason, at, protocol, indexer FROM blocklist${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(500, opts.limit ?? 100)) as unknown as Row[];
  const items: BlocklistEntry[] = rows.map((r) => ({ id: r.id, release: r.release, tvdbId: r.tvdb_id, movieId: r.movie_id, title: titleOf(r), reason: r.reason, at: r.at, protocol: r.protocol, indexer: r.indexer }));
  return { items, total };
}

/** The shows and movies that have blocklisted releases (for the filter), most entries first. */
export function blocklistShows() {
  const rows = db.prepare("SELECT tvdb_id, movie_id, COUNT(*) AS n FROM blocklist WHERE tvdb_id IS NOT NULL OR movie_id IS NOT NULL GROUP BY tvdb_id, movie_id ORDER BY n DESC").all() as { tvdb_id: number | null; movie_id: number | null; n: number }[];
  return rows.map((r) => ({ tvdbId: r.tvdb_id, movieId: r.movie_id, title: titleOf({ tvdb_id: r.tvdb_id, movie_id: r.movie_id } as Row), count: r.n }));
}

/** Un-blocklists entries by id (one or many). Logged in Activity. Returns how many were removed. */
export function removeFromBlocklist(ids: number[]): number {
  if (dbState.corrupt) throw Object.assign(new Error("The database failed its integrity check, so AnimeArr is read-only"), { statusCode: 503 });
  const clean = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 1000);
  if (!clean.length) return 0;
  const rows = db.prepare(`SELECT id, release, tvdb_id, movie_id, reason, at, protocol, indexer FROM blocklist WHERE id IN (${clean.map(() => "?").join(",")})`).all(...clean) as unknown as Row[];
  if (!rows.length) return 0;
  db.prepare(`DELETE FROM blocklist WHERE id IN (${rows.map(() => "?").join(",")})`).run(...rows.map((r) => r.id));
  const one = rows.length === 1 ? rows[0] : null;
  logDecision("info", {
    tvdbId: one?.tvdb_id ?? null,
    title: one ? titleOf(one) : undefined,
    release: one?.release ?? null,
    why: one ? `You removed ${one.release} from the blocklist; it can be picked again` : `You removed ${rows.length} releases from the blocklist; they can be picked again`,
    detail: one?.movie_id ? { movieId: one.movie_id } : {},
  });
  return rows.length;
}

export function registerBlocklistApi(app: FastifyInstance) {
  const bad = (msg: string) => Object.assign(new Error(msg), { statusCode: 400 });
  const num = (v: unknown) => {
    if (v === undefined || v === "") return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw bad("Bad id");
    return n;
  };
  app.get<{ Querystring: { tvdbId?: string; movieId?: string; before?: string; limit?: string } }>("/api/blocklist", async (req) => ({
    ...listBlocklist({ tvdbId: num(req.query.tvdbId), movieId: num(req.query.movieId), before: num(req.query.before), limit: num(req.query.limit) }),
    shows: blocklistShows(),
  }));
  app.delete<{ Params: { id: string } }>("/api/blocklist/:id", async (req) => {
    const removed = removeFromBlocklist([num(req.params.id)!]);
    if (!removed) throw Object.assign(new Error("That release isn't on the blocklist any more"), { statusCode: 404 });
    return { removed };
  });
  app.post<{ Body: { ids?: unknown; tvdbId?: unknown; movieId?: unknown; all?: unknown } }>("/api/blocklist/remove", async (req) => {
    const b = req.body ?? {};
    if (Array.isArray(b.ids)) return { removed: removeFromBlocklist(b.ids.map(Number)) };
    // "Remove all of this show's entries": an explicit filter, never an open-ended wipe.
    const tvdbId = num(b.tvdbId);
    const movieId = num(b.movieId);
    if (b.all === true && (tvdbId || movieId)) return { removed: removeFromBlocklist(listBlocklist({ tvdbId, movieId, limit: 500 }).items.map((x) => x.id)) };
    throw bad("Send ids, or all: true with a show (tvdbId) or movie (movieId)");
  });
}
