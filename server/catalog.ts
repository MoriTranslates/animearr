/**
 * AnimeArr's own metadata (1.0 takeover, step 4): AniList-first entries (TV cours, ONAs, OVAs, movies, specials),
 * grouped into franchises through AniList relations, with their episodes (air times from AniList's schedule, titles
 * from AniList's streaming list, TMDB when a key is set). TVDB/TMDB ids come from Anime-Lists (via the AniDB id)
 * and are only mappings, for Plex naming and the existing Sonarr/Radarr libraries. Donghua and ONAs that TVDB
 * doesn't have are entries like any other.
 *
 * Sources without keys: AniList (GraphQL), Anime-Lists, the AniDB titles dump, the Fribb mapping.
 * Optional providers (Settings → Metadata): TMDB (episode titles/air dates, movies), AniDB HTTP API (needs a
 * registered client; at most 1 request per 2 s), TVDB v4 (needs a key; not used yet).
 */
import { logDecision } from "./activity.js";
import { mediaByIds, type AniMedia } from "./anilist.js";
import { fribb } from "./covers.js";
import { cache, db, dbState, setJob, tx } from "./db.js";
import { animeListEntries, USER_AGENT } from "./metadata.js";
import { getSettings } from "./settings.js";

const DAY = 86_400_000;
/** Relations that keep two entries in one franchise (not "character", "other", "adaptation"…). */
const FRANCHISE_REL = new Set(["SEQUEL", "PREQUEL", "PARENT", "SIDE_STORY", "SPIN_OFF", "SUMMARY", "ALTERNATIVE"]);

export interface Entry {
  anilistId: number;
  anidbId: number | null;
  tvdbId: number | null;
  tvdbSeason: string | null;
  tvdbOffset: number;
  tmdbTv: number | null;
  tmdbSeason: number | null;
  tmdbMovie: number | null;
  kind: string | null;
  title: string;
  titleRomaji: string | null;
  titleEnglish: string | null;
  titleNative: string | null;
  synonyms: string[];
  status: string | null;
  year: number | null;
  startDate: string | null;
  endDate: string | null;
  episodes: number | null;
  duration: number | null;
  country: string | null;
  cover: string | null;
  banner: string | null;
  description: string | null;
  genres: string[];
  nextEpisode: number | null;
  nextAt: number | null;
  franchiseId: number | null;
}

const date = (d: { year: number | null; month: number | null; day: number | null }) => (d.year ? `${d.year}-${String(d.month ?? 1).padStart(2, "0")}-${String(d.day ?? 1).padStart(2, "0")}` : null);

