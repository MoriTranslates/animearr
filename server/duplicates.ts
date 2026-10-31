/**
 * Duplicate listings: TVDB sometimes lists an OVA or sequel twice, as specials (or a season) of a parent show AND as
 * its own series. The library can then hold the files under one and a wanted, empty copy under the other, and
 * AnimeArr would buy the episodes a second time.
 *
 * The catalog already knows where every AniList entry is filed (`entries.tvdb_id` + season + offset). A library
 * series is matched to AniList entries by ids first (the AniDB ids the library sync matched), and only when no id
 * resolves, by an exact title match whose episode count also agrees. An entry the catalog files under ANOTHER
 * library series is "elsewhere": its episodes have a home there, and when that home has the file the episode is
 * owned elsewhere. Automatic grabs and searches skip those episodes (`scope.ts`, `pipeline.ts`); a hand-picked
 * release is still allowed, with a warning.
 */
import { cache, db } from "./db.js";
import { aliasIndex } from "./metadata.js";
import { getSettings } from "./settings.js";

/** AnimeArr's own shows have ids from here up (native.ts NATIVE_BASE; not imported to keep scope.ts free of import cycles). */
const NATIVE_SERIES_BASE = 900_000_000;

interface EntryRow { anilist_id: number; anidb_id: number | null; tvdb_id: number; tvdb_season: string; tvdb_offset: number; episodes: number | null; title: string }
interface SeriesRow { id: number; tvdb_id: number; title: string; anidb_ids: string }
interface EpRow { id: number; season: number; episode: number; absolute: number | null; has_file: number }

export interface Overlap {
  /** The episode of the series being checked. */
  episodeId: number;
  season: number;
  episode: number;
  anilistId: number;
  entryTitle: string;
  via: "ids" | "title";
  /** Where the catalog files it: the other library series and its episode. */
  other: { tvdbId: number; seriesId: number; title: string; season: number; episode: number; episodeId: number; hasFile: boolean };
  ownHasFile: boolean;
  /** "Slayers S00E03" */
  label: string;
}

export interface DuplicateDeps {
  /** AniDB ids whose titles match exactly (the fallback when no id resolves). */
  titleAids: (title: string) => number[];
}
const realDeps: DuplicateDeps = {
  titleAids: (title) => [...new Set(aliasIndex().lookup(title).filter((c) => c.aid !== null && c.source.startsWith("anidb") && c.matchedTitle.toLowerCase() === title.toLowerCase()).map((c) => c.aid!))],
};

