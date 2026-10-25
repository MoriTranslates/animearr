/**
 * Parsers for the two bulk metadata dumps (PROPOSAL §6.1). Pure functions, no I/O.
 * - AniDB anime-titles.xml: every title of every anime, typed main/official/syn/short/kana.
 * - Anime-Lists anime-list-master.xml: AniDB id → TVDB/TMDB season, episode offset and per-episode mappings.
 * The formats are flat and regular, so a small regex reader is enough (no XML dependency).
 */

export interface AnidbTitle {
  title: string;
  type: "main" | "official" | "syn" | "short" | "kana" | string;
  lang: string;
}
export interface AnidbAnime {
  aid: number;
  titles: AnidbTitle[];
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decode(m[1]) : null;
};

export function parseAnidbTitles(xml: string): Map<number, AnidbAnime> {
  const out = new Map<number, AnidbAnime>();
  const re = /<anime aid="(\d+)">([\s\S]*?)<\/anime>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const aid = Number(m[1]);
    const titles: AnidbTitle[] = [];
    for (const t of m[2].matchAll(/<title([^>]*)>([^<]*)<\/title>/g)) {
      titles.push({ title: decode(t[2]), type: attr(t[1], "type") ?? "syn", lang: attr(t[1], "xml:lang") ?? "" });
    }
    out.set(aid, { aid, titles });
  }
  return out;
}

export interface EpisodeMapping {
  anidbSeason: number;
  tvdbSeason: number;
  start: number | null;
  end: number | null;
  offset: number;
  /** Explicit pairs ";1-5;2-6;" → anidb ep → tvdb ep(s) ("0" = not in TVDB). */
  pairs: Map<number, number[]>;
}
export interface AnimeListEntry {
  aid: number;
  name: string;
  /** Numeric TVDB id, or null for movie/hentai/unknown/OVA placeholders. */
  tvdbId: number | null;
  /** Raw tvdbid when not numeric ("movie", "hentai", "music", "unknown", "OVA"...). */
  tvdbKind: string | null;
  /** Numeric TVDB season, "a" (absolute order), or null. */
  defaultSeason: number | "a" | null;
  offset: number;
  tmdbTv: number | null;
  tmdbSeason: number | null;
  tmdbMovie: number | null;
  imdbId: string | null;
  mappings: EpisodeMapping[];
}

const num = (v: string | null) => (v !== null && v !== "" && /^-?\d+$/.test(v) ? Number(v) : null);

export function parseAnimeList(xml: string): Map<number, AnimeListEntry> {
  const out = new Map<number, AnimeListEntry>();
  const re = /<anime\s([^>]*?)(\/>|>([\s\S]*?)<\/anime>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const head = m[1];
    const body = m[3] ?? "";
    const aid = num(attr(head, "anidbid"));
    if (aid === null) continue;
    const tvdbRaw = attr(head, "tvdbid");
    const ds = attr(head, "defaulttvdbseason");
    const mappings: EpisodeMapping[] = [];
    for (const mm of body.matchAll(/<mapping\s([^>]*?)(?:\/>|>([^<]*)<\/mapping>)/g)) {
      const pairs = new Map<number, number[]>();
      for (const p of (mm[2] ?? "").split(";")) {
        const [a, ...b] = p.split("-");
        if (!a || !b.length) continue;
        const an = Number(a);
        const tv = b.join("-").split("+").map(Number).filter((x) => Number.isFinite(x));
        if (Number.isFinite(an)) pairs.set(an, tv);
      }
      mappings.push({
        anidbSeason: num(attr(mm[1], "anidbseason")) ?? 1,
        tvdbSeason: num(attr(mm[1], "tvdbseason")) ?? 0,
        start: num(attr(mm[1], "start")),
        end: num(attr(mm[1], "end")),
        offset: num(attr(mm[1], "offset")) ?? 0,
        pairs,
      });
    }
    out.set(aid, {
      aid,
      name: decode(body.match(/<name>([^<]*)<\/name>/)?.[1] ?? ""),
      tvdbId: num(tvdbRaw),
      tvdbKind: num(tvdbRaw) === null ? tvdbRaw : null,
      defaultSeason: ds === "a" ? "a" : num(ds),
      offset: num(attr(head, "episodeoffset")) ?? 0,
      tmdbTv: num(attr(head, "tmdbtv")),
      tmdbSeason: num(attr(head, "tmdbseason")),
      tmdbMovie: num(attr(head, "tmdbid")),
      imdbId: attr(head, "imdbid") || null,
      mappings,
    });
  }
  return out;
}

/**
 * AniDB episode (regular, anidb season 1) → TVDB (season, episode) for one entry, following Anime-Lists rules:
 * explicit pairs first, then ranged mappings with offset, then defaulttvdbseason + episodeoffset.
 * Returns null when the entry has no TVDB placement ("a" = absolute is returned as season -1 with the absolute number).
 */
export function anidbToTvdb(e: AnimeListEntry, ep: number, anidbSeason = 1): { season: number; episode: number; absolute?: boolean } | null {
  for (const mp of e.mappings) {
    if (mp.anidbSeason !== anidbSeason) continue;
    const pair = mp.pairs.get(ep);
    if (pair) return pair[0] > 0 ? { season: mp.tvdbSeason, episode: pair[0] } : null;
  }
  for (const mp of e.mappings) {
    if (mp.anidbSeason !== anidbSeason || mp.start === null) continue;
    if (ep >= mp.start && ep <= (mp.end ?? Infinity)) return { season: mp.tvdbSeason, episode: ep + mp.offset };
  }
  if (anidbSeason !== 1) return null;
  if (e.defaultSeason === "a") return { season: -1, episode: ep + e.offset, absolute: true };
  if (e.defaultSeason === null) return null;
  return { season: e.defaultSeason, episode: ep + e.offset };
}

/** Index of anime-list entries by TVDB id. */
export function byTvdb(list: Map<number, AnimeListEntry>): Map<number, AnimeListEntry[]> {
  const out = new Map<number, AnimeListEntry[]>();
  for (const e of list.values()) {
    if (e.tvdbId === null) continue;
    const arr = out.get(e.tvdbId) ?? [];
    arr.push(e);
    out.set(e.tvdbId, arr);
  }
  return out;
}
