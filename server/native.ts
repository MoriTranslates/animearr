/**
 * Native shows (1.0 takeover, step 4): shows added in AnimeArr itself, with no Sonarr involvement.
 *
 * A native show is built from AnimeArr's own catalog (AniList entries + Anime-Lists mappings):
 * - when the AniList entry maps to a TVDB series, the show IS that TVDB series (seasons/episodes numbered like TVDB,
 *   so Plex and anything TVDB-based agree), made of every entry mapped to it;
 * - otherwise (donghua, ONAs TVDB doesn't have) it's that one entry as season 1, under a synthetic id.
 *
 * The user's choices live in animearr.db (native_series); the show's rows in the rebuildable cache (series,
 * episodes, files, alt_titles) are materialized from the catalog and AnimeArr's own file records, so every other part
 * of AnimeArr (search, grabs, scopes, calendar, the Show page) works on it like on a Sonarr show.
 */
import { anidbForTvdb } from "./anidb.js";
import fs from "node:fs";
import path from "node:path";
import { logDecision } from "./activity.js";
import { mediaByIds, searchMedia, type AniMedia } from "./anilist.js";
import { rebuildFranchises, upsertMedia } from "./catalog.js";
import { compactKey } from "./core/normalize.js";
import { parseRelease } from "./core/parser.js";
import { fribb } from "./covers.js";
import { cache, db, dbState, tx } from "./db.js";
import { animeListEntries, invalidateIndex } from "./metadata.js";
import { renderMovie, renderSeriesFolder } from "./naming.js";
import { mappedPath } from "./paths.js";
import { getSettings, underAllowedRoot } from "./settings.js";

/** Cache ids of native shows/episodes/files start here (Sonarr's ids are far below). */
export const NATIVE_BASE = 900_000_000;
/** Synthetic TVDB ids for shows TVDB doesn't have: NATIVE_BASE + AniList id. */
export const isNativeSeriesId = (id: number) => id >= NATIVE_BASE;
const episodeId = (row: number, season: number, episode: number) => NATIVE_BASE + row * 1_000_000 + season * 10_000 + episode;

const err = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });

interface NativeRow { id: number; tvdb_id: number; anilist_id: number; synthetic: number; title: string; year: number | null; path: string; root_folder: string; added_at: number }
interface EntryRow { anilist_id: number; anidb_id: number | null; tvdb_season: string | null; tvdb_offset: number; kind: string | null; title_english: string | null; title_romaji: string | null; title_native: string | null; synonyms: string; status: string | null; season_year: number | null; start_date: string | null; episodes: number | null; duration: number | null; country: string | null; cover: string | null; description: string | null; genres: string; next_ep: number | null; next_at: number | null }

export const nativeShows = () => db.prepare("SELECT * FROM native_series ORDER BY id").all() as unknown as NativeRow[];
export const isNativeTvdb = (tvdbId: number) => !!db.prepare("SELECT 1 FROM native_series WHERE tvdb_id = ?").get(tvdbId);

const LANG: Record<string, string> = { JP: "Japanese", CN: "Chinese", KR: "Korean", TW: "Chinese" };
const STATUS: Record<string, string> = { RELEASING: "continuing", FINISHED: "ended", NOT_YET_RELEASED: "upcoming", HIATUS: "continuing", CANCELLED: "ended" };
const SERIES_KINDS = new Set(["TV", "TV_SHORT", "ONA", "OVA", "SPECIAL"]);

/** The entries a native show is made of, in order, with the season each one is numbered in. */
function showEntries(n: NativeRow): (EntryRow & { season: number; offset: number })[] {
  if (n.synthetic) {
    const e = db.prepare("SELECT * FROM entries WHERE anilist_id = ?").get(n.anilist_id) as unknown as EntryRow | undefined;
    return e ? [{ ...e, season: 1, offset: 0 }] : [];
  }
  const rows = db.prepare("SELECT * FROM entries WHERE tvdb_id = ? AND tvdb_season IS NOT NULL AND tvdb_season != '0' ORDER BY start_date IS NULL, start_date").all(n.tvdb_id) as unknown as EntryRow[];
  // "a" (absolute across TVDB seasons) can't be split without TVDB's own season lengths: numbered as season 1.
  return rows.filter((r) => SERIES_KINDS.has(r.kind ?? "TV")).map((r) => ({ ...r, season: r.tvdb_season === "a" ? 1 : Number(r.tvdb_season), offset: r.tvdb_offset }));
}

/** Writes one native show's cache rows (series, episodes, files from AnimeArr's own records, alt titles). */
const clearRows = (sid: number) =>
  tx(cache, () => {
    for (const t of ["series WHERE id", "episodes WHERE series_id", "files WHERE series_id", "alt_titles WHERE series_id"]) cache.prepare(`DELETE FROM ${t} = ?`).run(sid);
  });

