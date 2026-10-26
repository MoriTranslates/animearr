import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { AliasIndex, type LibSeries, type UserAlias } from "./core/aliases.js";
import { parseAnidbTitles, parseAnimeList, type AnidbAnime, type AnimeListEntry } from "./core/animedata.js";
import { CACHE_DIR, cache, db, getMeta, setJob, setMeta } from "./db.js";
import { VERSION } from "./version.js";

/**
 * Bulk metadata dumps (PROPOSAL §6.1, §6.7):
 * - AniDB anime-titles.xml.gz: at most once per 24 h, with If-Modified-Since and a proper User-Agent (AniDB bans abuse).
 * - Anime-Lists anime-list-master.xml: daily, with the GitHub ETag.
 * Files live in config/cache; resolution works offline from them.
 */
export const USER_AGENT = `AnimeArr/${VERSION} (+https://github.com/MoriTranslates/animearr)`;
const ANIDB_URL = "http://anidb.net/api/anime-titles.xml.gz";
const ANIMELIST_URL = "https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list-master.xml";
const ANIDB_FILE = path.join(CACHE_DIR, "anime-titles.xml.gz");
const ANIDB_PLAIN = path.join(CACHE_DIR, "anime-titles.xml");
const ANIMELIST_FILE = path.join(CACHE_DIR, "anime-list-master.xml");
const DAY = 86_400_000;

let anidb: Map<number, AnidbAnime> = new Map();
let animeList: Map<number, AnimeListEntry> = new Map();
let index: AliasIndex | null = null;
let indexAt = 0;

function fileAge(f: string) {
  try {
    return Date.now() - fs.statSync(f).mtimeMs;
  } catch {
    return Infinity;
  }
}

