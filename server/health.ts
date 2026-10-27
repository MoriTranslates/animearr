/**
 * Indexer health, learned from recent grabs.
 *
 * 1. A soft penalty: an indexer whose download links failed lately goes behind equivalent releases from healthy
 *    indexers (the same release cross-posted elsewhere wins).
 * 2. A circuit breaker: 3 failures in a row (download links: DNS, dead host, HTTP errors; or, for a direct indexer,
 *    its search) turn the indexer OFF for grabbing. Its results still show in searches but are never picked. It is
 *    re-tested on its own (6 h, 12 h, then daily) by fetching one recent .nzb/.torrent without grabbing it; a good
 *    test turns it back on, with an Activity entry and a notification. The user can test now, turn it back on, or
 *    keep it off.
 * Nothing is hard-coded per indexer.
 */
import { db } from "./db.js";
import { logDecision } from "./activity.js";
import type { Known } from "./core/rank.js";

const WINDOW = 3 * 86_400_000;
const HOUR = 3_600_000;
/** Consecutive failures that turn an indexer off. */
export const TRIP_AFTER = 3;
/** Re-test back-off: 6 h, 12 h, then daily. */
export const RETEST = [6 * HOUR, 12 * HOUR, 24 * HOUR];

export type FailKind = "download" | "search";
export interface TestRelease { guid: string; title: string; protocol: "usenet" | "torrent"; downloadUrl?: string | null; magnetUrl?: string | null; size?: number }
interface BreakerRow { indexer_id: number; name: string; dl_streak: number; search_streak: number; state: "on" | "off" | "kept-off"; trip_kind: FailKind | null; off_since: number | null; next_check: number | null; step: number; last_error: string | null; last_kind: FailKind | null; last_at: number | null }

const row = (id: number) => db.prepare("SELECT * FROM indexer_breaker WHERE indexer_id = ?").get(id) as BreakerRow | undefined;
const ensure = (id: number, name: string | null | undefined, now: number) => {
  db.prepare("INSERT INTO indexer_breaker (indexer_id, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(indexer_id) DO UPDATE SET name = CASE WHEN ? != '' THEN ? ELSE name END").run(id, name ?? "", now, name ?? "", name ?? "");
  return row(id)!;
};
const label = (r: Pick<BreakerRow, "name" | "indexer_id">) => r.name || `Indexer ${r.indexer_id}`;
const STREAK = { download: "dl_streak", search: "search_streak" } as const;

/** "fetch failed" says nothing: name the host and the cause (DNS, refused, TLS, timeout). */
export function describeFetchError(e: unknown, url?: string | null): string {
  const err = e as Error & { cause?: { code?: string; hostname?: string; message?: string } };
  const host = err.cause?.hostname ?? (url ? safeHost(url) : "");
  const code = err.cause?.code ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `host ${host || "?"} not found (DNS)`;
  if (code === "ECONNREFUSED") return `${host || "the host"} refused the connection`;
  if (code === "ECONNRESET") return `${host || "the host"} dropped the connection`;
  if (/CERT|TLS|SSL/i.test(code)) return `${host || "the host"}: TLS/certificate error (${code})`;
  if (err.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT") return `${host || "the host"} timed out`;
  if (err.message === "fetch failed" && err.cause?.message) return `${host ? `${host}: ` : ""}${err.cause.message}`;
  return err.message;
}
const safeHost = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
};

/**
 * Records a failure for an indexer (a download link, or its search). Downloads and searches keep separate streaks;
 * TRIP_AFTER in a row of either kind trips the breaker, and only a success of that kind (or a re-test) resets it.
 */
