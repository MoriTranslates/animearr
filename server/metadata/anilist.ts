/**
 * AniList GraphQL client (no key needed). Gentle: one request at a time, ≥ 2.1 s apart (AniList's degraded limit is 30/min),
 * backs off on 429. Used for AnimeArr's own metadata (titles, format, status, schedule, covers, relations).
 */
import { USER_AGENT } from "./metadata.js";

export interface AniMedia {
  id: number;
  idMal: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  synonyms: string[];
  format: string | null;
  status: string | null;
  episodes: number | null;
  duration: number | null;
  season: string | null;
  seasonYear: number | null;
  startDate: { year: number | null; month: number | null; day: number | null };
  endDate: { year: number | null; month: number | null; day: number | null };
  countryOfOrigin: string | null;
  coverImage: { large: string | null; color: string | null };
  bannerImage: string | null;
  description: string | null;
  genres: string[];
  isAdult: boolean;
  relations: { edges: { relationType: string; node: { id: number; type: string; format: string | null } }[] };
  airingSchedule: { nodes: { episode: number; airingAt: number }[] };
  nextAiringEpisode: { episode: number; airingAt: number } | null;
  streamingEpisodes: { title: string | null }[];
  trailer?: { id: string | null; site: string | null; thumbnail: string | null } | null;
}

/** A show's trailer: only YouTube or Dailymotion, only a plain video id (it goes into an embed URL). */
export interface Trailer {
  site: "youtube" | "dailymotion";
  id: string;
  thumbnail: string | null;
}
const TRAILER_ID = /^[A-Za-z0-9_-]+$/;