/** "Episode 5 - The Title" (Crunchyroll style) → [5, "The Title"]. */
export function parseStreamingTitle(t: string | null): [number, string] | null {
  const m = /^\s*(?:Episode|Ep\.?|#)\s*(\d+(?:\.\d+)?)\s*[-–:]\s*(.+)$/i.exec(t ?? "");
  return m && Number.isInteger(Number(m[1])) ? [Number(m[1]), m[2].trim()] : null;
}

/** Stores one AniList media (and its schedule, titles, relations) with its Anime-Lists mapping. */
export function upsertMedia(m: AniMedia, anidbId: number | null, now = Date.now()) {
  const al = anidbId ? animeListEntries().get(anidbId) : undefined;
  db.prepare(
    `INSERT INTO entries (anilist_id, anidb_id, mal_id, tvdb_id, tvdb_season, tvdb_offset, tmdb_tv, tmdb_season, tmdb_offset, tmdb_movie, kind, title_romaji, title_english, title_native, synonyms, status,
       season_year, start_date, end_date, episodes, duration, country, cover, banner, color, description, genres, adult, next_ep, next_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(anilist_id) DO UPDATE SET anidb_id = excluded.anidb_id, mal_id = excluded.mal_id, tvdb_id = excluded.tvdb_id, tvdb_season = excluded.tvdb_season, tvdb_offset = excluded.tvdb_offset,
       tmdb_tv = excluded.tmdb_tv, tmdb_season = excluded.tmdb_season, tmdb_offset = excluded.tmdb_offset, tmdb_movie = excluded.tmdb_movie, kind = excluded.kind, title_romaji = excluded.title_romaji, title_english = excluded.title_english,
       title_native = excluded.title_native, synonyms = excluded.synonyms, status = excluded.status, season_year = excluded.season_year, start_date = excluded.start_date, end_date = excluded.end_date,
       episodes = excluded.episodes, duration = excluded.duration, country = excluded.country, cover = excluded.cover, banner = excluded.banner, color = excluded.color, description = excluded.description,
       genres = excluded.genres, adult = excluded.adult, next_ep = excluded.next_ep, next_at = excluded.next_at, fetched_at = excluded.fetched_at`,
  ).run(
    m.id, anidbId, m.idMal, al?.tvdbId ?? null, al?.defaultSeason === null || al?.defaultSeason === undefined ? null : String(al.defaultSeason), al?.offset ?? 0, al?.tmdbTv ?? null, al?.tmdbSeason ?? null, al?.tmdbOffset ?? 0, al?.tmdbMovie ?? null,
    m.format, m.title.romaji, m.title.english, m.title.native, JSON.stringify(m.synonyms ?? []), m.status, m.seasonYear ?? m.startDate?.year ?? null, date(m.startDate), date(m.endDate), m.episodes, m.duration,
    m.countryOfOrigin, m.coverImage?.large ?? null, m.bannerImage, m.coverImage?.color ?? null, (m.description ?? "").replace(/<[^>]+>/g, "").slice(0, 4000), JSON.stringify(m.genres ?? []), m.isAdult ? 1 : 0,
    m.nextAiringEpisode?.episode ?? null, m.nextAiringEpisode ? m.nextAiringEpisode.airingAt * 1000 : null, now,
  );
  // Episodes: air times from the schedule, titles from the streaming list; TMDB/AniDB titles (source) are kept.
  const titles = new Map<number, string>();
  for (const s of m.streamingEpisodes ?? []) {
    const p = parseStreamingTitle(s.title);
    if (p && !titles.has(p[0])) titles.set(p[0], p[1]);
  }
  const numbers = new Set<number>([...(m.airingSchedule?.nodes ?? []).map((n) => n.episode), ...titles.keys()]);
  const air = new Map((m.airingSchedule?.nodes ?? []).map((n) => [n.episode, n.airingAt * 1000]));
  for (const n of numbers)
    db.prepare(
      `INSERT INTO entry_episodes (anilist_id, number, title, air_utc, source) VALUES (?, ?, ?, ?, 'anilist')
       ON CONFLICT(anilist_id, number) DO UPDATE SET title = CASE WHEN entry_episodes.source = 'anilist' THEN COALESCE(excluded.title, entry_episodes.title) ELSE entry_episodes.title END,
         air_utc = COALESCE(excluded.air_utc, entry_episodes.air_utc)`,
    ).run(m.id, n, titles.get(n) ?? null, air.get(n) ?? null);
  applyOverrides(m.id); // a user's/auto match wins over the mapping just written
  db.prepare("DELETE FROM entry_relations WHERE from_id = ?").run(m.id);
  for (const e of m.relations?.edges ?? []) if (e.node.type === "ANIME") db.prepare("INSERT OR IGNORE INTO entry_relations (from_id, to_id, type) VALUES (?, ?, ?)").run(m.id, e.node.id, e.relationType);
}

/** User/auto matches (catalog_overrides) win over Anime-Lists/Fribb: re-applied after every mapping pass. */
export function applyOverrides(only?: number) {
  for (const o of (only === undefined ? db.prepare("SELECT anilist_id, tvdb_id, tvdb_season, tvdb_offset, tmdb_movie FROM catalog_overrides").all() : db.prepare("SELECT anilist_id, tvdb_id, tvdb_season, tvdb_offset, tmdb_movie FROM catalog_overrides WHERE anilist_id = ?").all(only)) as { anilist_id: number; tvdb_id: number | null; tvdb_season: string | null; tvdb_offset: number; tmdb_movie: number | null }[]) {
    if (o.tvdb_id) db.prepare("UPDATE entries SET tvdb_id = ?, tvdb_season = ?, tvdb_offset = ? WHERE anilist_id = ?").run(o.tvdb_id, o.tvdb_season ?? "1", o.tvdb_offset, o.anilist_id);
    if (o.tmdb_movie) db.prepare("UPDATE entries SET tmdb_movie = ? WHERE anilist_id = ?").run(o.tmdb_movie, o.anilist_id);
  }
}

/** Recomputes franchises: connected entries through franchise relations; id = smallest AniList id, title = the earliest TV entry's. */
export function rebuildFranchises(now = Date.now()) {
  applyOverrides(); // runs at the end of every catalog refresh: overrides survive re-mapping
  const ids = (db.prepare("SELECT anilist_id FROM entries").all() as { anilist_id: number }[]).map((r) => r.anilist_id);
  const parent = new Map<number, number>(ids.map((i) => [i, i]));
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const r of db.prepare("SELECT from_id, to_id, type FROM entry_relations").all() as { from_id: number; to_id: number; type: string }[]) {
    if (!FRANCHISE_REL.has(r.type) || !parent.has(r.from_id) || !parent.has(r.to_id)) continue;
    const [a, b] = [find(r.from_id), find(r.to_id)];
    if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
  }
  const groups = new Map<number, number[]>();
  for (const i of ids) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);
  tx(db, () => {
    db.prepare("DELETE FROM franchises").run();
    for (const [root, members] of groups) {
      const rows = db.prepare(`SELECT anilist_id, kind, title_english, title_romaji, start_date FROM entries WHERE anilist_id IN (${members.map(() => "?").join(",")}) ORDER BY (kind IN ('TV', 'TV_SHORT', 'ONA')) DESC, start_date IS NULL, start_date`).all(...members) as { title_english: string | null; title_romaji: string | null }[];
      const id = Math.min(...members);
      db.prepare("INSERT INTO franchises (id, title, updated_at) VALUES (?, ?, ?)").run(id, rows[0]?.title_english ?? rows[0]?.title_romaji ?? String(root), now);
      db.prepare(`UPDATE entries SET franchise_id = ? WHERE anilist_id IN (${members.map(() => "?").join(",")})`).run(id, ...members);
    }
  });
  return groups.size;
}

