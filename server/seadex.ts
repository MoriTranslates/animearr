/**
 * SeaDex (releases.moe) and the TRaSH anime group tiers: the data behind quality ranking (core/quality.ts).
 *
 * - SeaDex's picks are cached per AniList entry (weekly refresh, and right after a show is added), fetched within a
 *   budget like the other metadata sources. Ranking only ever reads the cache, so a search never waits on SeaDex.
 * - A TVDB season maps to its AniList entries (split cours are two entries); their picks are merged.
 * - The tiers come from catalog/anime-tiers.json (versioned, from the TRaSH Guides' anime custom formats).
 */
import fs from "node:fs";
import path from "node:path";
import { compileTiers, seadexSource, type CompiledTiers, type SeadexEntry, type SeadexTorrent, type TierTable } from "./core/quality.js";
import { cache, db, setJob } from "./db.js";
import { listManaged } from "./managed.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** SeaDex lookups per hour (a full library fills in over a day or two). */
export const SEADEX_PER_HOUR = 30;
const REFRESH_DAYS = 7;
const SEADEX_URL = "https://releases.moe/api/collections/entries/records";

// ---------------------------------------------------------------- tiers

let tiersCache: { at: number; v: CompiledTiers | null } | null = null;
/** The TRaSH anime tiers (catalog/anime-tiers.json next to the app); null when the file is missing. */
export function animeTiers(): CompiledTiers | null {
  if (tiersCache && Date.now() - tiersCache.at < 10 * 60_000) return tiersCache.v;
  const file = [path.join(process.cwd(), "catalog", "anime-tiers.json"), path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "catalog", "anime-tiers.json")].find((f) => fs.existsSync(f));
  let v: CompiledTiers | null = null;
  try {
    v = file ? compileTiers(JSON.parse(fs.readFileSync(file, "utf8")) as TierTable) : null;
  } catch {
    v = null;
  }
  tiersCache = { at: Date.now(), v };
  return v;
}

// ---------------------------------------------------------------- cache

interface Row { anilist_id: number; fetched_at: number; found: number; incomplete: number; torrents: string }
const rowOf = (id: number) => db.prepare("SELECT * FROM seadex WHERE anilist_id = ?").get(id) as Row | undefined;

/** Entries waiting for their first lookup (newly added shows jump the queue). */
const wanted = new Set<number>();
export const requestSeadex = (anilistIds: number[]) => anilistIds.forEach((id) => Number.isInteger(id) && id > 0 && wanted.add(id));

/** SeaDex's picks for one AniList entry from the cache (null: none known or not fetched yet; the latter is queued). */
export function seadexFor(anilistId: number): SeadexEntry | null {
  const r = rowOf(anilistId);
  if (!r) {
    requestSeadex([anilistId]);
    return null;
  }
  if (!r.found) return null;
  return { incomplete: !!r.incomplete, torrents: JSON.parse(r.torrents) as SeadexTorrent[] };
}

/** The AniList entries behind a TVDB season (native shows TVDB doesn't have are their own single entry). */
export function anilistIdsFor(tvdbId: number, season: number): number[] {
  const ids = (db.prepare("SELECT anilist_id FROM entries WHERE tvdb_id = ? AND tvdb_season = ? ORDER BY start_date IS NULL, start_date").all(tvdbId, String(season)) as { anilist_id: number }[]).map((r) => r.anilist_id);
  if (ids.length) return ids;
  const native = db.prepare("SELECT anilist_id FROM native_series WHERE tvdb_id = ?").get(tvdbId) as { anilist_id: number } | undefined;
  return native ? [native.anilist_id] : [];
}

/** SeaDex's picks for a TVDB season: its entries' picks merged (incomplete if any part is). */
export function seadexForSeason(tvdbId: number, season: number | null): SeadexEntry | null {
  if (season === null) return null;
  const parts = anilistIdsFor(tvdbId, season)
    .map(seadexFor)
    .filter((x): x is SeadexEntry => !!x);
  if (!parts.length) return null;
  return { incomplete: parts.some((p) => p.incomplete), torrents: parts.flatMap((p) => p.torrents) };
}

// ---------------------------------------------------------------- fetching

/** Parses one releases.moe entries response into SeaDex picks (null = SeaDex has no entry for the show). */
export function parseSeadex(json: unknown): SeadexEntry | null {
  const item = (json as { items?: unknown[] })?.items?.[0] as { incomplete?: boolean; expand?: { trs?: unknown[] } } | undefined;
  if (!item) return null;
  const torrents = (item.expand?.trs ?? [])
    .map((t) => t as { releaseGroup?: string; tracker?: string; isBest?: boolean; dualAudio?: boolean; tags?: unknown })
    .filter((t) => typeof t.releaseGroup === "string" && t.releaseGroup.trim())
    .map((t) => ({ group: t.releaseGroup!.trim(), tracker: String(t.tracker ?? ""), best: !!t.isBest, dualAudio: !!t.dualAudio, tags: Array.isArray(t.tags) ? t.tags.map(String).slice(0, 10) : [] }));
  // The same group listed per tracker: keep one entry per group + best + dual flag + source.
  const seen = new Map<string, SeadexTorrent>();
  for (const t of torrents) seen.set(`${t.group.toLowerCase()}|${t.best}|${t.dualAudio}|${seadexSource(t)}`, t);
  return { incomplete: !!item.incomplete, torrents: [...seen.values()].slice(0, 30) };
}