/** AniList's `trailer` → a Trailer, or null when there is none (or it's another site, or the id looks odd). */
export function normTrailer(raw: unknown): Trailer | null {
  if (!raw || typeof raw !== "object") return null;
  const { site, id, thumbnail } = raw as { site?: unknown; id?: unknown; thumbnail?: unknown };
  const s = typeof site === "string" ? site.toLowerCase() : "";
  if ((s !== "youtube" && s !== "dailymotion") || typeof id !== "string" || id.length > 64 || !TRAILER_ID.test(id)) return null;
  return { site: s, id, thumbnail: typeof thumbnail === "string" && /^https:\/\/[^\s"'<>]+$/.test(thumbnail) ? thumbnail : null };
}

const FIELDS = `id idMal title { romaji english native } synonyms format status episodes duration season seasonYear
  startDate { year month day } endDate { year month day } countryOfOrigin coverImage { large color } bannerImage
  description(asHtml: false) genres isAdult
  relations { edges { relationType node { id type format } } }
  airingSchedule(perPage: 50) { nodes { episode airingAt } }
  nextAiringEpisode { episode airingAt }
  streamingEpisodes { title }
  trailer { id site thumbnail }`;

/**
 * The request queue. One request at a time, ≥ 2.1 s apart; a 429 sets a shared pause (its Retry-After, at most 120 s)
 * instead of sleeping inside the request, so the pause never holds the queue (review 2026-11-02):
 * - interactive (`priority`) calls go first; during a pause longer than FAST_FAIL_MS they fail at once with "try again
 *   in N s" (someone is waiting on them), a shorter one they wait out;
 * - background calls wait the pause out (woken early when an interactive call arrives, which then goes first);
 * - a call limited MAX_TRIES times gives up with the same message.
 */
const SPACING_MS = 2100;
const FAST_FAIL_MS = 5000;
const MAX_TRIES = 3;
let last = 0;
let pausedUntil = 0;
interface Job {
  priority: boolean;
  supersede: boolean;
  tries: number;
  /** One request: the data, or the seconds AniList asked to wait (a 429). */
  once: () => Promise<{ data: unknown } | { retryAfter: number }>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}
const queue: Job[] = [];
let working = false;
/** Wakes a background wait early (an interactive call arrived). */
let wake: (() => void) | null = null;

const limitedError = (ms: number) => new Error(`AniList is rate-limiting; try again in ${Math.max(1, Math.ceil(ms / 1000))} s`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** For tests: a fresh limiter (no pause, no spacing debt, nothing queued). */
export function resetAnilistLimiter() {
  last = 0;
  pausedUntil = 0;
  for (const j of queue.splice(0)) j.reject(new Error("AniList queue reset"));
  wake?.();
}

async function work() {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      // Interactive searches (the Add box) go before the catalog refresh's batches.
      const i = queue.findIndex((j) => j.priority);
      const job = queue[i >= 0 ? i : 0];
      const pause = pausedUntil - Date.now();
      if (pause > 0) {
        if (job.priority && pause > FAST_FAIL_MS) {
          queue.splice(queue.indexOf(job), 1);
          job.reject(limitedError(pause));
          continue;
        }
        if (!job.priority) {
          // Wait without holding the queue: an interactive call that arrives meanwhile is looked at at once.
          await new Promise<void>((r) => {
            const t = setTimeout(r, pause);
            wake = () => (clearTimeout(t), r());
          });
          wake = null;
          continue;
        }
        await sleep(pause); // an interactive call and a short pause: worth the wait
      }
      const spacing = Math.max(0, last + SPACING_MS - Date.now());
      if (spacing) await sleep(spacing);
      // Superseded by a newer search (or the queue reset) while it waited: it was answered already; look again.
      const at = queue.indexOf(job);
      if (at < 0) continue;
      queue.splice(at, 1);
      last = Date.now();
      try {
        const r = await job.once();
        if ("data" in r) {
          job.resolve(r.data);
          continue;
        }
        pausedUntil = Date.now() + Math.min(120, r.retryAfter) * 1000;
        if (++job.tries >= MAX_TRIES) job.reject(limitedError(pausedUntil - Date.now()));
        else queue.unshift(job); // tried again after the pause (an interactive one: if the pause is short)
      } catch (e) {
        job.reject(e);
      }
    }
  } finally {
    working = false;
  }
}

/**
 * One GraphQL call, serialised and spaced (AniList allows ~30 per minute). `priority` calls jump the queue, and a
 * newer superseding call (a search) replaces an older one still waiting (someone typing). Rate limits: see the queue.
 */
export function anilistQuery<T>(
  query: string,
  variables: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
  opts: { priority?: boolean; supersede?: boolean } = {},
): Promise<T> {
  const once = async (): Promise<{ data: unknown } | { retryAfter: number }> => {
    const res = await fetcher("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429) {
      const raw = Number(res.headers.get("retry-after"));
      return { retryAfter: Number.isFinite(raw) && raw > 0 ? raw : 60 };
    }
    if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
    const j = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (j.errors?.length && !j.data) throw new Error(`AniList: ${j.errors[0].message}`);
    if (!j.data) throw new Error("AniList: empty response");
    return { data: j.data };
  };
  return new Promise<T>((resolve, reject) => {
    if (opts.supersede)
      for (let i = queue.length - 1; i >= 0; i--)
        if (queue[i].supersede) queue.splice(i, 1)[0].reject(new Error("superseded by a newer search"));
    queue.push({
      priority: !!opts.priority,
      supersede: !!opts.supersede,
      tries: 0,
      once,
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    if (opts.priority) wake?.();
    void work();
  });
}

/** Media by AniList ids (50 per request). */
export async function mediaByIds(ids: number[], fetcher?: typeof fetch, opts: { priority?: boolean } = {}): Promise<AniMedia[]> {
  const out: AniMedia[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await anilistQuery<{ Page: { media: AniMedia[] } }>(
      `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${FIELDS} } } }`,
      { ids: ids.slice(i, i + 50) },
      fetcher,
      { priority: opts.priority },
    );
    out.push(...(d.Page?.media ?? []));
  }
  return out;
}

/** Title search (English, romaji, native, synonyms), anime only. */
export async function searchMedia(
  q: string,
  perPage = 15,
  fetcher?: typeof fetch,
  opts: { interactive?: boolean } = { interactive: true },
): Promise<AniMedia[]> {
  // Only what a search result shows (the full entry is fetched when something is added); first in the queue.
  const slim =
    "id idMal title { romaji english native } synonyms format status episodes duration seasonYear startDate { year month day } countryOfOrigin coverImage { large color } trailer { id site thumbnail }";
  const d = await anilistQuery<{ Page: { media: AniMedia[] } }>(
    `query ($q: String, $n: Int) { Page(perPage: $n) { media(search: $q, type: ANIME, sort: SEARCH_MATCH) { ${slim} } } }`,
    { q, n: perPage },
    fetcher,
    opts.interactive === false ? {} : { priority: true, supersede: true },
  );
  return d.Page?.media ?? [];
}