export interface CatalogDeps { media: typeof mediaByIds; fribb: typeof fribb }
const realDeps: CatalogDeps = { media: mediaByIds, fribb };

/**
 * Refreshes the catalog: every entry of the library (series via Anime-Lists, movies via TMDB), entries due for a
 * refresh (airing: daily; others: weekly), and their franchise relations one hop out (capped per run).
 */
export async function refreshCatalog(opts: { limit?: number; force?: boolean } = {}, deps: CatalogDeps = realDeps, now = Date.now()) {
  if (dbState.corrupt) return { fetched: 0 };
  const limit = opts.limit ?? 600;
  const f = await deps.fribb();
  const al = animeListEntries();
  // Seeds: the library's series and movies → AniDB (Anime-Lists) → AniList (Fribb).
  const seeds = new Set<number>();
  const tvdbs = new Set((cache.prepare("SELECT tvdb_id FROM series").all() as { tvdb_id: number }[]).map((r) => r.tvdb_id));
  const tmdbs = new Set((cache.prepare("SELECT tmdb_id FROM movies WHERE is_anime = 1 AND tmdb_id IS NOT NULL").all() as { tmdb_id: number }[]).map((r) => r.tmdb_id));
  for (const e of al.values()) if ((e.tvdbId && tvdbs.has(e.tvdbId)) || (e.tmdbMovie && tmdbs.has(e.tmdbMovie))) if (f.anidbToAnilist.has(e.aid)) seeds.add(f.anidbToAnilist.get(e.aid)!);
  for (const [alId, tm] of f.anilistToTmdb) if (tmdbs.has(tm)) seeds.add(alId);
  for (const r of db.prepare("SELECT anilist_id FROM catalog_pins").all() as { anilist_id: number }[]) seeds.add(r.anilist_id);
  for (const r of db.prepare("SELECT anilist_id FROM catalog_overrides").all() as { anilist_id: number }[]) seeds.add(r.anilist_id);
  // Exactly one hop out from the seeds (sequels, prequels, side stories, movies…): never a crawl.
  const want = new Set(seeds);
  const hop = seeds.size ? (db.prepare(`SELECT to_id, type FROM entry_relations WHERE from_id IN (${[...seeds].map(() => "?").join(",")})`).all(...seeds) as { to_id: number; type: string }[]) : [];
  for (const r of hop) if (FRANCHISE_REL.has(r.type)) want.add(r.to_id);
  // Prune what isn't wanted any more (removed from the library, or a crawl leftover).
  const gone = (db.prepare("SELECT anilist_id FROM entries").all() as { anilist_id: number }[]).map((r) => r.anilist_id).filter((x) => !want.has(x));
  if (gone.length && seeds.size)
    tx(db, () => {
      for (const id of gone) {
        db.prepare("DELETE FROM entries WHERE anilist_id = ?").run(id);
        db.prepare("DELETE FROM entry_episodes WHERE anilist_id = ?").run(id);
        db.prepare("DELETE FROM entry_relations WHERE from_id = ?").run(id);
      }
    });
  // Mappings follow Anime-Lists/Fribb changes every run (no AniList fetch needed).
  remap(f);
  const known = new Map((db.prepare("SELECT anilist_id, status, fetched_at FROM entries").all() as { anilist_id: number; status: string | null; fetched_at: number }[]).map((r) => [r.anilist_id, r]));
  const missing = new Map((db.prepare("SELECT anilist_id, at FROM catalog_missing").all() as { anilist_id: number; at: number }[]).map((r) => [r.anilist_id, r.at]));
  const due = (id: number) => {
    if (missing.has(id) && now - missing.get(id)! < 7 * DAY) return false; // AniList didn't return it last time
    const k = known.get(id);
    if (!k || opts.force) return true;
    return now - k.fetched_at > (k.status === "RELEASING" || k.status === "NOT_YET_RELEASED" ? DAY : 7 * DAY);
  };
  // Library seeds first, then their neighbours.
  const todo = [...seeds, ...[...want].filter((x) => !seeds.has(x))].filter(due).slice(0, limit);
  if (!todo.length) return { fetched: 0, franchises: rebuildFranchises(now) };
  setJob("catalog", "running", `Fetching ${todo.length} entries from AniList`);
  let fetched = 0;
  for (let i = 0; i < todo.length; i += 50) {
    const ask = todo.slice(i, i + 50);
    const batch = await deps.media(ask);
    const got = new Set(batch.map((m) => m.id));
    tx(db, () => {
      for (const m of batch) upsertMedia(m, anidbFor(f, m.id), now);
      for (const id of ask) if (!got.has(id)) db.prepare("INSERT OR REPLACE INTO catalog_missing (anilist_id, at) VALUES (?, ?)").run(id, now);
    });
    fetched += batch.length;
    setJob("catalog", "running", `Fetched ${fetched} of ${todo.length} entries from AniList`);
  }
  const franchises = rebuildFranchises(now);
  setJob("catalog", "done", `${fetched} entries refreshed; ${(db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n} known in ${franchises} franchises`);
  return { fetched, franchises };
}