/** Sonarr has this TVDB series too (added there after AnimeArr): Sonarr's copy is the one used; the native one is parked. */
export const ownedBySonarr = (tvdbId: number) => !!cache.prepare("SELECT 1 FROM series WHERE tvdb_id = ? AND id < ?").get(tvdbId, NATIVE_BASE);

type Ep = { id: number; season: number; episode: number; absolute: number; title: string | null; air: number | null; runtime: number | null };

/** A native show's episodes from the catalog (pure: nothing is written). */
export function buildEpisodes(n: Pick<NativeRow, "id" | "tvdb_id" | "anilist_id" | "synthetic">) {
  const entries = showEntries(n as NativeRow);
  const byKey = new Map<string, Ep>();
  for (const e of entries) {
    const list = new Map((db.prepare("SELECT number, title, air_utc FROM entry_episodes WHERE anilist_id = ?").all(e.anilist_id) as { number: number; title: string | null; air_utc: number | null }[]).map((x) => [x.number, x]));
    const count = e.episodes ?? Math.max(0, ...list.keys(), e.next_ep ?? 0); // airing: the next episode too (it has an air time)
    for (let k = 1; k <= count; k++) {
      const ep = k + e.offset;
      if (ep <= 0 || ep >= 10_000) continue;
      const key = `${e.season}x${ep}`;
      if (byKey.has(key)) continue; // two entries on the same S/E (overlapping mappings): the earlier entry wins
      const x = list.get(k);
      byKey.set(key, { id: episodeId(n.id, e.season, ep), season: e.season, episode: ep, absolute: e.tvdb_season === "a" ? ep : 0, title: x?.title ?? null, air: x?.air_utc ?? (e.next_ep === k ? e.next_at : null), runtime: e.duration });
    }
  }
  // AniDB (when fetched): fills episodes AniList's entries don't cover (e.g. a season mapped only on AniDB), missing
  // titles and air dates, and season 0 — specials placed by Anime-Lists' mapping lists.
  // AniDB entries already represented by an AniList entry (or any absolute-numbered entry) only fill titles/dates.
  const covered = new Set(entries.map((e) => e.anidb_id).filter((x): x is number => !!x));
  const absoluteEntry = entries.some((e) => e.tvdb_season === "a");
  if (!n.synthetic)
    for (const a of anidbForTvdb(n.tvdb_id)) {
      const key = `${a.season}x${a.episode}`;
      const have = byKey.get(key);
      if (have) {
        have.title ??= a.title;
        have.air ??= a.air;
        have.runtime ??= a.length;
        continue;
      }
      if (a.episode <= 0 || a.episode >= 10_000) continue;
      if (a.season > 0 && (covered.has(a.aid) || absoluteEntry)) continue;
      byKey.set(key, { id: episodeId(n.id, a.season, a.episode), season: a.season, episode: a.episode, absolute: 0, title: a.title, air: a.air, runtime: a.length });
    }
  // Absolute numbers: in (season, episode) order, regular seasons only; "a" entries already are absolute.
  const eps = [...byKey.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
  let abs = 0;
  for (const e of eps) if (e.season > 0) e.absolute = e.absolute || ++abs;
  return { entries, eps, byKey };
}

export function materialize(n: NativeRow, now = Date.now()) {
  const sid = NATIVE_BASE + n.id;
  if (ownedBySonarr(n.tvdb_id)) {
    clearRows(sid);
    return { episodes: 0, files: 0, parked: true };
  }
  const { entries, eps, byKey } = buildEpisodes(n);
  const first = entries[0];
  // After a cutover the show's id changes: the managed row follows (the rest is moved by the cutover itself).
  db.prepare("UPDATE managed SET series_id = ? WHERE tvdb_id = ?").run(sid, n.tvdb_id);
  // Files: AnimeArr's own records under the show's folder, matched by the SxxEyy in the name (season folder as a
  // fallback for the season), or a bare episode number for season-1-only shows.
  const base = n.path.replace(/\/+$/, "");
  const recs = db.prepare("SELECT path, size, video, audio, subs FROM media_files WHERE substr(path, 1, ?) = ?").all(base.length + 1, `${base}/`) as { path: string; size: number; video: string; audio: string; subs: string }[];
  const byAbs = new Map(eps.map((e) => [e.absolute, e]));
  // Files AnimeArr imported itself know their episodes; only older files are matched by name.
  const links = new Map((db.prepare("SELECT path, episode_ids FROM file_links WHERE tvdb_id = ?").all(n.tvdb_id) as { path: string; episode_ids: string }[]).map((r) => [r.path, JSON.parse(r.episode_ids) as number[]]));
  const files: { id: number; path: string; size: number; season: number; eps: number[]; audio: string; subs: string; resolution: string | null }[] = [];
  const oneSeason = new Set(eps.map((e) => e.season)).size === 1;
  for (const r of recs) {
    const name = path.posix.basename(r.path);
    const folderSeason = /(?:^|\/)Season (\d+)\//i.exec(r.path.slice(base.length))?.[1];
    const m = /S(\d{1,2})E(\d{1,4})(?:-?E?(\d{1,4}))?/i.exec(name);
    let hit: Ep[] = [];
    const linked = links.get(r.path);
    if (linked) hit = linked.map((id) => eps.find((e) => e.id === id)).filter((x): x is Ep => !!x);
    if (hit.length) {
      /* known from the import */
    } else if (m) {
      const s = Number(m[1]);
      const a = Number(m[2]);
      const b = m[3] ? Number(m[3]) : a;
      for (let k = a; k <= b && k - a < 50; k++) if (byKey.get(`${s}x${k}`)) hit.push(byKey.get(`${s}x${k}`)!);
    } else if (oneSeason || folderSeason) {
      const p = parseRelease(name);
      const nums = p.episodes.length ? p.episodes : p.absolute;
      hit = nums.map((x) => (folderSeason ? byKey.get(`${Number(folderSeason)}x${x}`) : byAbs.get(x))).filter((x): x is Ep => !!x);
    }
    if (!hit.length) continue;
    const audio = (JSON.parse(r.audio) as { lang: string | null }[]).map((a) => a.lang).filter(Boolean);
    const subs = (JSON.parse(r.subs) as { lang: string | null; partial?: boolean }[]).filter((s) => !s.partial).map((s) => s.lang).filter(Boolean);
    const v = JSON.parse(r.video) as { width: number | null; height: number | null } | null;
    files.push({ id: hit[0].id, path: r.path, size: r.size, season: hit[0].season, eps: hit.map((h) => h.id), audio: [...new Set(audio)].join("/"), subs: [...new Set(subs)].join("/"), resolution: v?.width && v.height ? `${v.width}x${v.height}` : null });
  }
  const fileOf = new Map<number, number>();
  for (const f of files) for (const e of f.eps) fileOf.set(e, f.id);
  const seasons = [...new Set(eps.map((e) => e.season))].map((s) => {
    const inS = eps.filter((e) => e.season === s);
    return { season: s, monitored: s > 0, files: inS.filter((e) => fileOf.has(e.id)).length, episodes: inS.length, total: inS.length };
  });
  const alt = new Set<string>();
  for (const e of entries) for (const t of [e.title_english, e.title_romaji, e.title_native, ...(JSON.parse(e.synonyms) as string[])]) if (t && t !== n.title) alt.add(t);
  const next = eps.filter((e) => e.air && e.air > now).sort((a, b) => a.air! - b.air!)[0];
  const prev = eps.filter((e) => e.air && e.air <= now).sort((a, b) => b.air! - a.air!)[0];
  const status = entries.some((e) => e.status === "RELEASING" || e.status === "NOT_YET_RELEASED" || e.status === "HIATUS") ? (entries.every((e) => e.status === "NOT_YET_RELEASED") ? "upcoming" : "continuing") : (STATUS[first?.status ?? ""] ?? "ended");
  tx(cache, () => {
    for (const t of ["series WHERE id", "episodes WHERE series_id", "files WHERE series_id", "alt_titles WHERE series_id"]) cache.prepare(`DELETE FROM ${t} = ?`).run(sid);
    cache
      .prepare(
        `INSERT INTO series (id, tvdb_id, title, sort_title, year, status, series_type, path, root_folder, monitored, tags, runtime, original_language, seasons, first_aired, next_airing, previous_airing,
           anidb_ids, anidb_status, poster, added, overview, genres, synced_at, season_folder) VALUES (?, ?, ?, ?, ?, ?, 'anime', ?, ?, 1, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        sid, n.tvdb_id, n.title, n.title.toLowerCase().replace(/^(the|a|an)\s+/, ""), n.year, status, n.path, n.root_folder, first?.duration ?? null, LANG[first?.country ?? "JP"] ?? "Japanese",
        JSON.stringify(seasons), first?.start_date ?? null, next?.air ? new Date(next.air).toISOString() : null, prev?.air ? new Date(prev.air).toISOString() : null,
        JSON.stringify(entries.filter((e) => e.anidb_id).map((e) => ({ aid: e.anidb_id, season: e.season, offset: e.offset }))), entries.some((e) => e.anidb_id) ? "matched" : "review",
        first?.cover ?? null, new Date(n.added_at).toISOString(), first?.description ?? null, first?.genres ?? "[]", now,
      );
    // Specials are only monitored when there's a file (AniDB-placed specials shouldn't trigger searches).
    const insE = cache.prepare("INSERT INTO episodes (id, series_id, season, episode, absolute, title, air_date, air_utc, runtime, monitored, has_file, file_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const e of eps) insE.run(e.id, sid, e.season, e.episode, e.season > 0 ? e.absolute : null, e.title, e.air ? new Date(e.air).toISOString().slice(0, 10) : null, e.air, e.runtime, e.season > 0 || fileOf.has(e.id) ? 1 : 0, fileOf.has(e.id) ? 1 : 0, fileOf.get(e.id) ?? null);
    const insF = cache.prepare("INSERT OR REPLACE INTO files (id, series_id, season, path, size, audio_langs, sub_langs, resolution, date_added, scene_name, release_group, quality, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const f of files) {
      // Release info kept from Sonarr's records (cutover), so upgrades and learning still know the release.
      const meta = db.prepare("SELECT scene_name, release_group, quality, revision FROM file_meta WHERE path = ?").get(f.path) as { scene_name: string | null; release_group: string | null; quality: string | null; revision: string | null } | undefined;
      insF.run(f.id, sid, f.season, f.path, f.size, f.audio, f.subs, f.resolution, null, meta?.scene_name ?? null, meta?.release_group ?? null, meta?.quality ?? null, meta?.revision ?? null);
    }
    const insA = cache.prepare("INSERT INTO alt_titles (series_id, title, key, season, scene_season) VALUES (?, ?, ?, NULL, NULL)");
    for (const t of alt) insA.run(sid, t, compactKey(t));
  });
  return { episodes: eps.length, files: files.length, parked: false };
}

/** All native shows into the cache (startup, after a library sync or a catalog refresh). */
export function materializeAll() {
  if (dbState.corrupt) return 0;
  let n = 0;
  for (const r of nativeShows()) {
    try {
      materialize(r);
      n++;
    } catch (e) {
      logDecision("fail", { tvdbId: r.tvdb_id, title: r.title, why: `Couldn't build ${r.title}'s episodes from the catalog: ${(e as Error).message}` }); // one broken show doesn't stop the rest
    }
  }
  materializeAllMovies();
  invalidateIndex();
  return n;
}

/** Re-materializes a native show by cache series id (after an import or a file scan). */
export function rematerializeSeries(seriesId: number) {
  const r = db.prepare("SELECT * FROM native_series WHERE id = ?").get(seriesId - NATIVE_BASE) as unknown as NativeRow | undefined;
  if (r) materialize(r);
  invalidateIndex();
}

// ---------------------------------------------------------------- search (one box for shows and movies)

export interface AddResult {
  anilistId: number;
  title: string;
  romaji: string | null;
  native: string | null;
  kind: string | null;
  year: number | null;
  episodes: number | null;
  status: string | null;
  cover: string | null;
  country: string | null;
  tvdbId: number | null;
  tmdbMovie: number | null;
  inLibrary: { kind: "series" | "movie"; tvdbId?: number; movieId?: number; native: boolean } | null;
  matchedBy: string;
}

/** Initials of a title ("Sword Art Online" → "sao", "One Punch Man" → "opm"). */
const initials = (t: string) =>
  t
    .split(/[\s:!?.,\-–'"]+/)
    .filter((w) => /^[\p{L}\p{N}]/u.test(w))
    .map((w) => w[0])
    .join("")
    .toLowerCase();

/** Comparable key: Latin titles compacted; CJK and other scripts (which compactKey drops) kept, NFKC-normalised. */
const searchKey = (s: string) => compactKey(s) || s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

const cacheQ = new Map<string, { at: number; v: AniMedia[] }>();

/** Searches AniList (titles in English/romaji/native, synonyms) plus the local catalog (abbreviations, aliases). */
/**
 * Searches AniList and the local catalog. AniList requests share one slow queue with the catalog refresh: a search
 * waits at most 6 s (then the local results come back with `anilist: "busy"`); a late answer still fills the cache.
 */
export async function searchAdd(q: string, deps = { search: searchMedia, fribb, timeoutMs: 6000 }): Promise<{ results: AddResult[]; anilist: "ok" | "busy" | "error" | "cached" }> {
  const query = q.trim();
  if (query.length < 2) return { results: [], anilist: "ok" };
  let anilist: "ok" | "busy" | "error" | "cached" = "ok";
  const key = searchKey(query);
  if (!key) return { results: [], anilist: "ok" };
  // Local catalog first: exact/contains on every title and synonym, or the initials ("sao", "konosuba" via synonyms).
  const local = (db.prepare("SELECT * FROM entries").all() as unknown as (EntryRow & { tvdb_id: number | null; tmdb_movie: number | null })[])
    .map((e) => {
      const titles = [e.title_english, e.title_romaji, e.title_native, ...(JSON.parse(e.synonyms) as string[])].filter((t): t is string => !!t);
      const keys = titles.map(searchKey).filter(Boolean);
      const score = keys.some((k) => k === key) ? 3 : keys.some((k) => k.startsWith(key)) ? 2 : keys.some((k) => k.includes(key)) ? 1 : titles.some((t) => initials(t) === query.toLowerCase().replace(/\s+/g, "")) ? 1.5 : 0;
      return { e, score, by: score === 1.5 ? "abbreviation" : "title" };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
  let remote: AniMedia[] = [];
  const hit = cacheQ.get(key);
  if (hit && Date.now() - hit.at < 600_000) {
    remote = hit.v;
    anilist = "cached";
  } else {
    const ask = deps.search(query, 20).then((v) => {
      cacheQ.set(key, { at: Date.now(), v }); // a late answer still fills the cache for the next keystroke
      if (cacheQ.size > 200) cacheQ.delete(cacheQ.keys().next().value!);
      return v;
    });
    ask.catch(() => undefined);
    try {
      const r = await Promise.race([ask, new Promise<null>((res) => setTimeout(() => res(null), deps.timeoutMs ?? 6000))]);
      if (r === null) anilist = "busy";
      else remote = r;
    } catch (x) {
      anilist = /superseded/.test((x as Error).message) ? "busy" : "error";
    }
  }
  const f = await deps.fribb();
  const al = animeListEntries();
  const out = new Map<number, AddResult>();
  const libTvdb = new Set((cache.prepare("SELECT tvdb_id FROM series").all() as { tvdb_id: number }[]).map((r) => r.tvdb_id));
  const libMovies = new Map((cache.prepare("SELECT id, tmdb_id FROM movies WHERE tmdb_id IS NOT NULL").all() as { id: number; tmdb_id: number }[]).map((r) => [r.tmdb_id, r.id]));
  const inLib = (tvdbId: number | null, tmdbMovie: number | null, anilistId: number): AddResult["inLibrary"] => {
    if (tmdbMovie && libMovies.has(tmdbMovie)) return { kind: "movie", movieId: libMovies.get(tmdbMovie), native: libMovies.get(tmdbMovie)! >= NATIVE_BASE };
    const nm = db.prepare("SELECT id FROM native_movies WHERE anilist_id = ?").get(anilistId) as { id: number } | undefined;
    if (nm) return { kind: "movie", movieId: NATIVE_BASE + nm.id, native: true };
    const synthetic = NATIVE_BASE + anilistId;
    if (libTvdb.has(synthetic)) return { kind: "series", tvdbId: synthetic, native: true };
    if (tvdbId && libTvdb.has(tvdbId)) return { kind: "series", tvdbId, native: isNativeTvdb(tvdbId) };
    return null;
  };
  for (const { e, by } of local) {
    out.set(e.anilist_id, {
      anilistId: e.anilist_id, title: e.title_english ?? e.title_romaji ?? e.title_native ?? String(e.anilist_id), romaji: e.title_romaji, native: e.title_native, kind: e.kind, year: e.season_year,
      episodes: e.episodes, status: e.status, cover: e.cover, country: e.country, tvdbId: e.tvdb_id, tmdbMovie: e.tmdb_movie, inLibrary: inLib(e.tvdb_id, e.tmdb_movie, e.anilist_id), matchedBy: by,
    });
  }
  for (const m of remote) {
    if (out.has(m.id)) continue;
    const aid = f.anilistToAnidb.get(m.id) ?? null;
    const map = aid ? al.get(aid) : undefined;
    const tmdbMovie = map?.tmdbMovie ?? f.anilistToTmdb?.get(m.id) ?? null;
    out.set(m.id, {
      anilistId: m.id, title: m.title.english ?? m.title.romaji ?? m.title.native ?? String(m.id), romaji: m.title.romaji, native: m.title.native, kind: m.format, year: m.seasonYear ?? m.startDate?.year ?? null,
      episodes: m.episodes, status: m.status, cover: m.coverImage?.large ?? null, country: m.countryOfOrigin, tvdbId: map?.tvdbId ?? null, tmdbMovie, inLibrary: inLib(map?.tvdbId ?? null, tmdbMovie, m.id), matchedBy: "AniList",
    });
  }
  return { results: [...out.values()], anilist };
}

// ---------------------------------------------------------------- add

export interface AddInput {
  anilistId: number;
  rootFolder: string;
  profileId?: string | null;
  sizePreset?: "lean" | "balanced" | "best" | null;
  scope?: { seasons: string; recentN: number; episodes: string; specials: boolean } | null;
  monitor?: boolean;
}

/** Makes sure the catalog has this entry (and, for a TVDB show, every entry mapped to that series), pinned. */
async function ensureEntries(anilistId: number, deps: { media: typeof mediaByIds; fribb: typeof fribb }) {
  const f = await deps.fribb();
  const al = animeListEntries();
  const aid = f.anilistToAnidb.get(anilistId) ?? null;
  const tvdbId = aid ? (al.get(aid)?.tvdbId ?? null) : null;
  const want = new Set<number>([anilistId]);
  if (tvdbId) for (const e of al.values()) if (e.tvdbId === tvdbId && f.anidbToAnilist.has(e.aid)) want.add(f.anidbToAnilist.get(e.aid)!);
  const have = new Set((db.prepare(`SELECT anilist_id FROM entries WHERE anilist_id IN (${[...want].map(() => "?").join(",")})`).all(...want) as { anilist_id: number }[]).map((r) => r.anilist_id));
  const missing = [...want].filter((x) => !have.has(x));
  for (let i = 0; i < missing.length; i += 50) {
    const batch = await deps.media(missing.slice(i, i + 50), undefined, { priority: true }); // someone is waiting on Add
    tx(db, () => {
      for (const m of batch) upsertMedia(m, f.anilistToAnidb.get(m.id) ?? null);
    });
  }
  tx(db, () => {
    for (const id of want) db.prepare("INSERT OR IGNORE INTO catalog_pins (anilist_id, at) VALUES (?, ?)").run(id, Date.now());
  });
  if (missing.length) rebuildFranchises();
  return { tvdbId };
}

/**
 * Adds a show natively: catalog entries → native_series → cache rows. Doesn't search by itself; the caller picks
 * "search now", the fill-in queue or nothing. Movies are refused here (next round).
 */
export async function addShow(input: AddInput, deps = { media: mediaByIds, fribb }) {
  if (dbState.corrupt) throw err("The database failed its integrity check; restore a backup first", 503);
  const root = path.posix.normalize(String(input.rootFolder ?? "").replace(/\\/g, "/")).replace(/\/+$/, "");
  if (!root || !getSettings().allowedRoots.some((a) => a.replace(/\\/g, "/").replace(/\/+$/, "") === root)) throw err("Pick one of the allowed root folders");
  const { tvdbId: mapped } = await ensureEntries(Number(input.anilistId), deps);
  const e = db.prepare("SELECT * FROM entries WHERE anilist_id = ?").get(Number(input.anilistId)) as unknown as (EntryRow & { tmdb_movie: number | null }) | undefined;
  if (!e) throw err("AniList didn't return that entry", 404);
  if (e.kind === "MOVIE") throw err("Movies are added from the movie side (coming with the native movie importer)", 409);
  const synthetic = !mapped;
  const tvdbId = mapped ?? NATIVE_BASE + e.anilist_id;
  if (cache.prepare("SELECT 1 FROM series WHERE tvdb_id = ?").get(tvdbId) || isNativeTvdb(tvdbId)) throw err("That show is already in your library", 409);
  // The show's title: for a TVDB show, its earliest entry's English (or romaji) title; else this entry's.
  const head = synthetic ? e : ((db.prepare("SELECT * FROM entries WHERE tvdb_id = ? AND tvdb_season IS NOT NULL AND tvdb_season != '0' ORDER BY start_date IS NULL, start_date LIMIT 1").get(tvdbId) as unknown as EntryRow | undefined) ?? e);
  const title = head.title_english ?? head.title_romaji ?? head.title_native ?? `AniList ${e.anilist_id}`;
  const year = head.season_year;
  const m = getSettings().media;
  const folder = renderSeriesFolder(m.seriesFolderFormat, { seriesTitle: title, seriesYear: year, tvdbId: synthetic ? null : tvdbId, anidbTitle: head.title_romaji }, { replaceIllegalCharacters: m.replaceIllegalCharacters, colonReplacement: m.colonReplacement, multiEpisodeStyle: m.multiEpisodeStyle });
  if (!folder.trim() || /^\.+$/.test(folder)) throw err("The series folder format gives an empty folder name");
  const showPath = `${root}/${folder}`;
  if (cache.prepare("SELECT 1 FROM series WHERE path = ?").get(showPath)) throw err(`${showPath} already belongs to another show`, 409);
  if (folder.includes("/") || !underAllowedRoot(showPath)) throw err("The series folder format gives a folder outside the root folder");
  let rowId: number;
  try {
    rowId = Number(db.prepare("INSERT INTO native_series (tvdb_id, anilist_id, synthetic, title, year, path, root_folder, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(tvdbId, e.anilist_id, synthetic ? 1 : 0, title, year, showPath, root, Date.now()).lastInsertRowid);
  } catch {
    throw err("That show is already in your library", 409); // a double click: the UNIQUE tvdb_id
  }
  const row = db.prepare("SELECT * FROM native_series WHERE id = ?").get(rowId) as unknown as NativeRow;
  let made: ReturnType<typeof materialize>;
  try {
    made = materialize(row);
  } catch (x) {
    db.prepare("DELETE FROM native_series WHERE id = ?").run(rowId);
    clearRows(NATIVE_BASE + rowId);
    throw err(`Couldn't build the show's episodes: ${(x as Error).message}`, 500);
  }
  invalidateIndex();
  if (m.createEmptyFolders) {
    try {
      fs.mkdirSync(mappedPath(showPath), { recursive: true });
    } catch {
      /* created on the first import */
    }
  }
  logDecision("info", { tvdbId, title, why: `Added ${title} in AnimeArr (${synthetic ? "an AniList entry TVDB doesn't have; numbered as season 1" : `TVDB ${tvdbId}`}, ${made.episodes} episodes) → ${showPath}` });
  return { tvdbId, title, path: showPath, episodes: made.episodes, synthetic };
}

/** Removes a native show from AnimeArr (its files stay on disk; nothing is deleted). */
export function removeShow(tvdbId: number) {
  const r = db.prepare("SELECT * FROM native_series WHERE tvdb_id = ?").get(tvdbId) as unknown as NativeRow | undefined;
  if (!r) throw err("That show wasn't added in AnimeArr", 404);
  clearRows(NATIVE_BASE + r.id);
  const sonarrHasIt = ownedBySonarr(tvdbId); // then the show's settings belong to Sonarr's copy and stay
  tx(db, () => {
    db.prepare("DELETE FROM native_series WHERE id = ?").run(r.id);
    if (!sonarrHasIt) for (const t of ["managed", "series_scope", "series_prefs", "fill_queue", "search_state", "upgrade_state"]) db.prepare(`DELETE FROM ${t} WHERE tvdb_id = ?`).run(tvdbId);
  });
  invalidateIndex();
  logDecision("info", { tvdbId, title: r.title, why: `Removed ${r.title} from AnimeArr (its files in ${r.path} were left alone)` });
  return { removed: true };
}

// ---------------------------------------------------------------- native movies

interface NativeMovieRow { id: number; anilist_id: number; tmdb_id: number | null; title: string; year: number | null; path: string; root_folder: string; added_at: number }

export const nativeMovies = () => db.prepare("SELECT * FROM native_movies ORDER BY id").all() as unknown as NativeMovieRow[];
export const isNativeMovieId = (id: number) => id >= NATIVE_BASE;
/** Radarr has this movie too (by TMDB id): Radarr's copy is used; the native one is parked. */
const movieOwnedByRadarr = (tmdbId: number | null) => !!tmdbId && !!cache.prepare("SELECT 1 FROM movies WHERE tmdb_id = ? AND id < ?").get(tmdbId, NATIVE_BASE);

/** Writes one native movie's cache row; its file is the biggest video AnimeArr's own scan found in its folder. */
export function materializeMovie(n: NativeMovieRow, now = Date.now()) {
  const mid = NATIVE_BASE + n.id;
  cache.prepare("DELETE FROM movies WHERE id = ?").run(mid);
  if (movieOwnedByRadarr(n.tmdb_id)) return { parked: true, hasFile: false };
  const e = db.prepare("SELECT * FROM entries WHERE anilist_id = ?").get(n.anilist_id) as unknown as EntryRow | undefined;
  const base = n.path.replace(/\/+$/, "");
  const rec = db
    .prepare("SELECT path, size, audio, subs, video FROM media_files WHERE substr(path, 1, ?) = ? ORDER BY size DESC LIMIT 1")
    .get(base.length + 1, `${base}/`) as { path: string; size: number; audio: string; subs: string; video: string } | undefined;
  let file: Record<string, unknown> | null = null;
  if (!rec) {
    // Not scanned yet (or the scan failed): a video on disk still counts, so the movie isn't searched again.
    try {
      const dir = mappedPath(base);
      const v = fs.readdirSync(dir).filter((f) => /\.(mkv|mp4|m4v|avi|ts|webm)$/i.test(f) && !f.endsWith(".animearr-part")).map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size })).sort((a, b) => b.size - a.size)[0];
      if (v) file = { path: `${base}/${v.f}`, sceneName: null, releaseGroup: null, quality: null, audio: [], subs: [], runTime: null, resolution: null };
    } catch {
      /* no folder yet */
    }
  }
  if (rec) {
    const v = JSON.parse(rec.video) as { width: number | null; height: number | null } | null;
    file = {
      path: rec.path,
      sceneName: null,
      releaseGroup: null,
      quality: null,
      audio: [...new Set((JSON.parse(rec.audio) as { lang: string | null }[]).map((a) => a.lang).filter((l): l is string => !!l))],
      subs: [...new Set((JSON.parse(rec.subs) as { lang: string | null; partial?: boolean }[]).filter((s) => !s.partial).map((s) => s.lang).filter((l): l is string => !!l))],
      runTime: null,
      resolution: v?.width && v.height ? `${v.width}x${v.height}` : null,
    };
  }
  const alt = e ? [e.title_english, e.title_romaji, e.title_native, ...(JSON.parse(e.synonyms) as string[])].filter((t): t is string => !!t && t !== n.title) : [];
  const start = e?.start_date ? Date.parse(e.start_date) : null;
  cache
    .prepare(
      `INSERT INTO movies (id, tmdb_id, imdb_id, title, original_title, year, path, root_folder, monitored, has_file, runtime, quality_profile_id, tags, alt_titles, file, is_anime, poster, synced_at, status, is_available, in_cinemas, digital_release, physical_release)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 1, ?, ?, NULL, '[]', ?, ?, 1, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(mid, n.tmdb_id, n.title, e?.title_romaji ?? null, n.year, n.path, n.root_folder, file ? 1 : 0, e?.duration ?? null, JSON.stringify(alt), file ? JSON.stringify(file) : null, e?.cover ?? null, now,
      e?.status === "FINISHED" ? "released" : "announced", e?.status === "FINISHED" ? 1 : 0, Number.isFinite(start) ? start : null);
  return { parked: false, hasFile: !!file };
}

export function materializeAllMovies() {
  if (dbState.corrupt) return 0;
  let n = 0;
  for (const r of nativeMovies()) {
    try {
      materializeMovie(r);
      n++;
    } catch (e) {
      logDecision("fail", { title: r.title, why: `Couldn't rebuild the movie ${r.title}: ${(e as Error).message}` });
    }
  }
  return n;
}

export function rematerializeMovie(movieId: number) {
  const r = db.prepare("SELECT * FROM native_movies WHERE id = ?").get(movieId - NATIVE_BASE) as unknown as NativeMovieRow | undefined;
  if (r) materializeMovie(r);
}

/** Adds a movie natively (no Radarr): catalog entry → native_movies → cache row. */
export async function addMovie(input: { anilistId: number; rootFolder: string }, deps = { media: mediaByIds, fribb }) {
  if (dbState.corrupt) throw err("The database failed its integrity check; restore a backup first", 503);
  const root = path.posix.normalize(String(input.rootFolder ?? "").replace(/\\/g, "/")).replace(/\/+$/, "");
  if (!root || !getSettings().allowedRoots.some((a) => a.replace(/\\/g, "/").replace(/\/+$/, "") === root)) throw err("Pick one of the allowed root folders");
  await ensureEntries(Number(input.anilistId), deps);
  const e = db.prepare("SELECT * FROM entries WHERE anilist_id = ?").get(Number(input.anilistId)) as unknown as (EntryRow & { tmdb_movie: number | null }) | undefined;
  if (!e) throw err("AniList didn't return that entry", 404);
  if (e.kind !== "MOVIE") throw err("That's not a movie; add it as a show", 409);
  const f = await deps.fribb();
  const tmdb = e.tmdb_movie ?? f.anilistToTmdb?.get(e.anilist_id) ?? null;
  if ((tmdb && cache.prepare("SELECT 1 FROM movies WHERE tmdb_id = ?").get(tmdb)) || db.prepare("SELECT 1 FROM native_movies WHERE anilist_id = ?").get(e.anilist_id)) throw err("That movie is already in your library", 409);
  const title = e.title_english ?? e.title_romaji ?? e.title_native ?? `AniList ${e.anilist_id}`;
  const m = getSettings().media;
  const folder = renderMovie(m.movieFolderFormat, { movieTitle: title, year: e.season_year, tmdbId: tmdb }, { replaceIllegalCharacters: m.replaceIllegalCharacters, colonReplacement: m.movieColonReplacement ?? m.colonReplacement, multiEpisodeStyle: m.multiEpisodeStyle });
  if (!folder.trim() || /^\.+$/.test(folder) || folder.includes("/")) throw err("The movie folder format gives an unusable folder name");
  const moviePath = `${root}/${folder}`;
  if (cache.prepare("SELECT 1 FROM movies WHERE path = ?").get(moviePath)) throw err(`${moviePath} already belongs to another movie`, 409);
  let rowId: number;
  try {
    rowId = Number(db.prepare("INSERT INTO native_movies (anilist_id, tmdb_id, title, year, path, root_folder, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(e.anilist_id, tmdb, title, e.season_year, moviePath, root, Date.now()).lastInsertRowid);
  } catch {
    throw err("That movie is already in your library", 409);
  }
  materializeMovie(db.prepare("SELECT * FROM native_movies WHERE id = ?").get(rowId) as unknown as NativeMovieRow);
  logDecision("info", { title, why: `Added the movie ${title}${e.season_year ? ` (${e.season_year})` : ""} in AnimeArr → ${moviePath}` });
  return { movieId: NATIVE_BASE + rowId, title, path: moviePath };
}

export function removeMovie(movieId: number) {
  const r = db.prepare("SELECT * FROM native_movies WHERE id = ?").get(movieId - NATIVE_BASE) as unknown as NativeMovieRow | undefined;
  if (!r) throw err("That movie wasn't added in AnimeArr", 404);
  cache.prepare("DELETE FROM movies WHERE id = ?").run(movieId);
  tx(db, () => {
    db.prepare("DELETE FROM native_movies WHERE id = ?").run(r.id);
    for (const t of ["movie_prefs", "movie_search"]) db.prepare(`DELETE FROM ${t} WHERE movie_id = ?`).run(movieId);
  });
  logDecision("info", { title: r.title, why: `Removed the movie ${r.title} from AnimeArr (its files in ${r.path} were left alone)` });
  return { removed: true };
}
