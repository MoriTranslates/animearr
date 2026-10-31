/**
 * Episode descriptions and thumbnails for the media-server files (server/mediaout.ts writes them).
 *
 * Where they come from, in order:
 *   1. TMDB: the season response of the entry's TMDB mapping (Anime-Lists' tmdb_tv / tmdb_season / tmdb_offset, the same
 *      mapping the catalog uses for episode titles), or the user's own "episode info source" for that season
 *      (server/metaoverride.ts) when the mapping is wrong for metadata. Needs the TMDB key from Settings → Metadata. A season is fetched
 *      once and kept a week in cache.db, so a library-wide run asks TMDB once per season, gently.
 *   2. Sonarr: the episode's overview and screenshot (only when Sonarr is connected and TMDB had nothing).
 *   3. A frame from the video itself (mediaout asks for it, and only when the user switched it on).
 *
 * Nothing here writes files; it only fills in EpisodeMeta (plot, still) so syncSeriesFiles can.
 */
import { spawn } from "node:child_process";
import { tmdbFetch } from "./catalog.js";
import { cache, db } from "./db.js";
import { getSettings } from "./settings.js";
import * as sonarr from "./arr/sonarr.js";
import { NATIVE_BASE } from "./native.js";
import { metaOverrides, type MetaOverride } from "./metaoverride.js";
import type { EpisodeMeta } from "./mediaout.js";

const WEEK = 7 * 24 * 3600_000;
/** TMDB's w780 still is ~60–120 KB; plenty for a 16:9 thumbnail in a media server's episode list. */
export const STILL_SIZE = "w780";
const DELAY_MS = 300;

interface TmdbEp { overview: string | null; still: string | null }
type Season = Record<number, TmdbEp>;

export interface MetaDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  sonarrEpisodes: (seriesId: number) => Promise<sonarr.SonarrEpisode[]>;
  now: () => number;
}
export const realMetaDeps: MetaDeps = {
  fetch,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  sonarrEpisodes: sonarr.getEpisodes,
  now: Date.now,
};

/** One TMDB season (episode number → overview + still), from cache.db when fresh. null = TMDB can't be asked right now. */
async function tmdbSeason(tv: number, season: number, key: string, deps: MetaDeps, state: { stop: boolean }): Promise<Season | null> {
  const source = `tmdb-season:${tv}:${season}`;
  const row = cache.prepare("SELECT fetched_at, info FROM meta WHERE source = ?").get(source) as { fetched_at: number; info: string } | undefined;
  const cached = () => {
    try {
      return row ? (JSON.parse(row.info) as Season) : null;
    } catch {
      return null;
    }
  };
  if (row && deps.now() - row.fetched_at < WEEK) return cached();
  if (state.stop) return cached(); // TMDB said slow down or refused the key: use what we have for the rest of this run
  try {
    await deps.sleep(DELAY_MS);
    const res = await tmdbFetch(`/tv/${tv}/season/${season}?language=en-US`, key, deps.fetch);
    if (res.status === 401 || res.status === 429) {
      state.stop = true;
      return cached();
    }
    const out: Season = {};
    if (res.ok) {
      const j = (await res.json()) as { episodes?: { episode_number: number; overview?: string | null; still_path?: string | null }[] };
      for (const e of j.episodes ?? []) out[e.episode_number] = { overview: e.overview?.trim() || null, still: e.still_path || null };
    } else if (res.status !== 404) return cached();
    // (a season TMDB doesn't have is remembered too, so it isn't asked again for a week)
    cache.prepare("INSERT INTO meta (source, fetched_at, info) VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET fetched_at = excluded.fetched_at, info = excluded.info").run(source, deps.now(), JSON.stringify(out));
    return out;
  } catch {
    return cached();
  }
}

interface MapRow { tvdb_season: string; tvdb_offset: number; episodes: number | null; tmdb_tv: number | null; tmdb_season: number | null; tmdb_offset: number }