/**
 * The AniDB id for an AniList id. Fribb can map one AniList entry to several AniDB ids (AniDB splits a show AniList
 * keeps whole): then the one with the smallest Anime-Lists offset (the start) wins.
 */
function anidbFor(f: Awaited<ReturnType<typeof fribb>>, anilistId: number): number | null {
  const all = f.anilistToAnidbAll?.get(anilistId) ?? [];
  if (all.length <= 1) return all[0] ?? f.anilistToAnidb.get(anilistId) ?? null;
  const al = animeListEntries();
  return [...all].sort((a, b) => (al.get(a)?.offset ?? 0) - (al.get(b)?.offset ?? 0))[0];
}

/** Re-applies Anime-Lists mappings (TVDB/TMDB ids, seasons, offsets) to known entries. Local only. */
function remap(f: Awaited<ReturnType<typeof fribb>>) {
  const al = animeListEntries();
  const rows = db.prepare("SELECT anilist_id FROM entries").all() as { anilist_id: number }[];
  const up = db.prepare("UPDATE entries SET anidb_id = ?, tvdb_id = ?, tvdb_season = ?, tvdb_offset = ?, tmdb_tv = ?, tmdb_season = ?, tmdb_offset = ?, tmdb_movie = ? WHERE anilist_id = ?");
  tx(db, () => {
    for (const r of rows) {
      const aid = anidbFor(f, r.anilist_id);
      const e = aid ? al.get(aid) : undefined;
      up.run(aid, e?.tvdbId ?? null, e?.defaultSeason === null || e?.defaultSeason === undefined ? null : String(e.defaultSeason), e?.offset ?? 0, e?.tmdbTv ?? null, e?.tmdbSeason ?? null, e?.tmdbOffset ?? 0, e?.tmdbMovie ?? null, r.anilist_id);
    }
    applyOverrides(); // in the same transaction: never a moment with the override lost
  });
}