export function recordIndexerFailure(indexerId: number | null | undefined, why: string, now = Date.now(), o: { name?: string | null; kind?: FailKind } = {}) {
  if (!indexerId) return;
  const kind = o.kind ?? "download";
  if (kind === "download") db.prepare("INSERT INTO indexer_failures (indexer_id, at, why) VALUES (?, ?, ?)").run(indexerId, now, why.slice(0, 300));
  memo.delete(indexerId);
  db.prepare("DELETE FROM indexer_failures WHERE at < ?").run(now - 30 * 86_400_000);
  const r = ensure(indexerId, o.name, now);
  const streak = r[STREAK[kind]] + 1;
  db.prepare(`UPDATE indexer_breaker SET ${STREAK[kind]} = ?, last_error = ?, last_kind = ?, last_at = ?, updated_at = ? WHERE indexer_id = ?`).run(streak, why.slice(0, 300), kind, now, now, indexerId);
  if (r.state === "on" && streak >= TRIP_AFTER) {
    db.prepare("UPDATE indexer_breaker SET state = 'off', trip_kind = ?, off_since = ?, step = 0, next_check = ? WHERE indexer_id = ?").run(kind, now, now + RETEST[0], indexerId);
    logDecision("fail", { title: label(r), why: `${label(r)} is off for grabbing: ${streak} ${kind === "search" ? "searches" : "downloads"} failed in a row (last error: ${why}). Its results still show in searches but won't be picked. AnimeArr tests it again in 6 hours.`, detail: { indexerId, breaker: "off" } });
  }
}

/** A good download (or search) resets that streak; it turns a tripped indexer back on only if it tripped on that kind. */
export function recordIndexerSuccess(indexerId: number | null | undefined, kind: FailKind = "download", now = Date.now()) {
  if (!indexerId) return;
  const r = row(indexerId);
  if (!r) return;
  if (r[STREAK[kind]] > 0) db.prepare(`UPDATE indexer_breaker SET ${STREAK[kind]} = 0, updated_at = ? WHERE indexer_id = ?`).run(now, indexerId);
  if (r.state !== "off" || r.trip_kind !== kind) return;
  db.prepare("UPDATE indexer_breaker SET dl_streak = 0, search_streak = 0, state = 'on', trip_kind = NULL, off_since = NULL, next_check = NULL, step = 0, updated_at = ? WHERE indexer_id = ?").run(now, indexerId);
  memo.delete(indexerId);
  logDecision("info", { title: label(r), why: `${label(r)} is working again: back on for grabbing`, detail: { indexerId, breaker: "on" } });
}

/** Off for grabbing (tripped, or kept off by the user)? */
export function indexerOff(indexerId: number | null | undefined) {
  if (!indexerId) return false;
  const r = row(indexerId);
  return !!r && r.state !== "on";
}

/** Recent failures vs. grabs that got to the download client, for one indexer; plus the breaker state. */
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
  const off = indexerOff(indexerId);
  const failures = (db.prepare("SELECT COUNT(*) AS n FROM indexer_failures WHERE indexer_id = ? AND at > ?").get(indexerId, now - WINDOW) as { n: number }).n;
  if (!failures && !off) return undefined;
  const ok = (db.prepare("SELECT COUNT(*) AS n FROM grabs WHERE indexer_id = ? AND at > ? AND client_ref IS NOT NULL").get(indexerId, now - WINDOW) as { n: number }).n;
  const last = row(indexerId)?.last_error ?? (db.prepare("SELECT why FROM indexer_failures WHERE indexer_id = ? ORDER BY at DESC LIMIT 1").get(indexerId) as { why: string } | undefined)?.why ?? "";
  return { failures, ok, lastWhy: last, off };
}

/**
 * The newest release seen per indexer (from searches, including the regular "recent releases" poll): what a re-test
 * fetches. Only real .nzb/.torrent links (fetching a magnet makes no network call, so it proves nothing). Memory
 * only: download links can carry API keys, so they're never stored.
 */
const recent = new Map<number, TestRelease>();
export function noteSeen(indexerId: number | null | undefined, r: TestRelease) {
  if (indexerId && r.downloadUrl && !r.downloadUrl.startsWith("magnet:")) recent.set(indexerId, { ...r, magnetUrl: null });
}

export type Fetcher = (r: TestRelease & { indexerId: number; indexer: string }) => Promise<unknown>;
export type Searcher = (indexerId: number) => Promise<boolean>;

