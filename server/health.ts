/**
 * Indexer health, learned from recent grabs: a release whose download link fails (DNS, dead host, Prowlarr error)
 * counts against its indexer. Ranking then pushes that indexer's releases below equivalent ones from healthy
 * indexers (a penalty, not a rejection, so it is still used when nothing else exists). Nothing is hard-coded.
 */
import { db } from "./db.js";
import type { Known } from "./core/rank.js";

const WINDOW = 3 * 86_400_000;

/** Records a download-link failure for an indexer (not the release's fault, not the client's). */
export function recordIndexerFailure(indexerId: number | null | undefined, why: string, now = Date.now()) {
  if (!indexerId) return;
  db.prepare("INSERT INTO indexer_failures (indexer_id, at, why) VALUES (?, ?, ?)").run(indexerId, now, why.slice(0, 300));
  memo.delete(indexerId);
  db.prepare("DELETE FROM indexer_failures WHERE at < ?").run(now - 30 * 86_400_000);
}

/** Recent failures vs. grabs that got to the download client, for one indexer (and protocol). */
const memo = new Map<number, { at: number; v: Known["indexerHealth"] }>();
export function indexerHealth(indexerId: number | null | undefined, now = Date.now()): Known["indexerHealth"] {
  if (!indexerId) return undefined;
  const hit = memo.get(indexerId);
  if (hit && now - hit.at < 30_000) return hit.v;
  const v = computeHealth(indexerId, now);
  memo.set(indexerId, { at: now, v });
  return v;
}
function computeHealth(indexerId: number, now: number): Known["indexerHealth"] {
  const failures = (db.prepare("SELECT COUNT(*) AS n FROM indexer_failures WHERE indexer_id = ? AND at > ?").get(indexerId, now - WINDOW) as { n: number }).n;
  if (!failures) return undefined;
  const ok = (db.prepare("SELECT COUNT(*) AS n FROM grabs WHERE indexer_id = ? AND at > ? AND client_ref IS NOT NULL").get(indexerId, now - WINDOW) as { n: number }).n;
  const last = db.prepare("SELECT why FROM indexer_failures WHERE indexer_id = ? ORDER BY at DESC LIMIT 1").get(indexerId) as { why: string };
  return { failures, ok, lastWhy: last.why };
}

/** Prowlarr's download proxy fails (HTTP 500) on some non-ASCII titles: that's neither the indexer's nor the release's fault. */
export const isTitleEncodingError = (msg: string, title: string) => /HTTP 500/.test(msg) && /[^\x20-\x7e]/.test(title);