/** Re-applies the mappings now (after an override was removed). */
export async function remapNow() {
  remap(await fribb());
}

// ---------------------------------------------------------------- reading

interface Row { anilist_id: number; anidb_id: number | null; tvdb_id: number | null; tvdb_season: string | null; tvdb_offset: number; tmdb_tv: number | null; tmdb_season: number | null; tmdb_movie: number | null; kind: string | null; title_romaji: string | null; title_english: string | null; title_native: string | null; synonyms: string; status: string | null; season_year: number | null; start_date: string | null; end_date: string | null; episodes: number | null; duration: number | null; country: string | null; cover: string | null; banner: string | null; description: string | null; genres: string; next_ep: number | null; next_at: number | null; franchise_id: number | null }
export const toEntry = (r: Row): Entry => ({
  anilistId: r.anilist_id, anidbId: r.anidb_id, tvdbId: r.tvdb_id, tvdbSeason: r.tvdb_season, tvdbOffset: r.tvdb_offset, tmdbTv: r.tmdb_tv, tmdbSeason: r.tmdb_season, tmdbMovie: r.tmdb_movie,
  kind: r.kind, title: r.title_english ?? r.title_romaji ?? r.title_native ?? String(r.anilist_id), titleRomaji: r.title_romaji, titleEnglish: r.title_english, titleNative: r.title_native,
  synonyms: JSON.parse(r.synonyms) as string[], status: r.status, year: r.season_year, startDate: r.start_date, endDate: r.end_date, episodes: r.episodes, duration: r.duration, country: r.country,
  cover: r.cover, banner: r.banner, description: r.description, genres: JSON.parse(r.genres) as string[], nextEpisode: r.next_ep, nextAt: r.next_at, franchiseId: r.franchise_id,
});

/** The entries mapped to a TVDB series, in TVDB season order, plus the rest of their franchise. */
export function entriesForSeries(tvdbId: number) {
  const mine = (db.prepare("SELECT * FROM entries WHERE tvdb_id = ? ORDER BY start_date IS NULL, start_date").all(tvdbId) as unknown as Row[]).map(toEntry);
  const fids = [...new Set(mine.map((e) => e.franchiseId).filter((x): x is number => !!x))];
  const others = fids.length ? (db.prepare(`SELECT * FROM entries WHERE franchise_id IN (${fids.map(() => "?").join(",")}) AND (tvdb_id IS NULL OR tvdb_id != ?) ORDER BY start_date IS NULL, start_date`).all(...fids, tvdbId) as unknown as Row[]).map(toEntry) : [];
  const franchise = fids.length ? (db.prepare("SELECT id, title FROM franchises WHERE id = ?").get(fids[0]) as { id: number; title: string } | undefined) ?? null : null;
  return { franchise, entries: mine, related: others };
}

