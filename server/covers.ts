/**
 * AniList cover art for library series: AniDB id (from Anime-Lists) → AniList id (Fribb mapping, weekly) →
 * AniList GraphQL in batches of 50, gently rate-limited. Sonarr's poster is the fallback.
 */
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR, cache, setJob } from "./db.js";
import { animeListEntries, USER_AGENT } from "./metadata.js";

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
  await anilistByAnidbDownload();
  fribbMemo = null;
  return (await fribb()).anidbToAnilist;
}

let fribbMemo: { at: number; anidbToAnilist: Map<number, number>; anilistToAnidb: Map<number, number>; anilistToTmdb: Map<number, number> } | null = null;
/** The Fribb mapping (AniDB ↔ AniList ↔ TMDB movie), read once per hour from the cached file. */
export async function fribb() {
  if (fribbMemo && Date.now() - fribbMemo.at < 3_600_000) return fribbMemo;
  if (!fs.existsSync(FRIBB_FILE)) await anilistByAnidbDownload();
  const rows = JSON.parse(fs.readFileSync(FRIBB_FILE, "utf8")) as { anidb_id?: number; anilist_id?: number; themoviedb_id?: number | string }[];
  const anidbToAnilist = new Map<number, number>();
  const anilistToAnidb = new Map<number, number>();
  const anilistToTmdb = new Map<number, number>();
  for (const r of rows) {
    if (r.anidb_id && r.anilist_id) (anidbToAnilist.set(r.anidb_id, r.anilist_id), anilistToAnidb.set(r.anilist_id, r.anidb_id));
    const tm = Number(r.themoviedb_id);
    if (r.anilist_id && Number.isFinite(tm) && tm > 0) anilistToTmdb.set(r.anilist_id, tm);
  }
  fribbMemo = { at: Date.now(), anidbToAnilist, anilistToAnidb, anilistToTmdb };
  return fribbMemo;
}

export async function refreshCovers(limit = 600) {
  setJob("covers", "running", "Fetching AniList art");
  try {
    const map = await anilistByAnidb();
    const tvdbs = new Set((cache.prepare("SELECT tvdb_id FROM series").all() as { tvdb_id: number }[]).map((r) => r.tvdb_id));
    const have = new Set((cache.prepare("SELECT anidb_id FROM covers WHERE fetched_at > ?").all(Date.now() - 30 * 86_400_000) as { anidb_id: number }[]).map((r) => r.anidb_id));
    // Newest mapped entry per series (highest TVDB season) is the one shown.
    const best = new Map<number, { aid: number; season: number }>();
    for (const e of animeListEntries().values()) {
      if (e.tvdbId === null || !tvdbs.has(e.tvdbId) || !map.has(e.aid)) continue;
      const season = typeof e.defaultSeason === "number" ? e.defaultSeason : 0;
      const cur = best.get(e.tvdbId);
      if (!cur || season > cur.season) best.set(e.tvdbId, { aid: e.aid, season });
    }
    const todo = [...best.values()].map((b) => b.aid).filter((aid) => !have.has(aid)).slice(0, limit);
    let n = 0;
    for (let i = 0; i < todo.length; i += 50) {
      const batch = todo.slice(i, i + 50);
      const ids = batch.map((a) => map.get(a)!);
      const res = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ query: "query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids) { id coverImage { large color } bannerImage } } }", variables: { ids } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) break;
      if (!res.ok) throw new Error(`AniList HTTP ${res.status}`);
      const j = (await res.json()) as { data?: { Page: { media: { id: number; coverImage: { large: string | null; color: string | null }; bannerImage: string | null }[] } } };
      const byId = new Map((j.data?.Page.media ?? []).map((m) => [m.id, m]));
      for (const aid of batch) {
        const m = byId.get(map.get(aid)!);
        cache.prepare("INSERT INTO covers (anidb_id, anilist_id, cover, banner, color, fetched_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(anidb_id) DO UPDATE SET anilist_id = excluded.anilist_id, cover = excluded.cover, banner = excluded.banner, color = excluded.color, fetched_at = excluded.fetched_at").run(aid, map.get(aid)!, m?.coverImage.large ?? null, m?.bannerImage ?? null, m?.coverImage.color ?? null, Date.now());
        if (m) n++;
      }
      await new Promise((r) => setTimeout(r, 3000)); // well under AniList's 30 req/min
    }
    setJob("covers", "done", `${n} new covers (${best.size} shows mapped to AniList)`);
  } catch (e) {
    setJob("covers", "error", (e as Error).message);
  }
}