export async function fetchSeadex(anilistId: number, fetcher: typeof fetch = fetch): Promise<SeadexEntry | null> {
  const url = `${SEADEX_URL}?${new URLSearchParams({ filter: `(alID=${anilistId})`, expand: "trs", perPage: "1" })}`;
  const res = await fetcher(url, { redirect: "follow", headers: { Accept: "application/json", "User-Agent": "AnimeArr" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`SeaDex answered HTTP ${res.status}`);
  return parseSeadex(await res.json());
}

export function saveSeadex(anilistId: number, e: SeadexEntry | null, now = Date.now()) {
  db.prepare("INSERT OR REPLACE INTO seadex (anilist_id, fetched_at, found, incomplete, torrents) VALUES (?, ?, ?, ?, ?)").run(anilistId, now, e ? 1 : 0, e?.incomplete ? 1 : 0, JSON.stringify(e?.torrents ?? []));
}

const fetchedLastHour = (now: number) => (db.prepare("SELECT COUNT(*) AS n FROM seadex WHERE fetched_at > ?").get(now - HOUR) as { n: number }).n;

/** AniList entries of managed shows (their seasons) whose SeaDex picks are missing or older than a week. */
export function dueEntries(now = Date.now()): number[] {
  const out = new Set<number>(wanted);
  for (const m of listManaged()) {
    const seasons = (cache.prepare("SELECT DISTINCT season FROM episodes WHERE series_id = ? AND season > 0").all(m.seriesId) as { season: number }[]).map((r) => r.season);
    for (const s of seasons) for (const id of anilistIdsFor(m.tvdbId, s)) out.add(id);
  }
  return [...out].filter((id) => {
    const r = rowOf(id);
    return !r || now - r.fetched_at > REFRESH_DAYS * DAY;
  });
}

/** One pass: fetch due entries within the hourly budget. Failures leave the entry due (retried next pass). */
export async function seadexPass(deps: { fetch: typeof fetch } = { fetch }, now = Date.now()) {
  let fetched = 0;
  let failed = 0;
  for (const id of dueEntries(now)) {
    if (fetchedLastHour(now) >= SEADEX_PER_HOUR) break;
    try {
      saveSeadex(id, await fetchSeadex(id, deps.fetch), now);
      wanted.delete(id);
      fetched++;
    } catch {
      failed++;
      if (failed >= 3) break; // SeaDex down: try again next pass
    }
  }
  return { fetched, failed };
}

let running = false;
export async function seadexTick() {
  if (running) return;
  running = true;
  try {
    const r = await seadexPass();
    if (r.fetched || r.failed) setJob("SeaDex", r.failed && !r.fetched ? "error" : "done", `${r.fetched} shows updated${r.failed ? `, ${r.failed} lookups failed` : ""}`);
  } catch (e) {
    setJob("SeaDex", "error", (e as Error).message);
  } finally {
    running = false;
  }
}

// ---------------------------------------------------------------- "Check SeaDex now"

/** A show's "Check SeaDex now" can run again after this long (SeaDex is a small volunteer site: be gentle). */
export const CHECK_COOLDOWN_MS = 30 * 60_000;
const checkKey = (tvdbId: number) => `seadex.check.${tvdbId}`;
export const lastCheck = (tvdbId: number) => {
  const v = (db.prepare("SELECT value FROM kv WHERE key = ?").get(checkKey(tvdbId)) as { value: string } | undefined)?.value;
  return v ? Number(v) || null : null;
};
/** Milliseconds until a show may be checked again (0 = now). */
export const cooldownLeft = (last: number | null, now = Date.now()) => (last === null ? 0 : Math.max(0, last + CHECK_COOLDOWN_MS - now));

/** The AniList entries behind all of a show's seasons (specials included). */
export function showEntries(tvdbId: number): number[] {
  const series = cache.prepare("SELECT id FROM series WHERE tvdb_id = ?").get(tvdbId) as { id: number } | undefined;
  if (!series) return [];
  const seasons = (cache.prepare("SELECT DISTINCT season FROM episodes WHERE series_id = ?").all(series.id) as { season: number }[]).map((r) => r.season);
  return [...new Set(seasons.flatMap((s) => anilistIdsFor(tvdbId, s)))];
}

/**
 * Fetches and saves SeaDex's picks for a show's AniList entries right now (the weekly pass is the normal way).
 * A show can be checked again after CHECK_COOLDOWN_MS; within it nothing is fetched.
 */
export async function checkSeadexNow(tvdbId: number, deps: { fetch: typeof fetch } = { fetch }, now = Date.now()): Promise<{ status: "checked" | "cooldown" | "none"; entries: number; found: number; retryInMs: number }> {
  const left = cooldownLeft(lastCheck(tvdbId), now);
  if (left > 0) return { status: "cooldown", entries: 0, found: 0, retryInMs: left };
  const ids = showEntries(tvdbId);
  if (!ids.length) return { status: "none", entries: 0, found: 0, retryInMs: 0 };
  let found = 0;
  for (const id of ids) {
    const e = await fetchSeadex(id, deps.fetch);
    saveSeadex(id, e, now);
    wanted.delete(id);
    if (e) found++;
  }
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(checkKey(tvdbId), String(now));
  return { status: "checked", entries: ids.length, found, retryInMs: CHECK_COOLDOWN_MS };
}