/**
 * The catalog's title for a TVDB episode (when Sonarr's is missing or TBA): through the Anime-Lists season/offset
 * of the entry that covers it. Returns the entry's native/romaji too, for a secondary line.
 */
export function catalogEpisode(tvdbId: number, season: number, episode: number, absolute: number | null) {
  return catalogLookup(tvdbId)(season, episode, absolute);
}

/** A lookup for one series (loaded once): TVDB S/E (or absolute) → the catalog episode. Specials aren't guessed. */
export function catalogLookup(tvdbId: number) {
  const rows = db.prepare("SELECT anilist_id, tvdb_season, tvdb_offset, episodes FROM entries WHERE tvdb_id = ? AND tvdb_season IS NOT NULL AND tvdb_season != '0' ORDER BY tvdb_offset DESC").all(tvdbId) as { anilist_id: number; tvdb_season: string; tvdb_offset: number; episodes: number | null }[];
  const eps = new Map<number, Map<number, { title: string | null; air_utc: number | null }>>();
  if (rows.length)
    for (const e of db.prepare(`SELECT anilist_id, number, title, air_utc FROM entry_episodes WHERE anilist_id IN (${rows.map(() => "?").join(",")})`).all(...rows.map((r) => r.anilist_id)) as { anilist_id: number; number: number; title: string | null; air_utc: number | null }[]) {
      if (!eps.has(e.anilist_id)) eps.set(e.anilist_id, new Map());
      eps.get(e.anilist_id)!.set(e.number, e);
    }
  return (season: number, episode: number, absolute: number | null) => {
    if (season === 0) return null;
    for (const r of rows) {
      const n = r.tvdb_season === "a" ? (absolute ? absolute - r.tvdb_offset : null) : Number(r.tvdb_season) === season ? episode - r.tvdb_offset : null;
      if (!n || n < 1 || (r.episodes && n > r.episodes)) continue;
      const e = eps.get(r.anilist_id)?.get(n);
      if (e) return { anilistId: r.anilist_id, number: n, title: e.title, airUtc: e.air_utc };
    }
    return null;
  };
}

export function catalogStatus() {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const s = getSettings().metadata;
  return {
    entries: n("SELECT COUNT(*) AS n FROM entries"),
    franchises: n("SELECT COUNT(*) AS n FROM franchises"),
    episodes: n("SELECT COUNT(*) AS n FROM entry_episodes"),
    withTitles: n("SELECT COUNT(*) AS n FROM entry_episodes WHERE title IS NOT NULL"),
    withoutTvdb: n("SELECT COUNT(*) AS n FROM entries WHERE tvdb_id IS NULL AND kind IN ('TV', 'TV_SHORT', 'ONA')"),
    donghua: n("SELECT COUNT(*) AS n FROM entries WHERE country = 'CN'"),
    providers: { anilist: true, animeLists: animeListEntries().size > 0, tmdb: !!s.tmdbKey, anidb: !!s.anidbClient },
    /** Saved, but not used yet (coming with later rounds). */
    pending: { tvdb: !!s.tvdbKey },
    lastJob: (cache.prepare("SELECT state, detail, finished_at FROM jobs WHERE name = 'catalog'").get() as { state: string; detail: string; finished_at: number } | undefined) ?? null,
  };
}

// ---------------------------------------------------------------- optional: TMDB episode titles (when a key is set)

/**
 * A TMDB request with either credential TMDB hands out: the v3 API key (32 hex characters → ?api_key=) or the API
 * Read Access Token (a JWT, "eyJ…" → Authorization: Bearer). Never logged; errors never include the URL.
 */
export function tmdbFetch(pathAndQuery: string, key: string, fetcher: typeof fetch = fetch) {
  const k = key.trim();
  const bearer = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(k);
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const url = `https://api.themoviedb.org/3${pathAndQuery}${bearer ? "" : `${sep}api_key=${encodeURIComponent(k)}`}`;
  return fetcher(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(bearer ? { Authorization: `Bearer ${k}` } : {}) }, signal: AbortSignal.timeout(20_000) });
}