/** The TMDB episode (show, season, number) for one AnimeArr episode, through the entry that covers it. Specials aren't guessed. */
export function tmdbTarget(rows: MapRow[], season: number, episode: number, absolute: number | null, overrides?: Map<number, MetaOverride>) {
  // The user's choice for this season replaces the catalog mapping (and is the only way specials get a TMDB episode).
  const o = overrides?.get(season);
  if (o) return { tv: o.tmdbTv, season: o.tmdbSeason, episode: episode + o.tmdbOffset };
  if (season === 0) return null;
  for (const r of rows) {
    // AnimeArr/TVDB numbering → the entry's own episode number (as catalogLookup), then → TMDB numbering with tmdb_offset.
    const n = r.tvdb_season === "a" ? (absolute ? absolute - r.tvdb_offset : null) : Number(r.tvdb_season) === season ? episode - r.tvdb_offset : null;
    if (!n || n < 1 || (r.episodes && n > r.episodes)) continue;
    if (!r.tmdb_tv || r.tmdb_season === null) return null;
    return { tv: r.tmdb_tv, season: r.tmdb_season, episode: n + (r.tmdb_offset ?? 0) };
  }
  return null;
}

/**
 * Fills plot and still on the episodes. `want` says which are needed (an NFO wants plots, thumbnails want stills), so
 * nothing is fetched that wouldn't be written.
 */
export async function enrichEpisodes(tvdbId: number | null, sonarrId: number | null, files: { episodes: EpisodeMeta[] }[], want: { plot: boolean; still: boolean }, deps: MetaDeps = realMetaDeps) {
  if (!want.plot && !want.still) return;
  const eps = files.flatMap((f) => f.episodes);
  const key = getSettings().metadata.tmdbKey;
  if (key && tvdbId) {
    const rows = db.prepare("SELECT tvdb_season, tvdb_offset, episodes, tmdb_tv, tmdb_season, tmdb_offset FROM entries WHERE tvdb_id = ? AND tvdb_season IS NOT NULL AND tvdb_season != '0' ORDER BY tvdb_offset DESC").all(tvdbId) as unknown as MapRow[];
    const overrides = metaOverrides(tvdbId);
    const state = { stop: false };
    const seasons = new Map<string, Season | null>();
    for (const e of eps) {
      const t = tmdbTarget(rows, e.season, e.episode, e.absolute ?? null, overrides);
      if (!t) continue;
      const k = `${t.tv}:${t.season}`;
      if (!seasons.has(k)) seasons.set(k, await tmdbSeason(t.tv, t.season, key, deps, state));
      const hit = seasons.get(k)?.[t.episode];
      if (!hit) continue;
      if (hit.overview) e.plot = hit.overview;
      if (hit.still) {
        e.still = `https://image.tmdb.org/t/p/${STILL_SIZE}${hit.still}`;
        e.stillSource = "tmdb";
      }
    }
  }
  // Sonarr for what TMDB didn't have (specials, unmapped seasons, no key).
  if (sonarrId && sonarrId < NATIVE_BASE && sonarr.sonarrConfigured() && eps.some((e) => (want.plot && !e.plot) || (want.still && !e.still))) {
    try {
      const list = await deps.sonarrEpisodes(sonarrId);
      const bySE = new Map(list.map((x) => [`${x.seasonNumber}x${x.episodeNumber}`, x]));
      for (const e of eps) {
        const x = bySE.get(`${e.season}x${e.episode}`);
        if (!x) continue;
        if (!e.plot && x.overview?.trim()) e.plot = x.overview.trim();
        const shot = x.images?.find((i) => i.coverType === "screenshot")?.remoteUrl;
        if (!e.still && shot && /^https:/i.test(shot)) {
          e.still = shot;
          e.stillSource = "sonarr";
        }
      }
    } catch {
      /* Sonarr down: the TMDB data is still used */
    }
  }
}

/** One frame about a third into the video, scaled to 640 px wide, as a JPEG. null when ffmpeg can't. */
export function ffmpegFrame(file: string, atSec: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(Math.max(0, Math.round(atSec))), "-i", file, "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-q:v", "4", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve(null);
    }
    const out: Buffer[] = [];
    const timer = setTimeout(() => p.kill("SIGKILL"), 60_000);
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.on("error", () => (clearTimeout(timer), resolve(null)));
    p.on("close", (code) => {
      clearTimeout(timer);
      const b = Buffer.concat(out);
      resolve(code === 0 && b.length > 0 ? b : null);
    });
  });
}
