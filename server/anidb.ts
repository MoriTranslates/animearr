/**
 * AniDB HTTP API provider (registered client, Settings → Metadata).
 *
 * What it adds: per-episode titles (English, romaji/x-jat, Japanese), episode types (regular, special, credit = OP/ED,
 * trailer, parody, other), lengths and air dates — the ground truth for TVDB season 0 (via Anime-Lists' mapping lists)
 * and for seasons AniList's list doesn't cover.
 *
 * AniDB bans IPs that misbehave, so this is deliberately slow and careful:
 * - one global queue, at most one request every 2.5 s, gzip;
 * - a long cache: airing anime once a day at most, finished anime once a week at most;
 * - any error response stops all requests for an hour; "banned" stops them for a day (persisted across restarts);
 * - never a crawl: only AniDB ids of the library, a few per run, a daily cap, most-needed first
 *   (shows blocked in the cutover, then shows with season-0 files, then the rest).
 */
import zlib from "node:zlib";
import { logDecision } from "./activity.js";
import { cache, db, dbState, setJob, tx } from "./db.js";
import { anidbToTvdb } from "./core/animedata.js";
import { animeListEntries } from "./metadata.js";
import { getSettings } from "./settings.js";

const DAY = 86_400_000;
const SPACING_MS = 2_500;
const PER_RUN = 12;
const DAILY_CAP = 400;
export const ANIDB_URL = "http://api.anidb.net:9001/httpapi";

export type AnidbEpType = "regular" | "special" | "credit" | "trailer" | "parody" | "other";
const TYPES: Record<string, AnidbEpType> = { "1": "regular", "2": "special", "3": "credit", "4": "trailer", "5": "parody", "6": "other" };

export interface AnidbEpisode { epno: string; type: AnidbEpType; number: number; length: number | null; airdate: string | null; titleEn: string | null; titleXjat: string | null; titleJa: string | null }
export interface AnidbAnime { aid: number; type: string | null; episodeCount: number | null; endDate: string | null; episodes: AnidbEpisode[] }

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");

/** Parses AniDB's anime XML (only what AnimeArr uses). */
export function parseAnime(xml: string, aid: number): AnidbAnime {
  const episodes: AnidbEpisode[] = [];
  for (const m of xml.matchAll(/<episode\b[^>]*>([\s\S]*?)<\/episode>/g)) {
    const body = m[1];
    const ep = /<epno\s+type="(\d)"\s*>([^<]+)<\/epno>/.exec(body);
    if (!ep) continue;
    const epno = ep[2].trim();
    const title = (lang: string) => {
      const t = new RegExp(`<title\\s+xml:lang="${lang}"[^>]*>([^<]*)</title>`).exec(body)?.[1];
      return t ? decode(t).trim() || null : null;
    };
    episodes.push({
      epno,
      type: TYPES[ep[1]] ?? "other",
      number: Number(epno.replace(/^[A-Z]/i, "")) || 0,
      length: Number(/<length>(\d+)<\/length>/.exec(body)?.[1]) || null,
      airdate: /<airdate>([\d-]+)<\/airdate>/.exec(body)?.[1] ?? null,
      titleEn: title("en"),
      titleXjat: title("x-jat"),
      titleJa: title("ja"),
    });
  }
  return { aid, type: /<type>([^<]*)<\/type>/.exec(xml)?.[1] ?? null, episodeCount: Number(/<episodecount>(\d+)<\/episodecount>/.exec(xml)?.[1]) || null, endDate: /<enddate>([\d-]+)<\/enddate>/.exec(xml)?.[1] ?? null, episodes };
}

// ---------------------------------------------------------------- state (persisted: a ban survives a restart)