/** What kind of TMDB credential this looks like (for the settings page). */
export const tmdbKeyKind = (key: string) => (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(key.trim()) ? "token" : /^[0-9a-f]{32}$/i.test(key.trim()) ? "apiKey" : "unknown");

/** Settings → Metadata test: /3/configuration with the given (or saved) credential. */
export async function testTmdb(key: string, fetcher: typeof fetch = fetch) {
  if (tmdbKeyKind(key) === "unknown") throw Object.assign(new Error("That doesn't look like a TMDB API key (32 hex characters) or a Read Access Token (starts with eyJ)"), { statusCode: 400 });
  let res: Response;
  try {
    res = await tmdbFetch("/configuration", key, fetcher);
  } catch (e) {
    throw Object.assign(new Error(`TMDB unreachable (${(e as Error).message})`), { statusCode: 502 });
  }
  if (res.status === 401) throw Object.assign(new Error("TMDB refused it (401): check the key or token"), { statusCode: 400 });
  if (!res.ok) throw Object.assign(new Error(`TMDB HTTP ${res.status}`), { statusCode: 502 });
  return { ok: true, kind: tmdbKeyKind(key) };
}

/** Fills episode titles/air dates from TMDB for entries mapped to a TMDB TV season (one request per season, cached a week). */
export async function tmdbEpisodes(limit = 300, fetcher: typeof fetch = fetch, now = Date.now()) {
  const key = getSettings().metadata.tmdbKey;
  if (!key) return 0;
  const rows = db.prepare("SELECT anilist_id, tmdb_tv, tmdb_season, tmdb_offset, episodes FROM entries WHERE tmdb_tv IS NOT NULL AND tmdb_season IS NOT NULL AND (tmdb_fetched_at IS NULL OR tmdb_fetched_at < ?) ORDER BY tmdb_fetched_at IS NOT NULL, tmdb_fetched_at LIMIT ?").all(now - 7 * DAY, limit) as { anilist_id: number; tmdb_tv: number; tmdb_season: number; tmdb_offset: number; episodes: number | null }[];
  let n = 0;
  for (const r of rows) {
    try {
      const res = await tmdbFetch(`/tv/${r.tmdb_tv}/season/${r.tmdb_season}?language=en-US`, key, fetcher);
      if (res.status === 401) throw new Error("TMDB rejected the API key / token");
      if (res.status === 429) break;
      if (!res.ok) {
        db.prepare("UPDATE entries SET tmdb_fetched_at = ? WHERE anilist_id = ?").run(now, r.anilist_id); // not on TMDB: try again next week
        continue;
      }
      const j = (await res.json()) as { episodes?: { episode_number: number; name: string | null; air_date: string | null }[] };
      for (const e of j.episodes ?? []) {
        // TMDB numbering inside the season → this entry's episode number (Anime-Lists' tmdboffset for split cours).
        const number = e.episode_number - (r.tmdb_offset ?? 0);
        if (number < 1 || (r.episodes && number > r.episodes)) continue;
        const air = e.air_date ? Date.parse(`${e.air_date}T00:00:00Z`) : null;
        db.prepare(
          `INSERT INTO entry_episodes (anilist_id, number, title, air_utc, source) VALUES (?, ?, ?, ?, 'tmdb')
           ON CONFLICT(anilist_id, number) DO UPDATE SET title = COALESCE(excluded.title, entry_episodes.title), source = CASE WHEN excluded.title IS NOT NULL THEN 'tmdb' ELSE entry_episodes.source END, air_utc = COALESCE(entry_episodes.air_utc, excluded.air_utc)`,
        ).run(r.anilist_id, number, e.name && !/^Episode \d+$/i.test(e.name) ? e.name : null, air);
      }
      db.prepare("UPDATE entries SET tmdb_fetched_at = ? WHERE anilist_id = ?").run(now, r.anilist_id);
      n++;
      await new Promise((res) => setTimeout(res, 300));
    } catch (e) {
      logDecision("info", { why: `TMDB episode titles: ${(e as Error).message}` });
      break;
    }
  }
  return n;
}