async function refreshAnidb(force = false) {
  const meta = getMeta("anidb-titles");
  const have = fs.existsSync(ANIDB_FILE) || fs.existsSync(ANIDB_PLAIN);
  // Never more than once per 24 h, whatever happens (an AniDB ban stops everything for a day).
  const last = Math.max(meta?.fetchedAt ?? 0, have ? Date.now() - Math.min(fileAge(ANIDB_FILE), fileAge(ANIDB_PLAIN)) : 0);
  if (have && Date.now() - last < DAY && !force) return false;
  if (Date.now() - (meta?.fetchedAt ?? 0) < DAY) return false;
  // Not while AniDB has us paused or banned (same IP as the HTTP API).
  const blocked = Number((db.prepare("SELECT value FROM anidb_state WHERE key = 'blockedUntil'").get() as { value: string } | undefined)?.value ?? 0);
  if (blocked > Date.now()) return false;
  setMeta("anidb-titles", { fetchedAt: Date.now(), etag: meta?.etag, lastModified: meta?.lastModified, info: JSON.parse(meta?.info ?? "{}") });
  const res = await fetch(ANIDB_URL, { headers: { "User-Agent": USER_AGENT, ...(have && meta?.lastModified ? { "If-Modified-Since": meta.lastModified } : {}) }, signal: AbortSignal.timeout(120_000) });
  if (res.status === 304) return false;
  if (!res.ok) throw new Error(`AniDB titles download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Validate before replacing the cached copy.
  const xml = zlib.gunzipSync(buf).toString("utf8");
  if (!xml.includes("<animetitles>")) throw new Error("AniDB returned something that isn't the titles dump (rate limited?)");
  fs.writeFileSync(`${ANIDB_FILE}.tmp`, buf);
  fs.renameSync(`${ANIDB_FILE}.tmp`, ANIDB_FILE);
  fs.rmSync(ANIDB_PLAIN, { force: true });
  setMeta("anidb-titles", { fetchedAt: Date.now(), lastModified: res.headers.get("last-modified"), info: { bytes: buf.length } });
  return true;
}

async function refreshAnimeList(force = false) {
  const meta = getMeta("anime-lists");
  const have = fs.existsSync(ANIMELIST_FILE);
  if (have && !force && Date.now() - (meta?.fetchedAt ?? Date.now() - fileAge(ANIMELIST_FILE)) < DAY) return false;
  const res = await fetch(ANIMELIST_URL, { headers: { "User-Agent": USER_AGENT, ...(have && meta?.etag ? { "If-None-Match": meta.etag } : {}) }, signal: AbortSignal.timeout(120_000) });
  if (res.status === 304) {
    setMeta("anime-lists", { fetchedAt: Date.now(), etag: meta?.etag });
    return false;
  }
  if (!res.ok) throw new Error(`Anime-Lists download failed (HTTP ${res.status})`);
  const text = await res.text();
  if (!text.includes("<anime-list>")) throw new Error("Anime-Lists returned an unexpected file");
  fs.writeFileSync(`${ANIMELIST_FILE}.tmp`, text);
  fs.renameSync(`${ANIMELIST_FILE}.tmp`, ANIMELIST_FILE);
  setMeta("anime-lists", { fetchedAt: Date.now(), etag: res.headers.get("etag") });
  return true;
}

function loadFiles() {
  if (fs.existsSync(ANIDB_FILE)) anidb = parseAnidbTitles(zlib.gunzipSync(fs.readFileSync(ANIDB_FILE)).toString("utf8"));
  else if (fs.existsSync(ANIDB_PLAIN)) anidb = parseAnidbTitles(fs.readFileSync(ANIDB_PLAIN, "utf8"));
  if (fs.existsSync(ANIMELIST_FILE)) animeList = parseAnimeList(fs.readFileSync(ANIMELIST_FILE, "utf8"));
}

/** Downloads what is due (respecting the AniDB 24 h rule), then (re)loads the dumps into memory. */
export async function refreshMetadata(force = false) {
  setJob("metadata", "running", "Checking AniDB titles and Anime-Lists");
  const errors: string[] = [];
  let changed = false;
  for (const fn of [refreshAnimeList, refreshAnidb]) {
    try {
      changed = (await fn(force)) || changed;
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (changed || !anidb.size || !animeList.size) {
    loadFiles();
    invalidateIndex();
  }
  setJob("metadata", errors.length ? "error" : "done", errors.length ? errors.join("; ") : `${anidb.size} AniDB anime, ${animeList.size} Anime-Lists entries`);
  return { anidb: anidb.size, animeList: animeList.size, errors };
}

export function metadataStatus() {
  const a = getMeta("anidb-titles");
  const l = getMeta("anime-lists");
  return {
    anidb: { count: anidb.size, fetchedAt: a?.fetchedAt ?? null, fileAge: Math.min(fileAge(ANIDB_FILE), fileAge(ANIDB_PLAIN)) },
    animeLists: { count: animeList.size, fetchedAt: l?.fetchedAt ?? null, fileAge: fileAge(ANIMELIST_FILE) },
  };
}

let animeListTried = false;
export const animeListEntries = () => {
  if (!animeList.size && !animeListTried) {
    animeListTried = true;
    if (fs.existsSync(ANIMELIST_FILE)) animeList = parseAnimeList(fs.readFileSync(ANIMELIST_FILE, "utf8"));
  }
  return animeList;
};

// ---------------------------------------------------------------- alias index over the synced library

export function librarySeries(): LibSeries[] {
  const rows = cache.prepare("SELECT id, tvdb_id, title, path, series_type, original_language FROM series").all() as { id: number; tvdb_id: number; title: string; path: string; series_type: string; original_language: string | null }[];
  const alts = cache.prepare("SELECT series_id, title, scene_season FROM alt_titles").all() as { series_id: number; title: string; scene_season: number | null }[];
  const byId = new Map<number, LibSeries>();
  for (const r of rows) byId.set(r.id, { seriesId: r.id, tvdbId: r.tvdb_id, title: r.title, path: r.path, seriesType: r.series_type, originalLanguage: r.original_language, altTitles: [] });
  for (const a of alts) byId.get(a.series_id)?.altTitles.push({ title: a.title, sceneSeason: a.scene_season });
  return [...byId.values()];
}

export function userAliases(): UserAlias[] {
  return (db.prepare("SELECT title, tvdb_id, season, source FROM aliases").all() as { title: string; tvdb_id: number; season: number | null; source: "user" | "learned" }[]).map((r) => ({ title: r.title, tvdbId: r.tvdb_id, season: r.season, source: r.source }));
}

export function invalidateIndex() {
  index = null;
}

/** The alias index, rebuilt lazily after a sync, a metadata refresh or an alias change. */
export function aliasIndex(): AliasIndex {
  if (index && Date.now() - indexAt < 6 * 3_600_000) return index;
  if (!anidb.size && !animeList.size) loadFiles();
  index = new AliasIndex({ library: librarySeries(), anidb, animeList, userAliases: userAliases() });
  indexAt = Date.now();
  return index;
}
