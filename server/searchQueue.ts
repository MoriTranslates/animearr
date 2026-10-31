/**
 * One scheduler for every indexer query the app sends (⚡ jobs, scheduled, backlog and upgrade searches, Find releases,
 * movie searches): at most `search.maxQueries` at once across the whole app. Waiting queries are served round-robin
 * between lanes (a ⚡ job, one Deep Search, the scheduled searches), first come first served within a lane, so a
 * 26-episode ⚡ can't starve the next tap. Plus a short-lived cache of identical queries.
 * Waiting only: nothing here blocks the event loop.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { getSettings } from "./settings.js";

const laneStore = new AsyncLocalStorage<string>();
/** Queries outside any lane (scheduled searches, the recent-releases poll) share this one. */
const DEFAULT_LANE = "default";

/** Runs `fn` with its indexer queries in `lane` (a new lane of its own when none is given). */
export function inLane<T>(lane: string | null, fn: () => Promise<T>): Promise<T> {
  return laneStore.run(lane ?? `lane:${crypto.randomUUID()}`, fn);
}
/** The lane the caller runs in, if any. */
export const currentLane = () => laneStore.getStore() ?? null;

const maxQueries = () => Math.max(1, getSettings().search?.maxQueries || 6);

/** Lanes with waiting queries, in round-robin order (a lane that was just served goes to the back). */
const lanes = new Map<string, (() => void)[]>();
let running = 0;

function pump() {
  while (running < maxQueries() && lanes.size) {
    const [lane, waiting] = lanes.entries().next().value as [string, (() => void)[]];
    lanes.delete(lane);
    const start = waiting.shift()!;
    if (waiting.length) lanes.set(lane, waiting);
    running++;
    start();
  }
}

/** Runs one indexer query when a slot is free (its lane's turn). */
export function querySlot<T>(fn: () => Promise<T>): Promise<T> {
  const lane = laneStore.getStore() ?? DEFAULT_LANE;
  return new Promise<T>((resolve, reject) => {
    const start = () =>
      void Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          running--;
          pump();
        });
    const q = lanes.get(lane);
    if (q) q.push(start);
    else lanes.set(lane, [start]);
    pump();
  });
}

/** For Settings/tests: queries running and waiting right now. */
export function schedulerStats() {
  return { running, waiting: [...lanes.values()].reduce((a, q) => a + q.length, 0), max: maxQueries() };
}

/** Identical queries within this window reuse the results (and a query still running is shared). */
export const QUERY_TTL = 10 * 60_000;
/** At most this many cached queries (the oldest go first). */
export const QUERY_CACHE_MAX = 300;
const queryCache = new Map<string, { at: number; rows: Promise<unknown> }>();

/**
 * Cached `fn()` under `key` for QUERY_TTL. Failures are never cached; `fresh` skips the cache (and refills it).
 * Keys hold the query, categories and the indexer, never an API key.
 */
export function cachedQuery<T>(key: string, fn: () => Promise<T>, opts: { fresh?: boolean; now?: number } = {}): Promise<T> {
  const now = opts.now ?? Date.now();
  for (const [k, v] of queryCache) if (now - v.at > QUERY_TTL) queryCache.delete(k);
  const hit = opts.fresh ? undefined : queryCache.get(key);
  if (hit) return hit.rows as Promise<T>;
  const rows = fn();
  queryCache.delete(key);
  queryCache.set(key, { at: now, rows });
  while (queryCache.size > QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value as string);
  rows.catch(() => {
    if (queryCache.get(key)?.rows === rows) queryCache.delete(key); // failures are not cached
  });
  return rows;
}

/** Tests: forget every cached query. */
export const clearQueryCache = () => queryCache.clear();
export const queryCacheSize = () => queryCache.size;