/** Re-tests one tripped indexer now (download: fetch one .nzb/.torrent without grabbing; search: one search). */
export async function testIndexer(indexerId: number, deps: { fetch: Fetcher; search?: Searcher }, now = Date.now(), manual = false) {
  const r = row(indexerId);
  if (!r) return { ok: true, why: "no failures recorded" };
  let ok = false;
  let why = "";
  try {
    if (r.trip_kind === "search" && deps.search) {
      ok = await deps.search(indexerId);
      why = ok ? "search works" : "search failed";
    } else {
      const t = recent.get(indexerId);
      if (!t) return { ok: false, why: "nothing to test with yet (no release from this indexer seen since the restart); the next search or the recent-releases poll provides one", state: r.state };
      await deps.fetch({ ...t, indexerId, indexer: label(r) });
      ok = true;
      why = `fetched ${t.protocol === "usenet" ? "an .nzb" : "a .torrent"} (${t.title})`;
    }
  } catch (e) {
    why = describeFetchError(e);
  }
  if (ok) {
    // A kept-off indexer stays off (the user chose that); the test only tells them it works.
    if (r.state === "kept-off") return { ok, why, state: r.state };
    db.prepare("UPDATE indexer_breaker SET dl_streak = 0, search_streak = 0, state = 'on', trip_kind = NULL, off_since = NULL, next_check = NULL, step = 0, updated_at = ? WHERE indexer_id = ?").run(now, indexerId);
    memo.delete(indexerId);
    if (r.state === "off") logDecision("info", { title: label(r), why: `${label(r)} is working again (${why}): back on for grabbing`, detail: { indexerId, breaker: "on" } });
    return { ok, why, state: "on" as const };
  }
  if (r.state === "off") {
    const step = Math.min(r.step + 1, RETEST.length - 1);
    db.prepare("UPDATE indexer_breaker SET step = ?, next_check = ?, last_error = ?, updated_at = ? WHERE indexer_id = ?").run(step, now + RETEST[step], why.slice(0, 300), now, indexerId);
  }
  void manual;
  return { ok, why, state: r.state };
}

/** Scheduled: re-tests the tripped indexers that are due. */
export async function breakerTick(deps: { fetch: Fetcher; search?: Searcher }, now = Date.now()) {
  const due = db.prepare("SELECT indexer_id FROM indexer_breaker WHERE state = 'off' AND next_check <= ?").all(now) as { indexer_id: number }[];
  for (const d of due) await testIndexer(d.indexer_id, deps, now);
  return due.length;
}

/** The user's buttons: turn back on (clears the streak) or keep off (no automatic re-tests turn it on). */
export function setBreaker(indexerId: number, action: "on" | "keep-off", name?: string, now = Date.now()) {
  const r = ensure(indexerId, name, now);
  if (action === "on") db.prepare("UPDATE indexer_breaker SET state = 'on', dl_streak = 0, search_streak = 0, trip_kind = NULL, off_since = NULL, next_check = NULL, step = 0, updated_at = ? WHERE indexer_id = ?").run(now, indexerId);
  else db.prepare("UPDATE indexer_breaker SET state = 'kept-off', off_since = COALESCE(off_since, ?), next_check = NULL, updated_at = ? WHERE indexer_id = ?").run(now, now, indexerId);
  memo.delete(indexerId);
  logDecision("info", { title: label(r), why: action === "on" ? `You turned ${label(r)} back on for grabbing` : `You kept ${label(r)} off for grabbing (no automatic re-tests)`, detail: { indexerId, breaker: action } });
}

/** For Settings → Indexers: every indexer with a recorded failure or a breaker state. */
export function breakerList() {
  return (db.prepare("SELECT * FROM indexer_breaker ORDER BY name").all() as unknown as BreakerRow[]).map((r) => ({
    indexerId: r.indexer_id,
    name: label(r),
    state: r.state,
    streak: r.trip_kind === "search" ? r.search_streak : r.dl_streak,
    offSince: r.off_since,
    nextCheck: r.state === "off" ? r.next_check : null,
    lastError: r.last_error,
    lastKind: r.trip_kind ?? r.last_kind,
    lastAt: r.last_at,
  }));
}

/** Prowlarr's download proxy fails (HTTP 500) on some non-ASCII titles: that's neither the indexer's nor the release's fault. */
export const isTitleEncodingError = (msg: string, title: string) => /HTTP 500/.test(msg) && /[^\x20-\x7e]/.test(title);