const sxe = (s: number, e: number) => `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;
const marks = (ids: number[]) => ids.map(() => "?").join(",");

/** Resolved entries per series, kept a minute (the managed tick asks for every show; the files are always read fresh). */
const memo = new Map<number, { at: number; v: { rows: EntryRow[]; via: "ids" | "title" } }>();
export const resetDuplicateCache = () => memo.clear();

/** The AniList entries a library series corresponds to that the catalog files under another TVDB series. */
function elsewhereEntries(s: SeriesRow, regular: Map<number, number>, deps: DuplicateDeps): { rows: EntryRow[]; via: "ids" | "title" } {
  const hit = memo.get(s.tvdb_id);
  if (hit && Date.now() - hit.at < 60_000 && deps === realDeps) return hit.v;
  const aids = (JSON.parse(s.anidb_ids || "[]") as { aid: number }[]).map((a) => a.aid);
  const away = (ids: number[]) =>
    ids.length
      ? (db.prepare(`SELECT anilist_id, anidb_id, tvdb_id, tvdb_season, tvdb_offset, episodes, COALESCE(title_english, title_romaji, title_native, '') AS title FROM entries WHERE anidb_id IN (${marks(ids)}) AND tvdb_id IS NOT NULL AND tvdb_id != ? AND tvdb_season IS NOT NULL`).all(...ids, s.tvdb_id) as unknown as EntryRow[])
      : [];
  let v: { rows: EntryRow[]; via: "ids" | "title" } = { rows: away(aids), via: "ids" };
  // Titles only when ids say nothing at all (no AniDB match, nothing in the catalog filed here), and only for an entry
  // whose episode count equals one of this show's seasons: "Berserk" must not pull in the other Berserk.
  const own = db.prepare("SELECT 1 FROM entries WHERE tvdb_id = ? LIMIT 1").get(s.tvdb_id);
  if (!v.rows.length && !aids.length && !own) {
    const counts = new Set(regular.values());
    v = { rows: away(deps.titleAids(s.title)).filter((r) => r.episodes !== null && counts.has(r.episodes)), via: "title" };
  }
  if (deps === realDeps) memo.set(s.tvdb_id, { at: Date.now(), v });
  return v;
}

/**
 * Episodes of a library series that the catalog files under another library series. `parentHasFile` tells whether
 * that other home actually holds the file.
 */
export function overlapsFor(tvdbId: number, deps: DuplicateDeps = realDeps): Overlap[] {
  const s = cache.prepare("SELECT id, tvdb_id, title, anidb_ids FROM series WHERE tvdb_id = ?").get(tvdbId) as SeriesRow | undefined;
  if (!s) return [];
  const eps = cache.prepare("SELECT id, season, episode, absolute, has_file FROM episodes WHERE series_id = ?").all(s.id) as unknown as EpRow[];
  // Regular seasons: number of episodes each (the entry's episode n is episode n of the season it fills).
  const bySeason = new Map<number, EpRow[]>();
  for (const e of eps) if (e.season > 0) bySeason.set(e.season, [...(bySeason.get(e.season) ?? []), e]);
  const regular = new Map([...bySeason].map(([n, l]) => [n, l.length]));
  if (!regular.size) return [];
  const { rows, via } = elsewhereEntries(s, regular, deps);
  const out: Overlap[] = [];
  for (const r of rows) {
    const home = cache.prepare("SELECT id, tvdb_id, title FROM series WHERE tvdb_id = ?").get(r.tvdb_id) as { id: number; tvdb_id: number; title: string } | undefined;
    if (!home) continue; // the catalog's home isn't in the library: nothing owns it elsewhere
    // Which of this show's seasons the entry fills: the one with its episode count, or the only one.
    const season = regular.size === 1 ? [...regular.keys()][0] : [...regular].find(([, n]) => n === r.episodes)?.[0];
    if (season === undefined) continue;
    const homeEps = cache.prepare("SELECT id, season, episode, absolute, has_file FROM episodes WHERE series_id = ?").all(home.id) as unknown as EpRow[];
    for (const mine of bySeason.get(season) ?? []) {
      if (r.episodes !== null && mine.episode > r.episodes) continue;
      const target = r.tvdb_season === "a" ? homeEps.find((h) => h.absolute === mine.episode + r.tvdb_offset) : homeEps.find((h) => h.season === Number(r.tvdb_season) && h.episode === mine.episode + r.tvdb_offset);
      if (!target) continue;
      out.push({
        episodeId: mine.id, season: mine.season, episode: mine.episode, anilistId: r.anilist_id, entryTitle: r.title, via,
        other: { tvdbId: home.tvdb_id, seriesId: home.id, title: home.title, season: target.season, episode: target.episode, episodeId: target.id, hasFile: !!target.has_file },
        ownHasFile: !!mine.has_file, label: `${home.title} ${sxe(target.season, target.episode)}`,
      });
    }
  }
  return out;
}

/**
 * The other direction: a standalone listing (no AniDB ids of its own) that holds the files for episodes the catalog
 * files under THIS series (Record of Lodoss War S02 = the standalone "Chronicles of the Heroic Knight", which has them).
 * Kept a minute like the entry cache.
 */
let reverseMemo: { at: number; byHome: Map<number, Overlap[]> } | null = null;
function reverseOverlaps(deps: DuplicateDeps): Map<number, Overlap[]> {
  if (reverseMemo && Date.now() - reverseMemo.at < 60_000 && deps === realDeps) return reverseMemo.byHome;
  const byHome = new Map<number, Overlap[]>();
  for (const s of cache.prepare("SELECT tvdb_id, title FROM series WHERE anidb_ids IS NULL OR anidb_ids IN ('', '[]')").all() as { tvdb_id: number; title: string }[]) {
    for (const o of overlapsFor(s.tvdb_id, deps)) {
      if (!o.ownHasFile) continue;
      const flipped: Overlap = {
        episodeId: o.other.episodeId, season: o.other.season, episode: o.other.episode, anilistId: o.anilistId, entryTitle: o.entryTitle, via: o.via,
        other: { tvdbId: s.tvdb_id, seriesId: 0, title: s.title, season: o.season, episode: o.episode, episodeId: o.episodeId, hasFile: true },
        ownHasFile: o.other.hasFile, label: `${s.title} ${sxe(o.season, o.episode)}`,
      };
      byHome.set(o.other.tvdbId, [...(byHome.get(o.other.tvdbId) ?? []), flipped]);
    }
  }
  if (deps === realDeps) reverseMemo = { at: Date.now(), byHome };
  return byHome;
}

/** Episode id → where it is already filed with a file (the guard's view), in either direction. */
export function ownedElsewhere(tvdbId: number, deps: DuplicateDeps = realDeps): Map<number, Overlap> {
  const out = new Map(overlapsFor(tvdbId, deps).filter((o) => o.other.hasFile).map((o) => [o.episodeId, o] as const));
  for (const o of reverseOverlaps(deps).get(tvdbId) ?? []) if (!out.has(o.episodeId)) out.set(o.episodeId, o);
  return out;
}

/** The reason line shown wherever an owned-elsewhere episode is skipped. */
export const ownedWhy = (o: Overlap) => `owned elsewhere (filed as ${o.label})`;

/** Drop the owned-elsewhere episodes from a list of episode ids; `skipped` says why for each. */
export function withoutOwnedElsewhere(tvdbId: number, ids: number[], deps?: DuplicateDeps): { keep: number[]; skipped: { episodeId: number; why: string }[] } {
  const owned = ownedElsewhere(tvdbId, deps);
  if (!owned.size) return { keep: ids, skipped: [] };
  return { keep: ids.filter((id) => !owned.has(id)), skipped: ids.filter((id) => owned.has(id)).map((id) => ({ episodeId: id, why: ownedWhy(owned.get(id)!) })) };
}

/** "S01E01–03 ↔ S00E03–05" style ranges for the audit rows. */
const range = (list: { season: number; episode: number }[]) => {
  const out: string[] = [];
  const bySeason = new Map<number, number[]>();
  for (const x of list) bySeason.set(x.season, [...(bySeason.get(x.season) ?? []), x.episode]);
  for (const [season, nums] of [...bySeason].sort((a, b) => a[0] - b[0])) {
    nums.sort((a, b) => a - b);
    let i = 0;
    while (i < nums.length) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      out.push(i === j ? sxe(season, nums[i]) : `${sxe(season, nums[i])}–${String(nums[j]).padStart(2, "0")}`);
      i = j + 1;
    }
  }
  return out.join(", ");
};

/**
 * Audit → Duplicate listings. Catalog ids first; a standalone listing has no AniDB ids of its own (Anime-Lists files
 * its entry under the parent), so the strict title fallback (exact AniDB title AND the same episode count, which keeps
 * Berserk 1997 vs 2016 apart) is what finds those. A duplicate whose other home has no files is listed too.
 */
export function duplicateListings() {
  const managed = new Set((db.prepare("SELECT tvdb_id FROM managed").all() as { tvdb_id: number }[]).map((r) => r.tvdb_id));
  const sonarrUrl = getSettings().sonarr.url;
  const out: { tvdbId: number; title: string; managed: boolean; sonarr: boolean; sonarrUrl: string; otherTvdbId: number; otherTitle: string; mine: string; there: string; mineFiles: { files: number; total: number }; thereFiles: { files: number; total: number }; blocking: boolean }[] = [];
  for (const s of cache.prepare("SELECT id, tvdb_id, title FROM series").all() as { id: number; tvdb_id: number; title: string }[]) {
    const byHome = new Map<number, Overlap[]>();
    for (const o of overlapsFor(s.tvdb_id)) byHome.set(o.other.tvdbId, [...(byHome.get(o.other.tvdbId) ?? []), o]);
    for (const [home, list] of byHome) {
      const homeEps = cache.prepare(`SELECT id, has_file FROM episodes WHERE id IN (${marks(list.map((o) => o.other.episodeId))})`).all(...list.map((o) => o.other.episodeId)) as { id: number; has_file: number }[];
      const mineEps = cache.prepare(`SELECT id, has_file FROM episodes WHERE id IN (${marks(list.map((o) => o.episodeId))})`).all(...list.map((o) => o.episodeId)) as { id: number; has_file: number }[];
      out.push({
        tvdbId: s.tvdb_id, title: s.title, managed: managed.has(s.tvdb_id), sonarr: s.id < NATIVE_SERIES_BASE, sonarrUrl,
        otherTvdbId: home, otherTitle: list[0].other.title,
        mine: range(list), there: range(list.map((o) => ({ season: o.other.season, episode: o.other.episode }))),
        mineFiles: { files: mineEps.filter((e) => e.has_file).length, total: mineEps.length }, thereFiles: { files: homeEps.filter((e) => e.has_file).length, total: homeEps.length },
        blocking: list.some((o) => o.other.hasFile || o.ownHasFile),
      });
    }
  }
  return out.sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.title.localeCompare(b.title));
}