const state = (k: string) => (db.prepare("SELECT value FROM anidb_state WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null;
const setState = (k: string, v: string) => db.prepare("INSERT INTO anidb_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);

export function anidbStatus(now = Date.now()) {
  const blockedUntil = Number(state("blockedUntil") ?? 0);
  const day = new Date(now).toISOString().slice(0, 10);
  return {
    configured: !!getSettings().metadata.anidbClient,
    blockedUntil: blockedUntil > now ? blockedUntil : null,
    lastError: state("lastError"),
    today: state("day") === day ? Number(state("count") ?? 0) : 0,
    dailyCap: DAILY_CAP,
    known: (db.prepare("SELECT COUNT(*) AS n FROM anidb_anime WHERE missing = 0").get() as { n: number }).n,
  };
}

let last = 0;
let chain: Promise<unknown> = Promise.resolve();

/** One request, through the global queue. Errors block further requests (1 h; banned: 24 h). */
export function fetchAnime(aid: number, deps = { fetch }): Promise<AnidbAnime> {
  const run = async () => {
    const s = getSettings().metadata;
    if (!s.anidbClient) throw new Error("AniDB client not set");
    const now = Date.now();
    const st = anidbStatus(now);
    if (st.blockedUntil) throw new Error(`AniDB paused until ${new Date(st.blockedUntil).toISOString()} (${st.lastError ?? "earlier error"})`);
    if (st.today >= DAILY_CAP) throw new Error("AniDB daily cap reached");
    last = Math.max(last, Number(state("lastAt") ?? 0)); // spacing survives a restart
    const wait = Math.max(0, last + SPACING_MS - now);
    if (wait) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const day = new Date(last).toISOString().slice(0, 10);
    const prev = state("day") === day ? Number(state("count") ?? 0) : 0; // read before writing: a new day starts at 0
    tx(db, () => {
      setState("day", day);
      setState("count", String(prev + 1));
      setState("lastAt", String(last));
    });
    const url = `${ANIDB_URL}?request=anime&client=${encodeURIComponent(s.anidbClient)}&clientver=${s.anidbClientVer}&protover=1&aid=${aid}`;
    const block = (why: string, ms: number) => {
      setState("blockedUntil", String(Date.now() + ms));
      setState("lastError", why);
      logDecision("fail", { why: `AniDB: ${why}; no AniDB requests for ${Math.round(ms / 3_600_000)} h` });
      return new Error(`AniDB: ${why}`);
    };
    let res: Response;
    try {
      res = await deps.fetch(url, { headers: { "Accept-Encoding": "gzip", "User-Agent": `${s.anidbClient}/${s.anidbClientVer}` }, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw block(`unreachable (${(e as Error).message})`, 3_600_000);
    }
    if (!res.ok) throw block(`HTTP ${res.status}`, res.status === 503 || res.status === 429 ? 6 * 3_600_000 : 3_600_000);
    let xml: string;
    try {
      let buf = Buffer.from(await res.arrayBuffer());
      // fetch decodes "Content-Encoding: gzip" itself; raw gzip bytes (magic 1f 8b) are decoded here — never twice.
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      xml = buf.toString("utf8");
    } catch (e) {
      throw block(`bad response (${(e as Error).message})`, 3_600_000);
    }
    const err = /<error[^>]*>([^<]*)<\/error>/i.exec(xml)?.[1];
    if (err) {
      if (/banned/i.test(err)) throw block(`banned (${err})`, DAY);
      if (/client/i.test(err)) throw block(`client problem (${err}); check Settings → Metadata`, DAY);
      if (/no such anime|anime not found/i.test(err)) {
        db.prepare("INSERT OR REPLACE INTO anidb_anime (aid, fetched_at, ended, type, episode_count, missing) VALUES (?, ?, 1, NULL, NULL, 1)").run(aid, Date.now());
        throw new Error(`AniDB: ${err}`);
      }
      throw block(err, 3_600_000);
    }
    if (!/<anime\b/.test(xml)) throw block("unexpected answer", 3_600_000);
    return parseAnime(xml, aid);
  };
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

export function storeAnime(a: AnidbAnime, now = Date.now()) {
  const ended = !!a.endDate && Date.parse(a.endDate) < now;
  tx(db, () => {
    db.prepare("INSERT OR REPLACE INTO anidb_anime (aid, fetched_at, ended, type, episode_count, missing) VALUES (?, ?, ?, ?, ?, 0)").run(a.aid, now, ended ? 1 : 0, a.type, a.episodeCount);
    db.prepare("DELETE FROM anidb_episodes WHERE aid = ?").run(a.aid);
    const ins = db.prepare("INSERT OR REPLACE INTO anidb_episodes (aid, epno, type, number, length, airdate, title_en, title_xjat, title_ja) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const e of a.episodes) ins.run(a.aid, e.epno, e.type, e.number, e.length, e.airdate, e.titleEn, e.titleXjat, e.titleJa);
  });
}

/** Due for a (re)fetch: never fetched, or older than a day (airing) / a week (finished). */
export function due(aid: number, now = Date.now()) {
  const r = db.prepare("SELECT fetched_at, ended FROM anidb_anime WHERE aid = ?").get(aid) as { fetched_at: number; ended: number } | undefined;
  return !r || now - r.fetched_at > (r.ended ? 7 * DAY : DAY);
}

export function anidbEpisodes(aid: number) {
  return (db.prepare("SELECT epno, type, number, length, airdate, title_en, title_xjat, title_ja FROM anidb_episodes WHERE aid = ?").all(aid) as { epno: string; type: AnidbEpType; number: number; length: number | null; airdate: string | null; title_en: string | null; title_xjat: string | null; title_ja: string | null }[]);
}

/** The library's AniDB ids, most-needed first. `priority` ids (e.g. blocked cutover shows) go before everything. */
export function wantedAids(priority: number[] = []) {
  const seriesAids = (cache.prepare("SELECT id, anidb_ids FROM series").all() as { id: number; anidb_ids: string }[]).map((r) => ({ id: r.id, aids: (JSON.parse(r.anidb_ids) as { aid: number }[]).map((x) => x.aid) }));
  const withS0 = new Set((cache.prepare("SELECT DISTINCT series_id FROM episodes WHERE season = 0 AND has_file = 1").all() as { series_id: number }[]).map((r) => r.series_id));
  const ordered = [...priority, ...seriesAids.filter((s) => withS0.has(s.id)).flatMap((s) => s.aids), ...seriesAids.flatMap((s) => s.aids)];
  return [...new Set(ordered)];
}

let running = false;

/** A few library entries per run (never a crawl), most-needed first. */
export async function anidbTick(priority: number[] = [], deps = { fetch }, now = Date.now()) {
  if (running || dbState.corrupt || !getSettings().metadata.anidbClient) return { fetched: 0 };
  const st = anidbStatus(now);
  if (st.blockedUntil || st.today >= DAILY_CAP) return { fetched: 0 };
  running = true;
  let fetched = 0;
  try {
    const todo = wantedAids(priority).filter((a) => due(a, now)).slice(0, Math.min(PER_RUN, DAILY_CAP - st.today));
    for (const aid of todo) {
      try {
        storeAnime(await fetchAnime(aid, deps));
        fetched++;
      } catch (e) {
        if (anidbStatus().blockedUntil) break; // blocked: stop at once
        void e;
      }
    }
    if (fetched) setJob("anidb", "done", `AniDB: ${fetched} entr${fetched === 1 ? "y" : "ies"} refreshed (${anidbStatus().known} known)`);
  } finally {
    running = false;
  }
  return { fetched };
}

/**
 * AniDB's episodes placed on TVDB numbering through Anime-Lists: regular episodes on their TVDB season, specials on
 * season 0 where the mapping list says so. Only entries already fetched (nothing is requested here).
 */
export function anidbForTvdb(tvdbId: number) {
  const out: { season: number; episode: number; title: string | null; air: number | null; length: number | null; type: AnidbEpType; aid: number; epno: string }[] = [];
  for (const e of animeListEntries().values()) {
    if (e.tvdbId !== tvdbId) continue;
    for (const ep of anidbEpisodes(e.aid)) {
      if (ep.type !== "regular" && ep.type !== "special") continue;
      const t = anidbToTvdb(e, ep.number, ep.type === "regular" ? 1 : 0);
      // A special never lands on a regular season; a regular episode may be a TVDB special (OVA entries mapped to S0).
      if (!t || t.absolute || t.season < 0 || (ep.type === "special" && t.season !== 0)) continue;
      out.push({ season: t.season, episode: t.episode, title: ep.title_en ?? ep.title_xjat ?? ep.title_ja, air: ep.airdate ? Date.parse(`${ep.airdate}T00:00:00Z`) : null, length: ep.length, type: ep.type, aid: e.aid, epno: ep.epno });
    }
  }
  return out;
}

/** For the specials list: AniDB's type of a TVDB S0 episode (OP/ED/trailer/… come from AniDB's own episode types). */
export function anidbSpecialKind(tvdbId: number) {
  const m = new Map<number, { type: AnidbEpType; title: string | null; length: number | null }>();
  for (const x of anidbForTvdb(tvdbId)) if (x.season === 0 && !m.has(x.episode)) m.set(x.episode, { type: x.type, title: x.title, length: x.length }); // first wins, as in native shows
  return m;
}
