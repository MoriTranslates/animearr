/**
 * AniList cover art for library series: AniDB id (from Anime-Lists) → AniList id (Fribb mapping, weekly) →
 * AniList GraphQL in batches of 50, gently rate-limited. Sonarr's poster is the fallback.
 */
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, cache, setJob } from "./system/db.js";
import { animeListEntries, USER_AGENT } from "./metadata.js";
import { anilistQuery } from "./anilist.js";

const FRIBB_URL = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json";
const FRIBB_FILE = path.join(CACHE_DIR, "anime-list-full.json");

async function anilistByAnidbDownload() {
  const stale = !fs.existsSync(FRIBB_FILE) || Date.now() - fs.statSync(FRIBB_FILE).mtimeMs > 7 * 86_400_000;
  if (stale) {
    try {
      const res = await fetch(FRIBB_URL, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(`${FRIBB_FILE}.tmp`, Buffer.from(await res.arrayBuffer()));
      fs.renameSync(`${FRIBB_FILE}.tmp`, FRIBB_FILE);
    } catch (e) {
      if (!fs.existsSync(FRIBB_FILE)) throw new Error(`Couldn't download the AniList mapping: ${(e as Error).message}`);
    }
  }
}

export async function anilistByAnidb(): Promise<Map<number, number>> {
  return (await fribb()).anidbToAnilist;
}

let fribbMemo: {
  mtime: number;
  anidbToAnilist: Map<number, number>;
  anilistToAnidb: Map<number, number>;
  anilistToAnidbAll: Map<number, number[]>;
  anilistToTmdb: Map<number, number>;
} | null = null;
/** The Fribb mapping (AniDB ↔ AniList ↔ TMDB movie): downloaded weekly, parsed once per file version. */
export async function fribb() {
  await anilistByAnidbDownload();
  const mtime = fs.statSync(FRIBB_FILE).mtimeMs;
  if (fribbMemo && fribbMemo.mtime === mtime) return fribbMemo;
  const rows = JSON.parse(await fs.promises.readFile(FRIBB_FILE, "utf8")) as {
    anidb_id?: number;
    anilist_id?: number;
    themoviedb_id?: number | string;
  }[];
  const anidbToAnilist = new Map<number, number>();
  const anilistToAnidb = new Map<number, number>();
  const anilistToAnidbAll = new Map<number, number[]>();
  const anilistToTmdb = new Map<number, number>();
  for (const r of rows) {
    if (r.anidb_id && r.anilist_id) {
      anidbToAnilist.set(r.anidb_id, r.anilist_id);
      if (!anilistToAnidb.has(r.anilist_id)) anilistToAnidb.set(r.anilist_id, r.anidb_id);
      anilistToAnidbAll.set(r.anilist_id, [...(anilistToAnidbAll.get(r.anilist_id) ?? []), r.anidb_id]);
    }
    const tm = Number(r.themoviedb_id);
    if (r.anilist_id && Number.isFinite(tm) && tm > 0) anilistToTmdb.set(r.anilist_id, tm);
  }
  fribbMemo = { mtime, anidbToAnilist, anilistToAnidb, anilistToAnidbAll, anilistToTmdb };
  return fribbMemo;
}

export async function refreshCovers(limit = 600) {
  setJob("covers", "running", "Fetching AniList art");
  try {
    const map = await anilistByAnidb();
    const tvdbs = new Set((cache.prepare("SELECT tvdb_id FROM series").all() as { tvdb_id: number }[]).map((r) => r.tvdb_id));
    const have = new Set(
      (cache.prepare("SELECT anidb_id FROM covers WHERE fetched_at > ?").all(Date.now() - 30 * 86_400_000) as { anidb_id: number }[]).map(
        (r) => r.anidb_id,
      ),
    );
    // Newest mapped entry per series (highest TVDB season) is the one shown.
    const best = new Map<number, { aid: number; season: number }>();
    for (const e of animeListEntries().values()) {
      if (e.tvdbId === null || !tvdbs.has(e.tvdbId) || !map.has(e.aid)) continue;
      const season = typeof e.defaultSeason === "number" ? e.defaultSeason : 0;
      const cur = best.get(e.tvdbId);
      if (!cur || season > cur.season) best.set(e.tvdbId, { aid: e.aid, season });
    }
    const todo = [...best.values()]
      .map((b) => b.aid)
      .filter((aid) => !have.has(aid))
      .slice(0, limit);
    let n = 0;
    for (let i = 0; i < todo.length; i += 50) {
      const batch = todo.slice(i, i + 50);
      const ids = batch.map((a) => map.get(a)!);
      let j: { Page: { media: { id: number; coverImage: { large: string | null; color: string | null }; bannerImage: string | null }[] } };
      try {
        j = await anilistQuery(
          "query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids) { id coverImage { large color } bannerImage } } }",
          { ids },
        );
      } catch {
        break; // rate-limited or down: try again next time
      }
      const data = { data: j };
      const byId = new Map((data.data?.Page.media ?? []).map((m) => [m.id, m]));
      for (const aid of batch) {
        const m = byId.get(map.get(aid)!);
        cache
          .prepare(
            "INSERT INTO covers (anidb_id, anilist_id, cover, banner, color, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(anidb_id) DO UPDATE SET anilist_id = excluded.anilist_id, cover = excluded.cover, banner = excluded.banner, color = excluded.color, fetched_at = excluded.fetched_at",
          )
          .run(aid, map.get(aid)!, m?.coverImage.large ?? null, m?.bannerImage ?? null, m?.coverImage.color ?? null, Date.now());
        if (m) n++;
      }
      await new Promise((r) => setTimeout(r, 3000)); // well under AniList's 30 req/min
    }
    setJob("covers", "done", `${n} new covers (${best.size} shows mapped to AniList)`);
  } catch (e) {
    setJob("covers", "error", (e as Error).message);
  }
}

// ---------------------------------------------------------------- art for a show (cache only, no fetching)

/** A show's cover: AniList art when mapped (newest entry first), else Sonarr's poster. */
export function coverFor(s: { tvdb_id: number; poster: string | null }): string | null {
  // AniList art when mapped (newest entry first), else Sonarr's poster.
  const aids = animeListEntriesFor(s.tvdb_id);
  for (const aid of aids) {
    const c = cache.prepare("SELECT cover FROM covers WHERE anidb_id = ? AND cover IS NOT NULL").get(aid) as { cover: string } | undefined;
    if (c) return c.cover;
  }
  return s.poster;
}
function animeListEntriesFor(tvdbId: number): number[] {
  const out: { aid: number; season: number }[] = [];
  for (const e of animeListEntries().values())
    if (e.tvdbId === tvdbId) out.push({ aid: e.aid, season: typeof e.defaultSeason === "number" ? e.defaultSeason : 0 });
  return out.sort((a, b) => b.season - a.season).map((x) => x.aid);
}

export const seriesInfo = (tvdbId: number) =>
  cache.prepare("SELECT id, tvdb_id, title, poster, anidb_ids FROM series WHERE tvdb_id = ?").get(tvdbId) as
    { id: number; tvdb_id: number; title: string; poster: string | null; anidb_ids: string } | undefined;

/** AniList's cover colour for a show (the per-show accent), when known. */
export function colorFor(tvdbId: number): string | null {
  const s = seriesInfo(tvdbId);
  if (!s) return null;
  const aids = (JSON.parse(s.anidb_ids || "[]") as { aid: number }[]).map((a) => a.aid);
  if (!aids.length) return null;
  const r = cache
    .prepare(`SELECT color FROM covers WHERE anidb_id IN (${aids.map(() => "?").join(",")}) AND color IS NOT NULL LIMIT 1`)
    .get(...aids) as { color: string } | undefined;
  return r?.color ?? null;
}

/** Cover, banner and colour of a show (episode sheet hero). */
export function artFor(tvdbId: number): { cover: string | null; banner: string | null; color: string | null } {
  const s = seriesInfo(tvdbId);
  if (!s) return { cover: null, banner: null, color: null };
  const aids = (JSON.parse(s.anidb_ids || "[]") as { aid: number }[]).map((a) => a.aid);
  const rows = aids.length
    ? (cache.prepare(`SELECT banner, color FROM covers WHERE anidb_id IN (${aids.map(() => "?").join(",")})`).all(...aids) as {
        banner: string | null;
        color: string | null;
      }[])
    : [];
  return {
    cover: coverFor({ tvdb_id: s.tvdb_id, poster: s.poster }),
    banner: rows.find((r) => r.banner)?.banner ?? null,
    color: rows.find((r) => r.color)?.color ?? null,
  };
}
